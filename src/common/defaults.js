/**
 * AutoSkip — shared defaults and message constants.
 * Classic script: usable as a content script, via importScripts in the service
 * worker, and via a <script> tag in the popup.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    // master switch
    enabled: true,

    // per-action toggles
    jumpAhead: true,
    adSkip: true,
    continueWatching: true,
    suggestedChips: true,

    // jump-ahead tuning
    maxJumpsPerVideo: 20,
    cooldownMs: 1500,
    minAdvanceMs: 250,

    // strategy
    tier2Fallback: true,   // click the chip when no markers were captured
    forceTier2: false,     // debug: pretend tier 1 is unavailable

    // diagnostics
    debug: false,
    captureMode: false,    // log the selector chain of anything clicked in the player

    // "channel name" or 11-char video id, one per line, case-insensitive
    blocklist: []
  };

  var STATS = {
    jumps: 0,
    millisSaved: 0,
    adsSkipped: 0,
    dialogsDismissed: 0,
    chipsClicked: 0
  };

  root.ASDefaults = {
    DEFAULTS: DEFAULTS,
    STATS: STATS,
    STORAGE_KEY: 'settings',
    STATS_KEY: 'stats',
    TAG: '__autoskip',
    LOG_PREFIX: '[autoskip]',

    withDefaults: function (stored) {
      var out = {};
      for (var k in DEFAULTS) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
        out[k] = stored && Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : DEFAULTS[k];
      }
      return out;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ASDefaults;
})(typeof globalThis !== 'undefined' ? globalThis : this);
