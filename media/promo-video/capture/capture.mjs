// Record the promo video's scenes from the real extension in a disposable
// headless Chrome profile: real dictionaries imported through Settings, real
// mouse and keyboard input on a local Japanese page, and a fake AnkiConnect
// standing in for Anki. Writes the JPEG screenshots to ../video/assets/captures
// and what was recorded with them (pointer, element boxes, import results, the
// Anki note) to ../video/captures.js for the HyperFrames composition.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { answerAnkiConnect } from "../../../test/anki-connect-fake.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const extension = resolve(root, "extension");
const shots = resolve(here, "../video/assets/captures");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const chromeBuild = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8")).config.chrome;
const chromePath = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${chromeBuild}/chrome-linux64/chrome`);
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 2 };

// The real Yomitan dictionaries the video imports, in this order. They are not
// part of the repository: put them in one directory (../README.md says where
// each comes from) and set PROMO_DICTIONARIES to it.
const DICTIONARY_FILES = ["jitendex-yomitan.zip", "bees-ultimate-kanji-dictionary.zip",
  "bees-ultimate-grammar-dictionary.zip", "JPDB_v2.2_Frequency_Kana_2024-10-13.zip", "kanjium_pitch_accents.zip"];
if (!process.env.PROMO_DICTIONARIES) throw new Error(`Set PROMO_DICTIONARIES to a directory holding ${DICTIONARY_FILES.join(", ")}.`);
const dictionaries = DICTIONARY_FILES.map(file => resolve(process.env.PROMO_DICTIONARIES, file));
for (const path of dictionaries) {
  if (!existsSync(path)) throw new Error(`Missing dictionary ${path}`);
}
if (!existsSync(chromePath)) throw new Error(`Missing Chrome ${chromePath}; run npm --prefix test/tooling run install:chrome.`);

const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(read, predicate, description, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)?.slice(0, 400)}`);
    await sleep(100);
  }
}

// ---------- the local page and a fake AnkiConnect ----------
const site = createServer((request, response) => {
  if (new URL(request.url, "http://localhost").pathname !== "/reading.html") { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(readFileSync(resolve(here, "reading.html")));
});
// A Kiku note type with three notes in a Mining deck, so Settings' automatic
// setup detection has something to find. Notes added from the popup are kept.
const KIKU_FIELDS = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "SelectionText",
  "MainDefinition", "DefinitionPicture", "Sentence", "SentenceFurigana", "SentenceAudio", "Picture", "Glossary",
  "Hint", "IsWordAndSentenceCard", "IsClickCard", "IsSentenceCard", "IsAudioCard", "PitchPosition",
  "PitchCategories", "Frequency", "FreqSort", "MiscInfo"];
const anki = { notes: new Map(), unknown: new Set() };
const ankiServer = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*",
    "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  if (request.method !== "POST") { response.writeHead(204, headers).end(); return; }
  const reply = await answerAnkiConnect(JSON.parse(body), (action, params) => {
    const query = String(params.query ?? "");
    switch (action) {
      case "version": return 6;
      case "requestPermission": return { permission: "granted", requireApikey: false, version: 6 };
      case "deckNames": return ["Default", "Mining"];
      case "modelNames": return ["Basic", "Kiku"];
      case "modelNamesAndIds": return { Basic: 1, Kiku: 2 };
      case "modelFieldNames": return params.modelName === "Kiku" ? KIKU_FIELDS : ["Front", "Back"];
      case "findNotes": return query === "mid:2" ? [21, 22, 23] : [];
      case "findCards": return query.startsWith("mid:2") ? [211, 221, 231] : [];
      case "getDecks": return { Mining: [211, 221, 231] };
      case "cardsToNotes": return [21, 22, 23];
      // Added notes read back with the fields they were saved with.
      case "notesInfo": return params.notes.filter(id => anki.notes.has(id)).map(noteId => ({ noteId, modelName: "Kiku",
        tags: [], cards: [noteId + 1], fields: Object.fromEntries(Object.entries(anki.notes.get(noteId).fields)
          .map(([field, value], order) => [field, { value, order }])) }));
      case "cardsInfo": return [];
      case "canAddNotes": return params.notes.map(() => true);
      case "canAddNotesWithErrorDetail": return params.notes.map(() => ({ canAdd: true, error: null }));
      case "getMediaFilesNames": return [];
      case "storeMediaFile": return params.filename;
      case "deleteMediaFile": return null;
      case "addNote": {
        const noteId = 1700000000000 + anki.notes.size * 10;
        anki.notes.set(noteId, params.note);
        return noteId;
      }
      case "guiBrowse": return [...anki.notes.keys()].slice(-1);
      default: anki.unknown.add(action); return null;
    }
  });
  response.writeHead(200, headers);
  response.end(JSON.stringify(reply));
});

// ---------- capture bookkeeping ----------
const manifest = { chrome: null, viewport: VIEWPORT, dictionaries: [], importSummary: "", imports: [], shots: {}, anki: {} };
let pointer = { x: 900, y: 650 };
async function moveMouse(page, x, y) {
  await page.mouse.move(x, y);
  pointer = { x: Math.round(x), y: Math.round(y) };
}
async function popupRects(page) {
  return page.evaluate(() => [...(document.querySelector("hachidori-host")?.shadowRoot
    ?.querySelectorAll(".gsm-hoshidicts-popup") ?? [])]
    .filter(node => !node.hidden && node.getBoundingClientRect().width > 0)
    .map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; }));
}
// Viewport boxes of the elements the video points at. A "popup:" selector is
// matched inside the visible popup; the first rendered match wins.
async function markRects(page, marks) {
  const rects = await page.evaluate(marks => {
    const popup = [...(document.querySelector("hachidori-host")?.shadowRoot?.querySelectorAll(".gsm-hoshidicts-popup") ?? [])]
      .find(node => !node.hidden && node.getBoundingClientRect().width > 0);
    const found = {};
    for (const [name, selector] of Object.entries(marks)) {
      const inPopup = selector.startsWith("popup:");
      const node = [...((inPopup ? popup : document)?.querySelectorAll(inPopup ? selector.slice(6) : selector) ?? [])]
        .find(candidate => candidate.getBoundingClientRect().width > 0);
      if (!node) continue;
      const box = node.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(node);
      const ink = range.getBoundingClientRect();
      found[name] = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
        // Where its text is drawn, which can be narrower than the box.
        inner: ink.width > 0 ? { x: Math.round(ink.x), y: Math.round(ink.y), width: Math.round(ink.width), height: Math.round(ink.height) } : null,
        text: (node.innerText ?? node.textContent).replace(/\s+/gu, " ").trim().slice(0, 160) };
    }
    return found;
  }, marks);
  const missing = Object.keys(marks).filter(name => !rects[name]);
  if (missing.length) throw new Error(`No element for ${missing.map(name => `${name} (${marks[name]})`).join(", ")}`);
  return rects;
}
async function shoot(page, name, { marks = {}, ...extra } = {}) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: resolve(shots, `${name}.jpg`), type: "jpeg", quality: 90 });
  manifest.shots[name] = { file: `${name}.jpg`, pointer: { ...pointer }, popups: await popupRects(page).catch(() => []),
    marks: await markRects(page, marks), ...extra };
  console.log(`shot ${name}`);
}
// The note the popup sent to AnkiConnect, as plain text per non-empty field.
function noteSummary(note) {
  if (!note) return null;
  const fields = {};
  for (const [field, value] of Object.entries(note.fields)) {
    const text = value.replace(/<style[\s\S]*?<\/style>/gu, "").replace(/<rt\b[^>]*>[^<]*<\/rt>/gu, "")
      .replace(/<\/?(?:br|div|li|ol|ul|p|tr|td|th)\b[^>]*>/gu, " ").replace(/<[^>]+>/gu, "")
      .replace(/\s+/gu, " ").trim();
    if (text) fields[field] = text.length > 140 ? `${text.slice(0, 139)}…` : text;
    else if (/<img\b/u.test(value)) fields[field] = "[image]";
  }
  return { deckName: note.deckName, modelName: note.modelName, tags: note.tags, fields };
}
// The popup fills in over several passes (definitions, media, metadata):
// wait until its shadow tree has been quiet for a moment.
async function settled(page, quietMs = 500) {
  await page.evaluate(quiet => new Promise(done => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    if (!root) { setTimeout(done, quiet); return; }
    let timer = setTimeout(finish, quiet);
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, quiet); });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    const cap = setTimeout(finish, 6000);
    function finish() { observer.disconnect(); clearTimeout(cap); done(); }
  }), quietMs);
  await page.evaluate(() => Promise.all([...(document.querySelector("hachidori-host")?.shadowRoot?.querySelectorAll("img") ?? [])]
    .map(image => image.decode().catch(() => {}))));
}
async function glyph(page, selector, index = 0, fraction = 0.45) {
  return page.$eval(selector, (node, { index, fraction }) => {
    // Text-control values have no DOM text nodes: measure the glyph through a mirror.
    if (node instanceof HTMLTextAreaElement) {
      const style = getComputedStyle(node);
      const mirror = document.createElement("div");
      for (const property of ["font", "letterSpacing", "padding", "border", "boxSizing", "width", "lineHeight", "whiteSpace", "wordBreak"]) {
        mirror.style[property] = style[property];
      }
      mirror.style.position = "absolute";
      mirror.style.visibility = "hidden";
      mirror.style.whiteSpace = "pre-wrap";
      const box = node.getBoundingClientRect();
      mirror.style.left = `${box.left + scrollX}px`;
      mirror.style.top = `${box.top + scrollY}px`;
      mirror.textContent = node.value;
      document.body.append(mirror);
      const range = document.createRange();
      range.setStart(mirror.firstChild, index);
      range.setEnd(mirror.firstChild, index + 1);
      const rect = range.getBoundingClientRect();
      mirror.remove();
      return { x: rect.left + rect.width * fraction, y: rect.top + rect.height / 2, left: rect.left, right: rect.right };
    }
    const range = document.createRange();
    range.setStart(node.firstChild, index);
    range.setEnd(node.firstChild, index + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width * fraction, y: rect.top + rect.height / 2, left: rect.left, right: rect.right };
  }, { index, fraction });
}
async function scrollTo(page, selector, top) {
  await page.$eval(selector, (node, top) => window.scrollTo(0, Math.max(0, node.getBoundingClientRect().top + scrollY - top)), top);
  await sleep(200);
}
// Hover a glyph with a single real mouse move, re-firing (off and back on)
// until the popup shows the expected text, as the E2E harness does.
async function hover(page, selector, expected, { index = 0, rest = null } = {}) {
  const point = await glyph(page, selector, index);
  for (let attempt = 0; ; attempt++) {
    await moveMouse(page, rest?.x ?? 20, rest?.y ?? point.y);
    await sleep(attempt ? 250 : 120);
    await moveMouse(page, point.x, point.y + (attempt % 2));
    try {
      await page.waitForFunction(expected => {
        const popup = [...(document.querySelector("hachidori-host")?.shadowRoot?.querySelectorAll(".gsm-hoshidicts-popup") ?? [])]
          .find(node => !node.hidden && node.getBoundingClientRect().width > 0);
        if (!popup) return false;
        if (expected.text) return popup.innerText.includes(expected.text);
        // The first headword, with its furigana removed.
        const head = popup.querySelector(".gsm-hoshidicts-expression");
        if (!head) return false;
        const copy = head.cloneNode(true);
        copy.querySelectorAll("rt, rp").forEach(node => node.remove());
        return copy.textContent.replace(/\s+/gu, "") === expected.headword;
      }, { timeout: 5000 }, typeof expected === "string" ? { headword: expected } : expected);
      break;
    } catch (error) {
      if (attempt >= 5) throw new Error(`No popup with ${JSON.stringify(expected)} for ${selector}`, { cause: error });
    }
  }
  await settled(page);
  return point;
}
async function hide(page) {
  await moveMouse(page, 20, 700);
  await page.keyboard.press("Escape");
  await sleep(400);
}
// Click an element inside the popup's shadow root with the real mouse.
async function clickInPopup(page, selector) {
  const box = await page.evaluate(selector => {
    const node = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);
  if (!box) throw new Error(`No ${selector} in the popup`);
  await moveMouse(page, box.x, box.y);
  await sleep(150);
  await page.mouse.click(box.x, box.y);
}

// ---------- main ----------
rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-promo-"));
let browser;
const blocked = [];
try {
  await new Promise(done => site.listen(0, "127.0.0.1", done));
  await new Promise(done => ankiServer.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const ankiUrl = `http://127.0.0.1:${ankiServer.address().port}`;
  const local = url => url.startsWith(`${origin}/`) || url.startsWith(`${ankiUrl}/`) || url === ankiUrl;

  browser = await puppeteer.launch({
    executablePath: chromePath, headless: true, enableExtensions: true, userDataDir: profile, defaultViewport: VIEWPORT,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox",
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output", "--hide-scrollbars", "--lang=en-GB"],
  });
  manifest.chrome = await browser.version();
  // Nothing leaves the machine: requests other than the local page and the
  // fake AnkiConnect fail on every page, worker and offscreen target.
  const isolated = new Map();
  const isolate = target => {
    if (!["page", "service_worker", "other"].includes(target.type())) return Promise.resolve();
    if (!isolated.has(target)) isolated.set(target, (async () => {
      const cdp = await target.createCDPSession();
      cdp.on("Fetch.requestPaused", async event => {
        const url = event.request.url;
        if (local(url)) await cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
        else {
          blocked.push(url);
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
        }
      });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] });
    })().catch(() => {}));
    return isolated.get(target);
  };
  browser.on("targetcreated", target => { void isolate(target); });
  browser.on("targetchanged", target => { void isolate(target); });
  await Promise.all(browser.targets().map(isolate));

  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const extOrigin = `chrome-extension://${new URL(worker.url()).host}`;

  // A fresh install opens startup.html; choose Set up manually so nothing downloads.
  const startupTarget = await browser.waitForTarget(target => target.type() === "page" && target.url().endsWith("/startup.html"));
  const startup = await startupTarget.page();
  await until(() => startup.evaluate(() => !!document.getElementById("setup-manual")), Boolean, "startup welcome");
  await startup.evaluate(() => document.getElementById("setup-manual").click());
  await until(() => startup.evaluate(() => !!document.getElementById("setup-finish")), Boolean, "manual setup");
  await startup.evaluate(() => document.getElementById("setup-finish").click());
  await sleep(600);
  if (!startup.isClosed()) await startup.close().catch(() => {});

  const settings = await browser.newPage();
  settings.setDefaultTimeout(120_000);
  settings.on("pageerror", error => console.log("settings pageerror:", error.message));
  await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  const writeOptions = patch => settings.evaluate(async next => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      requestId: `promo-${Date.now()}`, baseRevision: options?.revision ?? 0, options: next });
    if (!reply?.ok) throw new Error(reply?.error || "options write failed");
  }, patch);
  await settings.goto(`${extOrigin}/settings.html#add-dictionaries`);
  await until(() => settings.evaluate(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status?.ok && status.ready && !status.loading;
  }), Boolean, "engine ready");
  // Hover lookups (Reading → Activation: No key) with the Hachidori palette;
  // MDX import and the Theme Store are Settings → Advanced → Experimental features.
  const experimental = await settings.evaluate(() => ({
    ...Object.fromEntries(HDReaderOptions.EXPERIMENTAL_FEATURES.map(feature => [feature.id, false])),
    mdxImport: true, themeStore: true }));
  await writeOptions({ popupTheme: "default", lookupMode: "hover", experimental });
  await settings.reload();
  await settings.waitForSelector("#import-file");
  await sleep(800);

  // ---------- scene: import ----------
  for (const path of dictionaries) {
    manifest.dictionaries.push({ file: basename(path),
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  }
  await shoot(settings, "import-0-empty");
  await (await settings.$("#import-file")).uploadFile(...dictionaries);
  await until(() => settings.$eval("#import-state", node => node.textContent), text => /Importing/u.test(text), "import start");
  await sleep(300);
  await shoot(settings, "import-1-running", { marks: { state: "#import-state" } });
  manifest.importSummary = await until(() => settings.$eval("#import-state", node => node.textContent),
    text => /Finished/u.test(text), "import finished", 600_000);
  await sleep(600);
  await settings.evaluate(() => {
    const zone = document.getElementById("import-drop-zone");
    window.scrollTo(0, zone.getBoundingClientRect().top + scrollY - 24);
  });
  await sleep(300);
  manifest.imports = await settings.$$eval("#import-progress .setup-dictionary", rows => rows.map(row => ({
    file: row.querySelector(".setup-dictionary-name")?.textContent.trim() ?? "",
    status: row.querySelector(".setup-dictionary-status")?.textContent.trim() ?? "" })));
  const titles = manifest.imports.map(row => /^Imported (.+?) in [\d.]+ seconds?:/u.exec(row.status)?.[1]);
  if (titles.length !== dictionaries.length || titles.some(title => !title)) throw new Error(`Import failed: ${JSON.stringify(manifest.imports)}`);
  await shoot(settings, "import-2-done", { marks: { state: "#import-state", first: "#import-progress .setup-dictionary", firstStatus: "#import-progress .setup-dictionary-status" } });
  console.log(manifest.importSummary);
  // What first-run setup selects for these dictionaries: Jitendex for the
  // compact summary and Bee's Ultimate Kanji Dictionary for clicked kanji.
  await writeOptions({ compactDefinitionSummaryDictionary: titles[0], kanjiClickDictionary: { title: titles[1], kind: "term" } });

  // ---------- scene: hover lookups ----------
  const reading = await browser.newPage();
  reading.on("pageerror", error => console.log("reading pageerror:", error.message));
  reading.on("console", message => { if (["error", "warn"].includes(message.type())) console.log(`reading ${message.type()}:`, message.text()); });
  await reading.goto(`${origin}/reading.html`);
  await reading.evaluate(() => document.fonts.ready);
  await moveMouse(reading, 1180, 660);
  await sleep(300);
  await shoot(reading, "lookup-0-page");
  await hover(reading, "#w-eat", "食べる");
  await shoot(reading, "lookup-1-popup", { marks: { word: "#w-eat", headword: "popup:.gsm-hoshidicts-expression", deinflection: "popup:.gsm-hoshidicts-deinflection",
    stats: "popup:.gsm-hoshidicts-lookup-stats", pitch: "popup:.gsm-hoshidicts-pitch-metadata", kanji: "popup:.gsm-hoshidicts-kanji-link" } });
  // Click the first kanji of the headword. Bee's Ultimate Kanji Dictionary is a
  // term dictionary, so the kanji opens as a term result with a Back button.
  await clickInPopup(reading, ".gsm-hoshidicts-kanji-link");
  await reading.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot
    ?.querySelector(".gsm-hoshidicts-kanji-back"), { timeout: 10_000 });
  await settled(reading);
  await shoot(reading, "lookup-3-kanji", { marks: { back: "popup:.gsm-hoshidicts-kanji-back", entry: "popup:.gsm-hoshidicts-entry" } });
  await hide(reading);

  // ---------- scene: text boxes ----------
  await scrollTo(reading, "#comment", 140);
  await moveMouse(reading, 1180, 660);
  await shoot(reading, "input-0-page", { marks: { textarea: "#comment" } });
  await hover(reading, "#comment", "楽しみ", { index: 7 });
  await shoot(reading, "input-1-popup", { marks: { textarea: "#comment", headword: "popup:.gsm-hoshidicts-expression" } });
  await hide(reading);
  await reading.evaluate(() => window.scrollTo(0, 0));

  // ---------- scene: Anki ----------
  const defaults = await settings.evaluate(() => HDReaderOptions.DEFAULT_OPTIONS.anki);
  await writeOptions({ anki: { ...defaults, url: ankiUrl } });
  await settings.bringToFront();
  await settings.goto(`${extOrigin}/settings.html#anki`);
  await settings.waitForSelector("#anki-find-setup", { visible: true });
  await sleep(800);
  await settings.click("#anki-find-setup");
  await until(() => settings.evaluate(async () => (await chrome.storage.local.get("options")).options?.anki?.model),
    model => model === "Kiku", "detected Kiku setup", 30_000);
  await sleep(1200);
  manifest.anki.detected = await settings.evaluate(() => ({
    connection: document.getElementById("anki-status")?.textContent ?? "",
    deck: document.getElementById("opt-anki-deck")?.value, model: document.getElementById("opt-anki-model")?.value }));
  await settings.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await shoot(settings, "anki-0-settings", { marks: { status: "#anki-status", find: "#anki-find-setup" } });
  await settings.evaluate(() => document.getElementById("anki-field-mapping")?.scrollIntoView({ block: "start" }));
  await sleep(400);
  await shoot(settings, "anki-1-mapping", { marks: { mapping: "#anki-field-mapping" } });

  await reading.bringToFront();
  await scrollTo(reading, "#line-promise", 150);
  await hover(reading, "#w-promise", "約束");
  await reading.waitForFunction(() => {
    const button = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-mine-button");
    return button && !button.hidden && button.dataset.state === "ready";
  }, { timeout: 20_000 });
  await settled(reading);
  await shoot(reading, "anki-2-ready", { marks: { mine: "popup:.gsm-hoshidicts-mine-button" } });
  await clickInPopup(reading, ".gsm-hoshidicts-mine-button");
  await reading.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot
    ?.querySelector(".gsm-hoshidicts-mine-button")?.dataset.state === "success", { timeout: 30_000 });
  await settled(reading);
  await shoot(reading, "anki-4-added", { marks: { mine: "popup:.gsm-hoshidicts-mine-button", feedback: "popup:.gsm-hoshidicts-mining-feedback" } });
  manifest.anki.note = noteSummary([...anki.notes.values()].at(-1));
  await hide(reading);

  // ---------- scene: personal dictionary ----------
  await reading.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  const first = await glyph(reading, "#w-name", 0, 0.08);
  const last = await glyph(reading, "#w-name", 1, 0.92);
  await moveMouse(reading, first.x, first.y);
  await reading.mouse.down();
  for (let step = 1; step <= 8; step++) await moveMouse(reading, first.x + (last.x - first.x) * step / 8, first.y);
  await reading.mouse.up();
  await reading.waitForFunction(() => {
    const popup = [...(document.querySelector("hachidori-host")?.shadowRoot?.querySelectorAll(".gsm-hoshidicts-popup") ?? [])]
      .find(node => !node.hidden && node.getBoundingClientRect().width > 0);
    return !!popup?.querySelector(".gsm-hoshidicts-note-button");
  }, { timeout: 15_000 });
  await settled(reading);
  await shoot(reading, "custom-0-selected", { marks: { word: "#w-name", notice: "popup:.gsm-hoshidicts-lookup-notice", pencil: "popup:.gsm-hoshidicts-note-button" } });
  await clickInPopup(reading, ".gsm-hoshidicts-note-button");
  await reading.waitForFunction(() => {
    const form = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-note-form");
    return form && !form.hidden;
  });
  await settled(reading, 300);
  await shoot(reading, "custom-1-form", { marks: { form: "popup:.gsm-hoshidicts-note-form:not([hidden])" } });
  const focusField = name => reading.evaluate(name => {
    const root = document.querySelector("hachidori-host").shadowRoot;
    [...root.querySelectorAll(`.gsm-hoshidicts-note-form:not([hidden]) .gsm-hoshidicts-note-${name}`)].at(-1).focus();
  }, name);
  await focusField("reading");
  await reading.keyboard.type("ちかげ", { delay: 40 });
  await focusField("definition");
  const definition = "Chikage — the narrator's friend (character name)";
  await reading.keyboard.type(definition.slice(0, 22), { delay: 15 });
  await shoot(reading, "custom-2-typing", { marks: { form: "popup:.gsm-hoshidicts-note-form:not([hidden])" } });
  await reading.keyboard.type(definition.slice(22), { delay: 15 });
  await settled(reading, 300);
  await shoot(reading, "custom-3-typed", { marks: { form: "popup:.gsm-hoshidicts-note-form:not([hidden])", save: "popup:.gsm-hoshidicts-note-form:not([hidden]) .gsm-hoshidicts-note-save" } });
  await clickInPopup(reading, ".gsm-hoshidicts-note-form:not([hidden]) .gsm-hoshidicts-note-save");
  await reading.waitForFunction(text => {
    const popup = [...(document.querySelector("hachidori-host")?.shadowRoot?.querySelectorAll(".gsm-hoshidicts-popup") ?? [])]
      .find(node => !node.hidden && node.getBoundingClientRect().width > 0);
    return !!popup && popup.textContent.includes(text) && !popup.querySelector(".gsm-hoshidicts-note-form:not([hidden])");
  }, { timeout: 30_000 }, "narrator's friend");
  await settled(reading);
  await shoot(reading, "custom-4-saved", { marks: { entry: "popup:.gsm-hoshidicts-entry" } });
  await reading.evaluate(() => getSelection().removeAllRanges());
  await hide(reading);

  // ---------- scene: lookup blur ----------
  await writeOptions({ definitionBlurCountEnabled: true, definitionBlurThreshold: 3, definitionBlurReveal: "timed",
    definitionBlurDelayMs: 3000 });
  await scrollTo(reading, "#line-usual", 150);
  let blurred = false;
  for (let visit = 0; visit < 8 && !blurred; visit++) {
    await hover(reading, "#w-usual", "相変わらず");
    blurred = await reading.evaluate(() => [...document.querySelector("hachidori-host").shadowRoot
      .querySelectorAll("[data-definition-blur-state]")].some(node => node.dataset.definitionBlurState === "blurred"));
    if (!blurred) await hide(reading);
  }
  if (!blurred) throw new Error("Definitions never blurred");
  await shoot(reading, "blur-0-blurred", { marks: { stats: "popup:.gsm-hoshidicts-lookup-stats", definitions: "popup:.gsm-hoshidicts-definitions" } });
  await reading.waitForFunction(() => ![...document.querySelector("hachidori-host").shadowRoot
    .querySelectorAll("[data-definition-blur-state]")].some(node => ["blurred", "pending"].includes(node.dataset.definitionBlurState)),
  { timeout: 15_000 });
  await settled(reading);
  await shoot(reading, "blur-1-revealed", { marks: { stats: "popup:.gsm-hoshidicts-lookup-stats", definitions: "popup:.gsm-hoshidicts-definitions" } });
  await hide(reading);
  await writeOptions({ definitionBlurCountEnabled: false });

  // ---------- scene: themes ----------
  await settings.bringToFront();
  await settings.goto(`${extOrigin}/settings.html#design`);
  await settings.waitForSelector(".theme-store-card button", { visible: true });
  await settings.waitForFunction(() => [...document.querySelectorAll(".theme-store-preview")]
    .every(image => image.complete && image.naturalWidth > 0)).catch(() => {});
  await sleep(1500);
  await shoot(settings, "theme-0-store", { marks: { store: "#theme-store", preview: ".design-sample" } });
  await reading.bringToFront();
  await reading.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  // Names as Settings shows them: layouts from the Theme Store index, palettes from Design.
  const layouts = JSON.parse(readFileSync(resolve(extension, "vendor/themes/index.json"), "utf8")).themes;
  const palettes = await settings.evaluate(() => HDReaderOptions.POPUP_THEME_GROUPS.flatMap(group => group.themes));
  manifest.themes = { palettes: palettes.filter(theme => theme.id !== "auto").length, layouts: layouts.map(theme => theme.name) };
  const themeLabel = id => (id === "default" ? null : layouts.find(theme => theme.slug === id)?.name)
    ?? palettes.find(theme => theme.id === id)?.label ?? id;
  for (const theme of ["default", "bee", "jl", "nazeka", "miku", "girlypop", "catppuccin-mocha", "solarized-light", "dracula", "light"]) {
    await writeOptions({ popupTheme: theme });
    await sleep(300);
    await hover(reading, "#w-ajisai", "紫陽花");
    await sleep(300);
    await shoot(reading, `theme-${theme}`, { theme, label: themeLabel(theme) });
    await hide(reading);
  }
  await writeOptions({ popupTheme: "default" });

  manifest.blocked = blocked;
  manifest.ankiUnknown = [...anki.unknown];
  writeFileSync(resolve(here, "../video/captures.js"),
    `// Generated by ../capture/capture.mjs from a real headless Chrome run. Do not edit.\nwindow.HACHIDORI_CAPTURES = ${JSON.stringify(manifest, null, 2)};\n`);
  console.log(`blocked ${blocked.length} external requests; unknown Anki actions: ${[...anki.unknown].join(", ") || "none"}`);
} finally {
  await browser?.close();
  site.close();
  ankiServer.close();
  rmSync(profile, { recursive: true, force: true });
}
