/*
 * Sharing from Firefox: Settings downloads the pinned Hachidori Relay, the
 * relay runs from that archive, this Firefox shares through it, and a second
 * Firefox links to it and looks words up with its dictionaries.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./backup.mjs";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe } from "node:test";
import { ANKI_ADDON_FILE_NAME, ANKI_ADDON_VERSION } from "../../extension/anki-addon.js";
import { startAnkiRelayServer } from "../anki-relay-server.mjs";
import { check, step } from "./harness.mjs";
import {
  activate, downloadedFiles, downloadsDirectory, hoverForPopup, installHachidori, launchFirefox, openExtensionPage,
  openPage, page, sendRuntime, serverUrl, showSettingsSection, sleep, waitFor,
} from "./session.mjs";

const sharing = (target, type, fields = {}) => sendRuntime(target, { target: "hachidori-sharing", type,
  requestId: `${type}-${Date.now()}`, ...fields });

describe("sharing", () => {
  step("sharing through the relay", async () => {
    await activate(page);
    await showSettingsSection(page, "sharing");
    const existing = new Set(downloadedFiles());
    await waitFor(() => page.evaluate(() => document.getElementById("sharing-addon")?.hidden === false
      && !document.getElementById("sharing-addon-download").disabled || false), { timeout: 15_000 });
    await page.evaluate(() => document.getElementById("sharing-addon-download").click());
    const file = await waitFor(async () => {
      const name = downloadedFiles().find(entry => !existing.has(entry) && entry.startsWith(ANKI_ADDON_FILE_NAME.replace(".ankiaddon", "")));
      if (!name) return false;
      const path = resolve(downloadsDirectory(), name);
      const size = statSync(path).size;
      await sleep(300);
      return size > 1000 && size === statSync(path).size ? path : false;
    }, { timeout: 60_000 });
    const status = await page.evaluate(() => document.getElementById("sharing-status")?.textContent ?? "");
    // The archive is a ZIP whose manifest names the pinned version.
    const bytes = file ? readFileSync(file) : Buffer.alloc(0);
    check("Settings downloads the pinned Hachidori Relay add-on",
      bytes.subarray(0, 4).toString("latin1") === "PK\u0003\u0004" && bytes.includes(Buffer.from(`"human_version": "${ANKI_ADDON_VERSION}"`))
        && status.startsWith("Saved hachidori-relay.ankiaddon"),
      JSON.stringify({ file, size: bytes.length, status }));

    let relay = null;
    let client = null;
    try {
      relay = await startAnkiRelayServer({ archive: file, port: 0, serverPath: process.env.HACHIDORI_RELAY_SERVER });
      const enabled = await sharing(page, "hd_sharing_host_enable", { port: relay.port });
      const hosting = await waitFor(async () => {
        const current = (await sharing(page, "hd_sharing_status")).sharing;
        return current?.connected ? current : false;
      }, { timeout: 30_000 });
      const statusText = await waitFor(() => page.evaluate(() => {
        const text = document.getElementById("sharing-status")?.textContent ?? "";
        return text === "Sharing through Anki." ? text : false;
      }), { timeout: 15_000 });
      check("the Firefox Hachidori shares through the relay",
        enabled?.ok === true && hosting?.port === relay.port && hosting.dictionaries > 0 && statusText !== null,
        JSON.stringify({ enabled, hosting, statusText }));

      // A second Firefox with no dictionaries of its own links to this one.
      client = await launchFirefox(resolve(tmpdir(), `hachidori-firefox-client-${process.pid}`));
      await installHachidori(client.browser);
      const settings = await openExtensionPage("settings.html", client.browser);
      await waitFor(async () => (await sendRuntime(settings, { target: "hoshidicts-offscreen", type: "hd_status",
        requestId: "client-status" }))?.ready || false, { timeout: 60_000 });
      const linked = await sharing(settings, "hd_sharing_client_link", { address: `127.0.0.1:${relay.port}` });
      const connected = await waitFor(async () => {
        const current = (await sharing(settings, "hd_sharing_status")).sharing;
        return current?.client?.connected ? current.client : false;
      }, { timeout: 30_000 });
      const hostClients = await waitFor(async () => {
        const current = (await sharing(page, "hd_sharing_status")).sharing;
        return current?.clients?.some(entry => entry.origin?.startsWith("moz-extension://")) ? current.clients : false;
      }, { timeout: 15_000 });
      const reader = await openPage(`${serverUrl}/?linked`, client.browser);
      const shown = await hoverForPopup(reader, "#verb");
      check("a second Firefox links to it and looks up words with its dictionaries",
        linked?.ok === true && connected !== null && hostClients !== null && shown?.headword === "食べる"
          && shown.plain.includes("to eat"),
        JSON.stringify({ linked, connected, hostClients, shown: shown?.plain?.slice(0, 120) }));
    } finally {
      await client?.browser.close().catch(() => {});
      await relay?.close();
    }
  });
});
