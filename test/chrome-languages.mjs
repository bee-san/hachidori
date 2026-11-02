/*
 * Languages in real Chrome (docs/languages.md 18), first part: the first-run
 * language choice; Japanese, English and Arabic profiles created in Settings;
 * one dictionary imported per language; hovers on inflected words on pages
 * with spaces, CJK and right-to-left text; switching from the toolbar, by
 * the shortcut and automatically by `lang`; one profile edited in Settings
 * while another is active; settings hidden per profile; an Arabic note added
 * through a fake AnkiConnect, from a monolingual Arabic and an Arabic-English
 * dictionary, whose fields draw every list number inside the field and every
 * paragraph in its own order in a left-to-right and a right-to-left card
 * template. It saves screenshots of the picker, the switcher, one lookup per
 * script and the two cards under test/tmp/languages/.
 *
 * The extension under test is a copy whose language registry holds the
 * Japanese pack and the English and Arabic fixture packs of
 * test/data/languages/ (the shipped registry holds Japanese alone until
 * hoshidicts ships more packs). Every check is planned, so a check that never
 * runs fails the suite.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { languageFiles } from "../scripts/sync-languages.mjs";
import { ARABIC, ENGLISH, buildLanguageFixtureZip } from "./make-language-fixtures.mjs";
import { buildFixtureZip } from "./make-fixture.mjs";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
import { hoverForPopup, popupReader } from "./chrome-e2e/popup-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOTS = resolve(ROOT, "test/tmp/languages");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || "";
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
const puppeteer = await import(PUPPETEER.startsWith("/") ? `file://${PUPPETEER}` : PUPPETEER);

const PLANNED = [
  "the welcome card offers every pack, Japanese first and selected, outside the actions",
  "choosing English at first run makes English the only profile, with no catalogue download",
  "a single-profile Settings page has the Language menu and no Use for lookups",
  "an import joins the edited profile",
  "Add a language adds Japanese and Arabic, each edited at once and its import joining it",
  "the records hold three profiles, each with its own dictionary",
  "the toolbar lists the languages as radio buttons, the switch reads Lookups and the badge names the language",
  "an English hover in the middle of an inflected word finds its lemma",
  "a Japanese hover finds an inflected word in CJK text",
  "an Arabic hover on a right-to-left page finds the word with its article",
  "the toolbar switches the active language and every frame follows",
  "the Switch to the next language keybind cycles the active language",
  "the browser command reaches the reader and switches the language",
  "automatic switching picks the profile by lang without changing the active one",
  "the popup names a profile in effect that is not the active one",
  "Settings edits English while Japanese is active, and only English changes",
  "pitch accent, the clicked-kanji dictionary and Anki's note-type setup hide for English and show for Japanese",
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

// ------------------------------------------------------------------ set-up

const scratch = mkdtempSync(join(tmpdir(), "hachidori-languages-"));
const EXTENSION = join(scratch, "extension");
const PROFILE = join(scratch, "profile");
const FILES = join(scratch, "files");

// The registry of the extension under test: Japanese from the submodule, and
// the English and Arabic fixture packs, written by sync-languages.mjs's own
// generator.
async function prepareExtension() {
  cpSync(resolve(ROOT, "extension"), EXTENSION, { recursive: true });
  const packs = join(scratch, "hoshidicts");
  mkdirSync(join(packs, "languages"), { recursive: true });
  symlinkSync(resolve(ROOT, "third_party/hoshidicts/tools"), join(packs, "tools"));
  symlinkSync(resolve(ROOT, "third_party/hoshidicts/languages/ja"), join(packs, "languages/ja"));
  for (const code of ["en", "ar"]) symlinkSync(resolve(ROOT, `test/data/languages/${code}`), join(packs, `languages/${code}`));
  const files = await languageFiles({ hoshidicts: packs, commit: "chrome-languages" });
  const output = join(EXTENSION, "vendor/languages");
  rmSync(output, { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(output, path)), { recursive: true });
    writeFileSync(join(output, path), text);
  }
  mkdirSync(FILES, { recursive: true });
  const archives = {
    ja: join(FILES, "hachidori-fixture.zip"),
    en: join(FILES, ENGLISH.file),
    ar: join(FILES, ARABIC.file),
  };
  writeFileSync(archives.ja, buildFixtureZip());
  writeFileSync(archives.en, buildLanguageFixtureZip(ENGLISH));
  writeFileSync(archives.ar, buildLanguageFixtureZip(ARABIC));
  for (const fixture of ANKI_DICTIONARIES) {
    archives[fixture.title] = join(FILES, `${fixture.title}.zip`);
    writeFileSync(archives[fixture.title], buildLanguageFixtureZip(fixture));
  }
  return archives;
}

// The Anki cases' dictionaries for كتاب (docs/languages.md 18): a monolingual
// Arabic entry with a numbered list and a Latin etymology, and an
// Arabic-English entry with an Arabic example and a list of both directions.
// Every paragraph ends with a period, which shows its order on its line.
const sc = content => ({ type: "structured-content", content });
const ANKI_DICTIONARIES = [
  { title: "hachidori-arabic-monolingual", sourceLanguage: "ar", targetLanguage: "ar", terms: [
    ["\u0643\u062A\u0627\u0628", "", "", "n", 0, [sc([
      { tag: "ol", content: [{ tag: "li", content: "صحائف مجموعة مكتوبة." }, { tag: "li", content: "الرسالة المكتوبة إلى شخص." }] },
      { tag: "div", content: "From Aramaic ktāḇā (writing)." }])], 1, ""]] },
  { title: "hachidori-arabic-english-examples", sourceLanguage: "ar", targetLanguage: "en", terms: [
    ["\u0643\u062A\u0627\u0628", "", "", "n", 0, [sc([
      { tag: "div", content: "a book; a written work." },
      { tag: "div", data: { content: "example-sentence" }, content: [
        { tag: "div", content: "قرأتُ الكتابَ كلَّه في ليلةٍ واحدةٍ." }, { tag: "div", content: "I read the whole book in one night." }] },
      { tag: "ul", content: [{ tag: "li", content: "كتب مقدسة." }, { tag: "li", content: "holy books." }] }])], 1, ""]] },
];

// A fake AnkiConnect with one note type, Basic, whose notes the cases read.
const ankiNotes = [];
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
      if (action === "addNote") { ankiNotes.push(params.note); return ankiNotes.length; }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(ankiNotes[noteId - 1].fields).map(([field, value]) => [field, { value }])) }));
      throw new Error(`Unexpected Anki action: ${action}`);
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reply));
  });
  return new Promise(resolveServer => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

const PAGES = {
  "/english.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>English</title></head>
    <body style="font: 32px sans-serif; padding: 40px"><p id="sample">She was running late.</p></body></html>`,
  "/japanese.html": `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Japanese</title></head>
    <body style="font: 32px sans-serif; padding: 40px"><p id="sample">食べたかった</p></body></html>`,
  "/arabic.html": `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Arabic</title></head>
    <body style="font: 32px sans-serif; padding: 40px"><p id="sample">\u0627\u0644\u0643\u062A\u0627\u0628 \u062C\u062F\u064A\u062F.</p></body></html>`,
  "/mixed.html": `<!doctype html><html><head><meta charset="utf-8"><title>Mixed</title></head>
    <body style="font: 32px sans-serif; padding: 40px">
    <p id="japanese" lang="ja">食べたかった</p><p id="english" lang="en-GB">She was running late.</p></body></html>`,
  // Two cards with the styling of Anki's Basic note type: a left-to-right card
  // template and a right-to-left one, {{Front}}<hr id=answer>{{Back}} and the sentence.
  "/cards.html": `<!doctype html><html><head><meta charset="utf-8"><title>Cards</title><style>
    body { margin: 0; display: flex; gap: 40px; padding: 20px; }
    .card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; width: 560px; }
    </style></head><body><div class="card" id="card-ltr"></div><div class="card" id="card-rtl"><div dir="rtl"></div></div></body></html>`,
};

function serve() {
  const server = createServer((request, response) => {
    const page = PAGES[new URL(request.url, "http://localhost").pathname];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(page ?? "not found");
  });
  return new Promise(resolveServer => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

async function screenshot(page, name, clipSelector = null) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  const path = join(SCREENSHOTS, `${name}.png`);
  if (clipSelector === null) {
    await page.screenshot({ path });
    return path;
  }
  // Page coordinates, as Puppeteer's clip expects (AGENTS.md).
  const clip = await page.evaluate(selector => {
    const box = document.querySelector(selector).getBoundingClientRect();
    return { x: box.left + scrollX, y: box.top + scrollY, width: Math.min(1280, box.width), height: Math.min(1280, box.height) };
  }, clipSelector);
  await page.screenshot({ path, clip });
  return path;
}

// A rect at the `index`th character of the first text node of `selector`.
async function characterPoint(page, selector, index) {
  return page.evaluate(({ selector: target, index: at }) => {
    const node = document.querySelector(target).firstChild;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { selector, index });
}

// ---------------------------------------------------------------- the suite

const archives = await prepareExtension();
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const ankiServer = await serveAnki();
const browser = await puppeteer.launch({ executablePath: CHROME, enableExtensions: true, userDataDir: PROFILE, headless: true,
  protocolTimeout: 60_000,
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--disable-gpu",
    "--disable-dev-shm-usage", ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])] });
const errors = [];
let extensionId = "";
let worker = null;

async function extensionPage(path) {
  const page = await browser.newPage();
  page.on("pageerror", error => errors.push(`[${path}] ${error.message}`));
  page.on("console", entry => { if (entry.type() === "error") errors.push(`[${path}] console: ${entry.text()}`); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/${path}`, { waitUntil: "load" });
  return page;
}

// Storage as the worker sees it, and runtime messages from an extension page
// (a worker's own messages do not reach its listeners).
let messenger = null;
const storage = keys => worker.evaluate(wanted => chrome.storage.local.get(wanted), keys);
const message = fields => messenger.evaluate(value => chrome.runtime.sendMessage({
  requestId: `languages-${Date.now()}`, ...value }), fields);
const languagesOf = options => (options?.profiles ?? []).map(profile => profile.language);

try {
  const workerTarget = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().endsWith("/background.js"), { timeout: 30_000 });
  extensionId = new URL(workerTarget.url()).host;
  worker = await workerTarget.worker();

  await step(PLANNED[0], async () => {
    const startupTarget = await browser.waitForTarget(target => target.url().includes("/startup.html"), { timeout: 30_000 });
    const startup = await startupTarget.page();
    await startup.setViewport({ width: 1280, height: 900 });
    await startup.waitForSelector("#setup-language-select", { timeout: 30_000 });
    const menu = await startup.evaluate(() => {
      const select = document.getElementById("setup-language-select");
      return { values: [...select.options].map(option => option.value), selected: select.value,
        afterActions: document.getElementById("setup-actions").nextElementSibling?.id ?? "",
        insideBody: document.getElementById("setup-body").contains(select),
        insideActions: document.getElementById("setup-actions").contains(select) };
    });
    await screenshot(startup, "first-run-picker", "#setup-card");
    check(PLANNED[0], menu.values[0] === "ja" && menu.selected === "ja" && menu.values.includes("en")
      && menu.values.includes("ar") && menu.afterActions === "setup-language" && !menu.insideBody && !menu.insideActions,
    JSON.stringify(menu));
    // In one task, so no render can come between the choice and the click.
    await startup.evaluate(() => {
      const select = document.getElementById("setup-language-select");
      select.value = "en";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("setup-manual").click();
    });
    const settled = await until(async () => {
      const stored = await storage(["options", "setupState", "dictionaryState"]);
      return stored.setupState?.stage === "practice" ? stored : null;
    }, { timeout: 30_000 });
    const stored = settled ?? await storage(["options", "setupState", "dictionaryState"]);
    check(PLANNED[1], JSON.stringify(languagesOf(stored.options)) === JSON.stringify(["en"])
      && (stored.dictionaryState?.dictionaries ?? []).length === 0,
    JSON.stringify({ stage: stored.setupState?.stage, profiles: stored.options?.profiles, state: stored.dictionaryState }));
    await startup.close();
  });

  const settings = await extensionPage("settings.html#add-dictionaries");
  messenger = settings;
  const importInto = async (archive, title) => {
    const input = await settings.$("#import-file");
    await input.uploadFile(archive);
    return until(async () => settings.evaluate(wanted => document.getElementById("import-state").textContent
      .startsWith("Imported") && [...document.querySelectorAll("#import-progress")].some(node => node.textContent.includes(wanted)),
    title), { timeout: 60_000 });
  };
  const editedId = () => settings.evaluate(() => document.getElementById("settings-language-select").value);

  await step(PLANNED[2], async () => {
    await settings.waitForSelector("#settings-language-select", { timeout: 30_000 });
    const menu = await settings.evaluate(() => ({
      options: [...document.getElementById("settings-language-select").options].map(option => option.value),
      use: document.getElementById("settings-language-use").hidden,
      beforeSearch: document.querySelector(".settings-search").previousElementSibling?.id ?? "",
      rail: document.querySelectorAll(".settings-nav a").length,
    }));
    check(PLANNED[2], JSON.stringify(menu.options) === JSON.stringify(["en"]) && menu.use === true
      && menu.beforeSearch === "settings-language" && menu.rail === 9, JSON.stringify(menu));
  });

  await step(PLANNED[3], async () => {
    await importInto(archives.en, ENGLISH.title);
    const stored = await storage(["dictionaryState"]);
    const english = stored.dictionaryState?.dictionaries?.find(row => row.title === ENGLISH.title);
    const listed = stored.dictionaryState?.profiles?.en?.dictionaries?.some(entry => entry.id === english?.id);
    check(PLANNED[3], Boolean(english) && listed, JSON.stringify(stored.dictionaryState));
  });

  await step(PLANNED[4], async () => {
    const add = async (code, name) => {
      await settings.click("#settings-language-manage");
      await settings.waitForSelector(`[aria-label="Add ${name}"]`, { timeout: 10_000 });
      await settings.click(`[aria-label="Add ${name}"]`);
      await until(async () => (await editedId()) === code, { timeout: 60_000 });
      await settings.keyboard.press("Escape");
      await settings.evaluate(() => { location.hash = "#add-dictionaries"; });
    };
    await add("ja", "Japanese");
    const japaneseEdited = await editedId();
    await importInto(archives.ja, "hachidori-fixture");
    await add("ar", "Arabic");
    const arabicEdited = await editedId();
    await importInto(archives.ar, ARABIC.title);
    const stored = await storage(["options", "dictionaryState"]);
    check(PLANNED[4], japaneseEdited === "ja" && arabicEdited === "ar"
      && stored.dictionaryState?.profiles?.ar?.dictionaries?.length === 1
      && stored.dictionaryState?.profiles?.ja?.dictionaries?.length >= 1,
    JSON.stringify({ japaneseEdited, arabicEdited, profiles: stored.dictionaryState?.profiles }));
    const titleOf = id => stored.dictionaryState.dictionaries.find(row => row.id === id)?.title;
    const own = code => (stored.dictionaryState.profiles[code]?.dictionaries ?? []).map(entry => titleOf(entry.id));
    check(PLANNED[5], JSON.stringify(languagesOf(stored.options)) === JSON.stringify(["en", "ja", "ar"])
      && own("en").includes(ENGLISH.title) && own("ar").includes(ARABIC.title)
      && own("ja").some(title => title?.startsWith("hachidori-fixture") || title === "Hachidori fixture")
      && !own("en").includes(ARABIC.title),
    JSON.stringify({ en: own("en"), ja: own("ja"), ar: own("ar") }));
  });

  // Lookups without a key, so a hover alone opens the popup.
  await message({ target: "hoshidicts-worker", type: "hd_options_write",
    baseRevision: (await storage(["options"])).options.revision, options: { lookupMode: "hover" } });

  const toolbar = await extensionPage("toolbar.html");
  // A click inside the toolbar page: it stays a background tab while the
  // reading page has the pointer, and Puppeteer's own click waits for frames
  // a background tab does not draw.
  const chooseInToolbar = async id => {
    await toolbar.waitForSelector(`#language-switcher [data-profile-id="${id}"]`, { timeout: 10_000 });
    await toolbar.evaluate(wanted => document.querySelector(`#language-switcher [data-profile-id="${wanted}"]`).click(), id);
    return until(async () => (await storage(["languageSelection"])).languageSelection?.activeProfileId === id);
  };

  await step(PLANNED[6], async () => {
    await toolbar.waitForSelector("#language-switcher", { timeout: 10_000 });
    const state = await toolbar.evaluate(() => ({
      role: document.getElementById("language-switcher").getAttribute("role"),
      choices: [...document.querySelectorAll("#language-switcher [role=radio]")].map(button =>
        [button.dataset.profileId, button.getAttribute("aria-checked")]),
      label: document.getElementById("lookup-toggle").getAttribute("aria-label"),
      hint: document.getElementById("activation-hint").textContent,
      above: document.getElementById("language-switcher").nextElementSibling?.id ?? "",
    }));
    const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
    await screenshot(toolbar, "toolbar-switcher", "main");
    check(PLANNED[6], state.role === "radiogroup" && state.choices.length === 3
      && state.choices.find(([id]) => id === "en")?.[1] === "true" && state.label === "Lookups"
      && state.hint === "Hover over English text to scan" && state.above === "lookup-toggle" && badge === "EN",
    JSON.stringify({ state, badge }));
  });

  const reading = await browser.newPage();
  reading.on("pageerror", error => errors.push(`[page] ${error.message}`));
  reading.on("console", entry => { if (["error", "warn"].includes(entry.type())) errors.push(`[page] console: ${entry.text()}`); });
  await reading.setViewport({ width: 1280, height: 720 });
  const popup = await popupReader(reading);
  const hoverAt = async (path, selector, index, accept) => {
    await reading.bringToFront();
    if (!reading.url().endsWith(path)) await reading.goto(`${origin}${path}`, { waitUntil: "load" });
    const point = await characterPoint(reading, selector, index);
    return hoverForPopup(reading, popup, selector, { point, accept, attempts: 20 });
  };

  await step(PLANNED[7], async () => {
    // The second n of "running".
    const state = await hoverAt("/english.html", "#sample", 10, current => current.plain.includes("to move swiftly on foot"));
    if (state) await screenshot(reading, "lookup-english");
    check(PLANNED[7], state?.plain.includes("run") && state.plain.includes("to move swiftly on foot"), JSON.stringify(state?.plain));
  });

  await step(PLANNED[8], async () => {
    await chooseInToolbar("ja");
    const state = await hoverAt("/japanese.html", "#sample", 0, current => current.plain.includes("食べる"));
    if (state) await screenshot(reading, "lookup-japanese");
    check(PLANNED[8], state?.plain.includes("食べる"), JSON.stringify(state?.plain));
  });

  await step(PLANNED[9], async () => {
    await chooseInToolbar("ar");
    // The fourth letter of الكتاب, on a right-to-left page.
    const state = await hoverAt("/arabic.html", "#sample", 3, current => current.plain.includes("book"));
    if (state) await screenshot(reading, "lookup-arabic");
    check(PLANNED[9], state?.plain.includes("\u0643\u062A\u0627\u0628") && state.plain.includes("book"), JSON.stringify(state?.plain));
  });

  await step(PLANNED[10], async () => {
    await chooseInToolbar("en");
    const state = await hoverAt("/english.html", "#sample", 10, current => current.plain.includes("to move swiftly on foot"));
    const hint = await toolbar.evaluate(() => document.getElementById("activation-hint").textContent);
    const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
    check(PLANNED[10], Boolean(state) && hint === "Hover over English text to scan" && badge === "EN",
      JSON.stringify({ plain: state?.plain, hint, badge }));
  });

  await step(PLANNED[11], async () => {
    const stored = await storage(["options"]);
    const current = await messenger.evaluate(value => globalThis.HDReaderOptions.normaliseOptions(value).keybinds, stored.options);
    const keybinds = [...current, { action: "switchLanguage", argument: "", key: "KeyL",
      modifiers: ["alt", "shift"], scopes: ["web"], enabled: true }];
    await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision,
      options: { keybinds } });
    await until(async () => (await storage(["options"])).options.keybinds.some(bind => bind.action === "switchLanguage"));
    await reading.goto(`${origin}/english.html`, { waitUntil: "load" });
    await wait(500);
    const before = (await storage(["languageSelection"])).languageSelection?.activeProfileId;
    await reading.keyboard.down("Alt");
    await reading.keyboard.down("Shift");
    await reading.keyboard.press("KeyL");
    await reading.keyboard.up("Shift");
    await reading.keyboard.up("Alt");
    const after = await until(async () => {
      const id = (await storage(["languageSelection"])).languageSelection?.activeProfileId;
      return id !== before ? id : null;
    });
    check(PLANNED[11], before === "en" && after === "ja", JSON.stringify({ before, after }));
  });

  await step(PLANNED[12], async () => {
    const before = (await storage(["languageSelection"])).languageSelection?.activeProfileId;
    // What the worker sends the active tab's readers for the browser command.
    await worker.evaluate(async url => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.sendMessage(tab.id, { target: "hachidori-reader", type: "hd_reader_command", action: "switchLanguage" });
    }, `${origin}/english.html`);
    const after = await until(async () => {
      const id = (await storage(["languageSelection"])).languageSelection?.activeProfileId;
      return id !== before ? id : null;
    });
    const commands = await worker.evaluate(() => chrome.commands.getAll());
    const command = commands.find(entry => entry.name === "switchLanguage");
    check(PLANNED[12], before === "ja" && after === "ar" && command?.shortcut === ""
      && command.description === "Switch to the next language", JSON.stringify({ before, after, command }));
  });

  await step(PLANNED[13], async () => {
    await chooseInToolbar("ja");
    const selection = (await storage(["languageSelection"])).languageSelection;
    await message({ target: "hoshidicts-worker", type: "hd_language_selection_write", baseRevision: selection.revision,
      autoSwitch: true });
    await until(async () => (await storage(["languageSelection"])).languageSelection?.autoSwitch === true);
    const english = await hoverAt("/mixed.html", "#english", 10, current => current.plain.includes("to move swiftly on foot"));
    const active = (await storage(["languageSelection"])).languageSelection?.activeProfileId;
    const japanese = await hoverAt("/mixed.html", "#japanese", 0, current => current.plain.includes("食べる"));
    check(PLANNED[13], Boolean(english) && Boolean(japanese) && active === "ja",
      JSON.stringify({ english: english?.plain, japanese: japanese?.plain, active }));
    // The English popup's label: the profile in effect is not the active one;
    // the Japanese popup, in the active profile, has none.
    check(PLANNED[14], english?.plain.includes("English") && !japanese?.plain.includes("English"),
      JSON.stringify({ english: english?.plain, japanese: japanese?.plain }));
    await message({ target: "hoshidicts-worker", type: "hd_language_selection_write",
      baseRevision: (await storage(["languageSelection"])).languageSelection.revision, autoSwitch: false });
  });

  await step(PLANNED[15], async () => {
    await settings.evaluate(() => { location.hash = "#lookup"; });
    await settings.reload({ waitUntil: "load" });
    await settings.waitForSelector("#settings-language-select", { timeout: 30_000 });
    const startedOn = await editedId();
    await settings.select("#settings-language-select", "en");
    await until(async () => (await settings.evaluate(() => document.getElementById("opt-scan-length").value)) !== "", {});
    const before = await storage(["options", "languageSelection"]);
    await settings.evaluate(() => {
      const input = document.getElementById("opt-scan-length");
      input.value = "21";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const after = await until(async () => {
      const stored = await storage(["options", "languageSelection"]);
      return stored.options.profiles.find(profile => profile.id === "en")?.settings.scanLength === 21 ? stored : null;
    });
    const scan = (stored, id) => stored?.options.profiles.find(profile => profile.id === id)?.settings.scanLength;
    check(PLANNED[15], startedOn === "ja" && Boolean(after) && scan(after, "ja") === scan(before, "ja")
      && after.languageSelection.activeProfileId === "ja",
    JSON.stringify({ startedOn, ja: [scan(before, "ja"), scan(after, "ja")], en: scan(after, "en"),
      active: after?.languageSelection.activeProfileId }));
  });

  await step(PLANNED[16], async () => {
    const hidden = async () => settings.evaluate(() => ({
      pitch: document.querySelector('[data-design-setting="showPitchAccentBadge"]').hidden,
      kanji: document.querySelector('[data-design-setting="kanjiClickDictionary"]').hidden,
      anki: document.querySelector('.anki-setup-row').hidden,
      japaneseOnly: document.getElementById("opt-japanese-only").closest("label").textContent.trim(),
    }));
    await settings.evaluate(() => { location.hash = "#design"; });
    await wait(300);
    const english = await until(async () => {
      const value = await hidden();
      return value.pitch && value.kanji ? value : null;
    }) ?? await hidden();
    await screenshot(settings, "settings-english-design");
    await settings.select("#settings-language-select", "ja");
    const japanese = await until(async () => {
      const value = await hidden();
      return !value.pitch ? value : null;
    }) ?? await hidden();
    check(PLANNED[16], english.pitch && english.kanji && english.anki && english.japaneseOnly === "English text only"
      && !japanese.pitch && !japanese.kanji && !japanese.anki && japanese.japaneseOnly === "Japanese text only",
    JSON.stringify({ english, japanese }));
  });
  await step(PLANNED[17], async () => {
    // Both dictionaries join the Arabic profile, beside its first one.
    await settings.select("#settings-language-select", "ar");
    await until(async () => (await editedId()) === "ar");
    await settings.evaluate(() => { location.hash = "#add-dictionaries"; });
    for (const fixture of ANKI_DICTIONARIES) await importInto(archives[fixture.title], fixture.title);
    // The Arabic profile's first Template adds Basic notes; the connection is every language's.
    const stored = await storage(["options"]);
    const anki = await messenger.evaluate(url => {
      const template = value => ({ value, overwriteMode: "coalesce" });
      return globalThis.HDReaderOptions.normaliseAnki({ url, apiKey: "", templates: [{
        ...globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE, id: "arabic-words", name: "Arabic words", model: "Basic",
        deck: "Default", captureScreenshot: false,
        fieldTemplates: { Front: template("{expression}"), Back: template("{glossary}"), Sentence: template("{sentence}") } }] });
    }, `http://127.0.0.1:${ankiServer.address().port}`);
    const written = await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision,
      profileId: "ar", options: { anki } });
    if (!written.ok) throw new Error(written.error);
    await chooseInToolbar("ar");
    const state = await hoverAt("/arabic.html", "#sample", 3, current => current.plain.includes("a written work"));
    const ready = await until(async () => (await popup.anki())?.controls[0]?.state === "ready", { timeout: 30_000 });
    if (!ready) throw new Error(`the Anki button never became ready: ${JSON.stringify(await popup.anki())}`);
    await popup.click(".gsm-hoshidicts-mine-button");
    const added = await until(async () => (await popup.anki())?.controls[0]?.state === "success" && ankiNotes.length === 1,
      { timeout: 30_000 });
    const fields = ankiNotes[0]?.fields ?? {};
    const shape = await reading.evaluate(html => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const root = holder.querySelector(".yomitan-glossary");
      return { dir: root?.getAttribute("dir"), align: root?.style.textAlign, padding: root?.querySelector(":scope > ol")?.style.paddingInline,
        items: [...(root?.querySelectorAll(":scope > ol > li") ?? [])].map(item => [item.dataset.dictionary, item.getAttribute("dir")]),
        footer: root?.querySelector(".yomitan-glossary-details")?.getAttribute("dir") };
    }, fields.Back ?? "");
    check(PLANNED[17], Boolean(state) && added && fields.Front === "\u0643\u062A\u0627\u0628" && shape.dir === "rtl"
      && shape.align === "start" && shape.padding === "40px" && shape.footer === "ltr"
      && JSON.stringify(shape.items) === JSON.stringify([[ARABIC.title, "ltr"], ["hachidori-arabic-monolingual", "rtl"],
        ["hachidori-arabic-english-examples", "ltr"]])
      && /^<span dir="auto">.*<b>.+<\/b>.*<\/span>$/u.test(fields.Sentence ?? ""),
    JSON.stringify({ popup: state?.plain, added, shape, fields }));
  });

  // Every list number inside the field (each ::marker box inside its card) and
  // every paragraph in its own order (its final period at the end its own
  // letters read from), for one card.
  const measureCard = async (cdp, id) => {
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
    return reading.evaluate((cardId, markerBoxes) => {
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
  };

  await step(PLANNED[18], async () => {
    const fields = ankiNotes[0]?.fields;
    if (!fields) throw new Error("no Arabic note was added");
    await reading.setViewport({ width: 1280, height: 1100 });
    await reading.bringToFront();
    await reading.goto(`${origin}/cards.html`, { waitUntil: "load" });
    await reading.evaluate(note => {
      const card = `${note.Front}<hr id=answer>${note.Back}<div>${note.Sentence}</div>`;
      document.getElementById("card-ltr").innerHTML = card;
      document.querySelector("#card-rtl > div").innerHTML = card;
      // Lay the cards out, which creates the ::marker boxes DOM.getDocument reports.
      document.body.getBoundingClientRect();
    }, fields);
    const cdp = await reading.createCDPSession();
    await cdp.send("DOM.enable");
    const ltr = await measureCard(cdp, "card-ltr");
    const rtl = await measureCard(cdp, "card-rtl");
    await screenshot(reading, "anki-note-ltr-card", "#card-ltr");
    await screenshot(reading, "anki-note-rtl-card", "#card-rtl");
    // Seven numbers and bullets, nine paragraphs: none may be missed.
    const passes = card => card.markers === 7 && card.outside.length === 0 && card.paragraphs.length === 9 && card.wrong.length === 0;
    check(PLANNED[18], passes(ltr), JSON.stringify(ltr));
    check(PLANNED[19], passes(rtl), JSON.stringify(rtl));
  });
} finally {
  await browser.close().catch(() => {});
  server.close();
  ankiServer.close();
  rmSync(scratch, { recursive: true, force: true });
}

const failed = PLANNED.filter(name => results.get(name)?.ok !== true);
for (const name of PLANNED.filter(planned => !results.has(planned))) console.log(`FAIL  ${name}\n      check never ran`);
if (errors.length > 0) console.log(`page errors:\n  ${errors.join("\n  ")}`);
console.log(`\n${PLANNED.length - failed.length}/${PLANNED.length} checks passed; screenshots in ${SCREENSHOTS}`);
process.exitCode = failed.length === 0 ? 0 : 1;
