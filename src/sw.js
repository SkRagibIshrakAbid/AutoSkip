/**
 * AutoSkip — service worker.
 * Seeds defaults on install and fills in any setting added by a later version.
 */
'use strict';

importScripts('common/defaults.js');

var D = globalThis.ASDefaults;

function seed() {
  chrome.storage.local.get([D.STORAGE_KEY, D.STATS_KEY], function (res) {
    var payload = {};
    payload[D.STORAGE_KEY] = D.withDefaults(res && res[D.STORAGE_KEY]);
    payload[D.STATS_KEY] = Object.assign({}, D.STATS, (res && res[D.STATS_KEY]) || {});
    chrome.storage.local.set(payload);
  });
}

chrome.runtime.onInstalled.addListener(seed);
chrome.runtime.onStartup.addListener(seed);
