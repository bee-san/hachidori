// SPDX-License-Identifier: GPL-3.0-or-later
// Real Chrome/threaded OPFS. Native importer output is installed once into
// each profile, then restored without reimport under alternating policies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendJsonlDurable, directoryContentSha256, hostSnapshot, processTreeSample } from "./system.mjs";

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const repo = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(readFileSync(resolve(arg("fixture"), "fixture.json"), "utf8"));
const output = resolve(arg("output"));
const samples = Number(arg("samples", "3"));
const variants = arg("variants", "resident,16,32,64,paged").split(",");
const before = arg("before", null);
const baseExtension = resolve(repo, "extension");
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const chrome = process.env.HACHIDORI_CHROME;
const probe = readFileSync(resolve(repo, "benchmark/hover-popup-probe.js"), "utf8");
// A temporary public key keeps the extension origin stable across profile
// copies and both revisions. It never changes the production manifest.
const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
const seedDirectory = mkdtempSync(resolve(tmpdir(), "hachidori-index-seed-"));
let seeded = false;
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
  node: process.version, chrome: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
  environment: hostSnapshot(), fixture, samples, variants, before,
  boundary: "fresh engine; cache includes header/startup warmup pages; OS cache is uncontrolled; engine ccall includes serialization/glue; round trip excludes CDP and rendering" };
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
  cpSync(resolve(repo, "benchmark/index-residency-seed.js"), resolve(extension, "benchmark-seed-worker.js"));
  if (seeded) cpSync(resolve(seedDirectory, "profile"), resolve(directory, "profile"), { recursive: true });
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
  writeFileSync(offscreenFile, `${readFileSync(offscreenFile, "utf8")}\nglobalThis.__benchmarkStopEngine = () => worker.terminate();\n`);
  const contentFile = resolve(extension, "content.js");
  const content = readFileSync(contentFile, "utf8"), marker = '  start();\n}());';
  assert.equal(content.split(marker).length, 2);
  writeFileSync(contentFile, content.replace(marker, `${probe}\n${marker}`));
  let browser, page, id;
  const diagnostics = [];

  const desiredIndex = baseline ? "resident" : variant === "resident" || variant === "paged" ? variant : "auto";
  const request = (type, fields = {}) => page.evaluate((type, fields) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type, ...fields }), type, fields);
  async function launch() {
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true,
      userDataDir: resolve(directory, "profile"), protocolTimeout: 600000,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
    browser.on("targetcreated", async target => {
      try {
        const session = await target.createCDPSession();
        session.on("Runtime.exceptionThrown", event => diagnostics.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
        session.on("Runtime.consoleAPICalled", event => { if (event.type === "error") diagnostics.push(event.args.map(arg => arg.value ?? arg.description).join(" ")); });
        await session.send("Runtime.enable");
      } catch {}
    });
    const target = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"));
    id = new URL(target.url()).host;
    page = await browser.newPage();
    for (const open of await browser.pages()) if (open !== page) await open.close();
    await page.goto(`chrome-extension://${id}/settings.html#dictionaries`);
    await page.bringToFront();
  }
  async function ready(count = fixture.packages) {
    return page.waitForFunction(async (count, desiredIndex) => {
      const s = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      if (s?.failedDictionaries?.length) throw new Error(JSON.stringify(s.failedDictionaries));
      return s?.ok && s.ready && !s.loading && s.lowMemory && s.dictionaryCount === count*4
        && (s.dictionaryIndexStorage ?? "resident") === desiredIndex ? s : false;
    }, { timeout: 600000, polling: 50 }, count, desiredIndex).then(handle => handle.jsonValue());
  }
  try {
    await launch();
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" })).ready, { polling: 50, timeout: 120000 });
    const optionReply = await page.evaluate(async desiredIndex => {
      const options = (await chrome.storage.local.get("options")).options ?? {};
      return chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision ?? 0,
        options: { lowMemoryMode: true, dictionaryEntryStorage: "auto", ...(desiredIndex ? { dictionaryIndexStorage: desiredIndex } : {}),
          audioAutoplay: false, showLookupCounts: false, maxResults: 256, hoverEnabled: true, lookupMode: "hover", showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3, definitionBlurCountEnabled: false } });
    }, baseline ? null : desiredIndex);
    assert.equal(optionReply.ok, true, JSON.stringify(optionReply));
    await ready(seeded ? fixture.packages : 0);
    if (!seeded) {
      // Setup writes must not compete with the mounted WasmFS OPFS handles.
      // The measured engine starts only after these files are persisted.
      const offscreen = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
      const session = await offscreen.createCDPSession();
      const stopped = await session.send("Runtime.evaluate", { expression: "__benchmarkStopEngine()" });
      assert.equal(stopped.exceptionDetails, undefined);
      await session.detach();
    }
    // No native mapping/import is performed during setup: write installed,
    // format-preserving files directly, then restart before any measurement.
    if (!seeded) await page.evaluate(async (dictionaries, fileNames, origin) => {
      await new Promise((done, reject) => {
        const worker = new Worker(chrome.runtime.getURL("benchmark-seed-worker.js"));
        worker.onmessage = ({ data }) => { worker.terminate(); data.ok ? done() : reject(new Error(data.error)); };
        worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
        worker.postMessage({ dictionaries, fileNames, origin });
      });
      await chrome.storage.local.set({ dictionaryState: { schemaVersion: 1, revision: 1, groups: [], dictionaries } });
    }, fixture.dictionaries.map(({ directory, ...dictionary }) => dictionary), fixture.files.map(file => file.name), origin);
    await browser.close(); browser = null;
    if (!seeded) {
      cpSync(resolve(directory, "profile"), resolve(seedDirectory, "profile"), { recursive: true });
      seeded = true;
    }
    console.log(`${variant} #${repetition+1}: installed profile prepared`);
    const loadStarted = performance.now();
    await launch();
    const status = await ready();
    assert.equal(status.storageBackend, "opfs"); assert.equal(status.threaded, true);
    assert.deepEqual(status.failedDictionaries, []);
    const restartMs = performance.now() - loadStarted;
    const fresh = await request("hd_memory");
    const rssFresh = processTreeSample(browser.process().pid).rssBytes;
    const pass = () => page.evaluate(async words => {
      const latencies = [], native = [], results = [];
      for (const text of words) {
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text, maxResults: 256, scanLength: 16 });
        latencies.push(performance.now() - started); native.push(reply.nativeMs);
        if (!Number.isFinite(reply.nativeMs)) throw new Error("native clock was not instrumented");
        if (!reply.ok) throw new Error(JSON.stringify(reply));
        results.push(reply.results);
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(results)));
      return { latencies, native, resultHash: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,"0")).join("") };
    }, fixture.corpus);
    const passes = [];
    for (let n = 0; n < 2; ++n) {
      const timed = await pass();
      const key = "corpus";
      if (signatures.has(key)) assert.equal(timed.resultHash, signatures.get(key));
      else signatures.set(key, timed.resultHash);
      passes.push({ ...timed, roundTrip: distribution(timed.latencies), engine: distribution(timed.native), memory: await request("hd_memory") });
    }
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
    const row = { variant, repetition, restartMs, status, fresh, rssFresh, passes, parityHash: hash(parity),
      hover, hoverFirst: distribution(hover.map(item => item.first)), hoverComplete: distribution(hover.map(item => item.complete)),
      disableMs, enableMs, disabledRestartMs, disabledMemory, afterEnable,
      reimport, afterReimport, recycleMs, afterRecycle, removeMs, afterRemove,
      rssWarm: processTreeSample(browser.process().pid).rssBytes };
    appendJsonlDurable(resolve(output, "raw.jsonl"), row);
    // Advanced starts Chrome's asynchronous memory measurement. Keep it
    // outside setup and timings, where GC would interfere with OPFS writes.
    if (variant === "32" && repetition === 0) {
      await page.goto(`chrome-extension://${id}/settings.html#advanced`);
      await page.waitForFunction(() => document.getElementById("memory-indexes").textContent.includes("resident"));
      mkdirSync(resolve(output, "screenshots"), { recursive: true });
      for (const palette of ["light", "dark"]) {
        await page.evaluate(palette => { document.documentElement.dataset.hoshidictsTheme = palette; }, palette);
        await (await page.$("#memory-settings")).screenshot({ path: resolve(output, `screenshots/memory-${palette}.png`) });
      }
    }
    console.log(`${variant} #${repetition+1}: heap ${(fresh.heapBytes/1048576).toFixed(1)} MiB;`
      + ` warm p50 ${passes[1].roundTrip.median.toFixed(2)} / p95 ${passes[1].roundTrip.p95.toFixed(2)} ms; parity ${passes[0].resultHash}`);
    return row;
  } catch (error) {
    console.error(JSON.stringify({ error: String(error), diagnostics, status: await request("hd_status").catch(() => null) }, null, 2));
    throw error;
  } finally { await browser?.close(); rmSync(directory, { recursive: true, force: true }); }
}
try {
  for (let repetition = 0; repetition < samples; ++repetition) {
    for (const variant of repetition % 2 ? [...variants].reverse() : variants) rows.push(await sample(variant, repetition));
  }
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ definition, rows }, null, 2));
} finally {
  await new Promise(done => server.close(done));
  rmSync(seedDirectory, { recursive: true, force: true });
}
