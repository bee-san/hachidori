/*
 * Dictionary tabs, columns and clicked-kanji groups.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./nested.mjs";
import { describe } from "node:test";
import { applyAnkiPreset } from "../../extension/anki-templates.js";
import { AnkiConnectError, answerAnkiConnect } from "../anki-connect-fake.mjs";
import {
  dictionaryTabsFixture,
  GENERIC_KANJI_TITLE,
  kanjiGroupFixture,
  makePng,
} from "../make-fixture.mjs";
import { check, diagnostics, HIGHLIGHT_NAME, step } from "./harness.mjs";
import { hoverForPopup, popupReader } from "./popup-reader.mjs";
import { popup, tab } from "./reader.mjs";
import {
  browser,
  editSettingsControls,
  GENERIC_KANJI_SELECTION,
  installMediaArchive,
  installMediaReplyProbe,
  interceptFetches,
  page,
  restoreMediaReplyProbe,
  showSettingsSection,
} from "./session.mjs";

async function checkDictionaryTabsColumns(settings, tab, popup, browser) {
  const fixture = dictionaryTabsFixture();
  const titles = fixture.dictionaries.map(item => item.title);
  const [links, usage, examples, reference] = titles;
  const studyId = "e2e-tabs-study", examplesId = "e2e-tabs-examples", emptyId = "e2e-tabs-empty";
  const studyKey = `group:${studyId}`;
  const installed = [];
  const original = await settings.evaluate(() => chrome.storage.local.get(["options", "dictionaryState"]));
  const originalVerb = await tab.$eval("#verb", element => ({ html: element.innerHTML, style: element.getAttribute("style") }));
  const viewport = tab.viewport(), settingsViewport = settings.viewport();
  const child = await popupReader(tab, 1);
  const evidence = { projections: [], columns: [] };
  let worker, failure;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function until(read, predicate, description) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now() >= deadline) throw new Error(`${description}: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const status = () => settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
  const ready = () => until(status, value => value.ok && value.ready && !value.loading, "E8 native readiness");
  const optionsWrite = options => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, options);
  const presentation = (patches, groups) => settings.evaluate(async ({ patches, groups }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: dictionaryState.revision,
      dictionaries: dictionaryState.dictionaries.map(dictionary => ({ ...dictionary, ...patches[dictionary.title] })), groups });
    if (!reply.ok) throw new Error(reply.error);
    return reply.state;
  }, { patches, groups });
  const requests = () => worker.evaluate(() => globalThis.__ownedMediaProbe.requests);
  const rootState = () => popup.dictionaryTabs();
  const childState = () => child.dictionaryTabs();
  const imageReady = value => value?.images.length === 1 && value.images[0].complete
    && value.images[0].width === 16 && value.images[0].height === 16;
  const visible = value => value && !value.hidden && value.entries.length > 0;
  const selectedReady = key => value => visible(value) && value.selected === key;
  const bounded = value => value.rect.left >= 5 && value.rect.top >= 5
    && value.rect.right <= value.viewport.width - 5 && value.rect.bottom <= value.viewport.height - 5;
  async function setColumns(value) {
    await editSettingsControls(settings, { "opt-popup-columns": String(value) });
    await settings.waitForFunction(async value => (await chrome.storage.local.get("options")).options.popupColumns === value,
      { polling: 50, timeout: 10_000 }, value);
  }
  function packed(value, requested) {
    if (!visible(value) || !bounded(value) || !value.grids.length) return false;
    const near = (a, b) => Math.abs(a - b) <= 1;
    return value.grids.every(grid => {
      const columns = Math.min(requested, grid.cards.length), heights = Array(columns).fill(0);
      // The stylesheet's grid gap, which masonry must reuse between columns.
      const { gap } = grid;
      const width = (grid.width - gap * (columns - 1)) / columns;
      if (grid.width <= 0 || grid.masonry !== (columns > 1)) return false;
      for (const [index, card] of grid.cards.entries()) {
        const column = heights.indexOf(Math.min(...heights));
        const x = column * (width + gap), y = heights[column];
        if (!near(card.rect.width, width) || !near(card.rect.left - grid.rect.left, x)
            || !near(card.rect.top - grid.rect.top, y) || card.rect.right > grid.rect.right + 1) return false;
        if (columns === 1 && (card.width !== "" || card.transform !== "" || card.visibility !== "")) return false;
        if (columns > 1 && (card.visibility !== "visible" || !near(Number.parseFloat(card.width), width))) return false;
        for (const other of grid.cards.slice(0, index)) {
          if (Math.min(card.rect.right, other.rect.right) - Math.max(card.rect.left, other.rect.left) > 1
              && Math.min(card.rect.bottom, other.rect.bottom) - Math.max(card.rect.top, other.rect.top) > 1) return false;
        }
        heights[column] += (columns === 1 ? card.rect.height : card.offsetHeight) + gap;
      }
      return columns === 1 ? grid.height === ""
        : near(Number.parseFloat(grid.height), Math.max(...heights) - gap);
    });
  }
  async function openChild() {
    require((await popup.nested("focus-link"))?.linkFocused, "E8 parent source link focus");
    await tab.keyboard.press("Enter");
    return until(childState, value => selectedReady("all")(value) && imageReady(value), "E8 linked All view");
  }
  try {
    for (const dictionary of fixture.dictionaries) {
      await installMediaArchive(settings, dictionary.archive);
      installed.push(dictionary.title);
    }
    const initialStatus = await ready();
    await optionsWrite({ popupColumns: 1, popupNestingMaxDepth: 2, maxResults: 32, kanjiClickDictionary: GENERIC_KANJI_SELECTION });
    const packages = await settings.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState.dictionaries);
    const id = title => packages.find(dictionary => dictionary.title === title)?.id;
    require([...titles, GENERIC_KANJI_TITLE].every(title => id(title)), "E8 exact package identities");
    let groups = [
      { id: studyId, name: "Study", dictionaryIds: [id(links), id(usage), id(GENERIC_KANJI_TITLE)] },
      { id: examplesId, name: "Examples", dictionaryIds: [id(links), id(examples)] },
      { id: emptyId, name: "Empty", dictionaryIds: [id(GENERIC_KANJI_TITLE)] },
    ];
    await presentation(Object.fromEntries(titles.map((title, index) => [title,
      { displayName: ["Links", "Usage", "Examples", "Reference"][index], favorite: index === 0 || index === 3 }])), groups);
    // Current E2E also retains the generic 食/しょく package. The native reply
    // includes that prefix, but an internal link displays only its full target.
    evidence.native = await settings.evaluate(async ({ root, child, reading }) => {
      const { options } = await chrome.storage.local.get("options");
      const lookup = (text, primaryReading) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup",
        text, maxResults: options.maxResults, scanLength: options.scanLength,
        options: { frequencyDictionary: options.frequencyDictionary, frequencyOrder: options.frequencyOrder, primaryReading } });
      return { root: await lookup(root, ""), child: await lookup(child, reading) };
    }, { root: fixture.query, child: fixture.child, reading: fixture.reading });
    require(evidence.native.root.ok && evidence.native.child.ok
      && evidence.native.root.results.length === 1
      && equal(evidence.native.root.results[0].term.glossaries.map(glossary => glossary.dictionary), titles), "E8 native four-card root");
    const childExpected = evidence.native.child.results.filter(result => result.matched === fixture.child).map(({ term }) => ({
      expression: term.expression, aria: term.reading && term.reading !== term.expression ? `${term.expression}, ${term.reading}` : term.expression,
      dictionaries: [...new Set(term.glossaries.map(glossary => glossary.dictionary))],
    }));
    require(evidence.native.child.results.some(result => result.matched !== fixture.child
        && result.term.glossaries.some(glossary => glossary.dictionary === GENERIC_KANJI_TITLE))
      && childExpected.length === 1 && childExpected[0].expression === fixture.child
      && childExpected[0].aria === `${fixture.child}, ${fixture.reading}`
      && equal(childExpected[0].dictionaries, [links]), "E8 exact child expression and reading exclude native prefixes");
    const completeChildBody = value => value?.entries.at(-1)?.cards.some(card => card.dictionary === links
      && card.text.some(text => text.includes("The referenced entry.")
        && text.includes("Continue to the final entry")));
    worker = await installMediaReplyProbe(browser, settings);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await tab.setViewport({ width: 1880, height: 960 });
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    const all = await until(rootState, value => selectedReady("all")(value) && imageReady(value), "E8 complete root");
    const expectedKeys = ["all", studyKey, `group:${examplesId}`, `dictionary:${reference}`];
    require(equal(all.tabs.map(tab => tab.key), expectedKeys)
      && equal(all.tabs.map(tab => tab.label), ["All", "Study", "Examples", "Reference"])
      && all.tabs.every(tab => tab.controls === all.panelId && tab.aria === tab.title)
      && all.labelledBy === all.tabs[0].id, "E8 semantic tabs and accessible panel linkage");
    const projectionStart = (await requests()).length;
    for (const [key, members] of [
      [studyKey, [links, usage]], [`group:${examplesId}`, [links, examples]],
      [`dictionary:${reference}`, [reference]], ["all", titles],
    ]) {
      await popup.dictionaryTabs("select", key);
      await until(rootState, selectedReady(key), `E8 projection ${key}`);
      const expected = all.entries.map(entry => ({ ...entry, cards: entry.cards.filter(card => members.includes(card.dictionary)) }));
      await until(() => popup.dictionaryTabs("matches", expected), Boolean, `E8 complete dictionary projection ${key}`);
      evidence.projections.push(key);
    }
    await popup.dictionaryTabs("remember");
    await popup.dictionaryTabs("select", "all");
    const noOp = await rootState();
    require(noOp.sameCards && noOp.samePanel && (await requests()).length === projectionStart, "E8 warmed tabs must stay local and same-tab must retain cards");

    // An internal link opens All even from Study. A child-local Study choice
    // then survives clicked-kanji → Back without changing its parent.
    await popup.dictionaryTabs("select", studyKey);
    await tab.setViewport({ width: 1880, height: 160 });
    const linked = await openChild();
    require(equal(linked.entries.map(entry => ({ expression: entry.expression, aria: entry.aria,
      dictionaries: entry.cards.map(card => card.dictionary) })), childExpected), "E8 linked All exact target");
    await child.dictionaryTabs("select", studyKey);
    const selectedChild = await until(childState, selectedReady(studyKey), "E8 child-local Study view");
    const studyResultCount = childExpected.filter(entry => entry.dictionaries.some(title => [links, usage, GENERIC_KANJI_TITLE].includes(title))).length;
    await until(childState, value => value?.entries.length === studyResultCount
      && completeChildBody(value), "E13 complete linked bodies");
    const beforeBack = await child.dictionaryTabs("scroll", 80);
    require(beforeBack.scrollTop > 0, "E13 nonzero prior scroll");
    const highlights = () => tab.evaluate(name => Array.from(CSS.highlights.get(name) ?? [], range => range.toString()), HIGHLIGHT_NAME);
    const previousHighlights = await highlights();
    require(await child.click(".gsm-hoshidicts-kanji-link"), "E8 clicked-kanji control");
    const kanji = await until(childState, value => selectedReady(studyKey)(value)
      && value.entries[0].cards[0].dictionary === GENERIC_KANJI_TITLE, "E8 clicked-kanji group context");
    await child.dictionaryTabs("select", "all");
    const beforeBackRequests = (await requests()).length;
    await optionsWrite({ customPopupCss: ".gsm-hoshidicts-popup { outline-color: rgb(12, 34, 56); }" });
    await until(childState, value => value.customOutline === "rgb(12, 34, 56)", "E18 live child CSS");
    evidence.cssChild = (await rootState()).customOutline === "rgb(12, 34, 56)";
    require(await child.click(".gsm-hoshidicts-kanji-back"), "E8 term Back");
    const back = await until(childState, value => selectedReady(studyKey)(value)
      && value.entries.length === beforeBack.entries.length && !value.showMore
      && Math.abs(value.scrollTop - beforeBack.scrollTop) < 1, "E13 complete linked Back viewport");
    evidence.back = back.toolbar === beforeBack.toolbar
      && await child.dictionaryTabs("matches", beforeBack.entries)
      && equal(await highlights(), previousHighlights)
      && (await requests()).length === beforeBackRequests;
    require(evidence.back, "E13 exact Back state and no native lookup");
    if (process.env.HACHIDORI_KANJI_BACK_SCREENSHOT) {
      const { x, y, width, height } = back.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_KANJI_BACK_SCREENSHOT, clip: { x, y, width, height } });
    }
    // The width follows Design live; the height is at most the Design value,
    // because in this 160px window a child fits on neither side of its source
    // link and is shortened beside it rather than covering it (issue #360).
    const childBesideLink = async () => ({ ...await childState(), link: (await popup.nested())?.linkRect });
    const sizedBesideLink = (width, height) => value => value.rect.width === Math.min(width, value.viewport.width - 12)
      && value.rect.height <= Math.min(height, value.viewport.height - 12) && Boolean(value.link)
      && (value.rect.top >= value.link.bottom || value.rect.bottom <= value.link.top);
    await optionsWrite({ popupWidthPx: 640, popupHeightPx: 480 });
    const resizedChild = await until(childBesideLink, sizedBesideLink(640, 480), "E15 live child dimensions");
    evidence.appearanceChild = bounded(resizedChild) && (await rootState()).rect.width === 640;
    await optionsWrite({ popupScalePercent: 75 });
    const scaledChild = await until(childState, value => value.rect.width === 480,
      "scaled child dimensions");
    require(scaledChild.rect.left >= 0 && scaledChild.rect.top >= 0
      && scaledChild.rect.right <= scaledChild.viewport.width && scaledChild.rect.bottom <= scaledChild.viewport.height
      && (await rootState()).rect.width === 480,
      "fractional scale applies once to both root and nested popups");
    await optionsWrite({ popupScalePercent: 100 });
    await until(childState, value => value.rect.width === 640, "restore child scale");
    const automaticRoot = (await rootState()).toolbar;
    // Automatic follows the child's own placement: a pane hanging below its
    // source link keeps the toolbar at the top, one rising above it at the
    // bottom. No pane covers its link.
    const sourceLink = (await popup.nested()).linkRect;
    const automaticChild = value => value.rect.top >= sourceLink.bottom ? ["top"]
      : value.rect.bottom <= sourceLink.top ? ["bottom"] : [];
    evidence.toolbarChild = true;
    for (const edge of ["bottom", "top", "auto"]) {
      await optionsWrite({ popupToolbarPosition: edge });
      await until(childState, value => (edge === "auto" ? automaticChild(value) : [edge]).includes(value.toolbar), "E16 child toolbar edge");
      evidence.toolbarChild &&= (await rootState()).toolbar === (edge === "auto" ? automaticRoot : edge);
    }
    await optionsWrite({ popupWidthPx: 560, popupHeightPx: 420 });
    await until(childBesideLink, sizedBesideLink(560, 420), "E15 restore child dimensions");
    require(await child.click(".gsm-hoshidicts-popup-close") && await child.waitForHidden(), "E8 close child lookup");
    await tab.setViewport({ width: 1880, height: 960 });
    evidence.inheritance = { linked: linked.selected, selectedChild: selectedChild.selected, kanji: kanji.selected, back: back.selected,
      parent: (await rootState()).selected };
    require(evidence.inheritance.linked === "all" && evidence.inheritance.selectedChild === studyKey
      && evidence.inheritance.kanji === studyKey && evidence.inheritance.back === studyKey
      && evidence.inheritance.parent === studyKey, "E8 linked default and child-local navigation preserve parent tab");
    require((await status()).generation === initialStatus.generation, "E8 presentation or tabs reloaded native dictionaries");

    const liveStart = (await requests()).length;
    await popup.dictionaryTabs("focus", studyKey);
    await popup.dictionaryTabs("remember");
    groups = [groups[1], { ...groups[0], name: "Reading list" }, groups[2]];
    await presentation({ [usage]: { displayName: "Usage notes" } }, groups);
    const renamed = await until(rootState, value => value?.tabs.some(tab => tab.key === studyKey && tab.label === "Reading list"), "E8 focused live labels");
    require(renamed.sameCards && renamed.samePanel && renamed.sameSelected && renamed.sameAnchor
      && renamed.tabs.filter(tab => tab.key.startsWith("group:")).map(tab => tab.key).join() === `group:${examplesId},${studyKey}`
      && renamed.tabs.every(tab => tab.same)
      && renamed.tabs.find(tab => tab.key === studyKey).focused
      && renamed.entries[0].cards.find(card => card.dictionary === usage).label === "Usage notes", `E8 labels/order preserve focused keyed controls and bodies: ${JSON.stringify(renamed)}`);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
    await popup.nested("remember");
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.heldLookups.length), count => count === 1, "E8 held child reply");
    groups = groups.map(group => group.id === studyId ? { ...group, name: "Learning" } : group);
    await presentation({}, groups);
    require((await popup.nested()).sameAnchor, "E8 pending child lost its parent anchor");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.heldLookups.splice(0)) release(); });
    const newest = await until(childState, value => selectedReady("all")(value)
      && value.tabs.find(tab => tab.key === studyKey)?.label === "Learning" && imageReady(value), "E8 pending child uses newest presentation");
    await child.dictionaryTabs("select", studyKey);
    const newestSelected = await until(childState, selectedReady(studyKey), "E8 newest child-local Study view");
    require(await popup.click(".gsm-hoshidicts-note-button"), "E8 parent Note");
    await popup.writeNote({ definition: "E8 protected presentation draft" });
    const draft = await popup.retainedControls("remember");
    await popup.dictionaryTabs("remember");
    groups = groups.map(group => group.id === studyId ? { ...group, dictionaryIds: [id(links), id(GENERIC_KANJI_TITLE)] } : group);
    await presentation({}, groups);
    // The real state event must have arrived: the child's same-membership label
    // changes too, while the protected parent still cannot replace its cards.
    groups = groups.map(group => group.id === studyId ? { ...group, name: "Focused learning" } : group);
    await presentation({}, groups);
    await until(childState, value => value?.tabs.find(tab => tab.key === studyKey)?.label === "Focused learning", "E8 protected state event delivered");
    const protectedView = await rootState(), protectedDraft = await popup.retainedControls();
    await optionsWrite({ customPopupCss: ".gsm-hoshidicts-popup { outline-color: rgb(56, 34, 12); }" });
    await until(rootState, value => value.customOutline === "rgb(56, 34, 12)", "E18 live root CSS");
    const cssDraft = await popup.retainedControls();
    evidence.css = evidence.cssChild && (await childState()).customOutline === "rgb(56, 34, 12)"
      && (await rootState()).sameCards && cssDraft.sameForm && cssDraft.mounted && cssDraft.inputFocused
      && cssDraft.draft === draft.draft && equal(cssDraft.selection, [2, 7]);
    await optionsWrite({ customPopupCss: "" });
    require(protectedView.sameCards && protectedView.samePanel && protectedView.sameAnchor
      && protectedView.entries[0].cards.length === 2 && protectedDraft.sameForm && protectedDraft.mounted
      && protectedDraft.inputFocused && protectedDraft.draft === draft.draft && equal(protectedDraft.selection, [2, 7]), "E8 live Note and child protect their original projection");
    await tab.keyboard.press("Escape");
    require((await popup.state()).noteOpen === false, "E8 Note must close before child retirement");
    require(await child.click(".gsm-hoshidicts-popup-close") && await child.waitForHidden(), "E8 protected child retirement");
    await popup.dictionaryTabs("focus", studyKey);
    const flushed = await until(rootState, value => selectedReady(studyKey)(value)
      && equal(value.entries[0].cards.map(card => card.dictionary), [links]), "E8 safe presentation flush");
    require(flushed.tabs.find(tab => tab.key === studyKey).focused, "E8 safe flush stole selected-tab focus");
    groups = groups.filter(group => group.id !== studyId);
    await presentation({}, groups);
    const fallback = await until(rootState, value => selectedReady("all")(value) && value.entries[0].cards.length === 4, "E8 removed selected group fallback");
    require(fallback.tabs.find(tab => tab.key === "all").focused, "E8 removed-group fallback focus");
    const liveRequests = (await requests()).slice(liveStart);
    require(liveRequests.length === 1 && liveRequests[0].type === "hd_lookup"
      && liveRequests[0].text === fixture.child && newest.selected === "all"
      && newestSelected.selected === studyKey, "E8 live presentation duplicated lookup/media/style work");
    evidence.live = { renamed, newest, newestSelected, protectedView, protectedDraft, flushed, fallback, liveRequests };

    // Columns must preserve mounted controls/cards; actual rects expose the
    // content-box width bug instead of accepting overlapping width styles.
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "E8 columns keep this exact draft" });
    const columnDraft = await popup.retainedControls("remember");
    await popup.dictionaryTabs("remember");
    const columnsStart = (await requests()).length;
    const toolbarEdges = [];
    for (const edge of ["bottom", "top"]) {
      await optionsWrite({ popupToolbarPosition: edge });
      await until(rootState, value => value.toolbar === edge, "E16 root toolbar edge");
      for (const size of [{ width: 520, height: 740 }, { width: 1880, height: 960 }]) {
        await tab.setViewport(size);
        const placed = await until(rootState, value => value.viewport.width === size.width && value.toolbar === edge,
          "E16 fixed edge survives resize");
        const controls = await popup.retainedControls();
        toolbarEdges.push(placed.sameCards && placed.samePanel && controls.sameForm && controls.mounted
          && controls.inputFocused && controls.draft === columnDraft.draft && equal(controls.selection, [2, 7]));
      }
    }
    await optionsWrite({ popupToolbarPosition: "auto" });
    evidence.toolbar = evidence.toolbarChild && toolbarEdges.every(Boolean) && (await requests()).length === columnsStart;
    const sourceSpan = await highlights();
    const pageTheme = await tab.evaluate(() => ({ theme: document.documentElement.getAttribute("data-hoshidicts-theme"),
      style: document.documentElement.getAttribute("style") }));
    await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await optionsWrite({ popupTheme: "auto" });
    const automaticThemes = [];
    for (const scheme of ["light", "dark"]) {
      await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await tab.waitForFunction(expected =>
        document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === expected, {}, scheme);
      automaticThemes.push(await tab.$eval("hachidori-host", host => host.dataset.hoshidictsTheme));
    }
    const automaticDraft = await popup.retainedControls();
    await tab.emulateMediaFeatures([]);
    await optionsWrite({ popupTheme: "high-contrast", popupOpacityPercent: 0, sourceHighlightEnabled: false });
    await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "high-contrast"
      && !CSS.highlights.has("gsm-hoshidicts-match"));
    await optionsWrite({ sourceHighlightEnabled: true });
    await until(highlights, value => equal(value, sourceSpan), "E15 restore the exact current source highlight");
    const appearance = await tab.evaluate(() => {
      const host = document.querySelector("hachidori-host");
      return { primary: getComputedStyle(host).getPropertyValue("--hoshidicts-palette-primary").trim(),
        opacity: host.style.getPropertyValue("--gsm-hoshidicts-popup-opacity"),
        highlight: getComputedStyle(document.getElementById("verb"), "::highlight(gsm-hoshidicts-match)").backgroundColor,
        theme: document.documentElement.getAttribute("data-hoshidicts-theme"),
        style: document.documentElement.getAttribute("style") };
    });
    const appearanceDraft = await popup.retainedControls();
    evidence.appearance = evidence.appearanceChild && JSON.stringify(automaticThemes) === '["light","dark"]'
      && automaticDraft.sameForm && automaticDraft.inputFocused && automaticDraft.draft === columnDraft.draft
      && appearance.primary === "#ffe000" && appearance.opacity === "0%"
      && appearance.highlight.endsWith(" / 0.56)") && appearance.theme === pageTheme.theme && appearance.style === pageTheme.style
      && appearanceDraft.sameForm && appearanceDraft.inputFocused && appearanceDraft.draft === columnDraft.draft
      && (await rootState()).sameCards && (await requests()).length === columnsStart;
    await optionsWrite({ popupTheme: "default", popupOpacityPercent: 85 });
    for (const columns of [1, 2, 3, 4, 1]) {
      await setColumns(columns);
      const geometry = await until(rootState, value => packed(value, columns), `E8 ${columns}-column geometry`);
      const controls = await popup.retainedControls();
      require(geometry.sameCards && geometry.samePanel && controls.sameForm && controls.mounted && controls.inputFocused
        && controls.draft === columnDraft.draft && equal(controls.selection, [2, 7]), "E8 column update replaced a mounted draft or card");
      evidence.columns.push({ columns, geometry, controls });
    }
    await setColumns(3);
    for (const size of [{ width: 520, height: 740 }, { width: 1880, height: 960 }]) {
      await tab.setViewport(size);
      const geometry = await until(rootState, value => value.viewport.width === size.width && packed(value, 3), "E8 focused resize geometry");
      require(geometry.sameCards && (await popup.retainedControls()).inputFocused, "E8 resize changed focused Note ownership");
    }
    require((await requests()).length === columnsStart, "E8 columns or resize issued dictionary resource work");
    await setColumns(2);
    await tab.keyboard.press("Escape");
    require(!(await popup.state()).noteOpen, "E8 finished column draft did not close");
    const screenshotView = await until(rootState, value => packed(value, 2), "E8 two-column reader capture");
    if (process.env.HACHIDORI_TABS_SCREENSHOT) {
      const { x, y, width, height } = screenshotView.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_TABS_SCREENSHOT, clip: { x, y, width, height } });
    }
    if (process.env.HACHIDORI_OPTIONS_SCREENSHOT || process.env.HACHIDORI_OPTIONS_DARK_SCREENSHOT) {
      await settings.bringToFront();
      await settings.setViewport({ width: 1280, height: 1000 });
      await showSettingsSection(settings, "lookup");
      for (const [scheme, path] of [["light", process.env.HACHIDORI_OPTIONS_SCREENSHOT], ["dark", process.env.HACHIDORI_OPTIONS_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await (await settings.$("#lookup")).screenshot({ path });
      }
    }
    // Retire the old view before importing a cold generation and arming the
    // real media reply hold; a protected Note would deliberately prevent rehover.
    await tab.bringToFront();
    require(!(await popup.state()).noteOpen, "E8 cold media setup retained Note");
    await tab.keyboard.press("Escape");
    require(await popup.waitForHidden(), "E8 cold media setup retained popup");
    await installMediaArchive(settings, fixture.archive);
    await ready();
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = true; });
    await hoverForPopup(tab, popup, "#verb");
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.held.length), count => count === 1, "E8 held real media");
    const loading = await until(rootState, value => packed(value, 2) && value.images.length === 1 && value.images[0].src === "", "E8 reserved pending-image geometry");
    await popup.dictionaryTabs("remember");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.held.splice(0)) release(); });
    const loaded = await until(rootState, value => packed(value, 2) && imageReady(value), "E8 decoded media reflow");
    require(loaded.sameCards && loaded.images[0].src === `data:image/png;base64,${makePng().toString("base64")}`, "E8 media reflow changed card or bytes");
    await popup.nested("remember");
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    await until(childState, value => selectedReady("all")(value) && imageReady(value), "E8 All exact linked child");
    const expanded = await until(childState, value => value?.entries.length === childExpected.length && packed(value, 2)
      && completeChildBody(value), "E8 complete exact linked bodies");
    require(equal(expanded.entries.map(entry => ({ expression: entry.expression, aria: entry.aria,
      dictionaries: entry.cards.map(card => card.dictionary) })), childExpected), "E8 exact linked expression/reading/dictionary order");
    await child.dictionaryTabs("remember");
    await child.click(".gsm-hoshidicts-note-button");
    await child.writeNote({ definition: "E8 child holds its anchor through resize" });
    const childDraft = await child.retainedControls("remember");
    const nestedResizeStart = (await requests()).length;
    for (const size of [{ width: 520, height: 740 }, { width: 1880, height: 960 }]) {
      await tab.setViewport(size);
      const resized = await until(childState, value => value?.viewport.width === size.width && packed(value, 2), "E8 complete linked child resize");
      const controls = await child.retainedControls();
      require(resized.sameCards && await child.dictionaryTabs("matches", expanded.entries)
        && (await popup.nested()).sameAnchor && controls.sameForm && controls.mounted
        && controls.inputFocused && controls.draft === childDraft.draft, "E8 child resize replaced complete results, Note or parent anchor");
    }
    require((await requests()).length === nestedResizeStart, "E8 child resize issued extra resource work");
    evidence.media = { loading, loaded, expanded };
    evidence.passed = true;
  } catch (error) {
    failure = error;
  } finally {
    // Complete every owned cleanup even if setup failed halfway, while retaining
    // both the original error and any cleanup error rather than swallowing either.
    const errors = [];
    const clean = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    if (worker) await clean(() => restoreMediaReplyProbe(worker));
    await clean(() => child.dictionaryTabs("cleanup"));
    await clean(() => popup.dictionaryTabs("cleanup"));
    await clean(() => optionsWrite({ popupColumns: original.options.popupColumns ?? 1,
      popupTheme: original.options.popupTheme ?? "default", popupOpacityPercent: original.options.popupOpacityPercent ?? 85,
      popupWidthPx: original.options.popupWidthPx ?? 560, popupHeightPx: original.options.popupHeightPx ?? 420,
      sourceHighlightEnabled: original.options.sourceHighlightEnabled ?? true,
      popupNestingMaxDepth: original.options.popupNestingMaxDepth ?? 10, maxResults: original.options.maxResults,
      kanjiClickDictionary: original.options.kanjiClickDictionary }));
    for (const title of installed) await clean(async () => {
      const reply = await settings.evaluate(title => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_remove", title }), title);
      if (!reply.ok) throw new Error(reply.error);
    });
    await clean(() => presentation({}, original.dictionaryState.groups ?? []));
    await clean(() => tab.$eval("#verb", (element, original) => {
      element.innerHTML = original.html;
      if (original.style === null) element.removeAttribute("style"); else element.setAttribute("style", original.style);
    }, originalVerb));
    await clean(() => tab.setViewport(viewport));
    await clean(() => settings.setViewport(settingsViewport));
    await clean(() => settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]));
    await clean(async () => {
      await tab.bringToFront();
      // At most the two deliberate Note forms and two live levels remain.
      for (let index = 0; index < 4 && !(await popup.waitForHidden(1)); index++) await tab.keyboard.press("Escape");
      require(await popup.waitForHidden(), "E8 cleanup retained its popup");
    });
    if (errors.length) failure = new AggregateError(failure ? [failure, ...errors] : errors, "E8 scenario/cleanup failure");
  }
  if (failure) throw failure;
  check("Back restores complete linked results, exact tab, scroll, highlight and toolbar without lookup",
    evidence.back === true, JSON.stringify(evidence.inheritance));
  check("Popup tabs project ordered groups and ungrouped favourites without another lookup",
    evidence.passed && evidence.projections.length === 4, JSON.stringify({ projections: evidence.projections, inheritance: evidence.inheritance }));
  check("Live dictionary presentation preserves pending replies, focused Note drafts and child anchors",
    evidence.passed && evidence.live.liveRequests.length === 1, JSON.stringify(evidence.live));
  check("Saved popup columns reflow complete cards after expansion, media load and resize",
    evidence.passed && evidence.columns.length === 5, JSON.stringify({ columns: evidence.columns, media: evidence.media }));
  check("live appearance changes preserve reader Notes and resources while applying the selected page highlight",
    evidence.passed && evidence.appearance === true, JSON.stringify({ appearance: evidence.appearance, child: evidence.appearanceChild }));
  check("live toolbar overrides apply to root and child and survive resize without focus or resource loss",
    evidence.passed && evidence.toolbar === true, JSON.stringify({ toolbar: evidence.toolbar, child: evidence.toolbarChild }));
  check("live custom CSS updates root and child without losing Notes, Back or making engine requests",
    evidence.passed && evidence.css && evidence.back && evidence.live.liveRequests.length === 1,
    JSON.stringify({ css: evidence.css, child: evidence.cssChild }));
}

async function checkKanjiGroup(settings, tab, popup, browser) {
  const fixture = kanjiGroupFixture();
  const [first, terms, second] = fixture.dictionaries.map(dictionary => dictionary.title);
  const groupId = "e2e-kanji-group";
  const groupValue = JSON.stringify({ kind: "tabGroup", id: groupId });
  const original = await settings.evaluate(() => chrome.storage.local.get(["options", "dictionaryState"]));
  const installed = [], evidence = {}, sessions = [];
  let failure;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // A Kiku note type behind a mocked AnkiConnect (#333): the group's native
  // card is mined through the real preflight, field builder and submission.
  const kikuFields = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "RelatedExpression",
    "SelectionText", "MainDefinition", "DefinitionPicture", "Sentence", "SentenceFurigana", "SentenceTranslation",
    "SentenceAudio", "Picture", "Glossary", "Hint", "IsWordAndSentenceCard", "IsClickCard", "IsSentenceCard",
    "IsAudioCard", "PitchPosition", "PitchCategories", "Frequency", "FreqSort", "MiscInfo"];
  const ankiCalls = [], ankiNotes = [];
  const ankiRoute = { requests: 0, async respond(request) {
    const reply = await answerAnkiConnect(JSON.parse(request.postData), async (action, params) => {
      ankiCalls.push(action);
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Kiku"];
      if (action === "modelNamesAndIds") return { Kiku: 1 };
      if (action === "modelFieldNames") return kikuFields;
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      if (action === "findNotes" || action === "notesInfo" || action === "getMediaFilesNames") return [];
      if (action === "storeMediaFile") return params.filename;
      if (action === "addNote") { ankiNotes.push(params.note.fields); return ankiNotes.length; }
      throw new AnkiConnectError(`Unexpected Anki action ${action}`);
    });
    return { body: JSON.stringify(reply), status: 200, contentType: "application/json" };
  } };
  async function until(read, predicate, description) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now() >= deadline) throw new Error(`${description}: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const status = () => settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
  const storedOptions = () => settings.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const optionsWrite = options => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, options);
  const groups = groups => settings.evaluate(async groups => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: dictionaryState.revision, dictionaries: dictionaryState.dictionaries, groups });
    if (!reply.ok) throw new Error(reply.error);
    return reply.state;
  }, groups);
  const chooser = () => settings.evaluate(() => {
    const select = document.getElementById("opt-kanji-dictionary");
    return { value: select.value, groups: [...select.querySelectorAll("optgroup[label=Groups] option")]
      .map(option => [option.textContent, option.value]) };
  });
  const view = () => popup.dictionaryTabs();
  const visible = value => value && !value.hidden && value.entries.length > 0;
  try {
    for (const dictionary of fixture.dictionaries) {
      await installMediaArchive(settings, dictionary.archive);
      installed.push(dictionary.title);
    }
    await until(status, value => value.ok && value.ready && !value.loading, "kanji group: native readiness");
    const packages = await settings.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState.dictionaries);
    const id = title => packages.find(dictionary => dictionary.title === title)?.id;
    require(fixture.dictionaries.every(dictionary => id(dictionary.title)), "kanji group: exact package identities");
    await groups([...original.dictionaryState.groups ?? [],
      { id: groupId, name: "Kanji group", dictionaryIds: [id(first), id(terms), id(second)] }]);

    // The Design section's chooser offers the group and saves its stable ID.
    await showSettingsSection(settings, "design");
    evidence.chooser = await until(chooser, value => value.groups.some(([, value]) => value === groupValue), "kanji group: chooser lists the group");
    await settings.select("#opt-kanji-dictionary", groupValue);
    await until(storedOptions, value => value.kanjiClickDictionary?.kind === "tabGroup" && value.kanjiClickDictionary.id === groupId, "kanji group: saved selection");
    // Inventory updates reach a focused chooser on focusout; the group is
    // deleted from another view, so leave the control as a user would.
    await settings.evaluate(() => document.activeElement?.blur());
    if (process.env.HACHIDORI_KANJI_GROUP_SETTINGS_SCREENSHOT) {
      await settings.bringToFront();
      const field = await settings.evaluateHandle(() => document.getElementById("opt-kanji-dictionary").closest(".field"));
      await field.screenshot({ path: process.env.HACHIDORI_KANJI_GROUP_SETTINGS_SCREENSHOT });
    }

    // Clicking 食 in 食べたかった asks every member at once: the two native
    // entries merge into one entry, the term entry keeps its reading, and every
    // member is a tab in group order. The ordinary fixture's own native entry
    // for 食 stays out of the group's view.
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    require(await popup.click(".gsm-hoshidicts-kanji-link"), "kanji group: clicked-kanji control");
    const all = await until(view, value => visible(value) && value.tabs.length === 4 && value.selected === "all"
      && value.entries.length === 2 && !value.showMore, "kanji group: member tabs and both entries");
    evidence.all = { tabs: all.tabs.map(tab => [tab.key, tab.label]), entries: all.entries.map(entry => [entry.expression,
      entry.cards.map(card => card.dictionary)]), showMore: all.showMore, text: all.entries[0].cards.map(card => card.text.join("")) };
    if (process.env.HACHIDORI_KANJI_GROUP_SCREENSHOT) {
      const { x, y, width, height } = all.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_KANJI_GROUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    await popup.dictionaryTabs("select", `dictionary:${terms}`);
    const projected = await until(view, value => visible(value) && value.selected === `dictionary:${terms}`, "kanji group: term member tab");
    evidence.terms = { entries: projected.entries.map(entry => [entry.expression, entry.cards.map(card => card.dictionary)]),
      text: projected.entries[0].cards.map(card => card.text).join(), showMore: projected.showMore };
    require(await popup.click(".gsm-hoshidicts-kanji-back"), "kanji group: Back");
    await until(() => popup.state(), value => value && !value.hidden && value.text.includes("to eat"), "kanji group: Back restores the verb");
    evidence.passed = true;

    // With Anki configured, the native card's mining control settles to ready
    // and Add mines the character with the kanji dictionary's card.
    for (const url of ["/background.js", "/offscreen.html"]) {
      const target = await browser.waitForTarget(candidate => candidate.url().endsWith(url));
      sessions.push(await interceptFetches(target, new Map([["http://127.0.0.1:8765/", ankiRoute]]), "kanji-group-anki"));
    }
    const diagnosticsStart = diagnostics.length;
    await optionsWrite({ anki: applyAnkiPreset({ ...original.options.anki, deck: "Default", model: "Kiku" }, kikuFields, "kiku") });
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    require(await popup.click(".gsm-hoshidicts-kanji-link"), "kanji group Anki: clicked-kanji control");
    await until(view, value => visible(value) && value.entries.length === 2, "kanji group Anki: group view");
    const settledAnki = await until(() => popup.anki(), value => value?.controls.length === 2
      && value.controls.every(control => !["checking", undefined].includes(control.state)), "kanji group Anki: settled controls");
    evidence.anki = { controls: settledAnki.controls.map(control => [control.state, control.title]), feedback: settledAnki.feedback };
    require(await popup.click(".gsm-hoshidicts-mine-button"), "kanji group Anki: Add");
    await until(() => ankiNotes.length, count => count === 1, "kanji group Anki: addNote");
    const [note] = ankiNotes;
    evidence.anki.note = { Expression: note.Expression, ExpressionReading: note.ExpressionReading,
      PitchCategories: note.PitchCategories, PitchPosition: note.PitchPosition, FreqSort: note.FreqSort,
      glossary: note.Glossary.includes("kanji-group first meaning") && note.Glossary.includes("ショク · ジキ"),
      mainDefinition: note.MainDefinition.includes("kanji-group first meaning") };
    evidence.anki.exceptions = diagnostics.slice(diagnosticsStart).filter(line => /exception|TypeError/u.test(line));
    require(await popup.click(".gsm-hoshidicts-kanji-back"), "kanji group Anki: Back");
    await optionsWrite({ anki: original.options.anki });

    // Removing the group resets the option, in the worker and in the open Settings page.
    await groups(original.dictionaryState.groups ?? []);
    evidence.reset = await until(async () => ({ stored: (await storedOptions()).kanjiClickDictionary, chooser: await chooser() }),
      value => value.stored === "" && value.chooser.value === "", "kanji group: removed group resets the option");
  } catch (error) {
    failure = error;
  } finally {
    const errors = [];
    const clean = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    await clean(() => optionsWrite({ kanjiClickDictionary: original.options.kanjiClickDictionary, anki: original.options.anki }));
    for (const session of sessions) await clean(() => session.detach());
    for (const title of installed) await clean(async () => {
      const reply = await settings.evaluate(title => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_remove", title }), title);
      if (!reply.ok) throw new Error(reply.error);
    });
    await clean(() => groups(original.dictionaryState.groups ?? []));
    await clean(async () => {
      await tab.bringToFront();
      await tab.keyboard.press("Escape");
      require(await popup.waitForHidden(), "kanji group: cleanup retained its popup");
    });
    if (errors.length) failure = new AggregateError(failure ? [failure, ...errors] : errors, "kanji group scenario/cleanup failure");
  }
  if (failure) throw failure;
  check("a clicked-kanji group shows each member with an entry as its own tab in group order",
    evidence.passed
      && equal(evidence.all.tabs, [["all", "All"], [`dictionary:${first}`, first], [`dictionary:${terms}`, terms], [`dictionary:${second}`, second]])
      && equal(evidence.all.entries, [[fixture.character, [first, second]], [fixture.character, [terms]]])
      && evidence.all.text[0].includes("kanji-group first meaning") && evidence.all.text[0].includes("ショク · ジキ")
      && evidence.all.text[1].includes("kanji-group second meaning")
      && equal(evidence.terms.entries, [[fixture.character, [terms]]]) && evidence.terms.text.includes(fixture.termGlossary),
    JSON.stringify(evidence));
  check("the clicked-kanji chooser saves a group by its stable ID and resets when the group is removed",
    evidence.passed && evidence.chooser.groups.some(([label, value]) => label === "Kanji group" && value === groupValue)
      && evidence.reset?.stored === "" && evidence.reset.chooser.value === "",
    JSON.stringify({ chooser: evidence.chooser, reset: evidence.reset }));
  check("a clicked-kanji group's native kanji card keeps a ready Anki mining control and mines as the character",
    evidence.anki?.controls.every(([state]) => state === "ready") && evidence.anki.feedback?.hidden === true
      && equal(evidence.anki.note, { Expression: fixture.character, ExpressionReading: "", PitchCategories: "",
        PitchPosition: "", FreqSort: "9999999", glossary: true, mainDefinition: true })
      && evidence.anki.exceptions.length === 0,
    JSON.stringify(evidence.anki));
}

describe("dictionary tabs and kanji groups", () => {
  step("dictionary tabs and columns", async () => {
    await checkDictionaryTabsColumns(page, tab, popup, browser);
  });

  step("clicked-kanji groups", async () => {
    await checkKanjiGroup(page, tab, popup, browser);
  });
});
