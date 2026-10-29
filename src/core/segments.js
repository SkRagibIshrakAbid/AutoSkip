/**
 * AutoSkip — sponsor-segment validation (pure).
 *
 * Turns SponsorBlock rows into the SAME shape the existing skip engine already
 * consumes:
 *
 *   { triggerMs, seekTargetMs, label, source, category }
 *
 * which is exactly what ASMarkers.buildRanges() takes — so sponsor segments and
 * Jump Ahead ranges merge and clip against each other for free.
 */
(function (root) {
  'use strict';

  var ALL_CATEGORIES = [
    'sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview',
    'filler', 'music_offtopic'
  ];

  var LABELS = {
    sponsor: 'Sponsor',
    selfpromo: 'Self-promo',
    interaction: 'Interaction reminder',
    intro: 'Intro',
    outro: 'Outro',
    preview: 'Preview',
    filler: 'Filler',
    music_offtopic: 'Non-music'
  };

  var DEFAULTS = {
    categories: ['sponsor', 'selfpromo'],
    minVotes: 0
  };

  function isObj(v) { return v !== null && typeof v === 'object'; }
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    var n = typeof v === 'string' ? parseFloat(v) : Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  function opt(o, k) {
    o = o || {};
    return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : DEFAULTS[k];
  }
  function labelFor(cat) { return LABELS[cat] || 'Segment'; }

  // ───────────────────────────────────────────────────────── SponsorBlock

  /**
   * Accepts either the direct `/api/skipSegments?videoID=` array or a bucket
   * from the privacy-preserving `/api/skipSegments/<hashPrefix>` endpoint
   * (which returns rows for several videos sharing the prefix, so it must be
   * filtered by videoId locally — the server never learns which one we want).
   */
  function fromSponsorBlock(payload, videoId, options) {
    var categories = opt(options, 'categories');
    var minVotes = opt(options, 'minVotes');
    var rows = [];

    if (Array.isArray(payload)) {
      payload.forEach(function (entry) {
        if (!isObj(entry)) return;
        if (Array.isArray(entry.segments)) {
          // hash-prefix bucket: keep only our video
          if (videoId && entry.videoID && entry.videoID !== videoId) return;
          entry.segments.forEach(function (s) { rows.push(s); });
        } else if (Array.isArray(entry.segment)) {
          rows.push(entry);
        }
      });
    }

    var out = [];
    rows.forEach(function (s) {
      if (!isObj(s) || !Array.isArray(s.segment)) return;
      if (s.actionType && s.actionType !== 'skip') return;
      if (categories.indexOf(s.category) === -1) return;

      // Community downvotes mean "this segment is wrong". Locked segments are
      // moderator-approved and always trusted.
      var votes = num(s.votes);
      if (!s.locked && Number.isFinite(votes) && votes < minVotes) return;

      var startMs = num(s.segment[0]) * 1000;
      var endMs = num(s.segment[1]) * 1000;
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return;

      out.push({
        triggerMs: Math.round(startMs),
        seekTargetMs: Math.round(endMs),
        label: labelFor(s.category),
        category: s.category,
        source: 'sponsorblock',
        locked: !!s.locked,
        uuid: s.UUID || null
      });
    });

    return mergeOverlapping(out);
  }

  /** SHA-256 hex of a videoId — the caller sends only the first 4 characters. */
  function hashPrefix(videoId, sha256Hex, length) {
    var n = length || 4;
    return String(sha256Hex || '').slice(0, n);
  }

  // ───────────────────────────────────────────────────────────── shared

  /** Merge overlapping/adjacent segments so the engine sees one clean range. */
  function mergeOverlapping(segments, gapMs) {
    var gap = typeof gapMs === 'number' ? gapMs : 1000;
    var sorted = (segments || []).slice().sort(function (x, y) { return x.triggerMs - y.triggerMs; });
    var out = [];
    sorted.forEach(function (s) {
      var prev = out[out.length - 1];
      if (prev && s.triggerMs <= prev.seekTargetMs + gap) {
        if (s.seekTargetMs > prev.seekTargetMs) prev.seekTargetMs = s.seekTargetMs;
        return;
      }
      out.push(Object.assign({}, s));
    });
    return out;
  }

  /** Keep segments inside the real video and drop anything degenerate. */
  function clampToDuration(segments, videoDurationMs) {
    if (!videoDurationMs) return segments.slice();
    return segments.map(function (s) {
      return Object.assign({}, s, {
        triggerMs: Math.max(0, Math.min(s.triggerMs, videoDurationMs)),
        seekTargetMs: Math.max(0, Math.min(s.seekTargetMs, videoDurationMs))
      });
    }).filter(function (s) { return s.seekTargetMs > s.triggerMs; });
  }

  /**
   * Drop segments the playhead is already past. A lookup that answers late
   * must never cause a backwards seek.
   */
  function dropPassed(segments, currentMs) {
    return segments.filter(function (s) { return s.seekTargetMs > currentMs; });
  }

  var api = {
    ALL_CATEGORIES: ALL_CATEGORIES,
    LABELS: LABELS,
    DEFAULTS: DEFAULTS,
    fromSponsorBlock: fromSponsorBlock,
    hashPrefix: hashPrefix,
    mergeOverlapping: mergeOverlapping,
    clampToDuration: clampToDuration,
    dropPassed: dropPassed
  };

  root.ASSegments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
