// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { API_CAPABILITY, API_CLIENT_ORIGIN, API_REQUESTS, createApiHost } from "../extension/api-host.js";

// The engine's exact hd_lookup result for 食べたかった (test/node-smoke.mjs).
const tabetakatta = {
  matched: "食べたかった", deinflected: "食べる",
  trace: [{ name: "-た", description: "past" }, { name: "-たい", description: "want to" }],
  term: { expression: "食べる", reading: "たべる", rules: "v1", score: 120,
    glossaries: [
      { dictionary: "Fixture", glossary: '["to eat","to live on (e.g. a salary)"]', definitionTags: "vt", termTags: "ichidan" },
      { dictionary: "Fixture", glossary: '["(colloquial) to make a living"]', definitionTags: "col", termTags: "ichidan" },
    ],
    frequencies: [{ dictionary: "Freq", frequencies: [{ value: 142, displayValue: "142位" }] }],
    pitches: [{ dictionary: "Pitch", pitches: [{ position: 2, pattern: "", nasal: [], devoice: [] }], transcriptions: ["tabeɾɯ"] }] },
  preprocessorSteps: 0,
};
const shoku = { character: "食", entries: [{ dictionary: "Kanji", onyomi: "ショク ジキ", kunyomi: "く.う た.べる", tags: "jouyou grade2",
  definitions: ["food", "eat", "meal"], stats: [{ name: "freq", value: "382" }, { name: "grade", value: "2" }, { name: "strokes", value: "9" }] }] };
const dictionaries = [
  { id: "fixture-id", title: "Fixture", displayName: "Fix", path: "/dicts/g1/Fixture", enabled: true, revision: "2026-01", termCount: 3, frequencyCount: 0, frequencyMode: null },
  { id: "freq-id", title: "Freq", displayName: null, path: "/dicts/g1/Freq", enabled: true, revision: "1", termCount: 0, frequencyCount: 9, frequencyMode: "rank-based" },
  { id: "kanji-id", title: "Kanji", displayName: null, path: "/dicts/g1/Kanji", enabled: true, revision: "3", termCount: 0, frequencyCount: 0, kanjiCount: 1 },
];

function host({ lookups = {}, kanji = {}, media = {}, audio = null, downloads = {} } = {}) {
  const calls = [];
  const engine = async message => {
    calls.push(structuredClone(message));
    switch (message.type) {
      case "hd_lookup": return { ok: true, generation: 7, results: lookups[message.text] ?? [] };
      case "hd_kanji": return { ok: true, generation: 7, kanji: kanji[message.character] ?? null };
      case "hd_media": return { ok: true, dataUrl: media[message.path] ?? null };
      case "hd_api_dictionary_open": return { ok: true, token: "dl-1", size: 4096 };
      case "hd_api_dictionary_read": return { ok: true, data: downloads[message.offset] ?? "", eof: true };
      case "hd_api_dictionary_close": return { ok: true };
      default: throw new Error(`unexpected engine request ${message.type}`);
    }
  };
  const render = async message => {
    calls.push(structuredClone(message));
    if (message.type === "hd_anki_audio") {
      if (audio === null) throw new Error("no pronunciation");
      return { ok: true, ...audio };
    }
    assert.equal(message.type, "hd_anki_fields");
    const fields = Object.fromEntries(Object.entries(message.templates).map(([marker]) => [marker,
      marker === "audio" ? message.audio : marker === "glossary" ? `<img src="${message.request.term.expression}.png">` : marker === "bogus" ? "" : `${marker}:${message.request.term.expression}`]));
    return { ok: true, fields, media: marker(message, "glossary") ? [{ dictionary: "Fixture", path: "img/eat.png", filename: "hachidori_eat.png" }] : [] };
  };
  const answer = createApiHost({ engine, render, version: "0.1.4",
    readDictionaries: async () => dictionaries, readAudioSources: async () => audio ? [{ id: "jpod", type: "jpod101", enabled: true }] : [] });
  return { answer, calls };
}
const marker = (message, name) => Object.hasOwn(message.templates, name);

test("the module names the relay contract and every request the relay sends", () => {
  assert.equal(API_CAPABILITY, "hoshidicts-api-v1");
  assert.equal(API_CLIENT_ORIGIN, "relay://yomitan-api");
  assert.deepEqual([...API_REQUESTS].sort(), ["hd_api_anki_fields", "hd_api_dictionaries", "hd_api_dictionary_close", "hd_api_dictionary_open",
    "hd_api_dictionary_read", "hd_api_kanji_entries", "hd_api_term_entries", "hd_api_tokenize", "hd_api_version"]);
});

test("version answers the extension's own version", async () => {
  const { answer } = host();
  assert.deepEqual(await answer({ type: "hd_api_version" }), { version: "0.1.4" });
  await assert.rejects(answer({ type: "hd_lookup" }), /unsupported API request/u);
});

test("term entries project the engine result onto Yomitan's TermDictionaryEntry, one result per input in order", async () => {
  const { answer, calls } = host({ lookups: { "食べたかった": [tabetakatta] } });
  const { results } = await answer({ type: "hd_api_term_entries", terms: ["食べたかった", "xyz"] });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(result => result.index), [0, 1]);
  assert.equal(results[0].originalTextLength, 6);
  assert.deepEqual(results[1], { index: 1, dictionaryEntries: [], originalTextLength: 0 });
  const [entry] = results[0].dictionaryEntries;
  assert.equal(entry.type, "term");
  assert.equal(entry.isPrimary, true);
  assert.deepEqual(entry.headwords, [{ index: 0, term: "食べる", reading: "たべる",
    sources: [{ originalText: "食べたかった", transformedText: "食べる", deinflectedText: "食べる", matchType: "exact", matchSource: "term", isPrimary: true }],
    tags: [{ name: "ichidan", category: "", order: 0, score: 0, content: [], dictionaries: ["Fixture"], redundant: false }], wordClasses: ["v1"] }]);
  assert.deepEqual(entry.inflectionRuleChainCandidates, [{ source: "dictionary",
    inflectionRules: [{ name: "-た", description: "past" }, { name: "-たい", description: "want to" }] }]);
  assert.equal(entry.definitions.length, 2);
  assert.deepEqual(entry.definitions[0].entries, ["to eat", "to live on (e.g. a salary)"]);
  assert.equal(entry.definitions[0].dictionary, "Fixture");
  assert.equal(entry.definitions[0].dictionaryAlias, "Fix");
  assert.deepEqual(entry.definitions[1].tags.map(tag => tag.name), ["col"]);
  assert.deepEqual(entry.frequencies, [{ index: 0, headwordIndex: 0, dictionary: "Freq", dictionaryIndex: 1, dictionaryAlias: "Freq",
    hasReading: false, frequency: 142, displayValue: "142位", displayValueParsed: false }]);
  assert.deepEqual(entry.pronunciations[0].pronunciations, [
    { type: "pitch-accent", positions: 2, nasalPositions: [], devoicePositions: [], tags: [] },
    { type: "phonetic-transcription", ipa: "tabeɾɯ", tags: [] }]);
  assert.equal(entry.maxOriginalTextLength, 6);
  assert.deepEqual(calls.map(call => call.text), ["食べたかった", "xyz"]);
  await assert.rejects(answer({ type: "hd_api_term_entries", terms: "食べる" }), /terms must be an array/u);
});

test("kanji entries look each character up and answer Yomitan's KanjiDictionaryEntry shape", async () => {
  const { answer } = host({ kanji: { "食": shoku } });
  const { results } = await answer({ type: "hd_api_kanji_entries", characters: ["食", "食x"] });
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { index: 0, dictionaryEntries: [{ type: "kanji", character: "食", dictionary: "Kanji", dictionaryIndex: 2, dictionaryAlias: "Kanji",
    onyomi: ["ショク", "ジキ"], kunyomi: ["く.う", "た.べる"],
    tags: ["jouyou", "grade2"].map(name => ({ name, category: "", order: 0, score: 0, content: [], dictionaries: ["Kanji"], redundant: false })),
    stats: { misc: [{ name: "freq", category: "misc", content: "", order: 0, score: 0, dictionary: "Kanji", value: "382" },
      { name: "grade", category: "misc", content: "", order: 0, score: 0, dictionary: "Kanji", value: "2" },
      { name: "strokes", category: "misc", content: "", order: 0, score: 0, dictionary: "Kanji", value: "9" }] },
    definitions: ["food", "eat", "meal"], frequencies: [] }] });
  assert.equal(results[1].dictionaryEntries.length, 1);
});

test("anki fields render each term through the mining renderer with the requested markers and return media as base64", async () => {
  const { answer, calls } = host({ lookups: { "食べたかった": [tabetakatta, { ...tabetakatta, term: { ...tabetakatta.term, expression: "食う" } }] },
    media: { "img/eat.png": "data:image/png;base64,iVBORw0KGgo=" }, audio: { filename: "hachidori_abc.mp3", data: "AAEC" } });
  const reply = await answer({ type: "hd_api_anki_fields", text: "食べたかった", entryType: "term", markers: ["Expression", "glossary", "audio", "bogus"], maxEntries: 1, includeMedia: true });
  assert.deepEqual(reply.fields, [{ expression: "expression:食べる", glossary: '<img src="食べる.png">', audio: "[sound:hachidori_abc.mp3]", bogus: "" }]);
  assert.deepEqual(reply.dictionaryMedia, [{ dictionary: "Fixture", path: "img/eat.png", mediaType: "image/png", content: "iVBORw0KGgo=", ankiFilename: "hachidori_eat.png" }]);
  assert.deepEqual(reply.audioMedia, [{ term: "食べる", reading: "たべる", mediaType: "audio/mpeg", content: "AAEC", ankiFilename: "hachidori_abc.mp3" }]);
  const lookup = calls.find(call => call.type === "hd_lookup");
  assert.equal(lookup.maxResults, 1);
  const audio = calls.find(call => call.type === "hd_anki_audio");
  assert.deepEqual(audio.sources, [{ id: "jpod", type: "jpod101", enabled: true }]);
  assert.equal(audio.recordSpeech, false);
  const render = calls.find(call => call.type === "hd_anki_fields");
  assert.deepEqual(render.templates, { expression: { value: "{expression}", overwriteMode: "coalesce" }, glossary: { value: "{glossary}", overwriteMode: "coalesce" },
    audio: { value: "{audio}", overwriteMode: "coalesce" }, bogus: { value: "{bogus}", overwriteMode: "coalesce" } });
  assert.equal(render.request.generation, 7);
  assert.equal(render.request.sentence, "食べたかった");
  assert.equal(render.request.matched, "食べたかった");
  assert.deepEqual(render.request.dictionaryAliases, { Fixture: "Fix" });
  assert.deepEqual(render.request.frequencyDictionaries, ["Freq"]);
  assert.deepEqual(render.request.term.frequencies[0].frequencyMode, "rank-based");
  assert.deepEqual(render.dictionaryPaths, { Fixture: "/dicts/g1/Fixture", Freq: "/dicts/g1/Freq", Kanji: "/dicts/g1/Kanji" });
});

test("anki fields without media skip audio and images, keep every entry when unlimited, and render kanji markers", async () => {
  const { answer, calls } = host({ lookups: { "食べたかった": [tabetakatta, { ...tabetakatta, term: { ...tabetakatta.term, expression: "食う" } }] }, kanji: { "食": shoku } });
  const reply = await answer({ type: "hd_api_anki_fields", text: "食べたかった", entryType: "term", markers: ["expression", "audio", "glossary"], maxEntries: 0, includeMedia: false });
  assert.deepEqual(reply.fields.map(fields => fields.expression), ["expression:食べる", "expression:食う"]);
  assert.deepEqual(reply.fields[0].audio, "");
  assert.deepEqual(reply.dictionaryMedia, []);
  assert.deepEqual(reply.audioMedia, []);
  assert.ok(!calls.some(call => call.type === "hd_anki_audio" || call.type === "hd_media"));
  const kanji = await answer({ type: "hd_api_anki_fields", text: "食べる", entryType: "kanji", markers: ["character", "onyomi", "kunyomi", "glossary", "stroke-count", "dictionary", "tags", "nothing"], maxEntries: 0, includeMedia: true });
  assert.deepEqual(kanji, { fields: [{ character: "食", onyomi: "ショク, ジキ", kunyomi: "く.う, た.べる", glossary: "<ul><li>food</li><li>eat</li><li>meal</li></ul>",
    "stroke-count": "9", dictionary: "Kanji", tags: "jouyou, grade2", nothing: "" }], dictionaryMedia: [], audioMedia: [] });
  await assert.rejects(answer({ type: "hd_api_anki_fields", text: "食", entryType: "sentence", markers: [] }), /unsupported entry type/u);
});

test("tokenize scans each text with the dictionaries, spreads the reading over the stem, and advances past unknown characters", async () => {
  const neko = { matched: "猫", deinflected: "猫", trace: [], term: { ...tabetakatta.term, expression: "猫", reading: "ねこ" } };
  const { answer, calls } = host({ lookups: { "猫が食べたかった。": [neko], "が食べたかった。": [], "食べたかった。": [tabetakatta], "。": [] } });
  const { results } = await answer({ type: "hd_api_tokenize", texts: ["猫が食べたかった。\nX"], scanLength: 10, parser: "scanning-parser" });
  assert.deepEqual(results, [{ id: "scan", source: "scanning-parser", dictionary: null, index: 0, content: [
    [{ text: "猫", reading: "ねこ" }, { text: "が", reading: "" }, { text: "食", reading: "た" }, { text: "べたかった。", reading: "" }],
    [{ text: "X", reading: "" }],
  ] }]);
  assert.deepEqual(calls.filter(call => call.type === "hd_lookup").map(call => [call.text, call.maxResults, call.scanLength]),
    [["猫が食べたかった。", 1, 10], ["が食べたかった。", 1, 10], ["食べたかった。", 1, 10], ["。", 1, 10], ["X", 1, 10]]);
});

test("dictionaries list the installed packages with a download file name, and downloads pass through the engine", async () => {
  const { answer, calls } = host({ downloads: { 0: "UEsDBA==" } });
  assert.deepEqual(await answer({ type: "hd_api_dictionaries" }), { dictionaries: [
    { id: "fixture-id", title: "Fixture", revision: "2026-01", fileName: "Fixture.hachidori.zip" },
    { id: "freq-id", title: "Freq", revision: "1", fileName: "Freq.hachidori.zip" },
    { id: "kanji-id", title: "Kanji", revision: "3", fileName: "Kanji.hachidori.zip" }] });
  assert.deepEqual(await answer({ type: "hd_api_dictionary_open", id: "nope" }), { error: "unknown dictionary", notFound: true });
  assert.deepEqual(await answer({ type: "hd_api_dictionary_open", id: "fixture-id" }), { token: "dl-1", size: 4096, fileName: "Fixture.hachidori.zip" });
  assert.deepEqual(await answer({ type: "hd_api_dictionary_read", token: "dl-1", offset: 0, length: 4194304 }), { data: "UEsDBA==", eof: true });
  assert.deepEqual(await answer({ type: "hd_api_dictionary_close", token: "dl-1" }), {});
  assert.deepEqual(calls.filter(call => call.type.startsWith("hd_api_")).map(call => call.type),
    ["hd_api_dictionary_open", "hd_api_dictionary_read", "hd_api_dictionary_close"]);
});
