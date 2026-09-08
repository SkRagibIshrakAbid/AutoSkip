'use strict';

var D = globalThis.ASDefaults;

var BOOLS = [
  'enabled', 'jumpAhead', 'adSkip', 'continueWatching', 'suggestedChips',
  'tier2Fallback', 'debug', 'captureMode', 'forceTier2',
  'sponsorSkip', 'sbEnabled', 'llmEnabled', 'showToast'
];
var NUMS = ['maxJumpsPerVideo', 'cooldownMs', 'minConfidence', 'minVideoSeconds'];
var TEXTS = ['llmBaseUrl', 'llmModel'];
var SELECTS = ['llmProvider'];

// Provider hints shown in the popup. Kept in sync with providers/llm.js.
var PROVIDER_INFO = {
  ollama: { needsKey: false, base: 'http://localhost:11434', model: 'llama3.1',
    privacy: 'Runs on your machine. The transcript never leaves this computer.' },
  openai: { needsKey: true, base: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    privacy: 'Video transcripts will be sent to this endpoint.' },
  anthropic: { needsKey: true, base: 'https://api.anthropic.com', model: 'claude-sonnet-5',
    privacy: 'Video transcripts will be sent to Anthropic.' },
  gemini: { needsKey: true, base: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash',
    privacy: 'Video transcripts will be sent to Google.' }
};

var settings = D.withDefaults(null);
var currentVideoId = null;
var hintTimer = 0;

function $(id) { return document.getElementById(id); }

function hint(text) {
  $('saved-hint').textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(function () { $('saved-hint').textContent = ''; }, 1400);
}

function render() {
  BOOLS.forEach(function (k) { $(k).checked = !!settings[k]; });
  NUMS.forEach(function (k) { $(k).value = settings[k]; });
  TEXTS.concat(SELECTS).forEach(function (k) { $(k).value = settings[k] || ''; });
  $('blocklist').value = (settings.blocklist || []).join('\n');

  var cats = settings.segCategories || [];
  document.querySelectorAll('[data-cat]').forEach(function (el) {
    el.checked = cats.indexOf(el.getAttribute('data-cat')) !== -1;
  });

  updateBlockButton();
  updateSponsorUi();
}

function updateSponsorUi() {
  $('sponsor-body').hidden = !settings.sponsorSkip;
  $('llm-body').hidden = !settings.llmEnabled;

  var info = PROVIDER_INFO[settings.llmProvider] || PROVIDER_INFO.ollama;
  $('llmBaseUrl').placeholder = info.base;
  $('llmModel').placeholder = info.model;
  $('key-row').hidden = !info.needsKey;
  $('ollama-note').hidden = settings.llmProvider !== 'ollama';
  $('privacy-note').textContent = info.privacy;
}

function save(patch) {
  Object.assign(settings, patch);
  var payload = {};
  payload[D.STORAGE_KEY] = settings;
  chrome.storage.local.set(payload, function () { hint('Saved'); });
  updateBlockButton();
}

function renderStats(stats) {
  var s = Object.assign({}, D.STATS, stats || {});
  $('stat-jumps').textContent = s.jumps;
  $('stat-ads').textContent = s.adsSkipped;
  $('stat-sponsor').textContent = s.sponsorSkips || 0;

  var mins = Math.round((s.millisSaved || 0) / 60000);
  $('stat-saved').textContent = mins >= 60
    ? (mins / 60).toFixed(1) + 'h'
    : mins + 'm';
}

function updateBlockButton() {
  var btn = $('block-video');
  if (!currentVideoId) {
    btn.disabled = true;
    btn.textContent = 'Never auto-skip this video';
    return;
  }
  var listed = (settings.blocklist || []).some(function (e) {
    return String(e).trim().toLowerCase() === currentVideoId.toLowerCase();
  });
  btn.disabled = false;
  btn.textContent = listed ? 'Allow auto-skip on this video' : 'Never auto-skip this video';
}

// ------------------------------------------------------------------- wiring

BOOLS.forEach(function (k) {
  $(k).addEventListener('change', function () {
    var patch = {};
    patch[k] = $(k).checked;
    save(patch);
    if (k === 'sponsorSkip' || k === 'llmEnabled') updateSponsorUi();
  });
});

NUMS.forEach(function (k) {
  $(k).addEventListener('change', function () {
    var n = k === 'minConfidence' ? parseFloat($(k).value) : parseInt($(k).value, 10);
    if (!Number.isFinite(n)) { $(k).value = settings[k]; return; }
    var patch = {};
    patch[k] = k === 'minConfidence' ? Math.min(1, Math.max(0, n)) : Math.max(0, n);
    save(patch);
  });
});

TEXTS.forEach(function (k) {
  $(k).addEventListener('change', function () {
    var patch = {};
    patch[k] = $(k).value.trim();
    save(patch);
  });
});

SELECTS.forEach(function (k) {
  $(k).addEventListener('change', function () {
    var patch = {};
    patch[k] = $(k).value;
    save(patch);
    updateSponsorUi();
  });
});

document.querySelectorAll('[data-cat]').forEach(function (el) {
  el.addEventListener('change', function () {
    var cats = [];
    document.querySelectorAll('[data-cat]').forEach(function (e) {
      if (e.checked) cats.push(e.getAttribute('data-cat'));
    });
    save({ segCategories: cats });
  });
});

/**
 * The API key is written to its OWN storage key, never into `settings` —
 * `settings` is broadcast into the page's JS world, which YouTube's own
 * scripts share.
 */
$('llmApiKey').addEventListener('change', function () {
  var payload = {};
  payload[D.SECRETS_KEY] = { llmApiKey: $('llmApiKey').value };
  chrome.storage.local.set(payload, function () { hint('Key saved'); });
});

$('test-provider').addEventListener('click', function () {
  var out = $('test-result');
  out.className = '';
  out.textContent = 'Testing...';
  chrome.runtime.sendMessage({ type: 'testProvider' }, function (r) {
    if (!r) { out.className = 'bad'; out.textContent = 'No response from the extension worker.'; return; }
    if (r.ok) {
      out.className = 'ok';
      out.textContent = 'Works — ' + r.model + (r.gotJson ? ' returned valid JSON.' : ' replied, but not JSON.');
    } else {
      out.className = 'bad';
      out.textContent = r.error;
    }
  });
});

$('clear-cache').addEventListener('click', function () {
  chrome.runtime.sendMessage({ type: 'clearSegmentCache' }, function (r) {
    hint(r ? 'Cleared ' + r.cleared : 'Cleared');
  });
});

$('blocklist').addEventListener('change', function () {
  save({
    blocklist: $('blocklist').value.split('\n')
      .map(function (s) { return s.trim(); })
      .filter(Boolean)
  });
});

$('block-video').addEventListener('click', function () {
  if (!currentVideoId) return;
  var list = (settings.blocklist || []).slice();
  var idx = list.findIndex(function (e) {
    return String(e).trim().toLowerCase() === currentVideoId.toLowerCase();
  });
  if (idx === -1) list.push(currentVideoId); else list.splice(idx, 1);
  save({ blocklist: list });
  $('blocklist').value = list.join('\n');
});

$('reset-stats').addEventListener('click', function () {
  var payload = {};
  payload[D.STATS_KEY] = Object.assign({}, D.STATS);
  chrome.storage.local.set(payload, function () {
    renderStats(D.STATS);
    hint('Stats reset');
  });
});

// ---------------------------------------------------------------- bootstrap

chrome.storage.local.get([D.STORAGE_KEY, D.STATS_KEY, D.SECRETS_KEY], function (res) {
  settings = D.withDefaults(res && res[D.STORAGE_KEY]);
  render();
  renderStats(res && res[D.STATS_KEY]);
  var secrets = D.withSecretDefaults(res && res[D.SECRETS_KEY]);
  $('llmApiKey').value = secrets.llmApiKey || '';
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes[D.STATS_KEY]) renderStats(changes[D.STATS_KEY].newValue);
});

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  var url = tabs && tabs[0] && tabs[0].url;
  var el = $('current');
  if (!url || !/^https?:\/\/(www|m)\.youtube\.com\//.test(url)) {
    el.textContent = 'Not a YouTube tab.';
    return;
  }
  try {
    var u = new URL(url);
    currentVideoId = u.pathname === '/watch' ? u.searchParams.get('v') : null;
  } catch (e) { currentVideoId = null; }

  el.textContent = currentVideoId
    ? 'Watching ' + currentVideoId
    : 'YouTube — not on a watch page.';
  updateBlockButton();
});
