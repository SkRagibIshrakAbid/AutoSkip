/**
 * AutoSkip — skip toast with Undo (isolated world).
 *
 * Sponsor segments come from heuristics — community votes or an LLM — not from
 * YouTube's own data, so a wrong skip is possible in a way it is not for Jump
 * Ahead. Showing what was skipped and offering one-tap Undo is what makes
 * automatic skipping acceptable rather than alarming.
 */
(function () {
  'use strict';

  var D = globalThis.ASDefaults;
  var shared = globalThis.ASState;
  if (!D || !shared) return;
  if (globalThis.__autoskipToastLoaded) return;
  globalThis.__autoskipToastLoaded = true;

  var HIDE_AFTER_MS = 6000;
  var host = null;
  var hideTimer = 0;

  function toMain(type, data) {
    var msg = { dir: 'iso->main', type: type };
    msg[D.TAG] = true;
    if (data) for (var k in data) msg[k] = data[k];
    try { window.postMessage(msg, location.origin); } catch (e) { /* ignore */ }
  }

  function ensureHost() {
    if (host && document.body.contains(host)) return host;

    host = document.createElement('div');
    host.id = 'autoskip-toast';
    // A shadow root keeps YouTube's stylesheets from reaching in, and ours
    // from leaking out onto the page.
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '.wrap{position:fixed;left:20px;bottom:84px;z-index:2147483000;',
      '  display:flex;align-items:center;gap:12px;',
      '  padding:10px 14px;border-radius:10px;',
      '  background:rgba(20,20,20,.94);color:#f1f1f1;',
      '  font:500 13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
      '  box-shadow:0 4px 18px rgba(0,0,0,.45);',
      '  opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}',
      '.wrap.in{opacity:1;transform:none}',
      '.txt{white-space:nowrap}',
      '.tag{color:#9a9a9a;font-weight:400}',
      'button{all:unset;cursor:pointer;padding:4px 10px;border-radius:6px;',
      '  color:#3ea6ff;font-weight:600}',
      'button:hover{background:rgba(62,166,255,.12)}',
      'button:focus-visible{outline:2px solid #3ea6ff;outline-offset:1px}',
      '@media (prefers-reduced-motion:reduce){.wrap{transition:none}}'
    ].join('');
    root.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    root.appendChild(wrap);

    document.body.appendChild(host);
    return host;
  }

  function fmtSeconds(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function hide() {
    if (!host) return;
    var wrap = host.shadowRoot.querySelector('.wrap');
    if (wrap) wrap.classList.remove('in');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
    }, 220);
  }

  /** data: { videoId, rangeId, label, millisSaved, source } */
  function show(data) {
    if (!shared.settings.showToast) return;

    ensureHost();
    var wrap = host.shadowRoot.querySelector('.wrap');
    wrap.textContent = '';

    var txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = 'Skipped ' + fmtSeconds(data.millisSaved || 0);

    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = data.label || 'segment';
    txt.appendChild(document.createTextNode(' — '));
    txt.appendChild(tag);

    var undo = document.createElement('button');
    undo.textContent = 'Undo';
    undo.addEventListener('click', function () {
      toMain('undo-jump', { videoId: data.videoId, rangeId: data.rangeId });
      hide();
    });

    wrap.appendChild(txt);
    wrap.appendChild(undo);

    requestAnimationFrame(function () { wrap.classList.add('in'); });
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_AFTER_MS);
  }

  globalThis.ASToast = { show: show, hide: hide };
})();
