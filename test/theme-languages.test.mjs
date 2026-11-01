// The language-aware theme contract (docs/languages.md 10 and 11, checked as
// 11.7 lists): every vendored theme and Crystal variant renders each
// language's fixtures with the attributes of 10.1, the directions of 10.2,
// the glossary languages of 10.3, the labels of 11.1 and the presentation of
// 10.4; the single-profile shape keeps today's markup.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BLOCKS, NATIVE_TEXT, PACKS, SCENARIOS, TEXT_THEMES, THEMES, VARIANTS, forbiddenLabels } from "./theme-languages-fixtures.mjs";
import { languageDom, renderCharacter, renderContext, renderTerms, scenarioLanguage, settle, singleProfileSnapshots,
  themeView } from "./theme-languages-jsdom.mjs";
import { applyDesignSettings } from "../extension/theme-store.js";
import { contentNoteStage, createHarness } from "./extension-smoke/content-harness.mjs";

const PROFILES = ["ja", "en", "ar", "ko", "zh"];
// Objects made in the jsdom window have its prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
// The direction a node reads in: its nearest `dir`.
const direction = element => element.closest("[dir]")?.getAttribute("dir") ?? null;
const ISOLATE_MARKS = /[\u2066-\u2069]/gu;
const runs = THEMES.flatMap(theme => (VARIANTS[theme] ?? ["auto"]).map(variant => ({ theme, variant })));

async function rendered(theme, profile, { variant = "auto", catalogue = null, packSettings, character = false } = {}) {
  const scenario = SCENARIOS[profile];
  const dom = languageDom(undefined, { page: scenario.page, catalogue });
  const language = scenarioLanguage(dom.window, scenario, packSettings ?? scenario.packSettings);
  const rendering = await themeView(dom, theme, { language, variant });
  if (character) await renderCharacter(rendering, scenario, { language });
  else await renderTerms(rendering, scenario, { language });
  return { dom, scenario, language, ...rendering };
}

// Text, aria-label and title outside dictionary content, where the theme
// writes its own labels.
function themeText(popup) {
  const values = [];
  const walker = popup.ownerDocument.createTreeWalker(popup, 1 | 4);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      if (!node.parentElement.closest(".gsm-hoshidicts-glossary-content")) values.push(node.data);
    } else for (const name of ["aria-label", "title"]) if (node.hasAttribute(name)) values.push(node.getAttribute(name));
  }
  return values;
}

function textNodes(root) {
  const nodes = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.data.trim()) nodes.push(node);
  return nodes;
}

// The language a fixture string reads in: its own span's in text mode, else
// the nearest `lang` above its text.
function stringLanguages(popup, text) {
  const found = [];
  for (const container of popup.querySelectorAll(".gsm-hoshidicts-definitions")) {
    for (const node of textNodes(container)) {
      const lines = node.data.replace(ISOLATE_MARKS, "").split("\n");
      for (const line of lines) {
        if (line.trim() === text || line.endsWith(` ${text}`) || line.endsWith(`. ${text}`) || line.trim().endsWith(text)) {
          if (line.includes(text)) found.push(node.parentElement.closest("[lang]")?.getAttribute("lang") ?? null);
        }
      }
    }
  }
  return found;
}

test("the single-profile shape keeps today's markup in every theme (design 4.5)", async () => {
  const golden = JSON.parse(readFileSync(new URL("./data/theme-languages/single-profile.json", import.meta.url), "utf8"));
  const now = await singleProfileSnapshots();
  for (const theme of THEMES) {
    assert.equal(now[theme].terms, golden[theme].terms, `${theme} term view`);
    assert.equal(now[theme].character, golden[theme].character, `${theme} character view`);
  }
});

test("the theme host injects the unmarked Japanese language only when a caller passes none (11.1)", async () => {
  const dom = languageDom(undefined, { page: { lang: "ja", dir: "ltr" } });
  try {
    const seen = [];
    const original = dom.window.HDPopup.createPopupView;
    dom.window.HDPopup.createPopupView = options => {
      seen.push(options.language);
      const view = original(options);
      return { ...view, renderResults(results, candidate, context) { seen.push(context.language); return view.renderResults(results, candidate, context); } };
    };
    const rendering = await themeView(dom, "default");
    await renderTerms(rendering, SCENARIOS.ja);
    assert.equal(seen.length, 2);
    for (const language of seen) {
      assert.equal(language.code, "ja");
      assert.equal(language.marked, false);
      assert.deepEqual(plain(language.sourceAttributes()), {});
      assert.equal(language.labels.traceMarker, "～");
    }
    const marked = scenarioLanguage(dom.window, SCENARIOS.ar);
    rendering.view.renderResults(SCENARIOS.ar.results, { query: "والكتاب" }, renderContext(SCENARIOS.ar, { language: marked }));
    assert.equal(seen.at(-1), marked, "a passed language reaches the theme unchanged");
    for (const name of ["dir", "lang", "data-hd-language", "data-hd-direction"]) {
      assert.ok(rendering.popup.hasAttribute(name), name);
    }
    rendering.view.renderResults(SCENARIOS.ja.results, { query: "食べる" }, renderContext(SCENARIOS.ja));
    for (const name of ["dir", "lang", "data-hd-language", "data-hd-direction"]) {
      assert.equal(rendering.popup.hasAttribute(name), false, `${name} leaves with the single-profile shape`);
    }
  } finally { dom.window.close(); }
});

for (const { theme, variant } of runs) {
  for (const profile of PROFILES) {
    test(`${theme}${variant === "auto" ? "" : ` (${variant})`} renders ${profile} with the language's attributes, directions and labels`, async () => {
      const run = await rendered(theme, profile, { variant });
      const { popup, scenario, language, host } = run;
      try {
        assert.equal(host.renderer, theme, "the theme rendered without falling back to Default");
        assert.ok(popup.textContent.length > 0);
        const pack = PACKS[profile];
        // 10.1: an English, left-to-right popup carrying the content's language.
        assert.equal(popup.getAttribute("dir"), "ltr");
        assert.equal(popup.getAttribute("lang"), "en");
        assert.equal(popup.dataset.hdLanguage, profile);
        assert.equal(popup.dataset.hdDirection, pack.direction);
        assert.equal(popup.style.getPropertyValue("--hd-language-word-break"), pack.presentation.typography.wordBreak ?? "");
        // 10.1: headword, readings and inputs.
        const expressions = popup.querySelectorAll(".gsm-hoshidicts-expression");
        if (theme !== "plain") assert.ok(expressions.length > 0);
        for (const expression of expressions) {
          assert.equal(expression.getAttribute("lang"), pack.bcp47, `${theme} headword lang`);
          assert.equal(expression.getAttribute("dir"), pack.direction === "rtl" ? "rtl" : null, `${theme} headword dir`);
        }
        for (const reading of popup.querySelectorAll(".jl-reading, .crystal-reading, .nazeka-reading, .gsm-hoshidicts-reading, .gsm-hoshidicts-expression rt")) {
          assert.equal(reading.closest("[lang]").getAttribute("lang"), pack.bcp47, `${theme} reading lang`);
          if (!reading.matches("rt")) assert.equal(reading.getAttribute("dir"), pack.direction === "rtl" ? "auto" : null, `${theme} reading dir`);
        }
        // 10.2 and 10.1: each dictionary's block carries its direction and default language.
        const blocks = [...popup.querySelectorAll(BLOCKS[theme])];
        assert.ok(blocks.length > 0, `${theme} names its dictionary blocks`);
        for (const block of blocks) {
          const title = block.closest("[data-dictionary]")?.dataset.dictionary
            ?? block.dataset.hoshidictsDictionary
            ?? block.querySelector("[data-hoshidicts-dictionary]")?.dataset.hoshidictsDictionary
            ?? block.querySelector(".nazeka-dictionary")?.dataset.dictionary;
          const dictionary = scenario.dictionaries.find(item => item.title === title);
          assert.ok(dictionary, `${theme} block of ${title}`);
          const rtl = (scenario.rtlDictionaries ?? []).includes(title);
          assert.equal(block.getAttribute("dir"), rtl ? "rtl" : null, `${theme} ${title} direction`);
          assert.equal(block.getAttribute("lang"), dictionary.targetLanguage ?? null, `${theme} ${title} default language`);
          assert.equal(block.hasAttribute("data-hd-lang-default"), Boolean(dictionary.targetLanguage));
        }
        // 10.1: names with right-to-left text sit alone in a dir="auto" element.
        for (const name of scenario.rtlNames ?? []) {
          for (const node of textNodes(popup).filter(node => node.data === name)) {
            assert.equal(node.parentElement.getAttribute("dir"), "auto", `${theme} isolates ${name}`);
            assert.equal(node.parentElement.childNodes.length, 1);
            assert.equal(node.parentElement.getAttribute("lang"), "ar");
          }
        }
        // 11.7: no Japanese label outside Japanese.
        if (profile !== "ja") {
          const text = themeText(popup).join("\n");
          for (const label of forbiddenLabels()) {
            const pattern = /^[A-Za-z]+$/u.test(label) ? new RegExp(`(^|[^A-Za-z])${label}([^A-Za-z]|$)`, "u") : null;
            assert.equal(pattern ? pattern.test(text) : text.includes(label), false, `${theme} shows "${label}" in ${profile}`);
          }
        }
        // 11.6: clickable characters follow the language's character view.
        const links = [...new Set([...popup.querySelectorAll(".gsm-hoshidicts-kanji-link")].map(link => link.textContent))];
        const expectedLinks = { ja: ["食"], en: [], ar: [], ko: ["學", "校"], zh: ["学", "校"] }[profile];
        assert.deepEqual(links, theme === "plain" ? [] : expectedLinks, `${theme} clickable characters`);
        // 10.3: every fixture string's language, line by line in text mode.
        const counts = new Map();
        for (const [text, expected, flag] of scenario.expected) {
          const seen = counts.get(text) ?? 0;
          counts.set(text, seen + 1);
          if (flag === "richOnly" && TEXT_THEMES.has(theme)) continue;
          const languages = stringLanguages(popup, text);
          assert.ok(languages.length > seen, `${theme} shows "${text}"`);
          assert.equal(languages[seen], expected, `${theme} labels "${text}"`);
        }
        // 11.7: no text in the profile's non-Latin scripts reads as English.
        if (NATIVE_TEXT[profile]) {
          for (const node of textNodes(popup)) {
            if (NATIVE_TEXT[profile].test(node.data)) {
              assert.equal(node.parentElement.matches(":lang(en)"), false, `${theme}: "${node.data}" reads as English`);
            }
          }
        }
        // Mining and counts read the stored term (10.4).
        for (const { result } of run.bound.rendered?.miningActions ?? []) {
          assert.equal(result.term.expression, scenario.results.find(item => item.term.expression === result.term.expression)?.term.expression);
        }
        assert.equal(language.code, profile);
      } finally { run.dom.window.close(); }
    });
  }
}

for (const { theme, variant } of runs) {
  for (const profile of ["ja", "ko", "zh"]) {
    test(`${theme}${variant === "auto" ? "" : ` (${variant})`} labels ${profile}'s character view from its pack`, async () => {
      const run = await rendered(theme, profile, { variant, character: true });
      try {
        const { popup } = run;
        const pack = PACKS[profile];
        const view = pack.capabilities.characterView;
        const text = themeText(popup).join("\n");
        if (["default", "jl", "bee", "crystal"].includes(theme)) {
          assert.ok(text.includes(view.readingLabels.onyomi), `${theme} shows ${view.readingLabels.onyomi}`);
        }
        if (profile !== "ja") {
          for (const label of forbiddenLabels()) {
            const pattern = /^[A-Za-z]+$/u.test(label) ? new RegExp(`(^|[^A-Za-z])${label}([^A-Za-z]|$)`, "u") : null;
            assert.equal(pattern ? pattern.test(text) : text.includes(label), false, `${theme} shows "${label}" in ${profile}'s character view`);
          }
        }
        for (const node of textNodes(popup)) {
          if (NATIVE_TEXT[profile].test(node.data)) {
            assert.equal(node.parentElement.matches(":lang(en)"), false, `${theme} character view: "${node.data}" reads as English`);
          }
        }
        if (theme !== "plain") {
          const character = [...popup.querySelectorAll(".gsm-hoshidicts-kanji-glyph, .jl-spelling, .crystal-kanji-character, .nazeka-word")]
            .find(element => element.textContent === run.scenario.kanji.character);
          assert.equal(character?.getAttribute("lang"), pack.bcp47, `${theme} character lang`);
        }
        const mined = run.bound.rendered?.miningActions?.[0]?.result;
        if (mined && profile !== "ja") assert.match(mined.term.glossaries[0].glossary, new RegExp(view.readingLabels.onyomi), "mined character labels");
      } finally { run.dom.window.close(); }
    });
  }
}

test("a Korean profile links hanja only while its hanja view is on (11.6, engine contract 4.6)", async () => {
  for (const theme of ["default", "jl", "crystal", "nazeka"]) {
    const run = await rendered(theme, "ko", { packSettings: { hanjaView: false } });
    try {
      assert.equal(run.popup.querySelectorAll(".gsm-hoshidicts-kanji-link").length, 0, theme);
      assert.equal(run.language.labels.character, null);
    } finally { run.dom.window.close(); }
  }
});

test("Default's character links name the language's character view", async () => {
  for (const [profile, name] of [["ja", "kanji"], ["zh", "hanzi"], ["ko", "hanja"]]) {
    const run = await rendered("default", profile);
    try {
      const labels = [...run.popup.querySelectorAll(".gsm-hoshidicts-kanji-link")].map(link => link.getAttribute("aria-label"));
      assert.ok(labels.length > 0);
      for (const label of labels) assert.match(label, new RegExp(`^Look up ${name} `, "u"));
    } finally { run.dom.window.close(); }
  }
});

test("a display setting changes the presentation in themes that declare it and survives a pitch repaint (10.4, 11.3)", async () => {
  const catalogue = JSON.parse(readFileSync(new URL("../extension/vendor/themes/index.json", import.meta.url), "utf8")).themes;
  for (const theme of THEMES) {
    const declared = catalogue.find(entry => entry.slug === theme).language.presentation;
    const run = await rendered(theme, "ar", { packSettings: SCENARIOS.ar.displaySettings });
    try {
      const expression = run.popup.querySelector(".gsm-hoshidicts-expression");
      if (!declared) {
        assert.equal(expression, null, `${theme} shows no headword`);
        continue;
      }
      assert.equal(expression.textContent, SCENARIOS.ar.displayedExpression, `${theme} shows the displayed headword`);
      run.view.updateDictionaryPresentation({ ...renderContext(SCENARIOS.ar), showPitchAccentFurigana: false });
      run.view.updateDictionaryPresentation({ ...renderContext(SCENARIOS.ar), showPitchAccentFurigana: true });
      assert.equal(run.popup.querySelector(".gsm-hoshidicts-expression").textContent, SCENARIOS.ar.displayedExpression,
        `${theme} keeps it through a pitch repaint`);
      for (const { result } of run.bound.rendered.miningActions) assert.equal(result.term.expression, "كِتَاب", "mining reads the stored term");
    } finally { run.dom.window.close(); }
  }
  const run = await rendered("jl", "zh", { packSettings: SCENARIOS.zh.displaySettings });
  try {
    assert.equal(run.popup.querySelector(".jl-reading").textContent, SCENARIOS.zh.displayedReading);
  } finally { run.dom.window.close(); }
});

test("Design shows a pack's display settings only for a theme that declares presentation, and hides the clicked-character dictionary of an undeclared theme outside Japanese (11.4, 11.5)", async () => {
  const { window } = languageDom();
  try {
    const { document } = window;
    const section = document.createElement("section");
    section.innerHTML = `<p id="popup-theme-hint"></p><label data-theme-variants><select><option value="auto">Automatic</option></select></label>
      <div data-design-group><label data-design-setting="kanjiClickDictionary">Clicked kanji</label>
        <label data-design-setting="showPitchAccentFurigana" data-requires="pitchAccent">Pitch</label></div>
      <fieldset data-pack-settings-group="display"><legend>Arabic display</legend></fieldset>`;
    const catalogue = JSON.parse(readFileSync(new URL("../extension/vendor/themes/index.json", import.meta.url), "utf8")).themes;
    const arabic = scenarioLanguage(window, SCENARIOS.ar);
    // Settings marks what the edited profile's language lacks (7.3).
    section.querySelector('[data-requires="pitchAccent"]').toggleAttribute("data-requirement-unmet", !arabic.capabilities.pitchAccent);
    for (const theme of catalogue) {
      applyDesignSettings(section, theme, { language: arabic });
      const display = section.querySelector("[data-pack-settings-group]");
      assert.equal(display.hidden, theme.language.presentation !== true, `${theme.slug} display settings`);
      assert.equal(section.querySelector('[data-design-setting="showPitchAccentFurigana"]').hidden, true, `${theme.slug} pitch needs pitch accent`);
    }
    const undeclared = { slug: "legacy", name: "Legacy", designSettings: ["kanjiClickDictionary"] };
    applyDesignSettings(section, undeclared, { language: arabic });
    assert.equal(section.querySelector('[data-design-setting="kanjiClickDictionary"]').hidden, true);
    assert.equal(section.querySelector("[data-pack-settings-group]").hidden, true);
    applyDesignSettings(section, undeclared, { language: window.HDThemeHost.createLanguage() });
    assert.equal(section.querySelector('[data-design-setting="kanjiClickDictionary"]').hidden, false, "Japanese keeps it");
  } finally { window.close(); }
});

test("undeclared themes get direction on the content hooks and lose character clicks outside Japanese (11.4)", async () => {
  // A theme written before languages, which marks nothing itself.
  const arabic = await rendered("legacy", "ar");
  try {
    await settle(20);
    const expression = arabic.popup.querySelector(".gsm-hoshidicts-expression");
    assert.equal(expression.getAttribute("lang"), "ar");
    assert.equal(expression.getAttribute("dir"), "rtl");
    const containers = [...arabic.popup.querySelectorAll(".gsm-hoshidicts-definitions")];
    const byTitle = new Map(containers.map(container => [container.closest("[data-dictionary]").dataset.dictionary, container]));
    assert.equal(byTitle.get("المعجم الوسيط").getAttribute("dir"), "rtl");
    assert.equal(byTitle.get("المعجم الوسيط").style.textAlign, "start");
    assert.equal(byTitle.get("Kaikki Arabic-English").hasAttribute("dir"), false, "left-to-right blocks stay unmarked");
  } finally { arabic.dom.window.close(); }
  const chinese = await rendered("legacy", "zh");
  try {
    await settle(20);
    const link = chinese.popup.querySelector(".gsm-hoshidicts-kanji-link");
    link.click();
    assert.deepEqual(chinese.bound.clicks, [], "clicks are ignored outside Japanese");
  } finally { chinese.dom.window.close(); }
  const japanese = await rendered("legacy", "ja");
  try {
    await settle(20);
    japanese.popup.querySelector(".gsm-hoshidicts-kanji-link").click();
    assert.deepEqual(japanese.bound.clicks, ["食"], "Japanese keeps them");
  } finally { japanese.dom.window.close(); }
  // A container that holds several dictionaries, or none core can name, reads each paragraph by its own text.
  const dom = languageDom(undefined, { page: SCENARIOS.ar.page, catalogue: "undeclared" });
  try {
    const language = scenarioLanguage(dom.window, SCENARIOS.ar);
    const rendering = await themeView(dom, "nazeka", { language });
    await renderTerms(rendering, SCENARIOS.ar, { language });
    await settle(20);
    const definitions = rendering.popup.querySelector(".gsm-hoshidicts-definitions");
    assert.equal(definitions.style.unicodeBidi, "plaintext");
    assert.equal(definitions.style.textAlign, "start");
    for (const row of definitions.querySelectorAll(".nazeka-sense")) assert.equal(row.style.unicodeBidi, "plaintext");
  } finally { dom.window.close(); }
});

test("the labelling pass labels text-mode definitions line by line and pads lists of mixed direction (10.1, 10.2)", async () => {
  const run = await rendered("jl", "ja");
  try {
    const block = run.popup.querySelector('.jl-entry[data-dictionary="Jitendex.org [2026-08-11]"] .gsm-hoshidicts-glossary-content');
    const spans = [...block.querySelectorAll("span[lang]")];
    assert.ok(spans.some(span => span.getAttribute("lang") === "ja" && span.textContent.includes("朝ごはんを食べる。")));
    assert.ok(!spans.some(span => span.textContent.includes("I eat breakfast.")), "English lines stay plain text");
  } finally { run.dom.window.close(); }
  const arabic = await rendered("default", "ar");
  try {
    const lists = [...arabic.popup.querySelectorAll("[data-hd-mixed-list]")];
    assert.ok(lists.length > 0, "a list with an item of each direction is marked");
    const item = text => [...arabic.popup.querySelectorAll(".gloss-sc-li, .gloss-sc-div")].find(element => element.textContent === text);
    assert.equal(direction(item("Bible (Christianity)")), "ltr", "each item of a mixed list reads in its own direction");
    assert.equal(direction(item("كتاب مقدس")), "rtl");
    assert.equal(item("Bible (Christianity)").closest("[dir]").style.textAlign, "start");
    assert.equal(direction(item("قرأتُ الكتابَ كلَّه في ليلةٍ واحدةٍ.")), "rtl", "an Arabic example in an Arabic-English dictionary keeps its direction");
    assert.equal(direction(item("I read it all.")), "ltr", "and its short translation keeps its own");
    assert.equal(direction(item("the people of the Book.")), "ltr", "a nested sense of the other direction");
    assert.equal(direction(item("كِتَاب kitāb pl. كُتُب kutub writing; letter, note; book.")), "ltr",
      "a paragraph that begins with the other script keeps its dictionary's direction");
    assert.equal(direction(item("n. صحائف مجموعة مكتوبة.")), "rtl", "an Arabic paragraph that begins with a Latin label");
    assert.equal(direction(item("From Aramaic ktāḇā (writing).")), "ltr", "a Latin etymology in a monolingual Arabic dictionary");
  } finally { arabic.dom.window.close(); }
});

test("text mode isolates paragraphs of the other direction after their marker (11.2)", async () => {
  const { window } = languageDom();
  try {
    const language = scenarioLanguage(window, SCENARIOS.ar);
    const text = window.HDGlossary.glossaryToPlainText(SCENARIOS.ar.results[0].term.glossaries[2].glossary, language, { direction: "rtl" });
    assert.equal(text, "• كتاب مقدس\n• \u2066Bible (Christianity)\u2069");
    assert.equal(window.HDGlossary.glossaryToPlainText(SCENARIOS.ar.results[0].term.glossaries[2].glossary),
      "• كتاب مقدس\n• Bible (Christianity)", "without a language, today's flattener");
    const pills = JSON.stringify([{ type: "structured-content", content: [{ tag: "span", data: { class: "tag" }, content: "名词" }, "school"] }]);
    assert.equal(window.HDGlossary.glossaryToPlainText(pills, scenarioLanguage(window, SCENARIOS.zh)), "名词 school");
    assert.equal(window.HDGlossary.glossaryToPlainText(pills), "名词school");
    const ruby = JSON.stringify([{ type: "structured-content", content: [{ tag: "ruby", content: ["學", { tag: "rt", content: "학" }] }] }]);
    assert.equal(window.HDGlossary.glossaryToPlainText(ruby, scenarioLanguage(window, SCENARIOS.ko)), "學(학)");
  } finally { window.close(); }
});

test("the language object's helpers follow 11.1", async () => {
  const { window } = languageDom();
  try {
    const arabic = scenarioLanguage(window, SCENARIOS.ar);
    assert.deepEqual(plain(arabic.sourceAttributes()), { lang: "ar", dir: "rtl" });
    assert.deepEqual(plain(arabic.readingAttributes()), { lang: "ar", dir: "auto" });
    assert.deepEqual(plain(arabic.nameAttributes("تردد الكلمات")), { dir: "auto", lang: "ar" });
    assert.deepEqual(plain(arabic.nameAttributes("Arabic Frequency")), {});
    assert.equal(arabic.isolate("تردد الكلمات"), "\u2068تردد الكلمات\u2069");
    assert.equal(arabic.isolate("Arabic Frequency"), "Arabic Frequency");
    assert.deepEqual(plain(arabic.glossaryAttributes("المعجم الوسيط", SCENARIOS.ar.results[0])), { dir: "rtl", lang: "ar", "data-hd-lang-default": "" });
    assert.deepEqual(plain(arabic.glossaryAttributes("Hans Wehr (converted)", SCENARIOS.ar.results[0])), {}, "the majority rule over its glosses");
    assert.equal(arabic.labels.traceMarker, "");
    assert.deepEqual(plain(arabic.labels.readingBrackets), ["(", ")"]);
    assert.equal(arabic.labels.character, null);
    assert.equal(arabic.sampleText, "قرأ");
    assert.equal(arabic.typography.joinedScript, true);
    assert.equal(arabic.readingFor(SCENARIOS.ar.results[0]), "", "an equal reading is no reading");
    assert.equal(arabic.sliceText("قرأتُ", 0, 4), "قرأتُ", "never splits a letter from its vowel mark");
    assert.equal(arabic.sliceText("قرأتُ", 0, 3), "قرأ");
    const english = scenarioLanguage(window, SCENARIOS.en);
    assert.equal(english.dictionaryDirection("English-Persian Glossary"), "rtl", "a target language without a pack takes its script's direction");
    const japanese = window.HDThemeHost.createLanguage();
    assert.equal(japanese.sliceText("食べたかった", 1, 3), "べた");
    assert.equal(japanese.isCharacterLink("々"), true, "Japanese keeps \\p{Script=Han}");
    assert.deepEqual(plain(japanese.glossaryAttributes("Jitendex")), {});
    const presented = arabic.present(SCENARIOS.ar.results);
    assert.equal(presented[0], SCENARIOS.ar.results[0], "no display setting, no presentation");
    const hidden = scenarioLanguage(window, SCENARIOS.ar, { vowelMarks: "hide" }).present(SCENARIOS.ar.results);
    assert.deepEqual(plain(hidden[0].presentation), { expression: "كتاب", reading: "كتاب" });
    assert.equal(hidden[0].term, SCENARIOS.ar.results[0].term, "the stored term is untouched");
    const invalid = scenarioLanguage(window, SCENARIOS.ar, { vowelMarks: "sometimes" });
    assert.equal(invalid.settings.vowelMarks, "show", "an invalid value reads as the default");
  } finally { window.close(); }
});

test("content.js passes the profile's language to its views and every render (11.1)", async () => {
  const single = await contentNoteStage({ async single() {
    const harness = await createHarness();
    try {
      await harness.initialLookup();
      return { view: harness.callbacks().language, render: harness.render().context.language };
    } finally { harness.close(); }
  }, async profiles() {
    const harness = await createHarness(undefined, { options: { profiles: [
      { id: "ja", language: "ja", settings: {}, packSettings: {} },
      { id: "ar", language: "ar", settings: {}, packSettings: {} },
    ] } });
    try {
      const window = harness.anchor.ownerDocument.defaultView;
      window.eval(readFileSync(new URL("../extension/render/glossary.js", import.meta.url), "utf8"));
      window.HDLanguages = { get: code => PACKS[code] ?? null };
      await harness.initialLookup();
      return { render: harness.render().context.language };
    } finally { harness.close(); }
  } });
  if (single === null) return;
  assert.equal(single.single.view.code, "ja");
  assert.equal(single.single.view.marked, false);
  assert.equal(single.single.render.code, "ja");
  assert.equal(single.single.render.marked, false, "the single-profile shape renders today's markup");
  assert.equal(single.profiles.render.code, "ja", "a request without a profile means the Japanese data");
  assert.equal(single.profiles.render.marked, true, "once the records have profiles the render is marked");
});

test("the Design preview passes the edited profile's language and uses its pack's sample scene (11.5)", async () => {
  const { JSDOM } = (await import("node:module")).createRequire(new URL("./tooling/package.json", import.meta.url))("jsdom");
  const extension = new URL("../extension/", import.meta.url);
  const dom = new JSDOM(readFileSync(new URL("design-preview.html", extension), "utf8"),
    { pretendToBeVisual: true, runScripts: "outside-only", url: "chrome-extension://test/design-preview.html" });
  const { window } = dom;
  try {
    window.fetch = async url => {
      const path = new URL(url).pathname.slice(1);
      const file = path.startsWith("vendor/languages/") ? new URL(`./data/theme-languages/${path.split("/")[2]}.json`, import.meta.url)
        : new URL(path, extension);
      const text = readFileSync(file, "utf8");
      return { ok: true, text: async () => text, json: async () => JSON.parse(text), blob: async () => new window.Blob([text]) };
    };
    window.URL.createObjectURL = () => "blob:sample";
    window.document.adoptedStyleSheets = [];
    window.CSS = { highlights: new Map() };
    window.Highlight = class extends Set { constructor(...ranges) { super(ranges); } };
    window.HDLanguages = { get: code => PACKS[code] ?? null };
    for (const file of ["reader-options.js", "render/glossary.js", "render/popup.js", "language-text.js", "theme-host.js", "visual-novel.js", "design-preview.js"]) {
      window.eval(readFileSync(new URL(file, extension), "utf8"));
    }
    const state = { revision: 1, dictionaries: [], groups: [] };
    const options = { ...window.HDReaderOptions.DEFAULT_OPTIONS };
    window.HDDesignPreview.update(options, state);
    await settle(50);
    const popup = window.document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
    assert.equal(popup.hasAttribute("data-hd-language"), false, "the single-profile preview is today's");
    assert.equal(window.document.querySelector(".vn-dialogue").lang, "ja");
    window.HDDesignPreview.update(options, state, { id: "ar", language: "ar", packSettings: { vowelMarks: "hide" } });
    await settle(100);
    assert.equal(popup.dataset.hdLanguage, "ar");
    assert.equal(popup.getAttribute("lang"), "en");
    const dialogue = window.document.querySelector(".vn-dialogue");
    assert.equal(dialogue.lang, "ar");
    assert.equal(dialogue.dir, "rtl");
    assert.equal(window.document.getElementById("preview-source").textContent, PACKS.ar.host.sample.practice.text);
    assert.equal(popup.querySelector(".gsm-hoshidicts-expression").textContent, "كتاب", "the pack's sample entry, displayed");
  } finally { window.close(); }
});
