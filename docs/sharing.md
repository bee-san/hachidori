<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Sharing

Sharing lets one Hachidori serve every browser on the same computer. The
browser install that holds your dictionaries is the **host**; another install,
such as the copy inside the [GameSentenceMiner](https://github.com/bpwhelan/GameSentenceMiner)
overlay, **links** to it and uses the host's dictionaries, personal entries,
lookup counts and settings instead of its own. Nothing is copied: a linked
browser sends its lookups and its edits to the host and mirrors what the host
stores.

## How it works

A Chrome extension cannot listen for connections, so neither install can talk
to the other directly. Something else on the computer has to: a small
**relay** on `127.0.0.1:8771` that both Hachidoris connect out to. The host
connects to `/host`, linked browsers connect to `/link`, and the relay forwards
frames between them without understanding them. GameSentenceMiner's overlay
process runs the relay, so with GameSentenceMiner there is nothing to install;
without it, the [Hachidori Relay add-on for Anki](#sharing-through-anki) runs
the same relay for as long as Anki is open. No permission is requested; sharing
simply waits while neither is running and resumes when one starts. The relay
accepts only connections whose `Origin` is a browser extension, so ordinary
web pages cannot reach it; there is no password or token, because the address
never leaves your computer. Another extension or program on the same computer
could connect while a relay runs, as it could to AnkiConnect.

## Sharing this Hachidori

A browser install shares by default. **Settings → Sharing** shows the state:
*Sharing is on. Waiting for GameSentenceMiner or the Anki add-on to start*
until a relay is there, then *Sharing through GameSentenceMiner on port 8771*
or *Sharing through Anki on port 8771* with the linked browsers named as they
connect. Turn **Share this Hachidori** off if you use neither. Change the port
only if you changed it in GameSentenceMiner or the add-on too; the address next
to it is what a linked browser needs when the port is not the default.

Sharing survives browser restarts, and a watchdog alarm reconnects within a
minute if a relay starts while Chrome is idle; a lookup in Chrome reconnects
immediately.

## Sharing through Anki

Without GameSentenceMiner, the **Hachidori Relay** add-on runs the relay inside
Anki. It is the `anki-relay/` folder of this repository: a few hundred lines
of Python with nothing beyond Anki's own runtime, and its only setting is the
port.

Install it once, the way AnkiConnect is installed: in Anki open **Tools →
Add-ons → Install from file…**, choose `hachidori-relay.ankiaddon` and restart
Anki. To build that file from a checkout:

```sh
cd anki-relay && zip -X ../hachidori-relay.ankiaddon manifest.json __init__.py server.py config.json config.md
```

From then on the relay listens whenever Anki is open, and sharing in every
Hachidori on the computer waits while Anki is closed. If you changed the port
under **Settings → Sharing**, set the same port under **Tools → Add-ons →
Hachidori Relay → Config** and restart Anki.

The add-on and GameSentenceMiner can both be installed. Whichever starts first
holds the port; the add-on keeps trying every ten seconds while
GameSentenceMiner has it, and the host and its linked browsers reconnect to
whichever relay is there, so switching between them needs nothing from you.
The Sharing section names the relay in use.

![Settings → Sharing on the host, sharing through Anki on port 8771](assets/sharing-settings.png)

## Using another Hachidori

In the browser that should use the shared Hachidori, open **Settings → Sharing**
and press **Find on this computer**. It reports what answers on the default
port, for example *Found Hachidori 0.1.0 with 5 dictionaries at
ws://127.0.0.1:8771/link*, and **Use it** links to it. When the relay is on
another port, type the address and press **Link** instead. The page
reloads, and from then on:

- lookups, media, engine status, Note appends, settings edits, dictionary
  presentation edits, update checks and installs, recommended-dictionary
  installs and removals go to the host, which commits them through its
  ordinary revisioned transactions and pushes the resulting storage batches back;
- the host's dictionary state, settings, personal dictionary source, update
  schedules and lookup counts are mirrored into this browser's storage, so the
  popup, Settings and toolbar read exactly what they read before;
- this browser's own dictionary state, settings, personal source, update
  schedule and lookup counts are kept aside untouched, and its engine keeps
  reading and committing them, so no local dictionary file is ever removed;
- the Import and Backup sections show that archives and backups belong to the
  host; recommended dictionaries can still be installed from here.

**Unlink** brings the kept state back with revisions above the mirror's, so
every open page adopts it, and removes the host's lookup-count rows. Pages open
in the linked browser before linking keep their previous reader options until
they reload; their lookups go to the host straight away.

![Settings → Sharing on a linked browser, using the shared Hachidori](assets/sharing-linked.png)

The host must be running for a linked browser to look anything up: when it is
closed, lookups fail with *The linked Hachidori is not reachable* and the
Sharing section says so; the linked browser reconnects by itself once the host
is back. The GameSentenceMiner overlay gains this client side when it updates
its vendored Hachidori commit; its Electron runtime needs nothing beyond the
WebSocket.

## What the host shares

- lookups, media, styles and engine status;
- reader and Design settings, dictionary state, groups, aliases and order, the
  personal dictionary source, update schedules and lookup counts, pushed to
  every linked browser as the same storage batches the host writes;
- Note appends, settings and presentation edits, update checks and installs,
  recommended-dictionary installs and removals made in a linked browser, which
  the host commits through its ordinary revisioned transactions.

Local-file imports and backups happen on the host. Pronunciation, Anki mining,
capture and external links run in each browser with the shared settings.

## For relay implementers

`extension/sharing-relay.js` is the relay's whole logic and is vendored into
GameSentenceMiner with the rest of the extension: `connectHost` and
`connectClient` return the handlers for a socket, or `null` when a second host
or a client without a host must be refused, and `ping` keeps the browsers'
service workers awake. `listening` names the relay (`GameSentenceMiner` or
`Anki`) so the host's Settings can say which one carries the link.
`anki-relay/server.py` is the same logic in Python with its own loopback
WebSocket server, and `test/sharing-relay-server.mjs` wraps the JavaScript in
a plain Node WebSocket server for the tests; both answer one contract test. A
relay that finds the port taken should keep trying, as the add-on does, so
that the two can be installed side by side.

## Tests

`node --test test/sharing-protocol.test.mjs test/sharing-relay.test.mjs`
checks the wire contract and drives both relays, the test relay server and the
Anki add-on's `server.py` as a `python3` process, over raw loopback
WebSockets: the `Origin` rule, clients refused without a host, a second host
turned away, whole-frame relaying in both directions, broadcast, pings, closes
and host loss. With Anki installed, `python3 test/anki-relay-desktop.py` starts
a separate Anki on a temporary base with only the add-on installed and checks
that it answers on the configured port with an extension `Origin` and refuses
a web page. `node --test test/sharing-settings.test.mjs` covers the Settings
card with jsdom. The extension smoke suite's sharing-host and sharing-client
stages cover the service worker's side against fake sockets, including a linked
install's kept state. `node test/chrome-sharing.mjs` runs two real Chromes with
the test relay, or with the add-on's relay when `HACHIDORI_SHARING_RELAY=anki`
is set: the host imports a fixture and shares it, the second browser
probes and links to it, looks a word up through it, edits a shared setting and
saves a personal entry that the host commits and pushes back, survives the
host closing and relaunching, and unlinks back to its own state.
