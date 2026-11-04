/*
 * The search page's line history (docs/search-history.md) in a real Chrome.
 * Lines typed, pasted and read by the Clipboard monitor are kept with their
 * source and window, a repeat of the newest once. Up and Down in the box walk
 * them as a shell's do and bring the draft back. In the searched text the
 * arrow keys move Rubi's cursor word by word, looking each word up, and row by
 * row, and on to earlier lines shown between their neighbours' rows; Enter adds
 * the word to a fake AnkiConnect with its line as the sentence. The keys follow
 * Settings → Keybinds and leave other controls alone; with the history off
 * nothing is kept or recalled. A second search page hears each line; Settings
 * shows the count, applies a lowered limit at once and clears the history.
 * The texthooker user script (userscripts/texthooker.js) shows the lines,
 * newest at the bottom, with their counts and times, pauses the Clipboard
 * monitor, edits and deletes lines and looks up a clicked word, through
 * HDSearchHistory alone.
 *
 * This copy of the extension holds clipboardRead from the start, as the
 * Clipboard monitor's suite does (chrome-clipboard-monitor.mjs): headless
 * Chrome cannot answer the permission prompt.
 *
 * test/run.mjs chrome-e2e runs it after the main scenario; on its own:
 *   node test/chrome-search-history.mjs
 * HACHIDORI_SEARCH_SCREENSHOTS=DIR also saves an earlier line's visit in the
 * default, a light and the high-contrast palette and Windows' forced colours.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
import { popupReader } from "./chrome-e2e/popup-reader.mjs";
import { buildFixtureZip } from "./make-fixture.mjs";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const { config } = require("./package.json");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = resolve(ROOT, "test/tmp/search-history-extension");
// Named like chrome-e2e's own profile, so CI's failure upload collects it.
const PROFILE = resolve(tmpdir(), `hachidori-e2e-profile-search-history-${process.pid}`);
const SCREENSHOTS = process.env.HACHIDORI_SEARCH_SCREENSHOTS;
const TEXTHOOKER = readFileSync(resolve(ROOT, "userscripts/texthooker.js"), "utf8");
const GLOSSES = { 漢字: "Chinese character", 読む: "to read", ありがとう: "thank you", 食べる: "to eat" };
const settle = ms => new Promise(done => { setTimeout(done, ms); });

rmSync(EXTENSION, { recursive: true, force: true });
cpSync(resolve(ROOT, "extension"), EXTENSION, { recursive: true });
const manifestPath = resolve(EXTENSION, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
delete manifest.optional_permissions;
manifest.permissions.push("clipboardRead");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// A page in another tab whose button copies its text, as a user would, and a
// fake AnkiConnect that keeps the notes it is sent.
const notes = [];
const server = createServer(async (request, response) => {
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = await answerAnkiConnect(JSON.parse(body), async (action, params) => {
      if (action === "version") return 6;
      if (action === "requestPermission") return { permission: "granted", requireApiKey: false, version: 6 };
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "modelFieldNames") return ["Front", "Back"];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      if (action === "findNotes") return [];
      if (action === "notesInfo") return [];
      if (action === "addNote") {
        notes.push(params.note.fields);
        return notes.length;
      }
      if (action === "getMediaFilesNames") return [];
      if (action === "storeMediaFile") return params.filename;
      throw new Error(`Unexpected Anki action ${action}`);
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><body>
    <p id="text"></p><button id="copy">Copy</button>
    <script>
      document.getElementById("copy").addEventListener("click", () => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById("text"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        window.copied = document.execCommand("copy");
      });
    </script>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

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
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  const frameUrl = `chrome-extension://${extensionId}/search-frame.html`;
  (await worker.worker())?.on("console", message => diagnostics.push(`[sw] ${message.text()}`));
  const watch = (page, name) => {
    page.on("console", message => diagnostics.push(`[${name}] ${message.type()}: ${message.text()}`));
    page.on("pageerror", error => diagnostics.push(`[${name}] pageerror: ${error.message}`));
    page.on("dialog", dialog => { void dialog.accept(); });
    return page;
  };

  const settings = watch(await browser.newPage(), "settings");
  await settings.goto(`chrome-extension://${extensionId}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const imported = await settings.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try {
      return await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: "search-history-fixture", blobUrl, fileName: "hachidori-fixture.zip" });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, buildFixtureZip().toString("base64"));
  assert.equal(imported?.ok === true && imported.report?.success === true, true, JSON.stringify(imported));
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const template = value => ({ value, overwriteMode: "overwrite" });
  await writeOptions({ showLookupCounts: false, anki: { ...await settings.evaluate(() => HDReaderOptions.normaliseOptions({}).anki),
    url: origin, model: "Basic", fieldTemplates: { Front: template("{expression}"), Back: template("{sentence}") } } });

  const web = watch(await browser.newPage(), "web");
  await web.goto(`${origin}/`);
  async function copyInWeb(text) {
    await web.bringToFront();
    await web.$eval("#text", (element, value) => { element.textContent = value; }, text);
    await web.click("#copy");
    assert.equal(await web.evaluate(() => window.copied), true, `the web page copied ${text}`);
  }
  await copyInWeb("ありがとう");

  // A search page, its frame, its docked result, and what its searched text shows.
  async function openSearch(name) {
    const tab = watch(await browser.newPage(), name);
    await tab.setViewport({ width: 960, height: 760 });
    await tab.goto(`chrome-extension://${extensionId}/search.html`, { waitUntil: "domcontentloaded" });
    await tab.waitForFrame(frameUrl, { timeout: 30_000 });
    const frame = tab.frames().find(candidate => candidate.url() === frameUrl);
    // The frame's document may still be loading when the frame is found: a
    // check that threw there would end the wait.
    await frame.waitForFunction(() => document.getElementById("search-submit")?.disabled === false,
      { polling: 100, timeout: 30_000 });
    await tab.waitForFunction(() => document.getElementById("search-clipboard")?.disabled === false,
      { polling: 100, timeout: 30_000 });
    return { tab, frame, popup: await popupReader(tab, 0, frameUrl) };
  }
  const { tab: search, frame, popup } = await openSearch("search");
  const view = () => frame.evaluate(() => {
    const text = id => document.getElementById(id);
    const [cursor] = CSS.highlights.get("hd-search-cursor") ?? [];
    return {
      value: text("search-input").value, focused: document.activeElement?.id || document.activeElement?.localName,
      caret: text("search-input").selectionStart,
      query: text("search-query").hidden ? null : text("search-query").textContent,
      before: text("search-before").hidden ? null : text("search-before").dataset.text,
      after: text("search-after").hidden ? null : text("search-after").dataset.text,
      where: text("search-where").hidden ? null : text("search-where").textContent,
      keys: text("search-keys").textContent,
      cursor: cursor ? { at: cursor.startOffset, text: cursor.toString() } : null,
    };
  });
  const lines = (target = frame) => target.evaluate(() => globalThis.HDSearchHistory.list());
  const until = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const state = await view();
      if (predicate(state)) return state;
      assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(state)}`);
      await settle(25);
    }
  };
  // The docked result shows `word`, from the gloss only it has.
  const shows = word => popup.waitForVisible(15_000, state => state.text.includes(GLOSSES[word]));
  const press = async (key, modifiers = []) => {
    for (const modifier of modifiers) await search.keyboard.down(modifier);
    await search.keyboard.press(key);
    for (const modifier of [...modifiers].reverse()) await search.keyboard.up(modifier);
  };
  async function typeSearch(text) {
    await search.bringToFront();
    await frame.focus("#search-input");
    await frame.$eval("#search-input", (box, value) => { box.value = value; }, text);
    await press("Enter");
  }
  // The search page's history events, as a user script hears them.
  await frame.evaluate(() => {
    globalThis.heard = [];
    for (const type of ["line", "change"]) {
      globalThis.HDSearchHistory.addEventListener(type, event => globalThis.heard.push({ type, detail: event.detail }));
    }
  });

  // Lines are kept from the box, a paste and the Clipboard monitor, a repeat of the newest once.
  await typeSearch("食べたかった");
  assert.ok(await shows("食べる"), "a typed line is searched");
  const typed = await until(state => state.query === "食べたかった" && state.cursor?.text === "食べたかった", "the cursor");
  assert.equal(typed.focused, "search-query", "the searched text takes focus from the box");
  await frame.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "読む");
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.ok(await shows("読む"), "a pasted line is searched");
  await copyInWeb("漢字");
  assert.ok(await shows("漢字"), "a copied line is searched");
  await typeSearch("漢字");
  await until(state => state.query === "漢字" && state.cursor?.text === "漢字", "the repeat");
  const kept = await lines();
  assert.deepEqual(kept.map(({ text, source, page }) => [text, source, page]),
    [["食べたかった", "typed", "tab"], ["読む", "paste", "tab"], ["漢字", "clipboard", "tab"]]);
  assert.ok(kept.every((line, index) => index === 0 || (line.id > kept[index - 1].id && line.at >= kept[index - 1].at)), JSON.stringify(kept));
  assert.deepEqual((await frame.evaluate(() => globalThis.heard)).map(({ type, detail }) => [type, detail.text]),
    [["line", "食べたかった"], ["line", "読む"], ["line", "漢字"]]);
  console.log("PASS: lines typed, pasted and copied are kept with their source and window, a repeat of the newest once");

  // Up and Down in the box walk the lines as a shell's do, and bring the draft back.
  await press("Escape");
  await until(state => state.focused === "search-input", "Escape focuses the box");
  await search.keyboard.type("下書き");
  for (const expected of ["漢字", "読む", "食べたかった"]) {
    await press("ArrowUp");
    await until(state => state.value === expected, `Up recalls ${expected}`);
  }
  await press("ArrowUp");
  await settle(300);
  assert.equal((await view()).value, "食べたかった", "Up on the oldest line stays");
  for (const expected of ["読む", "漢字", "下書き"]) {
    await press("ArrowDown");
    await until(state => state.value === expected, `Down shows ${expected}`);
  }
  await press("ArrowDown");
  await settle(300);
  const drafted = await view();
  assert.equal(drafted.value, "下書き", "Down past the newest line keeps the draft");
  await press("ArrowLeft");
  const caretMoved = await view();
  assert.ok(caretMoved.caret < drafted.caret && caretMoved.cursor === null, `Left moves the box's caret: ${JSON.stringify(caretMoved)}`);
  assert.equal(await popup.state().then(state => state.text.includes(GLOSSES["漢字"])), true, "the walk searched nothing");
  for (const expected of ["漢字", "読む"]) {
    await press("ArrowUp");
    await until(state => state.value === expected, `Up recalls ${expected} again`);
  }
  await press("Enter");
  assert.ok(await shows("読む"), "Enter searches the recalled line");
  await until(state => state.query === "読む", "the recalled line");
  assert.deepEqual((await lines()).map(line => line.text), ["食べたかった", "読む", "漢字", "読む"], "a line again after another is kept");
  console.log("PASS: Up and Down in the box walk the lines back and forward, Down past the newest brings the draft back,"
    + " Left and Right move the caret, and Enter searches the recalled line");

  // Left and Right move the cursor word by word, each word looked up; Left retraces the Rights.
  await typeSearch("漢字読むありがとう");
  assert.ok(await shows("漢字"));
  await until(state => state.cursor?.text === "漢字", "the first word");
  const step = async (key, word, at, modifiers = []) => {
    await press(key, modifiers);
    assert.ok(await shows(word), `${key} looks up ${word}`);
    return until(state => state.cursor?.at === at && state.cursor.text === word, `${key} to ${word}`);
  };
  await step("ArrowRight", "読む", 2);
  await step("ArrowRight", "ありがとう", 4);
  // A fresh press goes round a one-row text's end; Left retraces it.
  await step("ArrowRight", "漢字", 0);
  await step("ArrowLeft", "ありがとう", 4);
  await step("ArrowLeft", "読む", 2);
  await step("ArrowLeft", "漢字", 0);
  // A held Right stops at the text's end.
  await step("ArrowRight", "読む", 2);
  await search.keyboard.down("ArrowRight");
  assert.ok(await shows("ありがとう"));
  await until(state => state.cursor?.text === "ありがとう", "the last word");
  await search.keyboard.down("ArrowRight");
  await search.keyboard.up("ArrowRight");
  await settle(300);
  assert.equal((await view()).cursor?.at, 4, "a held Right does not go round");
  const described = (await view()).keys;
  assert.equal(described, "Left/Right: words · Up/Down: rows and earlier lines · Enter: add to Anki · Escape: back to the box");
  assert.equal(await frame.$eval("#search-query", element => element.getAttribute("aria-describedby")), "search-where search-keys");
  console.log("PASS: Left and Right move the cursor by the word each lookup matched, Left retraces the Rights, a one-row"
    + " text goes round its ends for a fresh press only, and the keys are named beside it");

  // Up and Down go between the rows of a long line, keeping the column, and past its top row to earlier lines.
  const long = "漢字読むありがとう".repeat(6);
  await typeSearch(long);
  await until(state => state.query === long && state.cursor?.text === "漢字", "the long line");
  const rows = await frame.$eval("#search-query", (element) => {
    const node = element.firstChild;
    const range = document.createRange();
    return Array.from(node.data, (_, at) => {
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const { top, left } = range.getClientRects()[0];
      return { top, left };
    });
  });
  const secondRow = rows.findIndex(cell => cell.top > rows[0].top + 10);
  assert.ok(secondRow > 0, "the long line has a second row");
  await press("ArrowDown");
  const down = await until(state => state.cursor?.at >= secondRow, "Down to the second row");
  assert.ok(Math.abs(rows[down.cursor.at].left - rows[0].left) < 25, `Down keeps the column: ${down.cursor.at}`);
  await press("ArrowDown");
  await settle(300);
  assert.equal((await view()).cursor.at, down.cursor.at, "Down on the current line's last row stays");
  await press("ArrowUp");
  await until(state => state.cursor?.at === 0, "Up back to the first row");
  await press("ArrowUp");
  const first = await until(state => state.query === "漢字読むありがとう", "Up past the top row");
  assert.deepEqual([first.before, first.after, first.where, first.cursor?.at], ["読む", long, "Earlier line -1 · ▲ earlier · ▼ later", 0]);
  assert.ok(await shows("漢字"), "an earlier line opens on its first word");
  if (SCREENSHOTS) {
    mkdirSync(SCREENSHOTS, { recursive: true });
    for (const theme of ["default", "girlypop", "high-contrast"]) {
      await writeOptions({ popupTheme: theme });
      await frame.waitForFunction(value => document.documentElement.dataset.hoshidictsTheme === value, { polling: 100, timeout: 10_000 }, theme);
      await search.bringToFront();
      await settle(300);
      await search.screenshot({ path: resolve(SCREENSHOTS, `search-history-visit-${theme}.png`) });
    }
    const cdp = await search.createCDPSession();
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    await settle(300);
    await search.screenshot({ path: resolve(SCREENSHOTS, "search-history-visit-forced-colors.png") });
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  }
  // The neighbours' rows are dimmed, and still legible: 4.5:1 against the page in every palette.
  for (const theme of ["girlypop", "high-contrast", "dracula", "default"]) {
    await writeOptions({ popupTheme: theme });
    await frame.waitForFunction(value => document.documentElement.dataset.hoshidictsTheme === value, { polling: 100, timeout: 10_000 }, theme);
    const contrast = await frame.evaluate(() => {
      const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      const rgb = (color) => {
        canvas.clearRect(0, 0, 1, 1);
        canvas.fillStyle = color;
        canvas.fillRect(0, 0, 1, 1);
        return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const luminance = color => rgb(color).map(value => value / 255)
        .map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const [text, page] = [getComputedStyle(document.getElementById("search-before")).color,
        getComputedStyle(document.body).backgroundColor].map(luminance);
      return (Math.max(text, page) + 0.05) / (Math.min(text, page) + 0.05);
    });
    assert.ok(contrast >= 4.5, `the dimmed rows in ${theme}: ${contrast.toFixed(2)}:1`);
  }
  // Up again goes further back, to the oldest line, and Down comes forward to the current line, its cursor where it was.
  await press("ArrowUp");
  const second = await until(state => state.query === "読む" && state.where?.startsWith("Earlier line -2"), "Up to -2");
  assert.deepEqual([second.before, second.after], ["漢字", "漢字読むありがとう"]);
  for (const depth of [3, 4, 5]) {
    await press("ArrowUp");
    await until(state => state.where?.startsWith(`Earlier line -${depth}`), `Up to -${depth}`);
  }
  const oldest = await view();
  assert.deepEqual([oldest.query, oldest.before, oldest.after, oldest.where], ["食べたかった", null, "読む", "Earlier line -5 · ▼ later"]);
  await press("ArrowUp");
  await settle(300);
  assert.equal((await view()).where, "Earlier line -5 · ▼ later", "Up on the oldest line stays");
  for (const depth of [4, 3, 2, 1]) {
    await press("ArrowDown");
    await until(state => state.where?.startsWith(`Earlier line -${depth}`), `Down to -${depth}`);
  }
  await press("ArrowDown");
  const back = await until(state => state.query === long, "Down past the newest earlier line");
  assert.deepEqual([back.before, back.after, back.where, back.cursor?.at], [null, null, null, 0]);
  console.log("PASS: Up and Down move between a long line's rows keeping the column, and past its top row through the"
    + " earlier lines, each between its neighbours' dimmed rows (4.5:1 or more), back to the current line");

  // Enter adds the word under the cursor to Anki, with the line it is on as the sentence; Escape goes back to the box.
  await press("ArrowUp");
  await until(state => state.query === "漢字読むありがとう" && state.cursor?.text === "漢字", "an earlier line again");
  await popup.waitForVisible(15_000, state => state.text.includes(GLOSSES["漢字"]));
  const anki = await (async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const controls = (await popup.anki())?.controls ?? [];
      if (controls.some(control => !control.hidden && !control.disabled && control.state === "ready")) return controls;
      assert.ok(Date.now() < deadline, `the docked result's Anki button: ${JSON.stringify(controls)}`);
      await settle(100);
    }
  })();
  assert.ok(anki.length > 0);
  await press("Enter");
  const deadline = Date.now() + 15_000;
  while (notes.length === 0) {
    assert.ok(Date.now() < deadline, "Enter adds a note");
    await settle(50);
  }
  // The sentence marks the word, as {sentence} does.
  assert.deepEqual(notes, [{ Front: "漢字", Back: "<b>漢字</b>読むありがとう" }]);
  await press("Escape");
  const escaped = await until(state => state.focused === "search-input", "Escape focuses the box");
  assert.equal(escaped.query, "漢字読むありがとう", "the earlier line stays shown");
  console.log("PASS: Enter adds the word under the cursor to Anki with its earlier line as the sentence, and Escape"
    + " goes back to the box");

  // The keys are Settings → Keybinds': a rebound key moves the cursor, the old one no longer does, and nothing
  // moves it while focus is elsewhere.
  const keybinds = await settings.evaluate(async () => HDReaderOptions.normaliseOptions(
    (await chrome.storage.local.get("options")).options).keybinds);
  await writeOptions({ keybinds: keybinds.map(bind => (bind.action === "searchNextWord"
    ? { ...bind, key: "KeyL", modifiers: ["alt"] } : bind)) });
  await until(state => state.keys.startsWith("Left/Alt + L: words"), "the rebound key is named");
  await frame.focus("#search-query");
  await press("ArrowRight");
  await settle(300);
  assert.equal((await view()).cursor?.at, 0, "the old key no longer moves the cursor");
  await step("KeyL", "読む", 2, ["Alt"]);
  await writeOptions({ keybinds });
  await until(state => state.keys.startsWith("Left/Right: words"), "the default keys again");
  await frame.focus("#search-clear");
  await press("ArrowRight");
  await press("ArrowUp");
  await settle(300);
  const elsewhere = await view();
  assert.equal(elsewhere.query, "漢字読むありがとう", "Up with focus on a button changes no line");
  await frame.focus("#search-query");
  assert.equal((await view()).cursor?.at, 2, "Right with focus on a button moves no cursor");
  console.log("PASS: the search page's keys follow Settings → Keybinds and leave other controls alone");

  // With the history off, nothing is kept and Up recalls nothing.
  await writeOptions({ searchHistoryEnabled: false });
  await frame.waitForFunction(() => !globalThis.HDSearchHistory.enabled, { polling: 50, timeout: 10_000 });
  const before = await lines();
  await typeSearch("ありがとう");
  assert.ok(await shows("ありがとう"));
  await until(state => state.query === "ありがとう", "a search with the history off");
  await press("ArrowUp");
  await settle(300);
  assert.equal((await view()).where, null, "no earlier line is shown");
  await press("Escape");
  await press("ArrowRight");
  await press("ArrowUp");
  await settle(300);
  assert.equal((await view()).value, "ありがとう", "Up in the box recalls nothing");
  assert.deepEqual(await lines(), before, "nothing is kept");
  await writeOptions({ searchHistoryEnabled: true });
  await frame.waitForFunction(() => globalThis.HDSearchHistory.enabled, { polling: 50, timeout: 10_000 });
  console.log("PASS: with the history off a search keeps no line, and Up recalls none");

  // A second search page, the popup window, keeps its lines with its window, and the first hears them.
  await settings.evaluate(async () => {
    const { openSearchPage } = await import(chrome.runtime.getURL("search-window.js"));
    await openSearchPage(chrome, "popup");
  });
  const windowTarget = await browser.waitForTarget(target => target.type() === "page" && target.url().endsWith("/search.html")
    && target !== search.target(), { timeout: 15_000 });
  const popupWindow = watch(await windowTarget.page(), "popup-window");
  await popupWindow.waitForFrame(frameUrl, { timeout: 30_000 });
  const windowFrame = popupWindow.frames().find(candidate => candidate.url() === frameUrl);
  await windowFrame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 30_000 });
  await windowFrame.$eval("#search-input", (box) => {
    box.value = "食べる";
    box.form.requestSubmit();
  });
  await frame.waitForFunction(() => globalThis.heard.some(({ type, detail }) => type === "line" && detail.text === "食べる"),
    { polling: 50, timeout: 15_000 });
  assert.deepEqual((await lines()).at(-1).page, "popup");
  assert.deepEqual(await lines(windowFrame), await lines());
  await popupWindow.close();
  console.log("PASS: the popup window's lines are kept with its window, and the search page in a tab hears them");

  // Settings counts the lines, applies a lowered limit at once and clears them.
  await settings.goto(`chrome-extension://${extensionId}/settings.html#lookup`, { waitUntil: "domcontentloaded" });
  await settings.waitForFunction(() => document.getElementById("search-history-count").textContent === "7 lines kept.",
    { polling: 100, timeout: 15_000 });
  if (SCREENSHOTS) {
    await settings.bringToFront();
    await settings.setViewport({ width: 1100, height: 900 });
    // Clips are page coordinates: add the scroll after scrollIntoView.
    const fieldset = await settings.$eval("#search-page-settings", (element) => {
      element.scrollIntoView({ block: "center" });
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x: x + scrollX, y: y + scrollY, width, height };
    });
    await settle(300);
    await settings.screenshot({ path: resolve(SCREENSHOTS, "settings-search-history.png"), clip: fieldset });
  }
  assert.equal(await settings.$eval("#opt-search-history", input => input.checked), true);
  // A lowered limit whose save is refused deletes nothing: another page saves
  // first, so this one's save meets a newer revision.
  await settings.bringToFront();
  await settings.evaluate(async () => {
    const input = document.getElementById("opt-search-history-limit");
    input.value = "1";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const { options } = await chrome.storage.local.get("options");
    await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
      options: { popupOpacityPercent: options.popupOpacityPercent === 90 ? 91 : 90 } });
  });
  await settings.waitForFunction(() => !document.getElementById("options-conflict-actions").hidden,
    { polling: 50, timeout: 15_000 });
  await settle(300);
  assert.equal(await settings.$eval("#search-history-count", count => count.textContent), "7 lines kept.",
    "a refused save keeps every line");
  assert.equal((await lines()).length, 7);
  await settings.click("#options-use-saved");
  await settings.waitForFunction(() => document.getElementById("options-conflict-actions").hidden
    && document.getElementById("opt-search-history-limit").value === "10000", { polling: 50, timeout: 15_000 });
  await settings.$eval("#opt-search-history-limit", (input) => {
    input.value = "3";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settings.waitForFunction(() => document.getElementById("search-history-count").textContent === "3 lines kept.",
    { polling: 100, timeout: 15_000 });
  await frame.waitForFunction(() => globalThis.heard.some(({ type, detail }) => type === "change" && detail.type === "prune"),
    { polling: 50, timeout: 15_000 });
  assert.deepEqual((await lines()).map(line => line.text), ["漢字読むありがとう", long, "食べる"], "the newest lines are kept");
  // Chrome shows a background tab's confirm() only once the tab is in front.
  await settings.bringToFront();
  await settings.click("#search-history-clear");
  await settings.waitForFunction(() => document.getElementById("search-history-count").textContent === "No lines kept."
    && document.getElementById("search-history-status").textContent === "Search history cleared.", { polling: 100, timeout: 15_000 });
  assert.deepEqual(await lines(), []);
  await settings.click("#opt-search-history");
  await frame.waitForFunction(() => !globalThis.HDSearchHistory.enabled, { polling: 50, timeout: 10_000 });
  await settings.click("#opt-search-history");
  await frame.waitForFunction(() => globalThis.HDSearchHistory.enabled, { polling: 50, timeout: 10_000 });
  await writeOptions({ searchHistoryLimit: 10000 });
  console.log("PASS: Settings shows how many lines are kept, keeps only the newest when the limit is lowered, clears"
    + " them, and turns the history off and on");

  // The texthooker user script, which Custom JavaScript runs once Chrome allows user scripts.
  const allowUserScripts = async (allowed) => {
    const extensions = await browser.newPage();
    try {
      await extensions.goto(`chrome://extensions/?id=${extensionId}`, { waitUntil: "load" });
      const perExtension = Number(/Chrome\/(\d+)/u.exec(await browser.version())[1]) >= 138;
      await extensions.evaluate((id, allowed, perExtension) => (perExtension
        ? chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: allowed })
        : chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: allowed })), extensionId, allowed, perExtension);
    } finally {
      await extensions.close();
    }
  };
  await allowUserScripts(true);
  await writeOptions({ customPopupJavascript: TEXTHOOKER });
  await settings.waitForFunction(async () => (await chrome.userScripts.getScripts({ ids: ["hachidori-custom-javascript"] }))
    .length === 1, { polling: 100, timeout: 15_000 });
  await search.close();
  const hooked = await openSearch("texthooker");
  const hookFrame = hooked.frame;
  await hookFrame.waitForSelector("#hd-texthooker ol", { timeout: 15_000 });
  const panel = () => hookFrame.evaluate(() => {
    const list = document.querySelector("#hd-texthooker ol");
    return {
      lines: [...list.querySelectorAll("li")].map(item => item.querySelector(".hd-th-text").textContent),
      stats: document.querySelector("#hd-texthooker .hd-th-stats").textContent,
      times: [...list.querySelectorAll("time")].map(stamp => getComputedStyle(stamp).display),
      pause: document.querySelector("#hd-texthooker .hd-th-pause").textContent,
      bottom: Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 2,
      overflows: list.scrollHeight > list.clientHeight,
    };
  });
  const panelUntil = async (predicate, label) => {
    const limit = Date.now() + 15_000;
    for (;;) {
      const state = await panel();
      if (predicate(state)) return state;
      assert.ok(Date.now() < limit, `${label}: ${JSON.stringify(state)}`);
      await settle(25);
    }
  };
  const searchIn = async (text) => {
    await hookFrame.$eval("#search-input", (box, value) => {
      box.value = value;
      box.form.requestSubmit();
    }, text);
    await panelUntil(state => state.lines.at(-1) === text, `the texthooker shows ${text}`);
  };
  const hookedLines = ["漢字読む", "ありがとう", "読む漢字", "食べたかった", "漢字", "読む", "ありがとう読む", "食べる", "漢字ありがとう",
    "読む読む", "漢字漢字", "ありがとう漢字"];
  for (const text of hookedLines) await searchIn(text);
  const shown = await panel();
  assert.deepEqual(shown.lines, hookedLines, "the lines, newest at the bottom");
  assert.equal(shown.stats, `12 lines · ${hookedLines.join("").length} characters`);
  assert.ok(shown.overflows && shown.bottom, `the list scrolls along: ${JSON.stringify(shown)}`);
  assert.ok(shown.times.every(display => display === "none"));
  await hookFrame.click("#hd-texthooker .hd-th-bar input[type=checkbox]");
  await panelUntil(state => state.times.every(display => display !== "none"), "times shown");
  // Paused, the Clipboard monitor's text is neither searched nor kept; resumed, it is.
  await hookFrame.click("#hd-texthooker .hd-th-pause");
  await panelUntil(state => state.pause === "Resume clipboard", "paused");
  await copyInWeb("読む漢字読む");
  await settle(1000);
  assert.equal((await panel()).lines.length, 12, "a copy while paused is not kept");
  await hooked.tab.bringToFront();
  await hookFrame.click("#hd-texthooker .hd-th-pause");
  await copyInWeb("食べる読む");
  await panelUntil(state => state.lines.at(-1) === "食べる読む" && state.pause === "Pause clipboard", "resumed");
  // A texthooker opened on lines that fill its list starts at the newest and
  // stays there when the searched text appears above it.
  const reopened = await openSearch("texthooker-reopened");
  await reopened.frame.waitForSelector("#hd-texthooker li", { timeout: 15_000 });
  await copyInWeb("漢字の本");
  await reopened.frame.waitForFunction(() => [...document.querySelectorAll("#hd-texthooker .hd-th-text")].at(-1)
    ?.textContent === "漢字の本" && document.getElementById("search-query").textContent === "漢字の本",
  { polling: 50, timeout: 15_000 });
  // A hidden tab runs no resize observer or scroll event: look at it, and
  // let two frames pass.
  await reopened.tab.bringToFront();
  await reopened.frame.evaluate(() => new Promise(done => { requestAnimationFrame(() => requestAnimationFrame(done)); }));
  const followed = await reopened.frame.evaluate(() => {
    const list = document.querySelector("#hd-texthooker ol");
    return { bottom: Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 2, overflows: list.scrollHeight > list.clientHeight };
  });
  assert.ok(followed.bottom && followed.overflows, `the reopened list follows its newest line: ${JSON.stringify(followed)}`);
  await reopened.tab.close();
  await panelUntil(state => state.lines.at(-1) === "漢字の本", "the first texthooker hears the line too");
  // Edit a line with a double click and Enter; delete one; Escape gives up an edit.
  await hooked.tab.bringToFront();
  await hookFrame.$eval("#hd-texthooker li:first-child .hd-th-text", text => text.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await hookFrame.waitForFunction(() => document.activeElement?.isContentEditable, { polling: 50, timeout: 5_000 });
  await hooked.tab.keyboard.type("漢字を読む");
  await hooked.tab.keyboard.press("Enter");
  await panelUntil(state => state.lines[0] === "漢字を読む", "the edited line");
  assert.equal((await lines(hookFrame))[0].text, "漢字を読む", "the edit is kept");
  await hookFrame.$eval("#hd-texthooker li:nth-child(2) .hd-th-text", text => text.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await hookFrame.waitForFunction(() => document.activeElement?.isContentEditable, { polling: 50, timeout: 5_000 });
  await hooked.tab.keyboard.type("捨てる");
  await hooked.tab.keyboard.press("Escape");
  await panelUntil(state => state.lines[1] === "ありがとう", "Escape gives up the edit");
  await hookFrame.$eval("#hd-texthooker li:nth-child(2) .hd-th-actions button:last-child", button => button.click());
  await panelUntil(state => state.lines.length === 13 && state.lines[1] === "読む漢字", "the deleted line");
  assert.ok(!(await lines(hookFrame)).some(line => line.text === "ありがとう"), "the line is deleted");
  // A click on a word in a line looks it up.
  const word = await hookFrame.$eval("#hd-texthooker li:nth-child(2) .hd-th-text", (text) => {
    const range = document.createRange();
    range.setStart(text.firstChild, 2);
    range.setEnd(text.firstChild, 3);
    const box = range.getBoundingClientRect();
    return { x: box.x + box.width * 0.75, y: box.y + box.height / 2 };
  });
  await hooked.tab.mouse.click(word.x, word.y);
  assert.ok(await hooked.popup.waitForVisible(15_000, state => state.text.includes(GLOSSES["漢字"])),
    "a clicked word is looked up");
  // A click beside a line's text looks nothing up; a line's buttons take
  // keyboard focus, which shows them.
  const beside = await hookFrame.$eval("#hd-texthooker li:nth-child(3) .hd-th-text", (text) => {
    const range = document.createRange();
    range.selectNodeContents(text);
    const glyphs = range.getBoundingClientRect();
    return { x: Math.min(glyphs.right + 60, text.getBoundingClientRect().right - 4), y: glyphs.y + glyphs.height / 2 };
  });
  await hooked.tab.mouse.click(beside.x, beside.y);
  await settle(500);
  assert.ok((await hooked.popup.state()).text.includes(GLOSSES["漢字"]), "a click beside the text keeps the result");
  const focusable = await hookFrame.$eval("#hd-texthooker li:nth-child(3) .hd-th-actions button", (button) => {
    button.focus();
    return { focused: document.activeElement === button, opacity: getComputedStyle(button.parentElement).opacity };
  });
  assert.deepEqual(focusable, { focused: true, opacity: "1" });
  await writeOptions({ customPopupJavascript: "" });
  await allowUserScripts(false);
  console.log("PASS: the texthooker user script lists the lines, newest at the bottom, scrolling along, with their"
    + " counts and times, pauses the Clipboard monitor, edits and deletes lines and looks up a clicked word");

  passed = true;
} finally {
  if (!passed) for (const line of diagnostics) console.log(line);
  await browser.close();
  server.close();
  if (passed) rmSync(PROFILE, { recursive: true, force: true });
}
