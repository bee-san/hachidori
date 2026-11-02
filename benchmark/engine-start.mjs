#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Engine start (docs/languages.md 19): Chrome closed and started again on a
// retained profile, from the launch to the first correct hd_lookup, for
// several checkouts in rotating order. A variant is `name=checkout[:codes]`:
// the checkout's extension with --archive imported into the Japanese profile
// and, after that, a profile added for each listed language (hd_profile_add),
// whose pack `reconcile` then loads at every engine start. A code written
// `en+` also imports `--language-archive en=/path.zip` into that profile.
//
// The extension runs as a copy whose engine-service.js keeps, in the engine
// worker, the times it started, created the WebAssembly module, reconciled
// (with the packs' load) and published (with the warm-up lookup), and the
// duration of its first engine calls; hd_memory returns them as `bench`.
// Nothing else changes. The first lookups come from an empty extension page.
//
//   node benchmark/engine-start.mjs --archive jitendex.zip --output out.json \
//     --variant before=/path/to/base --variant after=. --variant after-en-ar=.:en,ar \
//     [--variant three=.:en+,ar+ --language-archive en=kty-en-en.zip --language-archive ar=kty-ar-en.zip] \
//     [--sessions 3] [--restarts 8]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { processTreeSample } from "./system.mjs";

const values = name => process.argv.flatMap((value, index) => (process.argv[index - 1] === `--${name}` ? [value] : []));
const ARCHIVE = resolve(values("archive")[0] ?? "");
const OUTPUT = resolve(values("output")[0] ?? "engine-start.json");
const SESSIONS = Number(values("sessions")[0] ?? 3);
const RESTARTS = Number(values("restarts")[0] ?? 8);
const LANGUAGE_ARCHIVES = new Map(values("language-archive").map(entry => entry.split("=")).map(([code, path]) => [code, resolve(path)]));
const VARIANTS = values("variant").map((entry) => {
  const [name, spec] = entry.split("=");
  const [checkout, codes = ""] = spec.split(":");
  const languages = codes.split(",").filter(Boolean);
  return { name, checkout: resolve(checkout), languages: languages.map(code => code.replace(/\+$/u, "")),
    imports: languages.filter(code => code.endsWith("+")).map(code => code.slice(0, -1)) };
});
assert.ok(VARIANTS.length > 0, "at least one --variant name=checkout[:codes]");
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const ARGS = ["--disable-gpu", "--disable-dev-shm-usage", ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])];
const WORD = "食べる";

// Anchors present in engine-service.js before and after the language work;
// the pack anchor exists only after it.
function instrument(source) {
  const replace = (anchor, replacement, { optional = false, first = false } = {}) => {
    const count = source.split(anchor).length - 1;
    assert.ok(count === 1 || (first && count > 1) || (optional && count === 0), `anchor ${JSON.stringify(anchor)} x${count}`);
    source = source.replace(anchor, replacement);
  };
  replace("    engine = await createHoshidicts();\n",
    "    __benchMark(\"create\");\n    engine = await createHoshidicts();\n    __benchWrap(engine);\n    __benchMark(\"created\");\n");
  replace("    const committed = await reconcile();\n    publishLoadedDictionaries(committed.loadedCount);\n",
    "    __benchMark(\"reconcile\");\n    const committed = await reconcile();\n    __benchMark(\"reconciled\");\n"
    + "    publishLoadedDictionaries(committed.loadedCount);\n    __benchMark(\"published\");\n");
  // Only after the language work; its first occurrence is reconcile()'s.
  replace("  if (profileRecords) await loadLanguagePacks(recordLanguages, { all: true });\n  else languageFailures = [];\n",
    "  __benchMark(\"packs\");\n  if (profileRecords) await loadLanguagePacks(recordLanguages, { all: true });\n  else languageFailures = [];\n"
    + "  __benchMark(\"packs-loaded\");\n", { optional: true, first: true });
  replace("      heapBytes: engine.HEAPU8.byteLength,\n", "      heapBytes: engine.HEAPU8.byteLength,\n      bench: globalThis.__hachidoriBench,\n");
  return `const __benchRecord = globalThis.__hachidoriBench = { origin: performance.timeOrigin, marks: [["module", performance.now()]], calls: [] };
function __benchMark(name) { __benchRecord.marks.push([name, performance.now()]); }
function __benchWrap(module) {
  const ccall = module.ccall.bind(module);
  module.ccall = (name, ...rest) => {
    const start = performance.now();
    try { return ccall(name, ...rest); } finally {
      if (__benchRecord.calls.length < 400) __benchRecord.calls.push([name, start, performance.now() - start]);
    }
  };
}
${source}`;
}

// The worker's record as durations: phases between marks and the first calls
// of each engine function that matter at start.
function breakdown(bench) {
  const mark = name => bench.marks.find(([label]) => label === name)?.[1] ?? null;
  const span = (from, to) => (mark(from) === null || mark(to) === null ? null : mark(to) - mark(from));
  const calls = name => bench.calls.filter(([label]) => label === name);
  const lookups = calls("hdw_lookup");
  return {
    moduleMs: mark("module"), createMs: span("create", "created"), beforeReconcileMs: span("created", "reconcile"),
    packsMs: span("packs", "packs-loaded"), reconcileMs: span("reconcile", "reconciled"), publishMs: span("reconciled", "published"),
    workerToPublishedMs: mark("published"),
    languageLoadMs: calls("hdw_language_load").map(([, , ms]) => ms),
    addDictMs: calls("hdw_add_dict").reduce((sum, [, , ms]) => sum + ms, 0),
    warmLookupMs: lookups[0]?.[2] ?? null, firstServedLookupMs: lookups[1]?.[2] ?? null,
    firstServedLookupAt: lookups[1] ? lookups[1][1] : null,
  };
}

async function session(variant, round) {
  const directory = mkdtempSync(join(tmpdir(), "hachidori-engine-start-"));
  const extension = join(directory, "extension");
  cpSync(join(variant.checkout, "extension"), extension, { recursive: true });
  const servicePath = join(extension, "engine-service.js");
  writeFileSync(servicePath, instrument(readFileSync(servicePath, "utf8")));
  execFileSync(process.execPath, ["--check", servicePath]);
  writeFileSync(join(extension, "bench.html"), "<!doctype html><meta charset=\"utf-8\"><title>bench</title>\n");
  const profile = join(directory, "profile");
  const launch = () => puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, userDataDir: profile,
    enableExtensions: true, protocolTimeout: 300_000,
    args: [...ARGS, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  let browser = await launch();
  const rows = [];
  try {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"));
    const id = new URL(worker.url()).host;
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    const send = (target, type, fields = {}) => page.evaluate((target, type, fields) => chrome.runtime.sendMessage({
      target, type, requestId: `bench-${type}-${Date.now()}`, ...fields }), target, type, fields);
    const settled = async (count) => {
      let last = null;
      for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
        last = await page.evaluate(async () => ({ rows: (await chrome.storage.local.get("dictionaryState")).dictionaryState?.dictionaries?.length,
          text: document.getElementById("import-state")?.textContent,
          status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }) }));
        if (last.rows === count && last.status?.ok && last.status.ready && !last.status.loading && last.status.dictionaryCount > 0) return;
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
      throw new Error(`import did not settle: ${JSON.stringify(last)}`);
    };
    const importInto = async (archive, count, profileId = null) => {
      await page.goto(`chrome-extension://${id}/settings.html${profileId ? `?profile=${profileId}` : ""}#add-dictionaries`);
      // As benchmark/browser.mjs does: upload once Settings listens to the input.
      await page.waitForFunction(() => globalThis.__benchImportHandler === true, { polling: 50 });
      await (await page.$("#import-file")).uploadFile(archive);
      await settled(count);
    };
    await page.evaluateOnNewDocument(() => {
      const original = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function observed(type, listener, options) {
        if (type === "change" && this instanceof HTMLInputElement && this.id === "import-file") globalThis.__benchImportHandler = true;
        return original.call(this, type, listener, options);
      };
    });
    await importInto(ARCHIVE, 1);
    let count = 1;
    for (const code of variant.languages) {
      const reply = await send("hoshidicts-offscreen", "hd_profile_add", { language: code, copyFrom: "ja" });
      assert.ok(reply?.ok, `hd_profile_add ${code}: ${JSON.stringify(reply)}`);
      if (variant.imports.includes(code)) await importInto(LANGUAGE_ARCHIVES.get(code), ++count, code);
    }
    const stored = await page.evaluate(() => chrome.storage.local.get(["options", "dictionaryState"]));
    const languages = (stored.options?.profiles ?? [{ language: "ja" }]).map(profile => profile.language);
    for (let restart = 0; restart < RESTARTS; restart += 1) try {
      for (const open of await browser.pages().catch(() => [])) await open.close().catch(() => {});
      await browser.close().catch(() => {});
      const started = performance.now();
      browser = await launch();
      const launchedMs = performance.now() - started;
      await browser.waitForTarget(target => target.type() === "service_worker" && target.url().startsWith(`chrome-extension://${id}/`));
      const probe = await browser.newPage();
      await probe.goto(`chrome-extension://${id}/bench.html`, { waitUntil: "domcontentloaded" });
      const pageMs = performance.now() - started;
      // Every message has a deadline, so a start whose engine never answers
      // is recorded as failed instead of stalling the run.
      await probe.evaluate(() => {
        globalThis.call = (message, ms = 5000) => Promise.race([chrome.runtime.sendMessage(message),
          new Promise(resolveLate => setTimeout(() => resolveLate({ ok: false, error: "no reply" }), ms))])
          .catch(error => ({ ok: false, error: String(error) }));
      });
      const first = await probe.evaluate(async (text) => {
        const now = () => performance.timeOrigin + performance.now();
        const sentAt = now();
        let reply = null;
        for (let attempts = 1; now() - sentAt < 30_000; attempts += 1) {
          reply = await globalThis.call({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: `first-${attempts}`, text });
          if (reply?.ok && reply.results?.length > 0) return { attempts, sentAt, repliedAt: now(), expression: reply.results[0].term.expression };
          await new Promise(resolveWait => setTimeout(resolveWait, 5));
        }
        return { failed: JSON.stringify(reply).slice(0, 500) };
      }, WORD);
      const firstLookupMs = performance.now() - started;
      if (first.failed) {
        rows.push({ variant: variant.name, round, restart, failed: first.failed });
        console.log(JSON.stringify(rows.at(-1)));
        continue;
      }
      assert.equal(first.expression, WORD);
      const steady = await probe.evaluate(async (text) => {
        const out = [];
        for (let i = 0; i < 20; i += 1) {
          const begun = performance.now();
          await globalThis.call({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: `steady-${i}`, text });
          out.push(performance.now() - begun);
        }
        return out.sort((a, b) => a - b);
      }, WORD);
      const memory = await probe.evaluate(() => globalThis.call({ target: "hoshidicts-offscreen", type: "hd_memory", requestId: "memory" }));
      assert.ok(memory?.bench, `hd_memory carries no bench record: ${JSON.stringify(memory).slice(0, 300)}`);
      const phases = breakdown(memory.bench);
      const row = { variant: variant.name, round, restart, languages, launchedMs, pageMs, firstLookupMs, attempts: first.attempts,
        // The worker's clock and the page's share the time origin's epoch.
        workerToFirstReplyMs: first.repliedAt - memory.bench.origin, pageSentToReplyMs: first.repliedAt - first.sentAt,
        steadyMedianMs: steady[10], ...phases, heapBytes: memory.heapBytes, rssBytes: processTreeSample(browser.process().pid).rssBytes,
        bench: memory.bench };
      rows.push(row);
      console.log(JSON.stringify({ variant: row.variant, round, restart, firstLookupMs: Math.round(firstLookupMs),
        workerToFirstReplyMs: Math.round(row.workerToFirstReplyMs), workerToPublishedMs: Math.round(row.workerToPublishedMs),
        createMs: Math.round(row.createMs), reconcileMs: Math.round(row.reconcileMs), packsMs: row.packsMs?.toFixed(1),
        warmLookupMs: row.warmLookupMs?.toFixed(2), firstServedLookupMs: row.firstServedLookupMs?.toFixed(2) }));
    } catch (error) {
      rows.push({ variant: variant.name, round, restart, failed: String(error?.message ?? error).slice(0, 500) });
      console.log(JSON.stringify(rows.at(-1)));
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
  return rows;
}

const rows = [];
const definition = { harness: "benchmark/engine-start.mjs", chrome: execFileSync(process.env.HACHIDORI_CHROME, ["--version"], { encoding: "utf8" }).trim(),
  node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, loadAtStart: loadavg(), archive: ARCHIVE,
  languageArchives: Object.fromEntries(LANGUAGE_ARCHIVES), sessions: SESSIONS, restarts: RESTARTS, word: WORD, args: ARGS,
  variants: VARIANTS.map(variant => ({ ...variant,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: variant.checkout, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--short", "extension"], { cwd: variant.checkout, encoding: "utf8" }).trim() })) };
for (let round = 0; round < SESSIONS; round += 1) {
  // Each round rotates the order, so every variant runs in every position.
  const order = VARIANTS.map((_, index) => VARIANTS[(index + round) % VARIANTS.length]);
  for (const variant of order) {
    rows.push(...await session(variant, round));
    writeFileSync(OUTPUT, `${JSON.stringify({ ...definition, loadAtEnd: loadavg(), rows }, null, 2)}\n`);
  }
}
console.log(`wrote ${OUTPUT}`);
