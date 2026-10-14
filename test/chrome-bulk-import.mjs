/*
 * #578 in a real Chrome: a batch of 50 Yomitan archives, five of them large
 * frequency lists named after the ones the report lost, imports from Settings
 * on a fresh profile without one failure. Meanwhile a second Settings page
 * imports more archives at once, reloads the library, runs generation cleanup
 * and looks words up. Every import and change waits its turn and succeeds,
 * lookups keep answering, and the library ends with each dictionary exactly
 * once.
 *
 * test/run.mjs chrome-e2e runs it after the main scenario; on its own:
 *   node test/chrome-bulk-import.mjs
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTitledZip } from "./make-fixture.mjs";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const { config } = require("./package.json");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = resolve(ROOT, "extension");
const ARCHIVES = resolve(ROOT, "test/tmp/bulk-import");
const PROFILE = resolve(tmpdir(), `hachidori-bulk-import-profile-${process.pid}`);

const BATCH = 50;
// The archives the report saw fail after 0.0 seconds, as frequency lists.
const REPORTED = ["034-BCCWJ-LUW", "035-CC100", "036-JLPT", "037-Novels", "038-Wikipedia"];
const FREQUENCY_ROWS = 100_000;
const MARKERS = [".hoshidicts_6", ".hoshidicts_5"];

const SYLLABLES = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
function kana(value) {
  let out = "";
  do {
    out += SYLLABLES[value % SYLLABLES.length];
    value = Math.floor(value / SYLLABLES.length);
  } while (value > 0);
  return out;
}

// A term dictionary with its own word and the shared 辞書 every lookup asks for.
function termArchive(title, index) {
  return buildTitledZip(title, {
    revision: `bulk-${index}`,
    terms: [
      [`語${index}`, kana(index), "n", "", 10, [`bulk definition ${index}`], index + 1, ""],
      ["辞書", "じしょ", "n", "", 1, [`${title} entry`], 100_000 + index, ""],
    ],
  });
}

function frequencyArchive(title, index) {
  return buildTitledZip(title, {
    banks: false,
    revision: `bulk-${index}`,
    termMeta: Array.from({ length: FREQUENCY_ROWS }, (_, row) =>
      [`語${row}`, "freq", { value: row + 1, displayValue: String(row + 1) }]),
  });
}

const batch = Array.from({ length: BATCH }, (_, index) => {
  const number = String(index + 1).padStart(3, "0");
  const reported = REPORTED.find((title) => title.startsWith(`${number}-`));
  const title = reported ?? `${number}-Synthetic`;
  return { title, bytes: reported ? frequencyArchive(title, index) : termArchive(title, index) };
});
const extras = (prefix, count, offset) => Array.from({ length: count }, (_, index) => {
  const title = `${prefix}-${String(index + 1).padStart(2, "0")}`;
  return { title, base64: termArchive(title, offset + index).toString("base64") };
});
// Sent at once from a second page while the batch runs, then with lookups only,
// then between library reloads and generation cleanups.
const duringBatch = extras("concurrent", 10, 1000);
const alongsideLookups = extras("lookup-burst", 8, 2000);
const amongChanges = extras("mixed-burst", 4, 3000);

rmSync(ARCHIVES, { recursive: true, force: true });
mkdirSync(ARCHIVES, { recursive: true });
const paths = batch.map(({ title, bytes }) => {
  const path = resolve(ARCHIVES, `${title}.zip`);
  writeFileSync(path, bytes);
  return path;
});

const diagnostics = [];
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME || computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"),
    browser: Browser.CHROME, buildId: config.chrome }),
  enableExtensions: true,
  headless: true,
  userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
let passed = false;
try {
  browser.on("targetcreated", async (target) => {
    if (!target.url().endsWith("offscreen.html")) return;
    const cdp = await target.createCDPSession().catch(() => null);
    await cdp?.send("Runtime.enable");
    cdp?.on("Runtime.consoleAPICalled", (event) => diagnostics.push(`[offscreen] ${event.type}: `
      + event.args.map((arg) => arg.value ?? arg.description).join(" ")));
  });
  const worker = await browser.waitForTarget((target) => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  (await worker.worker())?.on("console", (message) => diagnostics.push(`[sw] ${message.text()}`));
  const settingsUrl = `chrome-extension://${extensionId}/settings.html`;

  // Two Settings pages open on the fresh profile at once, each of which first
  // migrates the empty library with hd_reload: the race #578 lost to.
  const [settings, other] = await Promise.all([browser.newPage(), browser.newPage()]);
  for (const page of [settings, other]) {
    page.on("console", (message) => diagnostics.push(`[settings] ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => diagnostics.push(`[settings] pageerror: ${error.message}`));
  }
  await Promise.all([
    settings.goto(`${settingsUrl}#add-dictionaries`, { waitUntil: "domcontentloaded" }),
    other.goto(settingsUrl, { waitUntil: "domcontentloaded" }),
  ]);
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();

  // Every status a row shows, so a refusal or a wait cannot pass unseen.
  await settings.evaluate(() => {
    const seen = { waiting: new Set(), refused: [] };
    globalThis.bulkImportSeen = seen;
    new MutationObserver(() => {
      for (const [index, status] of document.querySelectorAll("#import-progress .setup-dictionary-status").entries()) {
        if (status.textContent.startsWith("Waiting for the previous import to finish")) seen.waiting.add(index);
        if (/busy|failed/iu.test(status.textContent)) seen.refused.push(status.textContent);
      }
    }).observe(document.getElementById("import-progress"), { subtree: true, childList: true, characterData: true });
  });

  // Imports archives from the second page all at once, each its own hd_import.
  const importAtOnce = (archives) => other.evaluate((items) => Promise.all(items.map(async ({ title, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `bulk-${title}`, blobUrl, fileName: `${title}.zip` });
      return { title, ok: reply?.ok === true && reply.report?.success === true, error: reply?.error ?? null };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  })), archives);
  // Looks up 辞書 from the second page until stopped: every reply is counted,
  // and one that never comes is counted as hung rather than stalling the run.
  const startLookups = () => other.evaluate(() => {
    const counts = { ok: 0, hits: 0, refused: 0, hung: 0, other: [] };
    globalThis.bulkLookups = { counts, running: true };
    globalThis.bulkLookups.done = (async () => {
      while (globalThis.bulkLookups.running) {
        const reply = await Promise.race([
          chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "bulk-lookup",
            text: "辞書" }),
          new Promise((resolveTimeout) => { setTimeout(() => resolveTimeout({ hung: true }), 30_000); }),
        ]);
        if (reply?.hung) counts.hung += 1;
        else if (reply?.ok === true) {
          counts.ok += 1;
          if (reply.results?.length > 0) counts.hits += 1;
        } else if (reply?.errorCode === "engine-mutating") counts.refused += 1;
        else counts.other.push(reply?.error ?? JSON.stringify(reply));
        await new Promise((resolveTick) => { setTimeout(resolveTick, 5); });
      }
      return counts;
    })();
  });
  const stopLookups = () => other.evaluate(() => {
    globalThis.bulkLookups.running = false;
    return globalThis.bulkLookups.done;
  });

  const started = Date.now();
  await (await settings.$("#import-file")).uploadFile(...paths);
  // A tenth of the way in, ten more imports arrive at once from the other page.
  await settings.waitForFunction(() => document.getElementById("import-state").textContent.includes("(10 of 50)"),
    { timeout: 120_000, polling: 50 });
  await startLookups();
  const concurrent = await importAtOnce(duringBatch);
  const finished = await settings.waitForFunction(() => {
    const text = document.getElementById("import-state").textContent;
    return text.startsWith("Finished 50 of 50") || text.startsWith("Import cancelled") ? text : false;
  }, { timeout: 15 * 60_000, polling: 100 }).then((handle) => handle.jsonValue());
  const batchSeconds = (Date.now() - started) / 1000;
  const lookupsDuringBatch = await stopLookups();
  const rows = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map((row) => ({ name: row.querySelector(".setup-dictionary-name").textContent,
      status: row.querySelector(".setup-dictionary-status").textContent })));
  const seen = await settings.evaluate(() => ({ waiting: [...globalThis.bulkImportSeen.waiting],
    refused: globalThis.bulkImportSeen.refused }));

  assert.equal(finished, "Finished 50 of 50 archives — 50 imported, 0 failed.", JSON.stringify(rows));
  assert.deepEqual(rows.map(({ name }) => name), batch.map(({ title }) => `${title}.zip`));
  for (const [index, { status }] of rows.entries()) {
    assert.match(status, new RegExp(`^Imported ${batch[index].title} in \\d+(?:\\.\\d)? seconds: `, "u"));
  }
  assert.deepEqual(seen.refused, [], "no row ever reported a busy engine or a failure");
  assert.ok(seen.waiting.length > 0, "an archive that met the concurrent imports waited for them");
  console.log(`ok - 50 of 50 archives imported from Settings in ${batchSeconds.toFixed(1)} s, `
    + `including ${REPORTED.join(", ")} (${FREQUENCY_ROWS.toLocaleString("en")} frequency rows each); `
    + `${seen.waiting.length} waited for the engine`);
  assert.deepEqual(concurrent.filter(({ ok }) => !ok), [], "every import sent at once from another page succeeds");
  console.log(`ok - ${concurrent.length} imports sent at once from another page during the batch all succeeded`);
  assert.deepEqual(lookupsDuringBatch.other, []);
  assert.equal(lookupsDuringBatch.hung, 0);
  assert.ok(lookupsDuringBatch.hits > 0, JSON.stringify(lookupsDuringBatch));
  console.log(`ok - lookups kept answering during the batch: ${JSON.stringify(lookupsDuringBatch)}`);

  // Imports alone never hold the engine against reads on the primary path.
  await startLookups();
  const burst = await importAtOnce(alongsideLookups);
  const lookupsDuringImports = await stopLookups();
  assert.deepEqual(burst.filter(({ ok }) => !ok), []);
  assert.deepEqual(lookupsDuringImports, { ...lookupsDuringImports, refused: 0, hung: 0, other: [] });
  assert.ok(lookupsDuringImports.hits > 0, JSON.stringify(lookupsDuringImports));
  console.log(`ok - ${burst.length} concurrent imports while looking up: ${JSON.stringify(lookupsDuringImports)}`);

  // Library reloads and generation cleanup take their turns between imports;
  // reads they hold the engine against are refused at once, as before.
  await startLookups();
  const changes = await other.evaluate((items) => {
    const send = (type, fields = {}) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type,
      requestId: `bulk-${type}-${crypto.randomUUID()}`, ...fields });
    const importArchive = async ({ title, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      try {
        return { title, reply: await send("hd_import", { blobUrl, fileName: `${title}.zip` }) };
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    };
    return Promise.all([
      importArchive(items[0]), send("hd_reload").then((reply) => ({ title: "hd_reload", reply })),
      importArchive(items[1]), send("hd_backup_auto_cleanup").then((reply) => ({ title: "hd_backup_auto_cleanup", reply })),
      importArchive(items[2]), send("hd_reload").then((reply) => ({ title: "hd_reload", reply })),
      importArchive(items[3]),
    ].map((pending) => pending.then(({ title, reply }) => ({ title, ok: reply?.ok === true
      && (reply.type !== "hd_import_result" || reply.report?.success === true), error: reply?.error ?? null }))));
  }, amongChanges);
  const lookupsAmongChanges = await stopLookups();
  assert.deepEqual(changes.filter(({ ok }) => !ok), [], JSON.stringify(changes));
  assert.deepEqual(lookupsAmongChanges.other, []);
  assert.equal(lookupsAmongChanges.hung, 0);
  console.log(`ok - imports, reloads and cleanups sent at once all succeeded: ${JSON.stringify(lookupsAmongChanges)}`);

  // Each archive is in the library once, its files on disk, its words found.
  const expected = [...batch, ...duringBatch, ...alongsideLookups, ...amongChanges].map(({ title }) => title);
  const library = await settings.evaluate(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const root = await navigator.storage.getDirectory();
    const files = async (path) => {
      let directory = root;
      for (const name of path.split("/").filter(Boolean).slice(1)) directory = await directory.getDirectoryHandle(name);
      const names = [];
      for await (const name of directory.keys()) names.push(name);
      return names;
    };
    return Promise.all(dictionaryState.dictionaries.map(async ({ id, title, enabled, path }) =>
      ({ id, title, enabled, files: await files(path).catch((error) => [String(error)]) })));
  });
  assert.deepEqual(library.map(({ title }) => title).sort(), [...expected].sort(), "no dictionary is lost or duplicated");
  assert.equal(new Set(library.map(({ id }) => id)).size, expected.length);
  for (const dictionary of library) {
    assert.equal(dictionary.enabled, true);
    assert.ok(dictionary.files.some((name) => MARKERS.includes(name)) && dictionary.files.includes("hash.table"),
      `${dictionary.title} is complete on disk: ${dictionary.files}`);
  }
  const lookup = (text) => other.evaluate((query) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
    type: "hd_lookup", requestId: `bulk-final-${query}`, text: query }), text);
  for (const [text, expectedText] of [["語0", "bulk definition 0"], ["語49", "bulk definition 49"],
    ["語1009", "bulk definition 1009"], ["語3003", "bulk definition 3003"], ["語7", "035-CC100"]]) {
    const reply = await lookup(text);
    assert.ok(reply?.ok === true && JSON.stringify(reply.results).includes(expectedText), `${text}: ${JSON.stringify(reply)}`);
  }
  console.log(`ok - the library holds each of the ${expected.length} dictionaries once, complete on disk, and finds their words`);
  passed = true;
} finally {
  await browser.close();
  rmSync(ARCHIVES, { recursive: true, force: true });
  if (passed) {
    rmSync(PROFILE, { recursive: true, force: true });
    console.log("PASS: bulk dictionary imports wait their turn instead of failing (#578)");
  } else {
    console.log(`profile kept for inspection: ${PROFILE}\nbrowser diagnostics (last 60):`);
    for (const line of diagnostics.slice(-60)) console.log(`  ${line}`);
  }
}
