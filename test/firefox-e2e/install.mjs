/*
 * Installing the Firefox build: Firefox accepts it, runs background.js in its
 * background page with the engine, and opens first-run setup once.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { check, step } from "./harness.mjs";
import { engineStatus, extensionUrl, GECKO_ID, page, sleep, startSession, tabUrls, waitFor } from "./session.mjs";

describe("session", () => {
  step("Firefox loads the Firefox build", async () => {
    const installedId = await startSession();
    check("Firefox installs the Firefox build with its gecko ID", installedId === GECKO_ID, `installed ${installedId}`);
    const contexts = await page.evaluate(async () => (await chrome.runtime.getContexts({}))
      .map(({ contextType, documentUrl, frameId }) => [contextType, documentUrl, frameId]));
    // The background page, and the engine document in its frame.
    const background = contexts.filter(([type]) => type === "BACKGROUND").map(([, url]) => url).sort();
    const status = await waitFor(async () => {
      const reply = await engineStatus(page);
      return reply?.ready ? reply : false;
    }, { timeout: 60_000 });
    const manifest = await page.evaluate(() => chrome.runtime.getManifest());
    check("the background page runs background.js and holds the engine, with no offscreen document",
      JSON.stringify(background) === JSON.stringify([extensionUrl("background.html"), extensionUrl("offscreen.html")])
        && !contexts.some(([type]) => type === "OFFSCREEN_DOCUMENT")
        && manifest.background?.page === extensionUrl("background.html") && !manifest.background.service_worker
        && status?.ok === true && status.ready === true,
      JSON.stringify({ contexts, status, background: manifest.background }));
    const isolation = await page.evaluate(() => ({ isolated: globalThis.crossOriginIsolated, shared: typeof SharedArrayBuffer }));
    check("the engine runs single-threaded on IndexedDB in Firefox",
      status?.threaded === false && status.storageBackend === "idbfs" && isolation.isolated === false,
      JSON.stringify({ status, isolation }));
    const startupPages = await waitFor(async () => {
      const urls = (await tabUrls()).filter(url => url.startsWith(extensionUrl("startup.html")));
      return urls.length > 0 ? urls : false;
    }, { timeout: 20_000 });
    await sleep(500);
    check("a first install opens one startup page",
      (await tabUrls()).filter(url => url.startsWith(extensionUrl("startup.html"))).length === 1,
      JSON.stringify({ startupPages, tabs: await tabUrls() }));
  });
});
