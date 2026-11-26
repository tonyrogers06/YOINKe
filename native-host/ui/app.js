/* VideoGrabber Desktop UI Logic (pywebview bridge) */

let state = {
  downloads: [],
  settings: {
    theme: 'dark',
    accent: 'indigo',
    density: 'comfortable',
    outputDir: '',
    threadCount: 16,
    preferGpu: true,
  },
  diskFree: '—',
};

let currentView = 'all';
let selectedJobId = null;
let sparkHistory = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
let toastTimer = null;
let lastListSig = '';
let lastDrawerSig = '';
let pendingUpdateUrl = '';

async function apiGet(path) {
  const r = await fetch(path, { cache: 'no-store' });
  return r.json();
}

async function apiPost(path, body = {}) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ── Boot & Non-Overlapping Polling ─────────────────────────────────────────
let isRefreshing = false;

async function pollLoop() {
  if (!isRefreshing) {
    isRefreshing = true;
    await refreshState();
    isRefreshing = false;
  }
  const hasActive = state.downloads.some(d => d.status === 'running');
  setTimeout(pollLoop, hasActive ? 450 : 1200);
}

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  renderSparkline();
  pollLoop();
});

async function refreshState() {
  try {
    const res = await apiGet('/api/state');
    state.downloads = res.downloads || [];
    state.settings = res.settings || state.settings;
    state.diskFree = res.diskFree || '—';

    applyThemeAndAccent();
    updateBandwidth(res.totalSpeedMB || 0);
    renderAll();
  } catch (e) {
    // Ignore transient errors during close
  }
}

function applyThemeAndAccent() {
  const s = state.settings;
  document.documentElement.setAttribute('data-theme', s.theme || 'dark');
  document.documentElement.setAttribute('data-accent', s.accent || 'indigo');

  document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('selected'));
  document.getElementById(`theme-card-${s.theme || 'dark'}`)?.classList.add('selected');

  document.querySelectorAll('.swatch-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.acc === (s.accent || 'indigo'));
  });

  const dens = s.density || 'comfortable';
  document.getElementById('densityComfortable')?.classList.toggle('active', dens === 'comfortable');
  document.getElementById('densityCompact')?.classList.toggle('active', dens === 'compact');

  document.getElementById('footer-path').textContent = s.outputDir || '~/Downloads/VideoGrabber';
  document.getElementById('footer-disk').textContent = state.diskFree;
  document.getElementById('footer-gpu').textContent = s.preferGpu ? 'NVENC/CUDA' : 'CPU';
  document.getElementById('bw-threads').textContent = `${s.threadCount || 16} threads`;
}

function updateBandwidth(mbPerSec) {
  const txt = `${mbPerSec.toFixed(1)} MB/s`;
  document.getElementById('header-global-speed').textContent = txt;
  document.getElementById('sidebar-speed').textContent = txt;
  sparkHistory.shift();
  sparkHistory.push(mbPerSec);
  renderSparkline();
}

function renderSparkline() {
  const el = document.getElementById('sparkline');
  if (!el) return;
  const maxVal = Math.max(1, ...sparkHistory);
  el.innerHTML = sparkHistory.map(v => {
    const pct = Math.max(10, Math.round((v / maxVal) * 100));
    return `<div class="spark-bar" style="height:${pct}%"></div>`;
  }).join('');
}

// ── Rendering Downloads ────────────────────────────────────────────────────
function renderAll() {
  const all = state.downloads;
  const activeCount = all.filter(d => d.status === 'running').length;
  const doneCount = all.filter(d => d.status === 'completed').length;
  const failCount = all.filter(d => d.status === 'failed').length;

  document.getElementById('cnt-all').textContent = all.length;
  document.getElementById('cnt-active').textContent = activeCount;
  document.getElementById('cnt-completed').textContent = doneCount;
  document.getElementById('cnt-failed').textContent = failCount;
  document.getElementById('leg-active').textContent = activeCount;
  document.getElementById('leg-done').textContent = doneCount;
  document.getElementById('leg-fail').textContent = failCount;
  document.getElementById('bw-tasks').textContent = `${activeCount} active task${activeCount !== 1 ? 's' : ''}`;

  const streamCount = all.filter(d => d.stream_type === 'HLS' || d.stream_type === 'DASH').length;
  const directCount = all.length - streamCount;
  const totalBytes = all.reduce((acc, d) => acc + (d.file_size || 0), 0);
  document.getElementById('cat-streams').textContent = streamCount;
  document.getElementById('cat-direct').textContent = directCount;
  document.getElementById('cat-size').textContent = formatSize(totalBytes);

  // Filter by view + search
  const query = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  let items = all.filter(d => {
    if (currentView === 'active' && d.status !== 'running') return false;
    if (currentView === 'completed' && d.status !== 'completed') return false;
    if (currentView === 'failed' && d.status !== 'failed') return false;
    if (query) {
      return (d.name || '').toLowerCase().includes(query) || (d.url || '').toLowerCase().includes(query);
    }
    return true;
  });

  // Sort
  const sortBy = document.getElementById('sortSelect').value;
  items.sort((a, b) => {
    if (sortBy === 'size') return (b.file_size || 0) - (a.file_size || 0);
    if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
    return (b.created_at || 0) - (a.created_at || 0);
  });

  document.getElementById('downloads-counter').textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

  const listEl = document.getElementById('downloadsList');
  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <i data-lucide="inbox" style="width:36px;height:36px;opacity:0.45"></i>
        <div style="font-size:14px;font-weight:600;color:var(--text-primary)">No downloads here</div>
        <div style="font-size:12px">Click a video in the VideoGrabber browser extension or click <strong>+ New Download</strong>.</div>
      </div>`;
    lucide.createIcons();
    renderDrawer();
    return;
  }

  const isCompact = state.settings.density === 'compact';
  const sig = JSON.stringify([items.map(d => [d.job_id, d.status, d.progress, d.speed, d.eta, d.file_size, d.error]), isCompact, selectedJobId]);
  if (sig !== lastListSig) {
    lastListSig = sig;
    listEl.innerHTML = items.map(d => buildRowHtml(d, isCompact)).join('');
    lucide.createIcons();
  }
  renderDrawer();
}

function buildRowHtml(d, isCompact) {
  const isSelected = d.job_id === selectedJobId;
  const st = d.status;
  const pct = Math.min(100, Math.max(0, d.progress || 0));

  let iconClass = '';
  let iconName = 'video';
  let badgeClass = 'badge-running';
  let badgeText = 'Downloading';
  let fillColor = 'var(--accent)';

  if (st === 'completed') {
    iconClass = 'done';
    iconName = 'check-circle-2';
    badgeClass = 'badge-completed';
    badgeText = 'Completed';
    fillColor = 'var(--accent)';
  } else if (st === 'failed') {
    iconClass = 'failed';
    iconName = 'alert-octagon';
    badgeClass = 'badge-failed';
    badgeText = 'Failed';
    fillColor = '#F87171';
  }

  let domain = '';
  try { domain = new URL(d.url).hostname; } catch { domain = d.url; }

  const sizeOrStatus = st === 'completed'
    ? `${formatSize(d.file_size)} • ${formatDate(d.completed_at || d.created_at)}`
    : st === 'failed'
      ? (d.error || 'Download failed')
      : (d.status_text || 'Downloading…');

  const rightStatMain = st === 'completed'
    ? 'Done'
    : st === 'failed'
      ? 'Error'
      : (d.speed || '—');

  const rightStatSub = st === 'completed'
    ? (d.out_format || 'MP4').toUpperCase()
    : st === 'failed'
      ? 'Click log'
      : (d.eta ? `ETA ${d.eta}` : 'Active');

  const actionsHtml = st === 'running'
    ? `<button class="act-btn danger" onclick="event.stopPropagation(); cancelDownload('${escAttr(d.job_id)}')" title="Cancel & delete temp files"><i data-lucide="x" style="width:13px;height:13px"></i> Cancel</button>`
    : st === 'completed'
      ? `<button class="act-btn" onclick="event.stopPropagation(); playById('${escAttr(d.job_id)}')" title="Play video"><i data-lucide="play" style="width:13px;height:13px;color:#34D399"></i> Play</button>
         <button class="act-btn" onclick="event.stopPropagation(); revealById('${escAttr(d.job_id)}')" title="Open folder"><i data-lucide="folder-open" style="width:13px;height:13px;color:var(--accent)"></i></button>
         <button class="act-btn danger" onclick="event.stopPropagation(); deleteHistory('${escAttr(d.job_id)}')" title="Remove from history"><i data-lucide="trash-2" style="width:13px;height:13px"></i></button>`
      : `<button class="act-btn" onclick="event.stopPropagation(); retryDownload('${escAttr(d.job_id)}')" title="Retry"><i data-lucide="refresh-cw" style="width:13px;height:13px;color:#60A5FA"></i></button>
         ${d.log_path ? `<button class="act-btn" onclick="event.stopPropagation(); openLogById('${escAttr(d.job_id)}')" title="View error log"><i data-lucide="file-text" style="width:13px;height:13px;color:#F59E0B"></i></button>` : ''}
         <button class="act-btn danger" onclick="event.stopPropagation(); deleteHistory('${escAttr(d.job_id)}')" title="Remove"><i data-lucide="trash-2" style="width:13px;height:13px"></i></button>`;

  return `
    <div class="download-row ${isCompact ? 'compact' : ''} ${isSelected ? 'row-selected' : ''}"
         onclick="selectDownload('${escAttr(d.job_id)}')">
      <div class="row-top">
        <div class="row-info">
          <div class="row-icon ${iconClass}"><i data-lucide="${iconName}" style="width:17px;height:17px"></i></div>
          <div style="min-width:0;flex:1">
            <div class="row-title-line">
              <span class="row-name truncate">${escHtml(d.name)}</span>
              <span class="status-badge badge-type mono">${escHtml(d.stream_type)}</span>
              ${d.quality ? `<span class="status-badge badge-type mono">${escHtml(d.quality)}</span>` : ''}
              <span class="status-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="row-sub">
              <span class="truncate" style="max-width:170px">${escHtml(domain)}</span>
              <span>•</span>
              <span class="truncate" style="${st === 'failed' ? 'color:#F87171' : ''}">${escHtml(sizeOrStatus)}</span>
            </div>
          </div>
        </div>
        <div class="row-right">
          <div class="row-stat">
            <div class="row-stat-main mono" style="color:${st === 'completed' ? '#34D399' : st === 'failed' ? '#F87171' : 'var(--accent)'}">${escHtml(rightStatMain)}</div>
            <div class="row-stat-sub mono">${escHtml(rightStatSub)}</div>
          </div>
          <div class="row-stat" style="width:46px">
            <div class="row-stat-main mono">${pct}%</div>
          </div>
          <div class="row-actions">${actionsHtml}</div>
        </div>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${pct}%;background:${fillColor}"></div>
      </div>
    </div>`;
}

// ── Drawer Inspector ───────────────────────────────────────────────────────
function selectDownload(jobId) {
  selectedJobId = jobId;
  document.getElementById('detailsDrawer').classList.remove('hidden');
  renderAll();
}

function toggleDrawer() {
  document.getElementById('detailsDrawer').classList.toggle('hidden');
}

function renderDrawer() {
  const drawer = document.getElementById('detailsDrawer');
  if (drawer.classList.contains('hidden')) return;
  const d = state.downloads.find(x => x.job_id === selectedJobId);
  const body = document.getElementById('drawerBody');
  const foot = document.getElementById('drawerFooter');
  if (!d) {
    if (lastDrawerSig !== 'empty') {
      lastDrawerSig = 'empty';
      body.innerHTML = `<div style="color:var(--text-secondary);font-size:12px;text-align:center;padding:30px 0">Select a download to inspect its details.</div>`;
      foot.innerHTML = '';
    }
    return;
  }

  const dSig = JSON.stringify([d.job_id, d.status, d.progress, d.file_size, d.file_path, d.error]);
  if (dSig === lastDrawerSig) return;
  lastDrawerSig = dSig;

  body.innerHTML = `
    <div class="drawer-preview">
      <div class="drawer-icon"><i data-lucide="film" style="width:22px;height:22px"></i></div>
      <div style="font-weight:600;font-size:12px;word-break:break-all">${escHtml(d.name)}</div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:3px">${escHtml(d.stream_type)} ${d.quality ? '• ' + escHtml(d.quality) : ''}</div>
      <div class="drawer-stats mono">
        <div><div style="font-size:10px;color:var(--text-secondary)">Status</div><div style="font-weight:700;color:var(--accent)">${escHtml(d.status)}</div></div>
        <div><div style="font-size:10px;color:var(--text-secondary)">Progress</div><div style="font-weight:700">${d.progress || 0}%</div></div>
        <div><div style="font-size:10px;color:var(--text-secondary)">Size</div><div style="font-weight:700">${formatSize(d.file_size)}</div></div>
      </div>
    </div>
    <div>
      <span class="meta-label">Source URL</span>
      <div class="meta-box mono">${escHtml(d.url)}</div>
    </div>
    ${d.file_path ? `<div><span class="meta-label">Saved File</span><div class="meta-box mono">${escHtml(d.file_path)}</div></div>` : ''}
    ${d.error ? `<div><span class="meta-label">Error</span><div class="meta-box mono" style="color:#F87171">${escHtml(d.error)}</div></div>` : ''}
    <div class="meta-grid mono">
      <div class="meta-box"><div style="font-size:10px;color:var(--text-secondary)">Created</div><div>${formatDate(d.created_at)}</div></div>
      <div class="meta-box"><div style="font-size:10px;color:var(--text-secondary)">Format</div><div>${escHtml((d.out_format || 'mp4').toUpperCase())}</div></div>
    </div>
  `;

  if (d.status === 'completed' && d.file_path) {
    foot.innerHTML = `
      <button class="btn-accent" style="width:100%;justify-content:center;padding:8px" onclick="playById('${escAttr(d.job_id)}')"><i data-lucide="play" style="width:14px;height:14px"></i> Play Video</button>
      <button class="btn-surface" onclick="revealById('${escAttr(d.job_id)}')"><i data-lucide="folder-open" style="width:14px;height:14px;color:var(--accent)"></i> Open Enclosing Folder</button>`;
  } else if (d.status === 'running') {
    foot.innerHTML = `
      <button class="btn-surface" style="color:#F87171" onclick="cancelDownload('${escAttr(d.job_id)}')"><i data-lucide="x" style="width:14px;height:14px"></i> Cancel Download</button>`;
  } else {
    foot.innerHTML = `
      <button class="btn-accent" style="width:100%;justify-content:center;padding:8px" onclick="retryDownload('${escAttr(d.job_id)}')"><i data-lucide="refresh-cw" style="width:14px;height:14px"></i> Retry Download</button>
      ${d.log_path ? `<button class="btn-surface" onclick="openLogById('${escAttr(d.job_id)}')"><i data-lucide="file-text" style="width:14px;height:14px;color:#F59E0B"></i> View Error Log</button>` : ''}`;
  }
  lucide.createIcons();
}

// ── Actions via local HTTP API ─────────────────────────────────────────────
async function cancelDownload(jobId) {
  await apiPost('/api/cancel', { jobId });
  showToast('Download cancelled & cleaned up');
  await refreshState();
}

async function deleteHistory(jobId) {
  await apiPost('/api/delete', { jobId });
  if (selectedJobId === jobId) selectedJobId = null;
  showToast('Removed from history');
  await refreshState();
}

async function clearFinished() {
  await apiPost('/api/clear');
  showToast('Cleared finished downloads');
  await refreshState();
}

async function retryDownload(jobId) {
  await apiPost('/api/retry', { jobId });
  showToast('Retrying download...');
  await refreshState();
}

async function playById(jobId) {
  const res = await apiPost('/api/play', { jobId });
  if (res && !res.ok) showToast(res.error || 'File not found on disk');
}
async function revealById(jobId) {
  const res = await apiPost('/api/reveal', { jobId });
  if (res && !res.ok) showToast(res.error || 'File not found on disk');
}
function openLogById(jobId) { apiPost('/api/open_log', { jobId }); }
function openOutputFolder() { apiPost('/api/open_folder', { path: state.settings.outputDir || '' }); }

async function openExternal(target) {
  const res = await apiPost('/api/open_external', { target });
  if (res?.isPlaceholder) {
    showToast('Opened placeholder link (update URL in gui_app.py later)');
  }
}

async function checkForUpdates() {
  const txt = document.getElementById('updateStatusText');
  const applyBtn = document.getElementById('btnApplyUpdate');
  txt.textContent = 'Checking for updates…';
  const res = await apiPost('/api/check_updates');
  if (!res) return;
  if (res.updateAvailable) {
    pendingUpdateUrl = res.downloadUrl || '';
    txt.textContent = `Update v${res.latestVersion} available!`;
    applyBtn.classList.remove('hidden');
    showToast(`Update v${res.latestVersion} available!`);
  } else {
    applyBtn.classList.add('hidden');
    txt.textContent = res.message || 'Up to date.';
    showToast(res.message || 'Up to date');
  }
}

async function applyUpdate() {
  if (!pendingUpdateUrl) return;
  const txt = document.getElementById('updateStatusText');
  txt.textContent = 'Downloading & installing update…';
  const res = await apiPost('/api/apply_update', { downloadUrl: pendingUpdateUrl });
  if (res) {
    txt.textContent = res.message;
    showToast(res.message);
  }
}

// ── Modals & Preferences ───────────────────────────────────────────────────
function openAddModal() {
  document.getElementById('addModal').classList.remove('hidden');
  document.getElementById('modalUrl').focus();
}
function closeAddModal() { document.getElementById('addModal').classList.add('hidden'); }

async function submitNewDownload() {
  const url = document.getElementById('modalUrl').value.trim();
  if (!url) { showToast('Please enter a URL'); return; }
  const name = document.getElementById('modalName').value.trim();
  let type = document.getElementById('modalType').value;
  const format = document.getElementById('modalFormat').value;

  if (type === 'AUTO') {
    if (/\.m3u8/i.test(url)) type = 'HLS';
    else if (/\.mpd/i.test(url)) type = 'DASH';
    else type = 'MP4';
  }

  closeAddModal();
  document.getElementById('modalUrl').value = '';
  document.getElementById('modalName').value = '';

  await apiPost('/api/add', { url, name, saveName: name, type, format });
  showToast('Download started');
  await refreshState();
}

function openSettingsModal() {
  const s = state.settings;
  document.getElementById('setOutputDir').value = s.outputDir || '';
  document.getElementById('setThreads').value = String(s.threadCount || 16);
  document.getElementById('setDensity').value = s.density || 'comfortable';
  document.getElementById('setPreferGpu').checked = s.preferGpu !== false;
  document.getElementById('settingsModal').classList.remove('hidden');
}
function closeSettingsModal() { document.getElementById('settingsModal').classList.add('hidden'); }

async function browseOutputDir() {
  const res = await apiPost('/api/browse_folder');
  if (res?.path) document.getElementById('setOutputDir').value = res.path;
}

async function saveSettingsFromModal() {
  const updates = {
    outputDir: document.getElementById('setOutputDir').value.trim(),
    threadCount: parseInt(document.getElementById('setThreads').value, 10) || 16,
    density: document.getElementById('setDensity').value,
    preferGpu: document.getElementById('setPreferGpu').checked,
  };
  await apiPost('/api/settings', updates);
  closeSettingsModal();
  showToast('Preferences saved');
  await refreshState();
}

async function setTheme(theme) {
  state.settings.theme = theme;
  applyThemeAndAccent();
  await apiPost('/api/settings', { theme });
  showToast(`Switched to ${theme.toUpperCase()} theme`);
}

function cycleThemeQuick() {
  const list = ['dark', 'light', 'oled'];
  const next = list[(list.indexOf(state.settings.theme || 'dark') + 1) % list.length];
  setTheme(next);
}

async function setAccent(accent) {
  state.settings.accent = accent;
  applyThemeAndAccent();
  await apiPost('/api/settings', { accent });
  showToast(`Accent set to ${accent}`);
}

async function setDensity(density) {
  state.settings.density = density;
  document.getElementById('densityComfortable').classList.toggle('active', density === 'comfortable');
  document.getElementById('densityCompact').classList.toggle('active', density === 'compact');
  await apiPost('/api/settings', { density });
  renderAll();
}

function switchView(view, btn) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const titles = { all: 'All Downloads', active: 'Active Downloads', completed: 'Completed Downloads', failed: 'Failed Downloads' };
  document.getElementById('view-title').textContent = titles[view] || 'Downloads';
  renderAll();
}

// ── Helpers ────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  t.classList.remove('hide');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hide'), 2400);
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1024 ** 3) return (bytes / (1024 ** 3)).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / (1024 ** 2)).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString();
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return escHtml(s).replace(/'/g, '&#39;'); }
