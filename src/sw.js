/**
 * AutoSkip — service worker.
 *
 * Owns everything that must not touch the page: API keys, outbound network
 * calls to SponsorBlock and LLM providers, and the segment cache.
 *
 * Segment lookup is a two-step protocol, because the transcript can only be
 * obtained by the content script (from YouTube's DOM/network) while the API
 * key can only live here:
 *
 *   content → getSegments(videoId)      → { segments }            (cache/SponsorBlock hit)
 *                                       → { needTranscript:true } (nothing found yet)
 *   content → analyzeTranscript(lines)  → { segments }            (LLM result, validated)
 */
'use strict';

importScripts(
  'common/defaults.js',
  'core/segments.js',
  'core/transcript.js',
  'providers/sponsorblock.js',
  'providers/llm.js'
);

var D = globalThis.ASDefaults;
var S = globalThis.ASSegments;
var T = globalThis.ASTranscript;
var SB = globalThis.ASSponsorBlock;
var LLM = globalThis.ASLlm;

var CACHE_VERSION = 1;
var MAX_CACHE_ENTRIES = 500;
var TTL_HIT_MS = 30 * 24 * 3600 * 1000;   // a found segment set is stable
var TTL_MISS_MS = 7 * 24 * 3600 * 1000;   // recheck: SponsorBlock gains data over time

// ───────────────────────────────────────────────────────────── storage

function get(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, function (r) { resolve(r || {}); });
  });
}
function set(obj) {
  return new Promise(function (resolve) { chrome.storage.local.set(obj, resolve); });
}

async function loadSettings() {
  var r = await get([D.STORAGE_KEY]);
  return D.withDefaults(r[D.STORAGE_KEY]);
}
async function loadSecrets() {
  var r = await get([D.SECRETS_KEY]);
  return D.withSecretDefaults(r[D.SECRETS_KEY]);
}

async function bumpStats(delta) {
  var r = await get([D.STATS_KEY]);
  var stats = Object.assign({}, D.STATS, r[D.STATS_KEY] || {});
  for (var k in delta) stats[k] = (stats[k] || 0) + delta[k];
  var payload = {};
  payload[D.STATS_KEY] = stats;
  await set(payload);
}

// ─────────────────────────────────────────────────────────────── cache

function cacheKey(videoId, settings) {
  var tag = (settings.segCategories || []).slice().sort().join(',');
  var provider = settings.llmEnabled ? settings.llmProvider + ':' + (settings.llmModel || 'default') : 'sb';
  return 'sc:' + CACHE_VERSION + ':' + videoId + ':' + tag + ':' + provider;
}

async function cacheGet(key) {
  var r = await get([key]);
  var entry = r[key];
  if (!entry || typeof entry !== 'object') return null;
  var ttl = entry.segments && entry.segments.length ? TTL_HIT_MS : TTL_MISS_MS;
  if (Date.now() - (entry.ts || 0) > ttl) return null;
  return entry;
}

async function cachePut(key, entry) {
  var payload = {};
  payload[key] = Object.assign({ ts: Date.now() }, entry);
  await set(payload);

  // Bounded LRU so a long-lived profile can't grow without limit.
  var r = await get([D.CACHE_INDEX_KEY]);
  var index = Array.isArray(r[D.CACHE_INDEX_KEY]) ? r[D.CACHE_INDEX_KEY] : [];
  index = index.filter(function (k) { return k !== key; });
  index.push(key);
  var evicted = [];
  while (index.length > MAX_CACHE_ENTRIES) evicted.push(index.shift());
  if (evicted.length) chrome.storage.local.remove(evicted);
  var idxPayload = {};
  idxPayload[D.CACHE_INDEX_KEY] = index;
  await set(idxPayload);
}

// ────────────────────────────────────────────────────────── orchestration

async function getSegments(msg) {
  var settings = await loadSettings();
  if (!settings.enabled || !settings.sponsorSkip) {
    return { segments: [], meta: { skipped: 'feature-off' } };
  }

  var videoId = msg.videoId;
  if (!videoId) return { segments: [], meta: { skipped: 'no-video-id' } };

  var key = cacheKey(videoId, settings);
  var cached = await cacheGet(key);
  if (cached) {
    return { segments: cached.segments, meta: Object.assign({ cached: true }, cached.meta) };
  }

  // Tier 1: SponsorBlock — free, instant, community-verified.
  if (settings.sbEnabled) {
    var sb = await SB.fetchSegments(videoId, {
      categories: settings.segCategories,
      apiBase: settings.sbApiBase || undefined
    });
    if (sb.segments.length) {
      await cachePut(key, { segments: sb.segments, meta: sb.meta });
      return { segments: sb.segments, meta: sb.meta };
    }
    var sbMeta = sb.meta;
  }

  // Tier 2: hand back to the content script for a transcript.
  if (settings.llmEnabled) {
    var durationOk = !msg.durationSeconds || msg.durationSeconds >= settings.minVideoSeconds;
    if (!durationOk) {
      await cachePut(key, { segments: [], meta: { skipped: 'video-too-short' } });
      return { segments: [], meta: { skipped: 'video-too-short' } };
    }
    return { segments: [], needTranscript: true, meta: sbMeta || { source: 'sponsorblock' } };
  }

  await cachePut(key, { segments: [], meta: sbMeta || { source: 'sponsorblock' } });
  return { segments: [], meta: sbMeta || { source: 'sponsorblock' } };
}

async function analyzeTranscript(msg) {
  var settings = await loadSettings();
  if (!settings.enabled || !settings.sponsorSkip || !settings.llmEnabled) {
    return { segments: [], meta: { skipped: 'llm-off' } };
  }

  var lines = Array.isArray(msg.lines) ? msg.lines : [];
  if (!lines.length) return { segments: [], meta: { error: 'empty-transcript' } };

  var secrets = await loadSecrets();
  var providerMeta = LLM.PROVIDERS[settings.llmProvider] || LLM.PROVIDERS.ollama;
  var cfg = {
    provider: settings.llmProvider,
    baseUrl: settings.llmBaseUrl || providerMeta.defaultBaseUrl,
    model: settings.llmModel || providerMeta.defaultModel,
    apiKey: secrets.llmApiKey,
    timeoutMs: settings.llmTimeoutMs
  };

  var opts = {
    categories: settings.segCategories,
    minConfidence: settings.minConfidence,
    videoDurationMs: msg.durationSeconds ? msg.durationSeconds * 1000 : T.totalDurationMs(lines)
  };

  var chunks = T.chunk(lines, {});
  var all = [];
  var rejected = [];
  var usage = [];

  try {
    for (var i = 0; i < chunks.length; i++) {
      var promptLines = T.toPromptLines(lines, chunks[i].fromIndex, chunks[i].toIndex);
      var res = await LLM.analyze(cfg, promptLines);
      var parsed = S.fromLlm(res.text, lines, opts);
      all = all.concat(parsed.segments);
      rejected = rejected.concat(parsed.rejected);
      if (res.usage) usage.push(res.usage);
    }
  } catch (e) {
    return { segments: [], meta: { error: String(e && e.message || e), provider: cfg.provider } };
  }

  var segments = S.clampToDuration(S.mergeOverlapping(all), opts.videoDurationMs);

  var meta = {
    source: 'llm',
    provider: cfg.provider,
    model: cfg.model,
    chunks: chunks.length,
    lineCount: lines.length,
    rejected: rejected,
    usage: usage
  };

  await cachePut(cacheKey(msg.videoId, settings), { segments: segments, meta: meta });
  await bumpStats({ llmCalls: chunks.length });
  return { segments: segments, meta: meta };
}

async function clearCache() {
  var r = await get([D.CACHE_INDEX_KEY]);
  var index = Array.isArray(r[D.CACHE_INDEX_KEY]) ? r[D.CACHE_INDEX_KEY] : [];
  if (index.length) chrome.storage.local.remove(index);
  var payload = {};
  payload[D.CACHE_INDEX_KEY] = [];
  await set(payload);
  return { cleared: index.length };
}

/** Popup "Test connection" — proves the key/URL work without touching a video. */
async function testProvider() {
  var settings = await loadSettings();
  var secrets = await loadSecrets();
  var providerMeta = LLM.PROVIDERS[settings.llmProvider] || LLM.PROVIDERS.ollama;
  var cfg = {
    provider: settings.llmProvider,
    baseUrl: settings.llmBaseUrl || providerMeta.defaultBaseUrl,
    model: settings.llmModel || providerMeta.defaultModel,
    apiKey: secrets.llmApiKey,
    timeoutMs: 30000
  };
  try {
    var res = await LLM.analyze(cfg, '[0] this video is sponsored by ExampleCorp\n[1] back to the video');
    var parsed = S.parseJsonLoose(res.text);
    return { ok: true, model: cfg.model, provider: cfg.provider, gotJson: !!parsed,
      sample: String(res.text || '').slice(0, 200) };
  } catch (e) {
    return { ok: false, provider: cfg.provider, error: String(e && e.message || e) };
  }
}

// ────────────────────────────────────────────────────────────── router

var HANDLERS = {
  getSegments: getSegments,
  analyzeTranscript: analyzeTranscript,
  clearSegmentCache: clearCache,
  testProvider: testProvider
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  handler(msg)
    .then(function (r) { sendResponse(r); })
    .catch(function (e) { sendResponse({ segments: [], meta: { error: String(e && e.message || e) } }); });
  return true; // async
});

// ───────────────────────────────────────────────────────────── install

function seed() {
  chrome.storage.local.get([D.STORAGE_KEY, D.STATS_KEY, D.SECRETS_KEY], function (res) {
    var payload = {};
    payload[D.STORAGE_KEY] = D.withDefaults(res && res[D.STORAGE_KEY]);
    payload[D.STATS_KEY] = Object.assign({}, D.STATS, (res && res[D.STATS_KEY]) || {});
    payload[D.SECRETS_KEY] = D.withSecretDefaults(res && res[D.SECRETS_KEY]);
    chrome.storage.local.set(payload);
  });
}

chrome.runtime.onInstalled.addListener(seed);
chrome.runtime.onStartup.addListener(seed);
