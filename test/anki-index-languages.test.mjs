// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Anki duplicate index per language profile (docs/languages.md 4.3, 12):
// one snapshot per source key of the profiles' first Templates, each pulled
// and retried on its own and evicted when no profile uses it, today's record
// while there is one source, invalidation compared profile by profile, one
// row revision across snapshots, and the note-type families a language lists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../extension/reader-options.js";
import { ankiIndexConfigurationChange, ankiIndexSources, createAnkiDuplicateIndex } from "../extension/anki-index-cache.js";
import { ankiIndexSource, fetchAnkiIndex } from "../extension/anki-index.js";
import { ankiLanguageFamilies } from "../extension/anki-setup.js";
import { ankiInvokeFake } from "./anki-connect-fake.mjs";

const LANGUAGES = JSON.parse(readFileSync(new URL("./data/profile-languages.json", import.meta.url), "utf8"));
globalThis.HDLanguages = { get: code => LANGUAGES[code] ?? null, codes: ["ja", "en", "ar"] };
const layer = globalThis.HDReaderOptions;
const copy = value => structuredClone(value);
const turn = () => new Promise(resolve => setImmediate(resolve));

const template = (id, model, patch = {}) => ({ id, name: id, deck: "Default", model, tags: [],
  fields: { expression: "Expression", reading: "", definition: "", sentence: "", frequency: "", pitch: "", audio: "",
    screenshot: "" }, duplicateScope: "model", duplicateBehavior: "prevent", captureScreenshot: false, fieldTemplates: null,
  ...patch });
const profile = (id, language, first) => ({ id, language, settings: { anki: { templates: [first] } }, packSettings: {} });
function records(english = template("words", "English")) {
  return { revision: 4, anki: { url: "http://127.0.0.1:8765", apiKey: "" },
    profiles: [profile("ja", "ja", template("mining", "Japanese")), profile("en", "en", english)] };
}
// A profile's first Template as mining and the index key it.
function firstTemplate(options, profileId) {
  const { anki } = layer.projectOptions(options, profileId);
  const families = ankiLanguageFamilies(layer.profileDescriptor(options, profileId).language);
  return families === null ? anki : { ...anki, noteTypeFamilies: families };
}

const ROWS = { Japanese: [["猫", true, [7]]], English: [["run", false, [21]]], "English 2": [["walk", true, [31]]] };

function fixture(options) {
  let state, clock = 1_800_000, storageTail = Promise.resolve();
  const held = new Map(), failing = new Set(), refreshes = [], alarms = new Map();
  const dependencies = {
    async fetchRows(source) {
      refreshes.push(source.model);
      if (held.has(source.model)) await held.get(source.model).promise;
      if (failing.has(source.model)) throw new Error("Anki closed");
      return copy(ROWS[source.model] ?? []);
    },
    lookupLive: async () => { throw new Error("no live lookups here"); },
    lookupLiveMany: async () => { throw new Error("no live lookups here"); },
    readOptions: async () => copy(options),
    readState: async () => copy(state),
    updateState(update) {
      const run = storageTail.then(async () => {
        const next = await update({ options: copy(options), state: copy(state) });
        if (next !== undefined) state = copy(next);
        return copy(state);
      });
      storageTail = run.catch(() => {});
      return run;
    },
    alarms: {
      get: async name => copy(alarms.get(name)),
      clear: async name => alarms.delete(name),
      create: async (name, value) => alarms.set(name, { name, scheduledTime: value.when }),
    },
    now: () => clock,
    reportError() {},
  };
  return {
    service: createAnkiDuplicateIndex(dependencies),
    refreshes,
    get state() { return copy(state); },
    get options() { return copy(options); },
    hold(model) {
      let resolve;
      held.set(model, { promise: new Promise(done => { resolve = done; }) });
      return () => { held.delete(model); resolve(); };
    },
    fail(model) { failing.add(model); },
    due() { clock += 30 * 60 * 1000; },
    // An options write, which invalidates the index in the same storage turn.
    async write(next) {
      const commit = storageTail.then(async () => {
        const changed = await ankiIndexConfigurationChange(options, next, copy(state));
        options = copy(next);
        if (changed !== undefined) state = copy(changed);
      });
      storageTail = commit.catch(() => {});
      await commit;
    },
    async settled(predicate) {
      const deadline = Date.now() + 5000;
      while (!predicate() && Date.now() < deadline) await turn();
      assert.ok(predicate(), "the index settled");
    },
  };
}

test("two profiles' first Templates keep one snapshot each, answered for the profile each request names", async () => {
  const f = fixture(records());
  await f.service.reconcile();
  await f.settled(() => f.state?.snapshots?.length === 2);
  assert.deepEqual(f.refreshes, ["Japanese", "English"], "one pull per source, one after the other");
  const { state } = f;
  assert.equal(Object.hasOwn(state, "snapshot"), false);
  assert.equal(Object.hasOwn(state, "attempt"), false);
  const keys = [...(await ankiIndexSources(f.options)).keys()];
  assert.deepEqual(state.snapshots.map(snapshot => snapshot.sourceKey), keys, "in profile order");
  assert.deepEqual(state.attempts.map(attempt => attempt.sourceKey), keys);
  assert.deepEqual(state.snapshots.map(snapshot => snapshot.rows), [ROWS.Japanese, ROWS.English]);
  const japanese = firstTemplate(f.options, "ja"), english = firstTemplate(f.options, "en");
  assert.deepEqual(await f.service.statuses(japanese, ["猫", "run"]), { revision: 2, statuses: ["known", "unknown"] });
  assert.deepEqual(await f.service.statuses(english, ["猫", "run"]), { revision: 2, statuses: ["unknown", "learning"] });
  assert.equal(await f.service.has(japanese, "猫"), true);
  assert.equal(await f.service.has(english, "猫"), false);
  assert.deepEqual(await f.service.peek(english, "run"), { wordKey: "run", mature: false, noteIds: [21], cached: true });
});

test("a confirmed write in one profile moves the one row revision every snapshot shares", async () => {
  const f = fixture(records());
  await f.service.reconcile();
  await f.settled(() => f.state?.snapshots?.length === 2);
  const japanese = firstTemplate(f.options, "ja"), english = firstTemplate(f.options, "en");
  await f.service.recordWrite(english, "walk", 40);
  assert.equal(f.state.rowRevision, 3);
  assert.deepEqual(f.state.snapshots[1].rows, [["run", false, [21]], ["walk", false, [40]]]);
  assert.deepEqual(f.state.snapshots[0].rows, ROWS.Japanese, "the Japanese snapshot is untouched");
  assert.deepEqual(await f.service.statuses(japanese, ["猫"]), { revision: 3, statuses: ["known"] });
});

test("one profile's new source invalidates by profile: the other keeps its snapshot, schedule and running pull", async () => {
  const f = fixture(records());
  await f.service.reconcile();
  await f.settled(() => f.state?.snapshots?.length === 2);
  const before = f.state;
  f.due();
  const release = f.hold("Japanese");
  const refresh = f.service.reconcile();
  await f.settled(() => f.refreshes.length === 3);
  // English's first Template moves to another note type while Japanese's pull runs.
  await f.write(records(template("words", "English 2")));
  let state = f.state;
  assert.equal(state.configurationRevision, before.configurationRevision + 1);
  assert.deepEqual(state.snapshots.map(snapshot => snapshot.rows), [ROWS.Japanese], "English's old snapshot leaves");
  assert.deepEqual(state.attempts.map(attempt => attempt.sourceKey), [before.attempts[0].sourceKey],
    "Japanese keeps its reservation; the new source has none, so it is due now");
  release();
  await refresh;
  await f.settled(() => f.state?.snapshots?.length === 2 && f.state.snapshots[1].rows[0]?.[0] === "walk");
  state = f.state;
  assert.equal(state.snapshots[0].refreshedAt, 3_600_000, "the running Japanese pull still committed");
  assert.deepEqual(f.refreshes, ["Japanese", "English", "Japanese", "English 2"]);
});

test("each source backs off on its own after a failed pull", async () => {
  const f = fixture(records());
  f.fail("English");
  await f.service.reconcile();
  await f.settled(() => f.refreshes.length === 2 && f.state?.attempts?.every(attempt => attempt.finishedAt !== undefined));
  assert.deepEqual(f.state.snapshots.map(snapshot => snapshot.rows), [ROWS.Japanese], "the English pull stored nothing");
  // Neither source is due again before its 30 minutes, the failed one included.
  await f.service.reconcile();
  assert.equal(f.refreshes.length, 2);
});

test("back to one source, the record is today's single snapshot, and a profile without a source adds none", async () => {
  const f = fixture(records());
  await f.service.reconcile();
  await f.settled(() => f.state?.snapshots?.length === 2);
  const japanese = f.state.snapshots[0];
  // English's Template moves to the Japanese note type, checked by note type as Japanese's is.
  await f.write(records(template("words", "Japanese")));
  const state = f.state;
  assert.deepEqual(Object.keys(state), ["version", "configurationRevision", "rowRevision", "snapshot", "attempt"]);
  assert.deepEqual(state.snapshot, japanese, "the remaining source keeps its snapshot");
  assert.equal(state.attempt.sourceKey, japanese.sourceKey);
  assert.deepEqual(await f.service.statuses(firstTemplate(f.options, "en"), ["猫"]), { revision: 2, statuses: ["known"] });
  // A profile whose first Template names no note type adds no source either.
  assert.equal((await ankiIndexSources(records(template("words", "")))).size, 1);
});

test("with one source, a record with profiles changes exactly as the single-profile record does", async () => {
  const flat = layer.normaliseOptions({ revision: 4, anki: { url: "http://127.0.0.1:8765", apiKey: "",
    templates: [template("mining", "Japanese")] } });
  const withProfiles = records(template("words", ""));
  const run = async options => {
    const f = fixture(options);
    await f.service.reconcile();
    await f.settled(() => f.state?.snapshot?.rows?.length === 1);
    await f.service.recordWrite(firstTemplate(f.options, "ja"), "犬", 9);
    const anki = layer.projectOptions(options, "ja").anki;
    const scope = { ...anki, duplicateScope: "all",
      templates: anki.templates.map(value => ({ ...value, duplicateScope: "all" })) };
    await f.write(layer.hasProfiles(options) ? layer.applyOptionsPatch(options, { anki: scope }, "ja")
      : { ...options, anki: scope });
    return f.state;
  };
  assert.deepEqual(await run(withProfiles), await run(flat));
});

test("a language without note-type families keys its source with them and recognises no family note type beside its own", async () => {
  assert.equal(ankiLanguageFamilies("ja"), null, "Japanese lists every family, so its sources are today's");
  assert.equal(ankiLanguageFamilies(undefined), null);
  assert.deepEqual(ankiLanguageFamilies("en"), []);
  const config = layer.normaliseOptions({ anki: { model: "English", duplicateScope: "all",
    fields: { expression: "Expression" } } }).anki;
  const japanese = await ankiIndexSource(config);
  const english = await ankiIndexSource({ ...config, noteTypeFamilies: [] });
  assert.equal(Object.hasOwn(japanese, "families"), false);
  assert.deepEqual(english.families, []);
  assert.notEqual(english.key, japanese.key);
  const byModel = await ankiIndexSource({ ...config, duplicateScope: "model", noteTypeFamilies: [] });
  assert.equal(byModel.key, (await ankiIndexSource({ ...config, duplicateScope: "model" })).key,
    "a note-type scope recognises nothing else, so the families leave its key alone");
  const asked = [];
  const invoke = ankiInvokeFake(async (action, params) => {
    asked.push(action);
    if (action === "modelNamesAndIds") return { English: 1, "Kiku v2": 2 };
    if (action === "findNotes") {
      assert.doesNotMatch(params.query, /Kiku/u, "a Kiku note type is not an English duplicate");
      return [];
    }
    throw new Error(`unexpected ${action}`);
  });
  assert.deepEqual(await fetchAnkiIndex(invoke, english), []);
  assert.deepEqual(asked, ["modelNamesAndIds", "findNotes", "findNotes"]);
});
