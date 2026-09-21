// SPDX-License-Identifier: GPL-3.0-or-later
//
// Low memory mode before/after: imports one archive into a fresh Chrome profile
// with the option off and on (alternating samples), and records import wall
// time, the engine heap and process-tree RSS after the import settles and, with
// the mode on, after the worker has been recycled, plus steady hd_lookup
// latency. See docs/memory.md and benchmark/README.md.
//
//   node benchmark/low-memory-mode.mjs --archive /path/to/jitendex.zip \
//     --samples 3 --output benchmark/results/low-memory-mode.json
//
// Import time is the settings-page clock from file selection until hd_status
// reports the imported package ready. Heap is hd_memory.heapBytes (WASM linear
// memory); RSS is the summed Linux RSS of Chrome's process tree sampled at that
// moment, so it includes every renderer and the browser process.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import { processTreeSample } from "./system.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EXTENSION = resolve(REPO, "extension");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");

function cachedChrome() {
  const root = resolve(CACHE, "hachidori-browsers", "chrome");
  if (!existsSync(root)) return null;
  const builds = readdirSync(root).sort().reverse();
  for (const build of builds) {
    const candidate = resolve(root, build, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const CHROME = process.env.HACHIDORI_CHROME || cachedChrome();
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const ARCHIVE = resolve(argument("archive", resolve(REPO, "test/fixtures/hachidori-fixture.zip")));
const SAMPLES = Number(argument("samples", "3"));
const OUTPUT = resolve(argument("output", resolve(REPO, "benchmark/results/low-memory-mode.json")));
const LOOKUPS = Number(argument("lookups", "200"));
const TEXT = argument("text", "食べる");

function sumRss(pid) {
  return processTreeSample(pid).rssBytes;
}

async function sample(puppeteer, lowMemoryMode, index) {
  const profile = `/tmp/hachidori-low-memory-bench-${process.pid}-${index}`;
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  try {
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30_000 });
    const extensionId = new URL(target.url()).host;
    // The first-run startup page opens itself; close it so its installer does not compete.
    for (const page of await browser.pages()) {
      if (page.url().includes("startup.html")) await page.close();
    }
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/settings.html#advanced`, { waitUntil: "domcontentloaded" });
    const engine = (type, fields = {}) => page.evaluate((type, fields) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type, requestId: `bench-${type}`, ...fields,
    }), type, fields);
    // hd_status.lowMemory names the worker that is serving.
    const waitReady = (lowMemory) => page.waitForFunction(async (expected) => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return status?.ok && status.ready && !status.loading && status.lowMemory === expected ? status : false;
    }, { timeout: 180_000, polling: 100 }, lowMemory).then((handle) => handle.jsonValue());
    await waitReady(false);
    if (lowMemoryMode) {
      const options = await page.evaluate(async () => (await chrome.storage.local.get("options")).options ?? {});
      await page.evaluate((baseRevision) => chrome.runtime.sendMessage({
        target: "hoshidicts-worker", type: "hd_options_write", requestId: "bench-options", baseRevision, options: { lowMemoryMode: true },
      }), options.revision ?? 0);
      // The worker is replaced once idle and comes back in low memory mode.
      await waitReady(true);
    }
    const beforeImport = await engine("hd_memory");
    const archive = readFileSync(ARCHIVE);
    const importStarted = performance.now();
    await page.evaluate((base64, name) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: "application/zip" }));
      const input = document.getElementById("import-file");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, archive.toString("base64"), "benchmark.zip");
    const imported = await page.waitForFunction(async () => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return dictionaryState?.dictionaries?.length === 1 && status?.ok && status.ready && !status.loading
        && status.dictionaryCount > 0 ? status : false;
    }, { timeout: 600_000, polling: 100 }).then((handle) => handle.jsonValue());
    const importMs = performance.now() - importStarted;
    const afterImport = await engine("hd_memory");
    const rssAfterImport = sumRss(browser.process().pid);
    let recycle = null;
    if (lowMemoryMode) {
      const recycleStarted = performance.now();
      const recycled = await page.waitForFunction(async (previous) => {
        const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
        return status?.ok && status.ready && !status.loading && status.generation < previous ? status : false;
      }, { timeout: 60_000, polling: 100 }, imported.generation).then((handle) => handle.jsonValue());
      const memory = await engine("hd_memory");
      recycle = { recycleMs: performance.now() - recycleStarted, heapBytes: memory.heapBytes, rssBytes: sumRss(browser.process().pid),
        dictionaryCount: recycled.dictionaryCount };
    }
    // Steady lookups: one warm-up, then LOOKUPS timed round trips from the page.
    await engine("hd_lookup", { text: TEXT });
    const latencies = await page.evaluate(async (text, count) => {
      const out = [];
      for (let i = 0; i < count; i += 1) {
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: `bench-lookup-${i}`, text });
        if (!reply?.ok || !reply.results?.length) throw new Error(`lookup ${i} failed: ${JSON.stringify(reply)}`);
        out.push(performance.now() - started);
      }
      return out;
    }, TEXT, LOOKUPS);
    latencies.sort((a, b) => a - b);
    const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
    return {
      lowMemoryMode, threaded: imported.threaded, storageBackend: imported.storageBackend,
      heapBeforeImport: beforeImport.heapBytes, importMs, heapAfterImport: afterImport.heapBytes, rssAfterImport,
      mappedBytes: afterImport.dictionaries.reduce((sum, entry) => sum + entry.bytes, 0),
      recycle, lookupMedianMs: percentile(0.5), lookupP95Ms: percentile(0.95), lookups: LOOKUPS,
    };
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const mb = (bytes) => `${(bytes / 1_048_576).toFixed(0)} MB`;

async function main() {
  if (!CHROME || !existsSync(CHROME)) throw new Error("no Chrome found (HACHIDORI_CHROME)");
  if (!existsSync(PUPPETEER)) throw new Error(`no puppeteer-core at ${PUPPETEER}`);
  if (!existsSync(ARCHIVE)) throw new Error(`no archive at ${ARCHIVE}`);
  const puppeteerModule = await import(pathToFileURL(PUPPETEER).href);
  const puppeteer = puppeteerModule.default?.launch ? puppeteerModule.default : puppeteerModule;
  const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const chromeVersion = execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim();
  const rows = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    for (const lowMemoryMode of [false, true]) {
      const row = await sample(puppeteer, lowMemoryMode, rows.length);
      rows.push(row);
      console.log(`${lowMemoryMode ? "on " : "off"} #${index + 1}: import ${row.importMs.toFixed(0)} ms; heap ${mb(row.heapAfterImport)}`
        + ` rss ${mb(row.rssAfterImport)} after import${row.recycle ? `; heap ${mb(row.recycle.heapBytes)} rss ${mb(row.recycle.rssBytes)}`
          + ` ${row.recycle.recycleMs.toFixed(0)} ms after recycle` : ""}; lookup p50 ${row.lookupMedianMs.toFixed(2)} ms p95 ${row.lookupP95Ms.toFixed(2)} ms`);
    }
  }
  const result = { revision, chromeVersion, node: process.version, archive: ARCHIVE, archiveBytes: readFileSync(ARCHIVE).byteLength,
    samples: SAMPLES, lookups: LOOKUPS, text: TEXT, recordedAt: new Date().toISOString(), rows };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nwrote ${OUTPUT}`);
}

await main();
