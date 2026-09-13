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
to the other directly. GameSentenceMiner can: its overlay process runs a small
**relay** on `127.0.0.1:8771`, and both Hachidoris connect out to it. The host
connects to `/host`, linked browsers connect to `/link`, and the relay forwards
frames between them without understanding them. Nothing is installed and no
permission is requested; sharing simply waits while GameSentenceMiner is closed
and resumes when it starts. The relay accepts only connections whose `Origin`
is a browser extension, so ordinary web pages cannot reach it; there is no
password or token, because the address never leaves your computer. Another
extension or program on the same computer could connect while GameSentenceMiner
runs, as it could to AnkiConnect.

## Sharing this Hachidori

A browser install shares by default. **Settings → Sharing** shows the state:
*Sharing is on. Waiting for GameSentenceMiner to start* until the relay is
there, then *Sharing through GameSentenceMiner on port 8771* with the linked
browsers named as they connect. Turn **Share this Hachidori** off if you do not
use GameSentenceMiner. Change the port only if you changed it in
GameSentenceMiner too; the address next to it is what a linked browser needs
when the port is not the default.

Sharing survives browser restarts, and a watchdog alarm reconnects within a
minute if GameSentenceMiner starts while Chrome is idle; a lookup in Chrome
reconnects immediately.

## Using another Hachidori

In the browser that should use the shared Hachidori, open **Settings → Sharing**
and press **Find on this computer**. It reports what answers on the default
port, for example *Found Hachidori 0.1.0 with 5 dictionaries at
ws://127.0.0.1:8771/link*, and **Use it** links to it. When GameSentenceMiner
relays on another port, type the address and press **Link** instead. The page
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
service workers awake. `test/sharing-relay-server.mjs` wraps it in a plain Node
WebSocket server for the tests.

## Tests

`node --test test/sharing-protocol.test.mjs test/sharing-relay.test.mjs`
checks the wire contract and drives the test relay server over raw loopback
WebSockets: the `Origin` rule, clients refused without a host, a second host
turned away, whole-frame relaying in both directions, broadcast, pings, closes
and host loss. `node --test test/sharing-settings.test.mjs` covers the Settings
card with jsdom. The extension smoke suite's sharing-host and sharing-client
stages cover the service worker's side against fake sockets, including a linked
install's kept state. `node test/chrome-sharing.mjs` runs two real Chromes with
the test relay: the host imports a fixture and shares it, the second browser
probes and links to it, looks a word up through it, edits a shared setting and
saves a personal entry that the host commits and pushes back, survives the
host closing and relaunching, and unlinks back to its own state.
