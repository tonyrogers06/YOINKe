/**
 * VideoGrabber — Background Service Worker (Manifest V3)
 * Handles: network sniffing, storage, badge, native messaging bridge
 */

// ── Detection patterns ─────────────────────────────────────────────────────
const VIDEO_URL_PATTERNS = [
  /\.mp4(\?|#|$)/i,
  /\.webm(\?|#|$)/i,
  /\.mkv(\?|#|$)/i,
  /\.m3u8(\?|#|$)/i,
  /\.mpd(\?|#|$)/i,
  /\.flv(\?|#|$)/i,
  /\.avi(\?|#|$)/i,
  /\.mov(\?|#|$)/i,
  // Streaming segment patterns (detected but not shown as top-level entries)
  // /\.ts(\?|#|$)/i,
  // /\.m4s(\?|#|$)/i,
];

const VIDEO_CONTENT_TYPES = [
  'video/',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
];

// URL patterns to EXCLUDE (noise / tracking / ads / segments)
const EXCLUDE_PATTERNS = [
  /\.(gif|jpg|jpeg|png|webp|svg|ico|woff2?|ttf|css|js|json|vtt|srt|ts|m4s)(\?|#|$)/i,
  /doubleclick\.net/i,
  /googlesyndication/i,
  /analytics/i,
  /tracking/i,
  /pixel\./i,
  /ad\.js/i,
  /beacon/i,
  /telemetry/i,
  /thumb(nail)?s?/i,
  /sprite/i,
  /storyboard/i,
];

// ── Helpers ────────────────────────────────────────────────────────────────
function classifyUrl(url, contentType = '') {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('mpegurl') || /\.m3u8(\?|#|$)/i.test(url) || /m3u8/i.test(url)) return 'HLS';
  if (ct.includes('dash+xml') || /\.mpd(\?|#|$)/i.test(url) || /manifest\.mpd/i.test(url)) return 'DASH';
  if (/\.mp4(\?|#|$)/i.test(url)) return 'MP4';
  if (/\.webm(\?|#|$)/i.test(url)) return 'WebM';
  if (/\.mkv(\?|#|$)/i.test(url)) return 'MKV';
  if (/\.flv(\?|#|$)/i.test(url)) return 'FLV';
  if (/\.mov(\?|#|$)/i.test(url)) return 'MOV';
  return 'Video';
}

function isExcluded(url) {
  return EXCLUDE_PATTERNS.some(p => p.test(url));
}

function isVideoUrl(url, contentType) {
  if (isExcluded(url)) return false;
  const urlMatch = VIDEO_URL_PATTERNS.some(p => p.test(url));
  const ctMatch  = contentType && VIDEO_CONTENT_TYPES.some(t => contentType.startsWith(t));
  return urlMatch || ctMatch;
}

function getStorageKey(tabId) { return `tab_${tabId}`; }

async function getTabVideos(tabId) {
  const key  = getStorageKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || [];
}

async function setTabVideos(tabId, videos) {
  await chrome.storage.session.set({ [getStorageKey(tabId)]: videos });
}

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text });
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#e74c3c' });
  }
}

const tabMutationQueues = new Map(); // tabId -> Promise

function enqueueTabMutation(tabId, fn) {
  const prev = tabMutationQueues.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn);
  tabMutationQueues.set(tabId, next);
  return next;
}

async function addVideo(tabId, entry) {
  return enqueueTabMutation(tabId, async () => {
    const videos = await getTabVideos(tabId);
    if (videos.some(v => v.url === entry.url)) return; // dedup
    videos.push(entry);
    await setTabVideos(tabId, videos);
    updateBadge(tabId, videos.length);
  });
}

async function clearTabVideos(tabId) {
  return enqueueTabMutation(tabId, async () => {
    await setTabVideos(tabId, []);
    updateBadge(tabId, 0);
  });
}

// ── Request Header Capture (Cat-Catch pattern) ────────────────────────────
const capturedHeaders = new Map(); // url -> { referer, origin, cookie, userAgent, authorization }

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 || !details.requestHeaders) return;
    if (!isVideoUrl(details.url, '')) return;

    const hdrs = {};
    for (const h of details.requestHeaders) {
      const name = h.name.toLowerCase();
      if (name === 'referer') hdrs.referer = h.value;
      else if (name === 'origin') hdrs.origin = h.value;
      else if (name === 'cookie') hdrs.cookie = h.value;
      else if (name === 'user-agent') hdrs.userAgent = h.value;
      else if (name === 'authorization') hdrs.authorization = h.value;
    }
    if (Object.keys(hdrs).length > 0) {
      capturedHeaders.set(details.url, hdrs);
      if (capturedHeaders.size > 400) {
        const oldestKey = capturedHeaders.keys().next().value;
        capturedHeaders.delete(oldestKey);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// ── Network Request Observer ───────────────────────────────────────────────
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    const url = details.url;

    const contentType = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === 'content-type')?.value?.toLowerCase() || '';
    const contentLength = parseInt(
      details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length')?.value || '0',
      10
    );

    if (!isVideoUrl(url, contentType)) return;

    // Classify using both URL and MIME type before size/generic guards
    const type = classifyUrl(url, contentType);
    if (type !== 'HLS' && type !== 'DASH' && contentLength > 0 && contentLength < 102400) return;
    if (type === 'Video' && !contentType.includes('video/')) return;

    let hostname;
    try { hostname = new URL(url).hostname; } catch { hostname = url; }

    await addVideo(details.tabId, {
      url,
      type,
      label: hostname,
      contentType: contentType || '',
      size: contentLength || 0,
      drm: false,
      ts: Date.now(),
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ── Message Handlers ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {

  // Content script found a <video> src
  if (msg.type === 'DOM_VIDEO') {
    if (!sender.tab) return;
    const url = msg.url;
    if (!url || isExcluded(url)) return;
    let hostname;
    try { hostname = new URL(url).hostname; } catch { hostname = url; }
    addVideo(sender.tab.id, {
      url,
      type: classifyUrl(url),
      label: hostname + ' (DOM)',
      contentType: '',
      drm: false,
      ts: Date.now(),
      source: 'dom',
    });
    return;
  }

  // Content script detected EME DRM on this tab
  if (msg.type === 'DRM_DETECTED') {
    if (!sender.tab) return;
    chrome.storage.session.set({ [`drm_${sender.tab.id}`]: msg.keySystem || 'DRM' });
    return;
  }

  // Popup requests video list
  if (msg.type === 'GET_VIDEOS') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      const videos = tabId ? await getTabVideos(tabId) : [];
      const drmData = tabId ? await chrome.storage.session.get(`drm_${tabId}`) : {};
      const tabHasDrm = Boolean(drmData[`drm_${tabId}`]);
      reply({ videos: videos.map(v => ({ ...v, tabHasDrm })) });
    });
    return true; // keep channel open for async
  }

  // Popup requests clear
  if (msg.type === 'CLEAR_VIDEOS') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        await clearTabVideos(tabId);
      }
      reply({ ok: true });
    });
    return true;
  }

  // Popup requests HLS/DASH manifest fetch (for quality parsing)
  if (msg.type === 'FETCH_MANIFEST') {
    fetchManifest(msg.url).then(reply);
    return true;
  }

  // Popup requests opening the desktop downloader app
  if (msg.type === 'OPEN_APP') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'OPEN_APP' }, (resp) => {
      if (chrome.runtime.lastError) {
        reply({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        reply({ ok: true, resp });
      }
    });
    return true;
  }

  // Popup initiates download — relay to native host
  if (msg.type === 'START_DOWNLOAD') {
    startNativeDownload(msg.job, reply);
    return true;
  }

  // Popup requests persisted download jobs
  if (msg.type === 'GET_DOWNLOADS') {
    getStoredDownloads().then(jobs => reply({ jobs }));
    return true;
  }

  // Popup dismisses a finished/failed download job
  if (msg.type === 'DISMISS_DOWNLOAD') {
    removeStoredDownload(msg.jobId).then(() => reply({ ok: true }));
    return true;
  }

  // Settings save
  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.sync.set(msg.settings, () => reply({ ok: true }));
    return true;
  }

  // Settings load
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.sync.get({
      outputDir: '',
      ffmpegPath: 'C:\\tools\\VideoGrabber\\ffmpeg.exe',
      nm3u8Path:  'C:\\tools\\VideoGrabber\\N_m3u8DL-RE.exe',
      theme: 'dark',
      threadCount: 16,
      preferGpu: true,
    }, (settings) => reply({ settings }));
    return true;
  }
});

// ── Manifest Fetch (for HLS/DASH quality parsing) ─────────────────────────
async function fetchManifest(url) {
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return { ok: true, text, url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Native Messaging Bridge ────────────────────────────────────────────────
const NATIVE_HOST = 'com.videograbber.host';
const activeDownloads = new Map(); // jobId -> port
const DOWNLOADS_KEY = 'vg_download_jobs';

async function getStoredDownloads() {
  const data = await chrome.storage.session.get(DOWNLOADS_KEY);
  return data[DOWNLOADS_KEY] || {};
}

async function updateStoredDownload(jobId, patch) {
  const jobs = await getStoredDownloads();
  jobs[jobId] = { ...(jobs[jobId] || {}), ...patch };
  await chrome.storage.session.set({ [DOWNLOADS_KEY]: jobs });
  return jobs[jobId];
}

async function removeStoredDownload(jobId) {
  const jobs = await getStoredDownloads();
  delete jobs[jobId];
  await chrome.storage.session.set({ [DOWNLOADS_KEY]: jobs });
}

function broadcastProgress(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {}); // popup may be closed
}

async function startNativeDownload(job, reply) {
  try {
    // Merge exact headers captured from webRequest.onSendHeaders (Cat-Catch pattern)
    // Only reuse Cookie/Authorization from originalUrl fallback when origins match (CWE-201)
    const directCap = capturedHeaders.get(job.url);
    const origCap = (!directCap && job.originalUrl) ? capturedHeaders.get(job.originalUrl) : null;
    let sameOrigin = false;
    if (origCap && job.originalUrl) {
      try { sameOrigin = new URL(job.url).origin === new URL(job.originalUrl).origin; } catch {}
    }
    const cap = directCap || origCap || {};
    if (cap.referer && !job.referer) job.referer = cap.referer;
    if (cap.origin && !job.origin) job.origin = cap.origin;
    if (cap.userAgent && !job.userAgent) job.userAgent = cap.userAgent;
    if (directCap || sameOrigin) {
      if (cap.cookie && !job.cookie) job.cookie = cap.cookie;
      if (cap.authorization && !job.authorization) job.authorization = cap.authorization;
    }

    // Fallback to active tab referer & origin if not captured
    if (!job.referer) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.url) job.referer = tabs[0].url;
    }
    if (job.referer && !job.origin) {
      try { job.origin = new URL(job.referer).origin; } catch {}
    }

    // Fallback to chrome.cookies if Cookie header wasn't captured
    if (!job.cookie) {
      try {
        const cookies = await chrome.cookies.getAll({ url: job.url });
        if (cookies && cookies.length > 0) {
          job.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
      } catch {}
    }

    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener(async (msg) => {
      const event = msg.type; // 'PROGRESS', 'DONE', 'ERROR'
      const patch = {
        pct: msg.pct ?? (event === 'DONE' ? 100 : undefined),
        speed: msg.speed ?? '',
        eta: msg.eta ?? '',
        status: event === 'DONE' ? 'done' : event === 'ERROR' ? 'error' : 'running',
        error: event === 'ERROR' ? (msg.message || 'Download failed') : undefined,
        file: msg.file || undefined,
      };
      // Remove undefined keys so existing values are preserved
      Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

      const updated = await updateStoredDownload(job.jobId, patch);
      broadcastProgress({
        ...msg,
        event,
        type: 'DOWNLOAD_PROGRESS',
        jobId: job.jobId,
        job: updated,
      });

      if (event === 'SENT_TO_APP') {
        await removeStoredDownload(job.jobId);
        activeDownloads.delete(job.jobId);
        try { port.disconnect(); } catch {}
        return;
      }

      if (event === 'DONE' || event === 'ERROR') {
        activeDownloads.delete(job.jobId);
        try { port.disconnect(); } catch {}
      }
    });

    port.onDisconnect.addListener(async () => {
      const lastErr = chrome.runtime.lastError?.message;
      if (activeDownloads.has(job.jobId)) {
        const errMsg = lastErr || 'Native host disconnected unexpectedly';
        const updated = await updateStoredDownload(job.jobId, {
          status: 'error',
          error: errMsg,
        });
        broadcastProgress({
          type: 'DOWNLOAD_PROGRESS',
          event: 'ERROR',
          jobId: job.jobId,
          message: errMsg,
          job: updated,
        });
        activeDownloads.delete(job.jobId);
      }
    });

    activeDownloads.set(job.jobId, port);
    port.postMessage(job);
    reply({ ok: true });
  } catch (e) {
    await updateStoredDownload(job.jobId, { status: 'error', error: e.message });
    reply({ ok: false, error: e.message });
  }
}

// ── Tab Lifecycle ──────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([getStorageKey(tabId), `drm_${tabId}`]);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // New navigation — clear old detections
    chrome.storage.session.remove([getStorageKey(tabId), `drm_${tabId}`]);
    updateBadge(tabId, 0);
  }
});

// ── Keep Service Worker Alive During Active Downloads ─────────────────────
// (Chrome MV3 SWs sleep after 30s; we ping while downloads are running)
setInterval(() => {
  if (activeDownloads.size > 0) {
    // No-op ping to keep SW alive
    chrome.storage.session.get('__ping__', () => {});
  }
}, 20000);
