/**
 * AutoSkip — SponsorBlock provider. Runs in the service worker.
 *
 * Uses the privacy-preserving hash-prefix endpoint exclusively. We send only
 * the first 4 hex characters of sha256(videoId); the server returns every
 * video in that bucket and we filter locally. Measured live: a 4-char prefix
 * returned 57 videos, so the server cannot tell which one is being watched.
 * Never call /api/skipSegments?videoID= — that leaks the exact video.
 */
(function (root) {
  'use strict';

  var DEFAULT_BASE = 'https://sponsor.ajay.app';
  var HASH_LENGTH = 4;

  async function sha256Hex(text) {
    var buf = new TextEncoder().encode(text);
    var digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  /**
   * Returns { segments, meta }. `segments` is [] both when the video genuinely
   * has none and when the bucket 404s — SponsorBlock returns 404 for an empty
   * bucket, which is not an error condition.
   */
  async function fetchSegments(videoId, options) {
    options = options || {};
    var base = options.apiBase || DEFAULT_BASE;
    var categories = options.categories || ['sponsor', 'selfpromo'];
    var S = root.ASSegments;

    var hex = await sha256Hex(videoId);
    var prefix = hex.slice(0, HASH_LENGTH);

    var qs = categories.map(function (c) {
      return 'category=' + encodeURIComponent(c);
    }).join('&');
    var url = base + '/api/skipSegments/' + prefix + '?' + qs;

    var res;
    try {
      res = await fetch(url, { method: 'GET', credentials: 'omit' });
    } catch (e) {
      return { segments: [], meta: { source: 'sponsorblock', error: 'network: ' + e.message } };
    }

    if (res.status === 404) {
      return { segments: [], meta: { source: 'sponsorblock', prefix: prefix, bucketSize: 0, found: false } };
    }
    if (!res.ok) {
      return { segments: [], meta: { source: 'sponsorblock', error: 'http ' + res.status } };
    }

    var bucket;
    try { bucket = await res.json(); } catch (e) {
      return { segments: [], meta: { source: 'sponsorblock', error: 'bad json' } };
    }

    var segments = S.fromSponsorBlock(bucket, videoId, { categories: categories });
    return {
      segments: segments,
      meta: {
        source: 'sponsorblock',
        prefix: prefix,
        bucketSize: Array.isArray(bucket) ? bucket.length : 0,
        found: segments.length > 0
      }
    };
  }

  root.ASSponsorBlock = {
    DEFAULT_BASE: DEFAULT_BASE,
    HASH_LENGTH: HASH_LENGTH,
    sha256Hex: sha256Hex,
    fetchSegments: fetchSegments
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ASSponsorBlock;
})(typeof globalThis !== 'undefined' ? globalThis : this);
