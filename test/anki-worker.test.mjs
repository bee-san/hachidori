// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";

function fixture(firstAudio = false) {
  const calls = [];
  let fields, generation = 3, changeDuringCheck = false, audioUnavailable = false;
  const options = globalThis.HDReaderOptions.normaliseOptions({ anki: { model: "Basic", deck: "Default",
    fieldTemplates: { Front: { value: firstAudio ? "{expression}{audio}" : "{expression}", overwriteMode: "overwrite" },
      Audio: { value: "{audio}", overwriteMode: "overwrite" } } } });
  const gateway = { discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Audio"],
    models: ["Basic"], decks: ["Default"], errors: [] }), async invoke(action, params) {
    calls.push(action);
    if (action === "canAddNotesWithErrorDetail") { if (changeDuringCheck) generation++; return [{ canAdd: true }]; }
    if (action === "addNote") { fields = params.note.fields; return 12; }
    if (action === "notesInfo") return [{ noteId: 12, fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
    if (action === "storeMediaFile") return params.filename;
    if (action === "updateNoteFields") { fields = { ...fields, ...params.note.fields }; return null; }
    throw new Error(`Unexpected ${action}`);
  } };
  const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
    readDictionaries: async () => [{ title: "A", path: "/dicts/generation/A", enabled: true }],
    engine: async message => { calls.push(message.type); return { generation, ready: true, loading: false }; },
    offscreen: async message => {
      calls.push(message.type);
      if (message.type === "hd_anki_audio") {
        if (audioUnavailable) throw new Error("The chosen pronunciation is unavailable");
        return { filename: "checked.wav", data: "YXVkaW8=" };
      }
      assert.deepEqual(message.dictionaryPaths, { A: "/dicts/generation/A" });
      return { fields: Object.fromEntries(Object.entries(message.templates).map(([field, template]) =>
        [field, template.value.replace("{expression}", "猫").replace("{audio}", message.audio)])), media: [] };
    },
  });
  const request = { term: { expression: "猫", reading: "ねこ", rules: "", glossaries: [], frequencies: [], pitches: [] },
    generation: 3, trace: [], sentence: "猫", matched: "猫", matchOffset: 0, popupSelectionText: "", searchQuery: "猫", documentTitle: "Test",
    dictionaryAliases: {}, frequencyDictionaries: [] };
  return { service, calls, request, changedGeneration() { generation++; }, duringCheck() { changeDuringCheck = true; },
    failAudio() { audioUnavailable = true; }, get fields() { return fields; } };
}

test("the worker defers ordinary audio until verified note success and rejects stale dictionary generations", async () => {
  const f = fixture();
  f.request.configKey = (await f.service.status()).configKey;
  await f.service.preflight(f.request);
  assert.equal(f.calls.includes("hd_anki_audio"), false);
  assert.equal((await f.service.submit(f.request)).state, "added");
  assert.ok(f.calls.indexOf("hd_anki_audio") > f.calls.indexOf("notesInfo"));
  assert.equal(f.fields.Audio, "[sound:checked.wav]");
  f.changedGeneration();
  await assert.rejects(f.service.submit(f.request), /dictionary generation changed/u);
  assert.equal(f.calls.filter(action => action === "addNote").length, 1);
});

test("first-field audio is resolved before duplicate checking and its exact prepared bytes are reused after add", async () => {
  const f = fixture(true);
  f.request.configKey = (await f.service.status()).configKey;
  assert.equal((await f.service.submit(f.request)).state, "added");
  assert.equal(f.calls.filter(action => action === "hd_anki_audio").length, 1);
  assert.ok(f.calls.indexOf("hd_anki_audio") < f.calls.indexOf("canAddNotesWithErrorDetail"));
  assert.equal(f.fields.Front, "猫[sound:checked.wav]");
  assert.equal(f.fields.Audio, "[sound:checked.wav]");
});

test("a dictionary update during authoritative Anki checking cannot reach the note write", async () => {
  const f = fixture();
  f.request.configKey = (await f.service.status()).configKey;
  f.duringCheck();
  await assert.rejects(f.service.submit(f.request), /dictionary generation changed/u);
  assert.equal(f.calls.includes("addNote"), false);
});

test("unavailable first-field audio cannot silently change duplicate identity to text-only", async () => {
  const f = fixture(true);
  f.request.configKey = (await f.service.status()).configKey;
  f.failAudio();
  await assert.rejects(f.service.preflight(f.request), /chosen pronunciation is unavailable/u);
  await assert.rejects(f.service.submit(f.request), /chosen pronunciation is unavailable/u);
  assert.equal(f.calls.includes("canAddNotesWithErrorDetail"), false);
  assert.equal(f.calls.includes("addNote"), false);
});
