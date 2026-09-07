/**
 * AutoSkip — MAIN-world engine.
 *
 * Runs in the page's own context at document_start, which is required for two
 * reasons an isolated content script cannot satisfy:
 *   1. window.fetch / XMLHttpRequest must be patched BEFORE YouTube issues its
 *      first /youtubei/v1/player request, or the markers are missed.
 *   2. #movie_player.seekTo() is a page object; an isolated world can't call it.
 *
 * Tier 1 strategy: read the SMART_SKIP macro-markers straight out of the
 * Innertube payload and seek past them ourselves. The "Jump ahead" chip's
 * visibility becomes irrelevant, which is the whole point — no synthetic
 * hovering, no nudge-seeking, no waiting for the controls to appear.
 */
(function () {
  'use strict';

  var M = globalThis.ASMarkers;
  if (!M) return;
  if (globalThis.__autoskipMainLoaded) return;
  globalThis.__autoskipMainLoaded = true;

  var TAG = '__autoskip';
  var PREFIX = '[autoskip]';

  // Mirror of common/defaults.js — the MAIN world can't import it, and the real
  // values arrive from the isolated bridge moments after startup anyway.
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
    var args = [PREFIX].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }

  function warn() {
    var args = [PREFIX].concat(Array.prototype.slice.call(arguments));
    console.warn.apply(console, args);
  }

  // ------------------------------------------------------------- per-video state

  var videos = new Map();
  var MAX_TRACKED = 20;

  function stateFor(videoId) {
    var st = videos.get(videoId);
    if (!st) {
      st = {
        videoId: videoId,
        ranges: [],
        titles: [],
        consumed: new Set(),
        jumps: 0,
        lastJumpAt: 0,
        lastJumpTargetSec: -1,
        suspended: false,
        announced: false
      };
      videos.set(videoId, st);
      // Bound the map; YouTube sessions can run for hours.
      if (videos.size > MAX_TRACKED) {
        var oldest = videos.keys().next().value;
        videos.delete(oldest);
      }
    }
    return st;
  }

  function currentVideoId() {
    try {
      if (location.pathname !== '/watch') return null;
      return new URLSearchParams(location.search).get('v');
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ messaging

  function post(type, data) {
    var msg = { dir: 'main->iso', type: type };
    msg[TAG] = true;
    if (data) for (var k in data) msg[k] = data[k];
    try {
      window.postMessage(msg, location.origin);
    } catch (e) { /* origin edge cases during teardown */ }
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
      log('blocked =', blocked);
    }
  });

  // ------------------------------------------------------------ marker ingestion

  function ingest(payload, source) {
    if (!payload || typeof payload !== 'object') return;

    var markers;
    try {
      markers = M.extractSmartSkipMarkers(payload);
    } catch (e) {
      warn('marker parse failed from ' + source, e);
      return;
    }

    // Key off the payload's own video id so a prefetched next-video response
    // can never be applied to whatever is playing right now.
    var videoId = M.findVideoId(payload) || currentVideoId();
    if (!videoId) return;

    if (!markers.length) {
      log('no smart-skip markers in', source, 'for', videoId,
        '(expected for non-Premium / non-US / non-English)');
      var empty = stateFor(videoId);
      if (!empty.announced) {
        empty.announced = true;
        announce(empty);
      }
      return;
    }

    var ranges = M.buildRanges(markers);
    var st = stateFor(videoId);
    st.ranges = ranges;
    st.titles = markers.map(function (m) { return m.title; }).filter(Boolean);
    st.announced = true;

    log('captured', ranges.length, 'jump-ahead range(s) from', source, 'for', videoId, ranges);
    if (settings.debug) {
      ranges.forEach(function (r) {
        var t = M.resolveTarget(r);
        log('  range', fmt(r.start), '->', fmt(r.end),
          '| target', fmt(t.millis), '(' + t.source + ')',
          '| title:', JSON.stringify(r.title));
      });
    }
    announce(st);
  }

  function announce(st) {
    post('status', {
      videoId: st.videoId,
      hasMarkers: st.ranges.length > 0,
      rangeCount: st.ranges.length,
      titles: st.titles
    });
  }

  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // --------------------------------------------------- network / global capture

  /**
   * Endpoints that can carry macro-marker data.
   *
   * `get_watch` is the one that actually matters for SPA navigation on the
   * current web build — verified live: clicking through to another video fires
   * /youtubei/v1/get_watch, not /youtubei/v1/player. Missing it would mean
   * tier 1 only ever worked on the first, hard-loaded video.
   *
   * The trailing (\?|$) deliberately excludes /youtubei/v1/player/heartbeat,
   * which fires every few seconds and never carries markers.
   */
  var INTERESTING = /\/youtubei\/v1\/(player|next|get_watch|reel_watch_sequence)(\?|$)/;

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch (e) { /* ignore */ }

      var p = nativeFetch.apply(this, arguments);
      if (url && INTERESTING.test(url)) {
        p.then(function (res) {
          try {
            res.clone().json().then(function (json) {
              ingest(json, 'fetch ' + url.split('?')[0]);
            }).catch(function () { /* not json / already consumed */ });
          } catch (e) { /* ignore */ }
          return res;
        }).catch(function () { /* the page handles its own failures */ });
      }
      return p;
    };
  }

  var nativeOpen = XMLHttpRequest.prototype.open;
  var nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__autoskipUrl = url; } catch (e) { /* ignore */ }
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    try {
      if (self.__autoskipUrl && INTERESTING.test(self.__autoskipUrl)) {
        self.addEventListener('load', function () {
          try {
            var body = null;
            // Reading .responseText throws outright when responseType is set,
            // so go through .response for anything but the default/text case.
            if (self.responseType === 'json') {
              body = self.response;
            } else if (self.responseType === '' || self.responseType === 'text') {
              body = self.responseText ? JSON.parse(self.responseText) : null;
            }
            if (body) ingest(body, 'xhr ' + String(self.__autoskipUrl).split('?')[0]);
          } catch (e) { /* not json, or an opaque response type */ }
        });
      }
    } catch (e) { /* ignore */ }
    return nativeSend.apply(this, arguments);
  };

  // The very first video's markers arrive inlined in the HTML, never over the
  // network. Trap the assignment instead of polling for it.
  ['ytInitialPlayerResponse', 'ytInitialData'].forEach(function (prop) {
    var stored = window[prop];
    try {
      Object.defineProperty(window, prop, {
        configurable: true,
        enumerable: true,
        get: function () { return stored; },
        set: function (v) {
          stored = v;
          try { ingest(v, 'window.' + prop); } catch (e) { /* ignore */ }
        }
      });
    } catch (e) {
      warn('could not trap window.' + prop, e);
    }
    if (stored) { try { ingest(stored, 'window.' + prop + ' (already set)'); } catch (e) { /* ignore */ } }
  });

  // ------------------------------------------------------------------- the engine

  var attached = new WeakSet();
  var selfSeekAt = 0;

  function getPlayer() {
    return document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player');
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

    var targetSec = decision.target.millis / 1000;
    st.consumed.add(decision.range.id);
    st.jumps++;
    st.lastJumpAt = now;
    st.lastJumpTargetSec = targetSec;
    selfSeekAt = now;

    try {
      if (player && typeof player.seekTo === 'function') {
        player.seekTo(targetSec, true);
      } else {
        video.currentTime = targetSec;
      }
    } catch (e) {
      warn('seek failed', e);
      return;
    }

    log('jumped', fmt(video.currentTime * 1000), '->', fmt(decision.target.millis),
      '(' + decision.target.source + ', saved ' + Math.round(decision.savedMillis / 1000) + 's)');

    post('jump', {
      videoId: videoId,
      millisSaved: decision.savedMillis,
      source: decision.target.source
    });
  }

  function onSeeking(video) {
    var now = Date.now();
    // Our own seek fires this too; ignore anything within the echo window.
    if (now - selfSeekAt < 500) return;

    var videoId = currentVideoId();
    if (!videoId) return;
    var st = videos.get(videoId);
    if (!st || !st.lastJumpAt) return;

    // A manual seek shortly after our jump, landing before where we sent them,
    // means the user is undoing it. Stop auto-jumping on this video.
    var undoWindow = Math.max(settings.cooldownMs, 1500) + 4000;
    if (now - st.lastJumpAt < undoWindow && video.currentTime < st.lastJumpTargetSec) {
      st.suspended = true;
      log('user undid an auto-jump — suspending jump-ahead for', videoId);
      post('suspended', { videoId: videoId });
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

  // timeupdate is the primary driver (~4Hz while playing); this interval only
  // (re)attaches after SPA navigation swaps the media element.
  setInterval(attach, 1000);
  attach();

  // Reset nothing on navigation — state is keyed per video id, so stale ranges
  // simply stop matching. We only re-announce so the isolated side can update
  // its tier-2 fallback for the new video.
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

  log('MAIN world ready');
  post('ready', {});
})();
