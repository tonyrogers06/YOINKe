"""
YOINKe — Desktop Application (pywebview + Edge WebView2 + SQLite)
Uses a local ThreadingHTTPServer for UI <-> Python communication so the
WinForms/WebView2 UI thread never blocks on Python GIL or pythonnet IPC.
"""

import os
import re
import sys
import json
import time
import shutil
import socket
import threading
import subprocess
import webbrowser
import urllib.request
import zipfile
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import webview

HOST_DIR = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(HOST_DIR, 'ui')
sys.path.insert(0, HOST_DIR)

import db
from downloader import download_video, DownloadCancelledError, LOG_DIR

APP_VERSION = '2.0.0'
GITHUB_REPO = 'tonyrogers06/YOINKe'
GITHUB_URL = f'https://github.com/{GITHUB_REPO}'
COFFEE_URL = 'https://buymeacoffee.com/tonyrogers'

APP_HOST = '127.0.0.1'
APP_PORT = 47892


def _parse_speed_mb(speed_str: str) -> float:
    if not speed_str:
        return 0.0
    m = re.search(r'([\d.]+)\s*(GB|MB|KB)/s', speed_str, re.IGNORECASE)
    if not m:
        return 0.0
    val = float(m.group(1))
    unit = m.group(2).upper()
    if unit == 'GB':
        return val * 1024.0
    if unit == 'KB':
        return val / 1024.0
    return val


class VideoGrabberApi:
    def __init__(self):
        self.window = None
        self.cancel_events = {}   # job_id -> threading.Event
        self.active_speeds = {}   # job_id -> float MB/s
        self._disk_cache = ('—', 0.0)

    def get_state(self):
        settings = db.get_settings()
        downloads = db.list_downloads()
        out_dir = settings.get('outputDir') or os.path.expanduser('~/Downloads/VideoGrabber')
        now = time.time()
        disk_free, last_disk_t = self._disk_cache
        if now - last_disk_t > 15.0:
            try:
                os.makedirs(out_dir, exist_ok=True)
                usage = shutil.disk_usage(out_dir)
                disk_free = f'{usage.free / (1024 ** 3):.1f} GB'
            except Exception:
                pass
            self._disk_cache = (disk_free, now)
        total_mb = sum(self.active_speeds.values())
        return {
            'downloads': downloads,
            'settings': settings,
            'diskFree': disk_free,
            'totalSpeedMB': total_mb,
        }

    def add_download(self, msg: dict):
        url = (msg.get('url') or '').strip()
        if not url.lower().startswith(('http://', 'https://')):
            return {'ok': False, 'error': 'Only http:// and https:// URLs are allowed.'}
        settings = db.get_settings()
        job_id = msg.get('jobId') or f'job_{int(time.time() * 1000)}'
        out_dir = msg.get('outputDir') or settings.get('outputDir') or ''
        name = msg.get('saveName') or msg.get('name') or _guess_name(msg['url'])
        stream_type = msg.get('type', 'MP4')
        out_format = msg.get('format', 'mp4')

        os.makedirs(LOG_DIR, exist_ok=True)
        log_path = os.path.join(LOG_DIR, f'{job_id}.log')

        db.insert_download({
            'job_id': job_id,
            'name': name,
            'url': msg['url'],
            'stream_type': stream_type,
            'quality': msg.get('quality') or '',
            'audio_lang': msg.get('audioLang') or '',
            'out_format': out_format,
            'status': 'running',
            'progress': 0,
            'status_text': 'Starting…',
            'log_path': log_path,
            'referer': msg.get('referer') or '',
            'origin': msg.get('origin') or '',
            'cookie': msg.get('cookie') or '',
            'authorization': msg.get('authorization') or '',
            'user_agent': msg.get('userAgent') or '',
            'created_at': time.time(),
        })

        cancel_ev = threading.Event()
        self.cancel_events[job_id] = cancel_ev
        self.active_speeds[job_id] = 0.0

        job_cfg = dict(msg)
        job_cfg['jobId'] = job_id
        job_cfg['outputDir'] = out_dir
        job_cfg['saveName'] = name
        job_cfg['threadCount'] = int(msg.get('threadCount') or settings.get('threadCount') or 16)
        job_cfg['preferGpu'] = bool(msg.get('preferGpu', settings.get('preferGpu', True)))

        threading.Thread(
            target=self._run_job,
            args=(job_id, job_cfg, log_path, cancel_ev),
            daemon=True,
        ).start()
        return {'ok': True, 'jobId': job_id}

    def _run_job(self, job_id: str, msg: dict, log_path: str, cancel_ev: threading.Event):
        last_update = [0.0]

        def progress_cb(pct, speed='', eta='', status_text=''):
            self.active_speeds[job_id] = _parse_speed_mb(speed)
            now = time.time()
            if now - last_update[0] >= 0.25 or pct >= 96:
                last_update[0] = now
                db.update_download(
                    job_id,
                    progress=int(pct),
                    speed=speed or '',
                    eta=eta or '',
                    status_text=status_text or 'Downloading…',
                )

        try:
            output_file = download_video(
                url           = msg['url'],
                stream_type   = msg.get('type', 'MP4'),
                quality       = msg.get('quality'),
                audio_lang    = msg.get('audioLang'),
                out_format    = msg.get('format', 'mp4'),
                out_dir       = msg.get('outputDir') or '',
                save_name     = msg.get('saveName') or msg.get('name') or '',
                ffmpeg_path   = msg.get('ffmpegPath') or '',
                nm3u8_path    = msg.get('nm3u8Path') or '',
                thread_count  = int(msg.get('threadCount') or 16),
                prefer_gpu    = bool(msg.get('preferGpu', True)),
                referer       = msg.get('referer') or '',
                origin        = msg.get('origin') or '',
                cookie        = msg.get('cookie') or '',
                authorization = msg.get('authorization') or '',
                user_agent    = msg.get('userAgent') or '',
                log_path      = log_path,
                cancel_event  = cancel_ev,
                progress_cb   = progress_cb,
            )
            fsize = os.path.getsize(output_file) if os.path.isfile(output_file) else 0
            db.update_download(
                job_id,
                status='completed',
                progress=100,
                speed='',
                eta='',
                status_text='Completed',
                file_path=output_file,
                file_size=fsize,
                completed_at=time.time(),
            )
        except DownloadCancelledError:
            db.delete_download(job_id)
        except Exception as exc:
            db.update_download(
                job_id,
                status='failed',
                speed='',
                eta='',
                error=str(exc),
                status_text='Failed',
            )
        finally:
            self.active_speeds.pop(job_id, None)
            self.cancel_events.pop(job_id, None)

    def cancel_download(self, job_id: str):
        ev = self.cancel_events.get(job_id)
        if ev:
            ev.set()
        else:
            db.delete_download(job_id)
        return {'ok': True}

    def retry_download(self, job_id: str):
        rec = db.get_download(job_id)
        if not rec:
            return {'ok': False}
        db.delete_download(job_id)
        return self.add_download({
            'url': rec['url'],
            'name': rec['name'],
            'saveName': rec['name'],
            'type': rec['stream_type'],
            'quality': rec['quality'],
            'audioLang': rec['audio_lang'],
            'format': rec['out_format'],
            'referer': rec['referer'],
            'origin': rec['origin'],
            'cookie': rec['cookie'],
            'authorization': rec['authorization'],
            'userAgent': rec['user_agent'],
        })

    def delete_history(self, job_id: str):
        db.delete_download(job_id)
        return {'ok': True}

    def clear_finished(self):
        db.clear_finished()
        return {'ok': True}

    def save_settings(self, updates: dict):
        return db.save_settings(updates or {})

    def browse_folder(self):
        if not self.window:
            return ''
        res = self.window.create_file_dialog(webview.FOLDER_DIALOG)
        if res and len(res) > 0:
            return res[0]
        return ''

    def open_folder(self, path: str):
        target = path or db.get_settings().get('outputDir') or ''
        if target:
            os.makedirs(target, exist_ok=True)
            _os_open(target)
        return {'ok': True}

    def play_by_id(self, job_id: str):
        rec = db.get_download(job_id)
        if rec and rec.get('file_path') and os.path.isfile(rec['file_path']):
            _os_open(rec['file_path'])
            return {'ok': True}
        return {'ok': False, 'error': 'File not found on disk'}

    def reveal_by_id(self, job_id: str):
        rec = db.get_download(job_id)
        if rec and rec.get('file_path') and os.path.exists(rec['file_path']):
            fp = os.path.normpath(rec['file_path'])
            if sys.platform == 'win32':
                subprocess.Popen(['explorer', '/select,', fp])
            else:
                _os_open(os.path.dirname(fp))
            return {'ok': True}
        return {'ok': False, 'error': 'File not found on disk'}

    def open_log_by_id(self, job_id: str):
        rec = db.get_download(job_id)
        if rec and rec.get('log_path') and os.path.isfile(rec['log_path']):
            _os_open(rec['log_path'])
            return {'ok': True}
        return {'ok': False}

    def open_external(self, target: str):
        # Strictly allowlist external links
        url = GITHUB_URL if target == 'github' else COFFEE_URL if target == 'coffee' else None
        if url and url.startswith('https://'):
            webbrowser.open(url)
            return {'ok': True, 'url': url, 'isPlaceholder': 'your-username' in url}
        return {'ok': False}

    def check_for_updates(self):
        if 'your-username' in GITHUB_REPO:
            return {
                'ok': False,
                'version': APP_VERSION,
                'message': 'Set GITHUB_REPO in gui_app.py to your GitHub repo to enable 1-click updates.',
            }
        api_url = f'https://api.github.com/repos/{GITHUB_REPO}/releases/latest'
        try:
            req = urllib.request.Request(api_url, headers={'User-Agent': 'YOINKe-Updater'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            latest = (data.get('tag_name') or '').lstrip('vV')
            if not latest:
                return {'ok': False, 'version': APP_VERSION, 'message': 'No releases found.'}
            if _ver_tuple(latest) > _ver_tuple(APP_VERSION):
                zip_url = None
                for asset in data.get('assets', []):
                    if asset.get('name', '').endswith('.zip'):
                        zip_url = asset.get('browser_download_url')
                        break
                if not zip_url:
                    zip_url = data.get('zipball_url')
                return {
                    'ok': True,
                    'updateAvailable': True,
                    'currentVersion': APP_VERSION,
                    'latestVersion': latest,
                    'downloadUrl': zip_url,
                    'releaseUrl': data.get('html_url', GITHUB_URL),
                }
            return {
                'ok': True,
                'updateAvailable': False,
                'currentVersion': APP_VERSION,
                'latestVersion': latest,
                'message': f'You are on the latest version (v{APP_VERSION}).',
            }
        except Exception as exc:
            return {'ok': False, 'version': APP_VERSION, 'message': f'Update check failed: {exc}'}

    def apply_update(self, download_url: str):
        allowed_hosts = ('https://github.com/', 'https://objects.githubusercontent.com/', 'https://api.github.com/')
        if not download_url or not download_url.startswith(allowed_hosts):
            return {'ok': False, 'message': 'Untrusted update URL.'}
        try:
            upd_dir = os.path.join(os.environ.get('TEMP', '/tmp'), 'VideoGrabber', 'update')
            shutil.rmtree(upd_dir, ignore_errors=True)
            os.makedirs(upd_dir, exist_ok=True)
            zip_path = os.path.join(upd_dir, 'release.zip')

            req = urllib.request.Request(download_url, headers={'User-Agent': 'YOINKe-Updater'})
            with urllib.request.urlopen(req, timeout=60) as r, open(zip_path, 'wb') as f:
                shutil.copyfileobj(r, f)

            extract_dir = os.path.join(upd_dir, 'extracted')
            os.makedirs(extract_dir, exist_ok=True)
            # Zip-Slip protection: verify every member stays inside extract_dir
            with zipfile.ZipFile(zip_path, 'r') as zf:
                base = os.path.realpath(extract_dir)
                for member in zf.infolist():
                    dest = os.path.realpath(os.path.join(base, member.filename))
                    if not (dest == base or dest.startswith(base + os.sep)):
                        raise RuntimeError('Unsafe path detected in update archive.')
                zf.extractall(extract_dir)

            src_host = None
            for root_d, dirs, files in os.walk(extract_dir):
                if 'gui_app.py' in files:
                    src_host = root_d
                    break
            if not src_host:
                return {'ok': False, 'message': 'Invalid update archive (gui_app.py not found).'}

            for item in os.listdir(src_host):
                if item in ('videograbber.db', 'logs', '__pycache__'):
                    continue
                s = os.path.join(src_host, item)
                d = os.path.join(HOST_DIR, item)
                if os.path.isdir(s):
                    shutil.copytree(s, d, dirs_exist_ok=True)
                else:
                    shutil.copy2(s, d)

            subprocess.Popen([sys.executable, os.path.join(HOST_DIR, 'gui_app.py')], cwd=HOST_DIR)
            if self.window:
                threading.Timer(0.4, self.window.destroy).start()
            return {'ok': True, 'message': 'Updated! Restarting YOINKe...'}
        except Exception as exc:
            return {'ok': False, 'message': f'Update failed: {exc}'}

    def cancel_all_running(self):
        for ev in list(self.cancel_events.values()):
            ev.set()


def _os_open(path: str):
    if sys.platform == 'win32':
        os.startfile(path)
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', path])
    else:
        subprocess.Popen(['xdg-open', path])


def _ver_tuple(v: str):
    parts = []
    for p in v.split('.'):
        m = re.match(r'(\d+)', p)
        parts.append(int(m.group(1)) if m else 0)
    return tuple(parts)


def _guess_name(url: str) -> str:
    try:
        seg = url.split('?')[0].rstrip('/').split('/')[-1]
        if seg:
            return os.path.splitext(seg)[0][:60]
    except Exception:
        pass
    return 'video'


def _start_http_ui_server(api: VideoGrabberApi) -> int:
    srv_port_holder = [0]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def _is_local_origin(self):
            origin = self.headers.get('Origin')
            if not origin:
                return True
            expected = f'http://127.0.0.1:{srv_port_holder[0]}'
            return origin == expected

        def _send_json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._is_local_origin():
                self.send_error(403)
                return
            path = self.path.split('?')[0]
            if path == '/api/state':
                return self._send_json(api.get_state())

            rel = 'index.html' if path in ('/', '') else path.lstrip('/')
            safe = os.path.normpath(os.path.join(UI_DIR, rel))
            if not safe.startswith(os.path.normpath(UI_DIR)) or not os.path.isfile(safe):
                self.send_error(404)
                return
            mime, _ = mimetypes.guess_type(safe)
            with open(safe, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', mime or 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if not self._is_local_origin():
                self.send_error(403)
                return
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(length) if length > 0 else b'{}'
            try:
                body = json.loads(raw.decode('utf-8')) if raw else {}
            except Exception:
                body = {}

            p = self.path.split('?')[0]
            if p == '/api/add':
                return self._send_json(api.add_download(body))
            if p == '/api/cancel':
                return self._send_json(api.cancel_download(body.get('jobId', '')))
            if p == '/api/retry':
                return self._send_json(api.retry_download(body.get('jobId', '')))
            if p == '/api/delete':
                return self._send_json(api.delete_history(body.get('jobId', '')))
            if p == '/api/clear':
                return self._send_json(api.clear_finished())
            if p == '/api/play':
                return self._send_json(api.play_by_id(body.get('jobId', '')))
            if p == '/api/reveal':
                return self._send_json(api.reveal_by_id(body.get('jobId', '')))
            if p == '/api/open_log':
                return self._send_json(api.open_log_by_id(body.get('jobId', '')))
            if p == '/api/open_folder':
                return self._send_json(api.open_folder(body.get('path', '')))
            if p == '/api/browse_folder':
                return self._send_json({'path': api.browse_folder()})
            if p == '/api/settings':
                return self._send_json(api.save_settings(body))
            if p == '/api/open_external':
                return self._send_json(api.open_external(body.get('target', '')))
            if p == '/api/check_updates':
                return self._send_json(api.check_for_updates())
            if p == '/api/apply_update':
                return self._send_json(api.apply_update(body.get('downloadUrl', '')))
            self.send_error(404)

    srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    port = srv.server_address[1]
    srv_port_holder[0] = port
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port


def _start_ipc_server(api: VideoGrabberApi):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((APP_HOST, APP_PORT))
    srv.listen(16)

    def serve():
        while True:
            try:
                conn, _ = srv.accept()
                data = b''
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                    if b'\n' in data:
                        break
                line = data.decode('utf-8', errors='replace').strip()
                if line:
                    msg = json.loads(line)
                    if msg.get('type') != 'OPEN_APP':
                        api.add_download(msg)
                conn.sendall(b'{"ok":true}\n')
                conn.close()
            except Exception:
                pass

    threading.Thread(target=serve, daemon=True).start()


def main():
    db.init_db()
    api = VideoGrabberApi()
    _start_ipc_server(api)
    http_port = _start_http_ui_server(api)

    ico_path = os.path.join(HOST_DIR, 'icon.ico')
    win = webview.create_window(
        'YOINKe',
        url=f'http://127.0.0.1:{http_port}/',
        width=1100,
        height=700,
        min_size=(860, 560),
        background_color='#111318',
    )
    api.window = win
    win.events.closed += api.cancel_all_running
    webview.start(icon=ico_path if os.path.isfile(ico_path) else None, debug=False)


if __name__ == '__main__':
    main()
