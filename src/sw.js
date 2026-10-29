/**
 * AutoSkip — service worker.
 *
 * Looks up sponsor segments on SponsorBlock and caches the results. Doing the
 * network call here rather than in the page keeps it off YouTube's origin and
 * lets one cache serve every tab.
 *
 *   content → getSegments(videoId) → { segments, meta }
 */
'use strict';

importScripts(
  'common/defaults.js',
  'core/segments.js',
  'providers/sponsorblock.js'
);

var D = globalThis.ASDefaults;
var SB = globalThis.ASSponsorBlock;

// Bumped in 0.4.0 so results from builds with the AI feature are never reused.
var CACHE_VERSION = 2;
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

// ─────────────────────────────────────────────────────────────── cache

function cacheKey(videoId, settings) {
  var tag = (settings.segCategories || []).slice().sort().join(',');
  return 'sc:' + CACHE_VERSION + ':' + videoId + ':' + tag;
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

async function clearCache() {
  var r = await get([D.CACHE_INDEX_KEY]);
  var index = Array.isArray(r[D.CACHE_INDEX_KEY]) ? r[D.CACHE_INDEX_KEY] : [];
  if (index.length) chrome.storage.local.remove(index);
  var payload = {};
  payload[D.CACHE_INDEX_KEY] = [];
  await set(payload);
  return { cleared: index.length };
}

// ────────────────────────────────────────────────────────── lookup

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

  var sb = await SB.fetchSegments(videoId, { categories: settings.segCategories });

  // A network failure is not "this video has no sponsors" — don't cache it,
  // or a flaky connection would hide real segments for a week.
  if (!sb.meta.error) await cachePut(key, { segments: sb.segments, meta: sb.meta });
  return { segments: sb.segments, meta: sb.meta };
}

// ────────────────────────────────────────────────────────────── router

var HANDLERS = {
  getSegments: getSegments,
  clearSegmentCache: clearCache
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
  chrome.storage.local.get([D.STORAGE_KEY, D.STATS_KEY], function (res) {
    var payload = {};
    payload[D.STORAGE_KEY] = D.withDefaults(res && res[D.STORAGE_KEY]);
    payload[D.STATS_KEY] = Object.assign({}, D.STATS, (res && res[D.STATS_KEY]) || {});
    chrome.storage.local.set(payload);
  });
  // Earlier builds stored an AI provider API key. Nothing reads it any more,
  // so don't leave a credential sitting in storage.
  chrome.storage.local.remove(D.LEGACY_KEYS);
}

chrome.runtime.onInstalled.addListener(function (details) {
  seed();
  if (details && details.reason === 'update') clearCache();
});
chrome.runtime.onStartup.addListener(seed);
