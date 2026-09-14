/*
 * Two real Chromes and the Anki add-on's relay: one imports dictionaries,
 * hands out the add-on and shares itself; the other's startup page offers
 * that Hachidori and links with one click, looks words up through it, edits
 * shared settings, survives the host closing and reopening, unlinks, and
 * links again through this computer's own network address.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ANKI_ADDON_FILE_NAME, ANKI_ADDON_URL, ANKI_ADDON_VERSION } from "../extension/anki-addon.js";
import { CUSTOM_DICTIONARY_ID, CUSTOM_DICTIONARY_SOURCE_KEY, CUSTOM_DICTIONARY_TITLE } from "../extension/custom-dictionary.js";
import { BlobReader, TextWriter, ZipReader } from "../extension/vendor/zip.js";
import { startAnkiRelayServer } from "./anki-relay-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
// A test-only port keeps a developer's own Anki relay on the default port out of the way.
const PORT = Number(process.env.HACHIDORI_SHARING_PORT) || 18771;
const ADDRESS = `ws://127.0.0.1:${PORT}/link`;
const CUSTOM_SOURCE = "共有語, きょうゆうご, saved through the link\n";
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
// Set to a directory to save the documentation screenshots from this real run.
const SCREENSHOTS = process.env.HACHIDORI_SHARING_SCREENSHOTS || "";
// Use a locally built archive for offline runs or coordinated add-on changes.
const LOCAL_ADDON = process.env.HACHIDORI_ANKI_ADDON || "";

function scratchPath(value, prefix) {
  const resolved = resolve(value);
  const relativePath = relative(resolve(tmpdir()), resolved);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
    || dirname(relativePath) !== "." || !basename(relativePath).startsWith(prefix)) {
    throw new Error(`${value} is not a dedicated ${prefix}* scratch path directly under ${tmpdir()}`);
  }
  return resolved;
}

const HOST_PROFILE = scratchPath(process.env.HACHIDORI_SHARING_HOST_PROFILE || `${tmpdir()}/hachidori-sharing-host-${process.pid}`, "hachidori-sharing-host-");
const CLIENT_PROFILE = scratchPath(process.env.HACHIDORI_SHARING_CLIENT_PROFILE || `${tmpdir()}/hachidori-sharing-client-${process.pid}`, "hachidori-sharing-client-");
const OVERLAY_PROFILE = scratchPath(`${tmpdir()}/hachidori-sharing-overlay-${process.pid}`, "hachidori-sharing-overlay-");
const OVERLAY_EXTENSION = scratchPath(`${tmpdir()}/hachidori-sharing-extension-${process.pid}`, "hachidori-sharing-extension-");

function cachedChrome() {
  const suffixes = process.platform === "linux" ? [["chrome-linux64", "chrome"]]
    : process.platform === "darwin"
      ? [["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]]
      : process.platform === "win32" ? [["chrome-win64", "chrome.exe"], ["chrome-win32", "chrome.exe"]] : [];
  for (const name of ["hachidori-browsers", "hdw-browsers"]) {
    const root = resolve(CACHE, name, "chrome");
    if (!existsSync(root)) continue;
    const builds = readdirSync(root).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const build of builds) {
      for (const suffix of suffixes) {
        const candidate = resolve(root, build, ...suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return "";
}

function installedChrome() {
  const candidates = process.platform === "linux"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32" ? [resolve(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe")] : [];
  return candidates.find(existsSync) || "";
}

const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || cachedChrome() || installedChrome();
const PUPPETEER_CANDIDATES = ["hachidori-e2e", "hdw-e2e"].map((name) =>
  resolve(CACHE, name, "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js"));
const PUPPETEER = process.env.HACHIDORI_PUPPETEER || PUPPETEER_CANDIDATES.find(existsSync) || PUPPETEER_CANDIDATES[0];
const puppeteer = await import(`file://${PUPPETEER}`);

const CHECKS = [
  "the host's Sharing page saves the pinned Anki release as a valid archive while Anki is not yet connected",
  "the host imports the fixture and shares through Anki's relay on the chosen port",
  "the second browser's startup page offers the shared Hachidori, and one click links it and completes setup",
  "an options edit made on the linked browser is committed by the host and pushed back",
  "a personal dictionary save made on the linked browser lands in the host's source and answers lookups",
  "the linked browser discovers and mines through the host while capture stays local, stale results fail, and local Anki stays unused",
  "closing the host fails linked lookups, and relaunching it reconnects the linked browser by itself",
  "unlinking restores the linked browser's own empty state",
  "sharing with other computers lets the second browser link through this computer's network address, and turning it off disconnects it",
  "a failed add-on download reports the error, saves no file, and enables retry",
  "overlapping Sharing actions from two Settings tabs preserve local personal entries, settings and dictionary files",
  "a real linked overlay keeps local preferences through host edits, disconnection, restart and Unlink and explains mining capabilities",
];
const results = [];
const diagnostics = [];

function fatal(message) {
  console.error(`FATAL ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function check(name, ok, detail = "") {
  if (!CHECKS.includes(name)) fatal(`unknown check "${name}"`);
  if (results.some((entry) => entry.name === name)) fatal(`check("${name}") ran twice`);
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n       ${detail}`}`);
}

function launch(profile, extension = EXTENSION) {
  return puppeteer.launch({
    executablePath: CHROME,
    enableExtensions: true,
    userDataDir: profile,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
  });
}

async function extensionId(browser) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker" && candidate.url().startsWith("chrome-extension://"),
    { timeout: 30_000 },
  );
  return new URL(target.url()).host;
}

function watch(page, label) {
  page.on("console", (message) => diagnostics.push(`[${label}] ${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`[${label}] pageerror: ${error.message}`));
}

async function openSettings(browser, id, label, section) {
  const page = await browser.newPage();
  watch(page, label);
  await page.goto(`chrome-extension://${id}/settings.html#${section}`, { waitUntil: "domcontentloaded" });
  // A fresh install opens its startup page too; clicks only reach the active tab.
  await page.bringToFront();
  return page;
}

// The page a fresh install opens by itself.
async function startupPage(browser, id, label) {
  const url = `chrome-extension://${id}/startup.html`;
  const target = await browser.waitForTarget((candidate) => candidate.type() === "page" && candidate.url() === url, { timeout: 30_000 });
  const page = await target.page();
  watch(page, label);
  return page;
}

async function showSection(page, section) {
  await page.evaluate((hash) => { window.location.hash = hash; }, section);
  await page.waitForFunction((id) => document.getElementById(id)?.hidden === false, { timeout: 10_000, polling: 100 }, section);
}

// Runtime messages sent from an extension page reach that browser's own service
// worker; on the linked browser they are forwarded to the host.
function message(page, target, type, fields = {}) {
  return page.evaluate((request) => chrome.runtime.sendMessage(request),
    { target, type, requestId: `sharing-suite-${type}`, ...fields });
}

function sharingStatus(page) {
  return message(page, "hachidori-sharing", "hd_sharing_status");
}

function lookup(page, text = "食べたかった") {
  return message(page, "hoshidicts-offscreen", "hd_lookup", { text, maxResults: 32, scanLength: 16, options: {} });
}

function stored(page, keys) {
  return page.evaluate((list) => chrome.storage.local.get(list), keys);
}

function configureAnki(page, url, apiKey) {
  return page.evaluate(async ({ url, apiKey }) => {
    const { options } = await chrome.storage.local.get("options");
    const template = value => ({ value, overwriteMode: "overwrite" });
    const anki = {
      ...HDReaderOptions.normaliseOptions({}).anki,
      url,
      apiKey,
      deck: "Default",
      model: "Basic",
      captureScreenshot: true,
      fieldTemplates: {
        Front: template("{expression}"),
        Back: template("{sentence}"),
        Picture: template("{screenshot}"),
      },
    };
    return chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      requestId: "sharing-suite-configure-anki",
      baseRevision: options.revision,
      options: { anki, audioSources: [] },
    });
  }, { url, apiKey });
}

function setLocalAnkiEndpoint(page, url, apiKey) {
  return page.evaluate(async ({ url, apiKey }) => {
    const { options } = await chrome.storage.local.get("options");
    await chrome.storage.local.set({ options: {
      ...options,
      anki: { ...options.anki, url, apiKey },
    } });
  }, { url, apiKey });
}

function statusText(page) {
  return page.evaluate(() => document.getElementById("sharing-status")?.textContent ?? "");
}

async function readHttpJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 20 * 1024 * 1024) throw new Error("AnkiConnect test request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeHttpJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}

async function startMockAnkiConnect(apiKey) {
  const state = {
    apiKey,
    online: true,
    calls: [],
    notes: new Map(),
    media: new Map(),
    nextNoteId: 100,
  };
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": "*" });
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/") {
      writeHttpJson(response, 404, { result: null, error: "not found" });
      return;
    }
    try {
      const body = await readHttpJson(request);
      const { action, params = {}, key = "" } = body;
      state.calls.push({
        action,
        key,
        params: action === "storeMediaFile"
          ? { filename: params.filename, byteLength: Buffer.from(params.data ?? "", "base64").length }
          : structuredClone(params),
      });
      if (!state.online) {
        writeHttpJson(response, 503, { result: null, error: "Anki is unavailable" });
        return;
      }
      if (key !== state.apiKey) {
        writeHttpJson(response, 200, { result: null, error: "invalid api key" });
        return;
      }
      let result;
      if (action === "deckNames") result = ["Default"];
      else if (action === "modelNames") result = ["Basic"];
      else if (action === "modelNamesAndIds") result = { Basic: 1 };
      else if (action === "modelFieldNames") result = ["Front", "Back", "Picture"];
      else if (action === "canAddNotesWithErrorDetail") {
        result = params.notes.map(note => {
          const duplicate = [...state.notes.values()].some(existing => existing.fields.Front === note.fields.Front);
          return { canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null };
        });
      } else if (action === "canAddNotes") {
        result = params.notes.map(note =>
          ![...state.notes.values()].some(existing => existing.fields.Front === note.fields.Front));
      } else if (action === "addNote") {
        const noteId = ++state.nextNoteId;
        state.notes.set(noteId, structuredClone(params.note));
        result = noteId;
      } else if (action === "findNotes") {
        const match = /^"dupe:1,(.*)"$/u.exec(params.query);
        const text = match?.[1]?.replace(/\\(["\\])/gu, "$1") ?? "";
        result = [...state.notes].filter(([, note]) => note.fields.Front === text).map(([noteId]) => noteId);
      } else if (action === "notesInfo") {
        result = params.notes.filter(noteId => state.notes.has(noteId)).map(noteId => {
          const note = state.notes.get(noteId);
          return {
            noteId,
            modelName: note.modelName,
            cards: [],
            fields: Object.fromEntries(Object.entries(note.fields).map(([field, value]) => [field, { value }])),
          };
        });
      } else if (action === "updateNoteFields") {
        const current = state.notes.get(params.note.id);
        state.notes.set(params.note.id, { ...current, fields: { ...current.fields, ...params.note.fields } });
        result = null;
      } else if (action === "storeMediaFile") {
        state.media.set(params.filename, params.data);
        result = params.filename;
      } else if (action === "deleteMediaFile") {
        state.media.delete(params.filename);
        result = null;
      } else if (action === "guiBrowse") {
        result = [...state.notes.keys()];
      } else {
        throw new Error(`unexpected AnkiConnect action ${action}`);
      }
      writeHttpJson(response, 200, { result, error: null });
    } catch (error) {
      writeHttpJson(response, 200, { result: null, error: error.message || String(error) });
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    state,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}

async function until(predicate, what, timeoutMs = 30_000, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

async function importFixture(page) {
  await showSection(page, "add-dictionaries");
  await page.waitForSelector("#import-file", { visible: true });
  // A fresh profile's Settings page migrates dictionary state first; that
  // mutation holds the engine lock an early import would be refused by.
  await until(async () => {
    const status = await message(page, "hoshidicts-offscreen", "hd_status");
    return status?.ok && status.ready && !status.loading ? status : null;
  }, "the host engine to become idle", 60_000);
  await (await page.$("#import-file")).uploadFile(FIXTURE);
  const deadline = Date.now() + 120_000;
  let importState = "";
  while (importState !== "Finished 1 of 1 archive — 1 imported, 0 failed.") {
    if (Date.now() > deadline) throw new Error(`the fixture import did not finish: ${JSON.stringify(importState)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    importState = await page.evaluate(() => (document.querySelector("#import-state")?.textContent || "").trim());
  }
}

// Sharing is on by default on the standard port; the suite moves it to the
// test relay's port through the same message the switch sends.
async function enableSharing(page) {
  const reply = await message(page, "hachidori-sharing", "hd_sharing_host_enable", { port: PORT });
  if (!reply?.ok) throw new Error(`sharing could not be enabled: ${reply?.error}`);
  const connected = await until(async () => {
    const current = await sharingStatus(page);
    return current?.sharing?.connected ? current.sharing : null;
  }, "the host to connect to the relay", 30_000);
  await showSection(page, "sharing");
  await page.waitForFunction((text) => document.getElementById("sharing-status")?.textContent === text,
    { timeout: 15_000, polling: 100 }, "Sharing through Anki.");
  return connected;
}

async function failAddonDownload(page, session, file) {
  let paused = null;
  session.once("Fetch.requestPaused", request => { paused = request; });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: ANKI_ADDON_URL, requestStage: "Request" }] });
  await page.click("#sharing-addon-download");
  const request = await until(() => paused, "the pinned add-on request", 10_000);
  await page.waitForFunction(() => document.getElementById("sharing-addon-download").disabled
    && document.getElementById("sharing-status").textContent === "Downloading the Anki add-on from GitHub…", { timeout: 10_000 });
  await screenshot(page, "sharing-addon-downloading.png");
  await session.send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 503, body: "" });
  await session.send("Fetch.disable");
  await page.waitForFunction(() => document.getElementById("sharing-status").textContent.includes("HTTP 503"), { timeout: 10_000 });
  const failed = await page.evaluate(() => ({
    message: document.getElementById("sharing-status").textContent,
    disabled: document.getElementById("sharing-addon-download").disabled,
  }));
  check(CHECKS[9], !existsSync(file) && !failed.disabled
    && failed.message === "Could not download the add-on: GitHub returned HTTP 503. Try again.", JSON.stringify(failed));
  await screenshot(page, "sharing-addon-error.png");
}

// Retry the failed download using the real pinned release (or the explicit local archive).
async function downloadAddon(page) {
  const downloads = resolve(HOST_PROFILE, "downloads");
  mkdirSync(downloads, { recursive: true });
  const file = resolve(downloads, ANKI_ADDON_FILE_NAME);
  const session = await page.createCDPSession();
  try {
    await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
    await showSection(page, "sharing");
    await page.waitForFunction(() => document.getElementById("sharing-addon")?.hidden === false && !document.getElementById("sharing-addon-download").disabled,
      { timeout: 15_000, polling: 100 });
    await page.bringToFront();
    await failAddonDownload(page, session, file);
    if (LOCAL_ADDON) {
      const body = readFileSync(LOCAL_ADDON).toString("base64");
      session.once("Fetch.requestPaused", async request => {
        await session.send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/octet-stream" }], body });
      });
      await session.send("Fetch.enable", { patterns: [{ urlPattern: ANKI_ADDON_URL, requestStage: "Request" }] });
    }
    const requested = page.waitForRequest(request => request.url() === ANKI_ADDON_URL);
    await page.click("#sharing-addon-download");
    await requested;
    const bytes = await until(async () => {
      if (!existsSync(file) || readdirSync(downloads).some((name) => name.endsWith(".crdownload"))) return null;
      return readFileSync(file);
    }, "the add-on download to finish", 30_000);
    await page.waitForFunction(() => document.getElementById("sharing-status")?.textContent.startsWith("Saved hachidori-relay.ankiaddon"), { timeout: 10_000, polling: 100 });
    const status = await statusText(page);
    const archive = new ZipReader(new BlobReader(new Blob([bytes])));
    const entries = await archive.getEntries();
    const manifestEntry = entries.find((entry) => entry.filename === "manifest.json");
    const manifest = manifestEntry ? JSON.parse(await manifestEntry.getData(new TextWriter())) : null;
    await archive.close();
    return { file, size: bytes.length, files: entries.map((entry) => entry.filename), manifest, status };
  } finally {
    await session.detach();
  }
}

async function screenshot(page, name, { section = "sharing", element = "sharing" } = {}) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 2 });
  if (section !== null) await showSection(page, section);
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const clip = await page.evaluate((id) => {
    const rect = document.getElementById(id).getBoundingClientRect();
    return { x: Math.max(0, rect.left - 12 + window.scrollX), y: Math.max(0, rect.top - 12 + window.scrollY), width: rect.width + 24, height: rect.height + 24 };
  }, element);
  await page.screenshot({ path: resolve(SCREENSHOTS, name), clip });
}

function report() {
  const failed = results.filter((entry) => !entry.ok);
  for (const name of CHECKS) {
    if (!results.some((entry) => entry.name === name)) {
      results.push({ name, ok: false, detail: "check never ran" });
      failed.push(results.at(-1));
      console.log(`FAIL ${name}\n       check never ran`);
    }
  }
  console.log(`\n${results.length - failed.length}/${CHECKS.length} checks passed`);
  if (failed.length > 0) {
    console.log(`profiles kept for inspection: ${HOST_PROFILE} ${CLIENT_PROFILE} ${OVERLAY_PROFILE}`);
    console.log("\nfailures:");
    for (const entry of failed) console.log(`  - ${entry.name}\n      ${entry.detail}`);
    console.log("\ndiagnostics:");
    for (const line of diagnostics) console.log(`  ${line}`);
    process.exitCode = 1;
  } else {
    for (const path of [HOST_PROFILE, CLIENT_PROFILE, OVERLAY_PROFILE, OVERLAY_EXTENSION]) rmSync(path, { recursive: true, force: true });
  }
}

async function writeOptions(page, options) {
  const { options: current } = await stored(page, ["options"]);
  const reply = await message(page, "hoshidicts-worker", "hd_options_write", { baseRevision: current.revision, options });
  if (!reply.ok) throw new Error(`options save failed: ${reply.error}`);
  return reply;
}

async function checkOverlaySharing(hostPage) {
  cpSync(EXTENSION, OVERLAY_EXTENSION, { recursive: true });
  const flagPath = resolve(OVERLAY_EXTENSION, "overlay-mode.js");
  writeFileSync(flagPath, readFileSync(flagPath, "utf8").replace("OVERLAY_MODE = false;", "OVERLAY_MODE = true;"));
  let overlayBrowser = await launch(OVERLAY_PROFILE, OVERLAY_EXTENSION);
  try {
    const id = await extensionId(overlayBrowser);
    let page = await openSettings(overlayBrowser, id, "overlay", "sharing");
    const initial = (await stored(page, ["options"])).options;
    await writeOptions(page, { popupWidthPx: 440, popupTheme: "sunset",
      anki: { ...initial.anki, captureScreenshot: true } });
    await writeOptions(hostPage, { lookupMode: "activationSticky", activationKey: "Control", sourceHighlightEnabled: true,
      popupWidthPx: 1000, popupTheme: "dracula" });
    const linked = await message(page, "hachidori-sharing", "hd_sharing_client_link", { address: ADDRESS });
    if (!linked.ok) throw new Error(linked.error);
    await until(async () => (await sharingStatus(page)).sharing.client.connected, "the overlay link");
    const afterLink = (await stored(page, ["options"])).options;
    const sharedLookup = await lookup(page);
    const notice = await page.$eval("#sharing-overlay-preferences", node => !node.hidden);

    // Exercise the actual Settings autosave, not just its worker endpoint.
    await showSection(page, "design");
    await page.$eval("#opt-popup-width", input => {
      input.value = "480";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
    const afterLocal = (await stored(page, ["options"])).options;
    const hostAfterLocal = (await stored(hostPage, ["options"])).options;
    await writeOptions(hostPage, { popupWidthPx: 1150, popupTheme: "light" });
    await page.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "light");
    const afterHost = (await stored(page, ["options"])).options;
    const mixed = await writeOptions(page, { popupWidthPx: 520, popupTheme: "forest" });
    const hostAfterMixed = (await stored(hostPage, ["options"])).options;
    const stale = await message(page, "hoshidicts-worker", "hd_options_write", {
      baseRevision: afterLink.revision, options: { popupWidthPx: 900 },
    });

    await hostBrowser.close();
    hostBrowser = null;
    await until(async () => !(await sharingStatus(page)).sharing.client.connected, "the disconnected overlay");
    const offline = await writeOptions(page, { popupWidthPx: 680 });
    hostBrowser = await launch(HOST_PROFILE);
    hostPage = await openSettings(hostBrowser, await extensionId(hostBrowser), "host-after-overlay", "sharing");
    await until(async () => (await sharingStatus(page)).sharing.client.connected, "overlay reconnection");
    await overlayBrowser.close();
    overlayBrowser = await launch(OVERLAY_PROFILE, OVERLAY_EXTENSION);
    page = await openSettings(overlayBrowser, id, "overlay-restart", "sharing");
    await until(async () => (await sharingStatus(page)).sharing.client.connected, "the restarted overlay link");
    const afterRestart = (await stored(page, ["options"])).options;
    const unlinked = await message(page, "hachidori-sharing", "hd_sharing_client_unlink");
    const afterUnlink = await stored(page, ["options", "dictionaryState"]);

    // Keep the capability UI check independent of a developer's running Anki.
    const worker = await overlayBrowser.waitForTarget(target => target.type() === "service_worker");
    const cdp = await worker.createCDPSession();
    cdp.on("Fetch.requestPaused", request => {
      void cdp.send("Fetch.failRequest", { requestId: request.requestId, errorReason: "ConnectionRefused" });
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://127.0.0.1:8765*" }] });
    await showSection(page, "anki");
    await page.waitForFunction(() => document.getElementById("opt-anki-screenshot").disabled);
    const screenshot = await page.evaluate(() => ({ disabled: document.getElementById("opt-anki-screenshot").disabled,
      checked: document.getElementById("opt-anki-screenshot").checked,
      help: document.getElementById("anki-screenshot-help").textContent }));
    if (process.env.HACHIDORI_OVERLAY_SETTINGS_SCREENSHOT) {
      await page.setViewport({ width: 1280, height: 1200 });
      await page.$eval("#opt-anki-screenshot", input => input.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: process.env.HACHIDORI_OVERLAY_SETTINGS_SCREENSHOT });
    }
    await showSection(page, "audio");
    const speech = await page.evaluate(() => ({ visible: !document.getElementById("audio-mining-help").hidden,
      help: document.getElementById("audio-mining-help").textContent,
      captureHelpHidden: document.getElementById("audio-speech-capture-help").hidden }));
    await cdp.detach();
    check(CHECKS.at(-1),
      afterLink.lookupMode === "hover" && afterLink.sourceHighlightEnabled === false && afterLink.popupWidthPx === 440
        && afterLink.popupTheme === "dracula" && sharedLookup.ok && notice
        && afterLocal.popupWidthPx === 480 && hostAfterLocal.popupWidthPx === 1000
        && afterHost.popupWidthPx === 480 && mixed.options.popupWidthPx === 520
        && hostAfterMixed.popupWidthPx === 1150 && hostAfterMixed.popupTheme === "forest"
        && stale.ok === false && stale.conflict && offline.options.popupWidthPx === 680
        && afterRestart.popupWidthPx === 680 && unlinked.ok && afterUnlink.options.popupWidthPx === 680
        && afterUnlink.options.popupTheme === "sunset" && afterUnlink.dictionaryState.dictionaries.length === 0
        && afterUnlink.options.anki.captureScreenshot === true && screenshot.disabled && !screenshot.checked
        && screenshot.help.includes("unavailable in this overlay") && speech.visible && speech.captureHelpHidden
        && speech.help.includes("cannot be recorded into Anki"),
      JSON.stringify({ afterLink, afterLocal, hostAfterLocal, afterHost, mixed, hostAfterMixed, stale, offline, afterRestart,
        afterUnlink, screenshot, speech, notice }));
  } finally { await overlayBrowser?.close().catch(() => {}); }
}

if (!existsSync(CHROME)) fatal(`Chrome not found; set HACHIDORI_CHROME (tried ${CHROME || "nothing"})`);
if (!existsSync(FIXTURE)) fatal(`missing ${FIXTURE}; run node test/make-fixture.mjs first`);
for (const path of [HOST_PROFILE, CLIENT_PROFILE, OVERLAY_PROFILE, OVERLAY_EXTENSION]) rmSync(path, { recursive: true, force: true });
let relay = null;
let hostBrowser = null;
let clientBrowser = null;
let hostAnki = null;
let clientAnki = null;
try {
  hostAnki = await startMockAnkiConnect("host-secret");
  clientAnki = await startMockAnkiConnect("client-secret");
  console.log(`     host AnkiConnect mock: ${hostAnki.url}`);
  console.log(`     client AnkiConnect trap: ${clientAnki.url}`);
  hostBrowser = await launch(HOST_PROFILE);
  const hostId = await extensionId(hostBrowser);
  console.log(`     host extension id: ${hostId}`);
  let hostPage = await openSettings(hostBrowser, hostId, "host", "add-dictionaries");
  await importFixture(hostPage);

  // Until Anki carries the connection the page offers the add-on; the host is still trying the default port.
  const addon = await downloadAddon(hostPage);
  check(CHECKS[0],
    ["__init__.py", "server.py", "config.json"].every(name => addon.files.includes(name)) && addon.manifest?.package === "hachidori-relay"
      && addon.manifest.human_version === ANKI_ADDON_VERSION && Number.isInteger(addon.manifest.mod) && addon.size > 1000
      && addon.status === "Saved hachidori-relay.ankiaddon to your downloads. Double-click it to install it in Anki, then restart Anki.",
    JSON.stringify(addon));

  relay = await startAnkiRelayServer({ archive: addon.file, port: PORT, serverPath: process.env.HACHIDORI_RELAY_SERVER });
  console.log(`     downloaded relay v${addon.manifest.human_version} listening on 127.0.0.1:${relay.port}`);

  const hostSharing = await enableSharing(hostPage);
  const hostState = await stored(hostPage, ["dictionaryState", "options"]);
  check(CHECKS[1],
    hostSharing.enabled === true && hostSharing.connected === true && hostSharing.port === PORT && hostSharing.error === null
      && hostSharing.dictionaries === 1 && hostSharing.network?.enabled === false && hostSharing.network.active === false
      && hostState.dictionaryState?.dictionaries?.some((dictionary) => dictionary.title === "hachidori-fixture") === true,
    JSON.stringify({ hostSharing, dictionaries: hostState.dictionaryState?.dictionaries?.map((entry) => entry.title) }));

  clientBrowser = await launch(CLIENT_PROFILE);
  const clientId = await extensionId(clientBrowser);
  console.log(`     client extension id: ${clientId}`);
  // A fresh install opens its startup page, whose look around this computer
  // uses the port under Advanced; the suite moves that to the relay's port, as
  // a person on a changed port would have, and lets the page look again.
  const startup = await startupPage(clientBrowser, clientId, "client-startup");
  const clientPort = await message(startup, "hachidori-sharing", "hd_sharing_host_enable", { port: PORT });
  if (clientPort?.ok !== true) throw new Error(`the client port could not be set: ${clientPort?.error}`);
  await startup.reload({ waitUntil: "domcontentloaded" });
  await startup.waitForSelector("#setup-use-shared", { timeout: 15_000 });
  const offer = await startup.evaluate(() => ({
    body: document.getElementById("setup-body").textContent, button: document.getElementById("setup-use-shared").textContent,
  }));
  const probe = await message(startup, "hachidori-sharing", "hd_sharing_client_probe", { address: "" });
  const before = await stored(startup, ["dictionaryState"]);
  await screenshot(startup, "sharing-startup.png", { section: null, element: "setup-card" });
  await startup.bringToFront();
  await startup.click("#setup-use-shared");
  await startup.waitForFunction(() => document.getElementById("setup-heading")?.textContent === "Setup is complete.", { timeout: 30_000, polling: 100 });
  const linked = await until(async () => {
    const reply = await sharingStatus(startup);
    return reply?.sharing?.client?.connected ? reply.sharing : null;
  }, "the linked browser to connect", 30_000);
  const setup = await stored(startup, ["setupState"]);
  let clientPage = await openSettings(clientBrowser, clientId, "client", "sharing");
  const mirror = await stored(clientPage, ["dictionaryState", "options", "sharingLocalState", "sharing"]);
  const hostAfterLink = await stored(hostPage, ["dictionaryState", "options"]);
  const linkedLookup = await lookup(clientPage);
  const hostClients = (await sharingStatus(hostPage)).sharing.clients;
  await screenshot(hostPage, "sharing-settings.png");
  await screenshot(clientPage, "sharing-linked.png");
  const statusCards = await Promise.all([hostPage, clientPage].map(page => page.$eval("#sharing-status", (node) => {
    const style = getComputedStyle(node);
    const marker = getComputedStyle(node, "::before");
    const rect = node.getBoundingClientRect();
    const parent = node.parentElement.getBoundingClientRect();
    return {
      display: style.display,
      fontSize: Number.parseFloat(style.fontSize),
      height: rect.height,
      fullWidth: Math.abs(rect.width - parent.width) <= 1,
      marker: marker.content,
      ready: node.classList.contains("is-ready"),
    };
  })));
  const hostName = probe?.host?.name;
  check(CHECKS[2],
    probe?.ok === true && probe.display === "this computer" && typeof hostName === "string" && hostName !== ""
      && probe.host.dictionaryCount === hostState.dictionaryState.dictionaries.length
      && offer.body.includes(`${hostName} on this computer already has Hachidori set up, with 1 dictionary.`)
      && offer.button === `Use the Hachidori in ${hostName}`
      && setup.setupState?.stage === "complete"
      && linked.enabled === false && linked.client.address === ADDRESS && linked.client.display === "this computer"
      && linked.client.host?.name === hostName && linked.client.host.dictionaryCount === hostState.dictionaryState.dictionaries.length
      && linked.client.host.capabilities?.includes("linked-anki-v1")
      && JSON.stringify(mirror.dictionaryState) === JSON.stringify(hostAfterLink.dictionaryState)
      && JSON.stringify(mirror.options) === JSON.stringify(hostAfterLink.options)
      // The fresh browser's own library, empty whether or not its engine had committed it yet, is what is kept aside.
      && (mirror.sharingLocalState?.dictionaryState?.dictionaries ?? []).length === 0 && (before.dictionaryState?.dictionaries ?? []).length === 0
      && mirror.sharing?.client?.address === ADDRESS && mirror.sharing?.host?.enabled === false
      && linkedLookup?.ok === true && linkedLookup.results?.[0]?.deinflected === "食べる"
      && hostClients.length === 1 && hostClients[0].local === true && hostClients[0].name === hostName
      && hostClients[0].capabilities?.includes("linked-anki-v1")
      && statusCards.every(card => card.display === "grid" && card.fontSize >= 16 && card.height >= 56
        && card.fullWidth && card.marker.includes("✓") && card.ready),
    JSON.stringify({ probe, offer, setup: setup.setupState?.stage, linked, linkedLookup: { ok: linkedLookup?.ok, error: linkedLookup?.error, first: linkedLookup?.results?.[0]?.deinflected },
      own: before.dictionaryState ?? null, kept: mirror.sharingLocalState?.dictionaryState ?? null, sharing: mirror.sharing,
      mirrorRevision: mirror.dictionaryState?.revision, hostRevision: hostAfterLink.dictionaryState?.revision, hostClients, statusCards }));

  if (process.env.HACHIDORI_SHARING_BENCHMARK) {
    const { measureSharingLookups } = await import("../benchmark/sharing-latency.mjs");
    await measureSharingLookups(clientPage, clientBrowser, relay.serverPath, process.env.HACHIDORI_SHARING_BENCHMARK);
  }

  const baseRevision = mirror.options?.revision ?? 0;
  const written = await message(clientPage, "hoshidicts-worker", "hd_options_write", { baseRevision, options: { scanLength: 7 } });
  const hostOptions = await until(async () => {
    const value = (await stored(hostPage, ["options"])).options;
    return value?.scanLength === 7 ? value : null;
  }, "the host to commit the linked browser's options edit", 15_000);
  const mirroredOptions = await until(async () => {
    const value = (await stored(clientPage, ["options"])).options;
    return value?.scanLength === 7 ? value : null;
  }, "the host's options batch to reach the linked browser", 15_000);
  check(CHECKS[3],
    written?.ok === true && written.options?.scanLength === 7 && written.options.revision === baseRevision + 1
      && hostOptions.revision === written.options.revision && mirroredOptions.revision === written.options.revision,
    JSON.stringify({ written, hostOptions, mirroredOptions }));

  const saved = await message(clientPage, "hoshidicts-offscreen", "hd_custom_save", { baseDocumentRevision: 0, text: CUSTOM_SOURCE });
  const hostSource = await until(async () => {
    const value = (await stored(hostPage, [CUSTOM_DICTIONARY_SOURCE_KEY, "dictionaryState"]));
    return value[CUSTOM_DICTIONARY_SOURCE_KEY]?.text === CUSTOM_SOURCE ? value : null;
  }, "the host to store the linked browser's personal source", 60_000);
  const customLookup = await message(clientPage, "hoshidicts-offscreen", "hd_lookup_dictionary", { dictionary: CUSTOM_DICTIONARY_TITLE, text: "共有語" });
  const mirroredSource = await until(async () => {
    const value = (await stored(clientPage, [CUSTOM_DICTIONARY_SOURCE_KEY])) [CUSTOM_DICTIONARY_SOURCE_KEY];
    return value?.text === CUSTOM_SOURCE ? value : null;
  }, "the personal source to reach the linked browser", 15_000);
  check(CHECKS[4],
    saved?.ok === true && hostSource.dictionaryState?.dictionaries?.[0]?.id === CUSTOM_DICTIONARY_ID
      && customLookup?.ok === true && (customLookup.results?.length ?? 0) > 0
      && mirroredSource.revision === hostSource[CUSTOM_DICTIONARY_SOURCE_KEY].revision,
    JSON.stringify({ saved: { ok: saved?.ok, error: saved?.error }, customLookup: { ok: customLookup?.ok, count: customLookup?.results?.length, error: customLookup?.error } }));

  const configuredAnki = await configureAnki(hostPage, hostAnki.url, "host-secret");
  if (!configuredAnki?.ok) throw new Error(`the host Anki configuration could not be saved: ${configuredAnki?.error}`);
  const mirroredAnki = await until(async () => {
    const value = (await stored(clientPage, ["options"])).options?.anki;
    return value?.url === hostAnki.url && value.apiKey === "host-secret" ? value : null;
  }, "the host Anki configuration to reach the linked browser", 15_000);
  // Give the linked browser a different healthy endpoint. Every linked Anki
  // operation must still use the host's endpoint and key.
  await setLocalAnkiEndpoint(startup, clientAnki.url, "client-secret");
  const clientEndpoint = (await stored(startup, ["options"])).options.anki;
  const ankiDiscovery = await message(clientPage, "hoshidicts-worker", "hd_anki_discover", {
    model: "Basic",
    url: clientAnki.url,
    apiKey: "client-secret",
  });
  const miningLookup = await lookup(clientPage);
  if (!miningLookup?.ok || !miningLookup.results?.length) {
    throw new Error(`the linked Anki fixture lookup failed: ${miningLookup?.error}`);
  }
  const ankiStatus = await message(startup, "hachidori-anki", "hd_anki_status");
  const request = {
    ...miningLookup.results[0],
    generation: miningLookup.generation,
    sentence: "食べたかった。",
    matched: "食べたかった",
    matchOffset: 0,
    popupSelectionText: "",
    searchQuery: "食べたかった",
    documentTitle: "Linked browser mining",
    dictionaryAliases: {},
    frequencyDictionaries: [],
    configKey: ankiStatus.configKey,
    // These are deliberately hostile. The host allowlist must discard them
    // and bind the transaction to its own saved Anki settings.
    url: clientAnki.url,
    apiKey: "client-secret",
    anki: { url: clientAnki.url, apiKey: "client-secret" },
  };
  const preflight = await message(startup, "hachidori-anki", "hd_anki_preflight", { request });
  await startup.setViewport({ width: 640, height: 480, deviceScaleFactor: 1 });
  await startup.evaluate(() => {
    const proof = document.createElement("div");
    proof.id = "linked-anki-screenshot-proof";
    Object.assign(proof.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      background: "rgb(17, 201, 83)",
    });
    document.documentElement.append(proof);
  });
  await startup.bringToFront();
  const captured = await message(startup, "hachidori-anki", "hd_anki_screenshot", { request });
  await startup.evaluate(() => document.getElementById("linked-anki-screenshot-proof")?.remove());
  const submittedRequest = { ...request, screenshot: { token: captured.token, filename: captured.filename } };
  const submitted = await message(startup, "hachidori-anki", "hd_anki_submit", { request: submittedRequest });
  const browsed = await message(startup, "hachidori-anki", "hd_anki_browse",
    { request: { noteIds: [submitted.noteId], expression: request.term.expression } });
  const addsBeforeStale = hostAnki.state.calls.filter(call => call.action === "addNote").length;
  const stale = await message(startup, "hachidori-anki", "hd_anki_submit", {
    request: { ...request, generation: request.generation + 1 },
  });
  const addsAfterStale = hostAnki.state.calls.filter(call => call.action === "addNote").length;
  const note = hostAnki.state.notes.get(submitted.noteId);
  const screenshotFilename = /<img src="([^"]+)">/u.exec(note?.fields?.Picture ?? "")?.[1] ?? null;
  const screenshotData = screenshotFilename === null ? null : hostAnki.state.media.get(screenshotFilename);
  const screenshotProof = screenshotData === null ? null : await startup.evaluate(async data => {
    const response = await fetch(`data:image/jpeg;base64,${data}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      centre: [...context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data],
    };
  }, screenshotData);
  // The configuration cache is valid for two seconds. Let it expire so this
  // status call must ask the now-unavailable host endpoint.
  await new Promise(resolveWait => setTimeout(resolveWait, 2200));
  hostAnki.state.online = false;
  const unavailableAnki = await message(startup, "hachidori-anki", "hd_anki_status");
  hostAnki.state.online = true;
  const hostActions = hostAnki.state.calls.map(call => call.action);
  const centre = screenshotProof?.centre ?? [];
  check(CHECKS[5],
    mirroredAnki.url === hostAnki.url && clientEndpoint.url === clientAnki.url
      && ankiDiscovery?.ok === true && ankiDiscovery.connected === true
      && JSON.stringify(ankiDiscovery.decks) === JSON.stringify(["Default"])
      && JSON.stringify(ankiDiscovery.models) === JSON.stringify(["Basic"])
      && JSON.stringify(ankiDiscovery.fields) === JSON.stringify(["Front", "Back", "Picture"])
      && ankiStatus?.ok === true && ankiStatus.available === true && typeof ankiStatus.configKey === "string"
      && preflight?.ok === true && preflight.state === "addable" && preflight.canAdd === true && preflight.screenshot === true
      && captured?.ok === true && /^hachidori-screenshot-[0-9a-f-]{36}\.jpg$/u.test(captured.filename ?? "")
      && submitted?.ok === true && submitted.state === "added" && Number.isInteger(submitted.noteId)
      && note?.fields?.Front === request.term.expression && note.fields.Back.includes("食べたかった")
      && screenshotFilename === captured.filename && typeof screenshotData === "string"
      && Buffer.from(screenshotData, "base64").subarray(0, 3).toString("hex") === "ffd8ff"
      && screenshotProof?.width === 640 && screenshotProof.height === 480
      && centre[1] > 150 && centre[1] > centre[0] + 80 && centre[1] > centre[2] + 70
      && browsed?.ok === true && browsed.opened === true && hostActions.includes("guiBrowse")
      && stale?.ok === false && /dictionary generation changed/iu.test(stale.error)
      && addsBeforeStale === 1 && addsAfterStale === addsBeforeStale
      && unavailableAnki?.ok === true && unavailableAnki.available === false
      && /AnkiConnect returned HTTP 503/u.test(unavailableAnki.error)
      && hostAnki.state.calls.every(call => call.key === "host-secret")
      && clientAnki.state.calls.length === 0,
    JSON.stringify({
      configured: configuredAnki.ok,
      mirroredUrl: mirroredAnki.url,
      clientUrl: clientEndpoint.url,
      status: ankiStatus,
      discovery: ankiDiscovery,
      preflight,
      captured: { ok: captured?.ok, filename: captured?.filename },
      submitted,
      note: note?.fields,
      screenshot: screenshotProof,
      browsed,
      stale: { ok: stale?.ok, error: stale?.error, addsBeforeStale, addsAfterStale },
      unavailableAnki,
      hostActions,
      hostKeys: [...new Set(hostAnki.state.calls.map(call => call.key))],
      clientCalls: clientAnki.state.calls.map(call => call.action),
    }));

  await hostBrowser.close();
  hostBrowser = null;
  // The relay closes the linked browser's socket once it notices the host is gone.
  const unreachable = await until(async () => {
    const reply = await lookup(clientPage);
    return reply?.ok === false ? reply : null;
  }, "linked lookups to fail after the host closed", 30_000, 500);
  hostBrowser = await launch(HOST_PROFILE);
  const relaunchedId = await extensionId(hostBrowser);
  hostPage = await openSettings(hostBrowser, relaunchedId, "host-again", "sharing");
  const reconnected = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.connected ? reply.sharing.client : null;
  }, "the linked browser to reconnect after the host relaunched", 60_000, 500);
  const recovered = await lookup(clientPage);
  check(CHECKS[6],
    unreachable.error === "The linked Hachidori is not reachable." && relaunchedId === hostId
      && reconnected.address === ADDRESS && recovered?.ok === true && recovered.results?.[0]?.deinflected === "食べる",
    JSON.stringify({ unreachable: { ok: unreachable?.ok, error: unreachable?.error }, reconnected, recovered: { ok: recovered?.ok, error: recovered?.error } }));

  await showSection(clientPage, "sharing");
  await clientPage.waitForFunction(() => document.getElementById("sharing-client-unlink")?.hidden === false, { timeout: 15_000, polling: 100 });
  await clientPage.bringToFront();
  await Promise.all([
    clientPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    clientPage.click("#sharing-client-unlink"),
  ]);
  const afterUnlink = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.linked === false ? reply.sharing.client : null;
  }, "the linked browser to unlink", 15_000);
  const ownState = await stored(clientPage, ["dictionaryState", "options", "sharingLocalState", "sharing", CUSTOM_DICTIONARY_SOURCE_KEY]);
  const ownLookup = await lookup(clientPage);
  check(CHECKS[7],
    afterUnlink.linked === false
      && (ownState.dictionaryState?.dictionaries ?? []).length === 0
      && ownState.sharingLocalState === undefined
      && ownState[CUSTOM_DICTIONARY_SOURCE_KEY] === undefined && ownState.sharing?.client === null
      && ownState.options?.revision > (mirroredOptions.revision ?? 0)
      && ownLookup?.ok === true && (ownLookup.results?.length ?? 0) === 0,
    JSON.stringify({ afterUnlink, keys: Object.keys(ownState), ownOptions: ownState.options, ownLookup: { ok: ownLookup?.ok, count: ownLookup?.results?.length, error: ownLookup?.error } }));

  // Other computers: the host asks the relay for the network, and the second
  // browser links through this computer's own network address, as a laptop would.
  const networkOn = await message(hostPage, "hachidori-sharing", "hd_sharing_host_enable", { port: PORT, network: true });
  const hostNetwork = await until(async () => {
    const reply = await sharingStatus(hostPage);
    return reply?.sharing?.network?.active && reply.sharing.network.addresses.length > 0 ? reply.sharing.network : null;
  }, "the relay to open the network and report an address (this machine needs one beyond loopback)", 15_000);
  await showSection(hostPage, "sharing");
  await hostPage.waitForFunction((count) => document.querySelectorAll("#sharing-host-address-list code").length === count, { timeout: 10_000, polling: 100 }, hostNetwork.addresses.length);
  const shown = await hostPage.evaluate(() => ({
    status: document.getElementById("sharing-status").textContent,
    addresses: [...document.querySelectorAll("#sharing-host-address-list code")].map((node) => node.textContent),
  }));
  const remoteAddress = hostNetwork.addresses[0].address;
  const remote = `${remoteAddress}:${PORT}`;
  await showSection(clientPage, "sharing");
  await clientPage.waitForFunction(() => document.getElementById("sharing-client-link")?.hidden === false && !document.getElementById("sharing-client-link").disabled, { timeout: 15_000, polling: 100 });
  await clientPage.$eval("#sharing-client-address", (input, value) => { input.value = value; }, remote);
  await clientPage.bringToFront();
  await Promise.all([
    clientPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    clientPage.click("#sharing-client-link"),
  ]);
  const remoteLinked = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.connected ? reply.sharing.client : null;
  }, "the browser to link through the network address", 30_000);
  const remoteLookup = await lookup(clientPage);
  const remoteClients = (await sharingStatus(hostPage)).sharing.clients;
  const hostDictionaries = (await stored(hostPage, ["dictionaryState"])).dictionaryState.dictionaries.length;
  await clientPage.waitForFunction(() => document.getElementById("sharing-status")?.textContent.startsWith("Using the Hachidori in"), { timeout: 15_000, polling: 100 });
  const remoteStatus = await statusText(clientPage);
  const networkOff = await message(hostPage, "hachidori-sharing", "hd_sharing_host_enable", { port: PORT, network: false });
  const dropped = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.connected === false ? reply.sharing.client : null;
  }, "the network link to drop when the host stops sharing on the network", 15_000);
  const hostAfterOff = await until(async () => {
    const reply = await sharingStatus(hostPage);
    return reply?.sharing?.network?.active === false && reply.sharing.clients.length === 0 ? reply.sharing : null;
  }, "the relay to close the network", 15_000);
  const cleanup = await message(clientPage, "hachidori-sharing", "hd_sharing_client_unlink");
  // The relay must have survived the swap back: this computer still finds the host through it.
  const stillThere = await message(clientPage, "hachidori-sharing", "hd_sharing_client_probe", { address: "" });
  check(CHECKS[8],
    networkOn?.ok === true && hostNetwork.enabled === true
      && shown.status === "Sharing through Anki, on this computer and the network."
      && shown.addresses.join(",") === hostNetwork.addresses.map((entry) => entry.address).join(",")
      && remoteLinked.address === `ws://${remoteAddress}:${PORT}/link` && remoteLinked.display === remote
      && remoteLookup?.ok === true && remoteLookup.results?.[0]?.deinflected === "食べる"
      && remoteClients.length === 1 && remoteClients[0].local === false && remoteClients[0].address === remoteAddress
      && remoteStatus === `Using the Hachidori in ${hostName} at ${remote} (${hostDictionaries} dictionaries).`
      && networkOff?.ok === true && dropped.linked === true && hostAfterOff.network.active === false && hostAfterOff.connected === true
      && cleanup?.ok === true && stillThere?.ok === true && relay.exitCode === null,
    JSON.stringify({ networkOn: networkOn?.ok, hostNetwork, shown, remoteLinked, remoteLookup: { ok: remoteLookup?.ok, error: remoteLookup?.error, first: remoteLookup?.results?.[0]?.deinflected },
      remoteClients, remoteStatus, networkOff: networkOff?.ok, dropped, hostAfterOff: { network: hostAfterOff.network, connected: hostAfterOff.connected, clients: hostAfterOff.clients.length },
      cleanup: cleanup?.ok, stillThere: stillThere?.ok, relayExit: relay.exitCode }));

  const localText = "私語,しご,local personal entry preserved across sharing\n";
  const localBase = await message(clientPage, "hoshidicts-worker", "hd_custom_read");
  const localSave = await message(clientPage, "hoshidicts-offscreen", "hd_custom_save",
    { baseDocumentRevision: localBase.document.revision, text: localText });
  if (!localSave?.ok) throw new Error(`local personal entry could not be saved: ${localSave?.error}`);
  const localOptions = (await stored(clientPage, ["options"])).options;
  const localEdit = await message(clientPage, "hoshidicts-worker", "hd_options_write",
    { baseRevision: localOptions.revision, options: { scanLength: 11 } });
  const localBefore = await stored(clientPage, ["dictionaryState", "options", CUSTOM_DICTIONARY_SOURCE_KEY]);
  const secondPage = await openSettings(clientBrowser, clientId, "client-second-tab", "sharing");
  // Hold the host's hello snapshot until both real Settings tabs have sent Link.
  // The sockets, worker handlers and browser storage remain the production path.
  const hostWorker = await (await hostBrowser.waitForTarget(target => target.type() === "service_worker")).worker();
  await hostWorker.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    let release;
    const held = new Promise(resolveHeld => { release = resolveHeld; });
    chrome.storage.local.get = async keys => {
      if (Array.isArray(keys) && keys.length === 5 && keys.includes("customDictionarySource") && keys.includes("lookupStats")) await held;
      return get(keys);
    };
    globalThis.releaseSharingHello = () => { chrome.storage.local.get = get; release(); };
  });
  try {
    await Promise.all([clientPage, secondPage].map(page => page.evaluate(address => {
      globalThis.sharingLinkReply = chrome.runtime.sendMessage({ target: "hachidori-sharing", type: "hd_sharing_client_link", address });
    }, ADDRESS)));
  } finally {
    await hostWorker.evaluate(() => { globalThis.releaseSharingHello(); delete globalThis.releaseSharingHello; });
  }
  const concurrentLinks = await Promise.all([clientPage, secondPage].map(page => page.evaluate(() => globalThis.sharingLinkReply)));
  await until(async () => (await sharingStatus(clientPage)).sharing.client.connected, "the concurrent link to connect");
  const keptLocal = (await stored(clientPage, ["sharingLocalState"])).sharingLocalState;
  const concurrentUnlinks = await Promise.all([clientPage, secondPage].map(page => message(page, "hachidori-sharing", "hd_sharing_client_unlink")));
  await message(secondPage, "hachidori-sharing", "hd_sharing_client_unlink");
  const localAfter = await stored(clientPage, ["dictionaryState", "options", CUSTOM_DICTIONARY_SOURCE_KEY, "sharingLocalState"]);
  const personalLookup = await lookup(clientPage, "私語");
  check(CHECKS[10],
    localEdit?.ok && concurrentLinks.every(reply => reply?.ok) && concurrentUnlinks.every(reply => reply?.ok && !reply.sharing.client.linked)
      && keptLocal?.customDictionarySource?.text === localText && keptLocal.options?.scanLength === 11
      && localAfter.customDictionarySource?.text === localText && localAfter.options?.scanLength === 11
      && localAfter.customDictionarySource.revision > localBefore.customDictionarySource.revision
      && JSON.stringify(localAfter.dictionaryState?.dictionaries) === JSON.stringify(localBefore.dictionaryState?.dictionaries)
      && localAfter.sharingLocalState === undefined && personalLookup?.ok && personalLookup.results?.[0]?.term?.expression === "私語",
    JSON.stringify({ concurrentLinks, concurrentUnlinks, keptLocal, localBefore, localAfter, personalLookup }));
  await secondPage.close();
  await checkOverlaySharing(hostPage);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await hostBrowser?.close().catch(() => {});
  await clientBrowser?.close().catch(() => {});
  await relay?.close();
  await hostAnki?.close().catch(() => {});
  await clientAnki?.close().catch(() => {});
  report();
}
