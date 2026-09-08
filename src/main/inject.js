/**
 * AutoSkip — MAIN-world engine.
 *
 * Runs in the page's own context at document_start, which an isolated content
 * script cannot do:
 *   1. window.fetch / XMLHttpRequest must be patched BEFORE YouTube issues its
 *      first request, or the Jump Ahead data is missed.
 *   2. #movie_player.seekTo() is a page object; an isolated world can't call it.
 *
 * Strategy: read the `timelyActions` data that YouTube builds the Jump Ahead
 * chip from, and seek past the segment ourselves. The chip never has to be
 * visible — which is the whole point, since YouTube only renders it while the
 * player controls are shown.
 */
(function () {
  'use strict';

  var M = globalThis.ASMarkers;
  if (!M) return;
  if (globalThis.__autoskipMainLoaded) return;
  globalThis.__autoskipMainLoaded = true;

  var VERSION = '0.2.0';
  var TAG = '__autoskip';
  var PREFIX = '[autoskip]';

  // Mirror of common/defaults.js; real values arrive from the isolated bridge.
  var settings = {
    enabled: true,
    jumpAhead: true,
    maxJumpsPerVideo: 20,
    cooldownMs: 1500,
    minAdvanceMs: 250,
    tier2Fallback: true,
    forceTier2: false,
    debug: false
  };

  var blocked = false;

  function log() {
    if (!settings.debug) return;
    console.log.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
  }
  function warn() {
    console.warn.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
  }
  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ───────────────────────────────────────────────────── per-video state

  var videos = new Map();
  var MAX_TRACKED = 20;
  var seenPayloads = 0;

  function stateFor(videoId) {
    var st = videos.get(videoId);
    if (!st) {
      st = {
        videoId: videoId,
        ranges: [],
        segments: [],
        rejected: [],
        titles: [],
        consumed: new Set(),
        jumps: 0,
        lastJumpAt: 0,
        lastJumpTargetSec: -1,
        suspended: false,
        announced: false,
        sources: []
      };
      videos.set(videoId, st);
      if (videos.size > MAX_TRACKED) videos.delete(videos.keys().next().value);
    }
    return st;
  }

  function currentVideoId() {
    try {
      if (location.pathname !== '/watch') return null;
      return new URLSearchParams(location.search).get('v');
    } catch (e) { return null; }
  }

  // ─────────────────────────────────────────────────────────── messaging

  function post(type, data) {
    var msg = { dir: 'main->iso', type: type };
    msg[TAG] = true;
    if (data) for (var k in data) msg[k] = data[k];
    try { window.postMessage(msg, location.origin); } catch (e) { /* teardown */ }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d[TAG] !== true || d.dir !== 'iso->main') return;

    if (d.type === 'settings' && d.settings) {
      for (var k in d.settings) {
        if (Object.prototype.hasOwnProperty.call(settings, k)) settings[k] = d.settings[k];
      }
      log('settings updated', settings);
    } else if (d.type === 'blocked') {
      blocked = !!d.blocked;
    } else if (d.type === 'chip-sighting') {
      // The DOM layer saw a real Jump Ahead chip. If we have no data for this
      // video, our extraction missed something — say so loudly, because this
      // is the single most useful signal for diagnosing a payload change.
      var st = videos.get(currentVideoId());
      if (!st || !st.ranges.length) {
        warn('chip sighting with NO extracted segments — the payload shape may have ' +
          'changed. Run __autoskip.report() and check rejected entries.');
      }
    }
  });

  // ──────────────────────────────────────────────────── data ingestion

  function ingest(payload, source) {
    if (!payload || typeof payload !== 'object') return null;
    seenPayloads++;

    var rejected = [];
    var segments;
    try {
      segments = M.extractAllSegments(payload, rejected);
    } catch (e) {
      warn('extraction failed from ' + source, e);
      return null;
    }

    var videoId = M.findVideoId(payload) || currentVideoId();
    if (!videoId) return null;

    var st = stateFor(videoId);
    if (rejected.length) st.rejected = rejected;
    if (st.sources.indexOf(source) === -1) st.sources.push(source);

    if (!segments.length) {
      if (!st.announced) { st.announced = true; announce(st); }
      log('no jump-ahead segments in', source, 'for', videoId,
        rejected.length ? '(' + rejected.length + ' rejected — see __autoskip.report())' : '');
      return st;
    }

    st.segments = segments;
    st.ranges = M.buildRanges(segments);
    st.titles = segments.map(function (s) { return s.label; }).filter(Boolean);
    st.announced = true;

    log('captured', st.ranges.length, 'jump range(s) from', source, 'for', videoId);
    st.ranges.forEach(function (r) {
      log('  ' + fmt(r.start) + ' → ' + fmt(r.end) +
        '  (saves ' + Math.round((r.end - r.start) / 1000) + 's, ' + r.source + ')  "' + r.title + '"');
    });

    announce(st);
    return st;
  }

  function announce(st) {
    post('status', {
      videoId: st.videoId,
      hasMarkers: st.ranges.length > 0,
      rangeCount: st.ranges.length,
      titles: st.titles
    });
  }

  // ──────────────────────────────────────────── network / global capture

  /**
   * `get_watch` is the endpoint that matters for SPA navigation on the current
   * web build — verified live: clicking to another video fires
   * /youtubei/v1/get_watch, not /youtubei/v1/player. The trailing (\?|$)
   * excludes /youtubei/v1/player/heartbeat, which fires constantly and never
   * carries this data.
   */
  var INTERESTING = /\/youtubei\/v1\/(player|next|get_watch|reel_watch_sequence)(\?|$)/;

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
      var p = nativeFetch.apply(this, arguments);
      if (url && INTERESTING.test(url)) {
        p.then(function (res) {
          try {
            res.clone().json()
              .then(function (j) { ingest(j, 'fetch ' + url.split('?')[0].split('/').pop()); })
              .catch(function () {});
          } catch (e) {}
          return res;
        }).catch(function () {});
      }
      return p;
    };
  }

  var nativeOpen = XMLHttpRequest.prototype.open;
  var nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__autoskipUrl = url; } catch (e) {}
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    try {
      if (self.__autoskipUrl && INTERESTING.test(self.__autoskipUrl)) {
        self.addEventListener('load', function () {
          try {
            var body = null;
            // Reading .responseText throws when responseType is set.
            if (self.responseType === 'json') body = self.response;
            else if (self.responseType === '' || self.responseType === 'text') {
              body = self.responseText ? JSON.parse(self.responseText) : null;
            }
            if (body) ingest(body, 'xhr ' + String(self.__autoskipUrl).split('?')[0].split('/').pop());
          } catch (e) {}
        });
      }
    } catch (e) {}
    return nativeSend.apply(this, arguments);
  };

  // The first video's data is inlined in the HTML, never fetched. Trap the
  // assignment rather than polling. (After YouTube sets these they become
  // non-configurable, so this only works from document_start — the catch
  // branch still ingests whatever is already there.)
  ['ytInitialPlayerResponse', 'ytInitialData'].forEach(function (prop) {
    var stored = window[prop];
    try {
      Object.defineProperty(window, prop, {
        configurable: true,
        enumerable: true,
        get: function () { return stored; },
        set: function (v) { stored = v; try { ingest(v, 'window.' + prop); } catch (e) {} }
      });
    } catch (e) {
      warn('could not trap window.' + prop + ' (script ran late?)');
    }
    if (stored) { try { ingest(stored, 'window.' + prop + ' (already set)'); } catch (e) {} }
  });

  // ───────────────────────────────────────────────────────── the engine

  var attached = new WeakSet();
  var selfSeekAt = 0;

  function getPlayer() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }
  function getVideo() {
    var p = getPlayer();
    return (p && p.querySelector('video.html5-main-video')) ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video.html5-main-video');
  }
  function adShowing(player) {
    return !!(player && player.classList && player.classList.contains('ad-showing'));
  }

  function tick() {
    if (!settings.enabled || !settings.jumpAhead || blocked) return;
    if (settings.forceTier2) return;

    var videoId = currentVideoId();
    if (!videoId) return;
    var st = videos.get(videoId);
    if (!st || !st.ranges.length || st.suspended) return;
    if (st.jumps >= settings.maxJumpsPerVideo) return;

    var now = Date.now();
    if (now - st.lastJumpAt < settings.cooldownMs) return;

    var video = getVideo();
    var player = getPlayer();
    if (!video || video.paused || video.readyState < 2) return;
    if (adShowing(player)) return;

    var decision = M.decideJump({
      ranges: st.ranges,
      currentMillis: video.currentTime * 1000,
      consumed: st.consumed,
      minAdvanceMs: settings.minAdvanceMs
    });
    if (!decision.jump) return;

    doSeek(st, decision, video, player, now);
  }

  function doSeek(st, decision, video, player, now) {
    var from = video.currentTime * 1000;
    var targetSec = decision.targetMillis / 1000;

    st.consumed.add(decision.range.id);
    st.jumps++;
    st.lastJumpAt = now;
    st.lastJumpTargetSec = targetSec;
    selfSeekAt = now;

    try {
      if (player && typeof player.seekTo === 'function') player.seekTo(targetSec, true);
      else video.currentTime = targetSec;
    } catch (e) {
      warn('seek failed', e);
      return;
    }

    console.log(PREFIX + ' jumped ' + fmt(from) + ' → ' + fmt(decision.targetMillis) +
      '  (saved ' + Math.round(decision.savedMillis / 1000) + 's)');

    post('jump', { videoId: st.videoId, millisSaved: decision.savedMillis, source: decision.range.source });
  }

  function onSeeking(video) {
    var now = Date.now();
    if (now - selfSeekAt < 500) return; // our own seek echoes here

    var st = videos.get(currentVideoId());
    if (!st || !st.lastJumpAt) return;

    // A manual seek shortly after our jump, landing before where we sent them,
    // means the user is undoing it. Stop auto-jumping on this video.
    var undoWindow = Math.max(settings.cooldownMs, 1500) + 4000;
    if (now - st.lastJumpAt < undoWindow && video.currentTime < st.lastJumpTargetSec) {
      st.suspended = true;
      console.log(PREFIX + ' you undid an auto-jump — jump-ahead suspended for this video');
      post('suspended', { videoId: st.videoId });
    }
  }

  function attach() {
    var video = getVideo();
    if (!video || attached.has(video)) return;
    attached.add(video);
    video.addEventListener('timeupdate', tick, { passive: true });
    video.addEventListener('seeking', function () { onSeeking(video); }, { passive: true });
    log('attached to video element');
  }

  setInterval(attach, 1000);
  attach();

  ['yt-navigate-finish', 'yt-page-data-updated'].forEach(function (evt) {
    window.addEventListener(evt, function () {
      setTimeout(function () {
        attach();
        var id = currentVideoId();
        if (!id) return;
        var st = videos.get(id);
        if (st) announce(st);
        else post('status', { videoId: id, hasMarkers: false, rangeCount: 0, titles: [] });
      }, 0);
    });
  });

  // ─────────────────────────────────────────────── diagnostic surface

  /**
   * Exposed deliberately: without a Premium session there is no other way to
   * prove the pipeline end to end. Everything here is read-only except
   * simulate()/reset(), which only affect this tab's in-memory state.
   */
  globalThis.__autoskip = {
    version: VERSION,

    state: function () {
      var id = currentVideoId();
      var st = videos.get(id);
      if (!st) return { videoId: id, tracked: false, payloadsSeen: seenPayloads };
      return {
        videoId: st.videoId,
        ranges: st.ranges,
        segments: st.segments,
        rejected: st.rejected,
        consumed: Array.from(st.consumed),
        jumps: st.jumps,
        suspended: st.suspended,
        sources: st.sources,
        payloadsSeen: seenPayloads
      };
    },

    settings: function () { return JSON.parse(JSON.stringify(settings)); },

    ingest: function (payload) { return ingest(payload, 'manual'); },

    /**
     * Inject a synthetic Jump Ahead segment relative to the current playhead,
     * in the exact shape YouTube sends (decoy command included), then let the
     * normal engine act on it. Proves capture → parse → decide → seek without
     * needing a video that actually offers Jump Ahead.
     */
    simulate: function (inSeconds, jumpSeconds) {
      inSeconds = typeof inSeconds === 'number' ? inSeconds : 5;
      jumpSeconds = typeof jumpSeconds === 'number' ? jumpSeconds : 30;

      var video = getVideo();
      var id = currentVideoId();
      if (!video || !id) { console.warn(PREFIX + ' simulate: not on a watch page with a video'); return null; }

      var triggerMs = Math.round(video.currentTime * 1000) + inSeconds * 1000;
      var payload = M.makeSyntheticPayload({
        videoId: id,
        triggerMs: triggerMs,
        seekTargetMs: triggerMs + jumpSeconds * 1000,
        label: 'Jump ahead (simulated)'
      });

      var st = ingest(payload, 'simulate()');
      console.log(PREFIX + ' simulated a jump at ' + fmt(triggerMs) + ' → ' +
        fmt(triggerMs + jumpSeconds * 1000) + '. Let it play; it should jump in ~' + inSeconds + 's.');
      if (!settings.enabled || !settings.jumpAhead) {
        console.warn(PREFIX + ' NOTE: jump-ahead is disabled in settings, so nothing will fire.');
      }
      return st ? st.ranges : null;
    },

    reset: function () {
      var id = currentVideoId();
      videos.delete(id);
      console.log(PREFIX + ' cleared state for ' + id);
    },

    report: function () {
      var s = this.state();
      console.log(PREFIX + ' ── report ────────────────────────────────');
      console.log('  version        ', VERSION);
      console.log('  video          ', s.videoId);
      console.log('  payloads seen  ', s.payloadsSeen, s.payloadsSeen ? '' : '  ← ZERO: capture never ran (script not at document_start?)');
      console.log('  data sources   ', (s.sources || []).join(', ') || '(none)');
      console.log('  jump ranges    ', (s.ranges || []).length);
      (s.ranges || []).forEach(function (r) {
        console.log('     ' + fmt(r.start) + ' → ' + fmt(r.end) + '  "' + r.title + '"  [' + r.source + ']');
      });
      console.log('  rejected       ', (s.rejected || []).length);
      (s.rejected || []).forEach(function (r) { console.log('     ', r); });
      console.log('  jumps made     ', s.jumps, s.suspended ? '(SUSPENDED — you undid one)' : '');
      console.log('  settings       ', this.settings());
      var chip = document.querySelector('.ytp-jump-ahead-button');
      console.log('  chip in DOM    ', chip ? 'YES ' + JSON.stringify(chip.getBoundingClientRect().width + 'x' + chip.getBoundingClientRect().height) : 'no');
      console.log(PREFIX + ' ──────────────────────────────────────────');
      return s;
    }
  };

  log('MAIN world ready (v' + VERSION + ') — try __autoskip.report()');
  post('ready', {});
})();
