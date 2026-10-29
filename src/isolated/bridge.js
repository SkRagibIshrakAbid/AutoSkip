/**
 * AutoSkip — isolated-world bridge.
 *
 * chrome.* APIs only exist here; #movie_player.seekTo only exists in the MAIN
 * world. This file owns settings, stats and the blocklist, and relays them
 * across the world boundary via window.postMessage.
 */
(function () {
  'use strict';

  var D = globalThis.ASDefaults;
  if (!D) return;
  if (globalThis.__autoskipBridgeLoaded) return;
  globalThis.__autoskipBridgeLoaded = true;

  var TAG = D.TAG;

  // Shared with dom-actions.js — same extension, same page, same isolated world.
  var shared = globalThis.ASState = {
    settings: D.withDefaults(null),
    // videoId -> what tier 1 reported for it. Keyed rather than a single
    // "latest" value because YouTube prefetches the next video's response
    // while the current one is still playing; a single slot would let video
    // B's status be read as video A's.
    reported: Object.create(null),
    blocked: false,
    log: function () {
      if (!shared.settings.debug) return;
      var args = [D.LOG_PREFIX].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    },
    bump: bump
  };

  function alive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ------------------------------------------------------------------ messaging

  function toMain(type, data) {
    var msg = { dir: 'iso->main', type: type };
    msg[TAG] = true;
    if (data) for (var k in data) msg[k] = data[k];
    try { window.postMessage(msg, location.origin); } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d[TAG] !== true || d.dir !== 'main->iso') return;

    if (d.type === 'status') {
      if (d.videoId) {
        var keys = Object.keys(shared.reported);
        if (keys.length > 50) delete shared.reported[keys[0]];
        shared.reported[d.videoId] = {
          hasMarkers: !!d.hasMarkers,
          rangeCount: d.rangeCount || 0,
          titles: Array.isArray(d.titles) ? d.titles : []
        };
        shared.log('tier-1 status', d.videoId, shared.reported[d.videoId]);
      }
    } else if (d.type === 'jump') {
      if (d.source === 'sponsorblock' || d.source === 'simulated') {
        bump({ sponsorSkips: 1, sponsorMillisSaved: d.millisSaved || 0 });
        if (globalThis.ASToast) globalThis.ASToast.show(d);
      } else {
        bump({ jumps: 1, millisSaved: d.millisSaved || 0 });
      }
    } else if (d.type === 'undo-done') {
      bump({ sponsorSkips: -1, sponsorMillisSaved: d.millisSaved || 0 });
    } else if (d.type === 'ready') {
      pushSettings();
      evaluateBlocklist();
    } else if (d.type === 'suspended') {
      shared.log('jump-ahead suspended for', d.videoId);
    }
  });

  // ------------------------------------------------------------------- settings

  function pushSettings() {
    toMain('settings', { settings: shared.settings });
  }

  function loadSettings(cb) {
    if (!alive()) return cb && cb();
    try {
      chrome.storage.local.get([D.STORAGE_KEY], function (res) {
        if (chrome.runtime.lastError) return cb && cb();
        shared.settings = D.withDefaults(res && res[D.STORAGE_KEY]);
        pushSettings();
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[D.STORAGE_KEY]) return;
      var wasOn = shared.settings.sponsorSkip;
      shared.settings = D.withDefaults(changes[D.STORAGE_KEY].newValue);
      pushSettings();
      evaluateBlocklist();
      if (!wasOn && shared.settings.sponsorSkip) setTimeout(maybeRunSponsorFlow, 0);
      shared.log('settings changed', shared.settings);
    });
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------------- stats

  var pending = null;
  var flushTimer = 0;

  function bump(delta) {
    pending = pending || {};
    for (var k in delta) pending[k] = (pending[k] || 0) + delta[k];
    if (flushTimer) return;
    // Debounced: a busy video shouldn't hammer storage.
    flushTimer = setTimeout(flushStats, 2000);
  }

  function flushStats() {
    flushTimer = 0;
    var delta = pending;
    pending = null;
    if (!delta || !alive()) return;
    try {
      chrome.storage.local.get([D.STATS_KEY], function (res) {
        if (chrome.runtime.lastError) return;
        var stats = Object.assign({}, D.STATS, res && res[D.STATS_KEY]);
        for (var k in delta) stats[k] = (stats[k] || 0) + delta[k];
        var payload = {};
        payload[D.STATS_KEY] = stats;
        chrome.storage.local.set(payload);
      });
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('pagehide', flushStats);

  // ------------------------------------------------------------------ blocklist

  function currentVideoId() {
    try {
      if (location.pathname !== '/watch') return null;
      return new URLSearchParams(location.search).get('v');
    } catch (e) { return null; }
  }

  function currentChannel() {
    var sel = [
      '#owner #channel-name a',
      'ytd-video-owner-renderer #channel-name a',
      'ytd-channel-name#channel-name a',
      '#upload-info #channel-name a'
    ];
    for (var i = 0; i < sel.length; i++) {
      var el = document.querySelector(sel[i]);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return null;
  }

  function evaluateBlocklist() {
    var list = (shared.settings.blocklist || []).map(function (s) {
      return String(s).trim().toLowerCase();
    }).filter(Boolean);

    var next = false;
    if (list.length) {
      var vid = (currentVideoId() || '').toLowerCase();
      var chan = (currentChannel() || '').toLowerCase();
      next = list.some(function (entry) {
        if (vid && entry === vid) return true;
        return !!chan && chan.indexOf(entry) !== -1;
      });
    }

    if (next !== shared.blocked) {
      shared.blocked = next;
      toMain('blocked', { blocked: next });
      shared.log('blocklist ->', next ? 'BLOCKED' : 'allowed');
    }
  }

  // The channel name renders well after navigation, so re-check for a while.
  function recheckBlocklist() {
    var tries = 0;
    var iv = setInterval(function () {
      evaluateBlocklist();
      if (++tries >= 10) clearInterval(iv);
    }, 1000);
  }

  ['yt-navigate-finish', 'yt-page-data-updated'].forEach(function (evt) {
    window.addEventListener(evt, recheckBlocklist);
  });

  // ──────────────────────────────────────────── sponsor-segment flow

  /**
   * Ask the service worker for this video's SponsorBlock segments and hand
   * them to the engine in the page. The worker does the network call and owns
   * the cache, so this stays a single round trip.
   */
  var sponsorRuns = Object.create(null);

  function sendToWorker(msg) {
    return new Promise(function (resolve) {
      if (!alive()) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r);
        });
      } catch (e) { resolve(null); }
    });
  }

  async function runSponsorFlow(videoId) {
    if (!videoId || sponsorRuns[videoId]) return;
    if (!shared.settings.enabled || !shared.settings.sponsorSkip) return;
    if (shared.blocked) return;
    sponsorRuns[videoId] = true;

    var res = await sendToWorker({ type: 'getSegments', videoId: videoId });
    if (!res) { delete sponsorRuns[videoId]; return; }

    if (res.meta && res.meta.error) {
      // A failed lookup is retried on the next visit rather than given up on.
      delete sponsorRuns[videoId];
      shared.log('SponsorBlock lookup failed:', res.meta.error);
      return;
    }
    if (!res.segments || !res.segments.length) {
      shared.log('no sponsor segments for', videoId, res.meta || '');
      return;
    }
    toMain('sponsor-segments', { videoId: videoId, segments: res.segments, meta: res.meta });
  }

  function maybeRunSponsorFlow() {
    var id = currentVideoId();
    if (id) runSponsorFlow(id);
  }

  ['yt-navigate-finish', 'yt-page-data-updated'].forEach(function (evt) {
    window.addEventListener(evt, function () { setTimeout(maybeRunSponsorFlow, 300); });
  });
  setTimeout(maybeRunSponsorFlow, 1200);

  globalThis.ASSponsorFlow = { run: runSponsorFlow, rerun: function (id) {
    delete sponsorRuns[id || currentVideoId()];
    maybeRunSponsorFlow();
  } };

  loadSettings(function () {
    pushSettings();
    recheckBlocklist();
  });

  shared.log('isolated bridge ready');
})();
