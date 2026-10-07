/*
 * The Design preview.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { EXTENSION, EXTENSION_ORIGIN, loadJsdom } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function designPreviewStage() {
  const jsdom = await loadJsdom();
  if (!jsdom) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "design-preview.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/design-preview.html`,
  });
  const { window } = dom;
  try {
    window.chrome = { runtime: { getURL: path => `${EXTENSION_ORIGIN}/${path}` } };
    window.fetch = async url => ({ ok: true,
      text: async () => readFileSync(resolve(EXTENSION, new URL(url).pathname.slice(1)), "utf8"),
      blob: async () => new window.Blob([readFileSync(resolve(EXTENSION, "sample-meal.svg"))], { type: "image/svg+xml" }),
    });
    window.URL.createObjectURL = () => "blob:sample-meal";
    window.CSS = { highlights: new Map() };
    window.Highlight = class extends Set { constructor(...ranges) { super(ranges); } };
    for (const file of ["reader-options.js", "render/glossary.js", "render/popup.js", "theme-host.js", "visual-novel.js", "design-preview.js"]) {
      window.eval(readFileSync(resolve(EXTENSION, file), "utf8"));
    }
    let earlyLoad = true;
    window.addEventListener("error", event => { earlyLoad = false; event.preventDefault(); });
    await new Promise(done => window.setTimeout(done, 60));
    // jsdom does not implement constructed sheets. The browser suite proves
    // CSS parsing/cascade; this double counts ownership and no-op work only.
    let parses = 0;
    window.CSSStyleSheet = class { replaceSync(text) { this.text = text; parses += 1; } };
    const shadow = window.document.getElementById("preview-host").shadowRoot;
    let sheets = [];
    let attachments = 0;
    Object.defineProperty(shadow, "adoptedStyleSheets", {
      get: () => sheets, set(value) { sheets = value; attachments += 1; },
    });
    let cssOwner = false;
    if (window.HDPopup.createCustomPopupStyle) {
      const base = {};
      shadow.adoptedStyleSheets = [base];
      const owner = window.HDPopup.createCustomPopupStyle(shadow);
      const empty = !owner.update("") && parses === 0 && attachments === 1;
      const first = owner.update(".gsm-hoshidicts-popup { color: red; }");
      const sheet = sheets.at(-1);
      const unchanged = !owner.update(sheet.text) && parses === 1 && attachments === 2;
      const second = owner.update("invalid CSS");
      cssOwner = empty && first && unchanged && second && sheets[0] === base && sheets.at(-1) === sheet
        && parses === 2 && attachments === 2 && owner.update("") && sheets.length === 1;
      owner.update("b { color: blue; }");
      owner.destroy();
      cssOwner &&= sheets.length === 1 && sheets[0] === base;
      parses = 0;
    }
    let state = { revision: 0, dictionaries: [], groups: [] };
    let options = { ...window.HDReaderOptions.DEFAULT_OPTIONS };
    const update = () => window.HDDesignPreview.update(options, state);
    const settle = () => new Promise(done => window.setTimeout(done, 60));
    update();
    await settle();
    parses = 0;
    const popup = window.document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
    const query = selector => popup.querySelector(selector);
    const card = query(".gsm-hoshidicts-glossary-card");
    const sample = popup.textContent.includes("食べる")
      && query('.gsm-hoshidicts-tag-frequency[data-dictionary="Sample ranks"] .gsm-hoshidicts-frequency-values')?.textContent === "120 · 240"
      && !query(".gsm-hoshidicts-frequency-source")
      && query(".gloss-image-link")?.dataset.imageLoadState === "loaded"
      // The engine's { position: 0, pattern: "LHL" } reads as Yomitan's [2].
      && [...popup.querySelectorAll(".gsm-hoshidicts-tag-pitch .pronunciation-character")].map(mora => mora.textContent).join("") === "たべる"
      && query(".gsm-hoshidicts-tag-pitch .pronunciation-downstep-notation")?.textContent === "[2]"
      && query(".gsm-hoshidicts-tag-ipa")?.textContent === "ta̠be̞ɾɯ̟ᵝ"
      && query(".pronunciation-group-tag-list > .gsm-hoshidicts-pitch-source")?.textContent === "Sample pitch"
      && query(".gsm-hoshidicts-tag-pitch")?.title === "Sample pitch: たべる [2]";
    query(".gsm-hoshidicts-note-button").click();
    const form = query("form");
    form.elements.definition.value = "A preview draft";
    const source = window.document.getElementById("preview-source");
    const sourceRect = source.getBoundingClientRect.bind(source);
    let cssPlacements = 0;
    source.getBoundingClientRect = () => { cssPlacements += 1; return sourceRect(); };
    options = { ...options, customPopupCss: ".gsm-hoshidicts-popup { color: red; }" };
    update();
    await settle();
    const cssPreview = parses === 1 && cssPlacements === 1 && query("form") === form
      && query(".gsm-hoshidicts-glossary-card") === card;
    source.getBoundingClientRect = sourceRect;
    options = { ...options, showPitchAccentDictionaryNames: false };
    update();
    await settle();
    const unlabelledPitch = Boolean(query(".gsm-hoshidicts-tag-pitch")) && !query(".gsm-hoshidicts-pitch-source")
      && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form;
    options = { ...options, showFrequencyDictionaryNames: false, showPitchAccentBadge: false,
      showCompactDefinitionSummary: true, popupColumns: 2 };
    update();
    await settle();
    let incremental = unlabelledPitch && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form
      && form.elements.definition.value === "A preview draft" && !query(".gsm-hoshidicts-tag-pitch")
      && !!query(".gsm-hoshidicts-compact-definition-summary");
    const audioControl = query(".gsm-hoshidicts-audio-control");
    options = { ...options, audioSources: [] };
    update();
    incremental &&= audioControl.hidden && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form;
    options = { ...options, audioSources: window.HDReaderOptions.DEFAULT_OPTIONS.audioSources };
    update();
    await settle();
    incremental &&= !audioControl.hidden && query(".gsm-hoshidicts-audio-control") === audioControl;
    let mutations = 0;
    const observer = new window.MutationObserver(records => { mutations += records.length; });
    observer.observe(popup, { subtree: true, childList: true, attributes: true, characterData: true });
    update();
    await settle();
    incremental &&= mutations === 0;
    observer.disconnect();
    const countLine = () => query(".gsm-hoshidicts-lookup-stats");
    let counts = countLine()?.hidden === false && countLine().textContent === "Looked up 3 times";
    options = { ...options, showLookupCounts: false };
    update();
    await settle();
    counts &&= countLine()?.hidden === true && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form;
    options = { ...options, showLookupCounts: true };
    update();
    await settle();
    counts &&= countLine()?.hidden === false && countLine().textContent === "Looked up 3 times"
      && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form;
    const blurState = () => popup.dataset.definitionBlurState ?? "revealed";
    let blur = blurState() === "revealed";
    options = { ...options, definitionBlurCountEnabled: true, definitionBlurDirection: "below", definitionBlurThreshold: 5,
      definitionBlurReveal: "hover" };
    update();
    await settle();
    blur &&= blurState() === "blurred" && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form;
    query(".gsm-hoshidicts-definitions").dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    blur &&= blurState() === "revealed";
    options = { ...options, definitionBlurThreshold: 4 };
    update();
    await settle();
    blur &&= blurState() === "blurred";
    options = { ...options, definitionBlurDirection: "atLeast" };
    update();
    await settle();
    blur &&= blurState() === "revealed" && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form;
    options = { ...options, definitionBlurCountEnabled: false };
    update();
    await settle();
    options = { ...options, showLookupCounts: false, definitionBlurAnkiMature: true };
    update();
    await settle();
    blur &&= blurState() === "blurred" && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form;
    options = { ...options, showLookupCounts: true, definitionBlurAnkiMature: false };
    update();
    await settle();
    blur &&= blurState() === "revealed";
    options = { ...options, definitionBlurFrequencyEnabled: true,
      definitionBlurFrequencyDictionary: "Sample ranks", definitionBlurFrequencyOrder: "auto",
      definitionBlurFrequencyThreshold: 120, definitionBlurReveal: "hover" };
    update();
    await settle();
    blur &&= blurState() === "blurred" && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form;
    query(".gsm-hoshidicts-definitions").dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    options = { ...options, definitionBlurFrequencyThreshold: 119 };
    update();
    await settle();
    blur &&= blurState() === "revealed";
    options = { ...options, definitionBlurFrequencyOrder: "descending", definitionBlurFrequencyThreshold: 240 };
    update();
    await settle();
    blur &&= blurState() === "blurred";
    options = { ...options, definitionBlurFrequencyEnabled: false };
    update();
    await settle();
    blur &&= blurState() === "revealed";
    options = { ...options, popupTheme: "miku", popupWidthPx: 720, popupHeightPx: 500, popupOpacityPercent: 0,
      sourceHighlightEnabled: false };
    update();
    await settle();
    const host = window.document.getElementById("preview-host");
    const appearance = host.dataset.hoshidictsTheme === "miku"
      && host.style.getPropertyValue("--gsm-hoshidicts-popup-opacity") === "0%"
      && host.style.getPropertyValue("--gsm-hoshidicts-popup-width") === "720px"
      && popup.style.width === "720px" && popup.style.height === "500px"
      && query(".gsm-hoshidicts-glossary-card") === card && query("form") === form
      && form.elements.definition.value === "A preview draft"
      && !window.document.documentElement.hasAttribute("data-hoshidicts-theme");
    let highlight = !window.CSS.highlights.has("gsm-hoshidicts-match");
    const highlightedText = () => [...(window.CSS.highlights.get("gsm-hoshidicts-match") || [])]
      .map(range => range.toString()).join("");
    options = { ...options, sourceHighlightEnabled: true };
    update();
    highlight &&= highlightedText() === "食べる";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    const note = popup.textContent.includes("This is a preview. Notes are not saved.")
      && form.elements.definition.value === "A preview draft";
    state = { revision: 1, dictionaries: [
      { id: "first", title: "First", termCount: 1, pitchCount: 1, enabled: true, favorite: true },
      { id: "second", title: "Second", termCount: 1, kanjiCount: 1, pitchCount: 1, enabled: true, favorite: true },
    ], groups: [] };
    options = { ...options, pitchAccentFuriganaDictionary: "Second", compactDefinitionSummaryDictionary: "Second" };
    update();
    await settle();
    incremental &&= query("form") === form && form.elements.definition.value === "A preview draft";
    form.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    const tab = popup.querySelectorAll('[role="tab"]')[1];
    tab.click();
    query(".gsm-hoshidicts-kanji-link").click();
    const kanji = query(".gsm-hoshidicts-kanji-glyph")?.textContent === "食"
      && popup.textContent.includes("ショク");
    options = { ...options, sourceHighlightEnabled: false };
    update();
    highlight &&= !window.CSS.highlights.has("gsm-hoshidicts-match");
    options = { ...options, sourceHighlightEnabled: true };
    update();
    highlight &&= highlightedText() === "食べる";
    query(".gsm-hoshidicts-note-button").click();
    const kanjiNote = query("form");
    kanjiNote.elements.definition.value = "Keep across source choices";
    options = { ...options, kanjiClickDictionary: { title: "Second", kind: "term" } };
    update();
    let kanjiSource = popup.textContent.includes("sample single-kanji entry")
      && query(".gsm-hoshidicts-glossary-card").textContent.includes("Second")
      && query("form") === kanjiNote && highlightedText() === "食べる";
    const kanjiCard = query(".gsm-hoshidicts-glossary-card");
    state = { ...state, revision: 2, dictionaries: state.dictionaries.map(entry => entry.id === "first"
      ? { ...entry, displayName: "Unrelated renamed dictionary" } : entry) };
    update();
    kanjiSource &&= query(".gsm-hoshidicts-glossary-card") === kanjiCard;
    // A group sample shows one card per member behind member tabs, in group order.
    state = { ...state, revision: 3, groups: [{ id: "kanji-group", name: "Kanji", dictionaryIds: ["second", "first"] }] };
    options = { ...options, kanjiClickDictionary: { kind: "tabGroup", id: "kanji-group" } };
    update();
    kanjiSource &&= JSON.stringify([...popup.querySelectorAll('[role="tab"]')].map(tab => tab.textContent))
      === JSON.stringify(["All", "Second", "Unrelated renamed dictionary"])
      && JSON.stringify([...popup.querySelectorAll(".gsm-hoshidicts-glossary-card-title")].map(title => title.title))
        === JSON.stringify(["Second", "First"])
      && popup.textContent.includes("ショク · ジキ") && popup.textContent.includes("sample single-kanji entry")
      && query("form") === kanjiNote;
    state = { ...state, revision: 4, groups: [] };
    options = { ...options, kanjiClickDictionary: { title: "Second", kind: "kanji" } };
    update();
    kanjiSource &&= query(".gsm-hoshidicts-kanji-glyph")?.textContent === "食"
      && popup.textContent.includes("Second") && query("form") === kanjiNote
      && kanjiNote.elements.definition.value === "Keep across source choices";
    // Native kanji stays outside term blur even while the sample frequency qualifies.
    options = { ...options, definitionBlurCountEnabled: false, definitionBlurFrequencyEnabled: true,
      definitionBlurFrequencyDictionary: "Sample ranks", definitionBlurFrequencyOrder: "auto",
      definitionBlurFrequencyThreshold: 120, definitionBlurReveal: "hover" };
    update();
    await settle();
    blur &&= (popup.dataset.definitionBlurState ?? "revealed") === "revealed"
      && query(".gsm-hoshidicts-kanji-glyph")?.textContent === "食";
    kanjiNote.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    query(".gsm-hoshidicts-kanji-back").click();
    await settle();
    blur &&= popup.dataset.definitionBlurState === "blurred";
    options = { ...options, definitionBlurFrequencyEnabled: false };
    update();
    await settle();
    const back = kanji && query('[role="tab"][aria-selected="true"]')?.dataset.dictionary === tab.dataset.dictionary;
    popup.querySelectorAll('[role="tab"]')[0].click();
    options = { ...options, popupImageSource: { kind: "tabGroup", id: "missing" } };
    update();
    await settle();
    const routing = query(".gloss-image-link")?.dataset.imageLoadState === "load-error";
    highlight &&= highlightedText() === "食べる";
    return { sample, note, back, incremental, counts, blur, routing, appearance, highlight, kanjiSource, earlyLoad, cssOwner, cssPreview };
  } finally { window.close(); }
}

describe("Design", () => {
  test("the Design preview", async () => {
    const preview = await designPreviewStage();
    check("custom CSS owns only its final shadow sheet and skips unchanged parses and attachment work",
      preview?.cssOwner === true, JSON.stringify(preview));
    check("preview initialization before its first update is safe and CSS edits retain mounted Notes and cards",
      preview?.earlyLoad === true && preview.cssPreview === true, JSON.stringify(preview));
    check("Design uses production term, kanji, media and metadata views without saving sample Notes",
      preview?.sample === true && preview.note === true && preview.back === true, JSON.stringify(preview));
    check("Design updates presentation without rebuilding cards and skips unchanged option echoes",
      preview?.incremental === true && preview.routing === true, JSON.stringify(preview));
    check("Design repaints its sample count line on the count switch without rebuilding cards or the Note draft",
      preview?.counts === true, JSON.stringify(preview));
    check("Design blurs its sample by the shared count rule, reveals on hover and restarts on blur edits without rerendering",
      preview?.blur === true, JSON.stringify(preview));
    check("live preview appearance preserves cards and drafts while term and kanji highlights toggle exactly",
      preview?.appearance === true && preview.highlight === true, JSON.stringify(preview));
    check("the live clicked-kanji preview switches source and kind without losing its Note or Back snapshot",
      preview?.kanjiSource === true, JSON.stringify(preview));
  });
});
