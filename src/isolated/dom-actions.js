/**
 * AutoSkip — isolated-world DOM actions.
 *
 * Everything here is a fallback or a side feature; the primary jump-ahead path
 * is tier 1 in the MAIN world. Clicking is deliberately conservative: each
 * action has a guard that makes a wrong click unlikely, because the elements
 * involved (confirm dialogs, suggested-action badges) are shared by YouTube
 * with things we must never click, like "delete comment" or a shopping link.
 */
(function () {
  'use strict';

  var D = globalThis.ASDefaults;
  var shared = globalThis.ASState;
  if (!D || !shared) return;
  if (globalThis.__autoskipDomLoaded) return;
  globalThis.__autoskipDomLoaded = true;

  var AD_SKIP = [
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button'
  ];

  // Unverified against a live dialog — refine with capture mode if it misses.
  var CONFIRM = [
    'yt-confirm-dialog-renderer #confirm-button button',
    'yt-confirm-dialog-renderer #confirm-button',
    'tp-yt-paper-dialog #confirm-button button',
    'ytd-popup-container tp-yt-paper-dialog #confirm-button'
  ];

  // `.ytp-jump-ahead-button` is the real one, confirmed against a working
  // third-party implementation.
  var JUMP_CHIP = [
    '.ytp-jump-ahead-button',
    '.ytp-jump-ahead',
    '#movie_player [class*="jump-ahead"]',
    '#movie_player [class*="smart-skip"]'
  ];

  var JUMP_LABEL = /\b(jump ahead|skip ahead)\b/i;

  function hasJumpLikeClass(el) {
    var cls = (el.className || '').toString();
    return /ytp-(?:jump-ahead|smart-skip)/i.test(cls);
  }

  function controlText(el) {
    return [
      el.innerText || '',
      el.textContent || '',
      (el.getAttribute && el.getAttribute('aria-label')) || '',
      (el.getAttribute && el.getAttribute('title')) || '',
      (el.getAttribute && el.getAttribute('data-title-no-tooltip')) || ''
    ].join(' ').replace(/\s+/g, ' ').trim();
  }

  function hasLayout(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function toMain(type, data) {
    var msg = { dir: 'iso->main', type: type };
    msg[D.TAG] = true;
    if (data) for (var k in data) msg[k] = data[k];
    try { window.postMessage(msg, location.origin); } catch (e) { /* ignore */ }
  }

  // Intentionally narrow: a suggested-action badge can also be a shopping link.
  var SKIPPY = /\b(skip|jump|ahead|intro|recap|passer|saltar|überspringen|sauter|пропустить|スキップ|건너뛰기)\b/i;

  var lastUserInputAt = 0;
  var lastAction = Object.create(null);
  var clicked = new WeakSet();
  var nudges = 0;
  var lastNudgeAt = 0;
  var lastSighting = null;

  ['pointerdown', 'keydown', 'wheel'].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      if (e && e.isTrusted) lastUserInputAt = Date.now();
    }, { capture: true, passive: true });
  });

  function cooled(key, ms) {
    var now = Date.now();
    if (now - (lastAction[key] || 0) < ms) return false;
    lastAction[key] = now;
    return true;
  }

  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function firstVisible(selectors, root) {
    var scope = root || document;
    for (var i = 0; i < selectors.length; i++) {
      var els = scope.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        if (visible(els[j]) && !clicked.has(els[j])) return els[j];
      }
    }
    return null;
  }

  function click(el, why) {
    if (!el) return false;
    clicked.add(el);
    try {
      el.click();
    } catch (e) {
      shared.log('click failed (' + why + ')', e);
      return false;
    }
    shared.log('clicked', why, describe(el));
    return true;
  }

  function textOf(el) {
    return ((el.getAttribute && el.getAttribute('aria-label')) || el.innerText || el.textContent || '')
      .trim();
  }

  function currentVideoId() {
    try {
      if (location.pathname !== '/watch') return null;
      return new URLSearchParams(location.search).get('v');
    } catch (e) { return null; }
  }

  function getVideo() {
    return document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('video.html5-main-video');
  }

  // ------------------------------------------------------------------- ad skip

  function doAdSkip() {
    if (!shared.settings.adSkip) return;
    var player = document.getElementById('movie_player');
    if (!player || !player.classList.contains('ad-showing')) return;
    if (!cooled('ad', 700)) return;
    var btn = firstVisible(AD_SKIP);
    if (btn && click(btn, 'ad-skip')) shared.bump({ adsSkipped: 1 });
  }

  // -------------------------------------------------- "Continue watching?" dialog

  /**
   * yt-confirm-dialog-renderer is also used for destructive confirms (deleting
   * a comment, clearing history). The idle prompt only ever appears after a
   * long stretch of no interaction, so requiring a quiet period makes it
   * impossible to auto-confirm a dialog the user just opened themselves.
   */
  function doContinueWatching() {
    if (!shared.settings.continueWatching) return;
    if (!currentVideoId()) return;

    var quietFor = Date.now() - lastUserInputAt;
    if (lastUserInputAt !== 0 && quietFor < 60000) return;

    var video = getVideo();
    if (!video || !video.paused) return;
    if (!cooled('confirm', 3000)) return;

    var btn = firstVisible(CONFIRM);
    if (!btn) return;
    if (click(btn, 'continue-watching')) {
      shared.bump({ dialogsDismissed: 1 });
      // The dialog leaves playback paused on some layouts.
      setTimeout(function () {
        var v = getVideo();
        if (v && v.paused) { try { v.play(); } catch (e) { /* autoplay policy */ } }
      }, 300);
    }
  }

  // ------------------------------------------------- suggested action / skip chips

  function doSuggestedChips() {
    if (!shared.settings.suggestedChips) return;
    if (!cooled('chip', 1500)) return;

    var badges = document.querySelectorAll('.ytp-suggested-action-badge');
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      if (!visible(b) || clicked.has(b)) continue;
      // Never auto-click a shopping badge. Observed live: a badge can carry
      // `ytp-featured-product` on itself without containing any product
      // imagery, so both the class and the inner imagery have to be checked.
      if (b.classList.contains('ytp-featured-product')) continue;
      if (b.querySelector('.ytp-suggested-action-badge-img, .ytp-suggested-action-product-thumbnail')) continue;
      var label = textOf(b);
      if (!label || !SKIPPY.test(label)) continue;
      if (click(b, 'suggested-chip: ' + label)) {
        shared.bump({ chipsClicked: 1 });
        return;
      }
    }
  }

  // --------------------------------------------------------- tier 2: jump chip

  /**
   * 'active'  - no usable data from the seek path for this video, so the chip
   *             is the only route. Worth revealing the controls to use it.
   * 'passive' - the seek path has ranges and will handle this video; only
   *             click a chip that happens to be sitting there already.
   *
   * Earlier this returned 'passive' whenever the seek path had reported
   * "no data for this video" — which is precisely the case where the chip is
   * the ONLY thing that can work. Combined with passive mode refusing to
   * reveal the controls the chip needs, that made the fallback unreachable.
   */
  function tier2Mode() {
    if (shared.settings.forceTier2) return 'active';
    if (!shared.settings.jumpAhead || !shared.settings.enabled) return 'off';
    if (!shared.settings.tier2Fallback) return 'off';
    var vid = currentVideoId();
    if (!vid) return 'off';
    var reported = shared.reported[vid];
    if (reported && reported.hasMarkers) return 'passive';
    return 'active';
  }

  /**
   * CRITICAL: this must not require layout.
   *
   * YouTube keeps the Jump Ahead chip in the DOM at 0x0 while the player
   * controls are hidden. Filtering on getBoundingClientRect() — which every
   * other action here does, correctly — throws away the exact element we are
   * looking for. That single mistake is enough to make the whole feature look
   * completely dead.
   */
  function findJumpChip() {
    var player = document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player');
    if (!player) return null;

    // Known selectors, no layout check.
    for (var i = 0; i < JUMP_CHIP.length; i++) {
      var hit = player.querySelector(JUMP_CHIP[i]) || document.querySelector(JUMP_CHIP[i]);
      if (hit) return hit;
    }

    // Otherwise scan the player's controls by class or label. Tier 1 gives us
    // the server's own localized title, so this works in any language.
    var reported = shared.reported[currentVideoId()];
    var titles = ((reported && reported.titles) || []).filter(Boolean);
    var candidates = player.querySelectorAll('button, [role="button"], .ytp-button');
    for (var j = 0; j < candidates.length; j++) {
      var el = candidates[j];
      if (hasJumpLikeClass(el)) return el;
      var label = controlText(el);
      if (!label) continue;
      if (JUMP_LABEL.test(label)) return el;
      for (var k = 0; k < titles.length; k++) {
        if (titles[k] && label.toLowerCase().indexOf(titles[k].toLowerCase()) !== -1) return el;
      }
    }
    return null;
  }

  function doJumpChip() {
    var mode = tier2Mode();
    if (mode === 'off' || shared.blocked) return;

    var chip = findJumpChip();

    if (chip) {
      // A sighting proves YouTube has jump data for this video right now.
      // Tell the engine: if it extracted nothing, its parsing needs attention.
      var key = currentVideoId() + '|' + (chip.className || '').toString();
      if (key !== lastSighting) {
        lastSighting = key;
        toMain('chip-sighting', { videoId: currentVideoId() });
        shared.log('jump chip sighted', describe(chip));
      }

      if (mode === 'passive') return;   // the seek path owns this video

      // Clicking a 0x0 hidden overlay silently does nothing, so reveal the
      // controls first and click on a following scan once it has layout.
      if (!hasLayout(chip)) {
        revealControls('chip present but 0x0 — revealing controls to click it');
        return;
      }

      if (!cooled('jumpchip', shared.settings.cooldownMs || 1500)) return;
      if (click(chip, 'jump chip')) {
        nudges = 0;
        shared.bump({ jumps: 1 });
      }
      return;
    }

    if (mode !== 'active') return;

    // No chip in the DOM at all. It may only be built once the controls show,
    // so nudge them visible — capped, so a video that simply has no Jump Ahead
    // never ends up with its controls pinned open.
    if (nudges >= 24) return;
    revealControls('no chip yet — nudge ' + (nudges + 1));
  }

  function revealControls(why) {
    var video = getVideo();
    if (!video || video.paused) return;
    if (Date.now() - lastNudgeAt < 2000) return;
    lastNudgeAt = Date.now();
    nudges++;

    var player = document.getElementById('movie_player');
    if (!player) return;
    var r = player.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.bottom - 40;
    ['mousemove', 'mouseover'].forEach(function (type) {
      player.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
      }));
    });
    shared.log('reveal controls:', why);
  }

  // ------------------------------------------------------------- capture mode

  function describe(el) {
    if (!el) return null;
    var chain = [];
    var node = el;
    for (var i = 0; node && i < 6; i++) {
      var part = node.tagName ? node.tagName.toLowerCase() : '?';
      if (node.id) part += '#' + node.id;
      if (node.classList && node.classList.length) {
        part += '.' + Array.prototype.slice.call(node.classList).join('.');
      }
      chain.unshift(part);
      node = node.parentElement;
    }
    return {
      selectorChain: chain.join(' > '),
      tag: el.tagName,
      id: el.id || null,
      classes: el.className && el.className.toString ? el.className.toString() : null,
      ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
      title: el.getAttribute ? el.getAttribute('title') : null,
      text: (el.innerText || '').trim().slice(0, 80)
    };
  }

  document.addEventListener('click', function (e) {
    if (!shared.settings.captureMode || !e.isTrusted) return;
    var el = e.target;
    var inPlayer = el.closest && el.closest('#movie_player');
    var inDialog = el.closest && el.closest('tp-yt-paper-dialog, yt-confirm-dialog-renderer, ytd-popup-container');
    if (!inPlayer && !inDialog) return;
    console.log(D.LOG_PREFIX + ' [capture] you clicked:', describe(el));
    var chainUp = [];
    var n = el;
    for (var i = 0; n && i < 4; i++) { chainUp.push(describe(n)); n = n.parentElement; }
    console.log(D.LOG_PREFIX + ' [capture] ancestors:', chainUp);
  }, true);

  // -------------------------------------------------------------- scan driver

  var scheduled = false;

  function scan() {
    scheduled = false;
    if (!shared.settings.enabled) return;
    try {
      doAdSkip();
      doContinueWatching();
      doSuggestedChips();
      doJumpChip();
    } catch (e) {
      console.warn(D.LOG_PREFIX + ' scan error', e);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 120);
  }

  function startObserver() {
    if (!document.body) return setTimeout(startObserver, 50);
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden']
    });
    schedule();
  }
  startObserver();

  // Backstop for anything the observer misses (canvas-driven UI, throttling).
  setInterval(schedule, 1000);

  ['yt-navigate-finish', 'yt-page-data-updated'].forEach(function (evt) {
    window.addEventListener(evt, function () {
      nudges = 0;
      schedule();
    });
  });

  shared.log('dom actions ready');
})();
