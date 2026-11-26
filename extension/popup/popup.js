/**
 * VideoGrabber — Popup Script
 * Renders detected video cards, quality/language pickers, and manages downloads.
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let detectedVideos = [];
let activeVideoInfo = null;
let filterPlayingOnly = false;
let settings = {};
let downloadJobs = {}; // jobId -> { name, pct, speed, eta, status }
let currentTheme = 'dark';

// ── DOM refs ───────────────────────────────────────────────────────────────
const $statusText       = document.getElementById('status-text');
const $emptyState       = document.getElementById('empty-state');
const $videoList        = document.getElementById('video-list');
const $settingsPanel    = document.getElementById('settings-panel');
const $toast            = document.getElementById('toast');
const $btnTheme         = document.getElementById('btn-theme');
const $btnRefresh       = document.getElementById('btn-refresh');
const $btnSettings      = document.getElementById('btn-settings');
const $btnClear         = document.getElementById('btn-clear');
const $btnFilterActive  = document.getElementById('btn-filter-active');

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  applyTheme(settings.theme || 'dark');
  await loadVideos();
  setupListeners();
}

// ── Settings ───────────────────────────────────────────────────────────────
async function loadSettings() {
  settings = await new Promise(res =>
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, r => res(r?.settings || {}))
  );
  document.getElementById('set-out-dir').value     = settings.outputDir   || '';
  document.getElementById('set-ffmpeg-path').value = settings.ffmpegPath  || '';
  document.getElementById('set-nm3u8-path').value  = settings.nm3u8Path   || '';
  document.getElementById('set-threads').value     = settings.threadCount || 16;
  document.getElementById('set-prefer-gpu').checked = settings.preferGpu !== false;
}

function saveSettings() {
  const updated = {
    outputDir:   document.getElementById('set-out-dir').value.trim(),
    ffmpegPath:  document.getElementById('set-ffmpeg-path').value.trim(),
    nm3u8Path:   document.getElementById('set-nm3u8-path').value.trim(),
    threadCount: parseInt(document.getElementById('set-threads').value) || 16,
    preferGpu:   document.getElementById('set-prefer-gpu').checked,
    theme:       currentTheme,
  };
  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: updated });
  settings = { ...settings, ...updated };
  $settingsPanel.classList.add('hidden');
  showToast('Settings saved ✓');
}

// ── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  $btnTheme.textContent = theme === 'dark' ? '🌙' : '☀️';
}

function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...settings, theme: next } });
}

// ── Video List ─────────────────────────────────────────────────────────────
async function loadVideos() {
  const [{ videos }, active] = await Promise.all([
    new Promise(res =>
      chrome.runtime.sendMessage({ type: 'GET_VIDEOS' }, r => res(r || { videos: [] }))
    ),
    getActiveTabVideo(),
  ]);

  activeVideoInfo = active;
  detectedVideos = matchAndSortVideos(videos || [], activeVideoInfo);

  const hasPlaying = detectedVideos.some(v => v.isPlaying);
  $btnFilterActive.classList.toggle('hidden', !hasPlaying);
  if (hasPlaying && detectedVideos.length > 3) {
    // Auto-focus the playing video if there are many entries
    filterPlayingOnly = true;
    $btnFilterActive.classList.add('active');
  } else if (!hasPlaying) {
    filterPlayingOnly = false;
    $btnFilterActive.classList.remove('active');
  }

  renderVideoList();
}

async function getActiveTabVideo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await new Promise((res) => {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_ACTIVE_VIDEO' }, (resp) => {
        if (chrome.runtime.lastError) return res(null);
        res(resp?.activeVideo || null);
      });
    });
  } catch {
    return null;
  }
}

function matchAndSortVideos(videos, active) {
  const list = videos.map(v => ({ ...v, isPlaying: false }));

  if (active) {
    let matched = null;
    if (active.src && !active.isBlob) {
      matched = list.find(v => v.url === active.src) ||
                list.find(v => active.src.includes(v.url) || v.url.includes(active.src));
    }
    if (!matched) {
      // For blob: MSE players (HLS.js, Video.js, Shaka), prefer master .m3u8/.mpd
      const streams = list.filter(v => v.type === 'HLS' || v.type === 'DASH');
      matched = streams.find(v => /master|playlist|manifest/i.test(v.url)) ||
                streams[streams.length - 1] ||
                list.find(v => v.type === 'MP4' || v.type === 'WebM');
    }
    if (matched) {
      matched.isPlaying = true;
      matched.activeMeta = active;
    }
  }

  // Sort: Playing first -> HLS/DASH (master/smaller manifest first) -> direct video (larger size first) -> newest
  list.sort((a, b) => {
    if (a.isPlaying !== b.isPlaying) return a.isPlaying ? -1 : 1;
    const aStream = (a.type === 'HLS' || a.type === 'DASH') ? 1 : 0;
    const bStream = (b.type === 'HLS' || b.type === 'DASH') ? 1 : 0;
    if (aStream !== bStream) return bStream - aStream;
    if (aStream && bStream) {
      const aMaster = /master|playlist|manifest/i.test(a.url) ? 1 : 0;
      const bMaster = /master|playlist|manifest/i.test(b.url) ? 1 : 0;
      if (aMaster !== bMaster) return bMaster - aMaster;
      // Smaller manifest file is usually the master playlist
      if ((a.size || 0) !== (b.size || 0)) return (a.size || 999999) - (b.size || 999999);
    } else {
      if ((a.size || 0) !== (b.size || 0)) return (b.size || 0) - (a.size || 0);
    }
    return (b.ts || 0) - (a.ts || 0);
  });

  return list;
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 ** 3)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 ** 2)).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function renderVideoList() {
  const totalCount = detectedVideos.length;
  const visible = filterPlayingOnly
    ? detectedVideos.filter(v => v.isPlaying)
    : detectedVideos;

  $statusText.textContent = totalCount === 0
    ? 'No videos detected'
    : filterPlayingOnly
      ? `Showing playing video (${totalCount} total)`
      : `${totalCount} video${totalCount !== 1 ? 's' : ''} detected on this page`;

  if (visible.length === 0) {
    $emptyState.classList.remove('hidden');
    $videoList.innerHTML = '';
    return;
  }

  $emptyState.classList.add('hidden');
  $videoList.innerHTML = '';

  visible.forEach((video) => {
    const realIdx = detectedVideos.indexOf(video);
    $videoList.appendChild(buildVideoCard(video, realIdx));
  });
}

function buildVideoCard(video, idx) {
  const card = document.createElement('div');
  card.className = 'video-card' + (video.isPlaying ? ' video-card--active' : '');
  card.dataset.idx = idx;

  const type = video.type || 'Video';
  const isDrm = video.drm || false;
  const isStream = type === 'HLS' || type === 'DASH';

  const badgeClass = {
    HLS: 'badge--hls', DASH: 'badge--dash',
    MP4: 'badge--mp4', WebM: 'badge--webm',
    MKV: 'badge--mkv',  FLV: 'badge--flv',
  }[type] || 'badge--other';

  let shortUrl;
  try { shortUrl = new URL(video.url).pathname.split('/').pop() || video.url; }
  catch { shortUrl = video.url; }
  if (shortUrl.length > 50) shortUrl = '…' + shortUrl.slice(-47);

  const metaParts = [];
  if (video.activeMeta?.width && video.activeMeta?.height) {
    metaParts.push(`${video.activeMeta.width}×${video.activeMeta.height}`);
  }
  if (video.activeMeta?.duration) {
    metaParts.push(`⏱ ${formatDuration(video.activeMeta.duration)}`);
  }
  if (video.size && !isStream) {
    metaParts.push(`💾 ${formatSize(video.size)}`);
  }

  const defaultName = (video.activeMeta?.title || video.label || shortUrl || 'video')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  card.innerHTML = `
    <div class="card-row1" title="${escAttr(video.url)}">
      ${video.isPlaying ? '<span class="badge badge--playing">★ Playing</span>' : ''}
      <span class="badge ${isDrm ? 'badge--drm' : badgeClass}">${isDrm ? '🔒 DRM' : type}</span>
      <span class="card-label">${escHtml(video.activeMeta?.title || video.label || shortUrl)}</span>
      ${isDrm ? '<span class="card-drm-icon" title="DRM protected — cannot download">🔒</span>' : ''}
    </div>
    ${metaParts.length ? `<div class="card-meta">${escHtml(metaParts.join('  •  '))}</div>` : ''}
    <div class="card-controls">
      ${!isDrm ? `<input type="text" class="ctrl-filename" data-idx="${idx}" value="${escAttr(defaultName)}" placeholder="Video filename...">` : ''}
      <div class="card-controls-row">
        ${isStream && !isDrm ? `
          <select class="ctrl-select select-quality" data-idx="${idx}" title="Video quality">
            <option value="">Loading qualities…</option>
          </select>
          <select class="ctrl-select select-lang" data-idx="${idx}" title="Audio language" style="display:none">
            <option value="">Any language</option>
          </select>
        ` : ''}
        <select class="ctrl-select select-format" data-idx="${idx}" title="Output format" style="max-width:74px">
          <option value="mp4">MP4</option>
          <option value="mkv">MKV</option>
          <option value="webm">WebM</option>
        </select>
        <button class="btn btn--icon btn--sm" data-action="copy" data-idx="${idx}" title="Copy URL">📋</button>
        ${isDrm
          ? `<button class="btn btn--ghost btn--sm btn--disabled" title="DRM protected">🔒 DRM</button>`
          : `<button class="btn btn--primary btn--sm" data-action="download" data-idx="${idx}">⬇ Download</button>`
        }
      </div>
    </div>
  `;

  // Trigger quality fetch for streams
  if (isStream && !isDrm) {
    fetchQualities(video, idx, card);
  }

  return card;
}

// ── Quality / Language Population ─────────────────────────────────────────
async function fetchQualities(video, idx, card) {
  const selQ = card.querySelector('.select-quality');
  const selL = card.querySelector('.select-lang');
  if (!selQ) return;

  selQ.classList.add('loading');

  const { ok, text, error } = await new Promise(res =>
    chrome.runtime.sendMessage({ type: 'FETCH_MANIFEST', url: video.url }, res)
  );

  selQ.classList.remove('loading');

  if (!ok || !text) {
    selQ.innerHTML = `<option value="${video.url}">Default (manifest unavailable)</option>`;
    return;
  }

  let variants = [], audioGroups = [];

  // Check for DRM markers in the manifest itself
  const isManifestDrm = /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95|METHOD=SAMPLE-AES/i.test(text);
  if (isManifestDrm || video.tabHasDrm) {
    const badgeEl = card.querySelector('.badge:not(.badge--playing)');
    if (badgeEl && isManifestDrm) {
      badgeEl.className = 'badge badge--drm';
      badgeEl.textContent = '🔒 DRM';
      const dlBtn = card.querySelector('[data-action="download"]');
      if (dlBtn) {
        dlBtn.className = 'btn btn--ghost btn--sm btn--disabled';
        dlBtn.textContent = '🔒 DRM Protected';
        dlBtn.title = 'DRM-protected streams cannot be downloaded';
        delete dlBtn.dataset.action;
      }
    }
  }

  if (video.type === 'HLS') {
    const parsed = parseHLSManifest(text, video.url);
    variants = parsed.variants;
    audioGroups = parsed.audioGroups;
  } else if (video.type === 'DASH') {
    const parsed = parseDASHManifest(text, video.url);
    variants = parsed.variants;
    audioGroups = parsed.audioGroups;
  }

  // Populate quality dropdown
  if (variants.length > 0) {
    selQ.innerHTML = variants.map((v, i) =>
      `<option value="${escAttr(v.url)}" ${i === 0 ? 'selected' : ''}>${escHtml(v.label)}</option>`
    ).join('');

    // Hide duplicate child-playlist cards that belong to this master playlist
    const childUrls = new Set([
      ...variants.map(v => v.url),
      ...audioGroups.map(ag => ag.url).filter(Boolean),
    ]);
    document.querySelectorAll('.video-card').forEach(otherCard => {
      const otherIdx = parseInt(otherCard.dataset.idx);
      if (otherIdx === idx) return;
      const otherVideo = detectedVideos[otherIdx];
      if (otherVideo && childUrls.has(otherVideo.url)) {
        otherCard.classList.add('hidden');
      }
    });
  } else {
    selQ.innerHTML = `<option value="${escAttr(video.url)}">Best available</option>`;
  }

  // Populate language dropdown (only if multi-track)
  if (audioGroups.length > 1) {
    selL.style.display = '';
    selL.innerHTML = audioGroups.map(ag => {
      const val = ag.filterExpr || ag.lang;
      const suffix = (ag.lang && ag.lang !== 'und' && ag.name.toLowerCase() !== ag.lang.toLowerCase())
        ? ` (${ag.lang})`
        : '';
      return `<option value="${escAttr(val)}" ${ag.isDefault ? 'selected' : ''}>${escHtml(ag.name + suffix)}</option>`;
    }).join('');
    selL.insertAdjacentHTML('afterbegin', '<option value="">Any</option>');
  } else if (audioGroups.length === 1) {
    // Single audio track — still show for transparency
    const ag = audioGroups[0];
    selL.style.display = '';
    selL.innerHTML = `<option value="${escAttr(ag.filterExpr || ag.lang)}">${escHtml(ag.name)}</option>`;
  }
}

// ── Event Listeners ────────────────────────────────────────────────────────
function setupListeners() {
  document.getElementById('btn-open-app')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_APP' }, (resp) => {
      if (resp?.ok) showToast('🖥 Opened VideoGrabber Desktop App');
      else showToast(`⚠ ${resp?.error || 'Could not open Desktop App'}`, 4000);
    });
  });

  $btnTheme.addEventListener('click', toggleTheme);
  $btnRefresh.addEventListener('click', loadVideos);
  $btnClear.addEventListener('click', clearVideos);
  $btnFilterActive.addEventListener('click', () => {
    filterPlayingOnly = !filterPlayingOnly;
    $btnFilterActive.classList.toggle('active', filterPlayingOnly);
    renderVideoList();
  });
  $btnSettings.addEventListener('click', () => $settingsPanel.classList.toggle('hidden'));

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-close-settings').addEventListener('click', () =>
    $settingsPanel.classList.add('hidden')
  );
  document.getElementById('link-install-guide').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('../native-host/README.html') });
  });

  // Event delegation for card buttons
  $videoList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    const video = detectedVideos[idx];
    if (!video) return;

    if (btn.dataset.action === 'copy') {
      navigator.clipboard.writeText(video.url).then(() => showToast('URL copied! 📋'));
    }
    if (btn.dataset.action === 'download') {
      startDownload(video, idx);
    }
  });

  // URL click to copy
  $videoList.addEventListener('click', (e) => {
    if (e.target.classList.contains('card-url')) {
      const idx = parseInt(e.target.closest('.video-card')?.dataset.idx);
      const video = detectedVideos[idx];
      if (video) {
        navigator.clipboard.writeText(video.url).then(() => showToast('URL copied! 📋'));
      }
    }
  });
}

// ── Download ───────────────────────────────────────────────────────────────
function startDownload(video, idx) {
  const card = document.querySelector(`.video-card[data-idx="${idx}"]`);
  const selQ  = card?.querySelector('.select-quality');
  const selL  = card?.querySelector('.select-lang');
  const selF  = card?.querySelector('.select-format');

  const selectedUrl  = (video.type === 'HLS' || video.type === 'DASH') ? video.url : (selQ?.value || video.url);
  const audioLang    = selL?.value || null;
  const format       = selF?.value || 'mp4';
  const quality      = selQ?.selectedOptions[0]?.text || null;

  const jobId = `job_${Date.now()}_${idx}`;
  const customName = card?.querySelector('.ctrl-filename')?.value?.trim();
  const jobName = customName || video.activeMeta?.title || video.label || new URL(video.url).pathname.split('/').pop() || 'video';

  const job = {
    jobId,
    name:        jobName,
    saveName:    jobName,
    type:        video.type,
    url:         selectedUrl,
    originalUrl: video.url,
    quality,
    audioLang,
    format,
    outputDir:   settings.outputDir   || '',
    ffmpegPath:  settings.ffmpegPath  || '',
    nm3u8Path:   settings.nm3u8Path   || '',
    threadCount: settings.threadCount || 16,
    preferGpu:   settings.preferGpu !== false,
    userAgent:   navigator.userAgent,
  };

  chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', job }, (resp) => {
    if (resp?.ok) {
      showToast(`🚀 Sent to Desktop App: ${jobName}`, 3000);
    } else {
      const errMsg = resp?.error || 'Unknown error';
      if (errMsg.includes('not found') || errMsg.includes('host')) {
        showToast('⚠ Native host not installed. See Settings → Setup Guide.', 4000);
      } else {
        showToast(`❌ Error: ${errMsg}`, 4000);
      }
    }
  });
}

function addDownloadJob(jobId, name) {
  downloadJobs[jobId] = { name, pct: 0, speed: '', eta: '', status: 'running' };
  renderQueue();
}

function updateDownloadJob(msg) {
  const job = downloadJobs[msg.jobId] || msg.job || { name: 'video', pct: 0, speed: '', eta: '', status: 'running' };
  const event = msg.event || msg.type;

  if (msg.job) {
    Object.assign(job, msg.job);
  }
  if (event === 'PROGRESS' || msg.pct !== undefined) {
    job.pct    = msg.pct   ?? job.pct ?? 0;
    job.speed  = msg.speed ?? job.speed ?? '';
    job.eta    = msg.eta   ?? job.eta ?? '';
    job.status = 'running';
  }
  if (event === 'DONE') {
    job.pct    = 100;
    job.status = 'done';
    showToast(`✅ Done: ${job.name}`);
  }
  if (event === 'ERROR') {
    job.status = 'error';
    job.error  = msg.message || job.error || 'Unknown error';
    showToast(`❌ Failed: ${job.name}`, 4000);
  }
  downloadJobs[msg.jobId] = job;
  renderQueue();
}

function renderQueue() {
  const jobs = Object.entries(downloadJobs);
  if (jobs.length === 0) {
    $downloadQueue.classList.add('hidden');
    return;
  }
  $downloadQueue.classList.remove('hidden');
  $queueItems.innerHTML = jobs.map(([id, job]) => {
    const pct = Math.round(job.pct || 0);
    const color = job.status === 'done' ? '#2ecc71'
                : job.status === 'error' ? '#e74c3c'
                : 'linear-gradient(90deg, #0f7bff, #e94560)';
    const dismissBtn = job.status !== 'running'
      ? `<button class="queue-dismiss" data-job-id="${escAttr(id)}" title="Dismiss">✕</button>`
      : '';
    return `
      <div class="queue-item">
        <div class="queue-item-label">
          <span class="queue-item-name">${escHtml(job.name)}</span>
          <span>
            <span class="queue-item-pct">${job.status === 'done' ? '✅' : job.status === 'error' ? '❌' : pct + '%'}</span>
            ${dismissBtn}
          </span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width:${pct}%; background:${color}"></div>
        </div>
        ${job.speed ? `<div class="queue-item-meta">${escHtml(job.speed)}${job.eta ? ' • ETA ' + escHtml(job.eta) : ''}</div>` : ''}
        ${job.error  ? `<div class="queue-item-meta" style="color:var(--error)">${escHtml(job.error)}</div>` : ''}
      </div>`;
  }).join('');
}

// ── Clear ──────────────────────────────────────────────────────────────────
async function clearVideos() {
  await new Promise(res => chrome.runtime.sendMessage({ type: 'CLEAR_VIDEOS' }, res));
  detectedVideos = [];
  renderVideoList();
  showToast('List cleared');
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, duration = 2500) {
  $toast.textContent = msg;
  $toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.add('hidden'), duration);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) { return escHtml(str); }

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
