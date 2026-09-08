/**
 * AutoSkip — sponsor-segment validation (pure).
 *
 * Turns SponsorBlock rows and LLM output into the SAME shape the existing skip
 * engine already consumes:
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
    minConfidence: 0.7,
    minDurationMs: 3000,
    maxDurationMs: 360000,      // 6 min
    maxFractionOfVideo: 0.25,
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

  // ──────────────────────────────────────────────────────────────── LLM

  /** Models wrap JSON in prose or ``` fences; dig the array/object out. */
  function parseJsonLoose(text) {
    if (isObj(text)) return text;
    if (typeof text !== 'string') return null;
    var t = text.trim();

    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();

    try { return JSON.parse(t); } catch (e) { /* keep digging */ }

    // First balanced array or object in the text.
    var starts = [t.indexOf('['), t.indexOf('{')].filter(function (i) { return i >= 0; });
    if (!starts.length) return null;
    var start = Math.min.apply(null, starts);
    var open = t[start];
    var close = open === '[' ? ']' : '}';
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < t.length; i++) {
      var c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /** Normalized for quote matching: case, punctuation and spacing all ignored. */
  function fold(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Validate model output against the transcript it was given.
   *
   * The model returns LINE INDICES, never timestamps — we map indices to times
   * ourselves, so a fabricated timestamp is structurally impossible. The
   * `quote` check is the second guard: the quoted text must actually appear in
   * the lines the model claims, which a model that pattern-matched "this sounds
   * sponsor-ish" without reading cannot satisfy.
   *
   * Returns { segments, rejected } — rejected carries a reason per entry so the
   * diagnostics can explain why a video produced nothing.
   */
  function fromLlm(raw, lines, options) {
    var parsed = parseJsonLoose(raw);
    var rejected = [];
    if (!parsed) return { segments: [], rejected: [{ reason: 'unparseable-response' }] };

    var list = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed.segments) ? parsed.segments
        : Array.isArray(parsed.results) ? parsed.results
          : null;
    if (!list) return { segments: [], rejected: [{ reason: 'no-segment-array' }] };

    var categories = opt(options, 'categories');
    var minConfidence = opt(options, 'minConfidence');
    var minDurationMs = opt(options, 'minDurationMs');
    var maxDurationMs = opt(options, 'maxDurationMs');
    var maxFraction = opt(options, 'maxFractionOfVideo');
    var videoDurationMs = (options && options.videoDurationMs) ||
      (lines.length ? lines[lines.length - 1].endMs : 0);

    var out = [];

    list.forEach(function (raw) {
      if (!isObj(raw)) { rejected.push({ reason: 'not-an-object' }); return; }

      var a = num(raw.startLine);
      var b = num(raw.endLine);
      var cat = String(raw.category || 'sponsor');
      var conf = num(raw.confidence);
      var quote = raw.quote;

      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        rejected.push({ reason: 'non-integer-line', raw: raw }); return;
      }
      if (a < 0 || b < a || b >= lines.length) {
        rejected.push({ reason: 'line-out-of-range', startLine: a, endLine: b, lineCount: lines.length });
        return;
      }
      if (categories.indexOf(cat) === -1) {
        rejected.push({ reason: 'category-not-enabled', category: cat }); return;
      }
      if (Number.isNaN(conf) || conf < minConfidence) {
        rejected.push({ reason: 'low-confidence', confidence: conf, category: cat }); return;
      }

      // THE anti-hallucination check.
      if (typeof quote !== 'string' || fold(quote).length < 8) {
        rejected.push({ reason: 'missing-quote', category: cat }); return;
      }
      var haystack = fold(lines.slice(a, b + 1).map(function (l) { return l.text; }).join(' '));
      if (haystack.indexOf(fold(quote)) === -1) {
        rejected.push({ reason: 'quote-not-in-transcript', quote: String(quote).slice(0, 80) });
        return;
      }

      var startMs = lines[a].startMs;
      var endMs = lines[b].endMs;
      var duration = endMs - startMs;

      if (duration < minDurationMs) {
        rejected.push({ reason: 'too-short', durationMs: duration }); return;
      }
      var cap = Math.min(maxDurationMs, videoDurationMs ? videoDurationMs * maxFraction : maxDurationMs);
      if (duration > cap) {
        rejected.push({ reason: 'too-long', durationMs: duration, capMs: Math.round(cap) }); return;
      }

      out.push({
        triggerMs: Math.round(startMs),
        seekTargetMs: Math.round(endMs),
        label: labelFor(cat),
        category: cat,
        source: 'llm',
        confidence: conf
      });
    });

    return { segments: mergeOverlapping(out), rejected: rejected };
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
   * Drop segments the playhead is already past. A late LLM result must never
   * cause a backwards seek.
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
    parseJsonLoose: parseJsonLoose,
    fromLlm: fromLlm,
    mergeOverlapping: mergeOverlapping,
    clampToDuration: clampToDuration,
    dropPassed: dropPassed,
    _fold: fold
  };

  root.ASSegments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
