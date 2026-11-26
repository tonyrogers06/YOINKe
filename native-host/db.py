"""
VideoGrabber — SQLite Persistence Layer
Stores download history and user preferences locally in videograbber.db.
"""

import os
import json
import sqlite3
import threading
import time
from pathlib import Path

HOST_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HOST_DIR, 'videograbber.db')
_LOCK = threading.Lock()

DEFAULT_SETTINGS = {
    'theme': 'dark',
    'accent': 'indigo',
    'density': 'comfortable',
    'outputDir': str(Path.home() / 'Downloads' / 'VideoGrabber'),
    'threadCount': 16,
    'maxConcurrent': 5,
    'preferGpu': True,
}


def _get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _LOCK:
        conn = _get_conn()
        try:
            conn.execute('PRAGMA journal_mode=WAL;')
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS downloads (
                    job_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    url TEXT NOT NULL,
                    stream_type TEXT NOT NULL,
                    quality TEXT DEFAULT '',
                    audio_lang TEXT DEFAULT '',
                    out_format TEXT DEFAULT 'mp4',
                    status TEXT NOT NULL DEFAULT 'running',
                    progress INTEGER NOT NULL DEFAULT 0,
                    speed TEXT DEFAULT '',
                    eta TEXT DEFAULT '',
                    status_text TEXT DEFAULT '',
                    file_path TEXT DEFAULT '',
                    file_size INTEGER DEFAULT 0,
                    log_path TEXT DEFAULT '',
                    error TEXT DEFAULT '',
                    referer TEXT DEFAULT '',
                    origin TEXT DEFAULT '',
                    cookie TEXT DEFAULT '',
                    authorization TEXT DEFAULT '',
                    user_agent TEXT DEFAULT '',
                    created_at REAL NOT NULL,
                    completed_at REAL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            """)
            # Any job left 'running' from an unexpected crash becomes 'failed'
            conn.execute(
                "UPDATE downloads SET status='failed', error='Interrupted (app closed)' WHERE status='running'"
            )
            conn.commit()
        finally:
            conn.close()


def insert_download(record: dict):
    with _LOCK:
        conn = _get_conn()
        try:
            conn.execute("""
                INSERT OR REPLACE INTO downloads (
                    job_id, name, url, stream_type, quality, audio_lang, out_format,
                    status, progress, speed, eta, status_text, file_path, file_size,
                    log_path, error, referer, origin, cookie, authorization, user_agent,
                    created_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                record['job_id'],
                record.get('name', 'video'),
                record['url'],
                record.get('stream_type', 'MP4'),
                record.get('quality') or '',
                record.get('audio_lang') or '',
                record.get('out_format', 'mp4'),
                record.get('status', 'running'),
                int(record.get('progress', 0)),
                record.get('speed', ''),
                record.get('eta', ''),
                record.get('status_text', ''),
                record.get('file_path', ''),
                int(record.get('file_size', 0)),
                record.get('log_path', ''),
                record.get('error', ''),
                record.get('referer', ''),
                record.get('origin', ''),
                record.get('cookie', ''),
                record.get('authorization', ''),
                record.get('user_agent', ''),
                float(record.get('created_at', time.time())),
                float(record.get('completed_at', 0)),
            ))
            conn.commit()
        finally:
            conn.close()


ALLOWED_UPDATE_COLS = {
    'name', 'url', 'stream_type', 'quality', 'audio_lang', 'out_format',
    'status', 'progress', 'speed', 'eta', 'status_text', 'file_path',
    'file_size', 'log_path', 'error', 'completed_at',
}


def update_download(job_id: str, **fields):
    if not fields:
        return
    safe_fields = {k: v for k, v in fields.items() if k in ALLOWED_UPDATE_COLS}
    if not safe_fields:
        return
    cols = ', '.join(f'{k}=?' for k in safe_fields)
    vals = list(safe_fields.values()) + [job_id]
    with _LOCK:
        conn = _get_conn()
        try:
            conn.execute(f'UPDATE downloads SET {cols} WHERE job_id=?', vals)
            conn.commit()
        finally:
            conn.close()


def delete_download(job_id: str):
    with _LOCK:
        conn = _get_conn()
        try:
            conn.execute('DELETE FROM downloads WHERE job_id=?', (job_id,))
            conn.commit()
        finally:
            conn.close()


def clear_finished():
    with _LOCK:
        conn = _get_conn()
        try:
            conn.execute("DELETE FROM downloads WHERE status IN ('completed', 'failed')")
            conn.commit()
        finally:
            conn.close()


def list_downloads() -> list:
    with _LOCK:
        conn = _get_conn()
        try:
            rows = conn.execute('SELECT * FROM downloads ORDER BY created_at DESC').fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def get_download(job_id: str):
    with _LOCK:
        conn = _get_conn()
        try:
            row = conn.execute('SELECT * FROM downloads WHERE job_id=?', (job_id,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def get_settings() -> dict:
    result = dict(DEFAULT_SETTINGS)
    with _LOCK:
        conn = _get_conn()
        try:
            rows = conn.execute('SELECT key, value FROM settings').fetchall()
            for r in rows:
                try:
                    result[r['key']] = json.loads(r['value'])
                except Exception:
                    result[r['key']] = r['value']
        finally:
            conn.close()
    return result


def save_settings(updates: dict) -> dict:
    with _LOCK:
        conn = _get_conn()
        try:
            for k, v in updates.items():
                conn.execute(
                    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                    (k, json.dumps(v))
                )
            conn.commit()
        finally:
            conn.close()
    return get_settings()
