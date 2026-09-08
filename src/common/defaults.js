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

    // ── sponsor-segment skipping (non-Premium ad reads) ──────────────────
    sponsorSkip: false,          // master switch; ships OFF
    sbEnabled: true,             // SponsorBlock: free, instant, no transcript
    llmEnabled: false,           // LLM fallback when SponsorBlock has nothing
    llmProvider: 'ollama',
    llmBaseUrl: '',              // blank = the provider's default
    llmModel: '',                // blank = the provider's default
    llmTimeoutMs: 90000,
    segCategories: ['sponsor', 'selfpromo'],
    minConfidence: 0.7,
    minVideoSeconds: 180,        // below this, ad reads are rare; do not spend tokens
    showToast: true
  };

  /**
   * Secrets live under their own storage key, NEVER in `settings`.
   *
   * `settings` is pushed wholesale into the MAIN world, which shares scope with
   * YouTube's own scripts. Keeping the API key in a separate key that only the
   * service worker and popup ever read makes leaking it structurally
   * impossible rather than a filtering mistake waiting to happen.
   */
  var SECRETS = {
    llmApiKey: ''
  };

  var STATS = {
    jumps: 0,
    millisSaved: 0,
    adsSkipped: 0,
    dialogsDismissed: 0,
    chipsClicked: 0,
    sponsorSkips: 0,
    sponsorMillisSaved: 0,
    llmCalls: 0
  };

  root.ASDefaults = {
    DEFAULTS: DEFAULTS,
    STATS: STATS,
    STORAGE_KEY: 'settings',
    STATS_KEY: 'stats',
    SECRETS_KEY: 'secrets',
    CACHE_INDEX_KEY: 'segCacheIndex',
    SECRETS: SECRETS,
    TAG: '__autoskip',
    LOG_PREFIX: '[autoskip]',

    withSecretDefaults: function (stored) {
      var out = {};
      for (var k in SECRETS) {
        if (!Object.prototype.hasOwnProperty.call(SECRETS, k)) continue;
        out[k] = stored && Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : SECRETS[k];
      }
      return out;
    },

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
