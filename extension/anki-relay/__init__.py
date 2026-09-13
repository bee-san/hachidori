# SPDX-License-Identifier: GPL-3.0-or-later
"""Hachidori Relay, the Anki add-on.

Keeps server.py listening for as long as Anki runs, so the Hachidori installs
on this computer can share one library. The port is the add-on's only setting;
see config.md.
"""
import threading
import time

from aqt import mw

from .server import serve

RETRY_SECONDS = 10


def run(port):
    # Another program may hold the port for a while; keep trying. Nothing goes to
    # stderr, which Anki shows as an error.
    while True:
        try:
            serve(port)
        except OSError:
            time.sleep(RETRY_SECONDS)


threading.Thread(target=run, args=(int(mw.addonManager.getConfig(__name__)["port"]),), name="hachidori-relay", daemon=True).start()
