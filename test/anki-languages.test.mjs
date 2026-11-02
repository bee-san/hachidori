// SPDX-License-Identifier: GPL-3.0-or-later
//
// Anki per language profile (docs/languages.md 12): a note follows the language
// of the profile it is mined in (glossary `lang` by 10.3, the right-to-left
// rules, the pack's part-of-speech labels, ruby); the Anki worker hands the
// profile to the note builder and keys the duplicate index with the
// language's note-type families; the Relay API writes the profile its index
// names; a linked request keeps each dictionary's direction and target
// language; Settings offers markers, presets and field-name suggestions by the
// edited profile's language. In the single-profile shape every note is today's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { PACKS, SCENARIOS } from "./theme-languages-fixtures.mjs";
import { registryOf } from "./language-settings-harness.mjs";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));

// The registry: the vendored Japanese pack and the English and Arabic fixture
// packs, with their Anki host data.
const vendored = {};
vendored.globalThis = vendored;
vm.runInNewContext(readFileSync(new URL("../extension/vendor/languages/registry.js", import.meta.url), "utf8"), vendored);
const withAnki = (pack, anki) => ({ ...pack, host: { ...pack.host, anki: { ...pack.host.anki, ...anki } } });
const REGISTRY = {
  ja: vendored.HDLanguages.get("ja"),
  en: withAnki(PACKS.en, { fieldAliases: { "phonetic-transcriptions": ["IPA"], pronunciation: ["Sound"] },
    partOfSpeechLabels: { v: "Verb", n: "Noun" } }),
  ar: withAnki(PACKS.ar, { partOfSpeechLabels: { n: "Noun" } }),
};
globalThis.HDLanguages = registryOf(REGISTRY);

await import("../extension/reader-options.js");
const { buildAnkiResourceFields } = await import("../extension/anki-resources.js");
const { createAnkiWorkerService, profileTemplateKey } = await import("../extension/anki-worker.js");
const { createApiHost } = await import("../extension/api-host.js");
const { allowLinkedAnkiRequest } = await import("../extension/sharing-protocol.js");
const glossary = globalThis.HDGlossary;
const layer = globalThis.HDReaderOptions;

const field = value => ({ value, overwriteMode: "coalesce" });
const TEMPLATES = {
  Front: field("{expression}"), Glossary: field("{glossary}"), Sentence: field("{sentence}"),
  Cloze: field("{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}"), Frequency: field("{frequencies}"),
  Kind: field("{part-of-speech}"), Furigana: field("{furigana}"),
};
const SENTENCES = { ja: "朝ごはんを食べたかった。", en: "I was running late.", ar: "قرأتُ والكتاب أمس." };

// A mining request for a scenario's first result, as the reader sends it once
// the records have profiles: each dictionary's direction and target language
// travel beside its display name.
function miningRequest(name, { languageFields = true } = {}) {
  const scenario = SCENARIOS[name];
  const result = scenario.results[0];
  const sentence = SENTENCES[name];
  const titles = [...new Set(result.term.glossaries.map(row => row.dictionary))];
  const targets = Object.fromEntries(scenario.dictionaries.filter(item => item.targetLanguage)
    .map(item => [item.title, item.targetLanguage]));
  const language = globalThis.HDThemeHost.createLanguage(REGISTRY[name], { marked: true, dictionaries: scenario.dictionaries });
  return { ...result, generation: 1, sentence, matchOffset: sentence.indexOf(result.matched), matched: result.matched,
    searchQuery: result.matched, popupSelectionText: "", documentTitle: "Page", dictionaryAliases: {}, dictionaryIds: {},
    frequencyDictionaries: result.term.frequencies.map(group => group.dictionary),
    ...(languageFields ? {
      dictionaryDirections: Object.fromEntries(titles.map(title => [title, language.dictionaryDirection(title, result)])),
      dictionaryTargetLanguages: Object.fromEntries(titles.filter(title => targets[title]).map(title => [title, targets[title]])),
    } : {}) };
}

function documentFor(t, options) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", options);
  t.after(() => dom.window.close());
  return dom.window.document;
}

async function note(t, name, { templates = TEMPLATES, profile = { language: name, packSettings: {} }, request,
  compact = false } = {}) {
  const document = documentFor(t, compact ? { virtualConsole: new VirtualConsole() } : undefined);
  const { fields } = await buildAnkiResourceFields(request ?? miningRequest(name), templates, { document,
    dictionaryPaths: Object.fromEntries(SCENARIOS[name].dictionaries.map(item => [item.title, `/dicts/${item.title}`])),
    styles: async () => [], compactGlossary: compact, profile });
  const parse = html => {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    return holder;
  };
  return { fields, parse };
}

// The direction a paragraph is laid out in: its nearest `dir`.
const laidOut = element => element.closest("[dir]")?.getAttribute("dir") ?? "ltr";
const languageOf = element => element.closest("[lang]")?.getAttribute("lang") ?? null;
// Every block that holds text of its own, with that text.
function paragraphs(root) {
  const blocks = new Set();
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  while (walker.nextNode()) {
    if (!/\p{L}/u.test(walker.currentNode.data)) continue;
    const block = walker.currentNode.parentElement.closest("div, li, p, small");
    if (block) blocks.add(block);
  }
  return [...blocks].map(block => ({ block, text: [...block.childNodes].filter(node => node.nodeType === 3
    || !["DIV", "LI", "P", "UL", "OL"].includes(node.nodeName)).map(node => node.textContent).join("") }));
}

test("a note mined in a right-to-left profile follows section 12's rules", async t => {
  const { fields, parse } = await note(t, "ar");
  const html = parse(fields.Glossary);
  const root = html.querySelector(".yomitan-glossary");
  assert.equal(root.getAttribute("dir"), "rtl", "a root of both directions takes the profile's");
  assert.match(root.getAttribute("style"), /^text-align: start; contain: layout paint style; isolation: isolate;$/u);
  const list = root.querySelector(":scope > ol");
  assert.equal(list.style.paddingInline, "40px", "the numbers of both directions stay inside the field");
  assert.deepEqual([...list.children].map(item => [item.dataset.dictionary, item.getAttribute("dir")]), [
    ["المعجم الوسيط", "rtl"], ["المعجم الوسيط", "rtl"], ["المعجم الوسيط", "rtl"],
    ["Kaikki Arabic-English", "ltr"], ["Kaikki Arabic-English", "ltr"], ["Kaikki Arabic-English", "ltr"],
    ["Kaikki Arabic-English", "ltr"], ["Hans Wehr (converted)", "ltr"]]);
  // Every paragraph is laid out in its own direction, whatever its row's.
  for (const { block, text } of paragraphs(root.querySelector(":scope > ol"))) {
    if (block.matches(".yomitan-glossary-meta, .yomitan-glossary-meta *")) continue;
    const own = glossary.textDirection(text);
    if (own) assert.equal(laidOut(block), own, text);
  }
  // A list that holds an item of the other direction pads both sides.
  for (const inner of root.querySelectorAll(".gsm-hoshidicts-glossary-content ul, .gsm-hoshidicts-glossary-content ol")) {
    const other = [...inner.children].some(item => laidOut(item) !== laidOut(inner));
    assert.equal(inner.style.paddingInline === "40px", other, inner.textContent);
  }
  // A block marked with its direction aligns to its own start.
  for (const marked of root.querySelectorAll(".gsm-hoshidicts-glossary-content [dir], .gsm-hoshidicts-glossary-content[dir]")) {
    assert.equal(marked.style.textAlign, "start", marked.textContent);
  }
  // A name with a right-to-left character sits alone in a dir="auto" element; a Latin one does not.
  assert.deepEqual([...root.querySelectorAll(".yomitan-glossary-meta span")].map(span =>
    [span.getAttribute("dir"), span.textContent]), Array(3).fill(["auto", "المعجم الوسيط"]));
  assert.equal(root.querySelectorAll(".yomitan-glossary-meta")[3].innerHTML, "(noun, Kaikki Arabic-English)");
  // The English footer is left to right.
  assert.equal(root.querySelector(".yomitan-glossary-details").getAttribute("dir"), "ltr");
  // Glossary text takes 10.3's language against each dictionary's target language.
  const text = value => [...root.querySelectorAll(".gsm-hoshidicts-glossary-content *, .gsm-hoshidicts-glossary-content")]
    .find(element => [...element.childNodes].some(node => node.nodeType === 3 && node.data === value));
  for (const [value, expected] of [["صحائف مجموعة مكتوبة.", "ar"], ["From Aramaic ktāḇā (writing).", "ar"],
    ["book", "en"], ["قرأتُ الكتابَ كلَّه في ليلةٍ واحدةٍ.", "ar"], ["I read it all.", "en"],
    ["the people of the Book.", "en"], ["writing; letter, note", null]]) {
    assert.equal(languageOf(text(value)), expected, value);
  }
  assert.equal(fields.Sentence, '<span dir="auto">قرأتُ <b>والكتاب</b> أمس.</span>');
  assert.equal(fields.Cloze, "قرأتُ <b>والكتاب</b> أمس.", "the cloze parts stay bare");
  assert.equal(fields.Frequency, '<ul style="text-align: start;"><li><span dir="auto">تردد الكلمات</span>: 95</li>'
    + "<li>Arabic Frequency: 312</li></ul>");
  assert.equal(fields.Kind, "Noun", "{part-of-speech} reads the pack's labels");
  assert.equal(fields.Furigana, "كِتَاب", "without ruby {furigana} is the plain headword");
});

test("an Arabic-English dictionary's root stays left to right in an Arabic note, with its Arabic example right to left", async t => {
  const { fields, parse } = await note(t, "ar", { templates: { Back: field("{single-glossary-kaikki-arabic-english}") } });
  const root = parse(fields.Back).querySelector(".yomitan-glossary");
  assert.equal(root.getAttribute("dir"), "ltr", "a right-to-left card template cannot turn its English around");
  assert.equal(root.querySelector(":scope > ol").getAttribute("style"), null, "one direction needs no extra padding");
  assert.ok([...root.querySelectorAll(":scope > ol > li")].every(item => !item.hasAttribute("dir")));
  const example = [...root.querySelectorAll("div")].find(element => element.textContent === "قرأتُ الكتابَ كلَّه في ليلةٍ واحدةٍ.");
  assert.equal(laidOut(example), "rtl");
});

test("in a left-to-right profile only the fields that hold a right-to-left dictionary follow the rules", async t => {
  const templates = { ...TEMPLATES, English: field("{single-glossary-kaikki-english}") };
  const { fields, parse } = await note(t, "en", { templates });
  const root = parse(fields.Glossary).querySelector(".yomitan-glossary");
  assert.equal(root.getAttribute("dir"), "ltr");
  assert.equal(root.querySelector(":scope > ol").style.paddingInline, "40px");
  assert.deepEqual([...root.querySelectorAll(":scope > ol > li")].map(item => item.getAttribute("dir")),
    ["ltr", "rtl", "rtl", "rtl", "ltr"], "the English-Persian dictionary has no pack and is right to left by its script");
  const english = [...root.querySelectorAll(".gsm-hoshidicts-glossary-content")].find(body => body.textContent === "I run fast.");
  assert.equal(laidOut(english), "ltr", "an English row in a right-to-left dictionary keeps its own order");
  // A field of left-to-right dictionaries only keeps today's markup, but for its language.
  const plain = parse(fields.English).querySelector(".yomitan-glossary");
  assert.equal(plain.getAttribute("style"), "text-align: left; contain: layout paint style; isolation: isolate;");
  assert.equal(plain.querySelector("[dir]"), null);
  assert.equal(plain.querySelector(".gsm-hoshidicts-glossary-content").getAttribute("lang"), "en");
  assert.equal(fields.Sentence, "I was <b>running</b> late.");
  assert.equal(fields.Frequency, '<ul style="text-align: left;"><li>Word Frequency: 210</li></ul>');
  assert.equal(fields.Kind, "Verb");
  assert.equal(fields.Furigana, "run");
});

test("a note in the Japanese profile keeps today's detection and turns nothing around", async t => {
  const { fields, parse } = await note(t, "ja");
  const withProfile = parse(fields.Glossary);
  const today = parse((await note(t, "ja", { profile: null })).fields.Glossary);
  assert.equal(withProfile.querySelector("[dir]"), null);
  assert.equal(withProfile.querySelector(".yomitan-glossary").getAttribute("style"),
    "text-align: left; contain: layout paint style; isolation: isolate;");
  // Each Japanese string reads as Japanese, as today; a dictionary's target
  // language is its body's default.
  for (const value of ["朝ごはんを食べる。", "See also 食う", "食物を口に入れて飲み込む。"]) {
    const find = root => [...root.querySelectorAll(".gsm-hoshidicts-glossary-content, .gsm-hoshidicts-glossary-content *")]
      .find(element => [...element.childNodes].some(node => node.nodeType === 3 && node.data === value));
    assert.equal(languageOf(find(withProfile)), "ja", value);
    assert.equal(languageOf(find(today)), "ja", value);
  }
  assert.deepEqual([...withProfile.querySelectorAll(".gsm-hoshidicts-glossary-content")].map(body => body.getAttribute("lang")),
    ["en", "en", "ja"]);
  assert.equal(fields.Kind, "Ichidan verb", "the Japanese pack carries today's table");
  assert.equal(fields.Furigana, "<ruby>食<rt>た</rt></ruby>べる");
  assert.equal(fields.Sentence, "朝ごはんを<b>食べたかった</b>。");
});

test("without profiles a note is today's, whatever the request carries", async t => {
  for (const name of ["ar", "en", "ja"]) {
    const carried = await note(t, name, { profile: null });
    const bare = await note(t, name, { profile: null, request: miningRequest(name, { languageFields: false }) });
    assert.deepEqual(carried.fields, bare.fields, name);
    const html = carried.parse(carried.fields.Glossary);
    assert.equal(html.querySelector("[dir]"), null, name);
    assert.match(carried.fields.Frequency, /^(?:<ul style="text-align: left;">|$)/u);
  }
});

test("Smaller Anki cards keep each block's direction, a row's own, the list padding and the target language", async t => {
  const { fields, parse } = await note(t, "ar", { compact: true, templates: { Glossary: field("{glossary}") } });
  const root = parse(fields.Glossary).querySelector(".yomitan-glossary");
  assert.equal(root.getAttribute("style"), "text-align: start;");
  assert.equal(root.getAttribute("dir"), "rtl");
  assert.equal(root.querySelector(":scope > ol").style.paddingInline, "40px");
  for (const { block, text } of paragraphs(root.querySelector(":scope > ol"))) {
    if (block.matches(".yomitan-glossary-meta, .yomitan-glossary-meta *")) continue;
    const own = glossary.textDirection(text);
    if (own) assert.equal(laidOut(block), own, text);
  }
  const bible = [...root.querySelectorAll("li")].find(item => item.textContent === "Bible (Christianity)");
  assert.equal(bible.parentElement.style.paddingInline, "40px");
  assert.equal(languageOf(bible), "ar");
});

// ---------------------------------------------------------------------------
// The Anki worker
// ---------------------------------------------------------------------------

const profileTemplate = (id, model, fieldTemplates) => ({ id, name: id, deck: "Default", model, tags: [],
  fields: Object.fromEntries(layer.ANKI_FIELDS.map(key => [key, ""])), duplicateScope: "all", duplicateBehavior: "prevent",
  captureScreenshot: false, fieldTemplates });
const STORED = { revision: 2, anki: { url: "http://127.0.0.1:8765", apiKey: "" }, profiles: [
  { id: "ja", language: "ja", settings: { anki: { templates: [profileTemplate("mining", "Japanese", {
    Front: field("{expression}"), Back: field("{glossary}"), Sentence: field("{sentence-furigana}") })] } }, packSettings: {} },
  { id: "en", language: "en", settings: { anki: { templates: [profileTemplate("words", "English", {
    Front: field("{expression}"), Back: field("{glossary}"), Sentence: field("{sentence-furigana}") })] } }, packSettings: {} },
] };

function workerFixture({ profiles = true } = {}) {
  const offscreen = [], engine = [], index = [];
  const service = createAnkiWorkerService({
    gateway: { discover: async config => ({ connected: true, model: config.model, models: [config.model], decks: ["Default"],
      fields: ["Front", "Back", "Sentence"], errors: [] }), invoke: async () => { throw new Error("no Anki writes here"); } },
    readOptions: async profileId => layer.projectOptions(STORED, profileId ?? "ja"),
    // What the worker's readAnkiProfile gives: the profile's language and pack settings.
    ...(profiles ? { readProfile: async profileId => {
      const { language, packSettings } = layer.profileDescriptor(STORED, profileId ?? "ja");
      return { language, packSettings };
    } } : {}),
    readDictionaries: async () => [{ title: "Kaikki English", path: "/dicts/kaikki", enabled: true }],
    engine: async message => {
      engine.push(message);
      if (message.type === "hd_status") return { ready: true, loading: false, generation: 1 };
      if (message.type === "hd_segment") return { segments: [{ spans: [] }, { spans: [] }] };
      throw new Error(`unexpected ${message.type}`);
    },
    offscreen: async message => {
      offscreen.push(message);
      return { fields: { Front: "run", Back: "", Sentence: "" }, media: [] };
    },
    duplicateIndex: {
      source: async config => { index.push(config); return null; },
      async has(config) { index.push(config); return false; },
      async statuses(config) { index.push(config); return { revision: 0, statuses: null }; },
    },
  });
  return { service, offscreen, engine, index };
}

async function preflight(fixture, profileId, request) {
  const templateId = profileTemplateKey(profileId, undefined);
  const { configKey } = await fixture.service.status(templateId);
  return fixture.service.preflight({ ...request, templateId, configKey, profileId });
}

test("the Anki worker hands the note builder its profile and keys duplicates with the language's families", async () => {
  const request = { ...miningRequest("en"), term: { ...miningRequest("en").term, expression: "run", reading: "run" } };
  const f = workerFixture();
  await assert.rejects(preflight(f, "en", request), /no Anki writes|canAdd|first field/u);
  const [fieldsRequest] = f.offscreen.filter(message => message.type === "hd_anki_fields");
  assert.deepEqual(fieldsRequest.profile, { language: "en", packSettings: {} });
  assert.equal(f.engine.some(message => message.type === "hd_segment"), false,
    "a language without ruby asks for no sentence furigana");
  assert.deepEqual(f.index.at(-1).noteTypeFamilies, [], "English recognises no Japanese note type");
  // Japanese asks for its sentence furigana for its own profile, and lists every family.
  const japanese = workerFixture();
  await assert.rejects(preflight(japanese, "ja", miningRequest("ja")), /no Anki writes|canAdd|first field/u);
  assert.deepEqual(japanese.engine.filter(message => message.type === "hd_segment").map(message => message.profileId), ["ja"]);
  assert.equal(Object.hasOwn(japanese.index.at(-1), "noteTypeFamilies"), false);
  assert.deepEqual(japanese.offscreen.find(message => message.type === "hd_anki_fields").profile, { language: "ja", packSettings: {} });
  // Maturity and word status read the requested profile's first Template.
  await f.service.maturity({ term: { expression: "run", reading: "run" }, profileId: "en" });
  await f.service.wordStatus({ headwords: ["run"], profileId: "en" });
  assert.deepEqual(f.index.slice(-2).map(config => [config.model, config.noteTypeFamilies]), [["English", []], ["English", []]]);
  // In the single-profile shape the message is today's.
  const today = workerFixture({ profiles: false });
  await assert.rejects(preflight(today, "ja", miningRequest("ja", { languageFields: false })), /no Anki writes|canAdd|first field/u);
  assert.equal(Object.hasOwn(today.offscreen.find(message => message.type === "hd_anki_fields"), "profile"), false);
});

test("a linked mining request keeps each dictionary's direction and target language", () => {
  const request = miningRequest("ar");
  const allowed = allowLinkedAnkiRequest({ target: "hachidori-anki", type: "hd_anki_preflight", requestId: 1, request });
  assert.deepEqual(allowed.request.dictionaryDirections, request.dictionaryDirections);
  assert.deepEqual(allowed.request.dictionaryTargetLanguages, request.dictionaryTargetLanguages);
});

// ---------------------------------------------------------------------------
// The Relay API
// ---------------------------------------------------------------------------

test("the Relay API writes the notes and readings of the profile its index names in that profile's language", async () => {
  const result = SCENARIOS.ar.results[0];
  const rendered = [];
  const apiHost = (profiles = true) => createApiHost({
    version: "test",
    engine: async message => {
      if (message.type === "hd_lookup") {
        return message.text.startsWith(result.matched) ? { results: [result], generation: 1 } : { results: [], generation: 1 };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    render: async message => {
      rendered.push(message);
      return message.type === "hd_anki_fields" ? { fields: { glossary: "<div></div>" }, media: [] } : { filename: "a.mp3", data: "AA==" };
    },
    readDictionaries: async () => SCENARIOS.ar.dictionaries.map((item, index) => ({ ...item, id: String(index),
      path: `/dicts/${index}`, enabled: true, frequencyCount: 0 })),
    readAudioSources: async () => [{ id: "url", type: "custom", enabled: true, url: "https://example.com/{language}/{term}", voice: "" }],
    readAnkiTemplates: async () => [],
    resolveProfile: async profileIndex => (profiles ? { profileId: profileIndex === 1 ? "ar" : "ja" } : { profileId: undefined }),
    readProfile: async profileId => (profiles ? { language: profileId, packSettings: {} } : null),
  });
  const host = apiHost();
  await host({ type: "hd_api_anki_fields", text: result.matched, markers: ["glossary", "audio"], entryType: "term",
    includeMedia: true, profileIndex: 1 });
  const fields = rendered.find(message => message.type === "hd_anki_fields");
  assert.deepEqual(fields.profile, { language: "ar", packSettings: {} });
  assert.deepEqual(fields.request.dictionaryTargetLanguages, { "المعجم الوسيط": "ar", "Kaikki Arabic-English": "en" });
  assert.equal(rendered.find(message => message.type === "hd_anki_audio").language, "ar");
  const tokens = await host({ type: "hd_api_tokenize", texts: [`${result.matched} `], profileIndex: 1 });
  assert.deepEqual(tokens.results[0].content, [[{ text: `${result.matched} `, reading: "" }]],
    "a language without ruby gives its words no furigana");
  // The single-profile shape sends today's messages.
  rendered.length = 0;
  await apiHost(false)({ type: "hd_api_anki_fields", text: result.matched, markers: ["glossary", "audio"], entryType: "term",
    includeMedia: true });
  assert.equal(Object.hasOwn(rendered.find(message => message.type === "hd_anki_fields"), "profile"), false);
  assert.equal(Object.hasOwn(rendered.find(message => message.type === "hd_anki_fields").request, "dictionaryTargetLanguages"), false);
  assert.equal(Object.hasOwn(rendered.find(message => message.type === "hd_anki_audio"), "language"), false);
});

// ---------------------------------------------------------------------------
// Settings → Anki
// ---------------------------------------------------------------------------

const { createAnkiTemplateSettingsController } = await import("../extension/anki-settings.js");
const SETTINGS_HTML = readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8");
const tick = () => new Promise(resolveTick => setImmediate(resolveTick));

// Settings → Anki for one profile's Templates, as settings.js builds it.
function ankiSettings(t, edited) {
  const dom = new JSDOM(SETTINGS_HTML, { runScripts: "outside-only" });
  const { window } = dom;
  t.after(() => window.close());
  window.document.getElementById("anki").hidden = false;
  window.eval(readFileSync(new URL("../extension/reader-options.js", import.meta.url), "utf8"));
  window.HDLanguages = globalThis.HDLanguages;
  let anki = window.HDReaderOptions.normaliseAnki({ url: "http://127.0.0.1:8765", apiKey: "",
    templates: [profileTemplate("words", "Basic", null)] });
  let profile = edited;
  const controller = createAnkiTemplateSettingsController({ document: window.document,
    readAnki: () => anki, editAnki(value) { anki = value; },
    readProfile: () => profile,
    async send(type, fields) {
      if (type !== "hd_anki_discover") return { ok: true, proposal: null, outcome: { status: "unavailable", detail: "" } };
      return { ok: true, connected: true, model: fields.model, models: ["Basic", "Kiku"], decks: ["Default"],
        fields: fields.model === "Kiku" ? ["Expression", "Sentence", "Glossary"] : ["Front", "Back", "IPA", "Sound"], errors: [] };
    } });
  const el = id => window.document.getElementById(id);
  return { window, el, controller, template: () => anki.templates[0],
    async render() { controller.render(); for (let turn = 0; turn < 5; turn++) await tick(); },
    edit(value) { profile = value; } };
}

function listedMarkers(f) {
  const editor = f.window.document.querySelector("#anki-templates textarea");
  editor.parentElement.querySelector(".anki-marker-combobox-toggle").click();
  const listed = [...editor.parentElement.querySelectorAll(".anki-marker-option")].filter(option => !option.hidden)
    .map(option => option.dataset.marker);
  editor.parentElement.querySelector(".anki-marker-combobox-toggle").click();
  return listed;
}

const JAPANESE_PROFILE = { id: "ja", language: "ja", packSettings: {} };
const ENGLISH_PROFILE = { id: "en", language: "en", packSettings: {} };

test("Settings offers the markers the edited profile's language has", async t => {
  const f = ankiSettings(t, JAPANESE_PROFILE);
  await f.render();
  const japanese = listedMarkers(f);
  for (const marker of ["{reading}", "{furigana}", "{sentence-furigana}", "{pitch}", "{pitch-accent-graphs}", "{character}",
    "{onyomi}", "{phonetic-transcriptions}"]) assert.ok(japanese.includes(marker), marker);
  f.edit(ENGLISH_PROFILE);
  await f.render();
  const english = listedMarkers(f);
  for (const marker of ["{reading}", "{furigana}", "{furigana-plain}", "{sentence-furigana}", "{pitch}", "{pitch-position}",
    "{pitch-accent-graphs}", "{pitch-accent}", "{character}", "{onyomi}", "{kunyomi}", "{stroke-count}"]) {
    assert.equal(english.includes(marker), false, marker);
  }
  for (const marker of ["{expression}", "{glossary}", "{sentence}", "{phonetic-transcriptions}", "{part-of-speech}"]) {
    assert.ok(english.includes(marker), marker);
  }
});

test("only the Preset select needs note-type families, so Apply preset gives a language its suggestions", () => {
  const { document } = new JSDOM(SETTINGS_HTML).window;
  const required = [...document.querySelectorAll('[data-requires="ankiNoteTypeFamilies"]')];
  assert.ok(required.some(node => node.matches("label.anki-preset") && node.contains(document.getElementById("anki-preset"))));
  assert.equal(document.getElementById("anki-apply-preset").closest("[data-requires]"), null);
  assert.equal(document.getElementById("anki-find-setup").closest('[data-requires="ankiNoteTypeFamilies"]') !== null, true);
});

test("without note-type families Apply preset gives automatic suggestions with the pack's field aliases", async t => {
  const f = ankiSettings(t, ENGLISH_PROFILE);
  await f.render();
  // A Kiku value left in the hidden select from another language is not applied.
  f.el("anki-preset").value = "kiku";
  f.el("anki-apply-preset").click();
  await f.render();
  assert.deepEqual(Object.fromEntries(Object.entries(f.template().fieldTemplates).map(([name, value]) => [name, value.value])),
    { Front: "{expression}", Back: "", IPA: "{phonetic-transcriptions}", Sound: "" },
    "the generic aliases and the pack's own; a key that names no marker suggests nothing");
});

test("a Kiku note type chosen in a language without families gets no preset and is not suggested", async t => {
  const f = ankiSettings(t, ENGLISH_PROFILE);
  await f.render();
  assert.equal(f.el("opt-anki-model").querySelector('optgroup[label="Suggested"]'), null);
  f.el("opt-anki-model").value = "Kiku";
  f.el("opt-anki-model").dispatchEvent(new f.window.Event("change"));
  await f.render();
  assert.equal(f.template().model, "Kiku");
  assert.equal(f.template().fieldTemplates, null, "no Kiku preset fills the fields");
  assert.equal(f.el("anki-preset").value, "automatic");
  // Japanese keeps today's: the Kiku note type gets its preset when chosen.
  const japanese = ankiSettings(t, JAPANESE_PROFILE);
  await japanese.render();
  assert.equal(japanese.el("opt-anki-model").querySelector('optgroup[label="Suggested"] option')?.value, "Kiku");
  japanese.el("opt-anki-model").value = "Kiku";
  japanese.el("opt-anki-model").dispatchEvent(new japanese.window.Event("change"));
  await japanese.render();
  assert.equal(japanese.template().fieldTemplates?.Expression?.value, "{expression}");
  assert.equal(japanese.el("anki-preset").value, "kiku");
});
