# AutoSkip for YouTube

Automatically performs YouTube Premium's **Jump Ahead**, plus a few related
one-click chores: the ad "Skip" button, "Skip intro"-style chips, and the
"Video paused. Continue watching?" dialog.

## Why this isn't just an auto-clicker

Jump Ahead's chip is awkward to catch. YouTube's player only renders it while
the controls are visible (`enable_smart_skip_player_controls_shown_on_web`),
and with a second flag also on progress-bar hover — which is why it often
stays hidden until you seek forward once and the controls pop up.

Rather than fight for the button, AutoSkip reads the same data the button is
built from. Jump Ahead is server-driven: it arrives as a macro-marker with
`sourceType: "SOURCE_TYPE_SMART_SKIP"`, a start time, a duration, a localized
title, and an `onActive` command. AutoSkip intercepts that payload, rebuilds
the skippable ranges exactly the way the player does, and seeks past them with
`#movie_player.seekTo()`.

**The chip's visibility stops mattering.** No synthetic hovering, no nudge
seeking, no waiting for the controls.

## Install

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

Chrome 111+ (MAIN-world content scripts). Permissions: `storage`, `activeTab`,
and `*://*.youtube.com/*`. Nothing is sent anywhere — no network calls of its
own, no analytics.

## How it decides to jump

Two tiers:

- **Tier 1 — marker-direct (primary).** Patches `fetch` / `XMLHttpRequest` at
  `document_start` (before any YouTube script runs) and traps the inline
  `ytInitialPlayerResponse`. Pulls smart-skip markers out, builds ranges, and
  seeks. Jump target: a seek offset parsed from the `onActive` command if one
  is recognizable, otherwise the end of the range.
- **Tier 2 — chip click (fallback).** Only if tier 1 produced nothing at all
  for the current video. Matches the chip by the **server's own localized
  title** captured in tier 1 — so it works in any language — falling back to a
  selector allowlist. This is the only path that ever synthesizes input, and
  it's capped so a video that simply has no Jump Ahead never ends up with its
  controls pinned open.

If tier 1 is working and reports "this video has no jump-ahead data", tier 2
stays passive and never synthesizes anything.

## Safety rules

- Never seeks backwards.
- Each range is consumed once; scrubbing back in does not re-trigger it.
- Per-video jump cap and a cooldown between jumps.
- Inert while an ad is showing.
- **Undo detection**: seek backwards shortly after an auto-jump and AutoSkip
  suspends itself for that video.
- Blocklist by channel name or video id, plus a one-click "never on this video".

The other three actions are guarded too, because they share DOM with things
that must never be auto-clicked:

- *Continue watching?* — `yt-confirm-dialog-renderer` is also used for
  destructive confirms like deleting a comment. AutoSkip only confirms after
  60s with no trusted user input, which the idle prompt requires anyway and a
  user-opened dialog never satisfies.
- *Suggested chips* — a suggested-action badge can be a shopping link. Product
  badges (`ytp-featured-product`, or containing product imagery) are excluded,
  and the label must read as skip-like.

## Development

```bash
node test/markers.test.js
```

28 tests over the pure logic in `src/core/markers.js`, with no browser and no
Premium account needed. `fixtures/real-get-watch.json` is a real response
captured live from youtube.com — note that it's a **top-level array** with the
markers at `[1].watchNextResponse.frameworkUpdates…`, which is exactly why the
parser walks structurally instead of following a fixed key path.

### Layout

| Path | World | Role |
|---|---|---|
| `src/core/markers.js` | both | Pure parsing / range / decision logic |
| `src/main/inject.js` | MAIN | Network capture, player control, jump engine |
| `src/isolated/bridge.js` | ISOLATED | Settings, stats, blocklist, world bridge |
| `src/isolated/dom-actions.js` | ISOLATED | Ad skip, dialogs, chips, tier-2 |
| `src/popup/` | — | Toggles, tuning, diagnostics |

`markers.js` is loaded as a MAIN-world content script *and* `require()`d by the
tests, which is what makes the core logic testable without a browser.

### Diagnostics

Turn on **Debug logging** in the popup and watch the console for `[autoskip]`.
On a non-Premium account you should see markers parsed and *zero* smart-skip
entries — that's the correct result, and it confirms the capture path runs.

**Capture mode** logs the full selector chain of anything you click inside the
player or a dialog. That's how to pin down the real Jump Ahead chip and the
"Continue watching?" confirm button on a live Premium account if the shipped
selectors ever drift.

## Known limits

- Jump Ahead is Premium-only and was, at time of writing, limited to
  English-language videos in the US. Elsewhere no markers ever arrive and the
  extension is correctly inert.
- The `onActive` command shape was never observed live (it needs a Premium
  session), so the target parser is a structural search over plausible field
  names. When it finds nothing it uses the range end, which is correct by
  construction — so an unrecognized command costs accuracy, not function.
- The "Continue watching?" selectors are the one set not confirmed against a
  live dialog. Use capture mode to correct them if it misses.
