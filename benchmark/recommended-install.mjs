// Settings' production recommended-install path, with deterministic publisher bytes.
// Usage: HACHIDORI_CHROME=... HACHIDORI_PUPPETEER=... node benchmark/recommended-install.mjs /base/repo /changed/repo
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RECOMMENDED_DICTIONARIES } from "../extension/recommended-dictionaries.js";
import { buildRecommendedZip } from "../test/make-fixture.mjs";

const puppeteer = await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href);
const roots = process.argv.slice(2);
if (roots.length === 0) roots.push(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const titles = { jitendex: "Jitendex.org [2026-08-11]", jmnedict: "JMnedict [2026-09-04]", jiten: "Jiten" };
const archives = new Map(RECOMMENDED_DICTIONARIES.map(entry => [entry.downloadUrl,
  buildRecommendedZip({ ...entry, title: titles[entry.sourceId] ?? entry.name, revision: "benchmark-1",
    capabilities: [entry.requiredCapability], paddingBytes: 1024 * 1024 })]));
console.log(JSON.stringify({ node: process.version, platform: platform(), arch: arch(),
  archives: [...archives].map(([url, bytes]) => ({ url, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") })) }));

async function sample(root, iteration) {
  const extension = resolve(root, "extension");
  const profile = mkdtempSync(resolve(tmpdir(), "hachidori-recommended-bench-"));
  const requests = [];
  const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME,
    enableExtensions: true, headless: true, userDataDir: profile,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"] });
  try {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker"
      && target.url().startsWith("chrome-extension://"));
    const id = new URL(worker.url()).host;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${id}/settings.html#add-dictionaries`);
    await page.bringToFront();
    await page.waitForFunction(async () => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return reply.ok && reply.ready && !reply.loading;
    });
    const offscreen = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
    for (const target of [page.target(), offscreen]) {
      const cdp = await target.createCDPSession();
      cdp.on("Fetch.requestPaused", async event => {
        const body = archives.get(event.request.url);
        requests.push(event.request.url);
        await cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/zip" },
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
            { name: "Content-Length", value: String(body.length) }], body: body.toString("base64") });
      });
      await cdp.send("Fetch.enable", { patterns: [...archives.keys()].map(urlPattern => ({ urlPattern })) });
    }
    const result = await page.evaluate(async count => {
      const start = performance.now();
      const status = document.getElementById("import-state");
      const duration = new Promise(resolveDone => {
        const observer = new MutationObserver(() => {
          if (status.textContent.startsWith(`Finished ${count} of ${count} recommended dictionaries`)) {
            observer.disconnect();
            resolveDone(performance.now() - start);
          }
        });
        observer.observe(status, { childList: true, subtree: true, characterData: true });
      });
      document.getElementById("install-recommended").click();
      const ms = await duration;
      const stored = await chrome.storage.local.get("dictionaryState");
      const engine = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      const lookup = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup",
        text: "辞書", maxResults: 32, scanLength: 16, options: {} });
      return { ms, status: status.textContent, dictionaries: stored.dictionaryState.dictionaries.length, engine, lookup };
    }, archives.size);
    assert.match(result.status, /0 failed\.$/u);
    assert.equal(result.dictionaries, archives.size);
    assert.equal(result.engine.storageBackend, "opfs");
    assert.equal(result.engine.threaded, true);
    assert.equal(result.lookup.ok, true);
    assert.ok(JSON.stringify(result.lookup).includes("term fixture"));
    assert.deepEqual(requests, [...archives.keys()]);
    console.log(JSON.stringify({ root, iteration, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      chrome: await browser.version(), milliseconds: result.ms, dictionaries: result.dictionaries, requests: requests.length }));
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
for (let iteration = 1; iteration <= 3; iteration++) {
  for (const root of iteration % 2 ? roots : [...roots].reverse()) await sample(root, iteration);
}
