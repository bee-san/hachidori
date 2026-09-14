// Compare overlay option-save round trips through a real host and the released relay.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startAnkiRelayServer } from "../test/anki-relay-server.mjs";
import { summarizeValues } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const archive = process.env.HACHIDORI_ANKI_ADDON;
const puppeteer = await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href);
const roots = process.argv.slice(2);
if (roots.length === 0) roots.push(ROOT);
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
console.log(JSON.stringify({ node: process.version, fixtureSha256: sha256(FIXTURE), relaySha256: sha256(archive) }));

function launch(extension, profile) {
  return puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
    enableExtensions: true, userDataDir: profile, args: [`--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`, "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"] });
}
function request(page, target, type, fields = {}) {
  return page.evaluate(message => chrome.runtime.sendMessage(message), { target, type, ...fields });
}
async function settings(browser) {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"));
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/settings.html#add-dictionaries`);
  await page.bringToFront();
  await page.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  });
  return page;
}
async function write(page, options) {
  const current = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const reply = await request(page, "hoshidicts-worker", "hd_options_write", { options, baseRevision: current.revision });
  assert.equal(reply.ok, true, reply.error);
}
async function sample(root, iteration) {
  const directory = mkdtempSync(resolve(tmpdir(), "hachidori-overlay-options-"));
  const extension = resolve(root, "extension");
  const overlay = resolve(directory, "overlay");
  cpSync(extension, overlay, { recursive: true });
  const flag = resolve(overlay, "overlay-mode.js");
  writeFileSync(flag, readFileSync(flag, "utf8").replace("OVERLAY_MODE = false;", "OVERLAY_MODE = true;"));
  const relay = await startAnkiRelayServer({ archive });
  let host, client;
  try {
    host = await launch(extension, resolve(directory, "host"));
    const hostPage = await settings(host);
    assert.equal((await request(hostPage, "hachidori-sharing", "hd_sharing_host_enable", { port: relay.port })).ok, true);
    await (await hostPage.$("#import-file")).uploadFile(FIXTURE);
    await hostPage.waitForFunction(() => document.getElementById("import-state").textContent
      === "Finished 1 of 1 archive — 1 imported, 0 failed.");
    await write(hostPage, { popupWidthPx: 1000 });
    client = await launch(overlay, resolve(directory, "client"));
    const page = await settings(client);
    await write(page, { popupWidthPx: 440 });
    assert.equal((await request(page, "hachidori-sharing", "hd_sharing_client_link", {
      address: `127.0.0.1:${relay.port}`,
    })).ok, true);
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: "hachidori-sharing", type: "hd_sharing_status" })).sharing.client.connected);
    const hostBefore = await hostPage.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    const values = await page.evaluate(async () => {
      let revision = (await chrome.storage.local.get("options")).options.revision;
      const durations = [];
      // Ten excluded warmups and thirty measured edits, on the page's clock.
      for (let index = 0; index < 40; index++) {
        const width = index % 2 ? 520 : 480;
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
          baseRevision: revision, options: { popupWidthPx: width } });
        const milliseconds = performance.now() - started;
        if (!reply.ok || reply.options.popupWidthPx !== width) throw new Error(JSON.stringify(reply));
        revision = reply.options.revision;
        if (index >= 10) durations.push(milliseconds);
      }
      return durations;
    });
    const hostAfter = await hostPage.evaluate(async () => (await chrome.storage.local.get("options")).options);
    const lookup = await request(page, "hoshidicts-offscreen", "hd_lookup", { text: "食べる" });
    assert.equal(lookup.ok, true, lookup.error);
    assert.ok(lookup.results.length > 0);
    console.log(JSON.stringify({ root, iteration, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      chrome: await host.version(), milliseconds: summarizeValues(values), samples: values,
      hostOptionWrites: hostAfter.revision - hostBefore, hostWidth: hostAfter.popupWidthPx }));
  } finally {
    await client?.close();
    await host?.close();
    await relay.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
for (let iteration = 1; iteration <= 3; iteration++) {
  for (const root of iteration % 2 ? roots : [...roots].reverse()) await sample(root, iteration);
}
