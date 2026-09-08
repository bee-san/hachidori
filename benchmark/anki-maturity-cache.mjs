// SPDX-License-Identifier: GPL-3.0-or-later
// Focused production-path diagnostic for bulk Anki refresh contention.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, loadavg, freemem } from "node:os";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendJsonlDurable } from "./system.mjs";
const [before, after, output] = process.argv.slice(2);
if (!before || !after || !output || !process.env.HACHIDORI_CHROME || !process.env.HACHIDORI_PUPPETEER) {
  throw new Error("Set HACHIDORI_CHROME and HACHIDORI_PUPPETEER, then pass before-extension after-extension output.jsonl.");
}
const { default: puppeteer } = await import(pathToFileURL(resolve(process.env.HACHIDORI_PUPPETEER)));
const chromePath = process.env.HACHIDORI_CHROME;
const rounds = 5; // One excluded warmup, then five measured pairs in alternating order.
const notes = Array.from({ length: 6104 }, (_, index) => ({ noteId: index + 1, modelName: "Japanese",
  fields: { Expression: { value: `語${String(index % 6001).padStart(5, "0")}`, order: 0 }, Sentence: { value: "", order: 1 } } }));
const compact = Buffer.from(JSON.stringify({ result: notes, error: null }));
const missing = 138474410 - compact.byteLength;
for (const [index, note] of notes.entries()) note.fields.Sentence.value = "d".repeat(Math.floor(missing / notes.length) + Number(index < missing % notes.length));
const large = Buffer.from(JSON.stringify({ result: notes, error: null }));
assert.equal(large.byteLength, 138474410);
notes.length = 0;
let largeResponse = false;
const server = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  response.end(largeResponse ? large : compact);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/`;
const environment = { platform: platform(), node: process.version, cpu: cpus()[0].model,
  memory: totalmem(), bytes: large.byteLength, notes: 6104, words: 6001, sha256: createHash("sha256").update(large).digest("hex") };
console.log(JSON.stringify(environment));
const expressions = ["語00000", "語06000", "absent"];
async function cell(variant, round) {
  const hostBefore = { load: loadavg(), freeMemory: freemem() };
  const extension = resolve(variant === "before" ? before : after);
  const profile = mkdtempSync(`${tmpdir()}/hachidori-maturity-bench-`);
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile,
    args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  let calls = 0;
  const errors = [];
    async function intercept(target) {
    const session = await target.createCDPSession();
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "http://127.0.0.1:8765*" }] });
    session.on("Fetch.requestPaused", async event => {
      try {
        const body = JSON.parse(event.request.postData);
        assert.equal(body.action, "notesInfo");
        assert.equal(body.params.query, '\"note:Japanese\" is:review -is:learn prop:ivl>=21');
        calls++;
        // Redirect only the test request transport; execute the real gateway,
        // decoding, extraction, scheduling and publication in both revisions.
        await session.send("Fetch.continueRequest", { requestId: event.requestId, url: endpoint });
      } catch (error) { errors.push(error.message); await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }).catch(() => {}); }
    });
  }
  try {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
    const id = new URL(worker.url()).host;
    await intercept(worker);
    const offscreen = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
    await intercept(offscreen);
    for (const page of await browser.pages()) if (page.url().includes(id)) await page.close();
    const page = await browser.newPage(); await page.goto(`chrome-extension://${id}/manifest.json`);
    largeResponse = false;
    await page.evaluate(async () => {
      const { normaliseOptions } = (await import("./reader-options.js"), globalThis.HDReaderOptions);
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options?.revision || 0,
        options: { definitionBlurAnkiMature: true, anki: normaliseOptions({ anki: { model: "Japanese", fields: { expression: "Expression" } } }).anki } });
      if (!reply.ok) throw new Error(reply.error);
    });
    await page.waitForFunction(async () => (await chrome.storage.local.get("ankiMaturityCache")).ankiMaturityCache?.snapshot?.words.length === 6001, { timeout: 20000 });
    assert.equal(calls, 1); assert.deepEqual(errors, []);
    const steady = await page.evaluate(async expressions => {
      const rows = [];
      for (let i = 0; i < 90; i++) {
        const started = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hachidori-anki", type: "hd_anki_maturity", request: { term: { expression: expressions[i % 3] } } });
        if (!reply.ok || reply.mature !== (i % 3 !== 2)) throw new Error("Wrong warm maturity answer");
        rows.push(performance.now() - started);
      }
      return rows;
    }, expressions);
    largeResponse = true;
    const concurrent = await page.evaluate(async expressions => {
      const { ankiMaturityCache: cache } = await chrome.storage.local.get("ankiMaturityCache");
      let completed = false;
      const observe = changes => { if (changes.ankiMaturityCache?.newValue?.snapshot?.refreshedAt > cache.snapshot.refreshedAt) completed = true; };
      chrome.storage.onChanged.addListener(observe);
      await chrome.storage.local.set({ ankiMaturityCache: { ...cache, attempt: { ...cache.attempt, startedAt: Date.now() - 1800001 } } });
      const started = performance.now();
      await chrome.alarms.create("hachidori-anki-maturity", { when: Date.now() });
      const rows = [];
      while (!completed) {
        if (performance.now() - started > 30000) throw new Error("Scheduled refresh did not finish");
        const index = rows.length % 3;
        const begin = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hachidori-anki", type: "hd_anki_maturity", request: { term: { expression: expressions[index] } } });
        if (!reply.ok || reply.mature !== (index !== 2)) throw new Error("Wrong concurrent maturity answer");
        rows.push(performance.now() - begin);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      chrome.storage.onChanged.removeListener(observe);
      const next = (await chrome.storage.local.get("ankiMaturityCache")).ankiMaturityCache;
      if (JSON.stringify(next.snapshot.words) !== JSON.stringify(cache.snapshot.words)) throw new Error("Snapshot changed");
      return { rows, refreshMs: performance.now() - started, words: next.snapshot.words.length };
    }, expressions);
    assert.equal(calls, 2); assert.deepEqual(errors, []);
    const workers = browser.targets().filter(target => target.url().endsWith("/anki-maturity-worker.js")).length;
    assert.equal(workers, 0, "Completed refresh worker must terminate");
    const row = { revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: extension, encoding: "utf8" }).trim(), environment, hostBefore, hostAfter: { load: loadavg(), freeMemory: freemem() }, variant, round, excluded: round === 0, chrome: await browser.version(), calls, steady, concurrent, workers };
    appendJsonlDurable(output, row);
    console.log(JSON.stringify({ variant, round, steadyMax: Math.max(...steady), concurrentMax: Math.max(...concurrent.rows), refreshMs: concurrent.refreshMs, samples: concurrent.rows.length }));
  } finally {
    await browser.close();
    assert.ok(browser.process().exitCode !== null || browser.process().signalCode !== null);
    rmSync(profile, { recursive: true, force: true });
  }
}
try {
  for (let round = 0; round <= rounds; round++) for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) await cell(variant, round);
} finally { await new Promise(resolve => server.close(resolve)); }
