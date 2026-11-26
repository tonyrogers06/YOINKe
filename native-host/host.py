"""
VideoGrabber — Native Messaging Host Entry Point
Forwards download jobs from Chrome to the persistent VideoGrabber Desktop App
(gui_app.py), launching it automatically if it isn't running yet.
"""

import sys
import json
import struct
import logging
import os
import socket
import subprocess
import time
import traceback

logging.basicConfig(
    stream=sys.stderr,
    level=logging.DEBUG,
    format='[VideoGrabber] %(levelname)s %(message)s'
)
log = logging.getLogger('videograbber')

HOST_DIR = os.path.dirname(os.path.abspath(__file__))
APP_HOST = '127.0.0.1'
APP_PORT = 47892


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    if msg_len == 0:
        return None
    raw_msg = sys.stdin.buffer.read(msg_len)
    return json.loads(raw_msg.decode('utf-8'))


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def is_app_running():
    try:
        with socket.create_connection((APP_HOST, APP_PORT), timeout=0.4):
            return True
    except OSError:
        return False


def ensure_gui_app():
    if is_app_running():
        return

    gui_script = os.path.join(HOST_DIR, 'gui_app.py')
    python_dir = os.path.dirname(sys.executable)
    pythonw = os.path.join(python_dir, 'pythonw.exe')
    exe = pythonw if os.path.isfile(pythonw) else sys.executable

    creation_flags = 0
    if sys.platform == 'win32':
        creation_flags = (
            subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.DETACHED_PROCESS
            | getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        )

    subprocess.Popen(
        [exe, gui_script],
        cwd=HOST_DIR,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags,
        start_new_session=(sys.platform != 'win32'),
        close_fds=True,
    )

    # Wait up to 5 seconds for GUI TCP server to bind
    for _ in range(25):
        if is_app_running():
            return
        time.sleep(0.2)

    raise RuntimeError('VideoGrabber Desktop App failed to start in time.')


def send_to_gui_app(msg):
    ensure_gui_app()
    payload = (json.dumps(msg, ensure_ascii=False) + '\n').encode('utf-8')
    with socket.create_connection((APP_HOST, APP_PORT), timeout=5) as sock:
        sock.sendall(payload)
        sock.recv(1024)


def main():
    msg = read_message()
    if not msg:
        sys.exit(1)

    if msg.get('type') == 'TEST' or msg.get('action') == 'test':
        send_message({'type': 'TEST_OK', 'message': 'VideoGrabber native host is running!'})
        return

    try:
        send_to_gui_app(msg)
        send_message({
            'type': 'SENT_TO_APP',
            'message': 'Sent to VideoGrabber Desktop App',
        })
    except Exception as exc:
        log.error(f'Failed to forward job: {exc}')
        log.debug(traceback.format_exc())
        send_message({'type': 'ERROR', 'message': str(exc)})
        sys.exit(1)


if __name__ == '__main__':
    main()
