/**
 * VideoGrabber — Content Script
 * Runs on every page (document_start, all_frames).
 * Jobs:
 *   1. Scan DOM for <video>/<source> elements (catches players that use src= directly)
 *   2. Observe mutations so dynamically added players are caught too
 *   3. Mark DRM-protected streams via EME API observation (read-only, no bypass)
 */

(function () {
  'use strict';

  // ── 1. DOM Scanner ────────────────────────────────────────────────────────
  const VIDEO_EXTENSIONS = /\.(mp4|webm|mkv|m3u8|mpd|flv|mov|avi)(\?|#|$)/i;

  function reportUrl(url, source) {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    if (!url.startsWith('http')) return;
    if (!VIDEO_EXTENSIONS.test(url)) return;
    chrome.runtime.sendMessage({ type: 'DOM_VIDEO', url, source }).catch(() => {});
  }

  function scanDOM() {
    // <video src="...">
    document.querySelectorAll('video').forEach(el => {
      reportUrl(el.src, 'video-element');
      reportUrl(el.currentSrc, 'video-currentSrc');
    });
    // <source src="..."> inside <video>
    document.querySelectorAll('video source, source').forEach(el => {
      reportUrl(el.src, 'source-element');
    });
    // <a href> pointing to video files (download links)
    document.querySelectorAll('a[href]').forEach(el => {
      if (VIDEO_EXTENSIONS.test(el.href)) reportUrl(el.href, 'anchor-link');
    });
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanDOM);
  } else {
    scanDOM();
  }
  // Also scan after a short delay for JS-rendered content
  setTimeout(scanDOM, 2000);
  setTimeout(scanDOM, 5000);

  // ── 2. MutationObserver — catch dynamically added players ─────────────────
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Check the node itself
        if (node.tagName === 'VIDEO') reportUrl(node.src || node.currentSrc, 'mutation-video');
        if (node.tagName === 'SOURCE') reportUrl(node.src, 'mutation-source');
        // Check descendants
        node.querySelectorAll?.('video, source').forEach(el => {
          reportUrl(el.src || el.currentSrc, 'mutation-descendant');
        });
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ── 3. EME Observer (read-only — just flags DRM, no bypass) ───────────────
  // We inject a tiny page-context script to observe EME calls.
  // This lets us mark streams as DRM-protected in the popup UI.
  const emsObserverScript = document.createElement('script');
  emsObserverScript.textContent = `(function() {
    if (!window.MediaKeySession) return;

    // Hook generateRequest to detect DRM initiation
    const origGR = MediaKeySession.prototype.generateRequest;
    MediaKeySession.prototype.generateRequest = function(initDataType, initData) {
      try {
        window.postMessage({
          __vgDrm: true,
          initDataType,
          psshBase64: btoa(String.fromCharCode(...new Uint8Array(initData).slice(0, 512)))
        }, '*');
      } catch(e) {}
      return origGR.apply(this, arguments);
    };

    // Hook requestMediaKeySystemAccess to capture key system name
    const origRMKSA = navigator.requestMediaKeySystemAccess.bind(navigator);
    navigator.requestMediaKeySystemAccess = function(keySystem, configs) {
      window.postMessage({ __vgDrm: true, keySystem }, '*');
      return origRMKSA(keySystem, configs);
    };
  })();`;

  try {
    (document.head || document.documentElement).prepend(emsObserverScript);
    emsObserverScript.remove(); // clean up after execution
  } catch (e) { /* CSP may block on some pages — that's OK */ }

  // Listen for EME messages from page context
  window.addEventListener('message', (e) => {
    if (!e.data?.__vgDrm) return;
    // Report DRM detection to background (informational only)
    chrome.runtime.sendMessage({
      type: 'DRM_DETECTED',
      keySystem: e.data.keySystem || 'unknown',
      pageUrl: location.href,
    }).catch(() => {});
  });

  // ── 4. Active Playing Video Detector ───────────────────────────────────────
  function getActiveVideoInfo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;

    let best = null;
    let bestScore = -1;

    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const isVisible = rect.width > 50 && rect.height > 50 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth;

      let score = 0;
      if (!v.paused && !v.ended && v.readyState >= 2) score += 1000;
      if (isVisible) score += 300 + Math.min(500, area / 1000);
      if (v.duration && isFinite(v.duration) && v.duration > 10) score += 200;
      if (v.videoWidth >= 480) score += 100;

      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }

    if (!best || bestScore <= 0) return null;
    return {
      src: best.currentSrc || best.src || '',
      isBlob: (best.currentSrc || best.src || '').startsWith('blob:'),
      width: best.videoWidth || 0,
      height: best.videoHeight || 0,
      duration: isFinite(best.duration) ? Math.round(best.duration) : 0,
      paused: best.paused,
      score: bestScore,
      title: document.title || '',
      pageUrl: location.href,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'GET_ACTIVE_VIDEO') {
      reply({ activeVideo: getActiveVideoInfo() });
      return true;
    }
  });

})();
