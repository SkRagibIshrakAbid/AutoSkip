/**
 * AutoSkip — transcript normalization (pure).
 *
 * Three acquisition paths all land here and produce one shape:
 *   { startMs, endMs, text }
 *
 * Loaded as a content script (assigns globalThis.ASTranscript) and require()d
 * by the tests.
 */
(function (root) {
  'use strict';

  function isObj(v) { return v !== null && typeof v === 'object'; }

  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    var n = typeof v === 'string' ? parseFloat(v) : Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  /** "1:23" / "01:02:03" / "23" → milliseconds. */
  function parseTimestamp(str) {
    if (typeof str !== 'string') return NaN;
    var parts = str.trim().split(':').map(function (p) { return parseInt(p, 10); });
    if (!parts.length || parts.some(function (p) { return !Number.isFinite(p); })) return NaN;
    var s = 0;
    for (var i = 0; i < parts.length; i++) s = s * 60 + parts[i];
    return s * 1000;
  }

  function cleanText(t) {
    return String(t == null ? '' : t)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Deep-collect every value stored under `key`. */
  function findDeepAll(node, key, out, depth, seen) {
    out = out || []; depth = depth || 0; seen = seen || new Set();
    if (depth > 24 || !isObj(node) || seen.has(node)) return out;
    seen.add(node);
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) findDeepAll(node[i], key, out, depth + 1, seen);
      return out;
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (k === key) out.push(node[k]);
      findDeepAll(node[k], key, out, depth + 1, seen);
    }
    return out;
  }

  /**
   * Path 1: YouTube's own /api/timedtext response (fmt=json3).
   * Exact millisecond timings, captured with zero UI disruption.
   */
  function fromTimedText(json) {
    if (!isObj(json) || !Array.isArray(json.events)) return [];
    var lines = [];
    json.events.forEach(function (e) {
      if (!e || !Array.isArray(e.segs)) return;
      var text = cleanText(e.segs.map(function (s) { return s && s.utf8 ? s.utf8 : ''; }).join(''));
      if (!text) return;
      var start = num(e.tStartMs);
      if (Number.isNaN(start)) return;
      var dur = num(e.dDurationMs);
      lines.push({
        startMs: start,
        endMs: Number.isNaN(dur) ? start + 5000 : start + dur,
        text: text
      });
    });
    return normalize(lines);
  }

  /**
   * Path 2: /youtubei/v1/get_transcript response, fired when the transcript
   * panel opens. Also exact milliseconds.
   */
  function fromGetTranscript(json) {
    var lines = [];
    findDeepAll(json, 'transcriptSegmentRenderer').forEach(function (s) {
      if (!isObj(s)) return;
      var text = cleanText(
        (s.snippet && s.snippet.simpleText) ||
        (s.snippet && Array.isArray(s.snippet.runs)
          ? s.snippet.runs.map(function (r) { return r && r.text ? r.text : ''; }).join('')
          : '')
      );
      if (!text) return;
      var start = num(s.startMs);
      if (Number.isNaN(start)) return;
      var end = num(s.endMs);
      lines.push({ startMs: start, endMs: Number.isNaN(end) ? start + 5000 : end, text: text });
    });
    return normalize(lines);
  }

  /**
   * Path 3: scraped from the transcript panel's DOM. Only ~1s precision, since
   * the panel renders "1:23" rather than a millisecond value. Each line's end
   * is the next line's start, so the coarseness never compounds.
   */
  function fromDomRows(rows) {
    if (!Array.isArray(rows)) return [];
    var lines = [];
    rows.forEach(function (r) {
      if (!r) return;
      var start = typeof r.startMs === 'number' ? r.startMs : parseTimestamp(r.timestamp);
      var text = cleanText(r.text);
      if (Number.isNaN(start) || !text) return;
      lines.push({ startMs: start, endMs: NaN, text: text });
    });
    lines.sort(function (a, b) { return a.startMs - b.startMs; });
    for (var i = 0; i < lines.length; i++) {
      if (Number.isNaN(lines[i].endMs)) {
        lines[i].endMs = i + 1 < lines.length ? lines[i + 1].startMs : lines[i].startMs + 5000;
      }
    }
    return normalize(lines);
  }

  /** Sort, drop empties/duplicates, and guarantee endMs > startMs. */
  function normalize(lines) {
    var out = (lines || [])
      .filter(function (l) { return l && l.text && Number.isFinite(l.startMs); })
      .slice()
      .sort(function (a, b) { return a.startMs - b.startMs; });

    var result = [];
    for (var i = 0; i < out.length; i++) {
      var l = out[i];
      var prev = result[result.length - 1];
      // YouTube's rolling auto-captions emit the same text on consecutive cues.
      // Dropped unconditionally rather than within a time window: two identical
      // adjacent cues are a caption artifact, and even if a speaker genuinely
      // repeated themselves, losing one line costs nothing here — segment
      // boundaries come from the surviving lines either side.
      if (prev && prev.text === l.text) continue;
      var end = Number.isFinite(l.endMs) && l.endMs > l.startMs ? l.endMs : l.startMs + 5000;
      var next = out[i + 1];
      if (next && next.startMs > l.startMs && end > next.startMs) end = next.startMs;
      result.push({ startMs: l.startMs, endMs: end, text: l.text });
    }
    return result;
  }

  /**
   * Render lines for the model WITHOUT timestamps.
   *
   * This is deliberate: a model given timestamps will hand back invented ones,
   * and an invented timestamp silently eats real content. It only ever sees
   * indices, and we map those back to times ourselves.
   */
  function toPromptLines(lines, fromIndex, toIndex) {
    var a = typeof fromIndex === 'number' ? fromIndex : 0;
    var b = typeof toIndex === 'number' ? toIndex : lines.length;
    var out = [];
    for (var i = a; i < b && i < lines.length; i++) out.push('[' + i + '] ' + lines[i].text);
    return out.join('\n');
  }

  /**
   * Split a long transcript into overlapping windows. Indices stay GLOBAL so a
   * segment found in chunk 3 still maps to the right line.
   */
  function chunk(lines, opts) {
    opts = opts || {};
    var maxChars = opts.maxChars || 24000;
    var overlap = opts.overlapLines || 20;
    var chunks = [];
    var i = 0;

    while (i < lines.length) {
      var chars = 0;
      var j = i;
      while (j < lines.length && chars < maxChars) {
        chars += lines[j].text.length + 8;
        j++;
      }
      chunks.push({ fromIndex: i, toIndex: j });
      if (j >= lines.length) break;
      i = Math.max(i + 1, j - overlap);
    }
    return chunks;
  }

  function totalDurationMs(lines) {
    return lines.length ? lines[lines.length - 1].endMs : 0;
  }

  var api = {
    parseTimestamp: parseTimestamp,
    cleanText: cleanText,
    fromTimedText: fromTimedText,
    fromGetTranscript: fromGetTranscript,
    fromDomRows: fromDomRows,
    normalize: normalize,
    toPromptLines: toPromptLines,
    chunk: chunk,
    totalDurationMs: totalDurationMs
  };

  root.ASTranscript = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
