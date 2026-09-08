/**
 * AutoSkip — sponsor-segment + transcript logic. No browser, no API keys.
 *   node test/segments.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/core/segments.js');
const T = require('../src/core/transcript.js');
const M = require('../src/core/markers.js');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'utf8'));
const timedtext = fx('timedtext.sample.json');
const sbBucket = fx('sponsorblock-hash.sample.json');
const panelRows = fx('panel-rows.sample.json');

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

const LINES = T.fromTimedText(timedtext);

// ─────────────────────────────────────────────────────────────── transcript

test('parses YouTube json3 timedtext into lines', () => {
  assert.ok(LINES.length >= 14, 'expected the full script, got ' + LINES.length);
  assert.strictEqual(LINES[0].text, 'hey everyone welcome back to the channel');
  assert.strictEqual(LINES[0].startMs, 0);
});

test('drops empty cues and ADJACENT rolling duplicates only', () => {
  assert.ok(!LINES.some(l => !l.text.trim()), 'no empty lines');

  for (let i = 1; i < LINES.length; i++) {
    assert.notStrictEqual(LINES[i].text, LINES[i - 1].text,
      `adjacent duplicate survived at line ${i}`);
  }

  // Non-adjacent repeats are real speech, not a caption artifact, and must be
  // kept — a video that says the same sentence twice minutes apart still has
  // two distinct moments the model may need to reason about.
  const texts = LINES.map(l => l.text);
  assert.ok(new Set(texts).size < texts.length,
    'this fixture deliberately repeats lines non-adjacently; they must survive');
});

test('a line never overruns the next line start', () => {
  for (let i = 0; i < LINES.length - 1; i++) {
    assert.ok(LINES[i].endMs <= LINES[i + 1].startMs,
      `line ${i} ends ${LINES[i].endMs} but next starts ${LINES[i + 1].startMs}`);
  }
});

test('parses "1:23" style panel timestamps', () => {
  assert.strictEqual(T.parseTimestamp('0:01'), 1000);
  assert.strictEqual(T.parseTimestamp('1:23'), 83000);
  assert.strictEqual(T.parseTimestamp('1:02:03'), 3723000);
  assert.ok(Number.isNaN(T.parseTimestamp('nope')));
});

test('DOM-scraped rows get their end from the next row start', () => {
  const rows = [
    { timestamp: '0:00', text: 'first' },
    { timestamp: '0:05', text: 'second' },
    { timestamp: '0:11', text: 'third' }
  ];
  const lines = T.fromDomRows(rows);
  assert.strictEqual(lines[0].endMs, 5000);
  assert.strictEqual(lines[1].endMs, 11000);
});

test('THE PROMPT CONTAINS NO TIMESTAMPS', () => {
  // If a timestamp ever leaks into the prompt, the model will start returning
  // its own invented ones and the whole safety model collapses.
  const prompt = T.toPromptLines(LINES);
  assert.ok(/^\[0\] hey everyone/.test(prompt), 'lines must be index-prefixed');
  assert.ok(!/\d+:\d\d/.test(prompt), 'no clock-style timestamps allowed');
  assert.ok(!/startMs|tStartMs|\bms\b/i.test(prompt), 'no raw millisecond fields allowed');
});

test('chunking keeps indices global across windows', () => {
  const chunks = T.chunk(LINES, { maxChars: 120, overlapLines: 2 });
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  assert.strictEqual(chunks[0].fromIndex, 0);
  const second = T.toPromptLines(LINES, chunks[1].fromIndex, chunks[1].toIndex);
  const firstIdx = Number(second.match(/^\[(\d+)\]/)[1]);
  assert.strictEqual(firstIdx, chunks[1].fromIndex, 'second chunk must not restart at [0]');
});

test('[real data] scraped transcript panel rows convert cleanly', () => {
  // Captured live from youtube.com's transcript panel.
  const lines = T.fromDomRows(panelRows);
  assert.strictEqual(lines.length, panelRows.length,
    'every scraped row should survive: none are adjacent duplicates');
  assert.strictEqual(lines[0].startMs, 1000);
  assert.strictEqual(lines[0].endMs, 18000, "a row's end is the next row's start");
  assert.strictEqual(lines[lines.length - 1].text.includes('Never gonna'), true);
});

test('[real data] a repeated chorus is NOT collapsed', () => {
  // This transcript repeats the same chorus line six times, non-adjacently.
  // Deduping globally instead of adjacently would delete most of the song and
  // shift every line index the model reasons about.
  const lines = T.fromDomRows(panelRows);
  const chorus = lines.filter(l => l.text.startsWith('♪ Never gonna give you up'));
  assert.ok(chorus.length >= 5, 'expected the chorus repeats to survive, got ' + chorus.length);
});

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

// ──────────────────────────────────────────────────────────────────── LLM

const goodResponse = JSON.stringify({ segments: [{
  startLine: 2, endLine: 7, category: 'sponsor', confidence: 0.95,
  quote: 'this video is sponsored by NordVPN'
}] });

test('accepts a well-formed response and maps lines to real timestamps', () => {
  const { segments, rejected } = S.fromLlm(goodResponse, LINES);
  assert.strictEqual(segments.length, 1, 'rejected: ' + JSON.stringify(rejected));
  assert.strictEqual(segments[0].triggerMs, LINES[2].startMs);
  assert.strictEqual(segments[0].seekTargetMs, LINES[7].endMs);
  assert.strictEqual(segments[0].source, 'llm');
});

test('THE HALLUCINATION GUARD: rejects a quote absent from the transcript', () => {
  // The model claims a sponsor read that was never said. Without this check it
  // would silently eat 15 seconds of real content.
  const hallucinated = JSON.stringify({ segments: [{
    startLine: 9, endLine: 13, category: 'sponsor', confidence: 0.99,
    quote: 'this segment is brought to you by Squarespace'
  }] });
  const { segments, rejected } = S.fromLlm(hallucinated, LINES);
  assert.strictEqual(segments.length, 0);
  assert.strictEqual(rejected[0].reason, 'quote-not-in-transcript');
});

test('quote matching ignores case, punctuation and spacing', () => {
  const messy = JSON.stringify({ segments: [{
    startLine: 2, endLine: 7, category: 'sponsor', confidence: 0.9,
    quote: '  THIS VIDEO,  is Sponsored-by NORDVPN!!  '
  }] });
  assert.strictEqual(S.fromLlm(messy, LINES).segments.length, 1);
});

test('rejects a missing or trivially short quote', () => {
  const noQuote = JSON.stringify([{ startLine: 2, endLine: 7, category: 'sponsor', confidence: 0.9 }]);
  assert.strictEqual(S.fromLlm(noQuote, LINES).rejected[0].reason, 'missing-quote');
});

test('rejects out-of-range line indices instead of clamping them', () => {
  const bad = JSON.stringify([{ startLine: 5, endLine: 9999, category: 'sponsor', confidence: 0.9, quote: 'x'.repeat(20) }]);
  assert.strictEqual(S.fromLlm(bad, LINES).rejected[0].reason, 'line-out-of-range');
  const inverted = JSON.stringify([{ startLine: 8, endLine: 3, category: 'sponsor', confidence: 0.9, quote: 'x'.repeat(20) }]);
  assert.strictEqual(S.fromLlm(inverted, LINES).rejected[0].reason, 'line-out-of-range');
});

test('rejects low confidence', () => {
  const weak = JSON.stringify([{
    startLine: 2, endLine: 7, category: 'sponsor', confidence: 0.4,
    quote: 'this video is sponsored by NordVPN'
  }]);
  assert.strictEqual(S.fromLlm(weak, LINES).rejected[0].reason, 'low-confidence');
});

test('rejects a segment that would swallow too much of the video', () => {
  const greedy = JSON.stringify([{
    startLine: 0, endLine: LINES.length - 1, category: 'sponsor', confidence: 0.99,
    quote: 'hey everyone welcome back to the channel'
  }]);
  const { segments, rejected } = S.fromLlm(greedy, LINES, { videoDurationMs: 37500 });
  assert.strictEqual(segments.length, 0);
  assert.strictEqual(rejected[0].reason, 'too-long');
});

test('rejects a segment shorter than the minimum', () => {
  const tiny = JSON.stringify([{
    startLine: 3, endLine: 3, category: 'sponsor', confidence: 0.9,
    quote: 'this video is sponsored by NordVPN'
  }]);
  assert.strictEqual(S.fromLlm(tiny, LINES, { minDurationMs: 5000 }).rejected[0].reason, 'too-short');
});

test('rejects categories the user has not enabled', () => {
  const r = S.fromLlm(JSON.stringify([{
    startLine: 2, endLine: 7, category: 'filler', confidence: 0.9,
    quote: 'this video is sponsored by NordVPN'
  }]), LINES, { categories: ['sponsor'] });
  assert.strictEqual(r.rejected[0].reason, 'category-not-enabled');
});

test('digs JSON out of prose and code fences', () => {
  const fenced = 'Sure! Here you go:\n```json\n{"segments":[]}\n```\nHope that helps.';
  assert.deepStrictEqual(S.parseJsonLoose(fenced), { segments: [] });
  const prosed = 'I found one: [{"startLine":1,"endLine":2}] — let me know.';
  assert.strictEqual(S.parseJsonLoose(prosed).length, 1);
  assert.strictEqual(S.parseJsonLoose('no json at all'), null);
  assert.strictEqual(S.fromLlm('no json at all', LINES).rejected[0].reason, 'unparseable-response');
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

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
