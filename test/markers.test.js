/**
 * AutoSkip core logic tests. No browser, no Premium account, no deps.
 *   node test/markers.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../src/core/markers.js');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8'));
const timely = fx('timely-actions.sample.json');
const real = fx('real-get-watch.json');
const legacy = fx('macro-markers.sample.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (err) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + err.message.split('\n').join('\n       '));
  }
}

console.log('\nAutoSkip core logic\n');

// ─────────────────────────────────────────── timelyActions (primary source)

test('extracts Jump Ahead segments from timelyActions', () => {
  const segs = M.extractJumpAheadSegments(timely);
  assert.strictEqual(segs.length, 2, 'two jumpable actions, the shopping one excluded');
  assert.strictEqual(segs[0].triggerMs, 30000);
  assert.strictEqual(segs[0].seekTargetMs, 72000);
  assert.strictEqual(segs[0].source, 'timely-actions');
});

test('THE REGRESSION TRAP: picks the right seekToVideoTimestampCommand', () => {
  // onTap's first command also carries a seekToVideoTimestampCommand, with
  // offset 0. A blind deep search returns that one and the jump goes nowhere.
  const segs = M.extractJumpAheadSegments(timely);
  assert.strictEqual(segs[0].seekTargetMs, 72000,
    'must skip the decoy command and take the real destination');
  assert.notStrictEqual(segs[0].seekTargetMs, 0);
});

test('reads the field as offsetFromVideoStartMilliseconds, not ...Millis', () => {
  const wrongName = { serialCommand: { commands: [
    { innertubeCommand: { seekToVideoTimestampCommand: { offsetFromVideoStartMillis: '5000' } } }
  ] } };
  assert.strictEqual(M.extractSeekTargetFromOnTap(wrongName), null,
    'the abbreviated spelling is not what YouTube sends');
});

test('supports commandExecutorCommand as well as serialCommand', () => {
  const segs = M.extractJumpAheadSegments(timely);
  assert.strictEqual(segs[1].triggerMs, 120000);
  assert.strictEqual(segs[1].seekTargetMs, 155000);
});

test('supports a direct onTap command with no wrapper list', () => {
  assert.strictEqual(
    M.extractSeekTargetFromOnTap({ seekToVideoTimestampCommand: { offsetFromVideoStartMilliseconds: '9000' } }),
    9000
  );
});

test('ignores a timely action that is not a jump (shopping link)', () => {
  const rejected = [];
  M.extractJumpAheadSegments(timely, rejected);
  assert.ok(rejected.some(r => r.reason === 'no-seek-target' && r.label === 'Shop now'),
    'the Shop now action must be rejected, with a reason recorded');
});

test('records why each entry was rejected (diagnostics depend on this)', () => {
  const rejected = [];
  M.extractJumpAheadSegments({ timelyActions: [{ notAViewModel: 1 }] }, rejected);
  assert.strictEqual(rejected[0].reason, 'no-view-model');
});

test('rejects an implausible jump distance', () => {
  const tooSmall = M.makeSyntheticPayload({ videoId: 'x', triggerMs: 1000, seekTargetMs: 1500 });
  assert.deepStrictEqual(M.extractJumpAheadSegments(tooSmall), []);
  const tooBig = M.makeSyntheticPayload({ videoId: 'x', triggerMs: 0, seekTargetMs: 5000000 });
  assert.deepStrictEqual(M.extractJumpAheadSegments(tooBig), []);
});

test('finds timelyActions no matter what wraps it', () => {
  const buried = { a: { b: [{ c: { timelyActions: timely.playerOverlays.timelyActionsOverlayViewModel.timelyActions } }] } };
  assert.strictEqual(M.extractJumpAheadSegments(buried).length, 2);
});

test('carries the server-supplied localized label', () => {
  const p = M.makeSyntheticPayload({ videoId: 'x', triggerMs: 1000, seekTargetMs: 20000, label: 'Passer en avant' });
  assert.strictEqual(M.extractJumpAheadSegments(p)[0].label, 'Passer en avant');
});

test('survives cyclic objects and junk input', () => {
  const cyclic = { a: {} }; cyclic.a.self = cyclic;
  assert.deepStrictEqual(M.extractJumpAheadSegments(cyclic), []);
  assert.deepStrictEqual(M.extractJumpAheadSegments(null), []);
  assert.strictEqual(M.extractSeekTargetFromOnTap(null), null);
});

// ─────────────────────────────────────────── smart-skip markers (secondary)

test('still reads legacy SOURCE_TYPE_SMART_SKIP markers', () => {
  const segs = M.extractSmartSkipSegments(legacy);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].triggerMs, 30000);
  assert.strictEqual(segs[0].seekTargetMs, 75000);
});

test('applies the 10s default when durationMillis is absent', () => {
  const segs = M.extractSmartSkipSegments(legacy);
  assert.strictEqual(segs[1].seekTargetMs, segs[1].triggerMs + 10000);
});

test('combines both sources without duplicating', () => {
  const both = M.extractAllSegments(timely);
  assert.strictEqual(both.length, 2, 'timelyActions only; no smart-skip markers here');
});

// ─────────────────────────────────────────────────────────── range building

test('builds ranges and clips an overlap against the next trigger', () => {
  const ranges = M.buildRanges(M.extractSmartSkipSegments(legacy));
  assert.strictEqual(ranges[0].start, 30000);
  assert.strictEqual(ranges[0].end, 60000, 'clipped to the next trigger at 60000');
});

test('drops ranges that clip down to zero length', () => {
  const ranges = M.buildRanges([
    { triggerMs: 5000, seekTargetMs: 65000, label: 'a' },
    { triggerMs: 5000, seekTargetMs: 15000, label: 'b' }
  ]);
  assert.strictEqual(ranges.length, 1);
});

// ────────────────────────────────────── real captured data (no false jumps)

/**
 * Captured live from youtube.com: the /youtubei/v1/get_watch response during
 * an SPA navigation. The whole response is a top-level ARRAY with the payload
 * at [1].watchNextResponse.… — a fixed key path from the root finds nothing,
 * which is why extraction walks structurally.
 */
test('[real data] walks a top-level array response', () => {
  assert.strictEqual(M.findVideoId(real), 'v5k3MxbIbiA');
});

test('[real data] produces no jumps from a video that has none', () => {
  assert.deepStrictEqual(M.extractAllSegments(real), []);
  assert.deepStrictEqual(M.buildRanges(M.extractAllSegments(real)), []);
});

test('[real data] never mistakes heatmap markers for jump-ahead', () => {
  const heat = M.findDeepAll(real, 'markers')[0];
  assert.ok(heat.length >= 3 && heat[0].intensityScoreNormalized !== undefined);
  assert.deepStrictEqual(M.extractSmartSkipSegments(real), []);
});

// ───────────────────────────────────────────────────────────── video id

test('prefers videoDetails over a related video appearing earlier', () => {
  assert.strictEqual(M.findVideoId({
    contents: { results: [{ videoId: 'AAAAAAAAAAA' }] },
    videoDetails: { videoId: 'BBBBBBBBBBB' }
  }), 'BBBBBBBBBBB');
});

test('externalVideoId outranks everything else', () => {
  assert.strictEqual(M.findVideoId({
    videoDetails: { videoId: 'BBBBBBBBBBB' },
    w: { macroMarkersListEntity: { externalVideoId: 'ZZZZZZZZZZZ' } }
  }), 'ZZZZZZZZZZZ');
});

// ──────────────────────────────────────────────────────── jump decision

const RANGES = M.buildRanges(M.extractJumpAheadSegments(timely));

test('jumps when the playhead enters a range', () => {
  const d = M.decideJump({ ranges: RANGES, currentMillis: 31000, consumed: new Set() });
  assert.strictEqual(d.jump, true);
  assert.strictEqual(d.targetMillis, 72000);
  assert.strictEqual(d.savedMillis, 41000);
});

test('does not jump outside every range', () => {
  assert.strictEqual(M.decideJump({ ranges: RANGES, currentMillis: 5000, consumed: new Set() }).reason, 'not-in-range');
});

test('does not re-jump a consumed range (user scrubbed back in)', () => {
  const consumed = new Set([RANGES[0].id]);
  assert.strictEqual(M.decideJump({ ranges: RANGES, currentMillis: 31000, consumed }).jump, false);
});

test('never seeks backwards', () => {
  const ranges = M.buildRanges([{ triggerMs: 10000, seekTargetMs: 30000, label: 'x' }]);
  assert.strictEqual(M.decideJump({ ranges, currentMillis: 29900, consumed: new Set() }).reason, 'target-not-ahead');
});

test('does nothing with no ranges at all', () => {
  assert.strictEqual(M.decideJump({ ranges: [], currentMillis: 1000, consumed: new Set() }).reason, 'no-ranges');
});

// ───────────────────────────────────────────────────────────── simulate()

test('makeSyntheticPayload round-trips through the real extraction path', () => {
  const p = M.makeSyntheticPayload({ videoId: 'abcdefghijk', triggerMs: 12000, seekTargetMs: 48000 });
  assert.strictEqual(M.findVideoId(p), 'abcdefghijk');
  const segs = M.extractJumpAheadSegments(p);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].seekTargetMs, 48000, 'must survive the decoy command it embeds');
  const ranges = M.buildRanges(segs);
  assert.strictEqual(M.decideJump({ ranges, currentMillis: 12500, consumed: new Set() }).targetMillis, 48000);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
