/**
 * AutoSkip — pure Jump Ahead logic.
 *
 * No DOM, no chrome APIs. Loaded both as a MAIN-world content script (assigns
 * globalThis.ASMarkers) and as a CommonJS module by test/markers.test.js.
 *
 * ── Where Jump Ahead actually lives ──────────────────────────────────────
 *
 * The desktop chip is driven by `timelyActions`, normally wrapped in a
 * `timelyActionsOverlayViewModel`. Each entry looks like:
 *
 *   { timelyActionViewModel: {
 *       startTimeMilliseconds: "30000",          // when the chip appears
 *       content: { buttonViewModel: { title: "Jump ahead", ... } },
 *       rendererContext: { commandContext: { onTap: {
 *         serialCommand: { commands: [
 *           { innertubeCommand: { seekToVideoTimestampCommand: {
 *               offsetFromVideoStartMilliseconds: "72000"   // where it lands
 *           } } }
 *         ] } } } } } }
 *
 * Two traps, both learned the hard way (see jiahongc/auto-jump-ahead-for-youtube,
 * which documents the second as a real regression it shipped and fixed):
 *
 *   1. The field is `offsetFromVideoStartMilliseconds` — not `...Millis`.
 *   2. `onTap` contains MULTIPLE seekToVideoTimestampCommands. A blind deep
 *      search finds the wrong one. The extraction below is an explicit,
 *      ordered path for exactly that reason.
 */
(function (root) {
  'use strict';

  var SMART_SKIP = 'SOURCE_TYPE_SMART_SKIP';
  var DEFAULT_DURATION_MS = 10000;

  // A jump has to move a sane distance to be believable.
  var MIN_DELTA_MS = 1000;
  var MAX_DELTA_MS = 900000; // 15 min

  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    var n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function isObj(v) {
    return v !== null && typeof v === 'object';
  }

  /** Collect the value of every occurrence of `key`, at any depth. */
  function findDeepAll(node, key, out, depth, seen) {
    out = out || [];
    depth = depth || 0;
    seen = seen || new Set();
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
   * Pull the seek target (ms) out of an onTap command bundle.
   *
   * Deliberately an explicit ordered path, NOT a deep search: onTap carries
   * several seekToVideoTimestampCommands (logging/telemetry variants among
   * them) and grabbing the first one found at arbitrary depth yields the wrong
   * destination.
   */
  function extractSeekTargetFromOnTap(onTap) {
    if (!isObj(onTap)) return null;

    var lists = [
      onTap.serialCommand && onTap.serialCommand.commands,
      onTap.commandExecutorCommand && onTap.commandExecutorCommand.commands
    ];

    for (var i = 0; i < lists.length; i++) {
      var commands = lists[i];
      if (!Array.isArray(commands)) continue;
      for (var j = 0; j < commands.length; j++) {
        var cmd = commands[j];
        if (!isObj(cmd)) continue;
        var seek = (cmd.innertubeCommand && cmd.innertubeCommand.seekToVideoTimestampCommand) ||
          cmd.seekToVideoTimestampCommand;
        var t = num(seek && seek.offsetFromVideoStartMilliseconds);
        if (!Number.isNaN(t) && t > 0) return t;
      }
    }

    var direct = (onTap.innertubeCommand && onTap.innertubeCommand.seekToVideoTimestampCommand) ||
      onTap.seekToVideoTimestampCommand;
    var d = num(direct && direct.offsetFromVideoStartMilliseconds);
    if (!Number.isNaN(d) && d > 0) return d;

    return null;
  }

  function textOf(t) {
    if (typeof t === 'string') return t;
    if (!isObj(t)) return '';
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (typeof t.content === 'string') return t.content;
    if (Array.isArray(t.runs)) {
      return t.runs.map(function (r) { return r && r.text ? r.text : ''; }).join('');
    }
    return '';
  }

  /**
   * PRIMARY source. Returns [{ label, triggerMs, seekTargetMs, source }].
   * `rejected` (optional array) collects why entries were dropped — the
   * diagnostic surface depends on knowing this.
   */
  function extractJumpAheadSegments(payload, rejected) {
    var segments = [];
    if (!isObj(payload)) return segments;

    var lists = findDeepAll(payload, 'timelyActions');

    lists.forEach(function (timelyActions) {
      if (!Array.isArray(timelyActions)) return;

      timelyActions.forEach(function (action) {
        var vm = action && action.timelyActionViewModel;
        if (!vm) {
          if (rejected) rejected.push({ reason: 'no-view-model', keys: isObj(action) ? Object.keys(action) : null });
          return;
        }

        var button = vm.content && vm.content.buttonViewModel;
        var label = textOf(button && button.title) ||
          textOf(button && button.accessibilityText) ||
          'Jump ahead';

        var triggerMs = num(vm.startTimeMilliseconds);
        if (Number.isNaN(triggerMs)) triggerMs = num(vm.startTimeMs);
        if (Number.isNaN(triggerMs)) {
          if (rejected) rejected.push({ label: label, reason: 'no-trigger-time', vmKeys: Object.keys(vm) });
          return;
        }

        var onTap = vm.rendererContext &&
          vm.rendererContext.commandContext &&
          vm.rendererContext.commandContext.onTap;
        var seekTargetMs = extractSeekTargetFromOnTap(onTap);
        if (!seekTargetMs) {
          if (rejected) {
            rejected.push({
              label: label, triggerMs: triggerMs, reason: 'no-seek-target',
              onTapKeys: isObj(onTap) ? Object.keys(onTap) : null
            });
          }
          return;
        }

        var delta = seekTargetMs - triggerMs;
        if (delta < MIN_DELTA_MS || delta > MAX_DELTA_MS) {
          if (rejected) {
            rejected.push({ label: label, triggerMs: triggerMs, seekTargetMs: seekTargetMs, reason: 'delta-out-of-bounds' });
          }
          return;
        }

        segments.push({
          label: label,
          triggerMs: triggerMs,
          seekTargetMs: seekTargetMs,
          source: 'timely-actions'
        });
      });
    });

    return segments;
  }

  /**
   * SECONDARY source: smart-skip macro markers. The player's base.js does
   * consume these, but they are not what drives the desktop chip today, so
   * they only ever supplement the timelyActions result.
   */
  function extractSmartSkipSegments(payload) {
    var segments = [];
    if (!isObj(payload)) return segments;

    findDeepAll(payload, 'markers').forEach(function (markers) {
      if (!Array.isArray(markers)) return;
      markers.forEach(function (m) {
        if (!isObj(m) || m.sourceType !== SMART_SKIP) return;
        var start = num(m.startMillis);
        if (Number.isNaN(start)) return;
        var dur = num(m.durationMillis);
        if (Number.isNaN(dur)) dur = DEFAULT_DURATION_MS;
        segments.push({
          label: textOf(m.title) || 'Jump ahead',
          triggerMs: start,
          seekTargetMs: start + dur,
          source: 'smart-skip-marker'
        });
      });
    });

    return segments;
  }

  /** Both sources, primary first, de-duplicated by trigger time. */
  function extractAllSegments(payload, rejected) {
    var all = extractJumpAheadSegments(payload, rejected).concat(extractSmartSkipSegments(payload));
    var seen = Object.create(null);
    return all.filter(function (s) {
      var key = s.triggerMs + ':' + s.seekTargetMs;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  /**
   * Turn segments into the ranges the engine watches. Sorted by trigger,
   * overlaps clipped so an earlier range never swallows the next trigger.
   */
  function buildRanges(segments) {
    var sorted = segments
      .filter(function (s) { return Number.isFinite(s.triggerMs) && Number.isFinite(s.seekTargetMs); })
      .slice()
      .sort(function (a, b) { return a.triggerMs - b.triggerMs; });

    var ranges = [];
    var prev = null;

    sorted.forEach(function (s, i) {
      if (prev && prev.end > s.triggerMs) prev.end = s.triggerMs;
      var r = {
        id: 'r' + i + '@' + s.triggerMs,
        start: s.triggerMs,
        end: s.seekTargetMs,
        title: s.label,
        source: s.source
      };
      ranges.push(r);
      prev = r;
    });

    return ranges.filter(function (r) { return r.end > r.start; });
  }

  /**
   * The video id a payload is about, so a prefetched response can't leak into
   * whatever is currently playing. Ordered by authority: a single response is
   * full of OTHER videos' ids (related videos, endscreen suggestions), so
   * taking the first one found would often identify a sidebar recommendation.
   */
  function findVideoId(root, maxDepth) {
    var depth = typeof maxDepth === 'number' ? maxDepth : 24;
    var probes = [
      function (n) { return typeof n.externalVideoId === 'string' && n.externalVideoId ? n.externalVideoId : null; },
      function (n) {
        return n.videoDetails && typeof n.videoDetails.videoId === 'string' && n.videoDetails.videoId.length === 11
          ? n.videoDetails.videoId : null;
      },
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

  function pickActiveRange(ranges, currentMillis, consumed) {
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (consumed && consumed.has(r.id)) continue;
      if (currentMillis >= r.start && currentMillis < r.end) return r;
    }
    return null;
  }

  /**
   * Full decision for one tick. Pure, so every safety rule is testable
   * without a browser.
   */
  function decideJump(opts) {
    var ranges = opts.ranges || [];
    var currentMillis = opts.currentMillis;
    var consumed = opts.consumed;
    var minAdvanceMs = typeof opts.minAdvanceMs === 'number' ? opts.minAdvanceMs : 250;

    if (!ranges.length) return { jump: false, reason: 'no-ranges' };

    var range = pickActiveRange(ranges, currentMillis, consumed);
    if (!range) return { jump: false, reason: 'not-in-range' };

    if (!(range.end > currentMillis + minAdvanceMs)) {
      return { jump: false, reason: 'target-not-ahead', range: range };
    }

    return {
      jump: true,
      range: range,
      targetMillis: range.end,
      savedMillis: range.end - currentMillis
    };
  }

  /** Build a payload in the real timelyActions shape — used by simulate(). */
  function makeSyntheticPayload(opts) {
    return [{
      playerOverlays: {
        timelyActionsOverlayViewModel: {
          timelyActions: [{
            timelyActionViewModel: {
              startTimeMilliseconds: String(opts.triggerMs),
              content: { buttonViewModel: { title: opts.label || 'Jump ahead (simulated)' } },
              rendererContext: {
                commandContext: {
                  onTap: {
                    serialCommand: {
                      commands: [
                        { innertubeCommand: { loggingCommand: { note: 'decoy that a blind search would hit first' } } },
                        { innertubeCommand: { seekToVideoTimestampCommand: {
                          offsetFromVideoStartMilliseconds: String(opts.seekTargetMs)
                        } } }
                      ]
                    }
                  }
                }
              }
            }
          }]
        }
      },
      videoDetails: { videoId: opts.videoId }
    }];
  }

  var api = {
    SMART_SKIP: SMART_SKIP,
    DEFAULT_DURATION_MS: DEFAULT_DURATION_MS,
    MIN_DELTA_MS: MIN_DELTA_MS,
    MAX_DELTA_MS: MAX_DELTA_MS,
    findDeepAll: findDeepAll,
    extractSeekTargetFromOnTap: extractSeekTargetFromOnTap,
    extractJumpAheadSegments: extractJumpAheadSegments,
    extractSmartSkipSegments: extractSmartSkipSegments,
    extractAllSegments: extractAllSegments,
    buildRanges: buildRanges,
    findVideoId: findVideoId,
    pickActiveRange: pickActiveRange,
    decideJump: decideJump,
    makeSyntheticPayload: makeSyntheticPayload,
    _textOf: textOf
  };

  root.ASMarkers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
