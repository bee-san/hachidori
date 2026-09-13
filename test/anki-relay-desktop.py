#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Optional check that the Hachidori Relay add-on starts inside the installed Anki.

Run with the Python interpreter that can import the installed anki and aqt:
  python3 test/anki-relay-desktop.py

Every run creates a fresh temporary Anki base with only this add-on installed,
starts a separate Anki instance on it, and connects to the relay over raw
WebSockets: a host with an extension Origin, which then asks for the network
and sees a browser link over this computer's own network address, and a web
Origin that must be refused. The live Anki profile, its add-ons and
AnkiConnect are never opened.
"""
import argparse
import base64
import json
import os
import shutil
import socket
import tempfile
import threading
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


def handshake(path, origin, host='127.0.0.1'):
    """Opens a WebSocket to the relay; returns the socket, the HTTP status and the bytes after the head."""
    sock = socket.create_connection((host, args.port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode('ascii')
    sock.sendall((
        f'GET {path} HTTP/1.1\r\nHost: {host}:{args.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
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


def text_frame(sock, data):
    """The next unmasked text frame from the relay (up to 64 KiB), and the bytes after it."""
    def parsed():
        if len(data) < 2:
            return None
        length, start = data[1] & 0x7F, 2
        if length == 126:
            if len(data) < 4:
                return None
            length, start = int.from_bytes(data[2:4], 'big'), 4
        return None if len(data) < start + length else (start, length)
    while parsed() is None:
        data += sock.recv(65536)
    start, length = parsed()
    if data[0] & 0x0F != 0x1:
        raise ValueError(f'expected a text frame, got {data[:2]!r}')
    return json.loads(data[start:start + length]), data[start + length:]


def send_text(sock, text):
    """One masked text frame, as a browser sends it."""
    payload = text.encode('utf-8')
    mask = os.urandom(4)
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    sock.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + masked)


result = {'base': str(base), 'port': args.port, 'errors': []}


def give_up():
    # A modal dialog or a hung startup would otherwise keep this Anki alive forever.
    result['errors'].append('timed out after 90 s')
    print(json.dumps(result, indent=2), flush=True)
    os._exit(2)


threading.Timer(90, give_up).start()


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
        result['listening'], rest = text_frame(host, rest)
        send_text(host, json.dumps({'kind': 'network', 'enabled': True}))
        result['network'], rest = text_frame(host, rest)
        addresses = [entry['address'] for entry in result['network'].get('addresses', [])]
        if addresses:
            link, result['linkStatus'], _ = handshake('/link', 'chrome-extension://hachidorirelaycheck', addresses[0])
            result['clientOpen'], rest = text_frame(host, rest)
            link.close()
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
    and result.get('network', {}).get('enabled') is True
    and (not result['network'].get('addresses') or (
        result.get('linkStatus') == 101
        and result.get('clientOpen', {}).get('kind') == 'client-open'
        and result['clientOpen'].get('address') == result['network']['addresses'][0]['address']))
    and result.get('pageStatus') == 403
)
print(json.dumps(result, indent=2), flush=True)
# Qt's teardown of a never-unloaded Anki crashes on exit; it is not what this check measures.
os._exit(0 if result['success'] else 1)
