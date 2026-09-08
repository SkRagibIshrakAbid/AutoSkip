/**
 * AutoSkip — transcript acquisition (isolated world).
 *
 * Three paths, cheapest first. The naive one — fetching
 * captionTracks[].baseUrl — is deliberately absent: it now carries `exp=xpe`
 * and returns HTTP 200 with a ZERO-BYTE body even from inside the page with
 * the user's own session. Verified live. Forging /youtubei/v1/get_transcript
 * fails too (FAILED_PRECONDITION). The transcript has to come from YouTube's
 * own requests or its own DOM.
 */
(function () {
  'use strict';

  var D = globalThis.ASDefaults;
  var shared = globalThis.ASState;
  var T = globalThis.ASTranscript;
  if (!D || !shared || !T) return;
  if (globalThis.__autoskipTranscriptLoaded) return;
  globalThis.__autoskipTranscriptLoaded = true;

  function toMain(type, data) {
    var msg = { dir: 'iso->main', type: type };
    msg[D.TAG] = true;
    if (data) for (var k in data) msg[k] = data[k];
    try { window.postMessage(msg, location.origin); } catch (e) { /* ignore */ }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * Path 1 & 2: whatever the MAIN world already captured from YouTube's own
   * /api/timedtext or /youtubei/v1/get_transcript traffic. Free and exact.
   */
  function askMainForTranscript(videoId, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      function onMsg(ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d[D.TAG] !== true || d.dir !== 'main->iso') return;
        if (d.type !== 'transcript-response' || d.videoId !== videoId) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(Array.isArray(d.lines) ? d.lines : []);
      }
      window.addEventListener('message', onMsg);
      toMain('transcript-request', { videoId: videoId });
      setTimeout(function () {
        if (done) return;
        window.removeEventListener('message', onMsg);
        resolve([]);
      }, timeoutMs || 1500);
    });
  }

  function findButton(re) {
    var nodes = document.querySelectorAll('button, ytd-button-renderer, tp-yt-paper-button');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (re.test(label)) return el.tagName === 'BUTTON' ? el : (el.querySelector('button') || el);
    }
    return null;
  }

  function transcriptPanel() {
    var panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
    for (var i = 0; i < panels.length; i++) {
      if ((panels[i].getAttribute('target-id') || '').indexOf('transcript') !== -1) return panels[i];
    }
    return null;
  }

  function panelIsOpen() {
    var p = transcriptPanel();
    return !!p && (p.getAttribute('visibility') || '').indexOf('EXPANDED') !== -1;
  }

  /** Read the rendered panel. ~1s precision, which the engine tolerates. */
  function scrapePanel() {
    var rows = [];
    document.querySelectorAll('transcript-segment-view-model, ytd-transcript-segment-renderer')
      .forEach(function (seg) {
        var tsEl = seg.querySelector(
          '.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp, [class*="Timestamp"]');
        var textEl = seg.querySelector('[role="text"], .segment-text, yt-formatted-string');
        var ts = tsEl ? tsEl.textContent.trim() : '';
        var text = textEl ? textEl.textContent.trim() : '';
        if (!text && !ts) return;
        rows.push({ timestamp: ts, text: text });
      });
    return T.fromDomRows(rows);
  }

  /**
   * Path 3: open the panel, read it, put it back how we found it.
   * Also makes YouTube fire get_transcript, which the MAIN world captures with
   * exact millisecond timings — so we prefer that result when it arrives.
   */
  async function viaPanel(videoId) {
    var wasOpen = panelIsOpen();

    if (!wasOpen) {
      // The transcript button lives in the description, which is collapsed by
      // default on most layouts.
      var show = findButton(/show transcript|transcript/i);
      if (!show) {
        var expand = document.querySelector('#expand, tp-yt-paper-button#expand, #description-inline-expander #expand');
        if (expand) { expand.click(); await sleep(400); }
        show = findButton(/show transcript/i);
      }
      if (!show) return { lines: [], path: 'panel', error: 'no-transcript-button' };
      show.click();
    }

    // Wait for segments to render.
    for (var i = 0; i < 30; i++) {
      await sleep(200);
      if (document.querySelector('transcript-segment-view-model, ytd-transcript-segment-renderer')) break;
    }

    // Prefer the exact-millisecond capture the click just triggered.
    var exact = await askMainForTranscript(videoId, 800);
    var lines = exact.length ? exact : scrapePanel();
    var path = exact.length ? 'get_transcript (via panel)' : 'panel DOM scrape';

    if (!wasOpen) {
      var close = findButton(/close transcript/i);
      if (close) close.click();
    }

    return { lines: lines, path: path };
  }

  /** Full acquisition, cheapest path first. */
  async function acquire(videoId) {
    var captured = await askMainForTranscript(videoId, 1200);
    if (captured.length) {
      return { lines: captured, path: 'intercepted (timedtext/get_transcript)' };
    }
    return viaPanel(videoId);
  }

  globalThis.ASTranscriptSource = {
    acquire: acquire,
    scrapePanel: scrapePanel,
    panelIsOpen: panelIsOpen
  };
})();
