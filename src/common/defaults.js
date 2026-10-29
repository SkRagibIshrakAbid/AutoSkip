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
    blocklist: [],

    // ── sponsor-segment skipping, via SponsorBlock ───────────────────────
    sponsorSkip: false,          // ships OFF
    segCategories: ['sponsor', 'selfpromo'],
    showToast: true
  };

  var STATS = {
    jumps: 0,
    millisSaved: 0,
    adsSkipped: 0,
    dialogsDismissed: 0,
    chipsClicked: 0,
    sponsorSkips: 0,
    sponsorMillisSaved: 0
  };

  root.ASDefaults = {
    DEFAULTS: DEFAULTS,
    STATS: STATS,
    STORAGE_KEY: 'settings',
    STATS_KEY: 'stats',
    CACHE_INDEX_KEY: 'segCacheIndex',
    // Storage left behind by pre-0.4.0 builds that had the AI feature. Removed
    // on update so no API key outlives the feature that needed it.
    LEGACY_KEYS: ['secrets'],
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
