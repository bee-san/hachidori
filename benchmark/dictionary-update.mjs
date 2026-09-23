// SPDX-License-Identifier: GPL-3.0-or-later
// Lookup availability while a dictionary is replaced by a newer generation.
//
// Each sample is a fresh Chrome profile with the unpacked extension. For each
// library size in --others, that many small fixture clones are imported through
// the real settings.html file input; then the target dictionary is updated
// through the same hd_import transaction a managed update runs (a same-title
// archive at the next revision replaces the installed package) while the page
// keeps issuing hd_lookup round trips every 100 ms, alternating a word only the
// target answers with a word only the other dictionaries answer.
//
// Per (sample, library size) row in raw.jsonl:
//   importWallMs       hd_import request to reply
//   failedLookups      lookups refused with engine-mutating during the import
//   unavailableMs      first refused lookup sent -> last refused lookup replied
//   maxLookupMs        slowest answered lookup during the import (the in-place
//                      swap shows up here rather than as a refusal)
//   newRevisionAfterMs first reply carrying the new revision, from the request
//   heapBefore/PeakBytes  hd_memory.heapBytes before and after the update; the
//                      heap never shrinks, so the reading after the reply is
//                      the engine's high-water mark (hd_memory stats every
//                      loaded file, so it is not sampled during the update)
//   opfsTransientBytes peak origin usage during the update minus the usage
//                      before it (old and new generation on disk together)
//   updatingReported   whether any hd_status during the update carried
//                      updating: { id, phase }
//
//   node benchmark/dictionary-update.mjs --output benchmark/results/dictionary-update
//   node benchmark/dictionary-update.mjs --revision origin/main --output benchmark/results/dictionary-update-base
//   node benchmark/dictionary-update.mjs --archive jitendex.zip --update-archive jitendex-next.zip --query 食べる
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromeArguments, closeBrowserVerified } from "./browser.mjs";
import { appendJsonlDurable, directoryContentSha256, hostSnapshot, sha256File } from "./system.mjs";
import { buildTitledZip } from "../test/make-fixture.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const root = resolve(argument("root", fileURLToPath(new URL("..", import.meta.url))));
const output = resolve(argument("output", "benchmark/results/dictionary-update"));
const revision = argument("revision", null);
const samples = Number(argument("samples", "3"));
const counts = argument("others", "1,20,100").split(",").map(Number);
const targetRows = Number(argument("target-rows", "100000"));
const archivePath = argument("archive", null);
const updateArchivePath = argument("update-archive", archivePath);
const lookupIntervalMs = Number(argument("interval-ms", "100"));
const chromePath = process.env.HACHIDORI_CHROME || "/usr/bin/chromium";
const puppeteerPath = process.env.HACHIDORI_PUPPETEER
  || resolve(homedir(), ".cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const puppeteer = await import(pathToFileURL(puppeteerPath).href);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// The target: a synthetic dictionary whose only shared word carries its
// revision in the glossary, or a real archive pair (the same title at two
// revisions; --update-archive defaults to re-importing the same file).
const TARGET_TITLE = "update-target";
const TARGET_QUERY = "更新語";
const OTHERS_QUERY = "食べる";
const targetQuery = argument("query", archivePath === null ? TARGET_QUERY : OTHERS_QUERY);

function syntheticTerms(rows, revision) {
  const terms = [[TARGET_QUERY, "こうしんご", "", "", 0, [`revision ${revision}`], 1, ""]];
  for (let i = 0; i < rows; i += 1) {
    const kana = String.fromCharCode(0x3042 + (i % 80), 0x3042 + ((i / 80) % 80 | 0), 0x3042 + ((i / 6400) % 80 | 0));
    const kanji = String.fromCharCode(0x4e00 + (i % 20000), 0x4e00 + ((i * 7) % 20000));
    terms.push([kanji + kana, kana, "n", "", 1, [`definition ${i} of revision ${revision}`,
      { type: "structured-content", content: { tag: "div", content: [{ tag: "span", content: `sense ${i}` }] } }], i, ""]);
  }
  return terms;
}

function targetArchive(revision) {
  if (archivePath !== null) return readFileSync(revision === 1 ? archivePath : updateArchivePath);
  return buildTitledZip(TARGET_TITLE, { revision: `rev-${revision}`, terms: syntheticTerms(targetRows, revision) });
}

const others = Array.from({ length: Math.max(...counts) }, (_, index) => {
  const title = `update-other-${String(index + 1).padStart(3, "0")}`;
  return { title, bytes: buildTitledZip(title) };
});
mkdirSync(output, { recursive: true });
// A source snapshot keeps a comparison in this worktree independent of later
// edits, and can benchmark a settled base without checking out another branch.
const source = revision === null ? root : resolve(output, "source");
if (revision !== null) {
  mkdirSync(source, { recursive: true });
  const archive = execFileSync("git", ["archive", revision, "extension"], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", source], { input: archive });
}
const archiveDirectory = resolve(output, "archives");
mkdirSync(archiveDirectory, { recursive: true });
for (const other of others) {
  other.path = resolve(archiveDirectory, `${other.title}.zip`);
  writeFileSync(other.path, other.bytes);
}
const firstTarget = targetArchive(1);
const firstTargetPath = resolve(archiveDirectory, `${TARGET_TITLE}-1.zip`);
writeFileSync(firstTargetPath, firstTarget);
const definition = {
  revision: git("rev-parse", revision ?? "HEAD"), worktreeStatus: revision === null ? git("status", "--short") : "",
  extensionSha256: directoryContentSha256(resolve(source, "extension")),
  node: process.version, chrome: execFileSync(chromePath, ["--version"], { encoding: "utf8" }).trim(),
  host: hostSnapshot(), counts, samples, lookupIntervalMs,
  target: archivePath === null
    ? { synthetic: true, rows: targetRows, bytes: firstTarget.length }
    : { archive: basename(archivePath), sha256: sha256File(archivePath), updateArchive: basename(updateArchivePath),
      updateSha256: sha256File(updateArchivePath), bytes: firstTarget.length },
  others: { title: "six-term fixture clones", bytes: others[0].bytes.length },
  limitations: "Other dictionaries are six-term fixture clones, so their reload cost is small; pass --others sizes for the library shape. "
    + "The update runs the hd_import transaction directly from the settings page (same-title replacement), not the alarm and index check of a scheduled update, which add one JSON fetch outside the engine. "
    + "Lookups are hd_lookup round trips from the page (service worker, offscreen document, engine), not page scanning or popup rendering. "
    + "Heap is the engine's linear memory (hd_memory) before and after the update; OPFS bytes come from navigator.storage.estimate(). "
    + "The profile's first automatic backup snapshot runs its own short generation cleanup at an unrelated time; a refused lookup it causes counts like any other.",
};
writeFileSync(resolve(output, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`);

// Runs in the settings page: issues the update and keeps looking words up
// until it has settled, recording every reply.
async function measureUpdate(page, { archiveBase64, fileName, revision, targetQuery, othersQuery, intervalMs, synthetic }) {
  return page.evaluate(async ({ archiveBase64, fileName, revision, targetQuery, othersQuery, intervalMs, synthetic }) => {
    const request = (type, fields = {}) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type, ...fields });
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const usage = async () => (await navigator.storage.estimate()).usage;
    const before = {
      status: await request("hd_status"),
      memory: await request("hd_memory"),
      opfsBytes: await usage(),
      state: (await chrome.storage.local.get("dictionaryState")).dictionaryState,
    };
    const lookups = [];
    let opfsPeak = before.opfsBytes;
    let updatingReported = false;
    let stop = false;
    // Fixed cadence, like a reader hovering every 100 ms: a lookup that waits
    // behind the import must not delay the next one.
    const inFlight = [];
    const tick = (i) => {
      const text = i % 2 === 0 ? targetQuery : othersQuery;
      const startedAt = performance.now();
      inFlight.push(request("hd_lookup", { text, requestId: `bench-lookup-${i}` }).then((reply) => {
        const repliedAt = performance.now();
        const glossaries = reply.results?.[0]?.term?.glossaries ?? [];
        lookups.push({
          text, startedAt, repliedAt, ms: repliedAt - startedAt,
          ok: reply.ok === true, errorCode: reply.errorCode ?? null, hit: glossaries.length > 0,
          generation: reply.generation ?? null,
          // The synthetic target's shared word carries its revision.
          revision: synthetic && text === targetQuery
            ? (glossaries.map((entry) => entry.glossary).join("\n").match(/"revision (\d+)"/u)?.[1] ?? null) : null,
        });
      }));
      inFlight.push(request("hd_status").then((status) => {
        if (status.updating) updatingReported = true;
      }));
      if (i % 3 === 0) inFlight.push(usage().then((bytes) => { opfsPeak = Math.max(opfsPeak, bytes); }));
    };
    const loop = (async () => {
      for (let i = 0; !stop; i += 1) {
        tick(i);
        await sleep(intervalMs);
      }
      await Promise.all(inFlight);
    })();
    await sleep(intervalMs * 3);
    const bytes = Uint8Array.from(atob(archiveBase64), (character) => character.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const sentAt = performance.now();
    const reply = await request("hd_import", { blobUrl, fileName, requestId: `bench-import-${revision}` });
    const repliedAt = performance.now();
    URL.revokeObjectURL(blobUrl);
    if (!reply.ok || !reply.report?.success) throw new Error(`update failed: ${JSON.stringify(reply)}`);
    // Let the loop observe the settled engine.
    await sleep(intervalMs * 5);
    stop = true;
    await loop;
    // The first automatic backup's generation cleanup is a separate short
    // mutation whose timing is unrelated to the update; it may refuse this
    // one read, so the settled reading retries past it.
    let lookup = await request("hd_lookup", { text: targetQuery });
    for (let attempt = 0; lookup.errorCode === "engine-mutating" && attempt < 20; attempt += 1) {
      await sleep(intervalMs);
      lookup = await request("hd_lookup", { text: targetQuery });
    }
    const after = {
      status: await request("hd_status"),
      memory: await request("hd_memory"),
      opfsBytes: await usage(),
      state: (await chrome.storage.local.get("dictionaryState")).dictionaryState,
      lookup,
    };
    return { before, after, sentAt, importWallMs: repliedAt - sentAt, lookups, opfsPeak, updatingReported, importReport: reply.report };
  }, { archiveBase64, fileName, revision, targetQuery, othersQuery, intervalMs, synthetic });
}

function summarise(result, revision, synthetic) {
  const since = (at) => at - result.sentAt;
  const during = result.lookups.filter((entry) => since(entry.startedAt) >= 0 && since(entry.startedAt) <= result.importWallMs);
  const refused = during.filter((entry) => entry.errorCode === "engine-mutating");
  const answered = during.filter((entry) => entry.ok);
  const otherFailures = during.filter((entry) => !entry.ok && entry.errorCode !== "engine-mutating");
  const firstNew = result.lookups.find((entry) => synthetic
    ? entry.revision === String(revision)
    : entry.ok && entry.generation !== null && entry.generation > result.before.status.generation);
  // The engine heap never shrinks, so the reading after the update is its peak.
  const heapPeak = Math.max(result.before.memory.heapBytes, result.after.memory.heapBytes);
  return {
    importWallMs: result.importWallMs,
    lookupsDuring: during.length,
    failedLookups: refused.length,
    otherFailures: otherFailures.length,
    unavailableMs: refused.length === 0 ? 0 : since(refused.at(-1).repliedAt) - since(refused[0].startedAt),
    maxLookupMs: answered.length === 0 ? null : Math.max(...answered.map((entry) => entry.ms)),
    medianLookupMs: answered.length === 0 ? null : answered.map((entry) => entry.ms).sort((a, b) => a - b)[Math.floor(answered.length / 2)],
    newRevisionAfterMs: firstNew ? since(firstNew.repliedAt) : null,
    heapBeforeBytes: result.before.memory.heapBytes,
    heapPeakBytes: heapPeak,
    heapAfterBytes: result.after.memory.heapBytes,
    opfsTransientBytes: result.opfsPeak - result.before.opfsBytes,
    opfsAfterBytes: result.after.opfsBytes - result.before.opfsBytes,
    updatingReported: result.updatingReported,
    generationBefore: result.before.status.generation,
    generationAfter: result.after.status.generation,
    dictionaryCount: result.after.status.dictionaryCount,
    storageBackend: result.after.status.storageBackend,
    threaded: result.after.status.threaded,
  };
}

async function importThroughSettings(page, paths, expectedCount) {
  await page.evaluate(() => { location.hash = "add-dictionaries"; });
  await (await page.$("#import-file")).uploadFile(...paths);
  await page.waitForFunction((count) => document.getElementById("import-state").textContent
    === `Finished ${count} of ${count} archive${count === 1 ? "" : "s"} — ${count} imported, 0 failed.`,
  { timeout: 600_000, polling: 100 }, expectedCount);
}

async function sample(iteration) {
  const profile = mkdtempSync(resolve(tmpdir(), "hachidori-update-"));
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, protocolTimeout: 600_000,
    args: chromeArguments({ runtime: { extensionPath: resolve(source, "extension") } }, { allowNoSandbox: true }) });
  try {
    const worker = await browser.waitForTarget((target) => target.type() === "service_worker"
      && target.url().startsWith("chrome-extension://"));
    const id = new URL(worker.url()).host;
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(`chrome-extension://${id}/settings.html#add-dictionaries`);
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById("engine-status").textContent.startsWith("Ready"));
    for (const other of await browser.pages()) {
      if (other !== page && other.url().includes("startup.html")) await other.close();
    }
    let installed = 0;
    let targetRevision = 1;
    for (const count of counts) {
      await importThroughSettings(page, [
        ...others.slice(installed, count).map((entry) => entry.path),
        ...(installed === 0 ? [firstTargetPath] : []),
      ], count - installed + (installed === 0 ? 1 : 0));
      installed = count;
      // The engine settles (and, in Low memory mode, recycles) before the update.
      await page.waitForFunction(async (expected) => {
        const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
        return status.ok && status.ready && !status.loading && status.dictionaryCount >= expected;
      }, { timeout: 60_000, polling: 100 }, count);
      targetRevision += 1;
      const result = await measureUpdate(page, {
        archiveBase64: targetArchive(targetRevision).toString("base64"),
        fileName: archivePath === null ? `${TARGET_TITLE}.zip` : basename(updateArchivePath),
        revision: targetRevision, targetQuery, othersQuery: OTHERS_QUERY, intervalMs: lookupIntervalMs,
        synthetic: archivePath === null,
      });
      const target = result.after.state.dictionaries.find((entry) => entry.title === (archivePath === null ? TARGET_TITLE : result.importReport.title));
      const previous = result.before.state.dictionaries.find((entry) => entry.id === target?.id);
      assert.ok(target && previous && target.path !== previous.path, "the update must publish a new generation for the same package");
      assert.equal(result.after.lookup.ok, true, `the settled lookup failed: ${JSON.stringify(result.after.lookup)}`);
      assert.equal(result.after.state.dictionaries.filter((entry) => entry.id === target.id).length, 1, "the package must be listed once");
      if (archivePath === null) {
        assert.equal(target.revision, `rev-${targetRevision}`);
        const glossary = result.after.lookup.results[0].term.glossaries.map((entry) => entry.glossary).join("\n");
        assert.match(glossary, new RegExp(`"revision ${targetRevision}"`, "u"), "the settled lookup must answer from the new revision");
      }
      const summary = summarise(result, targetRevision, archivePath === null);
      assert.equal(summary.otherFailures, 0, `lookups failed for another reason: ${JSON.stringify(result.lookups.filter((entry) => !entry.ok))}`);
      appendJsonlDurable(resolve(output, "raw.jsonl"), { revision: definition.revision, iteration, count, targetRevision, ...summary });
      console.log(`sample ${iteration}: ${count} others: import ${summary.importWallMs.toFixed(0)} ms, `
        + `${summary.failedLookups}/${summary.lookupsDuring} lookups refused over ${summary.unavailableMs.toFixed(0)} ms, `
        + `slowest answered ${summary.maxLookupMs === null ? "none" : `${summary.maxLookupMs.toFixed(0)} ms`}, heap ${(summary.heapBeforeBytes / 1048576).toFixed(0)} -> `
        + `${(summary.heapPeakBytes / 1048576).toFixed(0)} MiB, transient OPFS ${(summary.opfsTransientBytes / 1048576).toFixed(1)} MiB`);
    }
  } finally {
    await closeBrowserVerified(browser);
    rmSync(profile, { recursive: true, force: true });
  }
}

for (let iteration = 1; iteration <= samples; iteration += 1) await sample(iteration);
console.log(`Raw timings and environment: ${output}`);
