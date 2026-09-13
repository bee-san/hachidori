<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Sharing

Sharing lets one Hachidori serve every browser on the same computer. The Chrome
install that holds your dictionaries becomes the **host**; another install,
such as the copy inside the [GameSentenceMiner](https://github.com/bpwhelan/GameSentenceMiner)
overlay or a second Chrome profile, **links** to it and uses the host's
dictionaries, personal entries, lookup counts and settings instead of its own.
Nothing is copied: a linked browser sends its lookups and its edits to the host
and mirrors what the host stores.

## How it works

A Chrome extension cannot listen for connections, so the host starts a small
helper, the **bridge**, through Chrome's native messaging API. The bridge is
`bridge/hachidori-bridge.mjs`, a Node.js script without dependencies that owns
one loopback WebSocket listener, `ws://127.0.0.1:8771/link` by default, and
forwards frames between the host and each linked browser. Chrome starts it when
you turn sharing on and stops it when you turn sharing off or close the browser.

The bridge accepts only connections whose `Origin` is a browser extension, so
ordinary web pages cannot reach it. There is no password or token: the address
never leaves your computer. Another extension or program on the same computer
could connect while sharing is on, as it could to AnkiConnect.

## Sharing this Hachidori

1. Install the bridge once. In a terminal, from the Hachidori checkout:

   ```sh
   node bridge/install.mjs --extension-id <id>
   ```

   **Settings → Sharing** shows this command with the install's own ID. Add
   `--browser chromium` for Chromium or `--browser chrome-for-testing` for
   Chrome for Testing, and `--user-data-dir <dir>` when the browser runs on a
   custom profile directory (`chrome://version` shows it as the profile path,
   without the trailing profile name). The installer writes a launcher next to
   the bridge and a native messaging manifest into the profile's
   `NativeMessagingHosts` directory, or the registry on Windows. `--uninstall`
   removes both again.
2. In **Settings → Sharing**, turn on **Share this Hachidori**. Chrome asks for
   the native messaging permission the first time. The status line reports
   **Sharing on port 8771** once the bridge listens and names linked browsers
   as they connect.

If the status says the bridge is not running, the reason is Chrome's own:
*Specified native messaging host not found* means the manifest is not installed
for this browser or profile; *Native host has exited* means the launcher could
not start Node.js. Fix the installation and turn the switch on again. Change
the port only when another program already uses it; the address next to it is
what a linked browser needs when the port is not the default.

Sharing survives browser restarts, and a watchdog alarm reconnects the bridge
within a minute if it ever stops.

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

## Tests

`node --test test/sharing-protocol.test.mjs test/bridge.test.mjs` checks the
wire contract and drives the real bridge process: listening, the `Origin` rule,
splitting large frames into native messages, pings, closes and exit. The
extension smoke suite's sharing-host stage covers turning sharing on, answering
a linked browser's hello, forwarding a lookup and an options write, the storage
broadcast, a lost bridge and a worker restart. `node --test
test/sharing-settings.test.mjs` covers the Settings card, and
`node test/chrome-e2e.mjs` checks the manifest permission and the inactive
status in a real Chrome.
