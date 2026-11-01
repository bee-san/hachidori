// SPDX-License-Identifier: GPL-3.0-or-later
//
// Backups of records with profiles (docs/languages.md 17.1, 17.2, 17.6 and the
// backup cases of section 18): the Japanese view as a version 3 snapshot,
// version 4 archives and automatic snapshots, restores that leave out the
// languages a build has no pack for, the restore compare-and-set, and an
// export, preparation and restore through the real engine.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInContext } from "node:vm";

const ROOT = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, ROOT), "utf8");
const LANGUAGES = JSON.parse(read("test/data/profile-languages.json"));
const NAMES = { ja: "Japanese", en: "English", ar: "Arabic", vi: "Vietnamese" };
const sha256 = text => createHash("sha256").update(text).digest("hex");
// Values from the worker's realm, as plain values of this one.
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// A registry with the packs a build has; Vietnamese stands for a pack a newer
// build has and this one lacks.
function registry(codes) {
  const descriptor = code => {
    if (LANGUAGES[code]) return LANGUAGES[code];
    return { ...LANGUAGES.en, code, bcp47: code, name: NAMES[code], nativeName: NAMES[code],
      personalDictionary: { id: sha256(`hachidori-custom-dictionary:${code}`).slice(0, 32), title: `Hachidori Custom Dictionary (${NAMES[code]})` } };
  };
  return { version: 1, codes: [...codes], get: code => (codes.includes(code) ? descriptor(code) : null) };
}
const BUILD = registry(["ja", "en", "ar"]);
globalThis.HDLanguages = BUILD;

const backupState = await import("../extension/backup-state.js");
const { createBackupArchive, openBackupArchive } = await import("../extension/backup-archive.js");
const { CUSTOM_DICTIONARY_ID, CUSTOM_DICTIONARY_TITLE, customDictionarySemanticRevision } =
  await import("../extension/custom-dictionary.js");
const { lookupStatsKey } = await import("../extension/lookup-stats.js");
const profileState = await import("../extension/profile-state.js");
const japaneseViewModule = await import("../extension/japanese-view.js");
const {
  assertBackupProfiles, assertBackupSnapshot, assertRestoredProfileRecords, backupEngineDictionaries, prepareBackupProfiles,
  prepareBackupSnapshot, profileBackupPayload, restorePreviewNotes, restoredBackupSnapshot, restoredLanguageRows,
} = backupState;

// With a registry of `codes` for the length of `run`.
async function withBuild(codes, run) {
  const previous = globalThis.HDLanguages;
  globalThis.HDLanguages = codes === null ? undefined : registry(codes);
  try {
    return await run();
  } finally {
    globalThis.HDLanguages = previous;
  }
}

function identity(code) {
  if (code === "ja") return { id: CUSTOM_DICTIONARY_ID, title: CUSTOM_DICTIONARY_TITLE, language: "ja", readingRequired: true };
  const { id, title } = registry([code]).get(code).personalDictionary;
  return { id, title, language: code, readingRequired: false };
}

let generationCounter = 0;
function generationPath(title) {
  generationCounter += 1;
  return `/dicts/.hdw-generation-00000000-0000-4000-8000-${String(generationCounter).padStart(12, "0")}/${title}`;
}

function packageRow(id, title, language, extra = {}) {
  return { id, title, displayName: null, path: generationPath(title), favorite: false, revision: "1", isUpdatable: false,
    indexUrl: null, downloadUrl: null, language, frequencyMode: null, termCount: 3, frequencyCount: 0, pitchCount: 0,
    kanjiCount: 0, mediaCount: 0, installedAt: "2026-10-01T00:00:00.000Z", lastUpdateCheck: null, ...extra };
}

const ENTRIES = {
  ja: { text: "食べる, たべる, to eat\n", entries: [{ term: "食べる", reading: "たべる", definition: "to eat" }] },
  en: { text: "run, , to move fast\nwalk, , to move slowly\n",
    entries: [{ term: "run", reading: "", definition: "to move fast" }, { term: "walk", reading: "", definition: "to move slowly" }] },
  ar: { text: "كتاب, , book\n", entries: [{ term: "كتاب", reading: "", definition: "book" }] },
  vi: { text: "ăn, , to eat\n", entries: [{ term: "ăn", reading: "", definition: "to eat" }] },
};

const row = (term, lookupCount = 1) => ({ term, reading: "", lookupCount, firstLookedUpAt: 1, lastLookedUpAt: 2 });

/**
 * The six stored records (under the backup snapshot's names) and the lookup
 * rows of an installation. `languages` names, per language, whether it has a
 * profile, a dictionary, personal entries, counts and marks.
 */
async function installation(languages, { documentRevisions = {}, generations = {}, japaneseProfileSettings = { scanLength: 12 } } = {}) {
  const dictionaries = [], profiles = {}, optionProfiles = [], documents = {}, entriesOf = {};
  const descriptor = { generation: generations.ja ?? "ja-generation", revision: 40 };
  const marks = { revision: 9, known: [], ignored: [] };
  const rows = {};
  for (const [code, part] of Object.entries(languages)) {
    const list = [];
    if (part.personal) {
      const own = identity(code);
      const semanticRevision = await customDictionarySemanticRevision(ENTRIES[code].entries, own);
      dictionaries.push(packageRow(own.id, own.title, code, { revision: semanticRevision, termCount: ENTRIES[code].entries.length }));
      list.push({ id: own.id, enabled: true });
      const document = { revision: documentRevisions[code] ?? 2, semanticRevision, text: ENTRIES[code].text };
      if (code === "ja") Object.assign(documents, { ja: document });
      else documents[code] = document;
      entriesOf[code] = ENTRIES[code].entries.length;
    }
    if (part.dictionary) {
      const id = `${code}-dictionary`;
      dictionaries.push(packageRow(id, `${NAMES[code]} dictionary`, code));
      list.push({ id, enabled: true });
    }
    if (part.counts) {
      if (code !== "ja") descriptor.languages = { ...descriptor.languages, [code]: generations[code] ?? `${code}-generation` };
      rows[code] = part.counts.map(term => row(term));
    }
    if (part.marks) {
      if (code === "ja") marks.known.push(...part.marks);
      else marks.languages = { ...marks.languages, [code]: { known: part.marks, ignored: [] } };
    }
    if (part.profile) {
      profiles[code] = { dictionaries: list, groups: code === "ja" && part.dictionary ? [{ id: "g-ja", name: "Main", dictionaryIds: ["ja-dictionary"] }] : [] };
      optionProfiles.push({ id: code, language: code, settings: code === "ja" ? japaneseProfileSettings : { scanLength: 20 }, packSettings: {} });
    }
  }
  const japaneseDocument = documents.ja ?? { revision: documentRevisions.ja ?? 0, semanticRevision: await customDictionarySemanticRevision([]), text: "" };
  const languageDocuments = Object.fromEntries(Object.entries(documents).filter(([code]) => code !== "ja"));
  const records = {
    state: { schemaVersion: 2, revision: 31, dictionaries, profiles },
    options: { revision: 57, hoverEnabled: true, popupWidthPx: 640, profiles: optionProfiles },
    document: { schemaVersion: 1, ...japaneseDocument, ...(Object.keys(languageDocuments).length ? { languages: languageDocuments } : {}) },
    updates: { revision: 2, schedule: "off", lastCheckedAt: null },
    lookupStats: descriptor,
    wordStatusOverrides: marks,
  };
  // Stored rows by key, as chrome.storage.local holds them.
  const stored = {};
  for (const [code, list] of Object.entries(rows)) {
    const view = code === "ja" ? descriptor : { generation: descriptor.languages[code], revision: descriptor.revision };
    for (const entry of list) stored[lookupStatsKey(view, entry)] = entry;
  }
  return { records, stored, rows };
}

function rowsOf(stored) {
  return view => Object.entries(stored).filter(([key]) => key.startsWith(`lookupStats:${JSON.stringify(view.generation)}:`))
    .map(([, value]) => value);
}

// A backup made by a build with every pack these tests use, Vietnamese too.
async function payloadOf(languages, options) {
  return withBuild(["ja", "en", "ar", "vi"], async () => {
    const { records, stored } = await installation(languages, options);
    return { records, stored, payload: profileBackupPayload(records, rowsOf(stored)) };
  });
}

// The packages a restore loads, each at a fresh generation as staging gives them.
function freshDictionaries(plan) {
  const fresh = new Map(plan.dictionaryState.dictionaries.map(entry => [entry.id, { ...entry, path: generationPath(entry.title) }]));
  return backupEngineDictionaries(plan, fresh);
}

async function plannedRestore(current, payload) {
  const { snapshot } = await prepareBackupSnapshot(payload.snapshot);
  const plan = await prepareBackupProfiles(snapshot, payload.profiles);
  const dictionaries = freshDictionaries(plan);
  const records = restoredBackupSnapshot(current, snapshot, dictionaries, { plan });
  return { snapshot, plan, dictionaries, records, notes: restorePreviewNotes(current, plan) };
}

const JA_EN = {
  ja: { profile: true, dictionary: true, personal: true, counts: ["猫"], marks: ["犬"] },
  en: { profile: true, dictionary: true, personal: true, counts: ["run", "walk"], marks: ["cat"] },
};

const EMPTY_CURRENT = { state: null, options: null, document: null, updates: null, lookupStats: null, wordStatusOverrides: null };

test("a backup of records with profiles is a version 3 snapshot of their Japanese view beside the complete records", async () => {
  const { records, payload } = await payloadOf(JA_EN);
  const { snapshot, lookupStatsRows, profiles } = payload;
  assert.equal(snapshot.state.schemaVersion, 1);
  assert.deepEqual(snapshot.state.dictionaries.map(entry => [entry.id, entry.enabled]),
    [[CUSTOM_DICTIONARY_ID, true], ["ja-dictionary", true], ["en-dictionary", false]],
    "the Japanese personal package first, the Japanese list, every other package disabled, other personal packages left out");
  assert.deepEqual(snapshot.state.groups, records.state.profiles.ja.groups);
  assert.equal(snapshot.options.scanLength, 12, "the Japanese profile flattened with the global keys");
  assert.equal(snapshot.options.hoverEnabled, true);
  assert.equal(Object.hasOwn(snapshot.options, "profiles"), false);
  assert.equal(snapshot.options.revision, 57);
  assert.equal(Object.hasOwn(snapshot.document, "languages"), false);
  assert.equal(snapshot.document.text, ENTRIES.ja.text);
  assert.deepEqual(snapshot.lookupStats, { generation: "ja-generation", revision: 40 });
  assert.deepEqual(snapshot.wordStatusOverrides, { revision: 9, known: ["犬"], ignored: [] });
  assert.deepEqual(lookupStatsRows.map(entry => entry.term), ["猫"]);
  await assertBackupSnapshot(snapshot);
  await assertBackupProfiles(snapshot, profiles);
  assert.deepEqual(profiles.dictionaryState, records.state);
  assert.deepEqual(profiles.options.profiles.map(profile => profile.id), ["ja", "en"]);
  assert.deepEqual(Object.keys(profiles.languages), ["en"]);
  assert.deepEqual(profiles.languages.en.document, records.document.languages.en);
  assert.deepEqual(profiles.languages.en.wordStatusOverrides, { known: ["cat"], ignored: [] });
  assert.deepEqual(profiles.languages.en.lookupStatsRows.map(entry => entry.term), ["run", "walk"]);
  // A view whose package differs from the complete state is not a backup.
  const tampered = structuredClone(profiles);
  tampered.dictionaryState.dictionaries.find(entry => entry.id === "en-dictionary").title = "Renamed";
  await assert.rejects(assertBackupProfiles(snapshot, tampered), /invalid language profiles/u);
  // Another language's personal package must keep its document's semantics.
  const stale = structuredClone(profiles);
  stale.languages.en.document.text = "run, , changed\n";
  await assert.rejects(assertBackupProfiles(snapshot, stale), /invalid semantics/u);
});

test("a version 4 archive is version 3 for builds without profiles: the view's packages and nothing more", async () => {
  const { payload } = await payloadOf(JA_EN);
  const files = payload.snapshot.state.dictionaries.map((entry, index) => ({
    path: `dictionaries/${index}/index.json`, data: new Blob([JSON.stringify({ title: entry.title })]) }));
  const archive = await createBackupArchive(payload.snapshot, files, payload.lookupStatsRows, "2026-11-01T00:00:00.000Z",
    undefined, payload.profiles);
  const { BlobReader, TextWriter, ZipReader } = await import("../extension/vendor/zip.js");
  const reader = new ZipReader(new BlobReader(archive), { useWebWorkers: false });
  const entries = await reader.getEntries();
  const manifest = JSON.parse(await entries.find(entry => entry.filename === "hachidori-backup.json").getData(new TextWriter()));
  await reader.close();
  assert.equal(manifest.version, 4);
  assert.deepEqual(Object.keys(manifest), ["format", "version", "createdAt", "snapshot", "lookupStatsRows", "files", "profiles"]);
  assert.deepEqual(manifest.files.map(file => file.path), files.map(file => file.path),
    "the files are those of the packages the view lists; other languages' personal packages are rebuilt");
  // A Japanese-only build, or one without any registry, reads the snapshot
  // and restores it as one Japanese profile.
  for (const codes of [["ja"], null]) {
    await withBuild(codes, async () => {
      const opened = await openBackupArchive(archive);
      await assertBackupSnapshot(opened.snapshot, { allowInvalidSettings: true });
      const { snapshot } = await prepareBackupSnapshot(opened.snapshot);
      const restored = restoredBackupSnapshot(EMPTY_CURRENT, snapshot, snapshot.state.dictionaries);
      assert.equal(restored.state.schemaVersion, 1);
      assert.deepEqual(restored.state.dictionaries.map(entry => entry.id), [CUSTOM_DICTIONARY_ID, "ja-dictionary", "en-dictionary"]);
      assert.equal(Object.hasOwn(restored.options, "profiles"), false);
      assert.equal(Object.hasOwn(restored.document, "languages"), false);
    });
  }
  // The same records with the profiles field dropped, as an older reader skips it.
  const opened = await openBackupArchive(archive);
  assert.deepEqual(opened.profiles, payload.profiles);
  assert.deepEqual(opened.snapshot, payload.snapshot);
});

test("a single-profile archive keeps today's version 3 manifest", async () => {
  const semanticRevision = await customDictionarySemanticRevision([]);
  const snapshot = {
    state: { schemaVersion: 1, revision: 1, dictionaries: [], groups: [] },
    options: { revision: 1 }, document: { schemaVersion: 1, revision: 0, semanticRevision, text: "" },
    updates: { revision: 0, schedule: "off", lastCheckedAt: null }, lookupStats: { generation: null, revision: 0 },
    wordStatusOverrides: { revision: 0, known: [], ignored: [] },
  };
  const archive = await createBackupArchive(snapshot, [], [], "2026-11-01T00:00:00.000Z");
  const opened = await openBackupArchive(archive);
  assert.equal(Object.hasOwn(opened, "profiles"), false);
  const text = new TextDecoder().decode(new Uint8Array(await archive.arrayBuffer()));
  assert.ok(text.includes('{"format":"hachidori-backup","version":3,"createdAt":"2026-11-01T00:00:00.000Z","snapshot":'));
  assert.ok(!text.includes('"profiles"'));
});

test("a version 4 restore leaves out a language whose pack this build lacks and names it", async () => {
  const backup = await payloadOf({
    ...JA_EN,
    vi: { profile: true, dictionary: true, personal: true, counts: ["ăn"], marks: ["cơm"] },
  });
  const current = (await installation({ ja: { profile: true, dictionary: true } })).records;
  await withBuild(["ja", "en"], async () => {
    const { plan, records, notes } = await plannedRestore(current, backup.payload);
    assert.deepEqual(plan.missing, ["vi"]);
    assert.equal(plan.fallback, false);
    assert.deepEqual(records.options.profiles.map(profile => profile.id), ["ja", "en"]);
    assert.deepEqual(Object.keys(records.state.profiles), ["ja", "en"]);
    const ids = records.state.dictionaries.map(entry => entry.id);
    assert.ok(ids.includes("vi-dictionary"), "the language's other packages stay in the library");
    assert.ok(!Object.values(records.state.profiles).some(profile => profile.dictionaries.some(entry => entry.id === "vi-dictionary")),
      "in no profile");
    assert.ok(!ids.includes(identity("vi").id), "its personal package is left out");
    assert.deepEqual(Object.keys(records.document.languages), ["en"]);
    assert.deepEqual(Object.keys(records.lookupStats.languages), ["en"]);
    assert.deepEqual(Object.keys(records.wordStatusOverrides.languages), ["en"]);
    assert.ok(notes.includes("Vietnamese needs a newer Hachidori and is not restored."), JSON.stringify(notes));
    assert.ok(notes.includes("Restores Japanese and English."), JSON.stringify(notes));
    await assertRestoredProfileRecords(current, records, backup.payload.lookupStatsRows, restoredLanguageRows(plan, records));
  });
});

test("a Vietnamese personal dictionary without a Vietnamese profile, restored without its pack, gives the single-profile shape", async () => {
  const backup = await payloadOf({
    ja: { profile: true, dictionary: true, personal: true, counts: ["猫"] },
    vi: { personal: true, counts: ["ăn"], marks: ["cơm"] },
  });
  assert.equal(backup.payload.snapshot.state.dictionaries.some(entry => entry.id === identity("vi").id), false);
  await withBuild(["ja"], async () => {
    const { plan, records, notes } = await plannedRestore(EMPTY_CURRENT, backup.payload);
    assert.deepEqual(plan.missing, ["vi"]);
    assert.equal(records.state.schemaVersion, 1, "only Japanese is held, so the records keep today's shapes");
    assert.equal(Object.hasOwn(records.options, "profiles"), false);
    assert.equal(Object.hasOwn(records.document, "languages"), false);
    assert.equal(Object.hasOwn(records.lookupStats, "languages"), false);
    assert.equal(Object.hasOwn(records.wordStatusOverrides, "languages"), false);
    assert.deepEqual(records.state.dictionaries.map(entry => entry.id), [CUSTOM_DICTIONARY_ID, "ja-dictionary"]);
    assert.ok(notes.includes("Vietnamese needs a newer Hachidori and is not restored."), JSON.stringify(notes));
    await assertBackupSnapshot(records);
  });
});

test("one Japanese profile with English data keeps the English data on a build with English", async () => {
  const backup = await payloadOf({
    ja: { profile: true, dictionary: true, personal: true },
    en: { personal: true, counts: ["run"], marks: ["cat"] },
  });
  const { plan, records } = await plannedRestore(EMPTY_CURRENT, backup.payload);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.personal.map(entry => entry.language), ["en"], "its personal package is rebuilt from its document");
  assert.deepEqual(records.options.profiles.map(profile => profile.id), ["ja"]);
  assert.equal(records.state.schemaVersion, 2, "English is still held, so the records keep profiles");
  assert.ok(records.state.dictionaries.some(entry => entry.id === identity("en").id));
  assert.ok(!records.state.profiles.ja.dictionaries.some(entry => entry.id === identity("en").id), "in no profile");
  assert.equal(records.document.languages.en.text, ENTRIES.en.text);
  assert.equal(typeof records.lookupStats.languages.en, "string");
  assert.deepEqual(records.wordStatusOverrides.languages.en, { known: ["cat"], ignored: [] });
  assert.deepEqual(restoredLanguageRows(plan, records), { en: [row("run")] });
});

test("restoring an installation's own snapshot replaces its English counts under a fresh generation", async () => {
  const own = await payloadOf(JA_EN);
  const current = own.records;
  const { plan, records } = await plannedRestore(current, own.payload);
  const languageRows = restoredLanguageRows(plan, records);
  assert.notEqual(records.lookupStats.generation, current.lookupStats.generation);
  assert.notEqual(records.lookupStats.languages.en, current.lookupStats.languages.en);
  assert.deepEqual(languageRows.en.map(entry => entry.term), ["run", "walk"]);
  await assertRestoredProfileRecords(current, records, own.payload.lookupStatsRows, languageRows);
  const reused = structuredClone(records);
  reused.lookupStats.languages.en = current.lookupStats.languages.en;
  await assert.rejects(assertRestoredProfileRecords(current, reused, own.payload.lookupStatsRows, languageRows),
    /fresh lookup statistics namespace/u);
  const stray = { ...languageRows, ar: [row("كتاب")] };
  await assert.rejects(assertRestoredProfileRecords(current, records, own.payload.lookupStatsRows, stray), /lookup statistics/u);
});

test("a restore writes every language's personal document one revision above the current one", async () => {
  const current = (await installation({
    ja: { profile: true, personal: true },
    en: { profile: true, personal: true },
    ar: { profile: true, personal: true },
  }, { documentRevisions: { ja: 7, en: 5, ar: 3 } })).records;
  const backup = await payloadOf({
    ja: { profile: true, personal: true },
    en: { profile: true, personal: true },
    ar: { profile: true },
  }, { documentRevisions: { ja: 2, en: 9 } });
  const { plan, records } = await plannedRestore(current, backup.payload);
  assert.equal(records.document.revision, 8);
  assert.equal(records.document.languages.en.revision, 6);
  assert.equal(records.document.languages.en.text, ENTRIES.en.text);
  assert.deepEqual(records.document.languages.ar, { revision: 4,
    semanticRevision: await customDictionarySemanticRevision([]), text: "" },
  "a language that keeps a profile but loses its document gets an emptied one above the current revision");
  await assertRestoredProfileRecords(current, records, backup.payload.lookupStatsRows, restoredLanguageRows(plan, records));
  const behind = structuredClone(records);
  behind.document.languages.en.revision = 5;
  await assert.rejects(assertRestoredProfileRecords(current, behind, backup.payload.lookupStatsRows, restoredLanguageRows(plan, behind)),
    /restore revisions/u);
  const dropped = structuredClone(records);
  delete dropped.document.languages.ar;
  await assert.rejects(assertRestoredProfileRecords(current, dropped, backup.payload.lookupStatsRows, restoredLanguageRows(plan, dropped)),
    /restore revisions/u);
});

test("a restore that leaves no profile builds the Japanese profile from the backup's Japanese view", async () => {
  const backup = await payloadOf({
    vi: { profile: true, dictionary: true, personal: true, counts: ["ăn"] },
    en: { personal: true },
  });
  assert.deepEqual(backup.payload.snapshot.state.dictionaries.map(entry => [entry.id, entry.enabled]), [["vi-dictionary", false]]);
  assert.equal(backup.payload.snapshot.options.popupWidthPx, 640, "the view's options are the global keys over Japanese defaults");
  await withBuild(["ja", "en"], async () => {
    const { plan, records, notes } = await plannedRestore(EMPTY_CURRENT, backup.payload);
    assert.equal(plan.fallback, true);
    assert.deepEqual(plan.missing, ["vi"]);
    assert.deepEqual(records.options.profiles.map(profile => profile.id), ["ja"]);
    assert.equal(records.options.popupWidthPx, 640);
    assert.deepEqual(records.state.profiles.ja.dictionaries, [{ id: "vi-dictionary", enabled: false }]);
    assert.equal(records.document.languages.en.text, ENTRIES.en.text, "the other held languages it has packs for are kept");
    assert.deepEqual(notes, [
      "Restores Japanese.",
      "Vietnamese needs a newer Hachidori and is not restored.",
      "The Japanese settings and dictionaries are restored in place of Vietnamese.",
    ]);
  });
  await withBuild(["ja"], async () => {
    const { records } = await plannedRestore(EMPTY_CURRENT, backup.payload);
    assert.equal(records.state.schemaVersion, 1, "without English nothing but Japanese is held");
  });
});

test("the preview names every language of this installation whose data a restore removes", async () => {
  const current = (await installation(JA_EN)).records;
  const versionThree = (await payloadOf({ ja: { profile: true, dictionary: true } })).payload;
  const { snapshot } = await prepareBackupSnapshot(versionThree.snapshot);
  assert.deepEqual(restorePreviewNotes(current, null),
    ["Restoring removes English and its settings, personal dictionary, lookup counts and marked words."]);
  const single = (await installation({ ja: { profile: true, dictionary: true } })).records;
  assert.deepEqual(restorePreviewNotes({ ...single, options: snapshot.options, state: snapshot.state }, null), [],
    "a version 3 restore over a single-profile installation names nothing");
  const both = (await installation({ ...JA_EN, ar: { profile: true } })).records;
  const onlyJapanese = (await payloadOf({ ja: { profile: true, dictionary: true }, ar: { personal: true } })).payload;
  const { notes } = await plannedRestore(both, onlyJapanese);
  assert.deepEqual(notes.slice(-1), ["Restoring removes English and its settings, personal dictionary, lookup counts and marked words."]);
});

// ---------------------------------------------------------------------------
// The service worker: the payload it reads, automatic snapshots and their
// roots, and the restore compare-and-set.
// ---------------------------------------------------------------------------

const { loadBackgroundScript, makeAlarms, makeBus, makeChrome, makeStorage } = await import("./extension-smoke/fakes.mjs");
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const moduleFunctions = module => Object.fromEntries(Object.entries(module).filter(([, value]) => typeof value === "function"));

// The worker of an installation on `storage`, with the modules its harness
// strips handed to it as globals.
function backgroundWorkerOn(bus, storage, alarms) {
  const sandbox = {
    chrome: makeChrome("sw", bus, storage, alarms), console: quiet, Promise, Error, TypeError, JSON, URL, Map, Set,
    String, Number, Boolean, Object, Array, RegExp, Math, Date,
    setTimeout: (...args) => setTimeout(...args).unref?.(), clearTimeout, fetch: globalThis.fetch,
    HDLanguages: BUILD,
    ...moduleFunctions(profileState), ...moduleFunctions(japaneseViewModule), ...moduleFunctions(backupState),
  };
  const context = loadBackgroundScript(sandbox);
  const page = makeChrome("page", bus, storage, alarms);
  const engine = makeChrome("offscreen", bus, storage, alarms);
  return {
    context, storage,
    stored: key => plain(storage.raw.get(key)),
    worker: async message => plain(await page.runtime.sendMessage({ target: "hoshidicts-worker", ...message })),
    fromEngine: async message => plain(await engine.runtime.sendMessage({ target: "hoshidicts-worker", ...message })),
  };
}

function backgroundWorker(records = {}) {
  const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
  for (const [key, value] of Object.entries(records)) storage.raw.set(key, structuredClone(value));
  // A stand-in engine acknowledges what the worker relays (automatic cleanup).
  bus.addListener("engine-host", (message, _sender, respond) => {
    if (message?.relayed !== true || message.target !== "hoshidicts-offscreen") return false;
    respond({ type: `${message.type}_result`, requestId: message.requestId ?? null, ok: true });
    return true;
  });
  return backgroundWorkerOn(bus, storage, alarms);
}

function storedRecords({ records, stored }) {
  return {
    dictionaryState: records.state, options: records.options, customDictionarySource: records.document,
    dictionaryUpdates: records.updates, lookupStats: records.lookupStats, wordStatusOverrides: records.wordStatusOverrides, ...stored,
  };
}

test("the worker's backup payload and automatic snapshots carry the profiles; their roots cover both parts", async () => {
  const fixture = await installation(JA_EN);
  const { context, worker, fromEngine, stored } = backgroundWorker(storedRecords(fixture));
  const read = await worker({ type: "hd_backup_read" });
  assert.equal(read.ok, true, read.error);
  assert.deepEqual(read.profiles, profileBackupPayload(fixture.records, rowsOf(fixture.stored)).profiles);
  assert.equal(read.snapshot.state.schemaVersion, 1);
  await runInContext("reconcileAutomaticBackups()", context);
  const store = stored("automaticBackups");
  assert.equal(store.backups.length, 1);
  assert.deepEqual(store.backups[0].profiles, read.profiles, "the automatic snapshot stores the same object");
  const listed = await worker({ type: "hd_backup_auto_list" });
  assert.equal(listed.corruptCount, 0, "a snapshot with profiles is never counted as corrupt");
  assert.equal(listed.backups[0].customEntryCount, ENTRIES.ja.entries.length + ENTRIES.en.entries.length);
  assert.equal(listed.backups[0].dictionaries.length, fixture.records.state.dictionaries.length);
  const roots = await fromEngine({ type: "hd_backup_auto_roots" });
  assert.equal(roots.complete, true);
  const paths = new Set(roots.dictionaries.map(entry => entry.path));
  for (const entry of fixture.records.state.dictionaries) assert.ok(paths.has(entry.path), entry.title);
});

test("the restore compare-and-set writes every language's records and rows and keeps the language choice", async () => {
  const fixture = await installation(JA_EN);
  const selection = { revision: 3, activeProfileId: "en", autoSwitch: false };
  const { worker, fromEngine, stored } = backgroundWorker({ ...storedRecords(fixture), languageSelection: selection });
  const base = (await worker({ type: "hd_backup_base_read" })).snapshot;
  const backup = await payloadOf(JA_EN, { generations: { ja: "old-ja", en: "old-en" } });
  const { plan, records } = await plannedRestore(base, backup.payload);
  const languageLookupStatsRows = restoredLanguageRows(plan, records);
  const reply = await fromEngine({ type: "hd_backup_cas", base, snapshot: records,
    lookupStatsRows: backup.payload.lookupStatsRows, languageLookupStatsRows });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(stored("options"), records.options);
  assert.deepEqual(stored("dictionaryState"), records.state);
  assert.deepEqual(stored("customDictionarySource"), records.document);
  assert.deepEqual(stored("lookupStats"), records.lookupStats);
  assert.deepEqual(stored("wordStatusOverrides"), records.wordStatusOverrides);
  for (const entry of languageLookupStatsRows.en) {
    assert.deepEqual(stored(lookupStatsKey({ generation: records.lookupStats.languages.en }, entry)), entry);
  }
  assert.deepEqual(stored(lookupStatsKey(records.lookupStats, backup.payload.lookupStatsRows[0])), backup.payload.lookupStatsRows[0]);
  assert.deepEqual(stored("languageSelection"), selection);
  // A second commit against the old base is a conflict, not a write.
  const again = await fromEngine({ type: "hd_backup_cas", base, snapshot: records,
    lookupStatsRows: backup.payload.lookupStatsRows, languageLookupStatsRows });
  assert.equal(again.ok, false);
  assert.equal(again.conflict, true);
});

test("a version 3 restore over records with profiles converts them back and removes the language choice", async () => {
  const fixture = await installation(JA_EN);
  const { worker, fromEngine, stored } = backgroundWorker({ ...storedRecords(fixture),
    languageSelection: { revision: 3, activeProfileId: "en", autoSwitch: false } });
  const base = (await worker({ type: "hd_backup_base_read" })).snapshot;
  const view = (await payloadOf({ ja: { profile: true, dictionary: true } })).payload.snapshot;
  const { snapshot } = await prepareBackupSnapshot(view);
  const dictionaries = snapshot.state.dictionaries.map(entry => ({ ...entry, path: generationPath(entry.title) }));
  const records = restoredBackupSnapshot(base, snapshot, dictionaries);
  const reply = await fromEngine({ type: "hd_backup_cas", base, snapshot: records, lookupStatsRows: [] });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(stored("dictionaryState").schemaVersion, 1);
  assert.equal(Object.hasOwn(stored("options"), "profiles"), false);
  assert.equal(stored("languageSelection"), undefined);
});

// ---------------------------------------------------------------------------
// Through the real engine (the WebAssembly bundle on an in-memory filesystem)
// and the worker: an installation with Japanese and English exports a version
// 4 archive, which a fresh installation restores, rebuilding the English
// personal package from its document; an automatic snapshot restores in place.
// ---------------------------------------------------------------------------

const { EXTENSION, createObjectURL, installFetch, installNavigator } = await import("./extension-smoke/fakes.mjs");
const { buildTitledZip } = await import("./make-fixture.mjs");

let engineCounter = 0;

// The fixture packs answer for vendor/languages, as the extension's copy would.
function servePacks() {
  const inner = globalThis.fetch;
  globalThis.fetch = async input => {
    const match = /\/vendor\/languages\/(en|ar)\/([\w.-]+)$/u.exec(String(input));
    if (match) return new Response(readFileSync(new URL(`test/data/languages/${match[1]}/${match[2]}`, ROOT), "utf8"));
    return inner(input);
  };
}

async function engineInstallation() {
  engineCounter += 1;
  const tag = `backup-profiles-${engineCounter}`;
  const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
  const worker = backgroundWorkerOn(bus, storage, alarms);
  const engineChrome = makeChrome("backup-profiles-offscreen", bus, storage, alarms);
  const pageChrome = makeChrome("backup-profiles-page", bus, storage, alarms);
  const engineService = await import(`file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}?${tag}`);
  // The engine's own registry holds Japanese alone; the tests' build has more.
  globalThis.HDLanguages = BUILD;
  const { default: createHoshidicts } = await import(`file://${resolve(EXTENSION, "vendor", "hoshidicts.mjs").replace(/\\/gu, "/")}?${tag}`);
  let engine = null;
  engineService.configureEngineService(message => engineChrome.runtime.sendMessage(message), {
    createHoshidicts: async (...args) => {
      engine = await createHoshidicts(...args);
      return engine;
    },
    storageBackend: "memory",
    lowRam: true,
  });
  engineService.startEngine();
  engineChrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "hoshidicts-offscreen" || message.relayed !== true) return false;
    engineService.handleEngineMessage(message).then(sendResponse);
    return true;
  });
  let counter = 0;
  const request = async (type, fields = {}) => plain(await engineService.handleEngineMessage({ type, requestId: `${tag}-${++counter}`, ...fields }));
  const accepted = async (type, fields) => {
    const reply = await request(type, fields);
    assert.equal(reply.ok, true, `${type}: ${JSON.stringify(reply)}`);
    return reply;
  };
  let status = await request("hd_status");
  for (let attempt = 0; attempt < 1200 && !(status.ok && status.ready && !status.loading); attempt += 1) {
    await new Promise(done => setTimeout(done, 25));
    status = await request("hd_status");
  }
  return {
    storage, request, accepted, ...worker,
    roots: () => engine.FS.readdir("/dicts").filter(name => name.startsWith(".hdw-generation-")).sort(),
    exists: path => engine.FS.analyzePath(path).exists,
    // A lookup as a page sends it, resolved by the worker for its profile.
    lookup: async fields => plain(await pageChrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", ...fields })),
  };
}

const englishTerms = [["run", "", "", "", 10, ["to move fast"], 1, ""], ["walk", "", "", "", 5, ["to move slowly"], 2, ""]];

async function englishInstallation() {
  const installation = await engineInstallation();
  const { accepted, worker } = installation;
  await accepted("hd_import", { fileName: "japanese.zip",
    blobUrl: createObjectURL(buildTitledZip("Japanese words", { indexOverrides: { sourceLanguage: "ja", targetLanguage: "en" } })) });
  await accepted("hd_custom_save", { baseDocumentRevision: 0, text: ENTRIES.ja.text });
  await accepted("hd_profile_add", { language: "en", copyFrom: "ja" });
  await accepted("hd_custom_save", { language: "en", baseDocumentRevision: 0, text: ENTRIES.en.text });
  await accepted("hd_import", { fileName: "english.zip", profileId: "en",
    blobUrl: createObjectURL(buildTitledZip("English words", { terms: englishTerms,
      indexOverrides: { sourceLanguage: "en", targetLanguage: "en" } })) });
  for (const [term, reading, profileId] of [["食べる", "たべる", "ja"], ["run", "", "en"], ["run", "", "en"]]) {
    const recorded = await worker({ type: "hd_lookup_stats_record", term, reading, profileId });
    assert.equal(recorded.ok, true, recorded.error);
  }
  const marked = await worker({ type: "hd_word_status_override", headword: "walk", status: "known", profileId: "en" });
  assert.equal(marked.ok, true, marked.error);
  return installation;
}

test("a version 4 export restores in a fresh installation, rebuilding the English personal package from its document", async () => {
  installFetch();
  installNavigator();
  servePacks();
  const source = await englishInstallation();
  const sourceRecords = (await source.worker({ type: "hd_backup_base_read" })).snapshot;
  const english = identity("en");
  assert.ok(sourceRecords.state.dictionaries.some(entry => entry.id === english.id), JSON.stringify(sourceRecords.state));
  const exported = await source.accepted("hd_backup_export");
  const archive = await openBackupArchive(await (await fetch(exported.blobUrl)).blob());
  assert.ok(archive.profiles, "records with profiles export a version 4 archive");
  assert.deepEqual(archive.snapshot.state.dictionaries.map(entry => entry.title),
    [CUSTOM_DICTIONARY_TITLE, "Japanese words", "English words"]);
  assert.equal(archive.files.some(file => file.path.startsWith("dictionaries/3/")), false,
    "the English personal package is not archived");
  // The Relay dictionary download reads the Japanese view.
  const englishWords = sourceRecords.state.dictionaries.find(entry => entry.title === "English words");
  const download = await source.accepted("hd_api_dictionary_open", { id: englishWords.id });
  await source.accepted("hd_api_dictionary_close", { token: download.token });
  const personalDownload = await source.request("hd_api_dictionary_open", { id: english.id });
  assert.equal(personalDownload.ok, false);
  assert.match(personalDownload.error, /unknown dictionary/u);

  const target = await engineInstallation();
  const prepared = await target.accepted("hd_backup_prepare", { blobUrl: exported.blobUrl, token: "restore-token" });
  assert.deepEqual(prepared.languageNotes, ["Restores Japanese and English."]);
  assert.equal(prepared.customEntryCount, ENTRIES.ja.entries.length + ENTRIES.en.entries.length);
  assert.ok(prepared.dictionaries.some(entry => entry.title === english.title));
  await target.accepted("hd_backup_restore", { token: "restore-token" });
  const restored = (await target.worker({ type: "hd_backup_base_read" })).snapshot;
  assert.deepEqual(restored.options.profiles.map(profile => profile.id), ["ja", "en"]);
  assert.deepEqual(Object.keys(restored.state.profiles), ["ja", "en"]);
  const rebuilt = restored.state.dictionaries.find(entry => entry.id === english.id);
  const original = sourceRecords.state.dictionaries.find(entry => entry.id === english.id);
  assert.equal(rebuilt.revision, original.revision);
  assert.equal(rebuilt.termCount, ENTRIES.en.entries.length);
  assert.notEqual(rebuilt.path, original.path);
  assert.ok(target.exists(rebuilt.path), "the rebuilt package is a committed generation");
  assert.deepEqual(restored.state.profiles.en.dictionaries[0], { id: english.id, enabled: true });
  assert.equal(restored.document.languages.en.text, ENTRIES.en.text);
  assert.equal(restored.document.languages.en.revision, 1);
  assert.deepEqual(restored.wordStatusOverrides.languages.en, { known: ["walk"], ignored: [] });
  const englishCount = await target.worker({ type: "hd_lookup_stats_read", term: "run", reading: "", profileId: "en" });
  assert.equal(englishCount.statistics.lookupCount, 2);
  const japaneseCount = await target.worker({ type: "hd_lookup_stats_read", term: "食べる", reading: "たべる", profileId: "ja" });
  assert.equal(japaneseCount.statistics.lookupCount, 1);
  const found = await target.lookup({ text: "run", profileId: "en" });
  assert.equal(found.ok, true, found.error);
  assert.ok(found.results.length > 0, "the restored English profile looks up with its pack loaded before the restore published");
  const status = await target.request("hd_status");
  assert.deepEqual(status.failedLanguages, []);
});

test("an automatic snapshot with profiles keeps another language's personal package and restores it in place", async () => {
  installFetch();
  installNavigator();
  servePacks();
  const installation = await englishInstallation();
  const { accepted, context, worker, exists } = installation;
  // The snapshot taken before English existed is replaced by one with it.
  installation.storage.raw.set("automaticBackups", { schemaVersion: 1, backups: [] });
  await runInContext("reconcileAutomaticBackups()", context);
  const [record] = installation.stored("automaticBackups").backups;
  assert.ok(record.profiles, JSON.stringify(Object.keys(record)));
  const english = identity("en");
  const kept = record.profiles.dictionaryState.dictionaries.find(entry => entry.id === english.id);
  // A new English entry compiles a new generation; the snapshot's stays.
  const before = await worker({ type: "hd_custom_read", profileId: "en" });
  await accepted("hd_custom_save", { language: "en", baseDocumentRevision: before.document.revision, text: "swim, , to move in water\n" });
  await accepted("hd_backup_auto_cleanup");
  const replaced = (await worker({ type: "hd_backup_base_read" })).snapshot.state.dictionaries.find(entry => entry.id === english.id);
  assert.notEqual(replaced.path, kept.path);
  assert.ok(exists(kept.path), "the automatic snapshot's roots include other languages' personal packages");
  const prepared = await accepted("hd_backup_auto_prepare", { id: record.id, token: "automatic-token" });
  assert.deepEqual(prepared.languageNotes, ["Restores Japanese and English."]);
  await accepted("hd_backup_restore", { token: "automatic-token" });
  const restored = (await worker({ type: "hd_backup_base_read" })).snapshot;
  assert.equal(restored.state.dictionaries.find(entry => entry.id === english.id).path, kept.path);
  assert.equal(restored.document.languages.en.text, ENTRIES.en.text);
  assert.equal(restored.document.languages.en.revision, before.document.revision + 2);
});
