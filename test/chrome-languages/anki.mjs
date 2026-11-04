/*
 * Anki with language profiles in real Chrome (the Anki cases of
 * docs/languages.md 18): an installation with Japanese and Arabic profiles,
 * whose Arabic profile has a monolingual Arabic and an Arabic-English
 * dictionary for كتاب, adds an Arabic note through a fake AnkiConnect from
 * the popup's Anki button. Its glossary follows section 12's rules, and laid
 * out in Anki's Basic card styling in a left-to-right and a right-to-left card
 * template every list number sits inside the field and every paragraph reads
 * in its own order. It saves both cards under test/tmp/languages/.
 *
 * The extension under test is a copy whose language registry holds the
 * Japanese pack and the Arabic fixture pack of test/data/languages/, as
 * test/chrome-languages.mjs builds it. Every check is planned, so a check that
 * never runs fails the suite.
 *
 *   node test/run.mjs chrome-languages
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionWith, launchExtension } from "./builds.mjs";
import { ARABIC, buildLanguageFixtureZip } from "../make-language-fixtures.mjs";
import { answerAnkiConnect } from "../anki-connect-fake.mjs";
import { hoverForPopup, popupReader } from "../chrome-e2e/popup-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCREENSHOTS = resolve(ROOT, "test/tmp/languages");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || "";
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
const puppeteer = await import(PUPPETEER.startsWith("/") ? `file://${PUPPETEER}` : PUPPETEER);

const PLANNED = [
  "an Arabic note is added through the fake AnkiConnect with its glossary written by section 12's rules",
  "the Arabic note in a left-to-right card template draws every list number inside the field and every paragraph in its own order",
  "the Arabic note in a right-to-left card template draws every list number inside the field and every paragraph in its own order",
];
const results = new Map();
function check(name, ok, detail = "") {
  if (!PLANNED.includes(name)) throw new Error(`unplanned check: ${name}`);
  results.set(name, { ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail}`}`);
}
async function step(name, run) {
  try {
    await run();
  } catch (error) {
    if (!results.has(name)) check(name, false, error?.stack ?? String(error));
    else console.log(`      after ${name}: ${error?.stack ?? error}`);
  }
}
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(probe, { timeout = 15_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await wait(interval);
  }
}

// The dictionaries for كتاب: a monolingual Arabic entry with a numbered list
// and a Latin etymology, and an Arabic-English entry with an Arabic example
// and a list of both directions. Every paragraph ends with a period, which
// shows its order on its line.
const BOOK = "\u0643\u062A\u0627\u0628";
const sc = content => ({ type: "structured-content", content });
const DICTIONARIES = [
  { title: "hachidori-arabic-monolingual", sourceLanguage: "ar", targetLanguage: "ar", terms: [
    [BOOK, "", "", "n", 0, [sc([
      { tag: "ol", content: [{ tag: "li", content: "صحائف مجموعة مكتوبة." }, { tag: "li", content: "الرسالة المكتوبة إلى شخص." }] },
      { tag: "div", content: "From Aramaic ktāḇā (writing)." }])], 1, ""]] },
  { title: "hachidori-arabic-english-examples", sourceLanguage: "ar", targetLanguage: "en", terms: [
    [BOOK, "", "", "n", 0, [sc([
      { tag: "div", content: "a book; a written work." },
      { tag: "div", data: { content: "example-sentence" }, content: [
        { tag: "div", content: "قرأتُ الكتابَ كلَّه في ليلةٍ واحدةٍ." }, { tag: "div", content: "I read the whole book in one night." }] },
      { tag: "ul", content: [{ tag: "li", content: "كتب مقدسة." }, { tag: "li", content: "holy books." }] }])], 1, ""]] },
];

// A fake AnkiConnect with one note type, Basic, whose notes the checks read.
const notes = [];
function serveAnki() {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = await answerAnkiConnect(JSON.parse(body), (action, params) => {
      if (action === "version") return 6;
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "modelFieldNames") return ["Front", "Back", "Sentence"];
      if (["findNotes", "findCards"].includes(action)) return [];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      if (action === "addNote") { notes.push(params.note); return notes.length; }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(notes[noteId - 1].fields).map(([field, value]) => [field, { value }])) }));
      throw new Error(`Unexpected Anki action: ${action}`);
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reply));
  });
  return new Promise(resolveServer => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

const PAGES = {
  "/arabic.html": `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Arabic</title></head>
    <body style="font: 32px sans-serif; padding: 40px"><p id="sample">\u0627\u0644\u0643\u062A\u0627\u0628 \u062C\u062F\u064A\u062F.</p></body></html>`,
  // Two cards with the styling of Anki's Basic note type: a left-to-right card
  // template and a right-to-left one, {{Front}}<hr id=answer>{{Back}} and the sentence.
  "/cards.html": `<!doctype html><html><head><meta charset="utf-8"><title>Cards</title><style>
    body { margin: 0; display: flex; gap: 40px; padding: 20px; }
    .card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; width: 560px; }
    </style></head><body><div class="card" id="card-ltr"></div><div class="card" id="card-rtl"><div dir="rtl"></div></div></body></html>`,
};

function servePages() {
  const server = createServer((request, response) => {
    const page = PAGES[new URL(request.url, "http://localhost").pathname];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(page ?? "not found");
  });
  return new Promise(resolveServer => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

async function screenshot(page, name, selector) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  // Page coordinates, as Puppeteer's clip expects (AGENTS.md).
  const clip = await page.evaluate(target => {
    const box = document.querySelector(target).getBoundingClientRect();
    return { x: box.left + scrollX, y: box.top + scrollY, width: Math.min(1280, box.width), height: Math.min(1280, box.height) };
  }, selector);
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), clip });
}

// A rect at the `index`th character of the first text node of `selector`.
function characterPoint(page, selector, index) {
  return page.evaluate(({ selector: target, index: at }) => {
    const range = document.createRange();
    range.setStart(document.querySelector(target).firstChild, at);
    range.setEnd(document.querySelector(target).firstChild, at + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { selector, index });
}

// Every list number inside the field (each ::marker box, from CDP, inside its
// card) and every paragraph in its own order (its final period at the end its
// own letters read toward), for one card.
async function measureCard(page, cdp, id) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const markers = [];
  const walk = (node, inside) => {
    const attributes = node.attributes ?? [];
    const named = attributes.findIndex((value, index) => index % 2 === 0 && value === "id");
    const here = inside || (named >= 0 && attributes[named + 1] === id);
    if (here) for (const pseudo of node.pseudoElements ?? []) if (pseudo.pseudoType === "marker") markers.push(pseudo.nodeId);
    for (const child of node.children ?? []) walk(child, here);
  };
  walk(root, false);
  const boxes = [];
  for (const nodeId of markers) {
    const quad = (await cdp.send("DOM.getBoxModel", { nodeId })).model.border;
    boxes.push({ left: Math.min(quad[0], quad[6]), right: Math.max(quad[2], quad[4]) });
  }
  return page.evaluate((cardId, markerBoxes) => {
    const card = document.getElementById(cardId).getBoundingClientRect();
    const visible = rects => [...rects].filter(item => item.width > 0 && item.height > 0);
    const range = (node, start, end) => {
      const value = document.createRange();
      value.setStart(node, start);
      value.setEnd(node, end);
      return value;
    };
    const paragraphs = [];
    const walker = document.createTreeWalker(document.getElementById(cardId), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.trimEnd();
      const letters = text.match(/\p{L}/gu)?.length ?? 0;
      if (!text.endsWith(".") || letters === 0) continue;
      const own = (text.match(/\p{Script=Arabic}/gu)?.length ?? 0) * 2 > letters ? "rtl" : "ltr";
      const period = visible(range(node, text.length - 1, text.length).getClientRects()).at(-1);
      let block = node.parentElement;
      while (getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
      const line = [];
      const blockWalker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let other = blockWalker.nextNode(); other; other = blockWalker.nextNode()) {
        for (const item of visible(range(other, 0, other.data.length).getClientRects())) {
          if (Math.abs(item.top - period.top) < 2 && /\S/u.test(other.data)) line.push(item);
        }
      }
      const left = Math.min(...line.map(item => item.left)), right = Math.max(...line.map(item => item.right));
      paragraphs.push({ text, own, ok: own === "rtl" ? period.left <= left + 1 : period.right >= right - 1 });
    }
    const outside = markerBoxes.filter(box => box.left < card.left - 0.5 || box.right > card.right + 0.5);
    return { markers: markerBoxes.length, outside, card: { left: card.left, right: card.right },
      paragraphs, wrong: paragraphs.filter(paragraph => !paragraph.ok).map(paragraph => paragraph.text) };
  }, id, boxes);
}

// ---------------------------------------------------------------- the suite

const scratch = mkdtempSync(join(tmpdir(), "hachidori-languages-anki-"));
const errors = [];
const anki = await serveAnki();
const pages = await servePages();
const origin = `http://127.0.0.1:${pages.address().port}`;
let installation = null;

try {
  const extension = await extensionWith(scratch, "anki", ["ar"]);
  installation = await launchExtension(puppeteer, { chrome: CHROME, scratch, name: "anki", extension, errors });
  const { message, storage } = installation;

  await step(PLANNED[0], async () => {
    // Japanese and Arabic profiles; the Arabic one, active, reads the Arabic
    // fixture and both dictionaries for كتاب.
    const added = await message({ target: "hoshidicts-offscreen", type: "hd_profile_add", language: "ar", copyFrom: "ja" });
    if (added?.ok !== true) throw new Error(`hd_profile_add: ${JSON.stringify(added)}`);
    for (const fixture of [ARABIC, ...DICTIONARIES]) {
      await installation.importArchive(buildLanguageFixtureZip(fixture), `${fixture.title}.zip`, "ar");
    }
    const selection = await message({ target: "hoshidicts-worker", type: "hd_language_selection_write",
      baseRevision: 0, activeProfileId: "ar" });
    if (selection?.ok !== true) throw new Error(`hd_language_selection_write: ${JSON.stringify(selection)}`);
    // Lookups without a key, and the Arabic profile's first Template adding
    // Basic notes; the connection is every language's.
    let stored = await storage(["options"]);
    const written = await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision,
      options: { lookupMode: "hover" } });
    if (written?.ok !== true) throw new Error(`hd_options_write: ${JSON.stringify(written)}`);
    const settings = await installation.page("settings.html#anki");
    const templates = await settings.evaluate(url => {
      const field = value => ({ value, overwriteMode: "coalesce" });
      return globalThis.HDReaderOptions.normaliseAnki({ url, apiKey: "", templates: [{
        ...globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE, id: "arabic-words", name: "Arabic words", model: "Basic",
        deck: "Default", captureScreenshot: false,
        fieldTemplates: { Front: field("{expression}"), Back: field("{glossary}"), Sentence: field("{sentence}") } }] });
    }, `http://127.0.0.1:${anki.address().port}`);
    stored = await storage(["options"]);
    const saved = await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision,
      profileId: "ar", options: { anki: templates } });
    if (saved?.ok !== true) throw new Error(`hd_options_write anki: ${JSON.stringify(saved)}`);
    await settings.close();
    await installation.ready();

    const reading = await installation.browser.newPage();
    reading.on("pageerror", error => errors.push(`[page] ${error.message}`));
    await reading.setViewport({ width: 1280, height: 720 });
    await reading.goto(`${origin}/arabic.html`, { waitUntil: "load" });
    const popup = await popupReader(reading);
    // The fourth letter of الكتاب, on a right-to-left page.
    const point = await characterPoint(reading, "#sample", 3);
    const state = await hoverForPopup(reading, popup, "#sample",
      { point, accept: current => current.plain.includes("a written work"), attempts: 20 });
    const ready = await until(async () => (await popup.anki())?.controls[0]?.state === "ready", { timeout: 30_000 });
    if (!ready) throw new Error(`the Anki button never became ready: ${JSON.stringify(await popup.anki())}`);
    await popup.click(".gsm-hoshidicts-mine-button");
    const added_ = await until(async () => (await popup.anki())?.controls[0]?.state === "success" && notes.length === 1,
      { timeout: 30_000 });
    const fields = notes[0]?.fields ?? {};
    const shape = await reading.evaluate(html => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const root = holder.querySelector(".yomitan-glossary");
      return { dir: root?.getAttribute("dir"), align: root?.style.textAlign, padding: root?.querySelector(":scope > ol")?.style.paddingInline,
        items: [...(root?.querySelectorAll(":scope > ol > li") ?? [])].map(item => [item.dataset.dictionary, item.getAttribute("dir")]),
        footer: root?.querySelector(".yomitan-glossary-details")?.getAttribute("dir") };
    }, fields.Back ?? "");
    check(PLANNED[0], Boolean(state) && added_ && fields.Front === BOOK && shape.dir === "rtl"
      && shape.align === "start" && shape.padding === "40px" && shape.footer === "ltr"
      && JSON.stringify(shape.items) === JSON.stringify([[ARABIC.title, "ltr"], ["hachidori-arabic-monolingual", "rtl"],
        ["hachidori-arabic-english-examples", "ltr"]])
      && /^<span dir="auto">.*<b>.+<\/b>.*<\/span>$/u.test(fields.Sentence ?? ""),
    JSON.stringify({ popup: state?.plain, added: added_, shape, fields }));
    await reading.close();
  });

  await step(PLANNED[1], async () => {
    const fields = notes[0]?.fields;
    if (!fields) throw new Error("no Arabic note was added");
    const cards = await installation.browser.newPage();
    await cards.setViewport({ width: 1280, height: 1100 });
    await cards.goto(`${origin}/cards.html`, { waitUntil: "load" });
    await cards.evaluate(note => {
      const card = `${note.Front}<hr id=answer>${note.Back}<div>${note.Sentence}</div>`;
      document.getElementById("card-ltr").innerHTML = card;
      document.querySelector("#card-rtl > div").innerHTML = card;
      // Lay the cards out, which creates the ::marker boxes DOM.getDocument reports.
      document.body.getBoundingClientRect();
    }, fields);
    const cdp = await cards.createCDPSession();
    await cdp.send("DOM.enable");
    const ltr = await measureCard(cards, cdp, "card-ltr");
    const rtl = await measureCard(cards, cdp, "card-rtl");
    await screenshot(cards, "anki-note-ltr-card", "#card-ltr");
    await screenshot(cards, "anki-note-rtl-card", "#card-rtl");
    // Seven numbers and bullets, nine paragraphs: none may be missed.
    const passes = card => card.markers === 7 && card.outside.length === 0 && card.paragraphs.length === 9 && card.wrong.length === 0;
    check(PLANNED[1], passes(ltr), JSON.stringify(ltr));
    check(PLANNED[2], passes(rtl), JSON.stringify(rtl));
  });
} finally {
  await installation?.browser.close().catch(() => {});
  anki.close();
  pages.close();
  rmSync(scratch, { recursive: true, force: true });
}

const failed = PLANNED.filter(name => results.get(name)?.ok !== true);
for (const name of PLANNED.filter(planned => !results.has(planned))) console.log(`FAIL  ${name}\n      check never ran`);
if (errors.length > 0) console.log(`page errors:\n  ${errors.join("\n  ")}`);
console.log(`\n${PLANNED.length - failed.length}/${PLANNED.length} checks passed; screenshots in ${SCREENSHOTS}`);
process.exitCode = failed.length === 0 ? 0 : 1;
