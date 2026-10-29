/**
 * AutoSkip — sponsor-segment logic. No browser, no network.
 *   node test/segments.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/core/segments.js');
const M = require('../src/core/markers.js');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8'));
const sbBucket = fx('sponsorblock-hash.sample.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + e.message.split('\n').join('\n       '));
  }
}

console.log('\nAutoSkip sponsor segments\n');

// ──────────────────────────────────────────────────────────── SponsorBlock

test('[real data] filters a hash-prefix bucket down to our video', () => {
  // Captured live: a 4-char prefix returned 57 videos. The server never learns
  // which one we wanted — we filter locally.
  assert.ok(sbBucket.length > 1, 'fixture must contain other videos too');
  const segs = S.fromSponsorBlock(sbBucket, 'TZdUz0YRJ3g');
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].triggerMs, 0);
  assert.strictEqual(segs[0].seekTargetMs, 60400);
  assert.strictEqual(segs[0].source, 'sponsorblock');
  assert.strictEqual(segs[0].category, 'sponsor');
});

test('returns nothing for a video that is not in the bucket', () => {
  assert.deepStrictEqual(S.fromSponsorBlock(sbBucket, 'notARealVideo'), []);
});

test('honours enabled categories', () => {
  const payload = [{ videoID: 'v', segments: [
    { category: 'sponsor', actionType: 'skip', segment: [10, 20], votes: 5 },
    { category: 'outro', actionType: 'skip', segment: [30, 40], votes: 5 }
  ] }];
  const segs = S.fromSponsorBlock(payload, 'v', { categories: ['sponsor'] });
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].category, 'sponsor');
});

test('ignores non-skip action types (mute/poi/full)', () => {
  const payload = [{ videoID: 'v', segments: [
    { category: 'sponsor', actionType: 'mute', segment: [10, 20], votes: 5 },
    { category: 'sponsor', actionType: 'poi', segment: [30, 31], votes: 5 }
  ] }];
  assert.deepStrictEqual(S.fromSponsorBlock(payload, 'v'), []);
});

test('drops downvoted segments but trusts locked ones', () => {
  const payload = [{ videoID: 'v', segments: [
    { category: 'sponsor', actionType: 'skip', segment: [10, 20], votes: -3 },
    { category: 'sponsor', actionType: 'skip', segment: [50, 60], votes: -3, locked: 1 }
  ] }];
  const segs = S.fromSponsorBlock(payload, 'v');
  assert.strictEqual(segs.length, 1, 'only the locked one survives');
  assert.strictEqual(segs[0].triggerMs, 50000);
});

// ───────────────────────────────────────────────────────────────── shared

test('merges overlapping and adjacent segments', () => {
  const merged = S.mergeOverlapping([
    { triggerMs: 0, seekTargetMs: 10000 },
    { triggerMs: 9000, seekTargetMs: 20000 },
    { triggerMs: 60000, seekTargetMs: 70000 }
  ]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].seekTargetMs, 20000);
});

test('clamps to the real video duration and drops degenerate spans', () => {
  const clamped = S.clampToDuration([
    { triggerMs: 10000, seekTargetMs: 999999 },
    { triggerMs: 500000, seekTargetMs: 600000 }
  ], 60000);
  assert.strictEqual(clamped.length, 1);
  assert.strictEqual(clamped[0].seekTargetMs, 60000);
});

test('a late result never causes a backwards seek', () => {
  const segs = [{ triggerMs: 1000, seekTargetMs: 20000 }, { triggerMs: 90000, seekTargetMs: 120000 }];
  const kept = S.dropPassed(segs, 45000);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].triggerMs, 90000);
});

// ─────────────────────────────────────── hand-off to the existing engine

test('segments feed the existing engine unchanged', () => {
  const segs = S.fromSponsorBlock(sbBucket, 'TZdUz0YRJ3g');
  const ranges = M.buildRanges(segs);
  assert.strictEqual(ranges.length, 1);
  assert.strictEqual(ranges[0].source, 'sponsorblock');
  const d = M.decideJump({ ranges, currentMillis: 5000, consumed: new Set() });
  assert.strictEqual(d.jump, true);
  assert.strictEqual(d.targetMillis, 60400);
});

test('sponsor and jump-ahead segments merge and clip together', () => {
  const mixed = M.buildRanges([
    { triggerMs: 0, seekTargetMs: 60400, label: 'Sponsor', source: 'sponsorblock' },
    { triggerMs: 30000, seekTargetMs: 90000, label: 'Jump ahead', source: 'timely-actions' }
  ]);
  assert.strictEqual(mixed.length, 2);
  assert.strictEqual(mixed[0].end, 30000, 'the sponsor range clips at the next trigger');
});

// ───────────────────────────────────────────── permissions stay minimal

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
const D = require('../src/common/defaults.js');

test('the manifest asks only for YouTube and SponsorBlock', () => {
  // Broad host access is the single biggest cause of slow or failed store
  // review. If this fails, someone added a host — make sure it's deliberate.
  assert.deepStrictEqual(manifest.host_permissions.slice().sort(),
    ['*://*.youtube.com/*', 'https://sponsor.ajay.app/*']);
  assert.strictEqual(manifest.optional_host_permissions, undefined);
  assert.deepStrictEqual(manifest.permissions.slice().sort(), ['activeTab', 'storage']);
});

test('no setting can hold a credential, and old ones are cleaned up', () => {
  assert.ok(!Object.keys(D.DEFAULTS).some(k => /key|token|secret|llm/i.test(k)),
    'settings are broadcast into the page and must never carry a credential');
  assert.ok(D.LEGACY_KEYS.includes('secrets'), 'a stored API key from older builds must be removed on update');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
