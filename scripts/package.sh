#!/usr/bin/env bash
#
# Builds the Chrome Web Store upload: dist/autoskip-<version>.zip
#
#   ./scripts/package.sh
#
# Ships only what the extension needs at runtime — manifest.json, src/, icons/.
# Tests, fixtures, docs and this script stay out.
#
# Refuses to build if anything is wrong, because a rejected or broken store
# upload costs a review cycle (often days) to recover from.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "  ✗ $*" >&2; exit 1; }
ok()   { echo "  ✓ $*"; }

VERSION="$(node -p "require('./manifest.json').version")"
NAME="autoskip-$VERSION"
STAGE="dist/$NAME"
ZIP="dist/$NAME.zip"

echo "Packaging AutoSkip $VERSION"

# ── 1. versions agree ───────────────────────────────────────────────
# The console banner is how testers and users report which build they run;
# a mismatch makes every bug report ambiguous.
BANNER="$(sed -n "s/.*var VERSION = '\([^']*\)'.*/\1/p" src/main/inject.js)"
[ "$BANNER" = "$VERSION" ] || fail "manifest says $VERSION but the console banner says $BANNER (src/main/inject.js)"
ok "manifest and console banner both $VERSION"

# ── 2. tests and syntax ─────────────────────────────────────────────
node test/markers.test.js  >/dev/null || fail "test/markers.test.js failed"
node test/segments.test.js >/dev/null || fail "test/segments.test.js failed"
ok "all tests pass"

while IFS= read -r f; do
  node --check "$f" 2>/dev/null || fail "syntax error in $f"
done < <(find src -name '*.js')
ok "every source file parses"

# ── 3. every file the manifest references exists ───────────────────
node - <<'NODE' || exit 1
const fs = require('fs'), path = require('path');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const refs = new Set();
(m.content_scripts || []).forEach(cs => (cs.js || []).concat(cs.css || []).forEach(f => refs.add(f)));
if (m.background && m.background.service_worker) refs.add(m.background.service_worker);
if (m.action && m.action.default_popup) refs.add(m.action.default_popup);
Object.values(m.icons || {}).forEach(f => refs.add(f));
Object.values((m.action && m.action.default_icon) || {}).forEach(f => refs.add(f));

// importScripts() in the worker resolves relative to the worker's own folder.
const sw = m.background.service_worker;
const swSrc = fs.readFileSync(sw, 'utf8');
const imp = swSrc.match(/importScripts\(([\s\S]*?)\)/);
if (imp) for (const s of imp[1].matchAll(/'([^']+)'/g)) refs.add(path.join(path.dirname(sw), s[1]));

// <script src> and <link href> in the popup resolve relative to the popup.
const popup = m.action.default_popup;
const html = fs.readFileSync(popup, 'utf8');
for (const s of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) refs.add(path.join(path.dirname(popup), s[1]));

const missing = [...refs].filter(f => !fs.existsSync(f));
if (missing.length) { console.error('  ✗ referenced but missing: ' + missing.join(', ')); process.exit(1); }

// Store limits that cause an instant rejection.
if (m.name.length > 45) { console.error('  ✗ name over 45 chars'); process.exit(1); }
if ((m.description || '').length > 132) { console.error('  ✗ description over 132 chars'); process.exit(1); }
if (m.manifest_version !== 3) { console.error('  ✗ not Manifest V3'); process.exit(1); }
console.log('  ✓ all ' + refs.size + ' referenced files exist; name/description within store limits');
NODE

# ── 4. stage only runtime files ─────────────────────────────────────
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
cp manifest.json "$STAGE/"
cp -R src icons "$STAGE/"
find "$STAGE" \( -name '.DS_Store' -o -name '._*' -o -name '*.swp' \) -delete

# Chrome rejects any extension containing a file or folder starting with "_".
BAD="$(find "$STAGE" -name '_*' | head -5)"
[ -z "$BAD" ] || fail "names starting with '_' (Chrome refuses these): $BAD"
ok "no reserved '_' filenames"

# ── 5. zip with manifest.json at the root ───────────────────────────
# Zipping the folder itself would nest everything one level down, and the
# store rejects an upload whose manifest isn't at the top.
( cd "$STAGE" && zip -qrX "../$NAME.zip" . )
unzip -l "$ZIP" | awk '{print $4}' | grep -qx 'manifest.json' || fail "manifest.json is not at the zip root"
ok "manifest.json at the zip root"

COUNT="$(unzip -Z1 "$ZIP" | grep -v '/$' | wc -l | tr -d ' ')"
SIZE="$(du -h "$ZIP" | cut -f1 | tr -d ' ')"
echo
echo "Built $ZIP — $COUNT files, $SIZE"
echo "Unpacked copy for testing: $STAGE/"
