// SPDX-License-Identifier: GPL-3.0-or-later
//
// More custom buttons in a real Chrome (docs/custom-buttons-and-templates.md),
// against a fake AnkiConnect that already holds a note for 漢字:
//
// - Design → Custom buttons adds the View in Anki and Mine as kana
//   ready-made buttons and a script button through the form.
// - On 漢字, whose note exists under a Template that overwrites, the built-in
//   Anki button offers Overwrite and View in Anki shows beside it; pressing it
//   opens the note in Anki's browser. On 読む, which Anki lacks, it is hidden.
// - Mine as kana adds a note whose Front is the reading, こじれる-style (#770).
// - A user script hears the script button with the word, and runs View notes
//   through hachidori-action.
//
// Screenshots of Settings and the popup go to test/tmp/ci/:
//
//   node test/make-fixture.mjs && node test/chrome-more-buttons.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require(process.env.HACHIDORI_PUPPETEER || "puppeteer-core");
const extension = realpathSync(resolve(root, "extension"));
const chromePath = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${require("./package.json").config.chrome}/chrome-linux64/chrome`);
const output = resolve(root, "test/tmp/ci");
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-more-buttons-"));
const EXISTING_NOTE = 7;

const extensionId = path => [...createHash("sha256").update(path).digest("hex").slice(0, 32)]
  .map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");

const page = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>More custom buttons</title>
<style>body{margin:40px;font:28px sans-serif;background:#fff;color:#111}p{margin:0 0 420px}</style>
<p><span id="kanji">漢字</span>を<span id="read">読む</span></p>`;

// Anki holds one note, for 漢字; everything else is new.
const notes = [{ noteId: EXISTING_NOTE, fields: { Front: "漢字", Back: "an older card" } }];
const browsed = [];
const media = new Map();
const unexpected = new Set();
const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(page);
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const reply = await answerAnkiConnect(JSON.parse(body), (action, params) => {
    const answers = { version: 6, deckNames: ["Default"], modelNames: ["Basic"], modelNamesAndIds: { Basic: 1 },
      modelFieldNames: ["Front", "Back"], findCards: [], cardsInfo: [], getIntervals: [] };
    if (Object.hasOwn(answers, action)) return answers[action];
    if (action === "findNotes") {
      return notes.filter(note => String(params.query).includes(note.fields.Front)).map(note => note.noteId);
    }
    if (action === "notesInfo") {
      return params.notes.map(noteId => notes.find(note => note.noteId === noteId)).filter(Boolean)
        .map(note => ({ noteId: note.noteId, modelName: "Basic", tags: [], cards: [],
          fields: Object.fromEntries(Object.entries(note.fields).map(([field, value], order) => [field, { value, order }])) }));
    }
    if (action === "canAddNotesWithErrorDetail") {
      return params.notes.map(note => (notes.some(stored => stored.fields.Front === note.fields.Front)
        ? { canAdd: false, error: "cannot create note because it is a duplicate" } : { canAdd: true, error: null }));
    }
    if (action === "addNote") {
      const noteId = 100 + notes.length;
      notes.push({ noteId, fields: params.note.fields });
      return noteId;
    }
    if (action === "guiBrowse") { browsed.push(params.query); return []; }
    if (action === "getMediaFilesNames") return media.has(params.pattern) ? [params.pattern] : [];
    if (action === "storeMediaFile") { media.set(params.filename, params.data); return params.filename; }
    unexpected.add(action);
    return null;
  });
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(reply));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

// `message` is a string, or a function giving one when the wait fails.
async function until(probe, message, ms = 20_000) {
  for (const deadline = Date.now() + ms; !(await probe());) {
    if (Date.now() >= deadline) assert.fail(typeof message === "function" ? await message() : message);
    await new Promise(done => setTimeout(done, 100));
  }
}

// The popup's buttons through CDP's piercing DOM, which sees into the closed
// root: each visible custom or Anki button's class, label and page box.
async function popupButtons(tab) {
  const session = await tab.createCDPSession();
  try {
    const { root: documentRoot } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const found = [];
    const statuses = [];
    const attribute = (node, name) => {
      const attributes = node.attributes ?? [];
      const at = attributes.indexOf(name);
      return at >= 0 ? attributes[at + 1] : null;
    };
    const text = node => (node.nodeType === 3 ? node.nodeValue : (node.children ?? []).map(text).join(""));
    (function walk(node) {
      const className = attribute(node, "class") ?? "";
      if (node.nodeName === "BUTTON" && /gsm-hoshidicts-(custom-|mine-button)/u.test(className)) found.push(node);
      if (className.includes("gsm-hoshidicts-anki-status") && text(node)) statuses.push(text(node));
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    }(documentRoot));
    const buttons = [];
    for (const node of found) {
      if (attribute(node, "hidden") !== null) continue;
      const box = await session.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId }).catch(() => null);
      if (!box) continue;
      const [x1, y1, , , x3, y3] = box.model.border;
      buttons.push({ className: attribute(node, "class"), label: attribute(node, "aria-label"),
        state: attribute(node, "data-state"), x: (x1 + x3) / 2, y: (y1 + y3) / 2 });
    }
    buttons.statuses = statuses;
    return buttons;
  } finally {
    await session.detach().catch(() => {});
  }
}

mkdirSync(output, { recursive: true });
const id = extensionId(extension);
let browser;
let passed = false;
try {
  browser = await puppeteer.launch({
    executablePath: chromePath, headless: true, enableExtensions: true, userDataDir: profile, pipe: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  console.log(`browser ${await browser.version()}`);
  const workerTarget = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  assert.equal(new URL(workerTarget.url()).host, id, "the computed extension ID is the one Chrome loaded");
  const settings = await browser.newPage();
  settings.setDefaultTimeout(60_000);
  await settings.setViewport({ width: 1180, height: 1000 });
  await settings.goto(`chrome-extension://${id}/settings.html#advanced`);
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))],
      { type: "application/zip" }));
    try {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: "more-buttons-fixture-import", blobUrl, fileName: "hachidori-fixture.zip" });
      if (!reply.ok) throw new Error(reply.error);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, readFileSync(resolve(root, "test/fixtures/hachidori-fixture.zip")).toString("base64"));
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  await settings.evaluate(async ankiUrl => {
    const { options } = await chrome.storage.local.get("options");
    const anki = { ...HDReaderOptions.DEFAULT_OPTIONS.anki, url: ankiUrl, model: "Basic", deck: "Default",
      duplicateBehavior: "overwrite",
      fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
        Back: { value: "{glossary}", overwriteMode: "overwrite" } } };
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { anki, hoverEnabled: true, lookupMode: "hover" } });
    if (!reply.ok) throw new Error(reply.error);
  }, origin);
  console.log("fixture imported, Anki Template overwrites");

  // Three buttons from Design's form. The first-run page would keep
  // Settings in the background, where nothing paints.
  for (const other of await browser.pages()) if (other.url().endsWith("/startup.html")) await other.close();
  await settings.bringToFront();
  const click = selector => settings.evaluate(selector => document.querySelector(selector).click(), selector);
  const shown = selector => settings.waitForFunction(selector => document.querySelector(selector), { polling: 100 }, selector);
  await settings.goto(`chrome-extension://${id}/settings.html#design`);
  await shown("#custom-button-presets:not([hidden])");
  const addPreset = async (preset, count) => {
    await click(`[data-preset="${preset}"]`);
    await click("#custom-button-submit");
    await settings.waitForFunction(expected => document.querySelectorAll("#custom-button-list > li").length === expected,
      { polling: 100 }, count);
  };
  await addPreset("view-notes", 1);
  await addPreset("mine-kana", 2);
  await settings.evaluate(() => {
    const name = document.getElementById("opt-custom-button-name");
    name.value = "Speak";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const type = document.getElementById("opt-custom-button-type");
    type.value = "script";
    type.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("#custom-button-submit");
  await settings.waitForFunction(() => document.querySelectorAll("#custom-button-list > li").length === 3, { polling: 100 });
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.customButtons?.length === 3,
    { polling: 100 });
  const stored = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options.customButtons
    .map(({ id: _id, ...button }) => button));
  assert.deepEqual(stored, [
    { type: "action", label: "View in Anki", action: "viewNotes", argument: "", icon: "book-search" },
    { type: "anki", label: "Mine as kana", templateId: "default",
      markers: { expression: "reading", furigana: "reading", "furigana-plain": "reading" } },
    { type: "script", label: "Speak" },
  ]);
  await settings.evaluate(() => {
    const type = document.getElementById("opt-custom-button-type");
    type.value = "anki";
    type.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const section = await settings.$("#custom-buttons-settings");
  await section.scrollIntoView();
  await section.screenshot({ path: resolve(output, "more-buttons-settings.png") });
  console.log("Settings added View in Anki, Mine as kana and a script button");

  // A user script that answers the script button and runs View notes.
  const perExtension = Number(/Chrome\/(\d+)/u.exec(await browser.version())[1]) >= 138;
  const extensions = await browser.newPage();
  await extensions.goto(`chrome://extensions/?id=${id}`, { waitUntil: "load" });
  await extensions.evaluate((extensionId, perExtension) => (perExtension
    ? chrome.developerPrivate.updateExtensionConfiguration({ extensionId, userScriptsAccess: true })
    : chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })), id, perExtension);
  await extensions.close();
  await writeOptions({ userScripts: [{ id: "speak", name: "Speak", enabled: true, css: "", javascript: `
    let root = null;
    window.addEventListener("hachidori-popup-shown", () => {
      const shown = document.querySelector("hachidori-host")?.shadowRoot;
      if (!shown || shown === root) return;
      root = shown;
      root.addEventListener("hachidori-button", event => {
        document.documentElement.dataset.heard = event.detail;
        event.target.dispatchEvent(new CustomEvent("hachidori-action", { bubbles: true,
          detail: JSON.stringify({ action: "viewNotes" }) }));
      });
    });` }] });

  const tab = await browser.newPage();
  await tab.bringToFront();
  tab.setDefaultTimeout(30_000);
  await tab.setViewport({ width: 900, height: 620 });
  await tab.goto(`${origin}/page.html`);
  const hover = async selector => {
    await tab.mouse.move(890, 600);
    await new Promise(done => setTimeout(done, 400));
    const box = await (await tab.$(selector)).boundingBox();
    await tab.mouse.move(box.x + 10, box.y + box.height / 2);
  };
  // A custom Anki button's name is its label and then its state.
  const button = async label => (await popupButtons(tab)).find(entry => entry.label === label
    || entry.label?.startsWith(`${label}: `));
  // Straight down from the word into the popup's header, then along its row,
  // so the pointer crosses no other text on the way.
  const press = async label => {
    const target = await button(label);
    await tab.mouse.move(60, target.y, { steps: 4 });
    await tab.mouse.move(target.x, target.y, { steps: 8 });
    await tab.mouse.click(target.x, target.y);
  };

  await hover("#kanji");
  await until(async () => (await popupButtons(tab)).some(entry => entry.state === "overwrite")
    && Boolean(await button("View in Anki")), "on 漢字 the Anki button overwrites and View in Anki shows beside it");
  await until(async () => (await button("Mine as kana"))?.state === "ready",
    "Mine as kana is ready on 漢字, whose kana form Anki lacks");
  const row = await popupButtons(tab);
  assert.deepEqual(row.map(entry => entry.label).filter(Boolean).slice(-3),
    ["View in Anki", "Mine as kana: Mine to Anki", "Speak"], "the custom buttons follow the built-in actions in order");
  const clip = { x: 0, y: 0, width: 900, height: 420 };
  await tab.screenshot({ path: resolve(output, "more-buttons-popup.png"), clip });
  // The same row in the dark palette and in a Windows contrast theme.
  for (const [name, features] of [["dark", [{ name: "prefers-color-scheme", value: "dark" }]],
    ["forced-colors", [{ name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: "dark" }]]]) {
    await tab.emulateMediaFeatures(features);
    await new Promise(done => setTimeout(done, 300));
    await tab.screenshot({ path: resolve(output, `more-buttons-popup-${name}.png`), clip });
  }
  await tab.emulateMediaFeatures([]);
  await press("View in Anki");
  await until(() => browsed.length === 1, "View in Anki opens Anki's browser");
  assert.match(browsed[0], new RegExp(`nid:${EXISTING_NOTE}\\b`, "u"), "it shows the note Anki holds for 漢字");
  assert.equal(notes.length, 1, "viewing writes nothing");
  console.log("View in Anki opened the existing note beside Overwrite");

  await press("Mine as kana");
  await until(async () => notes.length === 2, async () => `Mine as kana adds a note (${JSON.stringify((await popupButtons(tab)).statuses)}, ${JSON.stringify(await popupButtons(tab))})`);
  await until(async () => (await popupButtons(tab)).statuses.some(status => /^Added note/u.test(status)),
    "the popup reports the note Mine as kana added");
  assert.equal(notes[1].fields.Front, "かんじ", "Mine as kana writes the reading where the Template writes {expression}");
  assert.match(notes[1].fields.Back, /Chinese character/u, "with the definitions of the 漢字 result");
  console.log("Mine as kana wrote かんじ with 漢字's definitions");

  await press("Speak");
  await until(async () => Boolean(await tab.evaluate(() => document.documentElement.dataset.heard)),
    "the user script hears the script button");
  const heard = JSON.parse(await tab.evaluate(() => document.documentElement.dataset.heard));
  assert.deepEqual([heard.label, heard.word, heard.reading, heard.entry], ["Speak", "漢字", "かんじ", 0]);
  await until(() => browsed.length === 2, "the user script runs View notes through hachidori-action");
  console.log("a user script answered the script button and ran View notes");

  await hover("#read");
  await until(async () => (await popupButtons(tab)).some(entry => entry.state === "ready" && /mine-button/u.test(entry.className)),
    "on 読む the Anki button adds");
  assert.equal(await button("View in Anki"), undefined, "View in Anki hides on a word Anki lacks");
  console.log("View in Anki hides on a word Anki lacks");

  // A page cannot run an action: it cannot reach the closed root.
  await tab.evaluate(() => window.dispatchEvent(new CustomEvent("hachidori-action",
    { detail: JSON.stringify({ action: "viewNotes" }) })));
  await new Promise(done => setTimeout(done, 500));
  assert.equal(browsed.length, 2, "an action dispatched by the page does nothing");
  assert.deepEqual([...unexpected].filter(action => !["getDeckConfig", "getEaseFactors"].includes(action)), [],
    "the fake AnkiConnect answered every action Hachidori asked");
  passed = true;
} finally {
  await browser?.close().catch(() => {});
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(passed ? "PASS chrome-more-buttons" : "FAIL chrome-more-buttons");
