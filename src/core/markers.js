/**
 * AutoSkip — pure marker logic.
 *
 * No DOM, no chrome APIs. Loaded both as a MAIN-world content script (assigns
 * globalThis.ASMarkers) and as a CommonJS module by test/markers.test.js.
 *
 * Mirrors how YouTube's player (base.js) turns macro-marker data into the
 * ranges that back the "Jump ahead" chip:
 *
 *   for each marker:
 *     start = Number(startMillis)
 *     len   = Number(durationMillis) ?? 10000
 *     if (prev && prev.end > start) prev.end = start   // clip overlaps
 *     push({ start, end: start + len })
 */
(function (root) {
  'use strict';

  var SMART_SKIP = 'SOURCE_TYPE_SMART_SKIP';
  var DEFAULT_DURATION_MS = 10000;

  // Keys whose numeric value is a millisecond offset from the start of the video.
  var MS_KEY_RE = /^(seekTimeMillis|offsetFromVideoStartMillis|startTimeMillis|seekToMillis|videoTimeMillis)$/;
  // Keys whose numeric value is a second offset.
  var SEC_KEY_RE = /^(startTimeSeconds|seekTimeSeconds|offsetFromVideoStartSeconds)$/;

  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    var n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function isObj(v) {
    return v !== null && typeof v === 'object';
  }

  /**
   * Walk an arbitrary Innertube response and collect every markers list we can
   * find. Deliberately structural rather than a fixed key path: YouTube moves
   * `macroMarkersListEntity` around between `frameworkUpdates.entityBatchUpdate
   * .mutations[].payload`, `playerOverlays`, and engagement panels, and renames
   * wrappers more often than it renames the leaf fields.
   */
  function findMarkerLists(root, maxDepth) {
    var depth = typeof maxDepth === 'number' ? maxDepth : 24;
    var found = [];
    var seen = new Set();

    (function walk(node, d) {
      if (d > depth || !isObj(node) || seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], d + 1);
        return;
      }

      // A markers list is any object carrying an array of things that look like
      // timestamp markers.
      if (Array.isArray(node.markers) && node.markers.some(looksLikeMarker)) {
        found.push({
          markerType: node.markerType || null,
          markers: node.markers.filter(looksLikeMarker)
        });
      }

      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        walk(node[k], d + 1);
      }
    })(root, 0);

    return found;
  }

  function looksLikeMarker(m) {
    return isObj(m) && !Number.isNaN(num(m.startMillis));
  }

  /**
   * The video id a payload is about, so a prefetched response can't leak into
   * whatever is currently playing.
   *
   * Ordered by authority, because a single response is full of *other* videos'
   * ids (related videos, endscreen suggestions). Taking the first `videoId`
   * encountered would frequently identify a sidebar recommendation instead of
   * the video the markers belong to.
   */
  function findVideoId(root, maxDepth) {
    var depth = typeof maxDepth === 'number' ? maxDepth : 24;

    var probes = [
      // Attached directly to the marker entity itself — most authoritative.
      function (n) { return typeof n.externalVideoId === 'string' && n.externalVideoId ? n.externalVideoId : null; },
      // The player response's own subject.
      function (n) {
        return n.videoDetails && typeof n.videoDetails.videoId === 'string' && n.videoDetails.videoId.length === 11
          ? n.videoDetails.videoId : null;
      },
      // Last resort: any id-shaped value.
      function (n) { return typeof n.videoId === 'string' && n.videoId.length === 11 ? n.videoId : null; }
    ];

    for (var p = 0; p < probes.length; p++) {
      var hit = search(root, probes[p], depth);
      if (hit) return hit;
    }
    return null;
  }

  function search(root, probe, depth) {
    var seen = new Set();
    var found = null;

    (function walk(node, d) {
      if (found || d > depth || !isObj(node) || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length && !found; i++) walk(node[i], d + 1);
        return;
      }
      var hit = probe(node);
      if (hit) { found = hit; return; }
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        walk(node[k], d + 1);
        if (found) return;
      }
    })(root, 0);

    return found;
  }

  function textOf(t) {
    if (!isObj(t)) return typeof t === 'string' ? t : '';
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map(function (r) { return r && r.text ? r.text : ''; }).join('');
    return '';
  }

  /** Normalize one raw marker into our own shape. */
  function normalizeMarker(m) {
    var start = num(m.startMillis);
    var dur = num(m.durationMillis);
    return {
      startMillis: start,
      durationMillis: Number.isNaN(dur) ? DEFAULT_DURATION_MS : dur,
      sourceType: m.sourceType || null,
      title: textOf(m.title),
      command: (m.onActive && m.onActive.innertubeCommand) || null
    };
  }

  /**
   * Pull the smart-skip ("Jump ahead") markers out of a whole Innertube payload.
   * Returns [] for any video that doesn't offer the feature — the expected
   * result for non-Premium accounts, non-US regions, and non-English videos.
   */
  function extractSmartSkipMarkers(payload) {
    var out = [];
    findMarkerLists(payload).forEach(function (list) {
      list.markers.forEach(function (raw) {
        if (raw.sourceType !== SMART_SKIP) return;
        var m = normalizeMarker(raw);
        if (Number.isNaN(m.startMillis)) return;
        out.push(m);
      });
    });
    return out;
  }

  /**
   * Build the skippable ranges. Sorted by start, overlaps clipped so an earlier
   * range never runs past the next one's start (same rule base.js applies).
   * Zero/negative-length ranges after clipping are dropped.
   */
  function buildRanges(markers) {
    var sorted = markers
      .filter(function (m) { return !Number.isNaN(m.startMillis); })
      .slice()
      .sort(function (a, b) { return a.startMillis - b.startMillis; });

    var ranges = [];
    var prev = null;

    sorted.forEach(function (m, i) {
      var start = m.startMillis;
      var len = Number.isNaN(m.durationMillis) ? DEFAULT_DURATION_MS : m.durationMillis;
      if (prev && prev.end > start) prev.end = start;
      var range = {
        id: 'r' + i + '@' + start,
        start: start,
        end: start + len,
        title: m.title,
        command: m.command,
        hasCommand: !!m.command
      };
      ranges.push(range);
      prev = range;
    });

    return ranges.filter(function (r) { return r.end > r.start; });
  }

  /**
   * Dig a seek offset (in ms) out of an onActive innertubeCommand. The exact
   * command shape is not documented and was never observed live, so this is a
   * structural search over known-plausible field names rather than a fixed
   * path. Returns NaN when nothing recognizable is present — callers fall back
   * to the range end, which is correct by construction.
   */
  function parseSeekCommand(cmd, maxDepth) {
    if (!isObj(cmd)) return NaN;
    var depth = typeof maxDepth === 'number' ? maxDepth : 12;
    var seen = new Set();
    var result = NaN;

    (function walk(node, d) {
      if (!Number.isNaN(result) || d > depth || !isObj(node) || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], d + 1);
        return;
      }
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        if (!isObj(v)) {
          var n = num(v);
          if (!Number.isNaN(n)) {
            if (MS_KEY_RE.test(k)) { result = n; return; }
            if (SEC_KEY_RE.test(k)) { result = n * 1000; return; }
          }
          continue;
        }
        walk(v, d + 1);
        if (!Number.isNaN(result)) return;
      }
    })(cmd, 0);

    return result;
  }

  /**
   * Where a jump for this range should land, in ms.
   * Command-supplied target wins; range end is the fallback.
   */
  function resolveTarget(range) {
    var fromCmd = parseSeekCommand(range && range.command);
    if (!Number.isNaN(fromCmd) && fromCmd > range.start) {
      return { millis: fromCmd, source: 'command' };
    }
    return { millis: range.end, source: 'range-end' };
  }

  /**
   * The range the playhead is currently inside, skipping consumed ones.
   * `consumed` is any object with a .has(id) method (a Set).
   */
  function pickActiveRange(ranges, currentMillis, consumed) {
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (consumed && consumed.has(r.id)) continue;
      if (currentMillis >= r.start && currentMillis < r.end) return r;
    }
    return null;
  }

  /**
   * Full decision for one tick. Returns a jump instruction or a reason not to.
   * Kept pure so every safety rule is unit-testable without a browser.
   */
  function decideJump(opts) {
    var ranges = opts.ranges || [];
    var currentMillis = opts.currentMillis;
    var consumed = opts.consumed;
    var minAdvanceMs = typeof opts.minAdvanceMs === 'number' ? opts.minAdvanceMs : 250;

    if (!ranges.length) return { jump: false, reason: 'no-ranges' };

    var range = pickActiveRange(ranges, currentMillis, consumed);
    if (!range) return { jump: false, reason: 'not-in-range' };

    var target = resolveTarget(range);

    // Never seek backwards, and never make a jump so small it's pointless.
    if (!(target.millis > currentMillis + minAdvanceMs)) {
      return { jump: false, reason: 'target-not-ahead', range: range, target: target };
    }

    return {
      jump: true,
      range: range,
      target: target,
      savedMillis: target.millis - currentMillis
    };
  }

  var api = {
    SMART_SKIP: SMART_SKIP,
    DEFAULT_DURATION_MS: DEFAULT_DURATION_MS,
    findMarkerLists: findMarkerLists,
    findVideoId: findVideoId,
    extractSmartSkipMarkers: extractSmartSkipMarkers,
    buildRanges: buildRanges,
    parseSeekCommand: parseSeekCommand,
    resolveTarget: resolveTarget,
    pickActiveRange: pickActiveRange,
    decideJump: decideJump,
    _textOf: textOf
  };

  root.ASMarkers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
