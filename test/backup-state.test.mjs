import assert from "node:assert/strict";
import test from "node:test";
import { assertBackupSnapshot, backupRevisions, restoredBackupSnapshot } from "../extension/backup-state.js";
import { CUSTOM_DICTIONARY_ID, CUSTOM_DICTIONARY_TITLE, customDictionarySemanticRevision,
  emptyCustomDictionaryDocument, parseCustomDictionary } from "../extension/custom-dictionary.js";

const snapshot = () => ({
  state: { schemaVersion: 1, revision: 8, dictionaries: [], groups: [] },
  document: emptyCustomDictionaryDocument(),
  options: { revision: 21, popupTheme: "dark" },
  updates: { revision: 4, schedule: "daily", lastCheckedAt: null },
  lookupStats: { generation: "archived", revision: 7 },
});

test("complete restore advances each local revision and replaces absent/default settings", async () => {
  const current = snapshot();
  const archived = snapshot();
  archived.options = { revision: 0 };
  archived.updates = { revision: 0, schedule: "off", lastCheckedAt: null };
  archived.state.revision = 0;
  await assertBackupSnapshot(archived);
  const restored = restoredBackupSnapshot(current, archived, []);
  assert.deepEqual(backupRevisions(restored), { state: 9, options: 22, document: 1, updates: 5, lookupStats: 8 });
  assert.notEqual(restored.lookupStats.generation, archived.lookupStats.generation);
  assert.deepEqual(restored.options, { revision: 22 });
  assert.equal(restored.updates.schedule, "off");
  await assertBackupSnapshot(restored);
});

test("a pre-Template backup validates and restores through the canonical Template and Custom-button model", async () => {
  const archived = snapshot();
  const defaults = globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki;
  archived.options = {
    revision: 4,
    anki: {
      url: "http://127.0.0.1:8765",
      apiKey: "legacy-key",
      deck: "Legacy",
      model: "Basic",
      tags: ["legacy"],
      fields: { ...defaults.fields, expression: "Front", screenshot: "Picture" },
      duplicateScope: "deck",
      duplicateBehavior: "overwrite",
      captureScreenshot: true,
      fieldTemplates: {
        Front: { value: "{expression}", overwriteMode: "coalesce" },
        Picture: { value: "{screenshot}", overwriteMode: "overwrite" },
      },
    },
    customLinks: [
      { label: "First", url: "https://one.example/%w" },
      { label: "Second", url: "https://two.example/%s" },
    ],
  };
  await assertBackupSnapshot(archived);
  const restored = restoredBackupSnapshot(snapshot(), archived, []);
  assert.deepEqual(restored.options.anki.templates, [{
    id: "default",
    name: "Default",
    ...Object.fromEntries(globalThis.HDReaderOptions.ANKI_TEMPLATE_CONFIG_KEYS
      .map(key => [key, archived.options.anki[key]])),
  }]);
  assert.deepEqual(restored.options.customButtons, [
    { id: "legacy-link-1", type: "link", label: "First", url: "https://one.example/%w" },
    { id: "legacy-link-2", type: "link", label: "Second", url: "https://two.example/%s" },
  ]);
  assert.deepEqual(restored.options.customLinks, archived.options.customLinks);
  await assertBackupSnapshot(restored);
});

test("restore validation rejects malformed state, settings and inconsistent custom source", async () => {
  const edits = [
    value => { value.state.schemaVersion = 2; },
    value => { delete value.state.revision; },
    value => { value.options = { revision: 0, popupWidthPx: -1 }; },
    value => { value.options.unknown = true; },
    value => { value.updates.schedule = "sometimes"; },
    value => { value.lookupStats.generation = ""; },
    value => { value.document.text = "猫,ねこ,cat"; },
    value => { value.state.groups = [{ id: "x", name: "All", dictionaryIds: [] }]; },
  ];
  for (const edit of edits) {
    const value = snapshot();
    edit(value);
    await assert.rejects(assertBackupSnapshot(value));
  }
  const inconsistent = snapshot();
  inconsistent.options = {
    revision: 1,
    customButtons: [{ id: "one", type: "link", label: "One", url: "https://one.example/%w" }],
    customLinks: [{ label: "Other", url: "https://other.example/%w" }],
  };
  await assert.rejects(assertBackupSnapshot(inconsistent));
});

test("backup enforces managed custom metadata without imposing extra limits on ordinary titles", async () => {
  const value = snapshot();
  value.document.text = "猫,ねこ,cat";
  value.document.semanticRevision = await customDictionarySemanticRevision(parseCustomDictionary(value.document.text).entries);
  const dictionary = { id: CUSTOM_DICTIONARY_ID, title: CUSTOM_DICTIONARY_TITLE, revision: value.document.semanticRevision,
    enabled: true, favorite: false, displayName: null, termCount: 1, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, mediaCount: 0,
    isUpdatable: false, indexUrl: null, downloadUrl: null, language: "ja" };
  value.state.dictionaries = [dictionary];
  await assertBackupSnapshot(value);
  for (const patch of [{ mediaCount: 1 }, { language: "en" }, { isUpdatable: true }]) {
    await assert.rejects(assertBackupSnapshot({ ...value, state: { ...value.state, dictionaries: [{ ...dictionary, ...patch }] } }));
  }
  value.document = emptyCustomDictionaryDocument();
  value.state.dictionaries = [{ ...dictionary, id: "ordinary", title: "Title\nwith a tab\t" }];
  await assertBackupSnapshot(value);
});
