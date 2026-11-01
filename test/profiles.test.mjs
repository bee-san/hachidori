// SPDX-License-Identifier: GPL-3.0-or-later
//
// The profile layer (docs/languages.md, sections 4-6 and 18): projections of
// every stored shape, the one options writer, capability masking, the
// dictionary-state views, and the single-profile invariant against golden
// files recorded from reader-options.js before profiles existed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const ROOT = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, ROOT), "utf8");
const golden = JSON.parse(read("test/data/profiles-golden.json"));
const LANGUAGES = JSON.parse(read("test/data/profile-languages.json"));

const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// A fresh reader-options.js, optionally beside a registry of fixture packs.
// Its results are copied into this realm, except a result that is one of the
// arguments, whose identity a test may check.
function readerOptions(languages = null) {
  const context = { URL };
  if (languages !== null) {
    context.HDLanguages = { get: code => languages[code] ?? null, codes: Object.keys(languages) };
  }
  vm.runInNewContext(read("extension/reader-options.js"), context);
  const api = context.HDReaderOptions;
  return new Proxy(api, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return plain(value);
      return (...args) => {
        const result = value(...args);
        return args.includes(result) ? result : plain(result);
      };
    },
  });
}

const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (Array.isArray(value.$repeat) && Object.keys(value).length === 1) {
      const [prefix, unit, times, suffix] = value.$repeat;
      return prefix + unit.repeat(times) + suffix;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

const goldenInputs = golden.entries.map(entry => ({ entry, input: entry.undefined ? undefined : decode(entry.input) }));

test("every stored record the existing suites use projects exactly as before profiles", () => {
  const options = readerOptions();
  for (const { entry, input } of goldenInputs) {
    const normalised = plain(options.normaliseOptions(input));
    assert.deepEqual(normalised, { ...golden.defaults, ...decode(entry.normalised) });
    assert.equal(sha256(normalised), entry.normalisedSha256);
    assert.equal(sha256(plain(options.projectStoredOptions(input))), entry.storedSha256);
    // The Japanese profile of a single-profile record is today's projection.
    assert.equal(sha256(plain(options.projectOptions(input, "ja"))), entry.normalisedSha256);
    assert.equal(sha256(plain(options.projectOptions(input, "ja", { masked: false }))), entry.normalisedSha256);
  }
  assert.ok(golden.entries.length > 700, "the golden covers the suites' records");
});

test("the registry changes nothing for a single-profile record", () => {
  const options = readerOptions(LANGUAGES);
  for (const { entry, input } of goldenInputs) {
    assert.equal(sha256(plain(options.projectOptions(input, "ja"))), entry.normalisedSha256);
  }
});

test("a single-profile record reads as one Japanese profile with its own profile keys", () => {
  const options = readerOptions();
  const stored = { revision: 4, scanLength: 20, hoverEnabled: false, popupTheme: "jl",
    anki: { url: "http://127.0.0.1:8765", apiKey: "k", templates: [{ id: "default", name: "Default", deck: "JP" }] } };
  const [profile, ...rest] = options.profiles(stored);
  assert.deepEqual(rest, []);
  assert.equal(profile.id, "ja");
  assert.equal(profile.language, "ja");
  assert.deepEqual(profile.packSettings, {});
  assert.equal(profile.settings.scanLength, 20);
  assert.equal(profile.settings.popupTheme, "jl");
  assert.equal(Object.hasOwn(profile.settings, "hoverEnabled"), false, "hoverEnabled is global");
  assert.equal(profile.settings.anki.templates[0].deck, "JP");
  assert.deepEqual(Object.keys(profile.settings.anki), ["templates"]);
  assert.deepEqual(options.profiles(undefined), [{ id: "ja", language: "ja", settings: {}, packSettings: {} }]);
  assert.deepEqual(plain(options.profileDescriptor(stored, "ja")), { id: "ja", language: "ja", packSettings: {} });
  assert.equal(options.profileDescriptor(stored, "en"), null);
});

test("the scope lists partition every option key as Appendix A says", () => {
  const options = readerOptions();
  const keys = Object.keys(options.DEFAULT_OPTIONS);
  const global = new Set(options.GLOBAL_OPTION_KEYS);
  const profile = new Set(options.PROFILE_OPTION_KEYS);
  for (const key of keys) {
    assert.equal(Number(global.has(key)) + Number(profile.has(key)) + Number(key === "anki"), 1, key);
  }
  // Appendix A of docs/languages-inventory.md: `key` (default) | control | assumption | G… or P….
  const appendix = read("docs/languages-inventory.md").split("\n## B.")[0];
  const scopes = new Map([...appendix.matchAll(/^\| `([A-Za-z]+)` \([^)]*\) \|.*\| ([GP])[;,. ]/gmu)]
    .map(([, key, scope]) => [key, scope]));
  for (const key of keys.filter(name => name !== "anki")) {
    assert.ok(scopes.has(key), `Appendix A lists ${key}`);
    assert.equal(global.has(key) ? "G" : "P", scopes.get(key), key);
  }
});

function withProfiles() {
  return {
    revision: 9,
    hoverEnabled: false,
    popupWidthPx: 640,
    keybinds: [],
    anki: { url: "http://127.0.0.1:8766", apiKey: "secret" },
    profiles: [
      { id: "ja", language: "ja", settings: { scanLength: 12, popupTheme: "jl", showPitchAccentGraph: true,
        anki: { templates: [{ id: "jp", name: "Japanese", deck: "JP", model: "Lapis" }] } }, packSettings: {} },
      { id: "ar", language: "ar", settings: { scanLength: 24, showPitchAccentGraph: true, wordHighlightEnabled: true,
        kanjiClickDictionary: "Some kanji", pitchAccentFuriganaDictionary: "Pitch",
        anki: { templates: [{ id: "arabic", name: "Arabic", deck: "AR" }] } }, packSettings: { vowelMarks: "hide" } },
    ],
  };
}

test("projectOptions joins the global keys with one profile's keys and splits anki", () => {
  const options = readerOptions(LANGUAGES);
  const stored = withProfiles();
  const ja = options.projectOptions(stored, "ja");
  assert.deepEqual(Object.keys(ja), Object.keys(options.normaliseOptions({})), "flat options keep today's shape");
  assert.equal(ja.hoverEnabled, false);
  assert.equal(ja.popupWidthPx, 640);
  assert.equal(ja.scanLength, 12);
  assert.equal(ja.popupTheme, "jl");
  assert.equal(ja.anki.url, "http://127.0.0.1:8766");
  assert.equal(ja.anki.apiKey, "secret");
  assert.equal(ja.anki.deck, "JP");
  assert.equal(ja.anki.templates[0].id, "jp");
  assert.equal(ja.showPitchAccentGraph, true, "Japanese has pitch accent");
  const ar = options.projectOptions(stored, "ar", { masked: false });
  assert.equal(ar.hoverEnabled, false, "global keys are shared");
  assert.equal(ar.scanLength, 24);
  assert.equal(ar.popupTheme, "default", "a missing profile key takes its default");
  assert.equal(ar.anki.deck, "AR");
  assert.equal(ar.anki.url, "http://127.0.0.1:8766");
  assert.equal(ar.showPitchAccentGraph, true, "unmasked keeps the stored value");
  // normaliseOptions of a record with profiles is its Japanese profile.
  assert.deepEqual(plain(options.normaliseOptions(stored)), plain(ja));
  assert.deepEqual(plain(options.profileDescriptor(stored, "ar")), { id: "ar", language: "ar", packSettings: { vowelMarks: "hide" } });
});

test("masking replaces settings a language lacks by their neutral values, which are inert", () => {
  const options = readerOptions(LANGUAGES);
  const stored = withProfiles();
  const ar = options.projectOptions(stored, "ar");
  for (const [key, { neutral }] of Object.entries(options.OPTION_REQUIREMENTS)) {
    if (key.startsWith("wordHighlight")) continue;
    assert.deepEqual(ar[key], neutral, key);
  }
  assert.equal(ar.wordHighlightEnabled, true, "Arabic has word highlighting");
  // The two Automatic neutral values are inert: without a character view
  // nothing is clickable, and every pitch switch is masked with them.
  assert.equal(ar.kanjiClickDictionary, "");
  assert.equal(ar.pitchAccentFuriganaDictionary, "");
  assert.equal(options.optionRequirementMet("characterView", "ar"), false);
  for (const [key, { requires, neutral }] of Object.entries(options.OPTION_REQUIREMENTS)) {
    if (requires === "pitchAccent" && typeof neutral === "boolean") assert.equal(ar[key], false, key);
  }
  // Japanese meets every requirement, with or without a registry.
  for (const [key] of Object.entries(options.OPTION_REQUIREMENTS)) {
    assert.deepEqual(options.projectOptions(stored, "ja")[key], options.projectOptions(stored, "ja", { masked: false })[key]);
  }
  const bare = readerOptions();
  assert.equal(bare.optionRequirementMet("pitchAccent", "ja"), true);
  assert.equal(bare.optionRequirementMet("wordHighlighting", "ar"), false, "a language without a descriptor meets nothing");
  // Hidden values are kept: masking never writes the record.
  assert.equal(options.applyOptionsPatch(stored, {}, "ar").profiles[1].settings.showPitchAccentGraph, true);
});

test("requirements: scripts with Hani, note-type families and optional capabilities", () => {
  const korean = { ...LANGUAGES.ar, code: "ko", scripts: ["Kore"], capabilities: { ...LANGUAGES.ar.capabilities,
    characterView: { name: "Hanja", pattern: "[\\u4E00-\\u9FFF]", optional: true } },
  settings: [{ id: "hanja", type: "boolean", default: false, effect: { capability: "characterView" } }] };
  const options = readerOptions({ ...LANGUAGES, ko: korean });
  assert.equal(options.optionRequirementMet({ scripts: ["Hani"] }, "ja"), true, "Jpan includes Han");
  assert.equal(options.optionRequirementMet({ scripts: ["Hani"] }, "ko"), true, "Kore includes Han");
  assert.equal(options.optionRequirementMet({ scripts: ["Hani"] }, "ar"), false);
  assert.equal(options.optionRequirementMet({ scripts: ["Arab"] }, "ar"), true);
  assert.equal(options.optionRequirementMet("ankiNoteTypeFamilies", "ja"), true);
  assert.equal(options.optionRequirementMet("ankiNoteTypeFamilies", "ar"), false);
  assert.equal(options.optionRequirementMet("characterView", "ko"), false, "an optional capability starts off");
  assert.equal(options.optionRequirementMet("characterView", "ko", { hanja: true }), true);
  assert.equal(options.optionRequirementMet("characterView", "ko", { hanja: "yes" }), false, "an invalid value reads as the default");
  assert.equal(options.packSettingValue(LANGUAGES.ar, { vowelMarks: "hide" }, "vowelMarks"), "hide");
  assert.equal(options.packSettingValue(LANGUAGES.ar, { vowelMarks: "sometimes" }, "vowelMarks"), "show");
});

test("applyOptionsPatch writes global keys to the top level and profile keys to the named profile only", () => {
  const options = readerOptions(LANGUAGES);
  const stored = withProfiles();
  const anki = options.normaliseAnki({ url: "http://127.0.0.1:9000", apiKey: "new",
    templates: [{ id: "arabic", name: "Arabic", deck: "AR2" }] });
  const patch = options.validateOptionsPatch({ hoverEnabled: true, scanLength: 30, popupTheme: "bee", anki });
  const next = options.applyOptionsPatch(stored, patch, "ar");
  assert.equal(next.revision, 9, "callers move the revision");
  assert.equal(next.hoverEnabled, true);
  assert.deepEqual(next.anki, { url: "http://127.0.0.1:9000", apiKey: "new" });
  const [ja, ar] = next.profiles;
  assert.deepEqual(plain(ja), plain(options.profiles(stored)[0]), "other profiles stay intact");
  assert.equal(ar.settings.scanLength, 30);
  assert.equal(ar.settings.popupTheme, "bee");
  assert.equal(ar.settings.anki.templates[0].deck, "AR2");
  assert.deepEqual(Object.keys(ar.settings.anki), ["templates"]);
  assert.deepEqual(ar.packSettings, { vowelMarks: "hide" });
  assert.equal(Object.hasOwn(next, "scanLength"), false, "profile keys live only in profiles");
  assert.equal(options.projectOptions(next, "ja").anki.url, "http://127.0.0.1:9000", "the connection is shared");
  assert.throws(() => options.applyOptionsPatch(stored, { scanLength: 3 }, "en"), /profile that does not exist/u);
  // A patch of global keys alone needs no profile, in any shape.
  assert.equal(options.applyOptionsPatch(stored, { hoverEnabled: true }, "en").hoverEnabled, true);
});

test("applyOptionsPatch is today's write for a single-profile record", () => {
  const options = readerOptions(LANGUAGES);
  for (const { input } of goldenInputs) {
    const patch = options.validateOptionsPatch({ scanLength: 7, hoverEnabled: false });
    const revision = Number.isInteger(input?.revision) && input.revision >= 0 ? input.revision : 0;
    // background-core.js optionsWriteResult before profiles.
    const today = { ...{ ...options.projectStoredOptions(input), revision }, ...patch };
    assert.equal(JSON.stringify(options.applyOptionsPatch(input, patch, "ja")), JSON.stringify(today));
  }
});

test("pack settings are validated against the profile's pack and unknown ids are kept", () => {
  const options = readerOptions(LANGUAGES);
  const stored = withProfiles();
  const next = options.applyPackSettingsPatch(stored, { vowelMarks: "show", futureSetting: 3 }, "ar");
  assert.deepEqual(next.profiles[1].packSettings, { vowelMarks: "show", futureSetting: 3 });
  assert.deepEqual(next.profiles[0], options.profiles(stored)[0]);
  assert.throws(() => options.applyPackSettingsPatch(stored, { vowelMarks: "sometimes" }, "ar"), /invalid value/u);
  assert.throws(() => options.applyPackSettingsPatch({ revision: 1 }, { vowelMarks: "show" }, "ja"), /no settings/u);
  assert.equal(options.applyPackSettingsPatch(stored, {}, "ar"), stored);
});

function schema2() {
  return {
    schemaVersion: 2,
    revision: 31,
    dictionaries: [
      { id: "custom", title: "Hachidori Custom Dictionary", displayName: null, path: "/dicts/a", favorite: false, language: "ja" },
      { id: "jitendex", title: "Jitendex", displayName: null, path: "/dicts/b", favorite: true, language: "ja" },
      { id: "arabic", title: "Arabic", displayName: "AR", path: "/dicts/c", favorite: false, language: "ar" },
      { id: "spare", title: "Spare", displayName: null, path: "/dicts/d", favorite: false, language: "en" },
    ],
    profiles: {
      ja: { dictionaries: [{ id: "custom", enabled: true }, { id: "jitendex", enabled: false }], groups: [] },
      ar: { dictionaries: [{ id: "arabic", enabled: true }, { id: "jitendex", enabled: true }],
        groups: [{ id: "g1", name: "Main", dictionaryIds: ["arabic"] }] },
    },
  };
}

test("projectDictionaryState is one profile's schema-1 view; allPackages is the union", () => {
  const options = readerOptions();
  const state = schema2();
  const ar = options.projectDictionaryState(state, "ar");
  assert.equal(ar.schemaVersion, 1);
  assert.equal(ar.revision, 31);
  assert.deepEqual(ar.dictionaries.map(row => [row.id, row.enabled]), [["arabic", true], ["jitendex", true]]);
  assert.deepEqual(Object.keys(ar.dictionaries[0]), ["id", "title", "displayName", "path", "enabled", "favorite", "language"],
    "enabled sits where today's rows carry it");
  assert.deepEqual(ar.groups, [{ id: "g1", name: "Main", dictionaryIds: ["arabic"] }]);
  assert.deepEqual(options.projectDictionaryState(state, "ja").dictionaries.map(row => [row.id, row.enabled]),
    [["custom", true], ["jitendex", false]]);
  assert.equal(options.projectDictionaryState(state, "en"), null);
  assert.deepEqual(options.allPackages(state).map(row => [row.id, row.enabled]),
    [["custom", true], ["jitendex", true], ["arabic", true], ["spare", false]]);
  const single = { schemaVersion: 1, revision: 3, dictionaries: [{ id: "x", title: "X", enabled: false }], groups: [] };
  assert.equal(options.projectDictionaryState(single, "ja"), single, "a single-profile state is its own view");
  assert.deepEqual(options.allPackages(single), single.dictionaries);
  assert.equal(options.projectDictionaryState(single, "ar"), null);
  assert.equal(options.projectDictionaryState(null, "ja"), null);
  assert.deepEqual(options.allPackages(null), []);
});
