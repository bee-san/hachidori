#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract test for the WebAssembly language ABI (docs/languages.md 9 and 18,
// engine contract 10.4): the real hoshidicts WebAssembly with the Japanese
// fixture and the English and Arabic fixture dictionaries of
// make-language-fixtures.mjs, and the fixture packs of test/data/languages/.
//
//   - a Japanese request without `language`, `dictionaries` or
//     `languageOptions` answers with exactly the bytes today's build gave
//     (test/data/languages-japanese-replies.json, recorded from the build
//     before the language ABI with --record);
//   - hdw_language_load, hdw_languages and hdw_deinflect;
//   - hdw_lookup, hdw_lookup_dictionary, hdw_segment and
//     hdw_kanji_with_options with `language` and `dictionaries`, an empty
//     list selecting nothing, and a selection answering as if only it were
//     loaded;
//   - segmentation per language.
//
// HACHIDORI_WASM_VARIANT chooses the build, as for node-smoke.mjs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtureZip } from "./make-fixture.mjs";
import { ARABIC, ENGLISH, PACKS, buildLanguageFixtureZip } from "./make-language-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VARIANT = { fallback: "hoshidicts", "threaded-idbfs": "hoshidicts-threaded-idbfs" }[process.env.HACHIDORI_WASM_VARIANT]
  ?? "hoshidicts-threaded";
const GOLDEN = join(HERE, "data/languages-japanese-replies.json");
const RECORD = process.argv.includes("--record");

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    for (const line of String(error?.message ?? error).split("\n")) console.log(`        ${line}`);
  }
}
const group = name => console.log(`\n# ${name}`);
function ok(condition, message) {
  if (!condition) throw new Error(message);
}
function same(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected: ${b}\n  actual:   ${a}`);
}
const sha256 = text => createHash("sha256").update(text).digest("hex");

const { default: createHoshidicts } = await import(join(HERE, "..", "extension", "vendor", `${VARIANT}.mjs`));
const M = await createHoshidicts();
const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
const lastError = () => call("hdw_last_error", "string", [], []);
const lookupRaw = (text, options = "", maxResults = 32, scanLength = 16) =>
  call("hdw_lookup", "string", ["string", "number", "number", "string"], [text, maxResults, scanLength, options]);
const dictionaryRaw = (text, path, options = "", maxResults = 32, scanLength = 16) =>
  call("hdw_lookup_dictionary", "string", ["string", "string", "number", "number", "string"], [text, path, maxResults, scanLength, options]);
const segmentRaw = (text, options = "", scanLength = 16) =>
  call("hdw_segment", "string", ["string", "number", "string"], [text, scanLength, options]);
const kanjiRaw = character => call("hdw_kanji", "string", ["string"], [character]);

call("hdw_init_storage", "number", ["number"], [0]);
M.FS.mkdir("/work");
// Index into this array is hdw_add_dict's `kind` (engine-service.js KINDS).
const addKinds = (path, kinds) => {
  for (const kind of kinds) ok(call("hdw_add_dict", "number", ["string", "number", "number"], [path, kind, 0]) === 1, `${path}: ${lastError()}`);
};
function importAndAdd(name, bytes, kinds) {
  M.FS.writeFile(`/work/${name}.zip`, bytes);
  const report = JSON.parse(call("hdw_import", "string", ["string", "string", "number"], [`/work/${name}.zip`, "/dicts", 0]));
  ok(report.success, `${name} did not import: ${report.error}`);
  const path = `/dicts/${report.title}`;
  addKinds(path, kinds);
  return path;
}

// Japanese requests as today's callers make them: hover options, the
// segmenter, a single dictionary and the kanji view (engine-service.js).
const OPTIONS = JSON.stringify({ frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "", metadataOnlyTerms: false });
const JAPANESE_REQUESTS = [
  ["hdw_lookup", "食べたかった", ""], ["hdw_lookup", "食べたかった", OPTIONS], ["hdw_lookup", "漢字を読む", OPTIONS],
  ["hdw_lookup", "ありがとう", OPTIONS], ["hdw_lookup", "読まなかった", OPTIONS], ["hdw_lookup", "run", OPTIONS],
  ["hdw_lookup_dictionary", "食べた", OPTIONS], ["hdw_segment", "漢字を読んで食べた。", OPTIONS],
  ["hdw_kanji", "食", ""], ["hdw_kanji", "漢", ""],
];
function japaneseReplies(japanesePath) {
  return JAPANESE_REQUESTS.map(([name, text, options]) => {
    if (name === "hdw_lookup") return lookupRaw(text, options);
    if (name === "hdw_lookup_dictionary") return dictionaryRaw(text, japanesePath, options);
    if (name === "hdw_segment") return segmentRaw(text, options);
    return kanjiRaw(text);
  });
}

group("Japanese requests without language keys");
const japanesePath = importAndAdd("japanese", buildFixtureZip(), [0, 1, 2, 3]);
const japaneseOnly = japaneseReplies(japanesePath);
if (RECORD) {
  writeFileSync(GOLDEN, `${JSON.stringify({
    description: "SHA-256 of the replies of hoshidicts WebAssembly to Japanese requests without language keys, on the "
      + "Japanese fixture alone, recorded from the build before the language ABI (test/node-smoke-languages.mjs --record).",
    requests: JAPANESE_REQUESTS.map(([name, text, options], index) => ({ name, text, options, sha256: sha256(japaneseOnly[index]) })),
  }, null, 2)}\n`);
  console.log(`recorded ${JAPANESE_REQUESTS.length} replies to ${GOLDEN}`);
  process.exit(0);
}
const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
check("the requests are the recorded ones", () => same(golden.requests.map(({ name, text, options }) => [name, text, options]),
  JAPANESE_REQUESTS, "request list"));
for (const [index, [name, text]] of JAPANESE_REQUESTS.entries()) {
  check(`${name}(${text}) answers with today's bytes`, () => {
    ok(sha256(japaneseOnly[index]) === golden.requests[index].sha256, `reply differs from the recorded build: ${japaneseOnly[index].slice(0, 300)}`);
  });
}

group("hdw_language_load and hdw_languages");
const pack = code => [readFileSync(join(PACKS, code, "language.json"), "utf8"), readFileSync(join(PACKS, code, "transforms.json"), "utf8")];
const loadLanguage = (languageJson, transformsJson) =>
  call("hdw_language_load", "number", ["string", "string"], [languageJson, transformsJson]);
const languages = () => JSON.parse(call("hdw_languages", "string", [], []));
check("only the built-in Japanese pack is loaded at start", () => same(languages(), ["ja"], "hdw_languages"));
check("a malformed pack is refused with an error", () => {
  ok(loadLanguage("{", "") === 0, "loaded malformed JSON");
  ok(lastError() !== "", "no error for malformed JSON");
  const [english] = pack("en");
  ok(loadLanguage(JSON.stringify({ ...JSON.parse(english), unknownKey: true }), pack("en")[1]) === 0, "loaded an unknown key");
});
check("the English and Arabic packs load", () => {
  for (const code of ["en", "ar"]) ok(loadLanguage(...pack(code)) === 1, `${code}: ${lastError()}`);
  same([...languages()].sort(), ["ar", "en", "ja"], "hdw_languages");
});
check("a pack survives hdw_reset", () => {
  call("hdw_reset", null, [], []);
  same([...languages()].sort(), ["ar", "en", "ja"], "hdw_languages after reset");
});

group("hdw_deinflect");
const deinflect = (text, code) => JSON.parse(call("hdw_deinflect", "string", ["string", "string"], [text, code]));
check("English deinflections carry conditions and transform ids", () => {
  const reply = deinflect("walked", "en");
  ok(reply.results.some(result => result.text === "walk" && JSON.stringify(result.trace) === JSON.stringify(["past"])),
    JSON.stringify(reply));
});
check("an unknown language is an error", () => {
  call("hdw_deinflect", "string", ["string", "string"], ["walked", "zz"]);
  ok(lastError() !== "", "no error for an unknown language");
});

group("lookups with language and dictionaries");
// The reset unloaded the Japanese fixture; its files stay.
addKinds(japanesePath, [0, 1, 2, 3]);
const englishPath = importAndAdd("english", buildLanguageFixtureZip(ENGLISH), [0]);
const arabicPath = importAndAdd("arabic", buildLanguageFixtureZip(ARABIC), [0]);
const withLanguage = (language, dictionaries, extra = {}) =>
  JSON.stringify({ ...JSON.parse(OPTIONS), language, dictionaries, ...extra });
const lookup = (text, options) => JSON.parse(lookupRaw(text, options));
check("an English lookup finds the English lemma", () => {
  const { results } = lookup("running", withLanguage("en", [englishPath]));
  ok(results[0]?.term.expression === "run", JSON.stringify(results[0]));
  same(results[0].trace.map(step => step.name), ["-ing"], "trace");
  ok(lookup("books", withLanguage("en", [englishPath])).results[0]?.term.expression === "book", "books");
  ok(lookup("went", withLanguage("en", [englishPath])).results[0]?.term.expression === "go", "went");
});
check("an Arabic lookup strips diacritics and the definite article", () => {
  ok(lookup("\u0627\u0644\u0643\u062A\u0627\u0628", withLanguage("ar", [arabicPath])).results[0]?.term.expression === "\u0643\u062A\u0627\u0628", "al-kitab");
  ok(lookup("\u0643\u0650\u062A\u064E\u0627\u0628", withLanguage("ar", [arabicPath])).results[0]?.term.expression === "\u0643\u062A\u0627\u0628", "kitab with harakat");
});
check("an empty dictionary list finds nothing", () => {
  same(lookup("running", withLanguage("en", [])).results, [], "English with no dictionaries");
  same(lookup("食べた", withLanguage("ja", [])).results, [], "Japanese with no dictionaries");
});
check("a selection answers as if only it were loaded", () => {
  const selected = JSON.parse(lookupRaw("食べたかった", withLanguage("ja", [japanesePath])));
  const alone = JSON.parse(japaneseOnly[1]);
  same(selected.results, alone.results, "Japanese results with every dictionary loaded");
  same(lookup("running", withLanguage("en", [englishPath, japanesePath])).results.map(result => result.term.expression)[0], "run",
    "English first");
});
check("a path that is not loaded is ignored", () => {
  same(lookup("running", withLanguage("en", ["/dicts/not-loaded", englishPath])).results.map(result => result.term.expression)[0],
    "run", "ignored path");
});
check("an unknown language is an error, never a Japanese answer", () => {
  lookupRaw("running", withLanguage("zz", [englishPath]));
  ok(lastError() !== "", "no error for an unknown language");
});
check("hdw_lookup_dictionary keeps its dictionary within the selection", () => {
  const reply = JSON.parse(dictionaryRaw("running", englishPath, withLanguage("en", [englishPath])));
  ok(reply.results[0]?.term.expression === "run", JSON.stringify(reply.results[0]));
  same(JSON.parse(dictionaryRaw("running", englishPath, withLanguage("en", [arabicPath]))).results, [], "outside the selection");
});
check("hdw_kanji_with_options reads only the selection", () => {
  const options = selection => JSON.stringify({ language: "ja", dictionaries: selection });
  const kanji = selection => JSON.parse(call("hdw_kanji_with_options", "string", ["string", "string"], ["食", options(selection)]));
  ok(kanji([japanesePath]).entries.length > 0, "no kanji entry from the Japanese fixture");
  same(kanji([englishPath]).entries, [], "an English selection has no kanji");
  same(JSON.parse(call("hdw_kanji_with_options", "string", ["string", "string"], ["食", ""])), JSON.parse(kanjiRaw("食")),
    "no options is hdw_kanji");
});

group("segmentation per language");
const spans = (text, options) => JSON.parse(segmentRaw(text, options)).spans;
check("English text is split at word starts", () => {
  const text = "she was running";
  const words = spans(text, withLanguage("en", [englishPath])).map(span => text.slice(span.start, span.start + span.length));
  ok(words.includes("running"), JSON.stringify(words));
});
check("Arabic text is split at word starts", () => {
  const text = "\u0627\u0644\u0643\u062A\u0627\u0628 \u0628\u064A\u062A";
  const words = spans(text, withLanguage("ar", [arabicPath])).map(span => text.slice(span.start, span.start + span.length));
  same(words, ["\u0627\u0644\u0643\u062A\u0627\u0628", "\u0628\u064A\u062A"], "Arabic spans");
});
check("Japanese segmentation with its selection is today's", () => {
  same(spans("漢字を読んで食べた。", withLanguage("ja", [japanesePath])), JSON.parse(japaneseOnly[7]).spans, "Japanese spans");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
