#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Optional check that the Hachidori Relay add-on starts inside the installed Anki.

Run with the Python interpreter that can import the installed anki and aqt:
  python3 test/anki-relay-desktop.py

Every run creates a fresh temporary Anki base with only this add-on installed,
starts a separate Anki instance on it, and connects to the relay over a raw
loopback WebSocket with an extension Origin and then with a web Origin. The
live Anki profile, its add-ons and AnkiConnect are never opened.
"""
import argparse
import base64
import json
import os
import shutil
import socket
import tempfile
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=18772, help='a test-only port keeps a running relay out of the way')
args = parser.parse_args()

root = Path(__file__).resolve().parents[1]
base = Path(tempfile.mkdtemp(prefix='hachidori-anki-relay-'))
addon = base / 'addons21' / 'hachidori-relay'
shutil.copytree(root / 'extension' / 'anki-relay', addon, ignore=shutil.ignore_patterns('__pycache__'))
# Anki keeps a user's settings next to the add-on; this is what Tools → Add-ons → Config writes.
(addon / 'meta.json').write_text(json.dumps({'config': {'port': args.port}}))
os.environ.update(
    ANKI_SINGLE_INSTANCE_KEY=base.name,
    QT_QPA_PLATFORM='offscreen',
    QTWEBENGINE_CHROMIUM_FLAGS='--disable-gpu --disable-dev-shm-usage',
    ANKI_SOFTWAREOPENGL='1',
)


def handshake(path, origin):
    """Opens a WebSocket to the relay; returns the socket, the HTTP status and the bytes after the head."""
    sock = socket.create_connection(('127.0.0.1', args.port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode('ascii')
    sock.sendall((
        f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{args.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n'
    ).encode('ascii'))
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = sock.recv(65536)
        if not chunk:
            break
        data += chunk
    head, _, rest = data.partition(b'\r\n\r\n')
    return sock, int(head.split(b' ')[1]), rest


def first_text_frame(sock, data):
    """The small unmasked text frame the relay sends first."""
    while len(data) < 2 or len(data) < 2 + (data[1] & 0x7F):
        data += sock.recv(65536)
    if data[0] & 0x0F != 0x1:
        raise ValueError(f'expected a text frame, got {data[:2]!r}')
    return json.loads(data[2:2 + (data[1] & 0x7F)])


result = {'base': str(base), 'port': args.port, 'errors': []}


def check():
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                host, status, rest = handshake('/host', 'chrome-extension://hachidorirelaycheck')
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.2)
        result['hostStatus'] = status
        result['listening'] = first_text_frame(host, rest)
        page, result['pageStatus'], _ = handshake('/host', 'https://example.com')
        page.close()
        host.close()
    except Exception as error:  # reported below; Anki must still quit
        result['errors'].append(repr(error))
    app.quit()


try:
    import anki
    import aqt
    from aqt.profiles import ProfileManager
    from aqt.qt import QTimer

    anki.lang.set_lang('en_US')
    pm = ProfileManager(str(base))
    pm.setupMeta()
    pm.create('Relay check')
    pm.load('Relay check')
    pm.profile['autoSync'] = False
    pm.meta.update(defaultLang='en_US', firstRun=False, updates=False, suppressUpdate=True)
    pm.save()
    pm.db.close()
    result['anki'] = anki.version
    app = aqt._run(['anki', '-b', str(base), '-p', 'Relay check'], exec=False)
    QTimer.singleShot(0, check)
    app.exec()
finally:
    shutil.rmtree(base, ignore_errors=True)

result['success'] = (
    not result['errors']
    and result.get('hostStatus') == 101
    and result.get('listening') == {'kind': 'listening', 'port': args.port}
    and result.get('pageStatus') == 403
)
print(json.dumps(result, indent=2), flush=True)
# Qt's teardown of a never-unloaded Anki crashes on exit; it is not what this check measures.
os._exit(0 if result['success'] else 1)
