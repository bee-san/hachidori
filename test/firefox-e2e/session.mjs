/*
 * Shared setup for the real-Firefox suite: launching Firefox with the Firefox
 * build installed as a temporary add-on, the page server, request interception
 * over WebDriver BiDi, and helpers for extension pages and the popup.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RECOMMENDED_DICTIONARIES as CATALOGUE } from "../../extension/recommended-dictionaries.js";
import { makeAudioWav, RECOMMENDED_FIXTURE_METADATA } from "../make-fixture.mjs";
import { diagnostics, fatal, keepProfiles, report } from "./harness.mjs";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = process.env.HACHIDORI_FIREFOX_EXTENSION || resolve(HERE, "tmp/firefox-extension");
const FIREFOX = process.env.HACHIDORI_FIREFOX;
const PUPPETEER = process.env.HACHIDORI_PUPPETEER;
const GECKO_ID = "hachidori@bee-san";
// Pinned so extension URLs are known before the add-on is installed.
const UUID = "5a1d4c2e-8f3b-4e6a-9c7d-0b1e2f3a4b5c";
const ORIGIN = `moz-extension://${UUID}`;
const PROFILE = process.env.HACHIDORI_FIREFOX_PROFILE || resolve(tmpdir(), `hachidori-firefox-profile-${process.pid}`);
const FIXTURE = resolve(HERE, "fixtures/hachidori-fixture.zip");
const FIXTURE_ID = "921c9971654f69cd1ad6d0e2f89b990c";
const HIGHLIGHT_NAME = /const HIGHLIGHT_NAME = "([^"]+)";/u.exec(readFileSync(resolve(HERE, "../extension/content.js"), "utf8"))?.[1];
const ANKI_PATH = "/anki-connect";
// AnkiConnect at this path drops the connection, as a closed port does.
const ANKI_REFUSED_PATH = "/anki-refused";
// WebDriver BiDi does not report the background page's own requests, so the
// managed-update index it fetches comes from a local HTTPS server under a test
// domain that Firefox resolves to this computer, with its certificate accepted
// for the session.
const UPDATE_HOST = "updates.hachidori.test";
const RECOMMENDED = CATALOGUE.map(entry => ({ ...entry, ...RECOMMENDED_FIXTURE_METADATA[entry.sourceId] }));

const PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>hachidori firefox e2e</title>
<style>
  body { font: 32px/2 serif; padding: 60px; margin: 0; }
  span { display: inline-block; }
  iframe { width: 600px; height: 160px; border: 0; }
</style></head>
<body>
  <p><span id="verb">食べたかった</span></p>
  <p><span id="kanjiword">漢字</span></p>
  <p><span id="latin">hello world</span></p>
  <p><span id="cat">猫</span></p>
  <p><span id="select">ありがとう</span></p>
</body></html>`;
const FRAME_PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>body { font: 32px serif; padding: 60px; }</style></head>
<body><p><span id="before">食べたかった</span></p><iframe id="frame" src="/frame"></iframe></body></html>`;
const FRAME_HTML = '<!doctype html><html lang="ja"><meta charset="utf-8"><body style="font: 32px serif; padding: 20px"><span id="frame-verb">食べたかった</span></body></html>';

let launchApi = null;
let browser = null;
let page = null;
let bidi = null;
let server = null;
let serverUrl = "";
let installedId = null;
let downloads = "";
let updateServer = null;
let updateOrigin = "";
// Paths the update server answers: { requests, status, body, contentType }.
const updateRoutes = new Map();
// Routes for the URLs this suite answers in place of the network, by exact URL.
// Each is { requests, status, body, contentType, fail?, respond?(request) }.
const routes = new Map();
// Handlers for POSTs to the page server's fake AnkiConnect.
const anki = { handle: null, requests: [], refused: 0 };
const servedAudio = new Map();
// Local files the page server streams, by path: archives too large to hand
// to a page through WebDriver BiDi.
const servedFiles = new Map();

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

async function waitFor(predicate, { timeout = 30_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate().catch(error => ({ error: String(error) }));
    if (last && !last.error) return last;
    await sleep(interval);
  }
  return null;
}

// A page's top-level browsing context, or a frame's own.
function browsingContextOf(target) {
  return (typeof target.mainFrame === "function" ? target.mainFrame() : target).browsingContext;
}

function bidiSession(target) {
  return browsingContextOf(target).userContext.browser.session;
}

function contextId(target) {
  return browsingContextOf(target).id;
}

// Intercepted requests are answered from `routes`; a URL the intercept matches
// without a route continues to the network.
async function answerIntercepted(session, event) {
  if (process.env.HACHIDORI_LOG_REQUESTS === "1") diagnostics.push(`[request] ${event.isBlocked ? "blocked" : "seen"} ${event.request.url}`);
  if (!event.isBlocked) return;
  const { url, request } = event.request;
  const route = routes.get(url);
  try {
    if (!route) {
      await session.send("network.continueRequest", { request });
      return;
    }
    route.requests = (route.requests ?? 0) + 1;
    if (route.fail) {
      await session.send("network.failRequest", { request });
      return;
    }
    const response = route.respond ? await route.respond(event.request) : route;
    if (response.hold) await response.hold;
    const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body ?? "");
    const headers = [
      ["access-control-allow-origin", "*"],
      ["content-type", response.contentType ?? "application/octet-stream"],
      ...(response.contentLength === false ? [] : [["content-length", String(body.length)]]),
    ].map(([name, value]) => ({ name, value: { type: "string", value } }));
    await session.send("network.provideResponse", { request, statusCode: response.status ?? 200,
      reasonPhrase: response.status && response.status !== 200 ? "Error" : "OK", headers,
      body: { type: "base64", value: body.toString("base64") } });
  } catch (error) {
    diagnostics.push(`[intercept ${url}] ${error?.stack ?? error}`);
    await session.send("network.failRequest", { request }).catch(() => {});
  }
}

// The catalogue's archives, which the engine downloads in place of the
// publishers' real ones.
function interceptedUrls() {
  return RECOMMENDED.flatMap(entry => [entry.downloadUrl, entry.indexUrl]);
}

async function launchFirefox(profile) {
  mkdirSync(profile, { recursive: true });
  const downloadDir = `${profile}-downloads`;
  mkdirSync(downloadDir, { recursive: true });
  keepProfiles(profile, downloadDir);
  const next = await launchApi.launch({
    browser: "firefox", executablePath: FIREFOX, headless: true, userDataDir: profile, protocolTimeout: 180_000,
    acceptInsecureCerts: true,
    dumpio: process.env.HACHIDORI_DUMPIO === "1",
    // Lets WebDriver BiDi open and script extension pages and about:addons.
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ [GECKO_ID]: UUID }),
      // A relaunch reinstalls the temporary add-on into the storage it left.
      "extensions.webextensions.keepStorageOnUninstall": true,
      "extensions.webextensions.keepUuidOnUninstall": true,
      // permissions.request() for userScripts is granted without a prompt.
      "extensions.webextOptionalPermissionPrompts": false,
      "browser.download.dir": downloadDir,
      "browser.download.folderList": 2,
      "browser.download.useDownloadDir": true,
      "browser.download.start_downloads_in_tmp_dir": false,
      "media.autoplay.default": 0,
      "network.dns.localDomains": UPDATE_HOST,
      // Settings asks before leaving unsaved work; the suite never has any.
      "dom.disable_beforeunload": true,
    },
  });
  const [first] = await next.pages();
  const session = bidiSession(first);
  session.on("network.beforeRequestSent", event => { void answerIntercepted(session, event); });
  session.on("log.entryAdded", entry => diagnostics.push(`[${entry.level}] ${entry.text}`));
  await session.send("session.subscribe", { events: ["network.beforeRequestSent", "log.entryAdded"] });
  await session.send("network.addIntercept", { phases: ["beforeRequestSent"],
    urlPatterns: interceptedUrls().map(pattern => ({ type: "string", pattern })) });
  return { browser: next, session, downloads: downloadDir, first };
}

async function installHachidori(target = browser) {
  return target.installExtension(EXTENSION);
}

// Navigates a tab and waits for the document; Firefox reports no load events
// for extension pages over BiDi, so readiness is polled instead.
async function navigate(target, url) {
  await bidiSession(target).send("browsingContext.navigate", { context: contextId(target), url, wait: "none" });
  const loaded = await waitFor(() => target.evaluate(expected =>
    location.href === expected && document.readyState === "complete", url), { timeout: 60_000 });
  if (!loaded) throw new Error(`${url} did not load`);
  return target;
}

async function openPage(url, target = browser) {
  return navigate(await target.newPage(), url);
}

const extensionUrl = path => `${ORIGIN}/${path}`;
const openExtensionPage = (path, target = browser) => openPage(extensionUrl(path), target);

// Brings a tab to the front. WebDriver BiDi will not activate an extension
// page, so an extension page activates its own tab.
async function activate(target) {
  const href = await target.evaluate(() => location.href);
  if (href.startsWith(ORIGIN)) {
    await target.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    });
  } else {
    await target.bringToFront();
  }
  return target;
}

// The tab showing an extension page the extension opened itself.
async function findPage(path, target = browser) {
  const url = extensionUrl(path);
  return waitFor(async () => {
    for (const candidate of await target.pages()) {
      const href = await candidate.evaluate(() => location.href).catch(() => "");
      if (href.startsWith(url)) return candidate;
    }
    return false;
  });
}

// A same-URL navigation keeps the document when only the hash differs, so the
// page reloads itself and the new document is told from the old by a marker.
async function reloadPage(target) {
  await target.evaluate(() => {
    window.hachidoriSuiteOldDocument = true;
    setTimeout(() => location.reload(), 0);
  });
  const reloaded = await waitFor(() => target.evaluate(() => !window.hachidoriSuiteOldDocument
    && document.readyState === "complete"), { timeout: 60_000 });
  if (!reloaded) throw new Error("the page did not reload");
  return target;
}

// A file input in an extension page: WebDriver BiDi's input.setFiles refuses
// privileged documents, so the files are given to the input through a
// DataTransfer and its change event, as a drop or the picker would. A file
// with a `url` is read by the page from that address instead of being sent.
async function setInputFiles(target, selector, files) {
  const payload = files.map(file => ({ name: file.name, type: file.type ?? "application/zip", url: file.url ?? null,
    base64: file.url ? null : (file.bytes ?? readFileSync(file.path)).toString("base64") }));
  return target.evaluate(async (inputSelector, json) => {
    const transfer = new DataTransfer();
    for (const { name, type, url, base64 } of JSON.parse(json)) {
      const bytes = url ? await (await fetch(url)).blob() : Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      transfer.items.add(new File([bytes], name, { type }));
    }
    const input = document.querySelector(inputSelector);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.files.length;
  }, selector, JSON.stringify(payload));
}

// Calls `source` (a function source) with the popup's shadow root as its first
// argument, in the page's own realm. BiDi serialises a closed shadow root as
// well as an open one, so this does not depend on the root's mode.
async function inPopup(target, source, ...args) {
  const session = bidiSession(target);
  const context = contextId(target);
  const { result: host } = await session.send("script.callFunction", {
    functionDeclaration: "() => document.querySelector('hachidori-host')", awaitPromise: false, target: { context },
    serializationOptions: { maxDomDepth: 1, includeShadowTree: "all" } });
  const shadow = host.result?.value?.shadowRoot?.sharedId;
  if (!shadow) return null;
  const { result } = await session.send("script.callFunction", {
    functionDeclaration: `async (root, args) => JSON.stringify(await (${source})(root, ...JSON.parse(args)))`,
    awaitPromise: true, target: { context },
    arguments: [{ sharedId: shadow }, { type: "string", value: JSON.stringify(args) }] });
  if (result.type === "exception") throw new Error(result.exceptionDetails?.text ?? "popup script failed");
  const value = result.result?.value;
  return value === undefined ? null : JSON.parse(value);
}

// Clicks the `index`th visible match of `selector` in the popup at `depth`
// with the real mouse, as a reader would.
async function clickInPopup(target, selector, { index = 0, depth = 0 } = {}) {
  const point = await inPopup(target, `(root, selector, index, depth) => {
    const popup = [...root.querySelectorAll(".gsm-hoshidicts-popup")].find(node => node.dataset.hoshidictsDepth === String(depth));
    const element = popup && [...popup.querySelectorAll(selector)].filter(node => node.getClientRects().length > 0)[index];
    if (!element) return null;
    element.scrollIntoView({ block: "nearest" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }`, selector, index, depth);
  if (!point) return false;
  await target.mouse.click(point.x, point.y);
  return true;
}

// The visible popup at `depth`: its text without ruby readings, its structure
// and its frequency and pitch tags.
function readPopup(target, depth = 0) {
  return inPopup(target, `(root, depth) => {
    const popup = [...root.querySelectorAll(".gsm-hoshidicts-popup")].find(node => node.dataset.hoshidictsDepth === String(depth));
    if (!popup || popup.hidden) return null;
    const flat = node => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const stripped = popup.cloneNode(true);
    for (const node of stripped.querySelectorAll("rt, rp")) node.remove();
    // The headword without its furigana or the reading its pitch is drawn on.
    const headword = popup.querySelector(".gsm-hoshidicts-expression")?.cloneNode(true);
    for (const node of headword?.querySelectorAll("rt, rp, .gsm-hoshidicts-pitch-reading") ?? []) node.remove();
    const view = popup.ownerDocument.defaultView;
    return {
      text: flat(popup),
      plain: flat(stripped),
      headword: flat(headword),
      reading: [...popup.querySelectorAll(".gsm-hoshidicts-expression rt")].map(flat).join(""),
      lists: [...popup.querySelectorAll("ul")].map(list => [...list.children].map(item => flat(item))),
      tables: [...popup.querySelectorAll("table")].map(table => [...table.rows].map(row => [...row.cells].map(flat))),
      bold: [...popup.querySelectorAll("*")].filter(node => Number.parseInt(view.getComputedStyle(node).fontWeight, 10) >= 600)
        .map(node => node.tagName.toLowerCase() + ":" + flat(node)),
      images: [...popup.querySelectorAll("img")].map(image => image.getAttribute("src") ?? ""),
      frequencies: [...popup.querySelectorAll(".gsm-hoshidicts-tag-frequency:not([hidden])")].map(flat),
      pitches: [...popup.querySelectorAll("li.pronunciation")].map(flat),
      entries: popup.querySelectorAll(".gsm-hoshidicts-entry, .gsm-hoshidicts-result").length,
      currentEntry: [...popup.querySelectorAll("[data-current-entry='true'], .is-current-entry")].length,
      theme: popup.closest("[data-hoshidicts-theme]")?.dataset.hoshidictsTheme ?? root.host?.dataset?.hoshidictsTheme ?? null,
      blurred: popup.querySelector(".gsm-hoshidicts-definitions[data-definition-blur='blurred'], [data-definition-blur='blurred']") !== null,
      width: popup.getBoundingClientRect().width,
    };
  }`, depth);
}

// The centre of the `index`th character of the element's text, in page pixels.
async function characterPoint(target, selector, index = 0) {
  return target.evaluate((elementSelector, offset) => {
    const element = document.querySelector(elementSelector);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (remaining < node.data.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, remaining + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      remaining -= node.data.length;
    }
    throw new Error(`no character ${offset} in ${elementSelector}`);
  }, selector, index);
}

// Holds the activation key over a word until its popup shows. The reader
// builds its host on the first lookup, so the pointer steps off and back on.
async function hoverForPopup(target, selector, { index = 0, key = "Shift", depth = 0, timeout = 15_000 } = {}) {
  if (depth === 0) await dismissPopup(target);
  const point = await characterPoint(target, selector, index);
  if (key) await target.keyboard.down(key);
  try {
    const deadline = Date.now() + timeout;
    for (let attempt = 0; Date.now() < deadline; attempt += 1) {
      await target.mouse.move(point.x + (attempt % 2), point.y);
      const shown = await readPopup(target, depth).catch(() => null);
      if (shown) return shown;
      await sleep(150);
    }
    return null;
  } finally {
    if (key) await target.keyboard.up(key);
  }
}

// Escape closes the deepest popup first, so it is pressed until none is left.
async function dismissPopup(target) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await readPopup(target)) === null) return true;
    await target.keyboard.press("Escape");
    await sleep(200);
  }
  return (await readPopup(target)) === null;
}

const highlightSize = target => target.evaluate(name => CSS.highlights.get(name)?.size ?? 0, HIGHLIGHT_NAME);

// Values cross between Node and Firefox's pages as JSON text. Puppeteer reads
// an object WebDriver BiDi returns without its repeated references (the second
// use of one array becomes undefined), and stored options repeat some.
async function evaluateJson(target, fn, ...args) {
  return JSON.parse(await target.evaluate(fn, ...args) ?? "null");
}

// Settings and the other extension pages talk to the worker and engine with
// ordinary runtime messages.
function sendRuntime(target, message) {
  return evaluateJson(target, async json => JSON.stringify(await chrome.runtime.sendMessage(JSON.parse(json))),
    JSON.stringify(message));
}

async function engineStatus(target = page) {
  return sendRuntime(target, { target: "hoshidicts-offscreen", type: "hd_status", requestId: `status-${Date.now()}` });
}

async function readStorage(target, keys) {
  return evaluateJson(target, async json => JSON.stringify(await chrome.storage.local.get(JSON.parse(json))), JSON.stringify(keys));
}

async function writeOptions(target, patch) {
  return target.evaluate(async json => {
    const value = JSON.parse(json);
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: value });
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  }, JSON.stringify(patch));
}

// The files of the engine's IndexedDB-backed filesystem.
async function listIdbfsPaths(target) {
  return target.evaluate(async () => {
    if (!(await indexedDB.databases()).some(database => database.name === "/dicts")) return [];
    const db = await new Promise((resolveOpen, rejectOpen) => {
      const request = indexedDB.open("/dicts");
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
    });
    try {
      const keys = await new Promise((resolveKeys, rejectKeys) => {
        const request = db.transaction("FILE_DATA").objectStore("FILE_DATA").getAllKeys();
        request.onsuccess = () => resolveKeys(request.result);
        request.onerror = () => rejectKeys(request.error);
      });
      return keys.map(String).sort();
    } finally {
      db.close();
    }
  });
}

async function showSettingsSection(target, id) {
  await target.evaluate(section => {
    const picker = document.getElementById("settings-section");
    if (picker.checkVisibility()) {
      picker.value = section;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      document.querySelector(`.settings-nav a[href="#${section}"], .section-tabs a[href="#${section}"]`).click();
    }
  }, id);
  return waitFor(() => target.evaluate(section => document.getElementById(section)?.hidden === false, id));
}

// Imports archives through Settings → Add and returns the final import line.
async function importArchives(target, files) {
  await showSettingsSection(target, "add-dictionaries");
  await setInputFiles(target, "#import-file", files);
  const total = files.length;
  const settled = await waitFor(() => target.evaluate(count => {
    const text = (document.getElementById("import-state")?.textContent ?? "").trim();
    return text.startsWith(`Finished ${count} of ${count} archive`) ? text : false;
  }, total), { timeout: 180_000, interval: 250 });
  return settled;
}

async function dictionaryState(target = page) {
  return (await readStorage(target, ["dictionaryState"])).dictionaryState;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function startServer() {
  return new Promise(resolveServer => {
    const created = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url, "http://127.0.0.1");
        if (request.method === "OPTIONS") {
          response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" });
          response.end();
          return;
        }
        if (url.pathname === ANKI_REFUSED_PATH) {
          anki.refused += 1;
          request.socket.destroy();
          return;
        }
        if (url.pathname === ANKI_PATH && request.method === "POST") {
          const body = JSON.parse(await readBody(request));
          anki.requests.push(body);
          const reply = anki.handle ? await anki.handle(body) : { result: null, error: "no fake AnkiConnect handler" };
          response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
          response.end(JSON.stringify(reply));
          return;
        }
        if (servedFiles.has(url.pathname)) {
          const file = servedFiles.get(url.pathname);
          response.writeHead(200, { "content-type": "application/zip", "content-length": statSync(file).size,
            "access-control-allow-origin": "*" });
          createReadStream(file).pipe(response);
          return;
        }
        if (servedAudio.has(url.pathname)) {
          servedAudio.get(url.pathname).requests += 1;
          response.writeHead(200, { "content-type": "audio/wav", "access-control-allow-origin": "*" });
          response.end(servedAudio.get(url.pathname).body);
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (url.pathname === "/frame") response.end(FRAME_HTML);
        else if (url.pathname === "/framed") response.end(FRAME_PAGE_HTML);
        else response.end(PAGE_HTML);
      })().catch(error => {
        diagnostics.push(`[server] ${error?.stack ?? error}`);
        response.writeHead(500);
        response.end();
      });
    });
    created.listen(0, "127.0.0.1", () => resolveServer(created));
  });
}

// A self-signed certificate for UPDATE_HOST, made with openssl for this run.
function startUpdateServer() {
  const directory = mkdtempSync(resolve(tmpdir(), "hachidori-firefox-tls-"));
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", resolve(directory, "key.pem"), "-out", resolve(directory, "cert.pem"),
    "-subj", `/CN=${UPDATE_HOST}`, "-addext", `subjectAltName=DNS:${UPDATE_HOST}`], { encoding: "utf8" });
  if (made.status !== 0) fatal(`openssl could not make a test certificate:\n${made.stderr}`);
  return new Promise(resolveServer => {
    const created = createHttpsServer({ key: readFileSync(resolve(directory, "key.pem")),
      cert: readFileSync(resolve(directory, "cert.pem")) }, (request, response) => {
      const route = updateRoutes.get(new URL(request.url, "https://localhost").pathname);
      if (!route) {
        response.writeHead(404);
        response.end();
        return;
      }
      route.requests = (route.requests ?? 0) + 1;
      response.writeHead(route.status ?? 200, { "content-type": route.contentType, "access-control-allow-origin": "*" });
      response.end(route.body);
    });
    created.listen(0, "127.0.0.1", () => resolveServer(created));
  });
}

function downloadsDirectory() {
  return downloads;
}

// Every file Firefox has saved into this profile's download directory.
function downloadedFiles() {
  return existsSync(downloads) ? readdirSync(downloads).filter(name => !name.endsWith(".part")).sort() : [];
}

// Puppeteer does not follow Firefox's navigations of extension pages, so the
// top-level browsing contexts are read from WebDriver BiDi.
async function tabUrls() {
  const { result } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
  return result.contexts.map(context => context.url);
}

// Launches Firefox on this run's profile with Hachidori installed and
// Settings open in a tab, and returns the add-on ID Firefox installed.
async function startSession() {
  if (!FIREFOX || !existsSync(FIREFOX)) fatal("no Firefox found (run node test/run.mjs install-firefox, or set HACHIDORI_FIREFOX)");
  if (!PUPPETEER || !existsSync(PUPPETEER)) fatal(`no puppeteer-core at ${PUPPETEER} (set HACHIDORI_PUPPETEER)`);
  if (!existsSync(resolve(EXTENSION, "manifest.json"))) {
    const built = spawnSync("python3", [resolve(HERE, "../scripts/build-firefox.py"), "--output-dir", EXTENSION], { encoding: "utf8" });
    if (built.status !== 0) fatal(`build-firefox.py failed:\n${built.stdout}\n${built.stderr}`);
  }
  if (!existsSync(FIXTURE)) {
    const made = spawnSync(process.execPath, [resolve(HERE, "make-fixture.mjs")], { encoding: "utf8" });
    if (made.status !== 0) fatal(`make-fixture.mjs failed:\n${made.stdout}\n${made.stderr}`);
  }
  if (!HIGHLIGHT_NAME) fatal("could not read HIGHLIGHT_NAME out of extension/content.js");
  const module = await import(pathToFileURL(PUPPETEER).href);
  launchApi = module.default?.launch ? module.default : module;
  server = await startServer();
  serverUrl = `http://127.0.0.1:${server.address().port}`;
  updateServer = await startUpdateServer();
  updateOrigin = `https://${UPDATE_HOST}:${updateServer.address().port}`;
  console.log(`profile: ${PROFILE}`);
  ({ browser, session: bidi, downloads } = await launchFirefox(PROFILE));
  installedId = await installHachidori();
  page = await openExtensionPage("settings.html");
  return installedId;
}

after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
  updateServer?.close();
  report(false);
});

function setBrowser(next) {
  browser = next;
}

function setPage(next) {
  page = next;
}

function setDownloads(next) {
  downloads = next;
}

function setBidi(next) {
  bidi = next;
}

export {
  activate, ANKI_PATH, ANKI_REFUSED_PATH, anki, bidiSession, browser, characterPoint, clickInPopup, contextId,
  dictionaryState, dismissPopup, downloadedFiles, downloadsDirectory, engineStatus, evaluateJson, EXTENSION,
  extensionUrl, findPage, FIXTURE, FIXTURE_ID, GECKO_ID, HERE, highlightSize, hoverForPopup, importArchives, inPopup,
  installHachidori, launchFirefox, listIdbfsPaths, makeAudioWav, navigate, openExtensionPage, openPage, ORIGIN, page,
  PROFILE, readPopup, readStorage, RECOMMENDED, reloadPage, routes, sendRuntime, servedAudio, servedFiles, serverUrl,
  setBidi, setBrowser, setDownloads, setInputFiles, setPage, showSettingsSection, sleep, startSession, tabUrls,
  updateOrigin, updateRoutes, UUID, waitFor, writeOptions
};
