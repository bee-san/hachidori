// SPDX-License-Identifier: GPL-3.0-or-later
// Reproduces hachidori#260 comment A in a real Electron overlay host (the
// GameSentenceMiner shape: `OVERLAY_MODE = true`, no `chrome.alarms`) against
// an isolated real Anki, and times the popup's `hd_anki_preflight` with and
// without a duplicate-index snapshot. Three launches on one profile:
//
//   1. fresh profile, Anki reachable: does the snapshot build, how long does
//      it take, and how fast is a cached preflight;
//   2. an attempt record left without an outcome (a host torn down mid-pull),
//      no snapshot: does the next worker start re-pull, or wait 30 minutes;
//   3. a failed attempt whose 30-minute backoff ends shortly after launch:
//      does anything fire without `chrome.alarms`.
//
//   HDW_ELECTRON=/path/to/electron node benchmark/anki-index-electron.mjs \
//     --extension extension --endpoint http://127.0.0.1:18765 --output out.json
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ELECTRON = process.env.HDW_ELECTRON;
if (!ELECTRON) throw new Error("set HDW_ELECTRON to the Electron binary");
const PUPPETEER = process.env.HDW_PUPPETEER
  || resolve(homedir(), ".cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const puppeteer = (await import(PUPPETEER)).default;

const options = {
  extension: resolve(HERE, "../extension"), endpoint: "http://127.0.0.1:18765",
  model: "Hachidori Duplicate Index Benchmark", deck: "Hachidori Duplicate Index Benchmark",
  expression: "食べる", samples: 20, waitMs: 45_000, backoffRemainingMs: 15_000, alarmProbeMs: 5_000, output: "",
};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/u, "").replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
  if (!(key in options)) throw new Error(`Unknown option ${process.argv[index]}`);
  options[key] = typeof options[key] === "number" ? Number(process.argv[index + 1]) : process.argv[index + 1];
}
if (new URL(options.endpoint).port === "8765") throw new Error("Refusing the standard AnkiConnect port; use an isolated Anki profile.");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const p95 = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]; };
const REFRESH_MS = 30 * 60 * 1000;

const work = mkdtempSync(resolve(tmpdir(), "hachidori-anki-index-electron-"));
const EXT = resolve(work, "extension");
cpSync(options.extension, EXT, { recursive: true });
const flag = resolve(EXT, "overlay-mode.js");
writeFileSync(flag, readFileSync(flag, "utf8").replace("OVERLAY_MODE = false", "OVERLAY_MODE = true"));
const PROFILE = resolve(work, "profile");
let port = 9500 + Math.floor(Math.random() * 400);

async function launch() {
  const env = { ...process.env, HDW_EXT: EXT, HDW_PROFILE: PROFILE, HDW_CDP_PORT: String(port++) };
  const proc = spawn("xvfb-run", ["-a", ELECTRON, "--no-sandbox", resolve(HERE, "electron-host")],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const launchedAt = performance.now();
  let extensionId = null;
  const ws = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("Electron did not expose DevTools in time")), 30_000);
    const on = data => {
      const text = data.toString();
      extensionId ??= text.match(/HDW_EXT_ID (\S+)/)?.[1] ?? null;
      const match = text.match(/ws:\/\/\S+/);
      if (match) { clearTimeout(timer); done(match[0]); }
    };
    proc.stdout.on("data", on); proc.stderr.on("data", on);
  });
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const target = await browser.waitForTarget(t => t.url().includes("settings.html"), { timeout: 30_000 });
  const page = await target.page();
  const workerTarget = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 30_000 });
  const worker = await workerTarget.worker();
  const logs = [];
  const session = await workerTarget.createCDPSession();
  await session.send("Runtime.enable");
  session.on("Runtime.consoleAPICalled", event => logs.push(`${event.type}: ${event.args.map(a => a.value ?? a.description ?? "").join(" ")}`));
  session.on("Runtime.exceptionThrown", event => logs.push(`exception: ${event.exceptionDetails.text} ${event.exceptionDetails.exception?.description ?? ""}`));
  return { proc, browser, page, worker, launchedAt, extensionId, logs };
}

async function shutdown({ browser, proc }) {
  await browser.disconnect();
  const exited = new Promise(resolve => proc.on("exit", resolve));
  writeFileSync(resolve(PROFILE, "hdw-quit"), "");
  await Promise.race([exited, sleep(15_000)]);
  try { process.kill(-proc.pid, "SIGKILL"); } catch {}
  await sleep(500);
}

const send = (page, message) => page.evaluate(m => chrome.runtime.sendMessage(m), message);
const readIndex = page => page.evaluate(async () => (await chrome.storage.local.get("ankiDuplicateIndex")).ankiDuplicateIndex ?? null);
const writeIndex = (page, value) => page.evaluate(async v => { await chrome.storage.local.set({ ankiDuplicateIndex: v }); }, value);
const indexSummary = state => state === null ? null : {
  rows: state.snapshot?.rows?.length ?? null,
  refreshedAt: state.snapshot?.refreshedAt ?? null,
  attempt: state.attempt ?? null,
  rowRevision: state.rowRevision,
};

async function waitForSnapshot(page, since, limitMs) {
  const started = performance.now();
  for (;;) {
    const state = await readIndex(page);
    if ((state?.snapshot?.rows?.length ?? 0) > 1 && (since === null || state.snapshot.refreshedAt > since)) {
      return { appeared: true, afterMs: Math.round(performance.now() - started), state: indexSummary(state) };
    }
    if (performance.now() - started > limitMs) return { appeared: false, afterMs: null, state: indexSummary(state) };
    await sleep(250);
  }
}

async function configureAnki(page) {
  const stored = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const reply = await send(page, { target: "hoshidicts-worker", type: "hd_options_write", requestId: `opts-${Math.random()}`,
    baseRevision: stored.revision, options: { anki: {
      ...stored.anki, url: options.endpoint, apiKey: "", model: options.model, deck: options.deck,
      duplicateScope: "model", duplicateBehavior: "prevent",
      fieldTemplates: { Expression: { value: "{expression}", overwriteMode: "coalesce" }, Back: { value: "{definition}", overwriteMode: "coalesce" } },
    } } });
  if (reply?.ok === false) throw new Error(`hd_options_write failed: ${JSON.stringify(reply)}`);
}

// Timed on the page clock around the runtime message, like the reader does.
async function timePreflight(page) {
  const status = await send(page, { target: "hachidori-anki", type: "hd_anki_status", requestId: `st-${Math.random()}` });
  if (!status?.ok || !status.available) throw new Error(`Anki not available: ${JSON.stringify(status)}`);
  // The reader's mining request for a result whose definitions are empty: only
  // the expression is needed for the duplicate decision under measurement.
  const request = {
    term: { expression: options.expression, reading: "", rules: "", glossaries: [], pitches: [], frequencies: [] },
    generation: 1, trace: [], configKey: status.configKey, sentence: options.expression, matched: options.expression, matchOffset: 0,
    popupSelectionText: "", searchQuery: options.expression, documentTitle: "benchmark", dictionaryAliases: {}, frequencyDictionaries: [],
  };
  const samples = [];
  let last = null, firstMs = null;
  for (let index = 0; index <= options.samples; index++) {
    const result = await page.evaluate(async r => {
      const started = performance.now();
      const reply = await chrome.runtime.sendMessage({ target: "hachidori-anki", type: "hd_anki_preflight", requestId: `pf-${Math.random()}`, request: r });
      return { ms: performance.now() - started, reply };
    }, request);
    if (!result.reply?.ok) throw new Error(`preflight failed: ${JSON.stringify(result.reply)}`);
    if (index > 0) samples.push(result.ms);
    else firstMs = Number(result.ms.toFixed(2));
    last = result.reply;
  }
  return { firstMs, samples: samples.length, medianMs: Number(median(samples).toFixed(2)), p95Ms: Number(p95(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)), state: last.state, noteIds: last.noteIds ?? null, raw: samples.map(v => Number(v.toFixed(2))) };
}

const report = { extension: options.extension, endpoint: options.endpoint, model: options.model, launches: {} };
try {
  // Launch 1: fresh profile, Anki reachable. First record what this host's
  // extension service worker actually offers: chrome.alarms may exist without
  // ever dispatching onAlarm, and storage.onChanged may never reach the worker.
  let host = await launch();
  report.electron = `${execFileSync(ELECTRON, ["--version"], { encoding: "utf8" }).trim()} ${await host.page.evaluate(() => navigator.userAgent.match(/Chrome\/\S+/)?.[0])}`;
  report.extensionId = host.extensionId;
  report.overlayMode = await host.page.evaluate(async () => (await import(chrome.runtime.getURL("overlay-mode.js"))).OVERLAY_MODE);
  report.workerApis = await host.worker.evaluate(() => ({
    alarms: typeof chrome.alarms, offscreen: typeof chrome.offscreen, getContexts: typeof chrome.runtime.getContexts }));
  report.alarmsProbe = await host.worker.evaluate(async probeMs => {
    if (typeof chrome.alarms === "undefined") return null;
    let fired = false;
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "hdw-probe") fired = true; });
    await chrome.alarms.create("hdw-probe", { when: Date.now() + 1000 });
    const created = await chrome.alarms.get("hdw-probe");
    await new Promise(resolve => setTimeout(resolve, probeMs));
    return { created, waitedMs: probeMs, fired, stillScheduled: (await chrome.alarms.get("hdw-probe")) !== undefined };
  }, options.alarmProbeMs);
  report.storageOnChangedInWorker = await host.worker.evaluate(async () => {
    const seen = [];
    chrome.storage.onChanged.addListener((changes, area) => seen.push([area, Object.keys(changes)]));
    await chrome.storage.local.set({ hdwWorkerProbe: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 1500));
    return seen;
  });
  console.error("host:", JSON.stringify({ electron: report.electron, apis: report.workerApis, alarms: report.alarmsProbe,
    storageOnChanged: report.storageOnChangedInWorker }));

  await configureAnki(host.page);
  let fresh = await waitForSnapshot(host.page, null, options.waitMs);
  fresh.sameWorker = fresh.appeared;
  if (!fresh.appeared) {
    // Without a storage event the configured source is only seen by the next
    // worker start.
    await shutdown(host);
    host = await launch();
    fresh = { ...await waitForSnapshot(host.page, null, options.waitMs), sameWorker: false };
  }
  const cachedPreflight = fresh.appeared ? await timePreflight(host.page) : null;
  const built = await readIndex(host.page);
  report.launches.fresh = { snapshot: fresh, preflight: cachedPreflight, workerLogs: host.logs.slice(0, 20) };
  console.error("fresh:", JSON.stringify({ snapshot: fresh, preflight: cachedPreflight && { firstMs: cachedPreflight.firstMs, medianMs: cachedPreflight.medianMs, state: cachedPreflight.state } }));

  // Launch 2: the reservation of a pull that never recorded an outcome, no snapshot.
  const sourceKey = built.attempt?.sourceKey ?? built.snapshot?.sourceKey;
  if (!sourceKey) throw new Error("no source key in the built index state");
  const orphanedAt = Date.now();
  await writeIndex(host.page, { version: 1, configurationRevision: built.configurationRevision, rowRevision: built.rowRevision,
    snapshot: null, attempt: { sourceKey, startedAt: orphanedAt } });
  await shutdown(host);
  host = await launch();
  const orphan = await waitForSnapshot(host.page, orphanedAt, options.waitMs);
  const orphanPreflight = await timePreflight(host.page);
  report.launches.orphanedAttempt = { attemptStartedAt: orphanedAt, snapshot: orphan, preflight: orphanPreflight };
  console.error("orphan:", JSON.stringify({ snapshot: orphan, preflight: { firstMs: orphanPreflight.firstMs, medianMs: orphanPreflight.medianMs, state: orphanPreflight.state } }));

  // Launch 3: a failed pull whose backoff ends `backoffRemainingMs` after launch.
  const current = await readIndex(host.page);
  const failedStartedAt = Date.now() - REFRESH_MS + options.backoffRemainingMs;
  await writeIndex(host.page, { version: 1, configurationRevision: current.configurationRevision, rowRevision: current.rowRevision,
    snapshot: null, attempt: { sourceKey, startedAt: failedStartedAt, finishedAt: failedStartedAt + 1000 } });
  await shutdown(host);
  host = await launch();
  const backoff = await waitForSnapshot(host.page, failedStartedAt + 1000, options.waitMs);
  report.launches.failedBackoffDue = { attemptStartedAt: failedStartedAt, dueMsAfterLaunch: options.backoffRemainingMs, snapshot: backoff };
  console.error("backoff:", JSON.stringify(backoff));
  await shutdown(host);
} finally {
  rmSync(work, { recursive: true, force: true });
}
report.measuredAt = new Date().toISOString();
const text = JSON.stringify(report, null, 2);
if (options.output) writeFileSync(options.output, text);
console.log(text);
process.exit(0);
