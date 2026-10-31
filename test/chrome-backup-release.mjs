/*
 * A backup from the released build restores in this checkout, and this
 * checkout's own backup restores again, in real Chrome.
 *
 * Released build: the Chrome ZIP of RELEASE, downloaded from GitHub and
 * checked against its SHA256SUMS line and the hash pinned here, imports
 * dictionaries, edits its library, personal source, update schedules and
 * settings through its own Settings page and revisioned writes, looks words up,
 * marks their status, and exports a backup through a real Chrome download.
 * Released backup: this checkout restores that file through Settings in a fresh
 * profile; every item must equal the released build's, or differ only by a
 * rule the code documents, and work in a real popup. New backup: that profile
 * picks the newest Reveal choice its Settings offer, exports, and a second fresh
 * profile restores it exactly. Hachidori has no profiles to cover (AGENTS.md
 * keeps L1 profiles out of scope).
 *
 *   node test/run.mjs chrome-backup-release
 *
 * It downloads a GitHub release, so it is not in the pull-request CI matrix;
 * run it before a release PR (.kiro/skills/cut-release/SKILL.md). See
 * test/README.md for the environment variables.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { openBackupArchive } from "../extension/backup-archive.js";
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader } from "../extension/vendor/zip.js";
import { AnkiConnectError, answerAnkiConnect } from "./anki-connect-fake.mjs";
import { hoverForPopup, popupReader } from "./chrome-e2e/popup-reader.mjs";
import {
  buildFixtureZip, buildGenericKanjiZip, buildTitledZip, buildTrainedZip, GENERIC_KANJI_GLOSSARY,
  GENERIC_KANJI_TITLE, TITLE as FIXTURE_TITLE, TRAINED_TITLE,
} from "./make-fixture.mjs";

// The release whose backups this checkout must restore; move it to each new
// release once its assets are published. HACHIDORI_BACKUP_RELEASE names
// another as "<version> <12-digit commit> <SHA-256 of its Chrome ZIP>", and
// HACHIDORI_BACKUP_RELEASE_ZIP uses a local copy of that ZIP, with the
// release's SHA256SUMS file beside it, instead of the download.
const [RELEASE_VERSION, RELEASE_COMMIT, RELEASE_SHA256] = (process.env.HACHIDORI_BACKUP_RELEASE
  || "0.3.2 4745397e8188 39af65baa6a823bb1cd83adb12d3239651b9b4930ded1cceb1fcff1468feaaf9").split(/\s+/u);
const RELEASE_ASSET = `hachidori-${RELEASE_VERSION}-${RELEASE_COMMIT}-chrome.zip`;
const RELEASE_SUMS = `hachidori-${RELEASE_VERSION}-${RELEASE_COMMIT}-SHA256SUMS.txt`;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = resolve(ROOT, "extension");
const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { config } = require("./package.json");
const puppeteerModule = await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER || require.resolve("puppeteer-core")).href);
const puppeteer = puppeteerModule.default?.launch ? puppeteerModule.default : puppeteerModule;
const { Browser, computeExecutablePath } = await import(require.resolve("@puppeteer/browsers"));
const CHROME = process.env.HACHIDORI_CHROME
  || computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: config.chrome });
// The downloaded release stays cached; everything else is this run's own.
const CACHE = resolve(ROOT, "test/tmp/releases", RELEASE_VERSION);
const SCRATCH = resolve(ROOT, "test/tmp/backup-release", String(process.pid));
// Named like chrome-e2e's profile, so CI's failure upload would collect them.
const profile = leg => resolve(tmpdir(), `hachidori-e2e-profile-backup-release-${leg}-${process.pid}`);

const FREQUENCY_TITLE = "Round-trip frequency list";
const SORTING_TITLE = "Round-trip sorting terms";
const FIXTURE_ALIAS = "Round-trip alias";
const GROUP_NAME = "Round trip";
const SORTED = "頻度語";
const SORTED_RANKS = { あ: 20, い: 10, う: 30 };
const INDEX_URL = "https://example.test/round-trip-frequency/index.json";
const FREQUENCY_REVISION = "round-trip-1";
const PERSONAL_SOURCE = "# Kept across releases\n往復, おうふく, a round trip\n猫舌, ねこじた, sensitive to hot food\\nいつも熱いものが苦手\n";
const ANKI_PATH = "/anki-connect";
const ANKI_API_KEY = "round-trip-key";
const ANKI_DECK = "Hachidori round trip";
const CUSTOM_CSS = ".gsm-hoshidicts-popup { outline-color: rgb(12, 34, 56); }";
const ARCHIVES = [
  ["hachidori-fixture.zip", buildFixtureZip()],
  ["round-trip-frequency.zip", buildTitledZip(FREQUENCY_TITLE, {
    banks: false, frequencyMode: "rank-based", revision: FREQUENCY_REVISION,
    indexUrl: INDEX_URL, downloadUrl: "https://example.test/round-trip-frequency.zip", indexOverrides: { isUpdatable: true },
    termMeta: [["食べる", "freq", { reading: "たべる", frequency: { value: 1200, displayValue: "1200" } }],
      ...Object.entries(SORTED_RANKS).map(([reading, value]) => [SORTED, "freq", { reading, frequency: value }])],
  })],
  ["round-trip-sorting.zip", buildTitledZip(SORTING_TITLE, { terms: Object.keys(SORTED_RANKS).map((reading, index) =>
    [SORTED, reading, "", "", 30 - index * 10, [`sorted reading ${reading}`], index + 1, ""]) })],
  ["hachidori-generic-kanji-fixture.zip", buildGenericKanjiZip()],
  ["hachidori-fixture-trained.zip", buildTrainedZip()],
];
const READING_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Hachidori backup round trip</title>
<style>body { font: 32px/2 serif; padding: 60px; } span { display: inline-block; }</style></head>
<body>
  <p><span id="verb">食べたかった</span></p>
  <p><span id="kanji">漢字</span>と<span id="read">読む</span></p>
  <p><span id="thanks">ありがとう</span></p>
  <p><span id="ranked">頻度語</span></p>
  <p><span id="personal">往復</span>、<span id="multibyte">猫舌</span></p>
</body></html>`;
// word-highlights.js registers each status's marks as hd-word-<status>.
const WORD_HIGHLIGHT_PREFIX = /`(hd-word-)\$\{status\}`/u.exec(readFileSync(resolve(EXTENSION, "word-highlights.js"), "utf8"))?.[1];

const RELEASED = {
  download: "the released Chrome ZIP has the pinned SHA-256 that its published SHA256SUMS line lists",
  loads: "the released build loads from its unpacked ZIP in a fresh profile and reports its version",
  imports: "the released build imports five dictionaries through its Settings file input",
  library: "the released build's Settings alias, disable, favourite, reorder and group dictionaries",
  personal: "the released build saves a personal source with a multibyte entry through Settings",
  updates: "the released build checks its managed dictionary and saves global and per-dictionary schedules",
  settings: "the released build saves changed Reading, Design, Audio, Anki, Keybind, Backup and Experimental settings",
  lookups: "the released build counts hovered lookups and marks one word known and one ignored from its popup",
  export: "the released build exports a version 3 backup of its complete state through a real Chrome download",
};
// Checked once for the released backup and once for this checkout's own.
const RESTORED = {
  preview: "the backup previews every dictionary without a skipped-settings warning",
  restore: "Replace and restore reports success and advances every local revision on fresh generations",
  dictionaries: "dictionaries keep their IDs, titles, order, aliases, enabled state, favourites, groups and update metadata",
  options: "every option equals the backup's, or differs only by a documented rule",
  state: "the personal source, update schedule, word status and lookup counts equal the backup's",
  settings: "Settings shows the restored choices and a real alarm follows the restored schedules",
  lookup: "a popup shows the fixture's definitions, structured content, media, pitch and the frequency list's value with the restored Design",
  sorting: "frequency sorting orders 頻度語 by the frequency list's ranks in the restored descending order",
  kanji: "a clicked kanji opens the selected term dictionary and native kanji lookup answers",
  personal: "personal entries, including the multibyte one, are looked up in the popup",
  counts: "the popup shows the restored lookup count and the next lookup increments it",
  blur: "definition blur follows the restored threshold and Reveal choice in a real popup",
  wordStatus: "word status shows in the popup and marks the page",
  anki: "a mined note uses the restored AnkiConnect URL, API key, deck, note type, fields, tags and duplicate scope",
};
const NEW_BUILD = {
  settings: "this checkout saves its newest Reveal choice and frequency average settings before exporting",
  export: "this checkout exports a version 3 backup of its complete state through a real Chrome download",
};
const LEGS = { released: "released backup", current: "new backup" };
const PLANNED = [
  ...Object.values(RELEASED),
  ...Object.values(LEGS).flatMap(leg => Object.values(RESTORED).map(name => `${leg}: ${name}`)),
  ...Object.values(NEW_BUILD),
];

// The fixed denominator, as in test/chrome-e2e/harness.mjs: a planned check
// that never ran fails, and an unplanned or repeated one is a harness fault.
const results = new Map();
const failures = [];
const diagnostics = [];
function check(name, ok, detail = "") {
  if (!PLANNED.includes(name)) throw new Error(`check("${name}") is not in PLANNED`);
  if (results.has(name)) throw new Error(`check("${name}") ran twice`);
  results.set(name, { ok: Boolean(ok), detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       ${detail}`}`);
}
const note = line => {
  diagnostics.push(line);
  if (diagnostics.length > 300) diagnostics.shift();
};

// Bounded polling of observable state; returns the last value read.
async function until(read, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    value = await read();
  }
  return value;
}

// The release ZIP, from the cache or GitHub, unpacked with the zip.js the
// extension already vendors.
async function releasedExtension() {
  const local = process.env.HACHIDORI_BACKUP_RELEASE_ZIP;
  const cached = async name => {
    const path = resolve(CACHE, name);
    if (!existsSync(path)) {
      const url = `https://github.com/bee-san/hachidori/releases/download/${RELEASE_VERSION}/${name}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    }
    return readFileSync(path);
  };
  const zip = local ? readFileSync(local) : await cached(RELEASE_ASSET);
  const sums = String(local ? readFileSync(resolve(dirname(local), RELEASE_SUMS)) : await cached(RELEASE_SUMS));
  const listed = sums.split("\n").map(line => line.trim().split(/\s+/u)).find(([, name]) => name === RELEASE_ASSET)?.[0];
  const actual = createHash("sha256").update(zip).digest("hex");
  check(RELEASED.download, actual === RELEASE_SHA256 && listed === RELEASE_SHA256,
    JSON.stringify({ asset: local ?? RELEASE_ASSET, actual, pinned: RELEASE_SHA256, listed }));
  if (actual !== RELEASE_SHA256) throw new Error(`${RELEASE_ASSET} does not have the pinned SHA-256`);
  const directory = resolve(SCRATCH, `hachidori-${RELEASE_VERSION}`);
  const reader = new ZipReader(new BlobReader(new Blob([zip])), { useWebWorkers: false });
  try {
    for (const entry of await reader.getEntries()) {
      const path = resolve(directory, entry.filename);
      mkdirSync(entry.directory ? path : dirname(path), { recursive: true });
      if (!entry.directory) writeFileSync(path, await entry.getData(new Uint8ArrayWriter()));
    }
  } finally {
    await reader.close();
  }
  return directory;
}

// AnkiConnect on the page server: a collection with no notes until one is
// mined, which requires the configured API key on every request.
const anki = { notes: [], media: new Set(), unexpected: [], keys: new Set() };
async function answerAnki(action, params, request) {
  anki.keys.add(request.key ?? null);
  if (request.key !== ANKI_API_KEY) throw new AnkiConnectError("valid api key must be provided");
  switch (action) {
    case "version": return 6;
    case "requestPermission": return { permission: "granted", requireApikey: true, version: 6 };
    case "deckNames": return ["Default", ANKI_DECK, "Hachidori sentences"];
    case "modelNames": return ["Basic"];
    case "modelNamesAndIds": return { Basic: 1 };
    case "modelFieldNames": return ["Front", "Back", "Reading", "Sentence"];
    case "findNotes": case "findCards": return [];
    case "notesInfo": case "cardsInfo": return [];
    case "canAddNotes": return params.notes.map(() => true);
    case "canAddNotesWithErrorDetail": return params.notes.map(() => ({ canAdd: true, error: null }));
    // Hachidori asks for each exact generated name.
    case "getMediaFilesNames": return anki.media.has(params.pattern) ? [params.pattern] : [];
    case "storeMediaFile": anki.media.add(params.filename); return params.filename;
    case "addNote": anki.notes.push(params.note); return anki.notes.length;
    default:
      anki.unexpected.push(action);
      throw new AnkiConnectError(`the round-trip fake does not answer ${action}`);
  }
}

const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === ANKI_PATH) {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const reply = await answerAnkiConnect(JSON.parse(body), answerAnki);
      response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify(reply));
    })().catch(error => {
      note(`[anki] ${error?.stack ?? error}`);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: null, error: String(error) }));
    });
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(READING_PAGE);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;
const ANKI_URL = new URL(ANKI_PATH, PAGE_URL).href;

// The managed dictionary's update index is answered on the service-worker
// target; every other example.test request and a real AnkiConnect on its
// default port are refused there and on the offscreen document.
const indexRequests = [];
function watch(browser, label) {
  const attached = new WeakSet();
  const consider = async target => {
    const offscreen = target.url().endsWith("/offscreen.html");
    if (attached.has(target) || !(offscreen || target.type() === "service_worker")) return;
    attached.add(target);
    try {
      const session = await target.createCDPSession();
      const name = `${label} ${offscreen ? "offscreen" : "worker"}`;
      session.on("Runtime.consoleAPICalled", event => note(`[${name}] ${event.type}: `
        + event.args.map(arg => arg.value ?? arg.description).join(" ")));
      session.on("Runtime.exceptionThrown", event => note(`[${name}] exception: `
        + (event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text)));
      session.on("Fetch.requestPaused", ({ requestId, request }) => void (async () => {
        if (request.url === INDEX_URL) {
          indexRequests.push(label);
          await session.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "application/json" }],
            body: Buffer.from(JSON.stringify({ title: FREQUENCY_TITLE, revision: FREQUENCY_REVISION, format: 3 })).toString("base64") });
        } else {
          await session.send("Fetch.failRequest", { requestId,
            errorReason: request.url.startsWith("http://127.0.0.1:8765/") ? "ConnectionRefused" : "Failed" });
        }
      })().catch(error => note(`[${name} fetch] ${error?.message ?? error}`)));
      await session.send("Runtime.enable");
      await session.send("Fetch.enable", { patterns: ["http://127.0.0.1:8765/*", "https://example.test/*"]
        .map(urlPattern => ({ urlPattern, requestStage: "Request" })) });
    } catch (error) {
      note(`[${label}] could not attach to ${target.url()}: ${error?.message ?? error}`);
    }
  };
  browser.on("targetcreated", target => void consider(target));
  browser.on("targetchanged", target => void consider(target));
  for (const target of browser.targets()) void consider(target);
}

// A fresh profile with one extension, its first-run tab closed, Settings open
// with the engine settled and sharing off (it is not backup content).
async function openBrowser(extension, profileDirectory, label) {
  rmSync(profileDirectory, { recursive: true, force: true });
  mkdirSync(profileDirectory, { recursive: true });
  const args = ["--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`];
  if (process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1") args.push("--no-sandbox");
  const browser = await puppeteer.launch({ executablePath: CHROME, enableExtensions: true, headless: true,
    userDataDir: profileDirectory, args });
  watch(browser, label);
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"), { timeout: 30_000 });
  const id = new URL(worker.url()).host;
  const startup = await browser.waitForTarget(target => target.url() === `chrome-extension://${id}/startup.html`,
    { timeout: 30_000 });
  await (await startup.page())?.close();
  const settings = await browser.newPage();
  settings.on("console", message => note(`[${label} settings] ${message.type()}: ${message.text()}`));
  settings.on("pageerror", error => note(`[${label} settings] pageerror: ${error.message}`));
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  await settings.bringToFront();
  await settings.waitForFunction(() => /ready|no dictionaries/iu.test(document.getElementById("engine-status")?.textContent ?? ""),
    { timeout: 90_000, polling: 100 });
  const sharing = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hachidori-sharing",
    type: "hd_sharing_host_disable", requestId: "backup-release-sharing-off" }));
  if (sharing?.ok !== true) throw new Error(`sharing could not be turned off: ${sharing?.error}`);
  return { browser, settings, id };
}

// Settings shows its section picker on a narrow page and links otherwise.
async function showSection(page, id) {
  await page.evaluate(section => {
    const picker = document.getElementById("settings-section");
    if (picker.checkVisibility()) {
      picker.value = section;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else document.querySelector(`.settings-nav a[href="#${section}"], .section-tabs a[href="#${section}"]`).click();
  }, id);
  await page.waitForFunction(section => {
    const visible = [...document.querySelectorAll("main > section")].filter(node => !node.hidden);
    return visible.length === 1 && visible[0].id === section;
  }, { timeout: 30_000, polling: 100 }, id);
}

// Edit one section's option controls as a reader does, then wait for autosave.
async function editControls(page, values) {
  await showSection(page, await page.$eval(`#${Object.keys(values)[0]}`, input => input.closest("main > section").id));
  await page.evaluate(changes => {
    for (const [id, value] of Object.entries(changes)) {
      const input = document.getElementById(id);
      for (let parent = input.closest("details"); parent; parent = parent.parentElement.closest("details")) parent.open = true;
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, values);
  await page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
    { timeout: 15_000, polling: 100 });
}

// The build's own revisioned options write, for values Settings edits in a
// dialog-like editor (Anki templates, keybinds, audio sources, buttons, CSS).
const writeOptions = (page, patch) => page.evaluate(async changes => {
  const { options } = await chrome.storage.local.get("options");
  const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
    baseRevision: options?.revision ?? 0, options: changes });
  if (!reply.ok) throw new Error(reply.error);
}, patch);

// The complete backup payload as the build reads it, with its own view of the
// options and its defaults.
const readBackup = page => page.evaluate(async () => {
  const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_backup_read" });
  if (!reply.ok) throw new Error(reply.error);
  return { snapshot: reply.snapshot, rows: reply.lookupStatsRows,
    view: HDReaderOptions.normaliseOptions(reply.snapshot.options), defaults: HDReaderOptions.DEFAULT_OPTIONS };
});

const byTitle = (snapshot, title) => snapshot.state.dictionaries.find(dictionary => dictionary.title === title);
const row = (rows, term) => rows.find(entry => entry.term === term);

async function exportBackup(browser, page, directory) {
  mkdirSync(directory, { recursive: true });
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
  try {
    await showSection(page, "backup");
    await page.bringToFront();
    await page.click("#backup-export");
    const status = await page.waitForFunction(() => {
      const output = document.getElementById("backup-status");
      return /Download started|cancelled/u.test(output.textContent) || output.classList.contains("is-error")
        ? output.textContent : false;
    }, { timeout: 120_000, polling: 100 }).then(handle => handle.jsonValue());
    if (!/Download started/u.test(status)) throw new Error(`the export did not start: ${status}`);
    const download = await page.waitForFunction(async () => {
      const [entry] = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 });
      const tracked = (await chrome.storage.session.get("backupDownloads")).backupDownloads ?? {};
      return entry?.state === "complete" && Object.keys(tracked).length === 0 ? entry : false;
    }, { timeout: 60_000, polling: 100 }).then(handle => handle.jsonValue());
    return download.filename;
  } finally {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

// The archive's own manifest and what this checkout's reader makes of it.
async function readArchive(path) {
  const bytes = readFileSync(path);
  const reader = new ZipReader(new BlobReader(new Blob([bytes])), { useWebWorkers: false });
  let manifest;
  try {
    const entry = (await reader.getEntries()).find(candidate => candidate.filename === "hachidori-backup.json");
    manifest = JSON.parse(await entry.getData(new TextWriter()));
  } finally {
    await reader.close();
  }
  return { manifest, parsed: await openBackupArchive(new Blob([bytes])) };
}

function exportedCompletely(archive, source) {
  const ordinals = new Set(archive.parsed.files.map(file => file.path.split("/")[1]));
  return archive.manifest.format === "hachidori-backup" && archive.manifest.version === 3
    && isDeepStrictEqual(archive.parsed.snapshot, source.snapshot)
    && isDeepStrictEqual(archive.parsed.lookupStatsRows, source.rows)
    && ordinals.size === source.snapshot.state.dictionaries.length
    && archive.parsed.files.some(file => file.path.endsWith("/media.bin"));
}

// A fresh lookup of one word, once its count line has been painted.
async function lookUp(tab, popup, selector, expression) {
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  const state = await hoverForPopup(tab, popup, selector, { accept: value => value.plain.includes(expression) });
  if (state === null) return null;
  const blur = await until(() => popup.definitionBlur(), value => /Looked up \d+/u.test(value?.countText ?? ""));
  return { state, blur, count: Number(/Looked up (\d+)/u.exec(blur?.countText ?? "")?.[1] ?? Number.NaN) };
}

// --------------------------------------------------------------- released build

async function releasedLeg() {
  const extension = await releasedExtension();
  const { browser, settings } = await openBrowser(extension, profile("released"), "released");
  try {
    const version = await settings.evaluate(() => chrome.runtime.getManifest().version);
    check(RELEASED.loads, version === RELEASE_VERSION, JSON.stringify({ version, expected: RELEASE_VERSION }));

    mkdirSync(SCRATCH, { recursive: true });
    const archivePaths = ARCHIVES.map(([name, bytes]) => {
      const path = resolve(SCRATCH, name);
      writeFileSync(path, bytes);
      return path;
    });
    await showSection(settings, "add-dictionaries");
    await (await settings.$("#import-file")).uploadFile(...archivePaths);
    const importState = await settings.waitForFunction(() => {
      const text = document.getElementById("import-state")?.textContent.trim() ?? "";
      return text.startsWith("Finished") ? text : false;
    }, { timeout: 180_000, polling: 250 }).then(handle => handle.jsonValue());
    const imported = (await readBackup(settings)).snapshot;
    const titles = [FIXTURE_TITLE, FREQUENCY_TITLE, SORTING_TITLE, GENERIC_KANJI_TITLE, TRAINED_TITLE];
    check(RELEASED.imports, importState === "Finished 5 of 5 archives — 5 imported, 0 failed."
      && titles.every(title => byTitle(imported, title)?.enabled === true)
      && byTitle(imported, FREQUENCY_TITLE).termCount === 0 && byTitle(imported, FREQUENCY_TITLE).frequencyCount === 4,
    JSON.stringify({ importState, dictionaries: imported.state.dictionaries.map(({ title, termCount, frequencyCount }) =>
      ({ title, termCount, frequencyCount })) }));

    const ids = Object.fromEntries(titles.map(title => [title, byTitle(imported, title).id]));
    // Check now first, so the schedules' next due time is a day away, not now.
    await showSection(settings, "updates");
    await settings.waitForFunction(() => !document.getElementById("update-check-now").disabled
      && !document.getElementById("update-schedule").disabled, { timeout: 30_000, polling: 100 });
    await settings.click("#update-check-now");
    await settings.waitForFunction(async title => (await chrome.storage.local.get("dictionaryState")).dictionaryState
      .dictionaries.find(dictionary => dictionary.title === title)?.lastUpdateCheck?.status === "up-to-date",
    { timeout: 30_000, polling: 100 }, FREQUENCY_TITLE);
    await showSection(settings, "dictionaries");
    // Each control the way Settings offers it, waiting for its committed state.
    const library = await settings.evaluate(async plan => {
      const read = async () => chrome.storage.local.get(["dictionaryState", "dictionaryUpdates"]);
      const settle = async (what, matches) => {
        const deadline = Date.now() + 20_000;
        for (;;) {
          const { dictionaryState: state, dictionaryUpdates: updates } = await read();
          const value = matches(state, updates);
          if (value) return value;
          if (Date.now() > deadline) throw new Error(`${what} did not settle: ${JSON.stringify({ state, updates })}`);
          await new Promise(resolveWait => setTimeout(resolveWait, 50));
        }
      };
      const dictionaryRow = id => document.querySelector(`#dict-list .dict-row[data-dictionary-id="${id}"]`);
      const entry = (state, id) => state.dictionaries.find(dictionary => dictionary.id === id);
      const choose = (control, value) => {
        control.value = value;
        control.dispatchEvent(new Event("change", { bubbles: true }));
      };
      for (const id of [plan.aliased, plan.managed]) dictionaryRow(id).querySelector(".dict-details").open = true;
      choose(dictionaryRow(plan.aliased).querySelector(".dict-display-name"), plan.alias);
      await settle("the alias", state => entry(state, plan.aliased)?.displayName === plan.alias);
      choose(dictionaryRow(plan.managed).querySelector(".dict-update-schedule"), "daily");
      await settle("the dictionary's schedule", state => entry(state, plan.managed)?.updateScheduleOverride === "daily");
      choose(document.getElementById("update-schedule"), "weekly");
      await settle("the default schedule", (_state, updates) => updates?.schedule === "weekly");
      dictionaryRow(plan.disabled).querySelector(".dict-enabled").click();
      await settle("disabling", state => entry(state, plan.disabled)?.enabled === false);
      dictionaryRow(plan.favourite).querySelector(".dict-selected").click();
      await settle("the selection", () => !document.getElementById("dict-bulk-favorite").disabled);
      document.getElementById("dict-bulk-favorite").click();
      await settle("the favourite", state => entry(state, plan.favourite)?.favorite === true);
      dictionaryRow(plan.favourite).querySelector(".dict-selected").click();
      const before = (await read()).dictionaryState.dictionaries.map(dictionary => dictionary.id);
      const moved = before[2];
      dictionaryRow(moved).querySelector(".dict-up").click();
      const after = await settle("the move", state => state.dictionaries[1].id === moved
        && state.dictionaries.map(dictionary => dictionary.id));
      document.getElementById("dict-group-name-new").value = plan.group;
      document.getElementById("dict-group-create").click();
      const groupId = await settle("the group", state => state.groups?.length === 1
        && document.querySelector(`#dict-group-list .dict-group[data-group-id="${state.groups[0].id}"]`)
        && state.groups[0].id);
      for (const member of plan.members) {
        const group = document.querySelector(`#dict-group-list .dict-group[data-group-id="${groupId}"]`);
        group.querySelector(".dict-group-add-select").value = member;
        group.querySelector(".dict-group-add").click();
        await settle("a group member", state => state.groups[0].dictionaryIds.includes(member));
      }
      return { before, after, groupId };
    }, { aliased: ids[FIXTURE_TITLE], alias: FIXTURE_ALIAS, managed: ids[FREQUENCY_TITLE], disabled: ids[TRAINED_TITLE],
      favourite: ids[SORTING_TITLE], group: GROUP_NAME, members: [ids[FIXTURE_TITLE], ids[GENERIC_KANJI_TITLE]] });
    const edited = (await readBackup(settings)).snapshot;
    check(RELEASED.library, byTitle(edited, FIXTURE_TITLE).displayName === FIXTURE_ALIAS
      && byTitle(edited, TRAINED_TITLE).enabled === false && byTitle(edited, SORTING_TITLE).favorite === true
      && isDeepStrictEqual(library.after, [library.before[0], library.before[2], library.before[1], ...library.before.slice(3)])
      && isDeepStrictEqual(edited.state.dictionaries.map(dictionary => dictionary.id), library.after)
      && isDeepStrictEqual(edited.state.groups, [{ id: library.groupId, name: GROUP_NAME,
        dictionaryIds: [ids[FIXTURE_TITLE], ids[GENERIC_KANJI_TITLE]] }]),
    JSON.stringify({ library, groups: edited.state.groups }));
    const managed = byTitle(edited, FREQUENCY_TITLE);
    check(RELEASED.updates, managed.isUpdatable === true && managed.indexUrl === INDEX_URL
      && managed.lastUpdateCheck?.status === "up-to-date" && managed.lastUpdateCheck.remoteRevision === FREQUENCY_REVISION
      && managed.updateScheduleOverride === "daily" && edited.updates.schedule === "weekly"
      && typeof edited.updates.lastCheckedAt === "string" && indexRequests.length === 1,
    JSON.stringify({ managed, updates: edited.updates, indexRequests }));

    await showSection(settings, "custom-dictionary");
    await settings.waitForFunction(() => !document.getElementById("custom-dictionary-form").hidden
      && document.getElementById("custom-dictionary-status").textContent === "Loaded source revision 0.",
    { timeout: 30_000, polling: 100 });
    await settings.$eval("#custom-dictionary-source", (textarea, source) => {
      textarea.value = source;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }, PERSONAL_SOURCE);
    await settings.click("#custom-dictionary-save");
    const personal = await settings.waitForFunction(async source => {
      const { customDictionarySource: document, dictionaryState } = await chrome.storage.local.get(["customDictionarySource", "dictionaryState"]);
      const custom = dictionaryState.dictionaries[0];
      return document?.revision === 1 && document.text === source && custom?.termCount === 2 && custom.enabled
        ? { document, custom } : false;
    }, { timeout: 120_000, polling: 250 }, PERSONAL_SOURCE).then(handle => handle.jsonValue()).catch(() => null);
    check(RELEASED.personal, personal !== null, JSON.stringify(personal));

    // Every experimental switch this release has goes on except Netflix mining,
    // so both a kept and a promoted or retired value cross the release.
    const switches = await settings.$$eval("#experimental-features input[type=checkbox]", inputs => inputs.map(input => input.id));
    await editControls(settings, Object.fromEntries(switches.map(id => [id, id !== "opt-experimental-netflixMining"])));
    const defaults = await settings.evaluate(() => HDReaderOptions.DEFAULT_OPTIONS);
    const ankiOptions = await settings.evaluate(({ url, apiKey, deck }) => HDReaderOptions.normaliseAnki({ url, apiKey, templates: [
      { id: "default", name: "Round trip", deck, model: "Basic", tags: ["hachidori", "round-trip"],
        fields: { expression: "Front", reading: "Reading", definition: "Back", sentence: "Sentence",
          frequency: "", pitch: "", audio: "", screenshot: "" },
        duplicateScope: "deck", duplicateBehavior: "new", captureScreenshot: false, fieldTemplates: null },
      { id: "sentence", name: "Sentence card", deck: "Hachidori sentences", model: "Basic", tags: ["sentence"],
        fields: { expression: "", reading: "", definition: "", sentence: "", frequency: "", pitch: "", audio: "", screenshot: "" },
        duplicateScope: "all", duplicateBehavior: "overwrite", captureScreenshot: true,
        fieldTemplates: { Front: { value: "{sentence}", overwriteMode: "coalesce" },
          Back: { value: "{expression}<br>{glossary}", overwriteMode: "append" } } },
    ] }), { url: ANKI_URL, apiKey: ANKI_API_KEY, deck: ANKI_DECK });
    const written = {
      anki: ankiOptions,
      keybinds: [...defaults.keybinds.map((bind, index) => (index === 1 ? { ...bind, enabled: false } : bind)),
        { action: "markWordKnown", argument: "", key: "KeyK", modifiers: ["alt"], scopes: ["popup"], enabled: true }],
      audioSources: [{ ...defaults.audioSources[0], enabled: false },
        { id: "round-trip-audio", type: "custom", enabled: true, url: "https://audio.example.test/{term}.mp3", voice: "" }],
      customButtons: [{ id: "round-trip-search", type: "link", label: "Round-trip search", url: "https://search.example.test/?q=%s" },
        { id: "round-trip-sentence", type: "anki", label: "Sentence card", templateId: "sentence" }],
      customPopupCss: CUSTOM_CSS,
    };
    await writeOptions(settings, written);
    // A later pinned release has Smaller Anki cards as an Anki setting, not a switch.
    if (await settings.$("#opt-smaller-anki-cards")) await editControls(settings, { "opt-smaller-anki-cards": true });
    const kanjiChoice = await settings.$$eval("#opt-kanji-dictionary option", (options, title) => options
      .map(option => option.value).find(value => value.startsWith("{")
        && JSON.parse(value).title === title && JSON.parse(value).kind === "term"), GENERIC_KANJI_TITLE);
    if (!kanjiChoice) throw new Error("Settings does not offer the generic kanji dictionary's term entries for clicked kanji");
    await editControls(settings, { "opt-activation-key": "", "opt-max-results": "20", "opt-no-result-notice": false,
      "opt-hide-delay": "240", "opt-frequency-dictionary": FREQUENCY_TITLE, "opt-frequency-order": "descending",
      "opt-blur-count": true });
    await editControls(settings, { "opt-blur-threshold": "3", "opt-blur-delay": "8", "opt-blur-reveal": "hover" });
    await editControls(settings, { "opt-word-highlight": true, "opt-word-highlight-known": true,
      "opt-word-highlight-ignored": true, "opt-word-highlight-style": "background" });
    await editControls(settings, { "opt-popup-theme": "dracula", "opt-popup-width": "600", "opt-popup-height": "480",
      "opt-popup-toolbar": "bottom", "opt-frequency-names": true, "opt-glossary-layout": "compact",
      "opt-kanji-dictionary": kanjiChoice });
    await editControls(settings, { "opt-popup-audio-button": false });
    await editControls(settings, { "opt-automatic-backup-days": "7" });
    const configured = (await readBackup(settings)).view;
    const expected = {
      ...written, lookupMode: "hover", maxResults: 20, showNoResultNotice: false, popupHideDelayMs: 240,
      frequencyDictionary: FREQUENCY_TITLE, frequencyOrder: "descending", definitionBlurCountEnabled: true,
      definitionBlurThreshold: 3, definitionBlurDelayMs: 8000, definitionBlurReveal: "hover",
      wordHighlightEnabled: true, wordHighlightKnown: true, wordHighlightIgnored: true, wordHighlightStyle: "background",
      popupTheme: "dracula", popupWidthPx: 600, popupHeightPx: 480, popupToolbarPosition: "bottom",
      showFrequencyDictionaryNames: true, glossaryLayoutMode: "compact",
      kanjiClickDictionary: { title: GENERIC_KANJI_TITLE, kind: "term" }, showPopupAudioButton: false,
      automaticBackupDays: 7,
      experimental: Object.fromEntries(Object.keys(defaults.experimental).map(id => [id, id !== "netflixMining"])),
    };
    const unsaved = Object.keys(expected).filter(key => !isDeepStrictEqual(configured[key], expected[key]));
    check(RELEASED.settings, unsaved.length === 0 && (configured.experimental.smallerAnkiCards ?? configured.smallerAnkiCards) === true,
      JSON.stringify({ unsaved, configured: Object.fromEntries(unsaved.map(key => [key, configured[key]])) }));

    const tab = await browser.newPage();
    await tab.goto(`${PAGE_URL}read`, { waitUntil: "load" });
    await tab.bringToFront();
    const popup = await popupReader(tab);
    const verbs = [];
    for (let lookup = 0; lookup < 3; lookup += 1) verbs.push(await lookUp(tab, popup, "#verb", "食べる"));
    const tabs = (await popup.dictionaryTabs())?.tabs.map(({ key, label }) => ({ key, label })) ?? null;
    const others = [];
    for (const [selector, expression] of [["#ranked", SORTED], ["#personal", "往復"], ["#multibyte", "猫舌"]]) {
      others.push(await lookUp(tab, popup, selector, expression));
    }
    const overrides = () => settings.evaluate(async () => (await chrome.storage.local.get("wordStatusOverrides")).wordStatusOverrides);
    const marked = [];
    for (const [selector, expression, status] of [["#kanji", "漢字", "known"], ["#read", "読む", "ignored"]]) {
      const looked = await lookUp(tab, popup, selector, expression);
      await until(() => popup.wordStatus(), value => value?.buttons.length === 2);
      const clicked = await popup.click(`[data-word-status="${status}"]`);
      marked.push({ looked: Boolean(looked), clicked, stored: await until(overrides, value => value?.[status]?.includes(expression)) });
    }
    await tab.close();
    const source = await readBackup(settings);
    check(RELEASED.lookups, verbs.every(Boolean) && others.every(Boolean)
      && row(source.rows, "食べる")?.lookupCount === 3 && verbs.map(verb => verb.count).join() === "1,2,3"
      && ["漢字", "読む", "往復", "猫舌", SORTED].every(term => row(source.rows, term)?.lookupCount === 1)
      && isDeepStrictEqual(source.snapshot.wordStatusOverrides.known, ["漢字"])
      && isDeepStrictEqual(source.snapshot.wordStatusOverrides.ignored, ["読む"]) && marked.every(mark => mark.clicked),
    JSON.stringify({ counts: verbs.map(verb => verb?.count), rows: source.rows, marked, tabs }));

    const file = await exportBackup(browser, settings, resolve(SCRATCH, "released-download"));
    const archive = await readArchive(file);
    check(RELEASED.export, exportedCompletely(archive, source),
      JSON.stringify({ file: basename(file), version: archive.manifest.version, files: archive.parsed.files.length }));
    return { file, source, tabs };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ------------------------------------------------------------------- restoring

// How the backup's options must come back: every option the exporting build
// had is equal after the restoring build's normalisation, unless one of the
// documented rules explains it, and those rules are asserted, not skipped:
// switches restore by name (docs/backup-format.md: known keep their values,
// newer start off, retired are dropped); a retired switch that became a
// setting of the same name carries its value (reader-options.js, "Keep the
// existing mining choice when the experiment becomes an Anki option"); a
// setting the backup lacks keeps its default (docs/backup-format.md).
function compareOptions(source, restored) {
  const unexplained = [];
  const rules = [];
  const { revision: _sourceRevision, ...sourceRecord } = source.snapshot.options;
  const { revision: _restoredRevision, ...restoredRecord } = restored.snapshot.options;
  const known = Object.keys(restored.defaults.experimental);
  const sourceFlags = source.view.experimental;
  for (const id of new Set([...Object.keys(sourceFlags), ...known])) {
    const value = restored.view.experimental[id];
    if (known.includes(id) && Object.hasOwn(sourceFlags, id)) {
      if (value !== sourceFlags[id]) unexplained.push(`experimental.${id}`);
    } else if (known.includes(id)) {
      if (value === false) rules.push(`experimental.${id}: a newer switch starts off`);
      else unexplained.push(`experimental.${id}`);
    } else if (value === undefined && !Object.hasOwn(restoredRecord.experimental ?? {}, id)) {
      rules.push(`experimental.${id}: a retired switch is dropped`);
    } else unexplained.push(`experimental.${id}`);
  }
  const promoted = new Set();
  for (const key of new Set([...Object.keys(source.view), ...Object.keys(restored.view)])) {
    if (key === "experimental") continue;
    if (Object.hasOwn(source.view, key) && Object.hasOwn(restored.view, key)) {
      if (!isDeepStrictEqual(source.view[key], restored.view[key])) unexplained.push(key);
    } else if (!Object.hasOwn(restored.view, key)) {
      unexplained.push(`${key}: missing after restore`);
    } else if (typeof sourceFlags[key] === "boolean" && !known.includes(key)) {
      if (restored.view[key] === sourceFlags[key]) {
        rules.push(`${key}: carries the retired experimental.${key} switch (${sourceFlags[key]})`);
        promoted.add(key);
      } else unexplained.push(`${key}: not the promoted switch's value`);
    } else if (isDeepStrictEqual(restored.view[key], restored.defaults[key])) {
      rules.push(`${key}: a newer setting keeps its default`);
    } else unexplained.push(`${key}: a newer setting is not at its default`);
  }
  // The stored record holds the same values, plus only the promoted settings.
  for (const [key, value] of Object.entries(sourceRecord)) {
    if (key !== "experimental" && !isDeepStrictEqual(restoredRecord[key], value)) unexplained.push(`stored ${key}`);
  }
  for (const key of Object.keys(restoredRecord)) {
    if (!Object.hasOwn(sourceRecord, key) && !promoted.has(key)) unexplained.push(`stored ${key} added`);
  }
  return { unexplained, rules };
}

const withoutRevision = ({ revision: _revision, ...value }) => value;
const withoutPaths = state => ({ ...withoutRevision(state), dictionaries: state.dictionaries.map(({ path: _path, ...entry }) => entry) });
const sortedRows = rows => [...rows].sort((left, right) =>
  `${left.term}\u0000${left.reading}`.localeCompare(`${right.term}\u0000${right.reading}`));

async function restoreLeg(leg, { file, source, tabs }) {
  const name = check => `${leg}: ${check}`;
  const label = leg === LEGS.released ? "restored" : "rerestored";
  const { browser, settings } = await openBrowser(EXTENSION, profile(label), label);
  anki.keys.clear();
  anki.media.clear();
  anki.unexpected.length = 0;
  try {
    const before = await readBackup(settings);
    await showSection(settings, "backup");
    await settings.bringToFront();
    await (await settings.$("#backup-file")).uploadFile(file);
    await settings.waitForFunction(() => !document.getElementById("backup-preview").hidden
      || document.getElementById("backup-status").classList.contains("is-error"), { timeout: 120_000, polling: 100 });
    const preview = await settings.evaluate(() => ({
      status: document.getElementById("backup-status").textContent,
      shown: !document.getElementById("backup-preview").hidden,
      restoreDisabled: document.getElementById("backup-restore").disabled,
      count: document.getElementById("backup-count").textContent,
      dictionaries: [...document.querySelectorAll("#backup-dictionaries li")].map(item => item.textContent),
    }));
    const listed = source.snapshot.state.dictionaries.map(({ title, enabled }) => `${title}${enabled ? "" : " (disabled)"}`);
    check(name(RESTORED.preview), preview.shown && preview.restoreDisabled
      && preview.status === "Backup checked. Nothing has been replaced."
      && preview.count === `${listed.length} dictionaries · 2 personal entries`
      && isDeepStrictEqual(preview.dictionaries, listed), JSON.stringify({ preview, listed }));
    await settings.click("#backup-confirm");
    await settings.click("#backup-restore");
    await settings.waitForFunction(() => !document.getElementById("backup-export").disabled
      && document.getElementById("backup-preview").hidden, { timeout: 120_000, polling: 100 });
    const notice = await settings.$eval("#backup-status", output => output.textContent);
    await settings.waitForFunction(count => document.getElementById("engine-status")?.textContent.includes("Ready")
      && document.querySelectorAll("#dict-list .dict-row").length === count, { timeout: 90_000, polling: 100 }, listed.length);
    const restored = await readBackup(settings);
    const revisions = Object.fromEntries(Object.keys(restored.snapshot).map(key =>
      [key, [before.snapshot[key]?.revision ?? 0, restored.snapshot[key].revision]]));
    check(name(RESTORED.restore), notice === "Restored successfully."
      && Object.values(revisions).every(([prior, now]) => now === prior + 1)
      && restored.snapshot.state.dictionaries.every((dictionary, index) =>
        dictionary.path !== source.snapshot.state.dictionaries[index].path),
    JSON.stringify({ notice, revisions }));

    // Everything but the fresh generation paths and the local revision.
    const restoredState = restored.snapshot.state;
    check(name(RESTORED.dictionaries), isDeepStrictEqual(withoutPaths(restoredState), withoutPaths(source.snapshot.state)),
      JSON.stringify({ restored: withoutPaths(restoredState), source: withoutPaths(source.snapshot.state) }));

    const options = compareOptions(source, restored);
    check(name(RESTORED.options), options.unexplained.length === 0, JSON.stringify(options));
    console.log(`     ${leg} options rules: ${options.rules.length ? options.rules.join("; ") : "none needed"}`);

    const restoredRows = sortedRows(restored.rows);
    check(name(RESTORED.state), isDeepStrictEqual(withoutRevision(restored.snapshot.document), withoutRevision(source.snapshot.document))
      && isDeepStrictEqual(withoutRevision(restored.snapshot.updates), withoutRevision(source.snapshot.updates))
      && isDeepStrictEqual(withoutRevision(restored.snapshot.wordStatusOverrides), withoutRevision(source.snapshot.wordStatusOverrides))
      && isDeepStrictEqual(restoredRows, sortedRows(source.rows))
      && typeof restored.snapshot.lookupStats.generation === "string"
      && restored.snapshot.lookupStats.generation !== source.snapshot.lookupStats.generation,
    JSON.stringify({ document: restored.snapshot.document, updates: restored.snapshot.updates,
      words: restored.snapshot.wordStatusOverrides, rows: restoredRows, lookupStats: restored.snapshot.lookupStats }));

    const managed = byTitle(restored.snapshot, FREQUENCY_TITLE);
    const due = Date.parse(managed.lastUpdateCheck.checkedAt) + 24 * 60 * 60_000;
    // The Anki section renders its fields once it is opened.
    await showSection(settings, "anki");
    await settings.waitForFunction(url => document.getElementById("opt-anki-url").value === url,
      { timeout: 15_000, polling: 100 }, ANKI_URL).catch(() => {});
    const shown = await settings.evaluate(async id => {
      const value = selector => document.querySelector(selector);
      const alarm = async () => chrome.alarms.get("hachidori-managed-dictionary-updates");
      let scheduled = await alarm();
      for (let attempt = 0; attempt < 100 && !scheduled; attempt += 1) {
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
        scheduled = await alarm();
      }
      return {
        reveal: value("#opt-blur-reveal").value, schedule: value("#update-schedule").value,
        dictionarySchedule: value(`#dict-list .dict-row[data-dictionary-id="${id}"] .dict-update-schedule`).value,
        smallerAnkiCards: value("#opt-smaller-anki-cards")?.checked ?? null,
        ankiUrl: value("#opt-anki-url").value, ankiKey: value("#opt-anki-api-key").value,
        backupDays: value("#opt-automatic-backup-days").value, wordHighlight: value("#opt-word-highlight").checked,
        switches: Object.fromEntries([...document.querySelectorAll("#experimental-features input[type=checkbox]")]
          .map(input => [input.id.replace("opt-experimental-", ""), input.checked])),
        alarm: scheduled?.scheduledTime ?? null,
      };
    }, managed.id);
    const view = restored.view;
    check(name(RESTORED.settings), shown.reveal === view.definitionBlurReveal && shown.schedule === "weekly"
      && shown.dictionarySchedule === "daily" && shown.smallerAnkiCards === view.smallerAnkiCards
      && shown.ankiUrl === ANKI_URL && shown.ankiKey === ANKI_API_KEY && shown.backupDays === "7" && shown.wordHighlight
      && isDeepStrictEqual(shown.switches, view.experimental)
      && shown.alarm !== null && Math.abs(shown.alarm - due) < 1000,
    JSON.stringify({ shown, due, view: { reveal: view.definitionBlurReveal, smallerAnkiCards: view.smallerAnkiCards,
      experimental: view.experimental } }));

    const observed = await popupChecks(name, browser, settings, source, restored, tabs);
    return { browser, settings, tabs: observed };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  } finally {
    if (leg === LEGS.current) await browser.close().catch(() => {});
  }
}

async function popupChecks(name, browser, settings, source, restored, tabs) {
  const tab = await browser.newPage();
  try {
    await tab.goto(`${PAGE_URL}read`, { waitUntil: "load" });
    await tab.bringToFront();
    const popup = await popupReader(tab);
    const options = restored.view;
    const sourceCount = term => row(source.rows, term)?.lookupCount ?? 0;

    const verb = await lookUp(tab, popup, "#verb", "食べる");
    const verbView = await popup.dictionaryTabs();
    // The palette and the hidden audio button are the popup host's attributes.
    const host = await tab.$eval("hachidori-host", element => ({ ...element.dataset }));
    const counted = await until(() => readBackup(settings), value => row(value.rows, "食べる")?.lookupCount === sourceCount("食べる") + 1);
    const blurred = verb?.blur ?? null;
    let revealed = null;
    let hoverKept = null;
    if (blurred?.definitionsPoint) {
      await tab.mouse.move(blurred.definitionsPoint.x, blurred.definitionsPoint.y);
      if (options.definitionBlurReveal === "click") {
        hoverKept = (await until(() => popup.definitionBlur(), value => value?.state === "revealed", 1_000))?.state;
        await tab.mouse.click(blurred.definitionsPoint.x, blurred.definitionsPoint.y);
      }
      revealed = await until(() => popup.definitionBlur(), value => value?.state === "revealed", 5_000);
    }
    const kanjiClicked = await popup.click(".gsm-hoshidicts-kanji-link");
    // The term view already shows the generic kanji dictionary's 食 entry, so
    // wait for the clicked kanji's own view, which has Back.
    const kanjiView = await until(() => popup.state(), value => value?.hasBack === true
      && value.text.includes(GENERIC_KANJI_GLOSSARY));
    const native = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
      type: "hd_kanji", requestId: "backup-release-kanji", character: "食" }));
    check(name(RESTORED.kanji), kanjiClicked && kanjiView?.hasBack === true && kanjiView.text.includes(GENERIC_KANJI_GLOSSARY)
      && native?.ok === true && native.kanji?.character === "食"
      && JSON.stringify(native.kanji.entries).includes("ショク") && JSON.stringify(native.kanji.entries).includes("food"),
    JSON.stringify({ kanjiClicked, kanjiView: kanjiView?.text, native }));

    const kanji = await lookUp(tab, popup, "#kanji", "漢字");
    // Dictionary media resolves after the definitions are painted.
    const structured = kanji && await until(() => popup.state(), value => value?.images.some(source => source.startsWith("data:image/")));
    const status = await until(() => popup.wordStatus(), value => value?.buttons.length === 2);
    const ready = await until(() => popup.anki(), value => value?.controls?.[0]?.action === "add"
      && value.controls[0].state !== "checking" && !value.controls[0].disabled, 20_000);
    const mined = anki.notes.length;
    const mining = await popup.click(".gsm-hoshidicts-mine-button");
    await until(() => anki.notes.length, count => count > mined, 20_000);
    const minedNote = anki.notes[mined] ?? null;
    const cards = verbView?.entries[0]?.cards.map(card => card.dictionary) ?? [];
    check(name(RESTORED.lookup), verb !== null && verb.state.plain.includes("to eat")
      && isDeepStrictEqual(verbView.tabs.map(({ key, label }) => ({ key, label })), tabs)
      && cards.includes(FIXTURE_TITLE) && !cards.includes(TRAINED_TITLE)
      && verbView.metadata.frequencyNames.includes(FREQUENCY_TITLE) && verbView.metadata.frequencies.includes(1200)
      && verbView.metadata.frequencies.includes(142) && verbView.metadata.pitch > 0
      && structured !== null && structured.text.includes("Chinese character")
      && structured.lists.some(list => list.length === 2) && structured.tables.length > 0 && structured.bold.length > 0
      && structured.images.some(source => source.startsWith("data:image/"))
      && verbView.rect.width === options.popupWidthPx && verbView.toolbar === options.popupToolbarPosition
      && verbView.customOutline === "rgb(12, 34, 56)" && host.hoshidictsTheme === options.popupTheme
      && host.hoshidictsAudioButton === (options.showPopupAudioButton ? undefined : "hidden"),
    JSON.stringify({ verb: verb?.state.plain, tabs: verbView?.tabs, expectedTabs: tabs, cards, metadata: verbView?.metadata,
      structured: structured && { lists: structured.lists, tables: structured.tables, bold: structured.bold, images: structured.images },
      rect: verbView?.rect, toolbar: verbView?.toolbar, outline: verbView?.customOutline, host }));

    const fields = minedNote?.fields ?? {};
    check(name(RESTORED.anki), mining && minedNote !== null && minedNote.deckName === ANKI_DECK && minedNote.modelName === "Basic"
      && fields.Front === "漢字" && fields.Reading === "かんじ" && fields.Back?.includes("Chinese character")
      && [...anki.media].some(filename => fields.Back.includes(filename))
      && isDeepStrictEqual(minedNote.tags, ["hachidori", "round-trip"])
      && minedNote.options?.duplicateScope === "deck" && minedNote.options.allowDuplicate === true
      && minedNote.options.duplicateScopeOptions?.deckName === ANKI_DECK
      && isDeepStrictEqual([...anki.keys], [ANKI_API_KEY]) && anki.unexpected.length === 0,
    JSON.stringify({ ready: ready?.controls?.[0], minedNote, media: [...anki.media], keys: [...anki.keys],
      unexpected: anki.unexpected }));

    const thanks = await lookUp(tab, popup, "#thanks", "ありがとう");
    const threshold = options.definitionBlurThreshold;
    check(name(RESTORED.blur), options.definitionBlurCountEnabled && options.definitionBlurDirection === "atLeast"
      && blurred?.state === "blurred" && verb.count >= threshold
      && (options.definitionBlurReveal === "hover" || options.definitionBlurReveal === "click")
      && (options.definitionBlurReveal !== "click" || hoverKept === "blurred")
      && revealed?.state === "revealed"
      && thanks !== null && thanks.count < threshold && thanks.blur.state === "revealed",
    JSON.stringify({ threshold, reveal: options.definitionBlurReveal, verb: blurred && { state: blurred.state, count: verb.count },
      hoverKept, revealed: revealed?.state, thanks: thanks && { state: thanks.blur.state, count: thanks.count } }));

    check(name(RESTORED.counts), verb?.count === sourceCount("食べる") + 1
      && row(counted.rows, "食べる")?.lookupCount === verb.count && kanji?.count === sourceCount("漢字") + 1
      && thanks?.count === sourceCount("ありがとう") + 1,
    JSON.stringify({ verb: verb?.count, kanji: kanji?.count, thanks: thanks?.count, stored: row(counted.rows, "食べる"),
      source: ["食べる", "漢字", "ありがとう"].map(term => [term, sourceCount(term)]) }));

    const ranked = await lookUp(tab, popup, "#ranked", SORTED);
    // The popup appends results after the first one is painted.
    const sortedEntries = view => view?.entries.filter(entry => entry.expression === SORTED) ?? [];
    const rankedView = ranked && await until(() => popup.dictionaryTabs(),
      view => sortedEntries(view).length === Object.keys(SORTED_RANKS).length);
    const order = sortedEntries(rankedView)
      .map(entry => /sorted reading (\S)/u.exec(entry.cards.flatMap(card => card.text).join(" "))?.[1]);
    const expectedOrder = Object.keys(SORTED_RANKS).sort((left, right) => SORTED_RANKS[right] - SORTED_RANKS[left]);
    check(name(RESTORED.sorting), options.frequencyDictionary === FREQUENCY_TITLE && options.frequencyOrder === "descending"
      && isDeepStrictEqual(order, expectedOrder), JSON.stringify({ order, expectedOrder,
      frequencyDictionary: options.frequencyDictionary, frequencyOrder: options.frequencyOrder }));

    const personal = await lookUp(tab, popup, "#personal", "往復");
    const multibyte = await lookUp(tab, popup, "#multibyte", "猫舌");
    check(name(RESTORED.personal), personal?.state.text.includes("a round trip") === true
      && multibyte?.state.text.includes("sensitive to hot food") === true && multibyte.state.text.includes("いつも熱いものが苦手"),
    JSON.stringify({ personal: personal?.state.text, multibyte: multibyte?.state.text }));

    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    const names = Object.fromEntries(["known", "ignored"].map(state => [state, `${WORD_HIGHLIGHT_PREFIX}${state}`]));
    const marks = await until(() => tab.evaluate(highlights => Object.fromEntries(Object.entries(highlights).map(([state, highlight]) =>
      [state, [...(CSS.highlights.get(highlight) ?? [])]
        .map(range => range.startContainer.data.slice(range.startOffset, range.endOffset))])), names),
    value => value.known.includes("漢字") && value.ignored.includes("読む"), 20_000);
    check(name(RESTORED.wordStatus), Object.fromEntries(status?.buttons.map(button => [button.status, button.pressed]) ?? [])
      .known === "true" && status.buttons.find(button => button.status === "ignored")?.pressed === "false"
      && marks.known.includes("漢字") && marks.ignored.includes("読む") && !marks.known.includes("読む"),
    JSON.stringify({ buttons: status?.buttons, marks }));
    return verbView?.tabs.map(({ key, label }) => ({ key, label })) ?? null;
  } finally {
    await tab.close().catch(() => {});
  }
}

// In the restored profile: the newest Reveal choice this checkout's Settings
// offer (read at runtime) and its own frequency average settings, then a
// backup of that state. Its popup tabs are the ones the restored popup showed.
async function newExportLeg({ browser, settings, tabs }) {
  try {
    const choices = await settings.$$eval("#opt-blur-reveal option", options => options.map(option => option.value));
    const newest = choices.at(-1);
    await editControls(settings, { "opt-blur-reveal": newest });
    await editControls(settings, { "opt-average-frequency": true });
    await editControls(settings, { "opt-average-frequency-tags": true });
    const source = await readBackup(settings);
    check(NEW_BUILD.settings, source.view.definitionBlurReveal === newest && source.view.averageFrequency === true
      && source.view.showFrequencyTagsWithAverage === true,
    JSON.stringify({ choices, reveal: source.view.definitionBlurReveal, averageFrequency: source.view.averageFrequency,
      showFrequencyTagsWithAverage: source.view.showFrequencyTagsWithAverage }));
    const file = await exportBackup(browser, settings, resolve(SCRATCH, "new-download"));
    const archive = await readArchive(file);
    check(NEW_BUILD.export, exportedCompletely(archive, source),
      JSON.stringify({ file: basename(file), version: archive.manifest.version, files: archive.parsed.files.length }));
    return { file, source, tabs };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function leg(label, body) {
  try {
    return await body();
  } catch (error) {
    failures.push(`${label} finished without throwing\n      ${error?.stack ?? error}`);
    console.log(`FAIL ${label} finished without throwing\n       ${error?.stack ?? error}`);
    return null;
  }
}

if (!WORD_HIGHLIGHT_PREFIX) throw new Error("word-highlights.js no longer names its highlights hd-word-${status}");
console.log(`released build ${RELEASE_VERSION} (${RELEASE_COMMIT}); this checkout ${EXTENSION}`);
try {
  const released = await leg("the released build", releasedLeg);
  const restored = released && await leg(LEGS.released, () => restoreLeg(LEGS.released, released));
  const exported = restored && await leg("the new build's export", () => newExportLeg(restored));
  if (exported) await leg(LEGS.current, () => restoreLeg(LEGS.current, exported));
} finally {
  server.close();
}

let failed = failures.length;
for (const name of PLANNED) {
  if (!results.has(name)) {
    console.log(`FAIL ${name}\n       check never ran`);
    results.set(name, { ok: false, detail: "check never ran" });
  }
  if (!results.get(name).ok) failed += 1;
}
console.log(`\n${PLANNED.filter(name => results.get(name).ok).length}/${PLANNED.length} checks passed`);
if (failed) {
  console.log("\nfailures:");
  for (const name of PLANNED.filter(planned => !results.get(planned).ok)) console.log(`  - ${name}\n      ${results.get(name).detail}`);
  for (const failure of failures) console.log(`  - ${failure}`);
  console.log(`\nprofiles kept for inspection: ${["released", "restored", "rerestored"].map(profile).filter(existsSync).join(", ")}`);
  console.log("\nbrowser diagnostics (last 60):");
  for (const line of diagnostics.slice(-60)) console.log(`  ${line}`);
} else {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const label of ["released", "restored", "rerestored"]) rmSync(profile(label), { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
