"""
VideoGrabber — Downloader
Dispatches download jobs to ffmpeg.exe or N_m3u8DL-RE.exe.
Uses NVENC/NVDEC (CUDA) for GPU-accelerated processing on RTX cards.
"""

import os
import re
import sys
import time
import uuid
import threading
import subprocess
import logging
import shutil
from pathlib import Path

log = logging.getLogger('videograbber.downloader')
_PROMOTE_LOCK = threading.Lock()

# ── Defaults (overridden by settings passed from extension) ───────────────
DEFAULT_OUT_DIR     = str(Path.home() / 'Downloads' / 'VideoGrabber')
DEFAULT_FFMPEG      = r'C:\tools\VideoGrabber\ffmpeg.exe'
DEFAULT_NM3U8       = r'C:\tools\VideoGrabber\N_m3u8DL-RE.exe'
DEFAULT_THREADS     = 16
LOG_DIR             = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
STAGING_ROOT        = os.path.join(os.environ.get('TEMP', '.'), 'VideoGrabber', 'staging')


class DownloadCancelledError(Exception):
    """Raised when a download is cancelled by the user."""


# ── Entry Point ────────────────────────────────────────────────────────────

def _is_safe_http_url(url: str) -> bool:
    return isinstance(url, str) and url.strip().lower().startswith(('http://', 'https://'))


def download_video(
    url,
    stream_type,
    quality,
    audio_lang,
    out_format,
    out_dir,
    ffmpeg_path,
    nm3u8_path,
    thread_count,
    prefer_gpu,
    progress_cb,
    save_name='',
    referer='',
    origin='',
    cookie='',
    authorization='',
    user_agent='',
    log_path='',
    cancel_event=None,
):
    """
    Main download dispatcher.
    Returns the absolute path to the saved file.
    """
    if not _is_safe_http_url(url):
        raise ValueError('Only http:// and https:// URLs are supported.')
    # Resolve tool paths
    ffmpeg  = _resolve_tool(ffmpeg_path,  DEFAULT_FFMPEG,  'ffmpeg')
    nm3u8   = _resolve_tool(nm3u8_path,   DEFAULT_NM3U8,   'N_m3u8DL-RE')
    out_dir = out_dir.strip() if out_dir and out_dir.strip() else DEFAULT_OUT_DIR

    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    os.makedirs(STAGING_ROOT, exist_ok=True)

    timestamp = int(time.time())
    clean_name = _sanitize_filename(save_name) if save_name else ''
    base_name = clean_name or f'vg_{timestamp}'

    if not log_path:
        log_path = os.path.join(LOG_DIR, f'{base_name}_{uuid.uuid4().hex[:6]}.log')

    # Isolated staging directory in %TEMP% with unique UUID so concurrent jobs never collide
    staging_dir = os.path.join(STAGING_ROOT, f'{base_name}_{timestamp}_{uuid.uuid4().hex[:8]}')
    os.makedirs(staging_dir, exist_ok=True)

    log.debug(f'Tool: ffmpeg={ffmpeg}  nm3u8={nm3u8}')
    log.debug(f'Job: type={stream_type}  url={url[:80]}  quality={quality}  lang={audio_lang}')
    log.debug(f'Staging: {staging_dir} -> OutDir: {out_dir}  gpu={prefer_gpu}  threads={thread_count}')

    # Notify UI immediately that download has started
    progress_cb(1, '', '', 'Starting...')

    try:
        if stream_type in ('HLS', 'DASH'):
            staged_file = _download_stream(
                url=url, quality=quality, audio_lang=audio_lang,
                staging_dir=staging_dir, save_name=base_name, out_format=out_format,
                ffmpeg=ffmpeg, nm3u8=nm3u8,
                thread_count=thread_count, prefer_gpu=prefer_gpu,
                referer=referer, origin=origin, cookie=cookie,
                authorization=authorization, user_agent=user_agent,
                log_path=log_path, progress_cb=progress_cb,
                cancel_event=cancel_event,
            )
        else:
            staged_file = _download_direct(
                url=url, staging_dir=staging_dir, save_name=base_name, out_format=out_format,
                ffmpeg=ffmpeg, prefer_gpu=prefer_gpu,
                referer=referer, origin=origin, cookie=cookie,
                authorization=authorization, user_agent=user_agent,
                log_path=log_path, progress_cb=progress_cb,
                cancel_event=cancel_event,
            )

        if not os.path.isfile(staged_file) or os.path.getsize(staged_file) == 0:
            raise RuntimeError('Downloaded file is empty or missing.')

        # Atomic promotion to final output directory under lock so concurrent jobs never overwrite
        final_ext = Path(staged_file).suffix.lstrip('.') or out_format
        with _PROMOTE_LOCK:
            final_path = os.path.join(out_dir, f'{base_name}.{final_ext}')
            counter = 1
            while os.path.exists(final_path):
                final_path = os.path.join(out_dir, f'{base_name}_{counter}.{final_ext}')
                counter += 1
            shutil.move(staged_file, final_path)
        return final_path
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


# ── HLS / DASH streaming download ─────────────────────────────────────────

def _download_stream(url, quality, audio_lang, staging_dir, save_name, out_format,
                     ffmpeg, nm3u8, thread_count, prefer_gpu,
                     referer, origin, cookie, authorization, user_agent,
                     log_path, progress_cb, cancel_event=None):
    """
    Uses N_m3u8DL-RE inside an isolated staging directory for parallel segment fetching + muxing.
    Falls back to ffmpeg if N_m3u8DL-RE hits a CLI/runtime crash.
    """
    if not os.path.isfile(nm3u8):
        log.warning(f'N_m3u8DL-RE not found at {nm3u8}, falling back to ffmpeg direct')
        return _download_direct(
            url, staging_dir, save_name, out_format, ffmpeg, prefer_gpu,
            referer, origin, cookie, authorization, user_agent, log_path, progress_cb, cancel_event
        )

    tmp_dir = os.path.join(staging_dir, 'tmp')
    os.makedirs(tmp_dir, exist_ok=True)
    staged_out = os.path.join(staging_dir, f'{save_name}.{out_format}')

    args = [
        nm3u8,
        url,
        '--auto-select',
        '--del-after-done',
        '--thread-count',       str(thread_count),
        '--tmp-dir',            tmp_dir,
        '--save-name',          save_name,
        '--save-dir',           staging_dir,
        '--ffmpeg-binary-path', ffmpeg,
        '--mux-after-done',     f'format={out_format}',
        '--no-log',
    ]

    if referer:
        args += ['-H', f'Referer: {referer}']
    if origin:
        args += ['-H', f'Origin: {origin}']
    if cookie:
        args += ['-H', f'Cookie: {cookie}']
    if authorization:
        args += ['-H', f'Authorization: {authorization}']
    if user_agent:
        args += ['-H', f'User-Agent: {user_agent}']

    # Video quality filter (e.g. "1920x1080 @30fps (5000k)" -> res=1920x1080:for=best)
    if quality:
        res_m = re.search(r'(\d+x\d+)', str(quality))
        if res_m:
            args += ['-sv', f'res={res_m.group(1)}:for=best']
        else:
            args += ['-sv', 'best']
    else:
        args += ['-sv', 'best']

    # Audio language filter (always select best audio so audio is never dropped)
    if audio_lang and audio_lang.strip() and audio_lang.strip().lower() != 'und':
        al = audio_lang.strip()
        if al.startswith(('lang=', 'name=')):
            args += ['-sa', f'{al}:for=best']
        else:
            args += ['-sa', f'lang={al}:for=best']
    else:
        args += ['-sa', 'best']

    log.debug(f'N_m3u8DL-RE cmd: {" ".join(_redact_args(args))}')

    try:
        _run_process(args, progress_cb, tool='nm3u8', log_path=log_path, tmp_dir=tmp_dir, cancel_event=cancel_event)
    except RuntimeError as err:
        # If N_m3u8DL-RE crashed (e.g. System.CommandLine), try ffmpeg fallback
        err_str = str(err)
        if 'System.' in err_str or 'InvocationPipeline' in err_str:
            log.warning(f'N_m3u8DL-RE crashed ({err_str}), retrying with ffmpeg...')
            progress_cb(2, '', '', 'Retrying with ffmpeg...')
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return _download_direct(
                url, staging_dir, save_name, out_format, ffmpeg, prefer_gpu,
                referer, origin, cookie, authorization, user_agent, log_path, progress_cb, cancel_event
            )
        raise

    if os.path.isfile(staged_out):
        return staged_out

    for f in os.listdir(staging_dir):
        full = os.path.join(staging_dir, f)
        if os.path.isfile(full) and f.startswith(save_name) and not f.endswith('.tmp'):
            return full

    raise FileNotFoundError(f'Output file not found in staging dir {staging_dir} after download')


# ── Direct MP4 / WebM download ─────────────────────────────────────────────

def _download_direct(url, staging_dir, save_name, out_format, ffmpeg, prefer_gpu,
                     referer, origin, cookie, authorization, user_agent, log_path, progress_cb, cancel_event=None):
    """
    Downloads a direct video URL via ffmpeg inside staging_dir using stream copy (no re-encode).
    """
    if not os.path.isfile(ffmpeg):
        raise FileNotFoundError(
            f'ffmpeg not found at: {ffmpeg}\n'
            'Download ffmpeg from https://www.gyan.dev/ffmpeg/builds/ '
            'and place ffmpeg.exe at the configured path.'
        )

    staged_out = os.path.join(staging_dir, f'{save_name}.{out_format}')
    args = [ffmpeg, '-y']

    hdrs = ''
    if referer:
        hdrs += f'Referer: {referer}\r\n'
    if origin:
        hdrs += f'Origin: {origin}\r\n'
    if cookie:
        hdrs += f'Cookie: {cookie}\r\n'
    if authorization:
        hdrs += f'Authorization: {authorization}\r\n'
    if hdrs:
        args += ['-headers', hdrs]
    if user_agent:
        args += ['-user_agent', user_agent]

    args += [
        '-i',  url,
        '-c',  'copy',  # stream copy = no re-encode, lossless & fastest
        staged_out,
    ]

    log.debug(f'ffmpeg cmd: {" ".join(_redact_args(args))}')
    _run_process(args, progress_cb, tool='ffmpeg', log_path=log_path, cancel_event=cancel_event)

    if not os.path.isfile(staged_out):
        raise FileNotFoundError(f'ffmpeg did not produce output at {staged_out}')
    return staged_out


# ── Process runner with progress parsing ───────────────────────────────────

def _redact_args(args):
    """Mask Cookie and Authorization values before logging command lines (CWE-532)."""
    redacted = []
    for a in args:
        s = str(a)
        s = re.sub(r'(?i)(Cookie:\s*)([^\r\n]+)', r'\1[REDACTED]', s)
        s = re.sub(r'(?i)(Authorization:\s*)([^\r\n]+)', r'\1[REDACTED]', s)
        redacted.append(s)
    return redacted


def _kill_process_tree(pid):
    try:
        if sys.platform == 'win32':
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        else:
            os.kill(pid, 9)
    except Exception:
        pass


def _run_process(args, progress_cb, tool='ffmpeg', log_path='', tmp_dir='', cancel_event=None):
    """
    Runs a subprocess, logs all output to log_path, parses progress, calls progress_cb.
    """
    if cancel_event and cancel_event.is_set():
        raise DownloadCancelledError('Download cancelled')

    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,  # merge stderr into stdout for single stream
        text=True,
        encoding='utf-8',
        errors='replace',
        bufsize=1,
    )

    duration_s = None
    all_lines = []
    seg_info = {'total': 0, 'done': False, 'max_pct': 0}

    if cancel_event:
        def _watch_cancel():
            while not seg_info['done']:
                if cancel_event.is_set():
                    _kill_process_tree(proc.pid)
                    break
                time.sleep(0.2)
        threading.Thread(target=_watch_cancel, daemon=True).start()
    log_fh = open(log_path, 'a', encoding='utf-8', errors='replace') if log_path else None
    if log_fh:
        log_fh.write(f'\n=== {tool}: {" ".join(_redact_args(args))} ===\n')

    # Background watcher for N_m3u8DL-RE live progress (counts downloaded segments in tmp_dir)
    watcher_thread = None
    if tool == 'nm3u8' and tmp_dir:
        def _watch_tmp():
            start_t = time.time()
            last_t = start_t
            last_bytes = 0
            while not seg_info['done']:
                time.sleep(0.35)
                if seg_info['done']:
                    break
                total = seg_info['total']
                if not os.path.isdir(tmp_dir):
                    continue
                count = 0
                total_bytes = 0
                try:
                    for root_d, _, files in os.walk(tmp_dir):
                        for fn in files:
                            if fn.endswith(('.ts', '.m4s', '.mp4', '.aac', '.m4a')) and not fn.endswith('.tmp'):
                                count += 1
                                try:
                                    total_bytes += os.path.getsize(os.path.join(root_d, fn))
                                except OSError:
                                    pass
                except OSError:
                    continue

                now = time.time()
                dt = max(0.1, now - last_t)
                dbytes = max(0, total_bytes - last_bytes)
                bps = dbytes / dt
                last_t = now
                last_bytes = total_bytes

                if bps >= 1024 * 1024:
                    speed_str = f'{bps / (1024 * 1024):.1f} MB/s'
                elif bps > 0:
                    speed_str = f'{bps / 1024:.0f} KB/s'
                else:
                    speed_str = ''

                if total > 0 and count > 0:
                    pct = min(95, max(2, int(count / total * 95)))
                    elapsed = now - start_t
                    eta_s = int(elapsed * (total - count) / count) if count < total else 0
                    eta_str = f'{eta_s // 60}:{eta_s % 60:02d}' if eta_s > 0 else ''
                    progress_cb(pct, speed_str, eta_str, f'{min(count, total)}/{total} segments')
                elif total_bytes > 0:
                    mb = total_bytes / (1024 * 1024)
                    progress_cb(5, speed_str, '', f'{mb:.1f} MB downloaded')

        watcher_thread = threading.Thread(target=_watch_tmp, daemon=True)
        watcher_thread.start()

    try:
        for line in proc.stdout:
            line = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', line).rstrip()
            if not line:
                continue
            log.debug(f'[{tool}] {line}')
            if log_fh:
                log_fh.write(line + '\n')
                log_fh.flush()
            all_lines.append(line)
            if len(all_lines) > 80:
                all_lines.pop(0)

            if tool == 'ffmpeg':
                if duration_s is None:
                    m = re.search(r'Duration:\s*(\d+):(\d+):([\d.]+)', line)
                    if m:
                        h, mn, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
                        duration_s = h * 3600 + mn * 60 + s

                m = re.search(r'time=(\d+):(\d+):([\d.]+)', line)
                if m and duration_s and duration_s > 0:
                    h, mn, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
                    cur_s = h * 3600 + mn * 60 + s
                    pct = min(99, int(cur_s / duration_s * 100))
                    speed_m = re.search(r'speed=\s*([\d.]+)x', line)
                    speed = f'{speed_m.group(1)}x' if speed_m else ''
                    br_m = re.search(r'bitrate=\s*([\d.]+\s*\S+)', line)
                    bitrate = br_m.group(1) if br_m else ''
                    progress_cb(pct, speed, '', bitrate)

            elif tool == 'nm3u8':
                # Sum segment counts from selected video + audio streams (e.g. "| 120 Segments |")
                for sm in re.finditer(r'\|\s*(\d+)\s+Segments?\b', line, re.IGNORECASE):
                    seg_info['total'] += int(sm.group(1))

                if 'Muxing' in line or 'Binary merging' in line:
                    seg_info['max_pct'] = max(seg_info['max_pct'], 96)
                    progress_cb(seg_info['max_pct'], '', '', 'Muxing video & audio...')

                m = re.search(r'(\d+(?:\.\d+)?)\s*%', line)
                if m:
                    pct = min(99, int(float(m.group(1))))
                    if pct > seg_info['max_pct']:
                        seg_info['max_pct'] = pct
                        speed_m = re.search(r'([\d.]+\s*(?:MB|KB|GB)/s)', line, re.IGNORECASE)
                        speed = speed_m.group(1) if speed_m else ''
                        progress_cb(pct, speed, '', '')

    finally:
        seg_info['done'] = True
        if watcher_thread:
            watcher_thread.join(timeout=1.0)
        if log_fh:
            log_fh.close()

    proc.wait()

    if cancel_event and cancel_event.is_set():
        raise DownloadCancelledError('Download cancelled')

    if proc.returncode not in (0, None):
        # Find the first meaningful error/exception line (top of stack trace, not bottom frame)
        err_lines = [
            l for l in all_lines
            if any(k in l for k in ('Unhandled exception', 'Exception:', 'ERROR', '403', '404', '401', 'Forbidden', 'Unauthorized', 'FAIL'))
            and not l.lstrip().startswith('at ')
        ]
        detail = err_lines[0] if err_lines else (all_lines[0] if all_lines else 'No output')
        raise RuntimeError(f'{tool} exited with code {proc.returncode}: {detail}')

    # Final progress
    progress_cb(100, '', '', 'Complete')


# ── Tool resolution & filename sanitization ────────────────────────────────

def _sanitize_filename(name):
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(name)).strip('. ')
    return cleaned[:120]


def _resolve_tool(configured_path, default_path, tool_name):
    """
    Resolves the path to an external tool (Windows & Linux).
    Priority: bundled bin/ > configured > default > PATH lookup.
    """
    ext = '.exe' if sys.platform == 'win32' else ''
    bundled = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bin', f'{tool_name}{ext}')
    if os.path.isfile(bundled):
        return bundled

    if configured_path and configured_path.strip():
        p = configured_path.strip()
        if os.path.isfile(p):
            return p
        log.warning(f'{tool_name} not found at configured path: {p}')

    if os.path.isfile(default_path):
        return default_path

    # Try system PATH
    found = shutil.which(tool_name)
    if found:
        log.debug(f'{tool_name} found on PATH: {found}')
        return found

    return default_path  # Return default anyway so error message is helpful
