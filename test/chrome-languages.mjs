/*
 * Languages in real Chrome (docs/languages.md 18), first part: a first run
 * that stays Japanese in a build with other packs; English and Arabic added
 * in Settings → Advanced → Languages; one dictionary imported per language;
 * Settings shows and Use for lookups; hovers on inflected words on pages with
 * spaces, CJK and right-to-left text, one of them opened before English was
 * added; switching from the toolbar, by the
 * shortcut and automatically by `lang`; one profile edited in Settings while
 * another is active; settings hidden per profile. It saves screenshots of the
 * welcome card, Advanced → Languages, the switcher and one lookup per script
 * under test/tmp/languages/.
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
import { hoverForPopup, popupReader } from "./chrome-e2e/popup-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOTS = resolve(ROOT, "test/tmp/languages");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || "";
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
const puppeteer = await import(PUPPETEER.startsWith("/") ? `file://${PUPPETEER}` : PUPPETEER);

const PLANNED = [
  "the welcome card has no language menu in a build with other packs",
  "Set up manually keeps the records Japanese-only, with no catalogue download",
  "a single-profile Settings page has main's sidebar and Advanced, and Multiple languages reveals Advanced → Languages listing its language",
  "an import joins the edited profile, its row carrying the archive's targetLanguage",
  "Advanced → Languages adds English and Arabic, each edited at once and its import joining it",
  "the records hold three profiles, each with its own dictionary",
  "Settings shows chooses English without moving lookups, and Use for lookups moves them",
  "the toolbar lists the languages as radio buttons, the switch reads Lookups and the badge names the language",
  "an English hover in the middle of an inflected word finds its lemma",
  "a Japanese hover finds an inflected word in CJK text",
  "an Arabic hover on a right-to-left page finds the word with its article",
  "the toolbar switches the active language and every frame follows",
  "the Switch to the next language keybind cycles the active language",
  "the browser command reaches the reader and switches the language",
  "automatic switching, turned on in Advanced → Languages, picks the profile by lang without changing the active one",
  "the popup names a profile in effect that is not the active one",
  "Settings edits English while Japanese is active, and only English changes",
  "pitch accent, the clicked-kanji dictionary and Anki's note-type setup hide for English and show for Japanese",
  "the Arabic-English dictionary's block takes its targetLanguage as its default lang",
  "a popup that automatic switching gives English shows English's display name, custom buttons, theme and target language",
  "the search page and its frame take the active profile's palette and follow a switch",
  "Multiple languages off returns lookups, the toolbar and the badge to Japanese, and on again brings English back",
  "a page opened while the records had no profiles looks English up once English is added, without a reload",
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
  return archives;
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
    await startup.waitForSelector("#setup-manual", { timeout: 30_000 });
    const card = await startup.evaluate(() => ({
      packs: globalThis.HDLanguages?.codes ?? [],
      selects: document.querySelectorAll("#setup-card select").length,
      actions: [...document.querySelectorAll("#setup-actions button")].map(button => button.id),
      text: document.getElementById("setup-card").textContent,
    }));
    await screenshot(startup, "first-run-welcome", "#setup-card");
    check(PLANNED[0], card.packs.includes("en") && card.packs.includes("ar") && card.selects === 0
      && JSON.stringify(card.actions) === JSON.stringify(["setup-start", "setup-manual"]) && !card.text.includes("I'm learning"),
    JSON.stringify(card));
    await startup.click("#setup-manual");
    const settled = await until(async () => {
      const stored = await storage(["options", "setupState", "dictionaryState"]);
      return stored.setupState?.stage === "practice" ? stored : null;
    }, { timeout: 30_000 });
    const stored = settled ?? await storage(["options", "setupState", "dictionaryState"]);
    check(PLANNED[1], stored.setupState?.stage === "practice" && !Object.hasOwn(stored.options ?? {}, "profiles")
      && (stored.dictionaryState?.dictionaries ?? []).length === 0,
    JSON.stringify({ stage: stored.setupState?.stage, options: stored.options, state: stored.dictionaryState }));
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
  // The profile Settings shows: Advanced → Languages' menu, which a page with
  // one language does not have.
  const editedId = () => settings.evaluate(() => document.getElementById("settings-language-select")?.value ?? "ja");
  const showSection = async section => {
    await settings.evaluate(id => { location.hash = `#${id}`; }, section);
    await settings.waitForFunction(id => document.getElementById(id)?.hidden === false, { timeout: 10_000 }, section);
  };

  // Advanced → Experimental features → Multiple languages, clicked in the page.
  const multipleLanguages = async enabled => {
    await showSection("advanced");
    await settings.waitForSelector("#opt-experimental-multipleLanguages", { timeout: 30_000 });
    await settings.evaluate(wanted => {
      const input = document.getElementById("opt-experimental-multipleLanguages");
      if (input.checked !== wanted) input.click();
    }, enabled);
    return until(async () => (await storage(["options"])).options?.experimental?.multipleLanguages === enabled);
  };

  await step(PLANNED[2], async () => {
    await settings.waitForSelector("#language-settings", { timeout: 30_000 });
    // Off, Advanced has no Languages tab, only User scripts, and #languages
    // leads to Advanced.
    await settings.evaluate(() => { location.hash = "#languages"; });
    await settings.waitForFunction(() => document.getElementById("advanced").hidden === false, { timeout: 10_000 });
    const off = await settings.evaluate(() => ({
      tabs: [...document.querySelectorAll("#advanced-navigation a:not([hidden])")].map(link => link.textContent),
      tab: document.querySelector('#advanced-navigation a[href="#languages"]').hidden,
      languages: document.getElementById("languages").hidden,
    }));
    if (!await multipleLanguages(true)) throw new Error("Multiple languages did not turn on");
    await settings.waitForFunction(() => document.getElementById("advanced-navigation").hidden === false, { timeout: 10_000 });
    await showSection("languages");
    const page = await settings.evaluate(async () => {
      // The sidebar as settings.html writes it.
      const markup = new DOMParser().parseFromString(await (await fetch(location.href)).text(), "text/html");
      const children = root => [...root.querySelector(".settings-sidebar").children].map(node => `${node.localName}#${node.id}.${node.className}`);
      const card = document.getElementById("language-settings");
      return {
        sidebar: children(document), markup: children(markup),
        rail: document.querySelectorAll(".settings-nav a").length,
        outside: [...document.querySelectorAll("#settings-language-select, #language-auto-switch, [data-scope-note], [data-language-settings]")]
          .map(node => node.id || node.className),
        section: card.closest("section").id, first: card === document.querySelector("#languages fieldset"),
        legend: card.querySelector("legend").textContent,
        languages: [...card.querySelectorAll("#settings-language-profiles [data-profile-id]")].map(row => row.dataset.profileId),
        removable: card.querySelectorAll("#settings-language-profiles button").length,
        offered: [...document.getElementById("settings-language-add-select").options].map(option => option.value),
      };
    });
    check(PLANNED[2], off.tabs.join() === "Advanced,User scripts" && off.tab && off.languages
      && JSON.stringify(page.sidebar) === JSON.stringify(page.markup) && page.rail === 9 && page.outside.length === 0
      && page.section === "languages" && page.first && page.legend === "Your languages" && page.languages.join() === "ja"
      && page.removable === 0 && page.offered.includes("en") && page.offered.includes("ar"), JSON.stringify({ off, page }));
  });

  // Open while the records are Japanese-only, so its frame has no language
  // layer until English is added (docs/languages.md 5).
  const early = await browser.newPage();
  early.on("pageerror", error => errors.push(`[early page] ${error.message}`));
  early.on("console", entry => { if (["error", "warn"].includes(entry.type())) errors.push(`[early page] console: ${entry.text()}`); });
  await early.setViewport({ width: 1280, height: 720 });
  await early.goto(`${origin}/english.html`, { waitUntil: "load" });
  // Puppeteer's clicks in Settings wait for frames, which a background tab does not draw.
  await settings.bringToFront();

  await step(PLANNED[4], async () => {
    await importInto(archives.ja, "hachidori-fixture");
    // Add a language in Advanced → Languages, then import into the language
    // Settings now shows.
    const add = async code => {
      await showSection("languages");
      await settings.select("#settings-language-add-select", code);
      await settings.click("#settings-language-add-row button");
      await until(async () => (await editedId()) === code, { timeout: 60_000 });
      const status = await settings.evaluate(() => document.getElementById("settings-language-status").textContent);
      await showSection("add-dictionaries");
      return status;
    };
    const englishStatus = await add("en");
    const englishEdited = await editedId();
    await importInto(archives.en, ENGLISH.title);
    let stored = await storage(["dictionaryState"]);
    const english = stored.dictionaryState?.dictionaries?.find(row => row.title === ENGLISH.title);
    const listed = stored.dictionaryState?.profiles?.en?.dictionaries?.some(entry => entry.id === english?.id);
    check(PLANNED[3], Boolean(english) && listed && english.targetLanguage === "en", JSON.stringify(stored.dictionaryState));
    await add("ar");
    const arabicEdited = await editedId();
    await importInto(archives.ar, ARABIC.title);
    stored = await storage(["options", "dictionaryState"]);
    check(PLANNED[4], englishEdited === "en" && arabicEdited === "ar" && englishStatus === "Added English. Settings now shows English."
      && stored.dictionaryState?.profiles?.en?.dictionaries?.length === 1
      && stored.dictionaryState?.profiles?.ar?.dictionaries?.length === 1,
    JSON.stringify({ englishEdited, arabicEdited, englishStatus, profiles: stored.dictionaryState?.profiles }));
    const titleOf = id => stored.dictionaryState.dictionaries.find(row => row.id === id)?.title;
    const own = code => (stored.dictionaryState.profiles[code]?.dictionaries ?? []).map(entry => titleOf(entry.id));
    check(PLANNED[5], JSON.stringify(languagesOf(stored.options)) === JSON.stringify(["ja", "en", "ar"])
      && own("en").includes(ENGLISH.title) && own("ar").includes(ARABIC.title)
      && own("ja").some(title => title?.startsWith("hachidori-fixture") || title === "Hachidori fixture")
      && !own("en").includes(ARABIC.title),
    JSON.stringify({ en: own("en"), ja: own("ja"), ar: own("ar") }));
  });

  await step(PLANNED[6], async () => {
    await showSection("languages");
    await settings.select("#settings-language-select", "en");
    await until(async () => (await editedId()) === "en");
    const read = () => settings.evaluate(() => ({
      edited: document.getElementById("settings-language-select").value,
      use: document.getElementById("settings-language-use").textContent,
      pressed: document.getElementById("settings-language-use").getAttribute("aria-pressed"),
      link: document.getElementById("settings-language-link")?.textContent ?? null,
      focused: document.activeElement?.id ?? "",
    }));
    const before = { ...(await read()), active: (await storage(["languageSelection"])).languageSelection?.activeProfileId ?? "ja" };
    await screenshot(settings, "settings-advanced-languages", "#language-settings");
    await settings.focus("#settings-language-use");
    await settings.keyboard.press("Enter");
    const active = await until(async () => (await storage(["languageSelection"])).languageSelection?.activeProfileId === "en");
    const after = await until(async () => {
      const value = await read();
      return value.pressed === "true" ? value : null;
    }) ?? await read();
    check(PLANNED[6], before.active === "ja" && before.use === "Use for lookups" && before.pressed === "false"
      && before.link === "Settings shows English" && active && after.use === "Used for lookups"
      && after.focused === "settings-language-use", JSON.stringify({ before, after }));
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

  await step(PLANNED[7], async () => {
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
    check(PLANNED[7], state.role === "radiogroup" && state.choices.length === 3
      && state.choices.find(([id]) => id === "en")?.[1] === "true" && state.label === "Lookups"
      && state.hint === "Hover over English text to scan" && state.above === "lookup-toggle" && badge === "EN",
    JSON.stringify({ state, badge }));
  });

  const reading = await browser.newPage();
  reading.on("pageerror", error => errors.push(`[page] ${error.message}`));
  reading.on("console", entry => { if (["error", "warn"].includes(entry.type())) errors.push(`[page] console: ${entry.text()}`); });
  await reading.setViewport({ width: 1280, height: 720 });
  const popup = await popupReader(reading);
  // Runs `declaration` on the root popup, inside its closed shadow root.
  const inPopup = async (page, declaration) => {
    const cdp = await page.createCDPSession();
    try {
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      let nodeId = null;
      const walk = node => {
        const attributes = node.attributes || [];
        for (let i = 0; i < attributes.length; i += 2) {
          if (attributes[i] === "class" && String(attributes[i + 1]).includes("gsm-hoshidicts-popup")
              && attributes[attributes.indexOf("data-hoshidicts-depth") + 1] === "0") nodeId = node.nodeId;
        }
        for (const shadow of node.shadowRoots || []) walk(shadow);
        for (const child of node.children || []) walk(child);
      };
      walk(root);
      if (nodeId === null) return [];
      const { object } = await cdp.send("DOM.resolveNode", { nodeId });
      const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
        functionDeclaration: declaration });
      return result.value ?? null;
    } finally {
      await cdp.detach().catch(() => {});
    }
  };
  // The language marks of the root popup's glossary blocks (docs/languages.md 10.1).
  const popupBlocks = async page => (await inPopup(page, `function () {
    return [...this.querySelectorAll("[data-hd-lang-default]")].map(node => ({
      lang: node.getAttribute("lang"), default: node.hasAttribute("data-hd-lang-default") }));
  }`)) ?? [];

  const hoverAt = async (path, selector, index, accept) => {
    await reading.bringToFront();
    if (!reading.url().endsWith(path)) await reading.goto(`${origin}${path}`, { waitUntil: "load" });
    const point = await characterPoint(reading, selector, index);
    return hoverForPopup(reading, popup, selector, { point, accept, attempts: 20 });
  };

  await step(PLANNED[8], async () => {
    // The second n of "running".
    const state = await hoverAt("/english.html", "#sample", 10, current => current.plain.includes("to move swiftly on foot"));
    if (state) await screenshot(reading, "lookup-english");
    check(PLANNED[8], state?.plain.includes("run") && state.plain.includes("to move swiftly on foot"), JSON.stringify(state?.plain));
  });

  await step(PLANNED[22], async () => {
    await early.bringToFront();
    const state = await hoverForPopup(early, await popupReader(early), "#sample", { point: await characterPoint(early, "#sample", 10),
      accept: current => current.plain.includes("to move swiftly on foot"), attempts: 20 });
    check(PLANNED[22], state?.plain.includes("to move swiftly on foot"), JSON.stringify(state?.plain));
    await early.close();
  });

  await step(PLANNED[9], async () => {
    await chooseInToolbar("ja");
    const state = await hoverAt("/japanese.html", "#sample", 0, current => current.plain.includes("食べる"));
    if (state) await screenshot(reading, "lookup-japanese");
    check(PLANNED[9], state?.plain.includes("食べる"), JSON.stringify(state?.plain));
  });

  await step(PLANNED[10], async () => {
    await chooseInToolbar("ar");
    // The fourth letter of الكتاب, on a right-to-left page.
    const state = await hoverAt("/arabic.html", "#sample", 3, current => current.plain.includes("book"));
    if (state) await screenshot(reading, "lookup-arabic");
    check(PLANNED[10], state?.plain.includes("\u0643\u062A\u0627\u0628") && state.plain.includes("book"), JSON.stringify(state?.plain));
    // The closed shadow root is reachable only through CDP (popup-reader.mjs).
    const blocks = await popupBlocks(reading);
    check("the Arabic-English dictionary's block takes its targetLanguage as its default lang",
      blocks.some(block => block.lang === "en" && block.default), JSON.stringify(blocks));
  });

  await step(PLANNED[11], async () => {
    await chooseInToolbar("en");
    const state = await hoverAt("/english.html", "#sample", 10, current => current.plain.includes("to move swiftly on foot"));
    const hint = await toolbar.evaluate(() => document.getElementById("activation-hint").textContent);
    const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
    check(PLANNED[11], Boolean(state) && hint === "Hover over English text to scan" && badge === "EN",
      JSON.stringify({ plain: state?.plain, hint, badge }));
  });

  await step(PLANNED[21], async () => {
    // English is used for lookups, and Settings shows English.
    const toolbarState = () => toolbar.evaluate(() => ({
      row: document.getElementById("language-switcher") !== null,
      label: document.getElementById("lookup-toggle").getAttribute("aria-label"),
      hint: document.getElementById("activation-hint").textContent,
    }));
    const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
    if (!await multipleLanguages(false)) throw new Error("Multiple languages did not turn off");
    const off = await until(async () => {
      const state = { toolbar: await toolbarState(), badge: await badge(), edited: await editedId() };
      return !state.toolbar.row && state.badge === "" ? state : null;
    }) ?? { toolbar: await toolbarState(), badge: await badge(), edited: await editedId() };
    const kept = (await storage(["options", "languageSelection"]));
    const japanese = await hoverAt("/japanese.html", "#sample", 0, current => current.plain.includes("食べる"));
    // English text read in Japanese finds no English entry; a few tries are enough.
    await reading.bringToFront();
    await reading.goto(`${origin}/english.html`, { waitUntil: "load" });
    const english = await hoverForPopup(reading, popup, "#sample", { point: await characterPoint(reading, "#sample", 10),
      accept: current => current.plain.includes("to move swiftly on foot"), attempts: 3 });
    if (!await multipleLanguages(true)) throw new Error("Multiple languages did not turn back on");
    const on = await until(async () => {
      const state = { toolbar: await toolbarState(), badge: await badge() };
      return state.toolbar.row && state.badge === "EN" ? state : null;
    });
    check(PLANNED[21], !off.toolbar.row && off.toolbar.label === "Japanese lookups"
      && off.toolbar.hint === "Hover over Japanese text to scan" && off.badge === "" && off.edited === "ja"
      && kept.languageSelection?.activeProfileId === "en" && languagesOf(kept.options).join() === "ja,en,ar"
      && Boolean(japanese) && english === null && on?.toolbar.hint === "Hover over English text to scan",
    JSON.stringify({ off, kept, japanese: japanese?.plain, english: english?.plain, on }));
  });

  await step(PLANNED[12], async () => {
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
    // The next language in the records' order: Japanese, English, Arabic.
    check(PLANNED[12], before === "en" && after === "ar", JSON.stringify({ before, after }));
  });

  await step(PLANNED[13], async () => {
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
    // From the last language the next is the first.
    check(PLANNED[13], before === "ar" && after === "ja" && command?.shortcut === ""
      && command.description === "Switch to the next language", JSON.stringify({ before, after, command }));
  });

  // Advanced → Languages → Switch language automatically, clicked in the
  // page: Settings stays a background tab while the reading page is in front.
  const autoSwitch = async enabled => {
    await showSection("languages");
    await settings.evaluate(wanted => {
      const input = document.getElementById("language-auto-switch");
      if (input.checked !== wanted) input.click();
    }, enabled);
    return until(async () => (await storage(["languageSelection"])).languageSelection?.autoSwitch === enabled);
  };

  await step(PLANNED[14], async () => {
    await chooseInToolbar("ja");
    if (!await autoSwitch(true)) throw new Error("Switch language automatically did not turn on");
    // English's dictionary gets a display name; only Japanese gets a link
    // button and the Plain theme (docs/languages.md 3, 8.1).
    let stored = await storage(["options", "dictionaryState"]);
    const englishRow = stored.dictionaryState.dictionaries.find(row => row.title === ENGLISH.title);
    const rows = new Map(stored.dictionaryState.dictionaries.map(row => [row.id, row]));
    const englishView = stored.dictionaryState.profiles.en;
    await message({ target: "hoshidicts-worker", type: "hd_state_cas", profileId: "en", baseRevision: stored.dictionaryState.revision,
      dictionaries: englishView.dictionaries.map(entry => ({ ...rows.get(entry.id), enabled: entry.enabled !== false,
        ...(entry.id === englishRow.id ? { displayName: "EN-ALIAS" } : {}) })),
      groups: englishView.groups ?? [] });
    await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision, profileId: "ja",
      options: { popupTheme: "plain", customButtons: [{ id: "jaonly", type: "link", label: "JA-ONLY", url: "https://jisho.org/search/{term}" }] } });
    await until(async () => {
      stored = await storage(["options", "dictionaryState"]);
      return stored.dictionaryState.dictionaries.find(row => row.id === englishRow.id)?.displayName === "EN-ALIAS"
        && JSON.stringify(stored.options).includes("JA-ONLY");
    });
    const english = await hoverAt("/mixed.html", "#english", 10, current => current.plain.includes("to move swiftly on foot"));
    const own = await inPopup(reading, `function () {
      return { alias: this.textContent.includes("EN-ALIAS"), jaOnly: this.innerHTML.includes("JA-ONLY"),
        renderer: this.getRootNode().host?.dataset.hoshidictsRenderer ?? null };
    }`);
    // The English dictionary's target language, although Japanese, the active
    // profile, does not use it (render review minor 1).
    const blocks = await popupBlocks(reading);
    check("a popup that automatic switching gives English shows English's display name, custom buttons, theme and target language",
      own?.alias === true && own.jaOnly === false && own.renderer === "default" && blocks.some(block => block.lang === "en"),
      JSON.stringify({ own, blocks }));
    stored = await storage(["options"]);
    await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision, profileId: "ja",
      options: { popupTheme: "default", customButtons: [] } });
    await until(async () => !JSON.stringify((await storage(["options"])).options).includes("JA-ONLY"));
    const active = (await storage(["languageSelection"])).languageSelection?.activeProfileId;
    const japanese = await hoverAt("/mixed.html", "#japanese", 0, current => current.plain.includes("食べる"));
    check(PLANNED[14], Boolean(english) && Boolean(japanese) && active === "ja",
      JSON.stringify({ english: english?.plain, japanese: japanese?.plain, active }));
    // The English popup's label: the profile in effect is not the active one;
    // the Japanese popup, in the active profile, has none.
    check(PLANNED[15], english?.plain.includes("English") && !japanese?.plain.includes("English"),
      JSON.stringify({ english: english?.plain, japanese: japanese?.plain }));
    await autoSwitch(false);
  });

  await step(PLANNED[16], async () => {
    await settings.evaluate(() => { location.hash = "#lookup"; });
    await settings.reload({ waitUntil: "load" });
    await settings.waitForSelector("#settings-language-link", { timeout: 30_000 });
    const startedOn = await editedId();
    // The sidebar's link leads to Settings shows.
    await settings.evaluate(() => document.getElementById("settings-language-link").click());
    const focused = await until(() => settings.evaluate(() => document.getElementById("languages").hidden === false
      && document.activeElement?.id === "settings-language-select"));
    await settings.select("#settings-language-select", "en");
    await until(async () => (await editedId()) === "en");
    const link = await settings.evaluate(() => document.getElementById("settings-language-link").textContent);
    await showSection("lookup");
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
    check(PLANNED[16], startedOn === "ja" && focused && link === "Settings shows English" && Boolean(after)
      && scan(after, "ja") === scan(before, "ja") && after.languageSelection.activeProfileId === "ja",
    JSON.stringify({ startedOn, focused, link, ja: [scan(before, "ja"), scan(after, "ja")], en: scan(after, "en"),
      active: after?.languageSelection.activeProfileId }));
  });

  await step(PLANNED[17], async () => {
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
    await showSection("languages");
    await settings.select("#settings-language-select", "ja");
    await until(async () => (await editedId()) === "ja");
    await showSection("design");
    const japanese = await until(async () => {
      const value = await hidden();
      return !value.pitch ? value : null;
    }) ?? await hidden();
    check(PLANNED[17], english.pitch && english.kanji && english.anki && english.japaneseOnly === "English text only"
      && !japanese.pitch && !japanese.kanji && !japanese.anki && japanese.japaneseOnly === "Japanese text only",
    JSON.stringify({ english, japanese }));
  });
  await step(PLANNED[20], async () => {
    // English reads in Light; Japanese keeps the Hachidori palette.
    let stored = await storage(["options"]);
    await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision, profileId: "en",
      options: { popupTheme: "light" } });
    await until(async () => {
      stored = await storage(["options"]);
      return stored.options.profiles.find(profile => profile.id === "en")?.settings.popupTheme === "light";
    });
    await chooseInToolbar("en");
    const search = await extensionPage("search.html");
    const palettes = async () => {
      const frame = search.frames().find(candidate => candidate.url().includes("search-frame.html"));
      const theme = target => target?.evaluate(() => document.documentElement.dataset.hoshidictsTheme ?? null).catch(() => null);
      return { shell: await theme(search.mainFrame()), frame: await theme(frame) };
    };
    const settled = async (wanted) => until(async () => {
      const value = await palettes();
      return value.shell === wanted && value.frame === wanted ? value : null;
    }) ?? await palettes();
    const english = await settled("light");
    await chooseInToolbar("ja");
    const japanese = await settled("default");
    await search.close();
    check(PLANNED[20], english.shell === "light" && english.frame === "light"
      && japanese.shell === "default" && japanese.frame === "default", JSON.stringify({ english, japanese }));
  });
} finally {
  await browser.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}

const failed = PLANNED.filter(name => results.get(name)?.ok !== true);
for (const name of PLANNED.filter(planned => !results.has(planned))) console.log(`FAIL  ${name}\n      check never ran`);
if (errors.length > 0) console.log(`page errors:\n  ${errors.join("\n  ")}`);
console.log(`\n${PLANNED.length - failed.length}/${PLANNED.length} checks passed; screenshots in ${SCREENSHOTS}`);
process.exitCode = failed.length === 0 ? 0 : 1;
