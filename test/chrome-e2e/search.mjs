/*
 * The search page (#610): Yomitan's search page and popup window, opened from
 * the toolbar menu and its shortcuts, with real lookups docked in the page.
 * The page itself is search-frame.html, the sandboxed frame search.html holds
 * (#644), so each read of it goes to that frame.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./notes.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { check, diagnostics, EXTENSION, step } from "./harness.mjs";
import { popupRoot } from "../chrome-popup-root.mjs";
import { nestedLinksFixture } from "../make-fixture.mjs";
import { popupReader } from "./popup-reader.mjs";
import { browser, editSettingsControls, extensionId, installMediaArchive, page, pageUrl } from "./session.mjs";

const READER_SCRIPTS = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"))
  .content_scripts[0].js.filter(src => src !== "reader-options.js");
const SCREENSHOTS = process.env.HACHIDORI_SEARCH_SCREENSHOTS;
const SEARCH_COMMANDS = ["openSearchPage", "openSearchPageCurrentTab", "openPopupWindow"];

// Values that more than one step uses; the step that creates each one assigns it.
let searchTab, searchPopup, originalOptions;

const searchUrl = () => `chrome-extension://${extensionId}/search.html`;
const frameUrl = () => `chrome-extension://${extensionId}/search-frame.html`;

// The search page's own document, in search.html's frame.
async function searchFrame(target) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const frame = target.frames().find(candidate => candidate.url() === frameUrl());
    if (frame || Date.now() >= deadline) return frame ?? null;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
}

// The open search pages, as the worker finds them: tabs hide extension URLs.
const searchPages = () => page.evaluate(async url => Promise.all((await chrome.runtime.getContexts({
  contextTypes: ["TAB"], documentUrls: [url] })).map(async ({ tabId, windowId }) => {
  const window = await chrome.windows.get(windowId);
  return { tabId, windowId, active: (await chrome.tabs.get(tabId)).active, type: window.type,
    size: [window.width, window.height] };
})), searchUrl());

const writeOptions = patch => page.evaluate(async patch => {
  const { options } = await chrome.storage.local.get("options");
  const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
    baseRevision: options.revision, options: patch });
  if (!reply.ok) throw new Error(reply.error);
}, patch);

async function screenshot(target, name, clip) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await target.bringToFront();
  // Switches ease their knobs and colours for 120 ms (settings.css, toolbar.css): shoot once they have.
  await target.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {}))),
    new Promise(done => { setTimeout(done, 1000); }),
  ]));
  await target.screenshot({ path: resolve(SCREENSHOTS, `${name}.png`), ...(clip ? { clip } : {}) });
}

// What the search page shows: its theme, the reader it loaded, the box, the
// echoed query and where its results area is.
const pageState = async target => (await searchFrame(target)).evaluate(() => {
  const box = document.getElementById("search-input");
  const area = document.getElementById("search-results").getBoundingClientRect();
  return {
    theme: document.documentElement.dataset.hoshidictsTheme ?? null,
    hostTheme: document.querySelector("hachidori-host")?.dataset.hoshidictsTheme ?? null,
    readerScripts: [...document.querySelectorAll("script[data-search-reader]")].map(script => script.getAttribute("src")),
    ready: !document.getElementById("search-submit").disabled,
    value: box.value,
    focused: document.activeElement === box,
    selected: box.selectionStart === 0 && box.selectionEnd === box.value.length && box.value.length > 0,
    query: document.getElementById("search-query").hidden ? null : document.getElementById("search-query").textContent,
    area: { x: area.x, y: area.y, width: area.width, height: area.height },
    inResults: document.getElementById("search-results").contains(document.querySelector("hachidori-host")),
  };
});

async function searchFor(target, text) {
  const frame = await searchFrame(target);
  await frame.focus("#search-input");
  await frame.$eval("#search-input", (box, value) => { box.value = value; }, text);
  await target.keyboard.press("Enter");
}

const fills = (rect, area) => rect !== null && ["x", "y", "width", "height"].every(key => Math.abs(rect[key] - area[key]) <= 1);

describe("search page", () => {
  step("the search page shortcuts, the toolbar menu's Search and the popup window", async () => {
    originalOptions = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
    const commands = await page.evaluate(async () => (await chrome.commands.getAll())
      .map(({ name, shortcut }) => ({ name, shortcut })));
    const shortcut = name => commands.find(command => command.name === name)?.shortcut;
    check("Chrome registers Yomitan's three search page shortcuts, Alt+Insert opening it in a new tab",
      SEARCH_COMMANDS.every(name => shortcut(name) !== undefined)
        // Chrome reports Insert as Ins, as it reports Delete as Del.
        && /^Alt\+Ins(?:ert)?$/u.test(shortcut("openSearchPage"))
        && shortcut("openSearchPageCurrentTab") === "" && shortcut("openPopupWindow") === "",
      JSON.stringify(commands.filter(({ name }) => SEARCH_COMMANDS.includes(name))));

    const toolbar = await browser.newPage();
    toolbar.on("pageerror", e => diagnostics.push(`[toolbar] pageerror: ${e.message}`));
    await toolbar.goto(`chrome-extension://${extensionId}/toolbar.html`, { waitUntil: "load" });
    await toolbar.waitForFunction(() => !document.getElementById("lookup-toggle").disabled);
    const before = await searchPages();
    const menu = await toolbar.evaluate(() => {
      const settings = document.getElementById("open-settings").getBoundingClientRect();
      const search = document.getElementById("open-search");
      const box = search.getBoundingClientRect();
      return { hidden: search.hidden, label: search.textContent.trim(), sameRow: Math.abs(settings.top - box.top) < 1,
        after: box.left >= settings.right };
    });
    await screenshot(toolbar, "toolbar-menu", await toolbar.$eval("main", main => {
      const { x, y, width, height } = main.getBoundingClientRect();
      return { x, y, width, height };
    }));
    const opened = browser.waitForTarget(target => target.url() === searchUrl(), { timeout: 15_000 });
    await toolbar.click("#open-search");
    searchTab = await (await opened).page();
    searchTab.on("pageerror", e => diagnostics.push(`[search] pageerror: ${e.message}`));
    const first = await searchPages();
    // Another tab in front, then Search again: the one search page comes forward.
    const again = toolbar.isClosed() ? await browser.newPage() : toolbar;
    if (again !== toolbar) await again.goto(`chrome-extension://${extensionId}/toolbar.html`, { waitUntil: "load" });
    await again.bringToFront();
    await again.waitForFunction(() => !document.getElementById("open-search").hidden);
    const behind = await searchPages();
    await again.click("#open-search");
    await page.waitForFunction(async url => {
      const [context] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
      return context && (await chrome.tabs.get(context.tabId)).active;
    }, { polling: 100, timeout: 10_000 }, searchUrl()).catch(() => {});
    const forward = await searchPages();
    if (again.isClosed()) {
      await (await browser.newPage()).goto(`chrome-extension://${extensionId}/toolbar.html`, { waitUntil: "load" });
    }
    const menuPage = (await browser.pages()).find(target => target.url().endsWith("/toolbar.html"));
    await editSettingsControls(page, { "opt-toolbar-search": false });
    const hidden = await menuPage.waitForFunction(() => document.getElementById("open-search").hidden,
      { polling: 100, timeout: 10_000 }).then(() => true, () => false);
    await editSettingsControls(page, { "opt-toolbar-search": true });
    const shown = await menuPage.waitForFunction(() => !document.getElementById("open-search").hidden,
      { polling: 100, timeout: 10_000 }).then(() => true, () => false);
    await menuPage.close();
    check("the toolbar menu's Search beside Settings opens one search page, then brings it forward, and Reading's switch hides it",
      before.length === 0 && !menu.hidden && menu.label === "Search" && menu.sameRow && menu.after
        && first.length === 1 && behind.length === 1 && !behind[0].active
        && forward.length === 1 && forward[0].tabId === first[0].tabId && forward[0].active
        && hidden && shown,
      JSON.stringify({ before, menu, first, behind, forward, hidden, shown }));

    // The worker's popup window command, through the opener it shares with the menu.
    const openPopupWindow = () => page.evaluate(async () => {
      const { openSearchPage } = await import(chrome.runtime.getURL("search-window.js"));
      await openSearchPage(chrome, "popup");
    });
    // Reading → Search page sets the window's size (#656).
    await editSettingsControls(page, { "opt-search-window-width": "520", "opt-search-window-height": "480" });
    const windowOpened = browser.waitForTarget(target => target.url() === searchUrl() && target !== searchTab.target(),
      { timeout: 15_000 });
    await openPopupWindow();
    searchPopup = await (await windowOpened).page();
    // The new tab's target can come before chrome.runtime.getContexts lists its
    // document, as the toolbar menu's Search waits for above.
    await page.waitForFunction(async url => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
      const windows = await Promise.all(contexts.map(({ windowId }) => chrome.windows.get(windowId)));
      return windows.some(window => window.type === "popup");
    }, { polling: 100, timeout: 10_000 }, searchUrl()).catch(() => {});
    const once = await searchPages();
    await editSettingsControls(page, { "opt-search-window-width": "600", "opt-search-window-height": "640" });
    await searchTab.bringToFront();
    await openPopupWindow();
    const twice = await searchPages();
    const popupWindows = list => list.filter(entry => entry.type === "popup");
    check("the popup window shortcut opens one search page in a popup window, then brings it forward",
      once.length === 2 && popupWindows(once).length === 1 && twice.length === 2 && popupWindows(twice).length === 1
        && popupWindows(twice)[0].tabId === popupWindows(once)[0].tabId
        && twice.some(entry => entry.tabId === first[0].tabId && entry.type === "normal"),
      JSON.stringify({ once, twice }));
    check("the popup window opens at the size set in Reading → Search page",
      JSON.stringify(popupWindows(once)[0]?.size) === "[520,480]", JSON.stringify(popupWindows(once)));
  });

  step("searching on the search page", async () => {
    await searchTab.setViewport({ width: 960, height: 760 });
    await searchTab.bringToFront();
    const frame = await searchFrame(searchTab);
    await frame.waitForFunction(() => !document.getElementById("search-submit").disabled,
      { polling: 100, timeout: 15_000 });
    const opened = await pageState(searchTab);
    const shellScripts = await searchTab.evaluate(() => document.querySelectorAll("script[data-search-reader]").length);
    // The Clipboard monitor (#639) is off: Hachidori holds no clipboardRead
    // permission, so the offscreen document's paste reads nothing that was
    // copied. Its switch and its reads are search.html's (#644).
    const copied = await frame.evaluate(() => {
      const box = document.getElementById("search-input");
      box.value = "食べたかった";
      box.select();
      const done = document.execCommand("copy");
      box.value = "";
      return done;
    });
    const clipboard = { copied, ...await searchTab.evaluate(async () => ({
      on: document.getElementById("search-clipboard").checked,
      enabled: !document.getElementById("search-clipboard").disabled,
      optional: chrome.runtime.getManifest().optional_permissions,
      granted: await chrome.permissions.contains({ permissions: ["clipboardRead"] }),
      read: await chrome.runtime.sendMessage({ target: "hachidori-clipboard", type: "hd_clipboard_read" }),
    })) };
    check("the search page's Clipboard monitor is off by default and Hachidori reads nothing from the clipboard until it is switched on",
      clipboard.copied && !clipboard.on && clipboard.enabled && JSON.stringify(clipboard.optional) === '["clipboardRead"]'
        && !clipboard.granted && clipboard.read?.ok === true && clipboard.read.text === "",
      JSON.stringify(clipboard));
    const popup = await popupReader(searchTab, 0, frameUrl());
    const theme = originalOptions.popupTheme === "auto"
      ? await searchTab.evaluate(() => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"))
      : originalOptions.popupTheme;
    await searchFor(searchTab, "食べたかった");
    const result = await popup.waitForVisible(15_000, state => state.plain.includes("食べる"));
    const docked = await pageState(searchTab);
    const rect = await popup.rect();
    await screenshot(searchTab, "search-page");
    await frame.click(".search-header h1");
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
    const afterClick = await popup.state();
    await searchTab.keyboard.press("Escape");
    await frame.waitForFunction(() => document.activeElement === document.getElementById("search-input"),
      { polling: 50, timeout: 5_000 }).catch(() => {});
    const afterEscape = await popup.state();
    const escaped = await pageState(searchTab);
    check("the search page opens with its box focused and shows a typed word's real results under it in the popup theme, kept through an outside click and Escape, which selects the box",
      opened.focused && result !== null && result.text.includes("to eat") && docked.ready && docked.theme === theme
        && JSON.stringify(docked.readerScripts) === JSON.stringify(READER_SCRIPTS) && shellScripts === 0
        && docked.query === "食べたかった" && !docked.focused && fills(rect, docked.area) && docked.inResults
        && popup.visible(afterClick) && afterClick.plain.includes("食べる")
        && popup.visible(afterEscape) && escaped.focused && escaped.selected,
      JSON.stringify({ opened, shellScripts, result: result?.plain.slice(0, 120), docked, rect, afterClick: afterClick?.plain.slice(0, 60),
        afterEscape: afterEscape?.plain.slice(0, 60), escaped }));

    await frame.$eval("#search-input", box => box.setSelectionRange(box.value.length, box.value.length));
    await frame.click(".search-header h1");
    await searchTab.keyboard.press("a");
    const typed = await pageState(searchTab);
    await frame.click(".search-header h1");
    await searchTab.keyboard.down("Control");
    await searchTab.keyboard.press("u");
    await searchTab.keyboard.up("Control");
    const cleared = await pageState(searchTab);
    await frame.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "漢字");
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const pasted = await popup.waitForVisible(15_000, state => state.tables.length > 0);
    const pastedPage = await pageState(searchTab);
    await searchFor(searchTab, "ぬるぽ");
    const missed = await popup.waitForVisible(15_000, state => state.text.includes("No definition found"));
    check("a key typed elsewhere on the search page goes into its box, Ctrl+U clears it, text pasted outside it is searched, and a miss says so in the results area",
      typed.focused && typed.value === "食べたかったa" && cleared.focused && cleared.value === ""
        && pasted !== null && pasted.plain.includes("漢字") && pastedPage.value === "漢字" && pastedPage.query === "漢字"
        && missed !== null && fills(await popup.rect(), (await pageState(searchTab)).area),
      JSON.stringify({ typed, cleared, pasted: pasted?.plain.slice(0, 120), pastedPage, missed: missed?.text.slice(0, 120) }));

    await searchFor(searchTab, "食べる");
    await popup.waitForVisible(15_000, state => state.plain.includes("食べる") && state.text.includes("to eat"));
    const changed = originalOptions.popupTheme === "dracula" ? "girlypop" : "dracula";
    await writeOptions({ popupTheme: changed });
    const followed = await frame.waitForFunction(theme => document.documentElement.dataset.hoshidictsTheme === theme
      && document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === theme,
    { polling: 100, timeout: 10_000 }, changed).then(() => true, () => false);
    const themed = await pageState(searchTab);
    const kept = await popup.state();
    await screenshot(searchTab, `search-page-${changed}`);
    // The palettes the PR shows, in screenshot runs only.
    for (const palette of SCREENSHOTS ? ["default", "high-contrast"] : []) {
      await writeOptions({ popupTheme: palette });
      await frame.waitForFunction(theme => document.documentElement.dataset.hoshidictsTheme === theme
        && document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === theme,
      { polling: 100, timeout: 10_000 }, palette).catch(() => {});
      await screenshot(searchTab, `search-page-${palette}`);
    }
    await writeOptions({ popupTheme: originalOptions.popupTheme });
    check("the search page and its results follow a popup theme change at once",
      followed && themed.theme === changed && themed.hostTheme === changed && popup.visible(kept) && kept.plain.includes("食べる"),
      JSON.stringify({ changed, followed, themed, kept: kept?.plain.slice(0, 60) }));

    // The page sees only the reader's host of the closed popup root, so keys
    // and pastes inside the docked result stay there: here, its Note form.
    const noteOpened = await popup.click(".gsm-hoshidicts-note-button");
    const root = popupRoot(searchTab, frameUrl());
    const noteFocused = await root.waitFor(shadow => {
      const field = shadow.querySelector('.gsm-hoshidicts-note-form:not([hidden]) [name="definition"]');
      field?.focus();
      return Boolean(field) && shadow.activeElement === field;
    }, { timeout: 10_000 }).catch(() => false);
    await searchTab.keyboard.type("ab");
    await searchTab.keyboard.down("Control");
    await searchTab.keyboard.press("u");
    await searchTab.keyboard.up("Control");
    const pastedInNote = await root.evaluate(shadow => {
      const field = shadow.activeElement;
      if (field?.name !== "definition") return false;
      const data = new DataTransfer();
      data.setData("text/plain", "漢字");
      field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
      return shadow.activeElement === field;
    });
    const drafted = await popup.state();
    const beside = await pageState(searchTab);
    await searchTab.keyboard.press("Escape");
    const noteClosed = await popup.state();
    check("keys typed, Ctrl+U and text pasted in the docked result's Note form stay in the form",
      noteOpened && noteFocused && pastedInNote && drafted?.noteOpen === true && drafted.noteDefinition === "ab"
        && beside.value === "食べる" && beside.query === "食べる" && !beside.focused
        && popup.visible(noteClosed) && noteClosed.noteOpen === false,
      JSON.stringify({ noteOpened, noteFocused, pastedInNote, drafted: drafted && { noteOpen: drafted.noteOpen,
        noteDefinition: drafted.noteDefinition }, beside, noteClosed: noteClosed?.noteOpen }));

    if (SCREENSHOTS) {
      await searchPopup.setViewport({ width: 600, height: 640 });
      const windowPopup = await popupReader(searchPopup, 0, frameUrl());
      await (await searchFrame(searchPopup)).waitForFunction(() => !document.getElementById("search-submit").disabled,
        { polling: 100, timeout: 15_000 });
      await searchFor(searchPopup, "読む");
      await windowPopup.waitForVisible(15_000, state => state.plain.includes("読む"));
      await screenshot(searchPopup, "popup-window");
      await page.bringToFront();
      const fieldset = await page.$eval("#search-page-settings", element => {
        element.scrollIntoView({ block: "center" });
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x: x + scrollX, y: y + scrollY, width, height };
      });
      await screenshot(page, "settings-search-page", fieldset);
    }
    await searchPopup.close();
    await searchTab.close();
  });

  // Reading → Search page → Look up words with a click (#656), off as
  // Yomitan's scanning.enablePopupSearch is: a click on a word of the echoed
  // query shows that word's results, and a click on a word in them opens it in
  // a child popup, without the activation key. The nested-links fixture's
  // definitions hold its other words.
  step("clicking words on the search page", async () => {
    const fixture = nestedLinksFixture();
    await installMediaArchive(page, fixture.archive);
    const tab = await browser.newPage();
    tab.on("pageerror", e => diagnostics.push(`[search] pageerror: ${e.message}`));
    let evidence;
    try {
      // Page lookups wait for the activation key, which nothing here holds.
      await writeOptions({ lookupMode: "activationSticky", definitionLookupMode: "inherit" });
      await tab.setViewport({ width: 960, height: 760 });
      await tab.goto(searchUrl(), { waitUntil: "load" });
      const frame = await searchFrame(tab);
      await frame.waitForFunction(() => !document.getElementById("search-submit").disabled,
        { polling: 100, timeout: 15_000 });
      const popup = await popupReader(tab, 0, frameUrl());
      const child = await popupReader(tab, 1, frameUrl());
      // Each entry's definition says which one is shown.
      const [rootDefinition, childDefinition, grandchildDefinition] =
        ["A linked definition.", "The referenced entry.", "The final entry."];
      const shows = (state, definition) => popup.visible(state) && state.plain.includes(definition);
      const text = `${fixture.query}と${fixture.child}`;
      await searchFor(tab, text);
      const searched = await popup.waitForVisible(15_000, state => state.plain.includes(rootDefinition));
      // The query's character at `index`: its centre, and its left and right
      // edges, where a press puts the caret before and after it. The frame
      // fills the page.
      const queryPoint = index => frame.evaluate(offset => {
        const range = document.createRange();
        range.setStart(document.getElementById("search-query").firstChild, offset);
        range.setEnd(document.getElementById("search-query").firstChild, offset + 1);
        const { x, y, width, height } = range.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2, left: x + 1, right: x + width - 1 };
      }, index);
      const clickQuery = async (index) => {
        const { x, y } = await queryPoint(index);
        await tab.mouse.click(x, y);
      };
      const clickDefinition = async (word) => {
        const hit = await popup.definitionTextRect(word);
        if (!hit) return false;
        await tab.mouse.click(hit.rect.x + hit.rect.width / 2, hit.rect.y + hit.rect.height / 2);
        return true;
      };
      const pause = () => new Promise(resolveWait => { setTimeout(resolveWait, 1_000); });

      await clickQuery(text.indexOf(fixture.child));
      await pause();
      const queryOff = await popup.state();
      const definitionOff = await clickDefinition(fixture.child);
      await pause();
      const childOff = await child.state();

      await editSettingsControls(page, { "opt-search-click-lookup": true });
      // Once the frame reads the switch on, its reader has heard of it.
      await frame.waitForFunction(async () => (await chrome.storage.local.get("options")).options.searchClickLookup === true,
        { polling: 100, timeout: 10_000 });
      await tab.bringToFront();
      await clickQuery(text.indexOf(fixture.child));
      const queryOn = await popup.waitForVisible(15_000, state => state.plain.includes(childDefinition));
      const definitionOn = await clickDefinition(fixture.grandchild);
      const childOn = await child.waitForVisible(15_000, state => state.plain.includes(grandchildDefinition));
      // A drag across the query's first word selects it and looks nothing up.
      const start = await queryPoint(0), end = await queryPoint(fixture.query.length - 1);
      await tab.mouse.move(start.left, start.y);
      await tab.mouse.down();
      await tab.mouse.move(end.right, end.y, { steps: 5 });
      await tab.mouse.up();
      await pause();
      const dragged = await popup.state();
      const selected = await frame.evaluate(() => getSelection().toString());
      await screenshot(tab, "search-click-lookup");
      // Off, neither click changed the result or opened a child; on, the
      // query's word replaced the result and the result's word opened a child.
      evidence = { searched: searched !== null, keptOff: shows(queryOff, rootDefinition), definitionOff,
        childOff: child.visible(childOff), queryOn: queryOn !== null, definitionOn, childOn: childOn !== null,
        keptDrag: shows(dragged, childDefinition), selected, shown: dragged?.plain.slice(0, 80) };
    } finally {
      await writeOptions({ searchClickLookup: false, lookupMode: originalOptions.lookupMode ?? "hover",
        definitionLookupMode: originalOptions.definitionLookupMode ?? "inherit" });
      const removed = await page.evaluate(title => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_remove", title }), fixture.title);
      if (!removed.ok) throw new Error(removed.error);
      await tab.close();
    }
    check("Look up words with a click is off by default; on, a click on a word of the search page's query shows its results, one in the results opens a child popup, and a drag still selects text",
      evidence.searched && evidence.keptOff && evidence.definitionOff && !evidence.childOff
        && evidence.queryOn && evidence.definitionOn && evidence.childOn && evidence.keptDrag
        && evidence.selected === fixture.query,
      JSON.stringify(evidence));
  });

  // The Anki Template switch (#656), where Yomitan's search page has its
  // profile switch: it chooses the Template the built-in Anki button uses, as
  // Settings → Anki → Set built-in does. It is search.html's, over an
  // invisible copy in the frame's header.
  step("choosing the Anki Template on the search page", async () => {
    const storedAnki = () => page.evaluate(async () => (await chrome.storage.local.get("options")).options.anki);
    const original = await storedAnki();
    const tab = await browser.newPage();
    tab.on("pageerror", e => diagnostics.push(`[search] pageerror: ${e.message}`));
    let evidence;
    try {
      const withTemplates = templates => page.evaluate((anki, list) => globalThis.HDReaderOptions.normaliseAnki({
        url: anki.url, apiKey: anki.apiKey, templates: list.map(([id, name]) => ({ ...anki.templates[0], id: id ?? anki.templates[0].id, name })),
      }), original, templates);
      await writeOptions({ anki: await withTemplates([[null, "Sentences"]]) });
      // The popup window's default size.
      await tab.setViewport({ width: 600, height: 640 });
      await tab.goto(searchUrl(), { waitUntil: "load" });
      const frame = await searchFrame(tab);
      await frame.waitForFunction(() => !document.getElementById("search-submit").disabled,
        { polling: 100, timeout: 15_000 });
      const state = async () => ({
        shell: await tab.evaluate(() => {
          const select = document.getElementById("search-template");
          return { hidden: select.hidden, value: select.value, choices: [...select.options].map(option => option.text),
            heading: select.querySelector("optgroup")?.label ?? null, name: select.getAttribute("aria-label"),
            focused: document.activeElement === select, rect: select.getBoundingClientRect().toJSON() };
        }),
        copy: await frame.evaluate(() => {
          const select = document.querySelector("select.search-template");
          // The lines the header's title and Clipboard monitor label take.
          const lines = (element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
          };
          return { hidden: select.hidden, value: select.value, visibility: getComputedStyle(select).visibility,
            rect: select.getBoundingClientRect().toJSON(),
            lines: [lines(document.querySelector(".search-header h1")), lines(document.querySelector(".search-header .lookup-enable span"))] };
        }),
        order: (await storedAnki()).templates.map(({ id }) => id),
        frameFocused: await tab.evaluate(() => document.activeElement?.localName === "iframe"),
      });
      const settled = async (predicate) => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const current = await state();
          if (predicate(current) || Date.now() >= deadline) return current;
          await new Promise(resolveWait => { setTimeout(resolveWait, 100); });
        }
      };
      const single = await state();
      // A long name is cut by the menu, which gives way in the 600-pixel
      // window rather than wrapping the title or the Clipboard monitor's label.
      await writeOptions({ anki: await withTemplates([[null, "Sentences with audio and a picture"], ["e2e-words", "Words"],
        ["e2e-kanji", "Kanji"]]) });
      const id = original.templates[0].id;
      const listed = await settled(current => !current.shell.hidden && !current.copy.hidden);
      await screenshot(tab, "search-template-switch");
      // In a 320 px window, or the default one at 200% zoom, the header wraps
      // rather than putting the Clipboard monitor past the window's edge. Its
      // rows end at its end, so a line too long would spill past its start,
      // which scrollWidth does not count: each control has to lie inside it.
      await tab.setViewport({ width: 320, height: 640 });
      const narrow = { copy: await frame.waitForFunction(() => {
        const header = document.querySelector(".search-header");
        const box = header.getBoundingClientRect();
        const inside = [...header.children].every(child => {
          const rect = child.getBoundingClientRect();
          return !child.getClientRects().length || (rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5);
        });
        return box.height > 40 && header.scrollWidth <= header.clientWidth && inside;
      }, { polling: 50, timeout: 5_000 }).then(() => true, () => false),
      switchInside: await tab.evaluate(() => {
        const rect = document.getElementById("search-clipboard").getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth;
      }) };
      await tab.setViewport({ width: 600, height: 640 });
      // The arrow keys walk the list, which stays put: Words after Sentences…,
      // then Sentences… and Kanji before it.
      await tab.focus("#search-template");
      await tab.keyboard.press("ArrowDown");
      const down = await settled(current => current.order[0] === "e2e-words" && current.copy.value === "e2e-words");
      await tab.keyboard.press("ArrowUp");
      await tab.keyboard.press("ArrowUp");
      const up = await settled(current => current.order[0] === "e2e-kanji" && current.copy.value === "e2e-kanji");
      // A pointer choice made from the frame hands focus back to it.
      await frame.focus("#search-input");
      await tab.click("#search-template");
      await tab.select("#search-template", id);
      const pointed = await settled(current => current.order[0] === id && current.copy.value === id && current.frameFocused);
      const same = (left, right) => ["x", "y", "width", "height"].every(key => Math.abs(left[key] - right[key]) < 0.5);
      evidence = { single, listed, narrow, down, up, pointed, apiKey: (await storedAnki()).apiKey === original.apiKey,
        aligned: same(listed.shell.rect, listed.copy.rect) };
    } finally {
      await writeOptions({ anki: await page.evaluate(anki => globalThis.HDReaderOptions.normaliseAnki(anki), original) });
      await tab.close();
    }
    const { single, listed, narrow, down, up, pointed } = evidence;
    const id = original.templates[0].id;
    check("the search page's Anki Template switch is hidden with one Template; with more, it lists them by name over the frame's invisible copy without wrapping the 600-pixel window's header or overflowing a 320-pixel one, and a choice by key or pointer becomes the built-in Template as Set built-in makes it",
      single.shell.hidden && single.copy.hidden
        && !listed.shell.hidden && listed.shell.name === "Anki Template" && listed.shell.heading === "Anki Template"
        && JSON.stringify(listed.shell.choices) === '["Kanji","Sentences with audio and a picture","Words"]'
        && listed.shell.value === id && JSON.stringify(listed.copy.lines) === "[1,1]" && narrow.copy && narrow.switchInside
        && listed.copy.visibility === "hidden" && listed.copy.value === id && evidence.aligned
        && JSON.stringify(down.order) === JSON.stringify(["e2e-words", id, "e2e-kanji"]) && down.shell.focused
        && down.copy.value === "e2e-words"
        && JSON.stringify(up.order) === JSON.stringify(["e2e-kanji", id, "e2e-words"]) && up.shell.focused
        && JSON.stringify(pointed.order) === JSON.stringify([id, "e2e-kanji", "e2e-words"]) && pointed.frameFocused
        && pointed.copy.value === id && evidence.apiKey,
      JSON.stringify(evidence));
  });

  // Design → Custom JavaScript on the search page (#644). Chrome runs no user
  // script in an extension page, so the page is a sandboxed frame, which runs
  // the script that web pages run, and only where they run it: once the user
  // allows user scripts on chrome://extensions and the worker has registered it.
  step("Custom JavaScript on the search page", async () => {
    const script = `document.documentElement.dataset.customScript = "ran";
      setInterval(() => {
        const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
        if (popup && !popup.hidden) popup.dataset.customScript = "reached";
      }, 50);`;
    // Chrome 138 added Allow User Scripts to the extension's details page;
    // before it, as in the manifest-minimum Chrome 128, Developer mode allowed them.
    const perExtension = Number(/Chrome\/(\d+)/u.exec(await browser.version())[1]) >= 138;
    const allowUserScripts = async allowed => {
      const extensions = await browser.newPage();
      try {
        await extensions.goto(`chrome://extensions/?id=${extensionId}`, { waitUntil: "load" });
        await extensions.evaluate((id, allowed, perExtension) => (perExtension
          ? chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: allowed })
          : chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: allowed })),
        extensionId, allowed, perExtension);
      } finally {
        await extensions.close();
      }
    };
    // A search for 食べる on a new search page, and the marks the script left.
    const searched = async () => {
      const tab = await browser.newPage();
      try {
        await tab.setViewport({ width: 960, height: 760 });
        await tab.goto(searchUrl(), { waitUntil: "load" });
        const frame = await searchFrame(tab);
        await frame.waitForFunction(() => !document.getElementById("search-submit").disabled,
          { polling: 100, timeout: 15_000 });
        const popup = await popupReader(tab, 0, frameUrl());
        await searchFor(tab, "食べる");
        const result = await popup.waitForVisible(15_000, state => state.plain.includes("食べる"));
        await frame.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot
          ?.querySelector(".gsm-hoshidicts-popup")?.dataset.customScript, { polling: 50, timeout: 2_000 }).catch(() => {});
        return { shown: result !== null, ...await frame.evaluate(() => ({
          page: document.documentElement.dataset.customScript ?? null,
          popup: document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup")
            ?.dataset.customScript ?? null,
        })) };
      } finally {
        await tab.close();
      }
    };
    // A new reading page, where the worker's user script runs.
    const read = async () => {
      const tab = await browser.newPage();
      try {
        await tab.goto(pageUrl, { waitUntil: "load" });
        return await tab.waitForFunction(() => document.documentElement.dataset.customScript === "ran",
          { polling: 50, timeout: 1_000 }).then(() => true, () => false);
      } finally {
        await tab.close();
      }
    };
    let blocked, allowed, onPage = false;
    try {
      await writeOptions({ customPopupJavascript: script });
      blocked = await searched();
      await allowUserScripts(true);
      // The worker registers the saved script when the options next change,
      // for pages opened from then on.
      await writeOptions({ customPopupJavascript: `${script}\n` });
      for (let attempt = 0; attempt < 10 && !onPage; attempt += 1) onPage = await read();
      allowed = await searched();
    } finally {
      await writeOptions({ customPopupJavascript: originalOptions.customPopupJavascript });
      await allowUserScripts(false);
    }
    check("Custom JavaScript runs on the search page, where it reaches the docked result, only once Chrome allows user scripts, as on web pages",
      blocked.shown && blocked.page === null && blocked.popup === null
        && allowed.shown && allowed.page === "ran" && allowed.popup === "reached" && onPage,
      JSON.stringify({ blocked, allowed, onPage }));
  });
});
