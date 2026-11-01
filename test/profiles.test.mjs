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

// ---------------------------------------------------------------------------
// The service worker (docs/languages.md 4.3, 5.2, 5.4, 9.3), run through the
// extension smoke suite's harness. Its modules are one script there, without
// their imports, so the new modules' exports are handed to it as globals.
// ---------------------------------------------------------------------------

const { loadBackgroundScript, makeAlarms, makeBus, makeChrome, makeStorage } = await import("./extension-smoke/fakes.mjs");
const profileState = await import("../extension/profile-state.js");
const ankiWorker = await import("../extension/anki-worker.js");
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const fixtureRegistry = { get: code => LANGUAGES[code] ?? null, codes: ["ja", "en", "ar"] };
// The modules imported here read the registry of this realm.
globalThis.HDLanguages = fixtureRegistry;

function unref(timer) {
  timer?.unref?.();
  return timer;
}

function backgroundWorker(records = {}) {
  const bus = makeBus();
  const storage = makeStorage();
  for (const [key, value] of Object.entries(records)) storage.raw.set(key, structuredClone(value));
  const alarms = makeAlarms();
  const sandbox = {
    chrome: makeChrome("sw", bus, storage, alarms), console: quiet, Promise, Error, TypeError, JSON, URL, Map, Set,
    setTimeout: (...args) => unref(setTimeout(...args)), clearTimeout,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
    HDLanguages: fixtureRegistry,
    ...Object.fromEntries(Object.entries(profileState).filter(([, value]) => typeof value === "function")),
    profileTemplateKey: ankiWorker.profileTemplateKey,
  };
  const context = loadBackgroundScript(sandbox);
  const page = makeChrome("page", bus, storage, alarms);
  const engine = makeChrome("offscreen", bus, storage, alarms);
  const relayed = [];
  bus.addListener("engine-host", (message, _sender, respond) => {
    if (message?.relayed !== true || message.target !== "hoshidicts-offscreen") return false;
    relayed.push(structuredClone(message));
    respond({ type: `${message.type}_result`, requestId: message.requestId ?? null, ok: true, results: [], dictionaryCount: 0 });
    return true;
  });
  return {
    context, storage, relayed,
    stored: key => structuredClone(storage.raw.get(key)),
    worker: message => page.runtime.sendMessage({ target: "hoshidicts-worker", ...message }),
    fromEngine: message => engine.runtime.sendMessage({ target: "hoshidicts-worker", ...message }),
    lookup: message => page.runtime.sendMessage({ target: "hoshidicts-offscreen", ...message }),
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function profileRecords() {
  const state = schema2();
  state.profiles.ar.dictionaries.push({ id: "spare", enabled: false });
  return {
    options: withProfiles(),
    dictionaryState: state,
  };
}

test("the worker writes options to the profile a request names", async () => {
  const { worker, stored } = backgroundWorker(profileRecords());
  let reply = await worker({ type: "hd_options_write", baseRevision: 9, profileId: "ar",
    options: { scanLength: 30, hoverEnabled: true } });
  assert.equal(reply.ok, true, reply.error);
  let options = stored("options");
  assert.equal(options.revision, 10);
  assert.equal(options.hoverEnabled, true);
  assert.equal(options.profiles[1].settings.scanLength, 30);
  assert.equal(options.profiles[0].settings.scanLength, 12, "Japanese keeps its own scan length");
  // A request that names no profile means the Japanese data (section 5.2).
  reply = await worker({ type: "hd_options_write", baseRevision: 10, options: { scanLength: 9 } });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(stored("options").profiles[0].settings.scanLength, 9);
  reply = await worker({ type: "hd_options_write", baseRevision: 11, profileId: "en", options: { scanLength: 9 } });
  assert.equal(reply.ok, false);
  assert.equal(reply.errorCode, "profile-missing");
  reply = await worker({ type: "hd_options_write", baseRevision: 11, profileId: "ar", options: {},
    packSettings: { vowelMarks: "hide" } });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(stored("options").profiles[1].packSettings, { vowelMarks: "hide" });
  reply = await worker({ type: "hd_options_write", baseRevision: 11, profileId: "ar", options: {},
    packSettings: { vowelMarks: "maybe" } });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /invalid value/u);
  options = stored("options");
  assert.equal(options.revision, 11, "an unchanged pack setting writes nothing");
});

test("a request that names no profile is refused without a Japanese profile, unless it writes global keys", async () => {
  const records = profileRecords();
  records.options.profiles = records.options.profiles.filter(profile => profile.id !== "ja");
  delete records.dictionaryState.profiles.ja;
  const { worker, stored } = backgroundWorker(records);
  let reply = await worker({ type: "hd_options_write", baseRevision: 9, options: { scanLength: 3 } });
  assert.equal(reply.ok, false);
  assert.equal(reply.errorCode, "no-japanese-profile");
  assert.equal(reply.error, "This Hachidori has no Japanese profile. Add Japanese in its Settings, or update the linked browser.");
  reply = await worker({ type: "hd_options_write", baseRevision: 9, options: { hoverEnabled: true } });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(stored("options").hoverEnabled, true);
});

test("a profile's dictionary view merges into the whole state; an older client's view means Japanese", async () => {
  const { worker, stored } = backgroundWorker(profileRecords());
  const view = readerOptions().projectDictionaryState(schema2(), "ar");
  view.dictionaries = [{ ...view.dictionaries[1], displayName: "J" }, view.dictionaries[0]];
  let reply = await worker({ type: "hd_state_cas", baseRevision: 31, profileId: "ar", dictionaries: view.dictionaries,
    groups: [{ id: "g1", name: "Main", dictionaryIds: ["arabic", "missing"] }] });
  assert.equal(reply.ok, true, reply.error);
  let state = stored("dictionaryState");
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.revision, 32);
  assert.deepEqual(state.profiles.ar.dictionaries, [{ id: "jitendex", enabled: true }, { id: "arabic", enabled: true }]);
  assert.deepEqual(state.profiles.ar.groups, [{ id: "g1", name: "Main", dictionaryIds: ["arabic"] }]);
  assert.deepEqual(state.profiles.ja, schema2().profiles.ja, "other profiles are left alone");
  assert.equal(state.dictionaries.find(row => row.id === "jitendex").displayName, "J", "package-wide fields are written");
  assert.equal(Object.hasOwn(state.dictionaries[0], "enabled"), false);
  // A view from a client that predates profiles lists every package.
  const legacy = profileState.japaneseDictionaryView(state).dictionaries
    .map(row => row.id === "spare" ? { ...row, enabled: true } : row);
  reply = await worker({ type: "hd_state_cas", baseRevision: 32, dictionaries: legacy });
  assert.equal(reply.ok, true, reply.error);
  state = stored("dictionaryState");
  assert.deepEqual(state.profiles.ja.dictionaries.map(entry => entry.id), ["custom", "jitendex", "spare"],
    "the Japanese profile keeps its packages and gains only enabled ones");
  reply = await worker({ type: "hd_state_cas", baseRevision: 33, profileId: "ar",
    dictionaries: [{ id: "unknown", title: "Unknown", enabled: true }] });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not installed/u);
});

test("the engine's whole-state commit prunes every profile's selections against its own packages", async () => {
  const records = profileRecords();
  records.options.profiles[1].settings.frequencyDictionary = "Arabic";
  records.options.profiles[0].settings.frequencyDictionary = "Jitendex";
  records.dictionaryState.dictionaries[1].frequencyCount = 1;
  records.dictionaryState.dictionaries[2].frequencyCount = 1;
  const { fromEngine, stored } = backgroundWorker(records);
  const state = stored("dictionaryState");
  const next = { dictionaries: state.dictionaries, profiles: { ...state.profiles,
    ar: { dictionaries: state.profiles.ar.dictionaries.filter(entry => entry.id !== "arabic"), groups: [] } } };
  const reply = await fromEngine({ type: "hd_state_cas", baseRevision: 31, state: next });
  assert.equal(reply.ok, true, reply.error);
  const options = stored("options");
  assert.equal(options.profiles[1].settings.frequencyDictionary, "", "Arabic left the profile");
  assert.equal(options.profiles[0].settings.frequencyDictionary, "", "Jitendex is disabled in Japanese");
  const conflict = await fromEngine({ type: "hd_state_cas", baseRevision: 31, state: next });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
});

function singleProfileRecords() {
  return {
    options: { revision: 4, scanLength: 20, popupTheme: "jl", hoverEnabled: false, frequencyDictionary: "Jitendex",
      anki: { url: "http://127.0.0.1:8765", apiKey: "", templates: [{ id: "default", name: "Default", deck: "JP", model: "Lapis" }] } },
    dictionaryState: { schemaVersion: 1, revision: 6, groups: [{ id: "g", name: "G", dictionaryIds: ["jitendex"] }], dictionaries: [
      { id: "jitendex", title: "Jitendex", displayName: null, path: "/dicts/a", enabled: true, favorite: false, language: "ja",
        frequencyCount: 1 },
      { id: "other", title: "Other", displayName: null, path: "/dicts/b", enabled: false, favorite: false, language: "ja" },
    ] },
  };
}

test("adding a second language converts the records; removing it converts them back", async () => {
  const records = singleProfileRecords();
  const { fromEngine, stored, storage } = backgroundWorker(records);
  const converted = profileState.dictionaryStateWithProfiles(records.dictionaryState);
  const added = { ...converted.profiles, en: { dictionaries: [], groups: [] } };
  let reply = await fromEngine({ type: "hd_profile_cas", action: "add", language: "en", copyFrom: "ja", baseRevision: 6,
    state: { dictionaries: converted.dictionaries, profiles: added } });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(plain(reply.languages), ["ja", "en"]);
  const options = stored("options");
  assert.equal(options.revision, 5);
  assert.equal(options.hoverEnabled, false);
  assert.deepEqual(options.anki, { url: "http://127.0.0.1:8765", apiKey: "" });
  const [ja, en] = options.profiles;
  assert.equal(ja.settings.scanLength, 20);
  assert.equal(ja.settings.anki.templates[0].id, "default");
  assert.equal(en.settings.scanLength, 20, "the new profile copies the profile it was added from");
  assert.equal(en.settings.popupTheme, "jl");
  assert.equal(Object.hasOwn(en.settings, "frequencyDictionary"), false, "dictionary selections are unset");
  assert.notEqual(en.settings.anki.templates[0].id, "default", "Templates get new ids");
  assert.equal(en.settings.anki.templates[0].model, "Lapis");
  assert.equal(en.settings.anki.templates[0].deck, "");
  assert.deepEqual(en.settings.audioSources.map(source => source.type), ["text-to-speech"]);
  assert.deepEqual(en.settings.customButtons, []);
  const state = stored("dictionaryState");
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.profiles.ja, { dictionaries: [{ id: "jitendex", enabled: true }, { id: "other", enabled: false }],
    groups: [{ id: "g", name: "G", dictionaryIds: ["jitendex"] }] });
  // A selection, then removing English: the records convert back and the selection goes.
  await storage.api().local.set({ languageSelection: { revision: 1, activeProfileId: "en", autoSwitch: false } });
  const removed = { ja: state.profiles.ja };
  reply = await fromEngine({ type: "hd_profile_cas", action: "remove", profileId: "en", language: "en", baseRevision: 7,
    state: { dictionaries: state.dictionaries, profiles: removed } });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.converted, true);
  assert.deepEqual(stored("dictionaryState"), { ...records.dictionaryState, revision: 8 });
  const back = stored("options");
  assert.equal(back.revision, 6);
  assert.equal(Object.hasOwn(back, "profiles"), false);
  assert.equal(back.scanLength, 20);
  assert.equal(back.anki.templates[0].deck, "JP");
  assert.equal(storage.raw.has("languageSelection"), false);
});

test("a language request changes no dictionary and the last language stays", async () => {
  const records = singleProfileRecords();
  const { fromEngine } = backgroundWorker(records);
  const converted = profileState.dictionaryStateWithProfiles(records.dictionaryState);
  let reply = await fromEngine({ type: "hd_profile_cas", action: "add", language: "en", copyFrom: "ja", baseRevision: 6,
    state: { dictionaries: converted.dictionaries.slice(1), profiles: { ...converted.profiles, en: { dictionaries: [], groups: [] } } } });
  assert.equal(reply.ok, false);
  reply = await fromEngine({ type: "hd_profile_cas", action: "add", language: "xx", copyFrom: "ja", baseRevision: 6,
    state: { dictionaries: converted.dictionaries, profiles: { ...converted.profiles, xx: { dictionaries: [], groups: [] } } } });
  assert.equal(reply.ok, false);
  assert.equal(reply.errorCode, "language-unknown");
  reply = await fromEngine({ type: "hd_profile_cas", action: "remove", profileId: "ja", language: "ja", baseRevision: 6,
    state: { dictionaries: converted.dictionaries, profiles: {} } });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /last language/u);
});

test("a first-run choice makes the language the only profile, once, while setup is at its start", async () => {
  const welcome = { schemaVersion: 1, revision: 1, startedAt: "2026-11-01T00:00:00.000Z", stage: "welcome", completedAt: null,
    dictionaries: { outcomes: {}, totalSeconds: null, continued: false, selectionsApplied: [], recordedRuns: [] }, anki: null };
  const { fromEngine, stored } = backgroundWorker({ options: { revision: 1, popupTheme: "auto", scanLength: 14 }, setupState: welcome });
  const message = { type: "hd_profile_cas", action: "add", language: "ar", firstRun: true, baseRevision: 0,
    state: { dictionaries: [], profiles: { ar: { dictionaries: [], groups: [] } } } };
  let reply = await fromEngine(message);
  assert.equal(reply.ok, true, reply.error);
  const options = stored("options");
  assert.deepEqual(options.profiles.map(profile => profile.id), ["ar"]);
  assert.equal(options.profiles[0].settings.scanLength, 14, "edits made before setup move into the profile");
  assert.equal(options.profiles[0].settings.popupTheme, "auto");
  assert.deepEqual(options.profiles[0].packSettings, { vowelMarks: "show" });
  // A retry after a lost reply does no harm.
  reply = await fromEngine({ ...message, baseRevision: 1 });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(stored("options").profiles.map(profile => profile.id), ["ar"]);
  // Japanese at first run is refused once setup has a language.
  reply = await fromEngine({ ...message, language: "en", baseRevision: 1,
    state: { dictionaries: [], profiles: { en: { dictionaries: [], groups: [] } } } });
  assert.equal(reply.ok, false);
  assert.equal(reply.errorCode, "already-set-up");
});

test("erasing a language empties its document, drops its counts and marks, and keeps Japanese's", async () => {
  const records = profileRecords();
  records.options.profiles.push({ id: "en", language: "en", settings: {}, packSettings: {} });
  records.dictionaryState.profiles.en = { dictionaries: [], groups: [] };
  records.customDictionarySource = { schemaVersion: 1, revision: 3, semanticRevision: "a".repeat(64), text: "猫, ねこ, cat\n",
    languages: { en: { revision: 5, semanticRevision: "b".repeat(64), text: "run, , to move fast\n" } } };
  records.lookupStats = { generation: "g-ja", revision: 4, languages: { en: "g-en", ar: "g-ar" } };
  records.wordStatusOverrides = { revision: 2, known: ["猫"], ignored: [], languages: { en: { known: ["run"], ignored: [] } } };
  records["lookupStats:\"g-en\":[\"run\",\"\"]"] = { term: "run", reading: "", lookupCount: 1, firstLookedUpAt: 1, lastLookedUpAt: 1 };
  records["lookupStats:\"g-ja\":[\"猫\",\"ねこ\"]"] = { term: "猫", reading: "ねこ", lookupCount: 1, firstLookedUpAt: 1, lastLookedUpAt: 1 };
  const { fromEngine, stored, storage } = backgroundWorker(records);
  const state = stored("dictionaryState");
  const profiles = { ja: state.profiles.ja, ar: state.profiles.ar };
  const reply = await fromEngine({ type: "hd_profile_cas", action: "remove", profileId: "en", language: "en", erase: true,
    baseRevision: 31, baseDocumentRevision: 5, state: { dictionaries: state.dictionaries, profiles } });
  assert.equal(reply.ok, true, reply.error);
  const document = stored("customDictionarySource");
  assert.equal(document.text, "猫, ねこ, cat\n");
  assert.equal(document.revision, 3);
  assert.deepEqual(document.languages.en, { revision: 6,
    semanticRevision: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", text: "" });
  assert.deepEqual(stored("lookupStats"), { generation: "g-ja", revision: 5, languages: { ar: "g-ar" } });
  assert.deepEqual(stored("wordStatusOverrides"), { revision: 3, known: ["猫"], ignored: [] });
  await settle();
  assert.equal(storage.raw.has("lookupStats:\"g-en\":[\"run\",\"\"]"), false, "the erased language's rows are deleted");
  assert.equal(storage.raw.has("lookupStats:\"g-ja\":[\"猫\",\"ねこ\"]"), true);
});

test("the language choice is installation-local and written only once the records have profiles", async () => {
  const single = backgroundWorker(singleProfileRecords());
  let reply = await single.worker({ type: "hd_language_selection_write", baseRevision: 0, activeProfileId: "ja" });
  assert.equal(reply.ok, false);
  const { worker, stored } = backgroundWorker(profileRecords());
  reply = await worker({ type: "hd_language_selection_write", baseRevision: 0, activeProfileId: "ar" });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(stored("languageSelection"), { revision: 1, activeProfileId: "ar", autoSwitch: false });
  reply = await worker({ type: "hd_language_selection_write", baseRevision: 0, autoSwitch: true });
  assert.equal(reply.conflict, true);
  reply = await worker({ type: "hd_language_selection_write", baseRevision: 1, activeProfileId: "en" });
  assert.equal(reply.errorCode, "profile-missing");
  reply = await worker({ type: "hd_language_selection_write", baseRevision: 1, autoSwitch: true });
  assert.deepEqual(stored("languageSelection"), { revision: 2, activeProfileId: "ar", autoSwitch: true });
});

test("counts and marks are kept per language and each write keeps the other languages'", async () => {
  const records = profileRecords();
  records.lookupStats = { generation: "g-ja", revision: 1 };
  records.wordStatusOverrides = { revision: 1, known: ["猫"], ignored: [] };
  const { worker, stored, storage, context } = backgroundWorker(records);
  let reply = await worker({ type: "hd_lookup_stats_record", profileId: "ar", term: "كتاب", reading: "كتاب" });
  assert.equal(reply.ok, true, reply.error);
  const descriptor = stored("lookupStats");
  assert.equal(descriptor.generation, "g-ja");
  assert.equal(descriptor.revision, 2);
  assert.equal(typeof descriptor.languages.ar, "string");
  assert.equal(reply.statistics.lookupCount, 1);
  reply = await worker({ type: "hd_lookup_stats_record", term: "猫", reading: "ねこ" });
  assert.equal(stored("lookupStats").languages.ar, descriptor.languages.ar, "a Japanese count keeps Arabic's generation");
  assert.ok(storage.raw.has(`lookupStats:"g-ja":["猫","ねこ"]`));
  reply = await worker({ type: "hd_lookup_stats_read", profileId: "ar", term: "كتاب", reading: "كتاب" });
  assert.equal(reply.statistics.lookupCount, 1);
  reply = await worker({ type: "hd_word_status_override", profileId: "ar", headword: "كتاب", status: "known" });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(stored("wordStatusOverrides"), { revision: 2, known: ["猫"], ignored: [], languages: { ar: { known: ["كتاب"], ignored: [] } } });
  reply = await worker({ type: "hd_word_status_override", headword: "犬", status: "ignored" });
  assert.deepEqual(stored("wordStatusOverrides").languages, { ar: { known: ["كتاب"], ignored: [] } }, "a Japanese mark keeps Arabic's");
  // The cleanup keeps every live generation's rows.
  storage.raw.set(`lookupStats:"stale":["x",""]`, { term: "x", reading: "", lookupCount: 1, firstLookedUpAt: 1, lastLookedUpAt: 1 });
  await vm.runInContext("removeObsoleteLookupStatsRows()", context);
  assert.equal(storage.raw.has(`lookupStats:"stale":["x",""]`), false);
  assert.equal(storage.raw.has(`lookupStats:"g-ja":["猫","ねこ"]`), true);
  assert.equal(storage.raw.has(`lookupStats:${JSON.stringify(descriptor.languages.ar)}:${JSON.stringify(["كتاب", "كتاب"])}`), true);
});

test("the personal document is kept per language", async () => {
  const records = profileRecords();
  records.options.profiles.push({ id: "en", language: "en", settings: {}, packSettings: {} });
  records.dictionaryState.profiles.en = { dictionaries: [], groups: [] };
  records.customDictionarySource = { schemaVersion: 1, revision: 3, semanticRevision: "a".repeat(64), text: "猫, ねこ, cat\n" };
  const { worker, fromEngine, stored } = backgroundWorker(records);
  let reply = await worker({ type: "hd_custom_read", profileId: "en" });
  assert.equal(reply.document.text, "");
  assert.equal(reply.document.revision, 0);
  const { customDictionarySemanticRevision, parseCustomDictionary } = await import("../extension/custom-dictionary.js");
  // An English row with no reading; English has no readings.
  const text = "run, , to move fast\n";
  const parsed = parseCustomDictionary(text, { readingRequired: false });
  assert.equal(parsed.entries.length, 1);
  const semanticRevision = await customDictionarySemanticRevision(parsed.entries, { readingRequired: false });
  // Without the package the source alone cannot be saved with entries.
  reply = await fromEngine({ type: "hd_custom_cas", language: "en", baseDocumentRevision: 0, baseRevision: 31, text,
    semanticRevision });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /source semantics/u);
  // An emptied source saves on its own and keeps Japanese's document.
  const empty = await customDictionarySemanticRevision([]);
  reply = await fromEngine({ type: "hd_custom_cas", language: "en", baseDocumentRevision: 0, baseRevision: 31,
    text: "# notes\n", semanticRevision: empty });
  assert.equal(reply.ok, true, reply.error);
  const document = stored("customDictionarySource");
  assert.equal(document.text, "猫, ねこ, cat\n");
  assert.deepEqual(document.languages.en, { revision: 1, semanticRevision: empty, text: "# notes\n" });
  reply = await worker({ type: "hd_custom_read", profileId: "en" });
  assert.equal(reply.document.text, "# notes\n");
  reply = await worker({ type: "hd_custom_read" });
  assert.equal(reply.document.text, "猫, ねこ, cat\n");
});

test("lookups name their profile's language, dictionaries and engine effects; Japanese-only lookups are unchanged", async () => {
  const single = backgroundWorker(singleProfileRecords());
  await settle();
  const request = { type: "hd_lookup", requestId: "r1", text: "食べた", maxResults: 32, scanLength: 16,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" } };
  await single.lookup(request);
  assert.deepEqual(single.relayed, [{ target: "hoshidicts-offscreen", ...request, relayed: true }]);
  const { lookup, relayed } = backgroundWorker(profileRecords());
  await settle();
  await lookup({ ...request, profileId: "ar" });
  await lookup({ ...request, requestId: "r2", language: "en", dictionaries: ["spare"] });
  const [arabic, japanese] = relayed;
  assert.equal(arabic.language, "ar");
  assert.deepEqual(arabic.dictionaries, ["arabic", "jitendex"]);
  assert.deepEqual(arabic.languageOptions, []);
  assert.equal(japanese.language, "ja", "a request that names no profile means Japanese, whatever it carried");
  assert.deepEqual(japanese.dictionaries, ["custom"]);
  const refused = await lookup({ ...request, requestId: "r3", profileId: "en" });
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, "profile-missing");
  const noJapanese = profileRecords();
  noJapanese.options.profiles = noJapanese.options.profiles.filter(profile => profile.id !== "ja");
  delete noJapanese.dictionaryState.profiles.ja;
  const older = backgroundWorker(noJapanese);
  await settle();
  await older.lookup(request);
  assert.deepEqual(older.relayed[0].dictionaries, [], "without a Japanese profile an older client's lookup finds nothing");
});

test("a single-profile worker writes nothing of the profile layer", async () => {
  const records = singleProfileRecords();
  const { worker, stored, storage, lookup } = backgroundWorker(records);
  await settle();
  await lookup({ type: "hd_lookup", requestId: "r", text: "猫", options: {} });
  await worker({ type: "hd_lookup_stats_record", term: "猫", reading: "ねこ" });
  await settle();
  assert.deepEqual(stored("options"), records.options);
  assert.deepEqual(stored("dictionaryState"), records.dictionaryState);
  assert.equal(storage.raw.has("languageSelection"), false);
  assert.deepEqual(Object.keys(stored("lookupStats")), ["generation", "revision"]);
});
