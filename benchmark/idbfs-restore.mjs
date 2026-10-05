// SPDX-License-Identifier: GPL-3.0-or-later
//
// Threaded IDBFS restoration: Chrome normally runs direct OPFS, so this copies
// the extension to a scratch directory and makes offscreen.js choose the
// threaded IDBFS worker (the Electron/GameSentenceMiner runtime). Each sample
// imports the archives into a fresh profile, restarts Chrome on it and records
// restart-to-ready, the engine heap, the extension total from hd_memory_total
// and what it measures outside the heap (the IDBFS mirror lives there), then
// looks up a word list and hashes the replies. See docs/memory.md.
//
//   node benchmark/idbfs-restore.mjs --archive /path/to/jitendex.zip \
//     --archive /path/to/pixiv.zip --words words.txt \
//     --samples 3 --output benchmark/results/idbfs-restore.json

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.HACHIDORI_CHROME;
const PUPPETEER = process.env.HACHIDORI_PUPPETEER;

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const ARCHIVES = process.argv.flatMap((value, index) => (process.argv[index - 1] === "--archive" ? [resolve(value)] : []));
const WORDS = readFileSync(resolve(argument("words")), "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
const SAMPLES = Number(argument("samples", "3"));
const OUTPUT = resolve(argument("output", resolve(REPO, "benchmark/results/idbfs-restore.json")));
const EXTENSION = resolve(tmpdir(), `hachidori-idbfs-extension-${process.pid}`);

function prepareExtension() {
  rmSync(EXTENSION, { recursive: true, force: true });
  cpSync(resolve(REPO, "extension"), EXTENSION, { recursive: true });
  const path = resolve(EXTENSION, "offscreen.js");
  const source = readFileSync(path, "utf8");
  const marker = "async function selectEngine() {";
  if (!source.includes(marker)) throw new Error("offscreen.js has no selectEngine()");
  writeFileSync(path, source.replace(marker, `${marker}\n  return "threaded-idbfs";`));
}

async function sample(puppeteer, index) {
  const profile = resolve(tmpdir(), `hachidori-idbfs-restore-${process.pid}-${index}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  let browser = null;
  let page = null;
  async function launch() {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: true, userDataDir: profile,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30_000 });
    for (const open of await browser.pages()) if (open.url().includes("startup.html")) await open.close();
    page = await browser.newPage();
    await page.goto(`chrome-extension://${new URL(target.url()).host}/settings.html#advanced`, { waitUntil: "domcontentloaded" });
  }
  const engine = (type, fields = {}) => page.evaluate((type, fields) => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen", type, requestId: `bench-${type}-${Math.random()}`, ...fields,
  }), type, fields);
  const waitReady = (count) => page.waitForFunction(async (count) => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status?.ok && status.ready && !status.loading && status.dictionaryCount >= count ? status : false;
  }, { timeout: 900_000, polling: 50 }, count).then((handle) => handle.jsonValue());
  const memory = async () => {
    const heap = await engine("hd_memory");
    const total = await engine("hd_memory_total");
    return { heapBytes: heap.heapBytes, totalBytes: total.bytes ?? null,
      outsideHeapBytes: typeof total.bytes === "number" ? total.bytes - total.heapBytes : null };
  };
  try {
    await launch();
    const initial = await waitReady(0);
    if (initial.storageBackend !== "idbfs" || initial.threaded !== true) throw new Error(`not threaded IDBFS: ${JSON.stringify(initial)}`);
    const importStarted = performance.now();
    await (await page.$("#import-file")).uploadFile(...ARCHIVES);
    const imported = await page.waitForFunction(async (count) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return dictionaryState?.dictionaries?.length === count && status?.ok && status.ready && !status.loading ? status : false;
    }, { timeout: 900_000, polling: 100 }, ARCHIVES.length).then((handle) => handle.jsonValue());
    const importMs = performance.now() - importStarted;
    const afterImport = await memory();
    await browser.close();
    const restartStarted = performance.now();
    await launch();
    await waitReady(imported.dictionaryCount);
    const restartMs = performance.now() - restartStarted;
    const afterRestart = await memory();
    const lookups = await page.evaluate(async (texts) => {
      const latencies = [];
      let hits = 0;
      let hash = 0x811c9dc5;
      for (let i = 0; i < texts.length; i += 1) {
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: `l-${i}`, text: texts[i] });
        if (!reply?.ok) throw new Error(`lookup ${i} failed: ${JSON.stringify(reply)}`);
        latencies.push(performance.now() - started);
        if (reply.results?.length) hits += 1;
        const text = JSON.stringify(reply.results ?? []);
        for (let c = 0; c < text.length; c += 1) hash = Math.imul(hash ^ text.charCodeAt(c), 0x01000193) >>> 0;
      }
      latencies.sort((a, b) => a - b);
      const at = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
      return { hits, resultHash: hash.toString(16), p50: at(0.5), p95: at(0.95), p99: at(0.99) };
    }, WORDS);
    const backupStarted = performance.now();
    const backup = await engine("hd_backup_export", {});
    const backupMs = performance.now() - backupStarted;
    if (backup?.blobUrl) await engine("hd_backup_release", { blobUrl: backup.blobUrl });
    return { importMs, afterImport, restartMs, afterRestart, lookups,
      backup: { ok: backup?.ok === true, ms: backupMs, bytes: backup?.size ?? null, error: backup?.ok === true ? null : backup?.error ?? null } };
  } finally {
    await browser?.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const mb = (bytes) => (typeof bytes === "number" ? `${(bytes / 1_048_576).toFixed(0)} MB` : "—");

async function main() {
  if (!CHROME || !existsSync(CHROME)) throw new Error("set HACHIDORI_CHROME");
  if (!PUPPETEER || !existsSync(PUPPETEER)) throw new Error("set HACHIDORI_PUPPETEER");
  if (ARCHIVES.length === 0) throw new Error("pass --archive");
  prepareExtension();
  const module = await import(pathToFileURL(PUPPETEER).href);
  const puppeteer = module.default?.launch ? module.default : module;
  const rows = [];
  try {
    for (let index = 0; index < SAMPLES; index += 1) {
      const row = await sample(puppeteer, index);
      rows.push(row);
      console.log(`#${index + 1}: import ${row.importMs.toFixed(0)} ms, outside heap ${mb(row.afterImport.outsideHeapBytes)};`
        + ` restart ${row.restartMs.toFixed(0)} ms heap ${mb(row.afterRestart.heapBytes)} outside heap ${mb(row.afterRestart.outsideHeapBytes)};`
        + ` lookups p50 ${row.lookups.p50.toFixed(2)} p95 ${row.lookups.p95.toFixed(2)} ms hash ${row.lookups.resultHash};`
        + ` backup ${row.backup.ok ? `${row.backup.ms.toFixed(0)} ms` : row.backup.error}`);
    }
  } finally {
    rmSync(EXTENSION, { recursive: true, force: true });
  }
  const result = {
    revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(),
    chromeVersion: execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(), node: process.version,
    archives: ARCHIVES, words: WORDS.length, recordedAt: new Date().toISOString(), rows,
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nwrote ${OUTPUT}`);
}

await main();
