// SPDX-License-Identifier: GPL-3.0-or-later
//
// Low memory mode before/after: imports one or more archives into a fresh
// Chrome profile with the option off and on (alternating samples), and records
// import wall time, the engine heap and process-tree RSS after the import
// settles and, with the mode on, after the worker has been recycled, plus
// hd_lookup latency. See docs/memory.md and benchmark/README.md.
//
//   node benchmark/low-memory-mode.mjs --archive /path/to/jitendex.zip \
//     [--archive /path/to/another.zip ...] [--words words.txt] \
//     --samples 3 --output benchmark/results/low-memory-mode.json
//
// Import time is the settings-page clock from file selection until hd_status
// reports every imported package ready. Heap is hd_memory.heapBytes (WASM
// linear memory); RSS is the summed Linux RSS of Chrome's process tree sampled
// at that moment, so it includes every renderer and the browser process.
//
// Without --words, one text (--text) is looked up --lookups times after one
// warm-up. With --words (one lookup text per line), the list is looked up
// --passes times (default 2): the first pass meets an empty page cache in Low
// memory mode (and a just-started engine either way), the later ones the cache
// the earlier passes left.

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

function argumentList(name) {
  return process.argv.flatMap((value, index) => (process.argv[index - 1] === `--${name}` ? [value] : []));
}

const ARCHIVES = (argumentList("archive").length > 0
  ? argumentList("archive") : [resolve(REPO, "test/fixtures/hachidori-fixture.zip")]).map((path) => resolve(path));
const SAMPLES = Number(argument("samples", "3"));
const OUTPUT = resolve(argument("output", resolve(REPO, "benchmark/results/low-memory-mode.json")));
const LOOKUPS = Number(argument("lookups", "200"));
const TEXT = argument("text", "食べる");
const WORDS_FILE = argument("words", null);
const PASSES = Number(argument("passes", "2"));
const WORDS = WORDS_FILE === null ? null
  : readFileSync(resolve(WORDS_FILE), "utf8").split("\n").map((line) => line.trim()).filter(Boolean);

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}

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
    const input = await page.$("#import-file");
    const importStarted = performance.now();
    // Straight from disk: a library's worth of archives is too large to pass
    // through one evaluate.
    await input.uploadFile(...ARCHIVES);
    const imported = await page.waitForFunction(async (count) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return dictionaryState?.dictionaries?.length === count && status?.ok && status.ready && !status.loading
        && status.dictionaryCount > 0 ? status : false;
    }, { timeout: 600_000, polling: 100 }, ARCHIVES.length).then((handle) => handle.jsonValue());
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
    const timeLookups = (texts, prefix, requireHit) => page.evaluate(async (texts, prefix, requireHit) => {
      const out = [];
      let hits = 0;
      for (let i = 0; i < texts.length; i += 1) {
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: `${prefix}-${i}`, text: texts[i] });
        if (!reply?.ok || (requireHit && !reply.results?.length)) throw new Error(`lookup ${i} failed: ${JSON.stringify(reply)}`);
        out.push(performance.now() - started);
        if (reply.results?.length) hits += 1;
      }
      return { latencies: out, hits };
    }, texts, prefix, requireHit);
    let lookups;
    if (WORDS === null) {
      // Steady lookups: one warm-up, then LOOKUPS timed round trips from the page.
      await engine("hd_lookup", { text: TEXT });
      const steady = distribution((await timeLookups(Array(LOOKUPS).fill(TEXT), "bench-lookup", true)).latencies);
      lookups = { text: TEXT, count: LOOKUPS, medianMs: steady.p50, p95Ms: steady.p95 };
    } else {
      const passes = [];
      for (let pass = 0; pass < PASSES; pass += 1) passes.push(await timeLookups(WORDS, `bench-pass-${pass}`, false));
      const memory = await engine("hd_memory");
      lookups = {
        words: WORDS.length, hits: passes[0].hits,
        passes: passes.map((pass) => distribution(pass.latencies)),
        firstPass: distribution(passes[0].latencies), secondPass: distribution(passes.at(-1).latencies),
        heapBytes: memory.heapBytes, pageCacheBytes: memory.pageCacheBytes ?? null,
      };
    }
    return {
      lowMemoryMode, threaded: imported.threaded, storageBackend: imported.storageBackend,
      pagedDictionaries: imported.pagedDictionaries ?? null,
      heapBeforeImport: beforeImport.heapBytes, importMs, heapAfterImport: afterImport.heapBytes, rssAfterImport,
      residentBytes: afterImport.dictionaries.reduce((sum, entry) => sum + entry.bytes, 0),
      recycle, lookups,
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
  for (const archive of ARCHIVES) {
    if (!existsSync(archive)) throw new Error(`no archive at ${archive}`);
  }
  const puppeteerModule = await import(pathToFileURL(PUPPETEER).href);
  const puppeteer = puppeteerModule.default?.launch ? puppeteerModule.default : puppeteerModule;
  const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const chromeVersion = execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim();
  const rows = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    for (const lowMemoryMode of [false, true]) {
      const row = await sample(puppeteer, lowMemoryMode, rows.length);
      rows.push(row);
      const timing = row.lookups.passes
        ? row.lookups.passes.map((pass, index) => `pass ${index + 1} p50 ${pass.p50.toFixed(2)} p95 ${pass.p95.toFixed(2)} ms`).join(", ")
        : `lookup p50 ${row.lookups.medianMs.toFixed(2)} ms p95 ${row.lookups.p95Ms.toFixed(2)} ms`;
      console.log(`${lowMemoryMode ? "on " : "off"} #${index + 1}: import ${row.importMs.toFixed(0)} ms; heap ${mb(row.heapAfterImport)}`
        + ` rss ${mb(row.rssAfterImport)} after import${row.recycle ? `; heap ${mb(row.recycle.heapBytes)} rss ${mb(row.recycle.rssBytes)}`
          + ` ${row.recycle.recycleMs.toFixed(0)} ms after recycle` : ""}; ${timing}`);
    }
  }
  const result = { revision, chromeVersion, node: process.version,
    archives: ARCHIVES.map((path) => ({ path, bytes: readFileSync(path).byteLength })),
    samples: SAMPLES, lookups: LOOKUPS, text: TEXT, words: WORDS_FILE, recordedAt: new Date().toISOString(), rows };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nwrote ${OUTPUT}`);
}

await main();
