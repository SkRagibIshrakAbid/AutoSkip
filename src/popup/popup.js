'use strict';

var D = globalThis.ASDefaults;

var BOOLS = [
  'enabled', 'jumpAhead', 'adSkip', 'continueWatching', 'suggestedChips',
  'tier2Fallback', 'debug', 'captureMode', 'forceTier2'
];
var NUMS = ['maxJumpsPerVideo', 'cooldownMs'];

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
  $('blocklist').value = (settings.blocklist || []).join('\n');
  updateBlockButton();
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
  $('stat-dialogs').textContent = s.dialogsDismissed;

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
  });
});

NUMS.forEach(function (k) {
  $(k).addEventListener('change', function () {
    var n = parseInt($(k).value, 10);
    if (!Number.isFinite(n)) { $(k).value = settings[k]; return; }
    var patch = {};
    patch[k] = Math.max(0, n);
    save(patch);
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

chrome.storage.local.get([D.STORAGE_KEY, D.STATS_KEY], function (res) {
  settings = D.withDefaults(res && res[D.STORAGE_KEY]);
  render();
  renderStats(res && res[D.STATS_KEY]);
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
