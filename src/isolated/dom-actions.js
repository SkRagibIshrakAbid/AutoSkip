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

  // Last-resort selectors for the Jump ahead chip. The reliable match is the
  // server-supplied localized title from tier 1; these only cover the case
  // where tier 1 produced nothing at all.
  var JUMP_CHIP = [
    '.ytp-jump-ahead-button',
    '.ytp-jump-ahead',
    '#movie_player [class*="jump-ahead"]',
    '#movie_player [class*="smart-skip"]'
  ];

  // Intentionally narrow: a suggested-action badge can also be a shopping link.
  var SKIPPY = /\b(skip|jump|ahead|intro|recap|passer|saltar|überspringen|sauter|пропустить|スキップ|건너뛰기)\b/i;

  var lastUserInputAt = 0;
  var lastAction = Object.create(null);
  var clicked = new WeakSet();
  var nudges = 0;
  var lastNudgeAt = 0;

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
   * 'active'  - tier 1 never reported on this video, so it may be broken.
   *             Worth nudging the controls visible to find the chip.
   * 'passive' - tier 1 works and says this video has no jump-ahead data.
   *             Click the chip if it shows up, but never synthesize input.
   */
  function tier2Mode() {
    if (shared.settings.forceTier2) return 'active';
    if (!shared.settings.jumpAhead || !shared.settings.enabled) return 'off';
    if (!shared.settings.tier2Fallback) return 'off';
    var vid = currentVideoId();
    if (!vid) return 'off';
    var reported = shared.reported[vid];
    if (reported) return reported.hasMarkers ? 'off' : 'passive';
    return 'active';
  }

  function findJumpChip() {
    var player = document.getElementById('movie_player');
    if (!player) return null;

    // Best match: the server's own localized label, captured by tier 1.
    var reported = shared.reported[currentVideoId()];
    var titles = ((reported && reported.titles) || []).filter(Boolean);
    if (titles.length) {
      var candidates = player.querySelectorAll('button, [role="button"], .ytp-button');
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!visible(el) || clicked.has(el)) continue;
        var label = textOf(el);
        if (!label) continue;
        for (var j = 0; j < titles.length; j++) {
          if (label.toLowerCase().indexOf(titles[j].toLowerCase()) !== -1) return el;
        }
      }
    }

    return firstVisible(JUMP_CHIP, player);
  }

  function doJumpChip() {
    var mode = tier2Mode();
    if (mode === 'off') return;
    if (shared.blocked) return;

    var chip = findJumpChip();
    if (chip) {
      if (!cooled('jumpchip', shared.settings.cooldownMs || 1500)) return;
      if (click(chip, 'tier-2 jump chip')) {
        nudges = 0;
        shared.bump({ jumps: 1 });
      }
      return;
    }

    if (mode !== 'active') return;

    // The chip only renders while the controls are visible, so make them
    // visible. Capped so a video that simply has no jump-ahead doesn't end up
    // with its controls pinned open forever.
    var video = getVideo();
    if (!video || video.paused) return;
    if (nudges >= 24) return;
    if (Date.now() - lastNudgeAt < 5000) return;
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
    shared.log('tier-2 nudge', nudges, '- revealing controls to look for the chip');
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
