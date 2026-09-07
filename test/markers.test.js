/**
 * AutoSkip core logic tests. No browser, no Premium account, no deps.
 *   node test/markers.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../src/core/markers.js');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'macro-markers.sample.json'), 'utf8')
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + err.message.split('\n').join('\n       '));
  }
}

console.log('\nAutoSkip core logic\n');

// ---------------------------------------------------------------- extraction

test('finds the video id the payload is about', () => {
  assert.strictEqual(M.findVideoId(fixture), 'dQw4w9WgXcQ');
});

test('extracts only SMART_SKIP markers, ignoring heatmap and chapters', () => {
  const markers = M.extractSmartSkipMarkers(fixture);
  assert.strictEqual(markers.length, 2, 'expected 2 smart-skip markers');
  assert.ok(markers.every(m => m.sourceType === M.SMART_SKIP));
  assert.strictEqual(markers[0].title, 'Jump ahead');
});

test('carries the server-supplied localized title through', () => {
  const localized = JSON.parse(JSON.stringify(fixture));
  const list = localized.frameworkUpdates.entityBatchUpdate.mutations[1]
    .payload.macroMarkersListEntity.markersList;
  list.markers[1].title = { runs: [{ text: 'Passer ' }, { text: 'en avant' }] };
  const markers = M.extractSmartSkipMarkers(localized);
  assert.strictEqual(markers[0].title, 'Passer en avant');
});

test('returns [] for a payload with no smart-skip data (non-Premium case)', () => {
  assert.deepStrictEqual(M.extractSmartSkipMarkers({ foo: { bar: [1, 2, 3] } }), []);
  assert.deepStrictEqual(M.extractSmartSkipMarkers(null), []);
});

test('survives cyclic objects without hanging', () => {
  const cyclic = { a: {} };
  cyclic.a.self = cyclic;
  assert.deepStrictEqual(M.extractSmartSkipMarkers(cyclic), []);
});

test('prefers videoDetails over a related video that appears earlier', () => {
  const payload = {
    contents: { results: [{ videoId: 'AAAAAAAAAAA' }, { videoId: 'CCCCCCCCCCC' }] },
    videoDetails: { videoId: 'BBBBBBBBBBB', title: 'the actual video' }
  };
  assert.strictEqual(M.findVideoId(payload), 'BBBBBBBBBBB');
});

test('externalVideoId on the marker entity outranks everything else', () => {
  const payload = {
    videoDetails: { videoId: 'BBBBBBBBBBB' },
    payloadWrapper: { macroMarkersListEntity: { externalVideoId: 'ZZZZZZZZZZZ' } }
  };
  assert.strictEqual(M.findVideoId(payload), 'ZZZZZZZZZZZ');
});

test('falls through to a bare videoId when nothing better exists', () => {
  assert.strictEqual(M.findVideoId({ a: { b: { videoId: 'QQQQQQQQQQQ' } } }), 'QQQQQQQQQQQ');
  assert.strictEqual(M.findVideoId({ a: { videoId: 'too-short' } }), null);
});

// ------------------------------------------------------------- range building

test('builds ranges and clips an overlap against the next range start', () => {
  const ranges = M.buildRanges(M.extractSmartSkipMarkers(fixture));
  assert.strictEqual(ranges.length, 2);
  // 30000 + 45000 = 75000, but the next marker starts at 60000 -> clipped.
  assert.strictEqual(ranges[0].start, 30000);
  assert.strictEqual(ranges[0].end, 60000, 'first range should be clipped to 60000');
});

test('applies the 10s default when durationMillis is absent', () => {
  const ranges = M.buildRanges(M.extractSmartSkipMarkers(fixture));
  assert.strictEqual(ranges[1].start, 60000);
  assert.strictEqual(ranges[1].end, 70000);
});

test('sorts out-of-order markers before clipping', () => {
  const ranges = M.buildRanges([
    { startMillis: 90000, durationMillis: 5000, title: 'b', command: null },
    { startMillis: 10000, durationMillis: 5000, title: 'a', command: null }
  ]);
  assert.deepStrictEqual(ranges.map(r => r.start), [10000, 90000]);
});

test('drops ranges that clip down to zero length', () => {
  const ranges = M.buildRanges([
    { startMillis: 5000, durationMillis: 60000, title: 'a', command: null },
    { startMillis: 5000, durationMillis: 10000, title: 'b', command: null }
  ]);
  assert.strictEqual(ranges.length, 1, 'the zero-length first range should be dropped');
  assert.strictEqual(ranges[0].start, 5000);
});

// -------------------------------------------------------- command / target

test('parses a millisecond seek offset out of a nested command', () => {
  const ranges = M.buildRanges(M.extractSmartSkipMarkers(fixture));
  assert.strictEqual(M.parseSeekCommand(ranges[0].command), 72000);
});

test('parses a seconds-based seek offset', () => {
  assert.strictEqual(M.parseSeekCommand({ watchEndpoint: { startTimeSeconds: 42 } }), 42000);
});

test('returns NaN for an unrecognized command shape', () => {
  assert.ok(Number.isNaN(M.parseSeekCommand({ clickTrackingParams: 'x' })));
  assert.ok(Number.isNaN(M.parseSeekCommand(null)));
});

test('command target wins when present', () => {
  const ranges = M.buildRanges(M.extractSmartSkipMarkers(fixture));
  const t = M.resolveTarget(ranges[0]);
  assert.strictEqual(t.source, 'command');
  assert.strictEqual(t.millis, 72000);
});

test('falls back to range end when the command is unusable', () => {
  const ranges = M.buildRanges(M.extractSmartSkipMarkers(fixture));
  const t = M.resolveTarget(ranges[1]);
  assert.strictEqual(t.source, 'range-end');
  assert.strictEqual(t.millis, 70000);
});

test('ignores a command target that points backwards', () => {
  const t = M.resolveTarget({
    start: 30000, end: 60000,
    command: { seekToVideoTimestampCommand: { seekTimeMillis: '1000' } }
  });
  assert.strictEqual(t.source, 'range-end', 'a backwards command target must be ignored');
  assert.strictEqual(t.millis, 60000);
});

// ------------------------------------------------- real captured YouTube data

/**
 * Captured live from www.youtube.com on a signed-out session: the response to
 * /youtubei/v1/get_watch during an SPA navigation. Note the shape — the whole
 * response is a top-level ARRAY, and the markers sit at
 *   [1].watchNextResponse.frameworkUpdates.entityBatchUpdate.mutations[1].payload
 * A fixed key path from the root would find nothing here, which is why the
 * parser walks structurally instead.
 */
const real = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'real-get-watch.json'), 'utf8')
);

test('[real data] walks a top-level array response', () => {
  const lists = M.findMarkerLists(real);
  assert.strictEqual(lists.length, 1, 'should find the heatmap list inside the array response');
  assert.strictEqual(lists[0].markerType, 'MARKER_TYPE_HEATMAP');
});

test('[real data] reads the video id out of a get_watch response', () => {
  assert.strictEqual(M.findVideoId(real), 'v5k3MxbIbiA');
});

test('[real data] never mistakes heatmap markers for jump-ahead', () => {
  assert.deepStrictEqual(M.extractSmartSkipMarkers(real), [],
    'heatmap markers have no sourceType and must not produce jumps');
  assert.deepStrictEqual(M.buildRanges(M.extractSmartSkipMarkers(real)), []);
});

test('[real data] handles string-typed millis fields', () => {
  const lists = M.findMarkerLists(real);
  const m = lists[0].markers[1];
  assert.strictEqual(typeof m.startMillis, 'string', 'YouTube really does send these as strings');
  const ranges = M.buildRanges([{ startMillis: Number(m.startMillis), durationMillis: Number(m.durationMillis), title: '', command: null }]);
  assert.strictEqual(ranges[0].start, 6170);
  assert.strictEqual(ranges[0].end, 12340);
});

// ------------------------------------------------------------ jump decision

const RANGES = M.buildRanges(M.extractSmartSkipMarkers(fixture));

test('jumps when the playhead is inside a range', () => {
  const d = M.decideJump({ ranges: RANGES, currentMillis: 31000, consumed: new Set() });
  assert.strictEqual(d.jump, true);
  assert.strictEqual(d.target.millis, 72000);
  assert.strictEqual(d.savedMillis, 41000);
});

test('does not jump outside every range', () => {
  const d = M.decideJump({ ranges: RANGES, currentMillis: 5000, consumed: new Set() });
  assert.strictEqual(d.jump, false);
  assert.strictEqual(d.reason, 'not-in-range');
});

test('does not re-jump a consumed range (user scrubbed back in)', () => {
  const consumed = new Set([RANGES[0].id]);
  const d = M.decideJump({ ranges: RANGES, currentMillis: 31000, consumed });
  assert.strictEqual(d.jump, false);
  assert.strictEqual(d.reason, 'not-in-range');
});

test('never seeks backwards', () => {
  const ranges = M.buildRanges([
    { startMillis: 10000, durationMillis: 20000, title: 'x', command: null }
  ]);
  const d = M.decideJump({ ranges, currentMillis: 29900, consumed: new Set() });
  assert.strictEqual(d.jump, false);
  assert.strictEqual(d.reason, 'target-not-ahead');
});

test('suppresses pointlessly small jumps via minAdvanceMs', () => {
  const ranges = M.buildRanges([
    { startMillis: 0, durationMillis: 1000, title: 'x', command: null }
  ]);
  assert.strictEqual(
    M.decideJump({ ranges, currentMillis: 900, consumed: new Set(), minAdvanceMs: 250 }).jump,
    false
  );
  assert.strictEqual(
    M.decideJump({ ranges, currentMillis: 700, consumed: new Set(), minAdvanceMs: 250 }).jump,
    true
  );
});

test('does nothing with no ranges at all', () => {
  const d = M.decideJump({ ranges: [], currentMillis: 1000, consumed: new Set() });
  assert.strictEqual(d.jump, false);
  assert.strictEqual(d.reason, 'no-ranges');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
