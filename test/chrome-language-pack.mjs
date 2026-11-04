/*
 * One language pack in real Chrome: the lookup check each language's pack
 * passes before it merges, and that the integrator runs for every language
 * (docs/languages.md 14, 16 and 18). In one fresh profile of headless Chrome,
 * as a user would:
 *
 *   1. Settings → Manage languages → Add a language adds the pack's
 *      language, and the Japanese profile stays.
 *   2. Settings' import puts the dictionary into that profile; the import
 *      must succeed and the engine must load it.
 *   3. Each case's sentence is a page <html lang dir> in the pack's language.
 *      The word's first occurrence is hovered: at its first character when
 *      the pack's scan starts at the cursor, and at the middle character of
 *      its first run of word characters when the scan starts at the word, so
 *      the reader has to move the start back. The popup's first result must
 *      have the expected headword: its term's expression as the dictionary
 *      writes it, compared after NFC normalisation. The text the page
 *      highlights as matched, the steps of the popup's deinflection
 *      disclosure and the first gloss are recorded. A word without a popup
 *      fails its case after about 30 seconds of hovering, saying what the
 *      engine finds for the text.
 *   4. The popup's Anki button adds the first case's result to a fake
 *      AnkiConnect through a Basic Template; the note's first field must be
 *      the headword.
 *   5. The toolbar switches to Japanese, where 食べた finds 食べる in the
 *      Japanese fixture dictionary, then back, where the first case must be
 *      found again. Every installation has the Japanese profile, so for
 *      Japanese itself step 1 adds English, with the English fixture
 *      dictionary, and the toolbar switches to English and back.
 *   6. Screenshots of the Settings language dialog, the toolbar's language
 *      switcher and the first lookup, each at most 1280 px a side.
 *
 * It prints a PASS or FAIL line per check, then one JSON line: language,
 * profile, dictionary, cases (sentence, word, expected, headword, matched,
 * trace, gloss, ok), anki, switch, screenshots, passed, failed, seconds; a
 * failed part has an `error`. It exits 1 when a check fails and 2 when an
 * input or the browser is missing.
 *
 *   HACHIDORI_LANGUAGE=en HACHIDORI_DICTIONARY=/path/to/kty-en-en.zip \
 *     HACHIDORI_CASES=test/data/language-pack/en.tsv node test/run.mjs chrome-language-pack
 *
 * HACHIDORI_LANGUAGE (required) is the pack's code. The pack must be in
 * extension/vendor/languages/: for a pack on a hoshidicts branch, check that
 * branch out in third_party/hoshidicts and run node scripts/sync-languages.mjs.
 * Packs load at run time, so the WebAssembly needs no rebuild.
 * HACHIDORI_DICTIONARY (required) is a Yomitan-format dictionary .zip for the
 * language, of any size. It is copied into a temporary directory first;
 * nothing is written beside it.
 * HACHIDORI_CASES (optional) is a UTF-8 file of
 * sentence<TAB>word<TAB>expected headword lines; blank lines and lines
 * starting with # are skipped. test/data/language-pack/ has the English,
 * Arabic and Japanese cases this check was proved with. Without it the one
 * case is the pack's host.sample.practice text and word, expecting
 * host.sample.entry's expression when that entry's matched text is the word,
 * and the word itself otherwise.
 * HACHIDORI_SCREENSHOTS (optional) is where the screenshots go,
 * test/tmp/language-pack/<code>/ by default.
 * HACHIDORI_CHROME, HACHIDORI_PUPPETEER and HACHIDORI_ALLOW_NO_SANDBOX=1 work
 * as for the other browser suites; test/run.mjs sets the first two to the
 * pinned Chrome and the locked puppeteer-core.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { AnkiConnectError, answerAnkiConnect } from "./anki-connect-fake.mjs";
import { hoverForPopup, popupReader } from "./chrome-e2e/popup-reader.mjs";
import { launchExtension } from "./chrome-languages/builds.mjs";
import { popupRoot } from "./chrome-popup-root.mjs";
import { TITLE as JAPANESE_FIXTURE_TITLE, buildFixtureZip } from "./make-fixture.mjs";
import { ENGLISH, buildLanguageFixtureZip } from "./make-language-fixtures.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = resolve(ROOT, "extension");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || "";
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
const HIGHLIGHT_NAME = readFileSync(resolve(EXTENSION, "content.js"), "utf8").match(/HIGHLIGHT_NAME\s*=\s*"([^"]+)"/u)?.[1];
const IMPORT_TIMEOUT = 30 * 60_000;

// ------------------------------------------------------------------ inputs

function setupError(message) {
  console.error(`chrome-language-pack: ${message}`);
  process.exit(2);
}

// The descriptors content scripts read, with the class references of their
// text rules expanded (docs/languages.md 9.1).
const READER = (() => {
  const context = {};
  context.globalThis = context;
  runInNewContext(readFileSync(join(EXTENSION, "vendor/languages/registry-reader.js"), "utf8"), context);
  return context.HDLanguages;
})();

// A pack's language.json with the text rules the reader uses.
function packOf(code) {
  const path = join(EXTENSION, "vendor/languages", code, "language.json");
  if (!/^[A-Za-z0-9-]+$/u.test(code) || !existsSync(path) || !READER.get(code)) return null;
  return { ...JSON.parse(readFileSync(path, "utf8")), text: READER.get(code).text };
}

const CODE = process.env.HACHIDORI_LANGUAGE ?? "";
const PACK = packOf(CODE);
if (PACK === null) {
  setupError(`HACHIDORI_LANGUAGE=${JSON.stringify(CODE)} names no pack in extension/vendor/languages/ (check out the`
    + " hoshidicts branch in third_party/hoshidicts and run node scripts/sync-languages.mjs)");
}
const DICTIONARY = resolve(process.env.HACHIDORI_DICTIONARY ?? "");
if (!process.env.HACHIDORI_DICTIONARY || !existsSync(DICTIONARY) || !statSync(DICTIONARY).isFile()) {
  setupError("set HACHIDORI_DICTIONARY to a Yomitan dictionary .zip");
}
if (!CHROME) setupError("set HACHIDORI_CHROME, or run node test/run.mjs chrome-language-pack");
if (!existsSync(PUPPETEER)) setupError(`no puppeteer-core at ${PUPPETEER} (set HACHIDORI_PUPPETEER, or run through test/run.mjs)`);
if (!HIGHLIGHT_NAME) setupError("could not read HIGHLIGHT_NAME out of extension/content.js");

function readCases(path) {
  if (!existsSync(path)) setupError(`HACHIDORI_CASES=${path} does not exist`);
  const cases = [];
  for (const [index, raw] of readFileSync(path, "utf8").replace(/^\uFEFF/u, "").split("\n").entries()) {
    const line = raw.replace(/\r$/u, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const fields = line.split("\t").map(field => field.trim());
    if (fields.length !== 3 || fields.includes("")) setupError(`${path}:${index + 1}: not sentence<TAB>word<TAB>expected headword`);
    const [sentence, word, expected] = fields;
    if (!sentence.includes(word)) setupError(`${path}:${index + 1}: ${JSON.stringify(word)} is not in the sentence`);
    cases.push({ sentence, word, expected });
  }
  if (cases.length === 0) setupError(`${path} has no cases`);
  return cases;
}

function sampleCases() {
  const { practice, entry } = PACK.host?.sample ?? {};
  if (typeof practice?.text !== "string" || typeof practice.lookup !== "string") {
    setupError(`the ${CODE} pack has no host.sample.practice; set HACHIDORI_CASES`);
  }
  const expected = entry?.matched === practice.lookup && typeof entry.expression === "string" ? entry.expression : practice.lookup;
  return [{ sentence: practice.text, word: practice.lookup, expected }];
}

const CASES = process.env.HACHIDORI_CASES ? readCases(resolve(process.env.HACHIDORI_CASES)) : sampleCases();
const SCREENSHOTS = resolve(process.env.HACHIDORI_SCREENSHOTS || join(ROOT, "test/tmp/language-pack", CODE));

// The language the toolbar switches to and back from: Japanese with the
// Japanese fixture dictionary or, when the pack under test is Japanese (whose
// profile every installation has), English with the English fixture.
const OTHER = CODE === "ja"
  ? { code: "en", file: `switch-${ENGLISH.file}`, archive: () => buildLanguageFixtureZip(ENGLISH),
    case: { sentence: "She was running late.", word: "running", expected: "run" } }
  : { code: "ja", file: `switch-${JAPANESE_FIXTURE_TITLE}.zip`, archive: buildFixtureZip,
    case: { sentence: "パンを食べた。", word: "食べた", expected: "食べる" } };
OTHER.pack = packOf(OTHER.code);
if (OTHER.pack === null) setupError(`switching languages needs extension/vendor/languages/${OTHER.code}`);
// The language Settings adds.
const ADDED = CODE === "ja" ? OTHER : { code: CODE, pack: PACK };

const puppeteer = await import(pathToFileURL(PUPPETEER).href);

// ----------------------------------------------------------------- helpers

const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(probe, { timeout = 15_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await wait(interval);
  }
}
const nfc = value => String(value ?? "").normalize("NFC");
const escapeHtml = value => String(value).replace(/[&<>"']/gu, character => `&#${character.codePointAt(0)};`);

function pageFor(pack, sentence) {
  return `<!doctype html><html lang="${escapeHtml(pack.bcp47)}" dir="${pack.direction === "rtl" ? "rtl" : "ltr"}"><head>`
    + `<meta charset="utf-8"><title>${escapeHtml(pack.name)}</title></head>`
    + `<body style="font: 32px sans-serif; padding: 40px"><p id="sample">${escapeHtml(sentence)}</p></body></html>`;
}

// The grapheme to hover: for a pack whose scan starts at the cursor, the
// word's first; for one that starts at the word, the middle one of the word's
// first run of word characters, with any word-internal character between two
// of them (м’ясо), which the reader moves the start back from.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function hoverTarget(pack, { sentence, word }) {
  const parts = [...graphemes.segment(word)];
  let run = parts.slice(0, 1);
  if (pack.text.scanStart === "word") {
    const tester = source => {
      const pattern = typeof source === "string" && source !== "" ? new RegExp(source, "u") : null;
      return part => part !== undefined && pattern !== null && pattern.test(String.fromCodePoint(part.segment.codePointAt(0)));
    };
    const isWord = tester(pack.text.wordCharacters ?? pack.text.pattern);
    const isInternal = tester(pack.text.wordInternal);
    const inRun = index => isWord(parts[index])
      || (isInternal(parts[index]) && isWord(parts[index - 1]) && isWord(parts[index + 1]));
    const first = parts.findIndex(part => isWord(part));
    let end = first;
    while (end >= 0 && end < parts.length && inRun(end)) end += 1;
    if (first >= 0) run = parts.slice(first, end);
  }
  const part = run[Math.floor((run.length - 1) / 2)];
  const start = sentence.indexOf(word) + part.index;
  return { start, end: start + part.segment.length, text: part.segment };
}

// The popup's first result as rendered: each entry's headword, the
// deinflection disclosure of the first and the text of its first gloss (the
// first list item without a nested list, outside the examples a dictionary
// folds into <details>).
function firstResult(page) {
  return popupRoot(page).evaluate(root => {
    const popup = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]:not([hidden])');
    const entries = [...(popup?.querySelectorAll(".gsm-hoshidicts-entry") ?? [])];
    if (entries.length === 0) return null;
    const flat = node => (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
    const disclosure = popup.querySelector(".gsm-hoshidicts-primary-header .gsm-hoshidicts-deinflection");
    const content = entries[0].querySelector(".gsm-hoshidicts-glossary-content");
    const gloss = [...(content?.querySelectorAll(".structured-content li") ?? [])]
      .find(item => !item.closest("details") && !item.querySelector("li"))
      ?? content?.querySelector(".gloss-content") ?? content;
    const pieces = [];
    const walker = document.createTreeWalker(gloss ?? document.createElement("span"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest("details, rt, rp")) pieces.push(node.data);
    }
    return {
      headwords: entries.map(entry => entry.dataset.expression),
      matched: flat(disclosure?.querySelector(".gsm-hoshidicts-deinflection-endpoint")),
      trace: [...(disclosure?.querySelectorAll(".gsm-hoshidicts-deinflection-step-name") ?? [])].map(flat),
      gloss: pieces.join(" ").replace(/\s+/gu, " ").replace(/ ([,.;:!?)])/gu, "$1").trim().slice(0, 200),
    };
  });
}

// Page coordinates, as Puppeteer's clip expects (AGENTS.md).
async function screenshot(page, name, selector = null) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  const path = join(SCREENSHOTS, `${name}.png`);
  const clip = selector === null ? null : await page.evaluate(target => {
    const box = document.querySelector(target).getBoundingClientRect();
    return { x: box.left + scrollX, y: box.top + scrollY, width: Math.min(1280, box.width), height: Math.min(1280, box.height) };
  }, selector);
  await page.screenshot({ path, ...(clip === null ? {} : { clip }) });
  summary.screenshots[name] = path;
}

// --------------------------------------------------------------- the fakes

// AnkiConnect with one note type, Basic, whose notes the Anki check reads.
const FIELDS = ["Front", "Back", "Sentence"];
const notes = [];
const ankiFaults = [];
const anki = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const reply = await answerAnkiConnect(JSON.parse(body), (action, params) => {
    if (action === "version") return 6;
    if (action === "deckNames") return ["Default"];
    if (action === "modelNames") return ["Basic"];
    if (action === "modelNamesAndIds") return { Basic: 1 };
    if (action === "modelFieldNames") return FIELDS;
    if (["findNotes", "findCards"].includes(action)) return [];
    if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
    if (action === "addNote") { notes.push(params.note); return notes.length; }
    if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
      fields: Object.fromEntries(Object.entries(notes[noteId - 1]?.fields ?? {}).map(([field, value]) => [field, { value }])) }));
    ankiFaults.push(action);
    throw new AnkiConnectError(`unsupported action: ${action}`);
  });
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(reply));
});

const PAGES = new Map([
  ...CASES.map((testCase, index) => [`/case/${index}`, pageFor(PACK, testCase.sentence)]),
  ["/switch", pageFor(OTHER.pack, OTHER.case.sentence)],
]);
const pages = createServer((request, response) => {
  const page = PAGES.get(new URL(request.url, "http://localhost").pathname);
  response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  response.end(page ?? "not found");
});
const listen = server => new Promise(resolveServer => server.listen(0, "127.0.0.1", resolveServer));

// ---------------------------------------------------------------- the check

const summary = {
  language: CODE,
  profile: { ok: false, profiles: [], error: "not run" },
  dictionary: { file: basename(DICTIONARY), bytes: statSync(DICTIONARY).size, title: null, seconds: null, ok: false,
    error: "not run" },
  cases: CASES.map(testCase => ({ ...testCase, headword: null, matched: null, trace: [], gloss: null, ok: false,
    error: "not run" })),
  anki: { ok: false, error: "not run" },
  switch: { to: OTHER.code, ok: false, error: "not run" },
  screenshots: {},
  passed: 0,
  failed: 0,
  seconds: 0,
};
// Every check with its name, in the order they run.
const CHECKS = new Map([
  [summary.profile, `Settings adds ${ADDED.pack.name} as a profile beside Japanese`],
  [summary.dictionary, `Settings imports the dictionary into ${CODE}`],
  ...summary.cases.map((part, index) => [part, `case ${index + 1}`]),
  [summary.anki, "the Anki button adds a note with the headword first"],
  [summary.switch, `the toolbar switches to ${OTHER.code} and back`],
]);
const reported = new Set();
function report(part, detail = "") {
  reported.add(part);
  if (part.ok) delete part.error;
  console.log(`${part.ok ? "PASS" : "FAIL"}  ${CHECKS.get(part)}${detail ? `: ${detail}` : ""}${part.ok ? "" : `\n      ${part.error}`}`);
}
async function step(part, run) {
  try {
    await run();
  } catch (error) {
    part.ok = false;
    part.error = error?.message ?? String(error);
  }
}

const started = Date.now();
const scratch = mkdtempSync(join(tmpdir(), "hachidori-language-pack-"));
const errors = [];
let installation = null;

try {
  await listen(anki);
  await listen(pages);
  const origin = `http://127.0.0.1:${pages.address().port}`;
  mkdirSync(join(scratch, "files"));
  const dictionaryCopy = join(scratch, "files", basename(DICTIONARY));
  copyFileSync(DICTIONARY, dictionaryCopy);
  const otherArchive = join(scratch, "files", OTHER.file);
  writeFileSync(otherArchive, OTHER.archive());

  installation = await launchExtension(puppeteer, { chrome: CHROME, scratch, name: "pack", extension: EXTENSION, errors });
  const { browser, message, storage } = installation;
  const settings = await installation.page("settings.html#add-dictionaries");
  await settings.waitForSelector("#settings-language-select", { timeout: 30_000 });
  const editedProfile = () => settings.$eval("#settings-language-select", select => select.value);
  const writeOptions = async fields => {
    const { options } = await storage(["options"]);
    const reply = await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision, ...fields });
    if (reply?.ok !== true) throw new Error(`hd_options_write: ${JSON.stringify(reply)}`);
  };
  const openLanguages = async () => {
    await settings.bringToFront();
    await settings.click("#settings-language-manage");
    await settings.waitForSelector("#settings-language-dialog[open]", { timeout: 10_000 });
  };
  const closeLanguages = async () => {
    await settings.click('#settings-language-dialog button[value="close"]');
    await settings.waitForSelector("#settings-language-dialog:not([open])", { timeout: 10_000 });
  };

  // 1. The language, added through Settings' dialog.
  await step(summary.profile, async () => {
    await openLanguages();
    const add = await settings.waitForFunction(label => [...document.querySelectorAll("#settings-language-available button")]
      .find(button => button.getAttribute("aria-label") === label && !button.disabled) ?? null,
    { timeout: 15_000 }, `Add ${ADDED.pack.name}`).catch(() => null);
    if (add === null) throw new Error(`Add a language does not offer ${ADDED.pack.name}`);
    await add.asElement().click();
    const edited = await until(async () => (await editedProfile()) === ADDED.code, { timeout: 120_000 });
    const status = await settings.$eval("#settings-language-dialog-status", output => output.textContent);
    if (!edited) throw new Error(`adding ${ADDED.pack.name} did not finish: ${status || "no status"}`);
    await closeLanguages();
    const { options } = await storage(["options"]);
    summary.profile.profiles = (options?.profiles ?? []).map(profile => profile.id);
    const engine = await installation.ready();
    if (engine.failedLanguages?.includes(ADDED.code)) throw new Error(`the engine could not load the ${ADDED.code} pack`);
    summary.profile.ok = summary.profile.profiles.includes("ja") && summary.profile.profiles.includes(ADDED.code);
    if (!summary.profile.ok) throw new Error(`the records hold the profiles ${JSON.stringify(summary.profile.profiles)}`);
  });
  report(summary.profile, summary.profile.profiles.join(", "));

  // 2. Each profile's dictionary, through Settings' import into the profile
  // it edits.
  const importInto = async (profileId, path) => {
    await settings.bringToFront();
    if ((await editedProfile()) !== profileId) {
      await settings.select("#settings-language-select", profileId);
      const chosen = await until(() => settings.$eval("#settings-language-select",
        (select, id) => select.value === id && !select.disabled, profileId), { timeout: 30_000 });
      if (!chosen) throw new Error(`Settings did not switch to editing ${profileId}`);
    }
    const added = async () => {
      const { dictionaryState } = await storage(["dictionaryState"]);
      return (dictionaryState?.profiles?.[profileId]?.dictionaries ?? []).filter(entry => !before.includes(entry.id))
        .map(entry => dictionaryState.dictionaries?.find(row => row.id === entry.id)?.title ?? entry.id);
    };
    // This file's row in the import progress list: its status, and whether it
    // is an error.
    const row = () => settings.evaluate(name => {
      const item = [...document.querySelectorAll("#import-progress .setup-dictionary")]
        .find(candidate => candidate.querySelector(".setup-dictionary-name")?.textContent === name);
      const status = item?.querySelector(".setup-dictionary-status");
      return { text: status?.textContent.trim() ?? "", error: status?.classList.contains("is-error") === true };
    }, basename(path));
    const before = ((await storage(["dictionaryState"])).dictionaryState?.profiles?.[profileId]?.dictionaries ?? [])
      .map(entry => entry.id);
    const input = await settings.waitForSelector("#import-file:not([disabled])", { timeout: 60_000 });
    const since = Date.now();
    await input.uploadFile(path);
    // The import ends when the profile lists the new package or the row says
    // it failed; the batch ends when the input is enabled again.
    const ended = await until(async () => (await added()).length > 0 || (await row()).error,
      { timeout: IMPORT_TIMEOUT, interval: 250 });
    const seconds = Math.round((Date.now() - since) / 100) / 10;
    if (!ended) {
      throw new Error(`${basename(path)} did not finish importing within ${IMPORT_TIMEOUT / 60_000} minutes: ${(await row()).text}`);
    }
    await settings.waitForSelector("#import-file:not([disabled])", { timeout: 120_000 });
    const titles = await added();
    if (titles.length !== 1) throw new Error(`${basename(path)} was not imported into ${profileId}: ${(await row()).text}`);
    const status = await installation.ready();
    const failure = status.failedDictionaries?.find(entry => entry.title === titles[0]);
    if (failure) throw new Error(`${titles[0]} was imported but did not load: ${failure.error}`);
    return { title: titles[0], seconds, status: (await row()).text };
  };

  if (summary.profile.ok) {
    await step(summary.dictionary, async () => {
      const { title, seconds, status } = await importInto(CODE, dictionaryCopy);
      Object.assign(summary.dictionary, { title, seconds, status, ok: true });
      await importInto(OTHER.code, otherArchive);
      await openLanguages();
      await screenshot(settings, "languages", "#settings-language-dialog");
      await closeLanguages();
    });
  }
  report(summary.dictionary, summary.dictionary.ok ? `${summary.dictionary.title} in ${summary.dictionary.seconds} s` : "");

  if (summary.dictionary.ok) {
    // Lookups on hover, and a Template that adds Basic notes from the
    // pack's profile; the AnkiConnect address is every language's.
    await writeOptions({ options: { lookupMode: "hover" } });
    const templates = await settings.evaluate(url => {
      const field = value => ({ value, overwriteMode: "coalesce" });
      return globalThis.HDReaderOptions.normaliseAnki({ url, apiKey: "", templates: [{
        ...globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE, id: "language-pack", name: "Language pack", model: "Basic",
        deck: "Default", captureScreenshot: false,
        fieldTemplates: { Front: field("{expression}"), Back: field("{glossary}"), Sentence: field("{sentence}") } }] });
    }, `http://127.0.0.1:${anki.address().port}`);
    await writeOptions({ profileId: CODE, options: { anki: templates } });

    // A click inside the toolbar page, which stays a background tab while
    // the reading page has the pointer (as test/chrome-languages.mjs does).
    const toolbar = await installation.page("toolbar.html");
    const activate = async id => {
      await toolbar.waitForSelector(`#language-switcher [data-profile-id="${id}"]`, { timeout: 15_000 });
      await toolbar.evaluate(wanted => document.querySelector(`#language-switcher [data-profile-id="${wanted}"]`).click(), id);
      const active = await until(async () => ((await storage(["languageSelection"])).languageSelection?.activeProfileId ?? "ja") === id
        && await toolbar.$eval(`#language-switcher [data-profile-id="${id}"]`, button => button.getAttribute("aria-checked") === "true"));
      if (!active) throw new Error(`the toolbar did not make ${id} the active language`);
    };

    const reading = await browser.newPage();
    reading.on("pageerror", error => errors.push(`[page] ${error.message}`));
    await reading.setViewport({ width: 1280, height: 720 });
    const popup = await popupReader(reading);
    // Hovers the case on its page and reads the popup's first result.
    const lookUp = async (path, pack, testCase) => {
      await reading.bringToFront();
      await reading.goto(`${origin}${path}`, { waitUntil: "load" });
      const target = hoverTarget(pack, testCase);
      const point = await reading.evaluate(({ start, end }) => {
        const range = document.createRange();
        range.setStart(document.getElementById("sample").firstChild, start);
        range.setEnd(document.getElementById("sample").firstChild, end);
        const box = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0) ?? range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }, target);
      const found = { headword: null, matched: null, trace: [], gloss: null, ok: false };
      const state = await hoverForPopup(reading, popup, "#sample", { point, attempts: 20 });
      if (state === null) {
        const text = testCase.sentence.slice(testCase.sentence.indexOf(testCase.word));
        const reply = await message({ target: "hoshidicts-offscreen", type: "hd_lookup", text, maxResults: 4, scanLength: 64,
          options: {}, profileId: pack.code });
        const first = reply?.results?.[0];
        let engine = `the engine finds nothing for ${JSON.stringify(text)}`;
        if (!Array.isArray(reply?.results)) engine = `the engine's lookup failed: ${reply?.error ?? JSON.stringify(reply)}`;
        else if (first) engine = `the engine finds ${JSON.stringify(first.term?.expression)} (matched ${JSON.stringify(first.matched)})`;
        return { ...found, error: `no popup after hovering ${JSON.stringify(target.text)} of ${JSON.stringify(testCase.word)}; ${engine}` };
      }
      if (state.failure) return { ...found, error: `the popup says ${state.failure.title} ${state.failure.detail}`.trim() };
      const result = await until(() => firstResult(reading), { timeout: 10_000 });
      if (result === null) return { ...found, error: `the popup shows no result: ${state.plain.slice(0, 200)}` };
      const highlighted = await reading.evaluate(name => [...(CSS.highlights.get(name) ?? [])].map(range => range.toString())
        .join(""), HIGHLIGHT_NAME);
      const [headword] = result.headwords;
      const record = { headword, matched: highlighted || result.matched || headword, trace: result.trace, gloss: result.gloss,
        ok: nfc(headword) === nfc(testCase.expected) };
      if (!record.ok) {
        const later = result.headwords.findIndex(other => nfc(other) === nfc(testCase.expected));
        const others = [...new Set(result.headwords)].filter(other => other !== headword).slice(0, 5);
        record.error = `the first result is ${JSON.stringify(headword)}, not ${JSON.stringify(testCase.expected)}`;
        if (later > 0) record.error += `, which is result ${later + 1}`;
        else record.error += others.length > 0 ? `; the other results include ${others.map(other => JSON.stringify(other)).join(", ")}`
          : "; there is no other result";
      }
      return record;
    };
    const describe = part => `${part.word} → ${part.headword ?? "nothing"}`
      + (part.ok ? ` (matched ${JSON.stringify(part.matched)}${part.trace.length > 0 ? `, ${part.trace.join(", ")}` : ""})` : "");

    // 3. The cases, in the pack's profile, made active from the toolbar.
    let activeError = null;
    await activate(CODE).catch(error => { activeError = error.message; });
    await screenshot(toolbar, "toolbar", "main");
    for (const [index, part] of summary.cases.entries()) {
      if (activeError !== null) part.error = activeError;
      else {
        await step(part, async () => {
          Object.assign(part, await lookUp(`/case/${index}`, PACK, part));
          if (index === 0) await screenshot(reading, "lookup");
        });
      }
      report(part, describe(part));
    }

    // 4. The first case's result, mined through the popup's Anki button.
    await step(summary.anki, async () => {
      const first = await lookUp("/case/0", PACK, CASES[0]);
      if (first.headword === null) throw new Error(first.error);
      const ready = await until(async () => (await popup.anki())?.controls[0]?.state === "ready", { timeout: 30_000 });
      if (!ready) throw new Error(`the Anki button never became ready: ${JSON.stringify((await popup.anki())?.controls[0])}`);
      await popup.click(".gsm-hoshidicts-mine-button");
      const added = await until(async () => notes.length > 0 && (await popup.anki())?.controls[0]?.state === "success",
        { timeout: 30_000 });
      const value = notes[0]?.fields?.[FIELDS[0]] ?? null;
      Object.assign(summary.anki, { field: FIELDS[0], value, notes: notes.length, ok: Boolean(added) && nfc(value) === nfc(first.headword) });
      if (!summary.anki.ok) {
        throw new Error(`the note's ${FIELDS[0]} is ${JSON.stringify(value)}, not ${JSON.stringify(first.headword)}`
          + ` (${notes.length} notes, button ${JSON.stringify((await popup.anki())?.controls[0]?.state)}`
          + `${ankiFaults.length > 0 ? `, unanswered actions ${ankiFaults.join(", ")}` : ""})`);
      }
    });
    report(summary.anki, summary.anki.ok ? summary.anki.value : "");

    // 5. To the other language from the toolbar and back.
    await step(summary.switch, async () => {
      await activate(OTHER.code);
      const there = await lookUp("/switch", OTHER.pack, OTHER.case);
      summary.switch.lookup = { ...OTHER.case, headword: there.headword, ok: there.ok };
      await activate(CODE);
      const back = await lookUp("/case/0", PACK, CASES[0]);
      summary.switch.back = { word: CASES[0].word, expected: CASES[0].expected, headword: back.headword, ok: back.ok };
      summary.switch.ok = there.ok && back.ok;
      if (!summary.switch.ok) throw new Error([there.error && `in ${OTHER.code}: ${there.error}`, back.error && `back in ${CODE}: ${back.error}`]
        .filter(Boolean).join("; "));
    });
    report(summary.switch, summary.switch.ok
      ? `${OTHER.case.word} → ${summary.switch.lookup.headword}, then ${CASES[0].word} → ${summary.switch.back.headword}` : "");
  }
} catch (error) {
  summary.error = error?.stack ?? String(error);
  console.log(`FAIL  the check finished without throwing\n      ${summary.error}`);
} finally {
  await installation?.browser.close().catch(() => {});
  anki.close();
  pages.close();
  rmSync(scratch, { recursive: true, force: true });
}

// A check a failure before it left out still gets its line.
for (const part of CHECKS.keys()) if (!reported.has(part)) report(part);
summary.passed = [...CHECKS.keys()].filter(part => part.ok).length;
summary.failed = CHECKS.size - summary.passed;
summary.seconds = Math.round((Date.now() - started) / 1000);
if (errors.length > 0) console.log(`page errors:\n  ${errors.join("\n  ")}`);
console.log(JSON.stringify(summary));
process.exitCode = summary.failed === 0 && summary.error === undefined ? 0 : 1;
