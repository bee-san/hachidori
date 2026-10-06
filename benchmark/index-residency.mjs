// SPDX-License-Identifier: GPL-3.0-or-later
// Real Chrome/threaded OPFS. Native importer output is installed once into
// each fresh profile, then restored without reimport under alternating policies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeSummary } from "./index-residency-report.mjs";
import { appendJsonlDurable, directoryContentSha256, hostSnapshot } from "./system.mjs";

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const repo = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(readFileSync(resolve(arg("fixture"), "fixture.json"), "utf8"));
const output = resolve(arg("output"));
const samples = Number(arg("samples", "3"));
const measureTotal = arg("measure-total", "false") === "true";
// OS-cold samples evict the seeded profile from the OS page cache before the
// measured launch. tmpfs pages cannot be evicted: point TMPDIR at a disk.
const osCold = arg("os-cold", "false") === "true";
const profileFilesystem = execFileSync("stat", ["-f", "-c", "%T", tmpdir()], { encoding: "utf8" }).trim();
assert.ok(!osCold || profileFilesystem !== "tmpfs", "--os-cold needs TMPDIR on a block-device filesystem");
const variants = arg("variants", "resident,16,32,64,paged").split(",");
// The baseline is a previous revision's unmodified extension/: a directory
// that contains it (--before), or a commit to extract it from (--before-ref).
const beforeRef = arg("before-ref", null);
const beforeRevision = beforeRef
  ? execFileSync("git", ["rev-parse", "--verify", `${beforeRef}^{commit}`], { cwd: repo, encoding: "utf8" }).trim() : null;
let before = arg("before", null);
if (!before && beforeRevision) {
  before = mkdtempSync(resolve(tmpdir(), "hachidori-index-before-"));
  execFileSync("sh", ["-c", 'git archive "$1" extension | tar -x -C "$2"', "sh", beforeRevision, before], { cwd: repo });
}
const baseExtension = resolve(repo, "extension");
// Memory of the renderer hosting the offscreen document and its engine
// worker (the WASM heap), and of the whole browser tree. Both are RSS, so
// shared pages count once per process.
function processMemory(rootPid) {
  const rows = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      rows.set(Number(name), { parent: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]),
        rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
        extension: readFileSync(`/proc/${name}/cmdline`, "utf8").includes("--extension-process") });
    } catch { /* The process exited while it was listed. */ }
  }
  const tree = new Set([rootPid]);
  for (let size = 0; size !== tree.size;) {
    size = tree.size;
    for (const [pid, row] of rows) if (tree.has(row.parent)) tree.add(pid);
  }
  let treeRssBytes = 0, extensionRssBytes = 0;
  for (const pid of tree) {
    treeRssBytes += rows.get(pid)?.rss ?? 0;
    if (rows.get(pid)?.extension) extensionRssBytes += rows.get(pid).rss;
  }
  return { treeRssBytes, extensionRssBytes };
}
function memorySampler(rootPid, intervalMs = 100) {
  const peak = { treeRssBytes: 0, extensionRssBytes: 0 };
  const capture = () => {
    const now = processMemory(rootPid);
    for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], now[key]);
    return now;
  };
  capture();
  const timer = setInterval(capture, intervalMs);
  return { stop() { clearInterval(timer); return { peak, last: capture(), intervalMs }; } };
}
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const chrome = process.env.HACHIDORI_CHROME;
const probe = readFileSync(resolve(repo, "benchmark/hover-popup-probe.js"), "utf8");
// A temporary public key keeps the extension origin stable across profile
// copies and both revisions. It never changes the production manifest.
const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
mkdirSync(output, { recursive: true });
const allowed = new Map();
allowed.set("/replace.zip", resolve(arg("fixture"), "replace.zip"));
for (const dictionary of fixture.dictionaries) for (const name of readdirSync(dictionary.directory)) {
  allowed.set(`/${encodeURIComponent(dictionary.title)}/${encodeURIComponent(name)}`, resolve(dictionary.directory, name));
}
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/reader") { res.end('<!doctype html><meta charset="utf-8"><p id="hit">食べる</p><p id="second">漢字</p>'); return; }
  const path = allowed.get(req.url);
  if (!path) { res.writeHead(404); res.end(); return; }
  createReadStream(path).pipe(res);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const distribution = values => {
  const sorted = [...values].sort((a, b) => a-b);
  const at = p => sorted[Math.min(sorted.length-1, Math.floor(p*sorted.length))];
  return { median: at(.5), p95: at(.95), p99: at(.99) };
};
const signatures = new Map();
const rows = [];
const definition = { revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  extensionSha256: directoryContentSha256(baseExtension), beforeExtensionSha256: before ? directoryContentSha256(resolve(before, "extension")) : null,
  beforeRef, beforeRevision,
  defaultBudgetMiB: Number(readFileSync(resolve(baseExtension, "dictionary-index-storage.js"), "utf8")
    .match(/RESIDENT_HASH_BUDGET_BYTES = (\d+) \* 1024 \* 1024;/)[1]),
  node: process.version, chrome: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
  environment: hostSnapshot(), fixture, samples, variants, before, measureTotal, osCold, profileDirectory: tmpdir(), profileFilesystem,
  boundary: `fresh engine; cache includes header/startup warmup pages; ${osCold ? "profile files evicted from the OS page cache before launch" : "OS cache is uncontrolled"}; engine ccall includes serialization/glue; round trip excludes CDP and rendering; RSS peak sampled every 100 ms from launch to the end of the warm pass` };
writeFileSync(resolve(output, "definition.json"), JSON.stringify(definition, null, 2));

async function sample(variant, repetition) {
  const directory = mkdtempSync(resolve(tmpdir(), "hachidori-index-"));
  const extension = resolve(directory, "extension");
  const baseline = variant === "baseline";
  assert.ok(!baseline || before, "baseline variant requires --before");
  cpSync(baseline ? resolve(before, "extension") : baseExtension, extension, { recursive: true });
  const manifestFile = resolve(extension, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, key: publicKey }));
  // An owned benchmark copy must not claim a relay on the developer's machine.
  // Apply the same disabled host configuration to both revisions before startup.
  const backgroundFile = resolve(extension, "background.js");
  const background = readFileSync(backgroundFile, "utf8");
  const hostConfig = "  const host = stored[SHARING_KEY]?.host;";
  assert.equal(background.split(hostConfig).length, 2);
  writeFileSync(backgroundFile, background.replace(hostConfig, "  const host = null;"));
  cpSync(resolve(repo, "benchmark/index-residency-seed.js"), resolve(extension, "benchmark-seed-worker.js"));
  const policyFile = resolve(extension, "dictionary-index-storage.js");
  if (/^\d+$/.test(variant)) {
    const original = readFileSync(policyFile, "utf8");
    writeFileSync(policyFile, original.replace(/export const RESIDENT_HASH_BUDGET_BYTES = \d+ \* 1024 \* 1024;/,
      `export const RESIDENT_HASH_BUDGET_BYTES = ${variant} * 1024 * 1024;`));
  }
  // These two clocks only instrument the temporary extension. The production
  // source/bundle is identical across all budget variants.
  const serviceFile = resolve(extension, "engine-service.js");
  let source = readFileSync(serviceFile, "utf8");
  source = source.replace('    const json = engine.ccall(\n      "hdw_lookup",', '    const nativeStarted = performance.now();\n    const json = engine.ccall(\n      "hdw_lookup",');
  source = source.replace('    throwIfEngineFailed("hdw_lookup");', '    const nativeMs = performance.now() - nativeStarted;\n    throwIfEngineFailed("hdw_lookup");');
  source = source.replace('termLookupReply(json, "hdw_lookup")', '{ ...termLookupReply(json, "hdw_lookup"), nativeMs }');
  writeFileSync(serviceFile, source);
  const offscreenFile = resolve(extension, "offscreen.js");
  const offscreenSource = readFileSync(offscreenFile, "utf8");
  // Seed an empty profile before any native OPFS mount owns handles. The
  // unmodified bridge is restored before the measured browser starts.
  writeFileSync(offscreenFile, offscreenSource.replace(
    /(function startWorkerEngine\([^\n]+\) \{)/, "$1\n  return; // benchmark setup only"));
  const contentFile = resolve(extension, "content.js");
  const content = readFileSync(contentFile, "utf8"), marker = '  start();\n}());';
  assert.equal(content.split(marker).length, 2);
  writeFileSync(contentFile, content.replace(marker, `${probe}\n${marker}`));
  let browser, page, id;

  const desiredIndex = baseline ? "resident" : variant === "resident" || variant === "paged" ? variant : "auto";
  const request = (type, fields = {}) => page.evaluate((type, fields) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type, ...fields }), type, fields);
  async function launch() {
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true,
      userDataDir: resolve(directory, "profile"), protocolTimeout: 300000,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
    const target = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"));
    id = new URL(target.url()).host;
    page = await browser.newPage();
    for (const open of await browser.pages()) if (open !== page) await open.close();
    await page.goto(`chrome-extension://${id}/settings.html#dictionaries`);
    await page.bringToFront();
  }
  async function ready(count = fixture.packages) {
    try {
      return await page.waitForFunction(async (count, desiredIndex) => {
        // A startup message can lose its reply while Chrome activates/replaces
        // extension contexts. Retry observations; never retry a mutation.
        let timer;
        const s = await Promise.race([chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
          new Promise(done => { timer = setTimeout(() => done(null), 1000); })]);
        clearTimeout(timer);
        if (s) globalThis.benchmarkLastStatus = s;
        if (s?.failedDictionaries?.length) throw new Error(JSON.stringify(s.failedDictionaries));
        return s?.ok && s.ready && !s.loading && s.lowMemory && s.dictionaryCount === count*4
          && (s.dictionaryIndexStorage ?? "resident") === desiredIndex ? s : false;
      }, { timeout: 180000, polling: 50 }, count, desiredIndex).then(handle => handle.jsonValue());
    } catch (error) {
      const last = await page.evaluate(() => globalThis.benchmarkLastStatus ?? null).catch(() => null);
      throw new Error(`${error.message}; last engine status: ${JSON.stringify(last)}`, { cause: error });
    }
  }
  try {
    await launch();
    await page.evaluate(async desiredIndex => {
      const options = (await chrome.storage.local.get("options")).options ?? {};
      await chrome.storage.local.set({ options: { ...options, revision: (options.revision ?? 0) + 1,
          lowMemoryMode: true, dictionaryEntryStorage: "auto", ...(desiredIndex ? { dictionaryIndexStorage: desiredIndex } : {}),
          audioAutoplay: false, showLookupCounts: false, maxResults: 256, hoverEnabled: true, lookupMode: "hover", showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3, definitionBlurCountEnabled: false } });
    }, baseline ? null : desiredIndex);
    // No native mapping/import is performed during setup: write installed,
    // format-preserving files directly, then restart before any measurement.
    await page.evaluate(async (dictionaries, origin) => {
      // Each package's setup worker releases its fetch buffers and OPFS handles
      // before the next one. None of this untimed work survives into the sample.
      for (const { files, ...dictionary } of dictionaries) await new Promise((done, reject) => {
        const worker = new Worker(chrome.runtime.getURL("benchmark-seed-worker.js"));
        worker.onmessage = ({ data }) => { worker.terminate(); data.ok ? done() : reject(new Error(data.error)); };
        worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
        worker.postMessage({ dictionaries: [dictionary], files, origin });
      });
      await chrome.storage.local.set({ dictionaryState: { schemaVersion: 1, revision: 1, groups: [],
        dictionaries: dictionaries.map(({ files, ...dictionary }) => dictionary) } });
    }, fixture.dictionaries.map(({ directory, files, reporterResidentBytes, syntheticRows, ...dictionary }) => ({ ...dictionary,
      files: (files ?? fixture.files).map(({ name, bytes }) => ({ name, bytes })) })), origin);
    await browser.close(); browser = null;
    writeFileSync(offscreenFile, offscreenSource);
    let profileCachedBytes = null;
    if (osCold) {
      const files = readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name));
      for (const file of files) {
        execFileSync("sync", [file]);
        execFileSync("dd", [`if=${file}`, "iflag=nocache", "count=0", "status=none"]);
      }
      profileCachedBytes = execFileSync("fincore", ["--bytes", "--noheadings", "--output", "RES", ...files], { encoding: "utf8" })
        .split("\n").filter(Boolean).reduce((sum, line) => sum + Number(line), 0);
    }
    console.log(`${variant} #${repetition+1}: installed profile prepared`);
    const loadStarted = performance.now();
    await launch();
    const sampler = memorySampler(browser.process().pid);
    const status = await ready();
    assert.equal(status.storageBackend, "opfs"); assert.equal(status.threaded, true);
    assert.deepEqual(status.failedDictionaries, []);
    const restartMs = performance.now() - loadStarted;
    const fresh = await request("hd_memory");
    const rssFresh = processMemory(browser.process().pid);
    const pass = () => page.evaluate(async words => {
      const latencies = [], native = [], results = [];
      const passStarted = performance.now();
      for (const text of words) {
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text, maxResults: 256, scanLength: 16 });
        latencies.push(performance.now() - started); native.push(reply.nativeMs);
        if (!Number.isFinite(reply.nativeMs)) throw new Error("native clock was not instrumented");
        if (!reply.ok) throw new Error(JSON.stringify(reply));
        results.push(reply.results);
      }
      const wallMs = performance.now() - passStarted;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(results)));
      return { latencies, native, wallMs, resultHash: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,"0")).join("") };
    }, fixture.corpus);
    const passes = [];
    for (let n = 0; n < 2; ++n) {
      const timed = await pass();
      const key = "corpus";
      if (signatures.has(key)) assert.equal(timed.resultHash, signatures.get(key));
      else signatures.set(key, timed.resultHash);
      passes.push({ ...timed, roundTrip: distribution(timed.latencies), engine: distribution(timed.native), memory: await request("hd_memory") });
    }
    // Low memory mode recycles the worker after 2 s idle once startup's state
    // commit has settled, so read memory while the worker that served both
    // passes is still running. Peak covers startup and both passes.
    const processRss = { ...sampler.stop(), fresh: rssFresh };
    const parity = { kanji: (await request("hd_kanji", { character: "食" })).kanji,
      selected: (await request("hd_lookup_dictionary", { text: "食べました", dictionary: fixture.dictionaries[0].title })).results,
      media: (await request("hd_media", { dictionary: fixture.dictionaries[0].title, path: "media/kanji.png" })).dataUrl };
    if (signatures.has("other")) assert.equal(hash(parity), signatures.get("other"));
    else signatures.set("other", hash(parity));
    const reader = await browser.newPage();
    await reader.setViewport({ width: 1440, height: 1000 });
    const cdp = await reader.createCDPSession(), contexts = [];
    cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
    await cdp.send("Runtime.enable");
    await reader.goto(`${origin}/reader`);
    await reader.bringToFront();
    let contextId;
    for (let retry = 0; retry < 100 && !contextId; ++retry) {
      for (const context of contexts) {
        const value = await cdp.send("Runtime.evaluate", { contextId: context.id,
          expression: "typeof __hoverProbe", returnByValue: true }).catch(() => null);
        if (value?.result.value === "object") contextId = context.id;
      }
      if (!contextId) await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(contextId, "production content-script probe ready");
    async function evaluate(expression) {
      const reply = await cdp.send("Runtime.evaluate", { contextId, expression, returnByValue: true });
      assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    }
    const hover = [];
    for (let n = 0; n < 12; ++n) {
      await reader.keyboard.press("Escape"); await reader.mouse.move(700, 500);
      await evaluate('__hoverProbe.arm("食べる")');
      const box = await (await reader.$("#hit")).boundingBox();
      await reader.mouse.move(box.x + 6, box.y + box.height/2);
      let result;
      for (let retry = 0; retry < 3000; ++retry) {
        result = await evaluate("__hoverProbe.read()");
        if (result.complete !== null) break;
        await new Promise(done => setTimeout(done, 10));
      }
      assert.notEqual(result.complete, null, "complete rendered hover results");
      hover.push({ first: result.first - result.start, complete: result.complete - result.start });
    }
    await reader.close();
    const beforeDisable = await page.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState);
    const mutationStarted = performance.now();
    const disabled = await request("hd_apply_state", { baseRevision: beforeDisable.revision,
      dictionaries: beforeDisable.dictionaries.map((item, index) => ({ ...item, enabled: index % 2 === 0 })) });
    assert.equal(disabled.ok, true);
    const disableMs = performance.now() - mutationStarted;
    await browser.close(); browser = null;
    const validationStarted = performance.now();
    await launch();
    await ready(Math.ceil(fixture.packages / 2));
    const disabledRestartMs = performance.now() - validationStarted;
    const disabledMemory = await request("hd_memory");
    const current = await page.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState);
    const enableStarted = performance.now();
    assert.equal((await request("hd_apply_state", { baseRevision: current.revision, dictionaries: current.dictionaries.map(item => ({ ...item, enabled: true })) })).ok, true);
    const enableMs = performance.now() - enableStarted;
    await ready();
    assert.equal((await pass()).resultHash, signatures.get("corpus"));
    const afterEnable = await request("hd_memory");
    const reimport = await page.evaluate(async origin => {
      const archive = await (await fetch(`${origin}/replace.zip`)).blob();
      const blobUrl = URL.createObjectURL(archive);
      try {
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
          blobUrl, fileName: "replace.zip", requestId: "benchmark-reimport" });
        if (!reply.ok) throw new Error(JSON.stringify(reply));
        return { ms: performance.now() - started, generation: reply.generation };
      } finally { URL.revokeObjectURL(blobUrl); }
    }, origin);
    const afterReimport = await request("hd_memory");
    const recycleStarted = performance.now();
    await page.waitForFunction(async generation => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return reply?.ready && !reply.loading && reply.generation < generation;
    }, { timeout: 120000, polling: 50 }, reimport.generation);
    await ready();
    const recycleMs = performance.now() - recycleStarted;
    const afterRecycle = await request("hd_memory");
    assert.equal((await pass()).resultHash, signatures.get("corpus"));
    const removeStarted = performance.now();
    assert.equal((await request("hd_remove", { title: fixture.dictionaries[0].title })).ok, true);
    const removeMs = performance.now() - removeStarted;
    await ready(fixture.packages - 1);
    const afterRemove = await request("hd_memory");
    const row = { variant, repetition, restartMs, profileCachedBytes, status, fresh, processRss, passes, parityHash: hash(parity),
      hover, hoverFirst: distribution(hover.map(item => item.first)), hoverComplete: distribution(hover.map(item => item.complete)),
      disableMs, enableMs, disabledRestartMs, disabledMemory, afterEnable,
      reimport, afterReimport, recycleMs, afterRecycle, removeMs, afterRemove,
      rssAfterLifecycle: processMemory(browser.process().pid) };
    // Advanced starts Chrome's asynchronous memory measurement. Keep it
    // outside setup and timings, where GC would interfere with OPFS writes.
    if (variant === "32" && repetition === 0) {
      await page.goto(`chrome-extension://${id}/settings.html#advanced`);
      await page.waitForFunction(() => document.getElementById("memory-indexes").textContent.includes("resident"));
      const expected = (await request("hd_lookup", { text: "食べる", maxResults: 256 })).results;
      row.uiControls = {};
      for (const policy of ["paged", "resident", "auto"]) {
        await page.select("#opt-dictionary-index-storage", policy);
        await page.waitForFunction(async policy => {
          const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
          return status?.ready && !status.loading && status.dictionaryIndexStorage === policy;
        }, { timeout: 120000, polling: 50 }, policy);
        const memory = await request("hd_memory");
        assert.ok(memory.dictionaries.every(item => item.paged));
        if (policy !== "auto") assert.ok(memory.dictionaries.every(item => item.hashIndexStorage === policy));
        assert.deepEqual((await request("hd_lookup", { text: "食べる", maxResults: 256 })).results, expected);
        row.uiControls[policy] = { heapBytes: memory.heapBytes, residentHashBytes: memory.dictionaries.reduce((sum, item) => sum + item.residentHashBytes, 0) };
      }
      await page.reload();
      await page.waitForFunction(() => document.getElementById("memory-indexes").textContent.includes("resident"));
      mkdirSync(resolve(output, "screenshots"), { recursive: true });
      for (const palette of ["light", "dark"]) {
        await page.evaluate(palette => { document.documentElement.dataset.hoshidictsTheme = palette; }, palette);
        await (await page.$("#memory-settings")).screenshot({ path: resolve(output, `screenshots/memory-${palette}.png`) });
      }
    }
    // Optional browser-wide snapshot after all timing and UI checks. Chrome's
    // GC-based measurement can take seconds; retain an unavailable result if
    // it does not answer in this benchmark's observation window.
    if (measureTotal) {
      let timer;
      row.extensionTotal = await Promise.race([request("hd_memory_total"), new Promise(done => {
        timer = setTimeout(() => done({ ok: false, error: "measurement did not answer within 30 seconds" }), 30000);
      })]);
      clearTimeout(timer);
    }
    appendJsonlDurable(resolve(output, "raw.jsonl"), row);
    console.log(`${variant} #${repetition+1}: heap ${(fresh.heapBytes/1048576).toFixed(1)} MiB;`
      + ` warm p50 ${passes[1].roundTrip.median.toFixed(2)} / p95 ${passes[1].roundTrip.p95.toFixed(2)} ms; parity ${passes[0].resultHash}`);
    return row;
  } catch (error) {
    console.error(JSON.stringify({ error: String(error) }, null, 2));
    throw error;
  } finally { await browser?.close(); rmSync(directory, { recursive: true, force: true }); }
}
// A sample that stalls (seen in about 1 of 40 samples, in main and PR variants
// alike, on a host shared with other browser tests) is retried once in a fresh
// profile. failures.jsonl keeps every failed attempt; the summary reports them.
async function sampleWithRetry(variant, repetition) {
  for (let attempt = 1; ; ++attempt) {
    try {
      return await sample(variant, repetition);
    } catch (error) {
      appendJsonlDurable(resolve(output, "failures.jsonl"), { variant, repetition, attempt, utc: new Date().toISOString(),
        error: String(error) });
      if (attempt === 2) throw error;
      console.error(`${variant} #${repetition+1}: attempt ${attempt} failed; retrying in a fresh profile`);
    }
  }
}
try {
  for (let repetition = 0; repetition < samples; ++repetition) {
    for (const variant of repetition % 2 ? [...variants].reverse() : variants) rows.push(await sampleWithRetry(variant, repetition));
  }
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ definition, rows }, null, 2));
  console.log(writeSummary(output));
} finally {
  await new Promise(done => server.close(done));
  if (!arg("before", null) && before) rmSync(before, { recursive: true, force: true });
}
