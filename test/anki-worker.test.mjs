// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";
import { buildAnkiFields } from "../extension/anki-values.js";
import { AnkiTransportError } from "../extension/anki.js";

const AUDIO_FILENAME = `hachidori_${"c".repeat(64)}.wav`;
const SPEECH_FILENAME = `hachidori_${"a".repeat(64)}.wav`;
const IMAGE_FILENAME = `hachidori_${"d".repeat(64)}.png`;
const SVG_FILENAME = `hachidori_${"e".repeat(64)}.svg`;
const PNG_DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]).toString("base64");
const SVG_DATA = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>')
  .toString("base64");
const wav = Buffer.alloc(46);
wav.write("RIFF", 0, "ascii");
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8, "ascii");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36, "ascii");
wav.writeUInt32LE(2, 40);
const AUDIO_DATA = wav.toString("base64");
// A minimal GIF89a byte string; the worker checks the base64 "R0lG" prefix.
const GIF_DATA = Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;", "latin1").toString("base64");

function testIndex(resolve = async () => []) {
  const find = async (config, expression, invoke) => {
    const value = await resolve(config, expression, invoke);
    const result = Array.isArray(value) ? { noteIds: value } : value;
    return {
      wordKey: expression,
      mature: result?.mature === true,
      noteIds: [...new Set(result?.noteIds ?? [])].sort((left, right) => left - right),
      cached: false,
    };
  };
  return {
    source: async config => {
      const fields = config.fieldTemplates === null
        ? [config.fields.expression].filter(Boolean)
        : Object.entries(config.fieldTemplates).filter(([, template]) => /^\{expression\}$/iu.test(template.value))
          .map(([field]) => field);
      return fields.length ? { key: "test", model: config.model, fields: fields.map(field => field.toLowerCase()) } : null;
    },
    lookup: find,
    repair: find,
    async recordWrite() {},
    async has() { return false; },
  };
}

function fixture(firstAudio = false, overwrite = false, { audioSources } = {}) {
  const calls = [], audioRequests = [], renders = [];
  const mediaFiles = new Set();
  let fields = overwrite ? { Front: "猫", Audio: `pronunciation[sound:${AUDIO_FILENAME}]` } : undefined;
  let generation = 3, changeDuringCheck = false, audioUnavailable = false, deferSpeech = false, deferAllSpeech = false;
  const options = globalThis.HDReaderOptions.normaliseOptions({ ...(audioSources && { audioSources }), anki: { model: "Basic", deck: "Default",
    duplicateBehavior: overwrite ? "overwrite" : "prevent",
    fieldTemplates: { Front: { value: firstAudio ? "{expression}{audio}" : "{expression}", overwriteMode: "overwrite" },
      Audio: { value: overwrite ? "pronunciation{audio}" : "{audio}", overwriteMode: "overwrite" } } } });
  const gateway = { discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Audio"],
    models: ["Basic"], decks: ["Default"], errors: [] }), async invoke(action, params) {
    calls.push(action);
    if (action === "canAddNotesWithErrorDetail") {
      if (changeDuringCheck) generation++;
      return [{ canAdd: !overwrite, error: overwrite ? "cannot create note because it is a duplicate" : null }];
    }
    if (action === "modelNamesAndIds") return { Basic: 1 };
    if (action === "findNotes") return [12];
    if (action === "addNote") { fields = params.note.fields; return 12; }
    if (action === "notesInfo") return [{ noteId: 12, modelName: "Basic", fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
    if (action === "getMediaFilesNames") return mediaFiles.has(params.pattern) ? [params.pattern] : [];
    if (action === "storeMediaFile") { mediaFiles.add(params.filename); return params.filename; }
    if (action === "updateNoteFields") { fields = { ...fields, ...params.note.fields }; return null; }
    throw new Error(`Unexpected ${action}`);
  } };
  const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
    duplicateIndex: testIndex(() => overwrite ? [12] : []),
    readDictionaries: async () => [{ title: "A", path: "/dicts/generation/A", enabled: true }],
    engine: async message => { calls.push(message.type); return { generation, ready: true, loading: false }; },
    offscreen: async message => {
      calls.push(message.type);
      if (message.type === "hd_anki_audio") {
        audioRequests.push(message);
        const source = message.sources.find(candidate => candidate.type.startsWith("text-to-speech"));
        if (message.clientSpeechProbe) {
          return { recordingRequired: true, clientSpeech: {
            sourceId: source.id,
            sourceKey: JSON.stringify(source),
            expression: message.term.expression,
            reading: message.term.reading,
          } };
        }
        if (source?.id === "remote-tts") {
          if (message.recordSpeech === false) return { recordingRequired: true };
          return {
            filename: SPEECH_FILENAME,
            data: AUDIO_DATA,
            sourceId: source.id,
          };
        }
        if (audioUnavailable) throw new Error("The chosen pronunciation is unavailable");
        if (deferAllSpeech || (deferSpeech && message.recordSpeech === false)) return { recordingRequired: true };
        return { filename: AUDIO_FILENAME, data: AUDIO_DATA };
      }
      assert.deepEqual(message.dictionaryPaths, { A: "/dicts/generation/A" });
      renders.push(message);
      return { fields: Object.fromEntries(Object.entries(message.templates).map(([field, template]) =>
        [field, template.value.replace("{expression}", "猫").replace("{audio}", message.audio)])), media: [] };
    },
  });
  const request = { term: { expression: "猫", reading: "ねこ", rules: "", glossaries: [], frequencies: [], pitches: [] },
    generation: 3, trace: [], sentence: "猫", matched: "猫", matchOffset: 0, popupSelectionText: "", searchQuery: "猫", documentTitle: "Test",
    dictionaryAliases: {}, frequencyDictionaries: [] };
  return { service, calls, audioRequests, renders, options, request, changedGeneration() { generation++; },
    duringCheck() { changeDuringCheck = true; }, deferSpeech() { deferSpeech = true; },
    deferAllSpeech() { deferAllSpeech = true; },
    failAudio() { audioUnavailable = true; }, get fields() { return fields; } };
}

test("the worker defers ordinary audio until verified note success and rejects stale dictionary generations", async () => {
  const f = fixture();
  f.request.configKey = (await f.service.status()).configKey;
  await f.service.preflight(f.request);
  assert.equal(f.calls.includes("hd_anki_audio"), false);
  assert.equal((await f.service.submit(f.request)).state, "added");
  assert.ok(f.calls.indexOf("hd_anki_audio") > f.calls.indexOf("notesInfo"));
  assert.ok(f.calls.indexOf("storeMediaFile") > f.calls.indexOf("addNote"),
    "non-first-field pronunciation remains deferred until the note is confirmed");
  assert.ok(f.calls.indexOf("storeMediaFile") < f.calls.indexOf("updateNoteFields"),
    "deferred pronunciation is stored before its field update");
  assert.equal(f.fields.Audio, `[sound:${AUDIO_FILENAME}]`);
  f.changedGeneration();
  await assert.rejects(f.service.submit(f.request), /dictionary generation changed/u);
  assert.equal(f.calls.filter(action => action === "addNote").length, 1);
});

test("Smaller Anki cards is part of the checked configuration and reaches every render of the note", async () => {
  const f = fixture();
  f.request.configKey = (await f.service.status()).configKey;
  await f.service.preflight(f.request);
  f.options.experimental = { ...f.options.experimental, smallerAnkiCards: true };
  await assert.rejects(f.service.submit(f.request), /configuration changed/u,
    "a toggle between preflight and Add cannot write a note that mixes both modes");
  assert.equal(f.calls.includes("addNote"), false);
  assert.ok(f.renders.length > 0 && f.renders.every(message => message.compactGlossary === false));
  const before = f.renders.length;
  f.request.configKey = (await f.service.status()).configKey;
  assert.equal((await f.service.submit(f.request)).state, "added");
  const compact = f.renders.slice(before);
  assert.equal(compact.length, 2, "the note and its deferred pronunciation update both render");
  assert.ok(compact.every(message => message.compactGlossary === true));
});

test("first-field audio is resolved before duplicate checking and its exact prepared bytes are reused after add", async () => {
  const f = fixture(true);
  f.request.configKey = (await f.service.status()).configKey;
  assert.equal((await f.service.submit(f.request)).state, "added");
  assert.equal(f.calls.filter(action => action === "hd_anki_audio").length, 1);
  assert.ok(f.calls.indexOf("hd_anki_audio") < f.calls.indexOf("canAddNotesWithErrorDetail"));
  assert.ok(f.calls.indexOf("getMediaFilesNames") < f.calls.indexOf("storeMediaFile"));
  assert.ok(f.calls.indexOf("storeMediaFile") < f.calls.indexOf("addNote"),
    "first-field pronunciation is confirmed before the note mutation");
  assert.equal(f.calls.filter(action => action === "storeMediaFile").length, 1);
  assert.equal(f.fields.Front, `猫[sound:${AUDIO_FILENAME}]`);
  assert.equal(f.fields.Audio, `[sound:${AUDIO_FILENAME}]`);
});

test("first-field browser speech stays silent during preflight and records once on authoritative submit", async () => {
  const f = fixture(true);
  f.deferSpeech();
  f.request.configKey = (await f.service.status()).configKey;
  const preflight = await f.service.preflight(f.request);
  assert.equal(preflight.deferred, true);
  assert.equal(preflight.canAdd, true);
  assert.equal(f.calls.includes("canAddNotesWithErrorDetail"), false);
  assert.equal(f.audioRequests[0].recordSpeech, false);
  const result = await f.service.submit(f.request);
  assert.equal(result.state, "added");
  assert.deepEqual(f.audioRequests.map(request => request.recordSpeech), [false, true]);
  assert.equal(f.calls.filter(action => action === "canAddNotesWithErrorDetail").length, 1);
  assert.equal(f.fields.Front, `猫[sound:${AUDIO_FILENAME}]`);
});

test("authoritative first-field speech cannot write the silent preflight placeholder", async () => {
  const f = fixture(true);
  f.deferAllSpeech();
  f.request.configKey = (await f.service.status()).configKey;
  assert.equal((await f.service.preflight(f.request)).deferred, true);
  await assert.rejects(f.service.submit(f.request), /was not recorded/u);
  assert.equal(f.calls.includes("addNote"), false);
});

test("linked browser speech is planned by the host, recorded by the reading browser, and reused for the host write", async () => {
  const source = { id: "remote-tts", enabled: true, type: "text-to-speech-reading", url: "", voice: "" };
  const f = fixture(true, false, { audioSources: [source] });
  f.request.configKey = (await f.service.status()).configKey;
  const preflight = await f.service.preflightClient(f.request);
  assert.equal(preflight.deferred, true);
  assert.deepEqual({
    ...preflight.clientSpeech,
    sourceKey: undefined,
  }, {
    sourceId: source.id,
    sourceKey: undefined,
    expression: "猫",
    reading: "ねこ",
  });
  assert.deepEqual(JSON.parse(preflight.clientSpeech.sourceKey), source);
  f.request.clientSpeech = preflight.clientSpeech;
  await f.service.preflightClientSpeech(f.request);
  const media = await f.service.clientMedia(f.request);
  assert.deepEqual(media, {
    speech: {
      ...preflight.clientSpeech,
      filename: `hachidori_${"a".repeat(64)}.wav`,
      byteLength: wav.length,
      data: AUDIO_DATA,
    },
  });
  const result = await f.service.submitClient(f.request, media);
  assert.equal(result.state, "added");
  assert.equal(f.fields.Front, `猫[sound:hachidori_${"a".repeat(64)}.wav]`);
  assert.deepEqual(f.audioRequests.map(request => ({
    probe: request.clientSpeechProbe === true,
    supplied: request.clientSpeech !== undefined,
    record: request.recordSpeech,
  })), [
    { probe: true, supplied: false, record: false },
    { probe: false, supplied: false, record: false },
    { probe: false, supplied: false, record: true },
    { probe: false, supplied: true, record: true },
  ]);
});

test("linked browser speech is also planned for deferred pronunciation enrichment", async () => {
  const source = { id: "remote-tts", enabled: true, type: "text-to-speech-reading", url: "", voice: "" };
  const f = fixture(false, false, { audioSources: [source] });
  f.request.configKey = (await f.service.status()).configKey;
  const preflight = await f.service.preflightClient(f.request);
  assert.equal(preflight.deferred, undefined);
  assert.equal(preflight.clientSpeech.sourceId, source.id);
  f.request.clientSpeech = preflight.clientSpeech;
  await f.service.preflightClientSpeech(f.request);
  const media = await f.service.clientMedia(f.request);
  const result = await f.service.submitClient(f.request, media);
  assert.equal(result.state, "added");
  assert.equal(f.fields.Audio, `[sound:hachidori_${"a".repeat(64)}.wav]`);
  assert.deepEqual(f.audioRequests.map(request => ({
    probe: request.clientSpeechProbe === true,
    supplied: request.clientSpeech !== undefined,
  })), [
    { probe: true, supplied: false },
    { probe: false, supplied: false },
    { probe: false, supplied: false },
    { probe: false, supplied: true },
  ]);
});

test("mixed text/audio overwrite restores pronunciation when its final value matches the original note", async () => {
  const f = fixture(false, true);
  f.request.configKey = (await f.service.status()).configKey;
  const result = await f.service.submit(f.request);
  assert.equal(result.state, "updated");
  assert.deepEqual(result.warnings, []);
  assert.equal(f.fields.Audio, `pronunciation[sound:${AUDIO_FILENAME}]`);
  assert.equal(f.calls.filter(action => action === "updateNoteFields").length, 2,
    "the text-only write is followed by restoring the selected pronunciation");
  assert.equal(f.calls.includes("addNote"), false);
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

// An overlay host keeps only downloadable sources, which can leave none.
test("with no enabled audio source first-field audio is left out instead of blocking the note", async () => {
  const f = fixture(true, false, { audioSources: [] });
  f.request.configKey = (await f.service.status()).configKey;
  const result = await f.service.submit(f.request);
  assert.equal(result.state, "added");
  assert.deepEqual(result.warnings, []);
  assert.equal(f.calls.includes("hd_anki_audio"), false);
  assert.equal(f.fields.Front, "猫");
  assert.equal(f.fields.Audio, "");
});

function dictionaryMediaFixture({
  items = [
    { dictionary: "Fixture", path: "media/picture.png", filename: IMAGE_FILENAME },
    { dictionary: "Fixture", path: "media/nested/diagram.svg", filename: SVG_FILENAME },
  ],
  existing = [],
  overwrite = false,
} = {}) {
  const calls = [];
  const files = new Set(existing);
  let fields = overwrite ? { Front: "媒体証明", Back: "existing definition" } : undefined;
  let generation = 3;
  let failStore = null;
  let acknowledgeWithoutStore = false;
  let rejectAfterStore = false;
  let duplicateRace = false;
  const options = globalThis.HDReaderOptions.normaliseOptions({ audioSources: [], anki: {
    model: "Basic",
    deck: "Default",
    duplicateBehavior: overwrite ? "overwrite" : "prevent",
    fieldTemplates: {
      Front: { value: "{expression}", overwriteMode: "overwrite" },
      Back: { value: "{definition}", overwriteMode: "overwrite" },
    },
  } });
  const gateway = {
    discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Back"],
      models: ["Basic"], decks: ["Default"], errors: [] }),
    async invoke(action, params) {
      calls.push({ action, params });
      if (action === "canAddNotesWithErrorDetail") return [{
        canAdd: !overwrite,
        error: overwrite ? "cannot create note because it is a duplicate" : null,
      }];
      if (action === "findNotes") return overwrite ? [42] : [];
      if (action === "getMediaFilesNames") return files.has(params.pattern) ? [params.pattern] : [];
      if (action === "storeMediaFile") {
        if (params.filename === failStore) throw new Error("media folder is read-only");
        if (!acknowledgeWithoutStore) files.add(params.filename);
        if (rejectAfterStore) generation++;
        return params.filename;
      }
      if (action === "addNote") {
        if (duplicateRace) {
          duplicateRace = false;
          throw new Error("cannot create note because it is a duplicate");
        }
        fields = { ...params.note.fields };
        return 42;
      }
      if (action === "updateNoteFields") {
        fields = { ...fields, ...params.note.fields };
        return null;
      }
      if (action === "notesInfo") return [{ noteId: 42, modelName: "Basic",
        fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
      if (action === "deleteMediaFile") {
        assert.fail("deterministic dictionary media must be retained for reuse");
      }
      throw new Error(`Unexpected ${action}`);
    },
  };
  const service = createAnkiWorkerService({
    gateway,
    readOptions: async () => options,
    duplicateIndex: testIndex(() => overwrite ? [42] : []),
    readDictionaries: async () => [{ title: "Fixture", path: "/dicts/generation/Fixture", enabled: true }],
    engine: async message => {
      calls.push({ action: message.type, params: message });
      if (message.type === "hd_status") return { generation, ready: true, loading: false };
      if (message.type === "hd_media") {
        const data = message.path.endsWith(".svg") ? SVG_DATA : PNG_DATA;
        const mime = message.path.endsWith(".svg") ? "image/svg+xml" : "image/png";
        return { dataUrl: `data:${mime};base64,${data}` };
      }
      throw new Error(`Unexpected ${message.type}`);
    },
    offscreen: async message => {
      assert.equal(message.type, "hd_anki_fields");
      return {
        fields: {
          Front: "媒体証明",
          Back: items.map(item => `<img src="${item.filename}">`).join(""),
        },
        media: items.map(item => ({ ...item })),
      };
    },
  });
  const request = {
    term: { expression: "媒体証明", reading: "ばいたいしょうめい", rules: "", glossaries: [], frequencies: [], pitches: [] },
    generation: 3,
    trace: [],
    sentence: "媒体証明",
    matched: "媒体証明",
    matchOffset: 0,
    popupSelectionText: "",
    searchQuery: "媒体証明",
    documentTitle: "Test",
    dictionaryAliases: {},
    frequencyDictionaries: [],
  };
  return {
    service,
    request,
    calls,
    files,
    get fields() { return fields; },
    fail(filename) { failStore = filename; },
    clearFailure() { failStore = null; },
    acknowledgeWithoutPersistence(value = true) { acknowledgeWithoutStore = value; },
    rejectGenerationAfterStore(value = true) { rejectAfterStore = value; },
    resetGeneration() { generation = request.generation; },
    raceDuplicate() { duplicateRace = true; },
  };
}

test("dictionary PNG and SVG bytes are confirmed before addNote and every written reference exists", async () => {
  const f = dictionaryMediaFixture();
  f.request.configKey = (await f.service.status()).configKey;
  const result = await f.service.submit(f.request);
  assert.equal(result.state, "added");
  assert.equal(f.fields.Back, `<img src="${IMAGE_FILENAME}"><img src="${SVG_FILENAME}">`);
  assert.deepEqual([...f.files].sort(), [IMAGE_FILENAME, SVG_FILENAME].sort());
  for (const name of [IMAGE_FILENAME, SVG_FILENAME]) {
    const inventory = f.calls.findIndex(call => call.action === "getMediaFilesNames" && call.params.pattern === name);
    const retrieval = f.calls.findIndex(call => call.action === "hd_media" && call.params.path.endsWith(name.endsWith(".svg") ? ".svg" : ".png"));
    const store = f.calls.findIndex(call => call.action === "storeMediaFile" && call.params.filename === name);
    const add = f.calls.findIndex(call => call.action === "addNote");
    assert.ok(inventory >= 0 && retrieval > inventory && store > retrieval && add > store);
  }
});

test("dictionary media store failure cannot create a note with a missing reference", async () => {
  const f = dictionaryMediaFixture({ items: [
    { dictionary: "Fixture", path: "media/picture.png", filename: IMAGE_FILENAME },
  ] });
  f.fail(IMAGE_FILENAME);
  f.request.configKey = (await f.service.status()).configKey;
  await assert.rejects(f.service.submit(f.request), /media folder is read-only/u);
  assert.equal(f.calls.some(call => call.action === "addNote" || call.action === "updateNoteFields"), false);
  assert.equal(f.files.has(IMAGE_FILENAME), false);
  assert.deepEqual(f.calls.filter(call => ["getMediaFilesNames", "hd_media", "storeMediaFile"].includes(call.action))
    .map(call => call.action), ["getMediaFilesNames", "hd_media", "storeMediaFile", "getMediaFilesNames"]);
});

test("dictionary media store failure cannot update an existing note with a missing reference", async () => {
  const f = dictionaryMediaFixture({
    items: [{ dictionary: "Fixture", path: "media/picture.png", filename: IMAGE_FILENAME }],
    overwrite: true,
  });
  f.fail(IMAGE_FILENAME);
  f.request.configKey = (await f.service.status()).configKey;
  await assert.rejects(f.service.submit(f.request), /media folder is read-only/u);
  assert.equal(f.calls.some(call => call.action === "addNote" || call.action === "updateNoteFields"), false);
  assert.deepEqual(f.fields, { Front: "媒体証明", Back: "existing definition" });
  assert.equal(f.files.has(IMAGE_FILENAME), false);
});

test("an acknowledged but absent dictionary file blocks addNote", async () => {
  const f = dictionaryMediaFixture({ items: [
    { dictionary: "Fixture", path: "media/picture.png", filename: IMAGE_FILENAME },
  ] });
  f.acknowledgeWithoutPersistence();
  f.request.configKey = (await f.service.status()).configKey;
  await assert.rejects(f.service.submit(f.request), /without confirming the requested media filename/u);
  assert.equal(f.calls.some(call => call.action === "addNote" || call.action === "updateNoteFields"), false);
  assert.equal(f.files.has(IMAGE_FILENAME), false);
  assert.deepEqual(f.calls.filter(call => ["getMediaFilesNames", "storeMediaFile"].includes(call.action))
    .map(call => call.action), ["getMediaFilesNames", "storeMediaFile", "getMediaFilesNames"]);
});

test("a later generation rejection retains deterministic media and retry reuses it without another upload", async () => {
  const f = dictionaryMediaFixture({ items: [
    { dictionary: "Fixture", path: "media/picture.png", filename: IMAGE_FILENAME },
  ] });
  f.rejectGenerationAfterStore();
  f.request.configKey = (await f.service.status()).configKey;
  await assert.rejects(f.service.submit(f.request), /dictionary generation changed/u);
  assert.equal(f.calls.some(call => call.action === "addNote"), false);
  assert.equal(f.files.has(IMAGE_FILENAME), true);
  assert.equal(f.calls.filter(call => call.action === "storeMediaFile").length, 1);
  assert.equal(f.calls.filter(call => call.action === "hd_media").length, 1);

  f.rejectGenerationAfterStore(false);
  f.resetGeneration();
  const retry = await f.service.submit(f.request);
  assert.equal(retry.state, "added");
  assert.equal(f.calls.filter(call => call.action === "storeMediaFile").length, 1);
  assert.equal(f.calls.filter(call => call.action === "hd_media").length, 1);
  assert.equal(f.calls.filter(call => call.action === "getMediaFilesNames").length, 3);
  assert.equal(f.fields.Back, `<img src="${IMAGE_FILENAME}">`);
  assert.equal(f.files.has(IMAGE_FILENAME), true);
});

test("a definitive duplicate race retains confirmed media for a later safe retry", async () => {
  const f = dictionaryMediaFixture({ items: [
    { dictionary: "Fixture", path: "media/picture.png", filename: IMAGE_FILENAME },
  ] });
  f.raceDuplicate();
  f.request.configKey = (await f.service.status()).configKey;
  assert.equal((await f.service.submit(f.request)).state, "duplicate");
  assert.equal(f.fields, undefined);
  assert.equal(f.files.has(IMAGE_FILENAME), true);
  assert.equal(f.calls.filter(call => call.action === "storeMediaFile").length, 1);

  assert.equal((await f.service.submit(f.request)).state, "added");
  assert.equal(f.calls.filter(call => call.action === "storeMediaFile").length, 1);
  assert.equal(f.calls.filter(call => call.action === "hd_media").length, 1);
  assert.equal(f.fields.Back, `<img src="${IMAGE_FILENAME}">`);
});

test("a mining screenshot is held until the note is written, then stored under its own name", async () => {
  const uploads = [];
  const deletions = [];
  let refuse = false, duplicate = false, lostReply = false, unsentReply = false;
  let check = { canAdd: true };
  const notes = new Map();
  let fields = null;
  const options = globalThis.HDReaderOptions.normaliseOptions({ anki: { model: "Basic", deck: "Default", apiKey: "local-key",
    fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
      Audio: { value: "{screenshot}", overwriteMode: "overwrite" } } } });
  const gateway = { discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Audio"],
    models: ["Basic"], decks: ["Default"], errors: [] }),
    async invoke(action, params, apiKey) {
      if (action === "canAddNotesWithErrorDetail") return [check];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "findNotes") return [12];
      if (action === "deleteMediaFile") { deletions.push(params.filename); return null; }
      if (action === "addNote") {
        if (duplicate) throw new Error("cannot create note because it is a duplicate");
        if (lostReply) throw new AnkiTransportError("Anki reply lost", { dispatched: true });
        if (unsentReply) throw new AnkiTransportError("Anki request was never sent", { dispatched: false });
        fields = params.note.fields;
        notes.set(12, fields);
        return 12;
      }
      if (action === "notesInfo") return [{ noteId: 12, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
      if (action !== "storeMediaFile") throw new Error(`Unexpected ${action}`);
      uploads.push({ ...params, apiKey });
      if (refuse) throw new Error("media folder is read-only");
      return params.filename;
    } };
  const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
    duplicateIndex: testIndex(() => /duplicate/iu.test(check.error ?? "") ? [12] : []),
    readDictionaries: async () => [], engine: async () => ({ generation: 3, ready: true, loading: false }),
    offscreen: async message => (message.type === "hd_anki_audio" ? { filename: "", data: "" } : {
      fields: Object.fromEntries(Object.entries(message.templates).map(([field, template]) =>
        [field, template.value.replace("{expression}", "猫").replace("{screenshot}", message.request.screenshot
          ? `<img src="${message.request.screenshot.filename}">` : "")])), media: [] }),
  });
  const request = { term: { expression: "猫", reading: "ねこ", rules: "", glossaries: [], frequencies: [], pitches: [] },
    generation: 3, trace: [], sentence: "猫", matched: "猫", matchOffset: 0, popupSelectionText: "", searchQuery: "猫",
    documentTitle: "Test", dictionaryAliases: {}, frequencyDictionaries: [] };

  // Capturing stores nothing: the picture waits for a note that is going ahead.
  const taken = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
  assert.match(taken.filename, /^hachidori-screenshot-[0-9a-f-]{36}\.jpg$/u);
  assert.match(taken.token, /^[0-9a-f-]{36}$/u);
  assert.equal(uploads.length, 0);

  const status = await service.status();
  const added = await service.submit({ ...request, configKey: status.configKey, screenshot: taken });
  assert.equal(added.state, "added");
  assert.deepEqual(added.warnings, []);
  assert.deepEqual(uploads, [{ filename: taken.filename, data: "c2hvdA==", deleteExisting: false, apiKey: "local-key" }]);
  assert.equal(notes.get(12).Audio, `<img src="${taken.filename}">`);

  // A picture that is no longer the pending one, and a refused upload, are both
  // warnings on a note that is still written without a broken reference.
  const stale = await service.submit({ ...request, term: { ...request.term, expression: "犬" },
    configKey: status.configKey, screenshot: taken });
  assert.equal(stale.state, "added");
  assert.match(stale.warnings.join(" "), /Screenshot: the captured picture was replaced/u);
  assert.equal(notes.get(12).Audio, "");
  assert.equal(uploads.length, 1);

  refuse = true;
  const retaken = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
  const refused = await service.submit({ ...request, term: { ...request.term, expression: "鳥" },
    configKey: status.configKey, screenshot: retaken });
  assert.equal(refused.state, "added");
  assert.match(refused.warnings.join(" "), /Screenshot: media folder is read-only/u);
  assert.equal(notes.get(12).Audio, "");
  // The store may have happened even though its answer was lost, so the note that
  // goes in without the picture takes that picture back out.
  assert.deepEqual(deletions, [retaken.filename]);
  deletions.length = 0;

  // A submission that is abandoned releases its picture, so a later note that
  // still names it is told the picture was replaced.
  refuse = false;
  const abandoned = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
  assert.deepEqual(service.discardScreenshot({ token: "someone-else" }), { discarded: true });
  service.discardScreenshot({ token: abandoned.token });
  const withoutHeld = await service.submit({ ...request, term: { ...request.term, expression: "牛" },
    configKey: status.configKey, screenshot: abandoned });
  assert.equal(withoutHeld.state, "added");
  assert.match(withoutHeld.warnings.join(" "), /Screenshot: the captured picture was replaced/u);
  assert.deepEqual(deletions, []);

  // Every authoritative no-write releases the pending bytes inside the worker,
  // even when the original reader cannot receive its reply and discard them.
  for (const outcome of ["duplicate", "invalid", "configuration changed"]) {
    const picture = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
    const submitted = { ...request, configKey: status.configKey, screenshot: picture };
    if (outcome === "configuration changed") {
      await assert.rejects(service.submit({ ...submitted, configKey: "stale" }), /configuration changed/u);
    } else {
      check = { canAdd: false, error: outcome === "duplicate" ? "cannot create note because it is a duplicate" : "invalid note" };
      assert.equal((await service.submit(submitted)).state, outcome);
    }
    check = { canAdd: true };
    const uploadsBefore = uploads.length;
    const retry = await service.submit(submitted);
    assert.match(retry.warnings.join(" "), /Screenshot: the captured picture was replaced/u);
    assert.equal(uploads.length, uploadsBefore, "a rejected submission must not leave its picture available for later upload");
  }

  const older = await service.screenshot(async () => "data:image/jpeg;base64,b2xk");
  const heldCapture = Promise.withResolvers();
  const delayedPicture = service.screenshot(async () => heldCapture.promise);
  const newer = await service.screenshot(async () => "data:image/jpeg;base64,bmV3");
  heldCapture.resolve("data:image/jpeg;base64,b2xk");
  await assert.rejects(delayedPicture, /newer capture/u);
  await assert.rejects(service.submit({ ...request, configKey: "stale", screenshot: older }), /configuration changed/u);
  const currentPicture = await service.submit({ ...request, configKey: status.configKey, screenshot: newer });
  assert.deepEqual(currentPicture.warnings, [], "old submission cleanup must leave a newer pending picture intact");
  assert.equal(uploads.at(-1).filename, newer.filename);

  // A note Anki definitively refuses takes its own picture back out of the media
  // folder rather than leaving it unreferenced.
  refuse = false;
  duplicate = true;
  const orphan = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
  const rejected = await service.submit({ ...request, term: { ...request.term, expression: "馬" },
    configKey: status.configKey, screenshot: orphan });
  assert.equal(rejected.state, "duplicate");
  assert.deepEqual(deletions, [orphan.filename]);
  duplicate = false;
  deletions.length = 0;

  lostReply = true;
  const uncertainPicture = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
  const uncertain = await service.submit({ ...request, configKey: status.configKey, screenshot: uncertainPicture });
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uploads.at(-1).filename, uncertainPicture.filename);
  assert.deepEqual(deletions, [], "an uncertain write must retain its uploaded screenshot");

  lostReply = false;
  unsentReply = true;
  const unsentPicture = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
  await assert.rejects(
    service.submit({ ...request, term: { ...request.term, expression: "兎" },
      configKey: status.configKey, screenshot: unsentPicture }),
    error => error instanceof AnkiTransportError && error.dispatched === false,
  );
  assert.equal(uploads.at(-1).filename, unsentPicture.filename);
  assert.deepEqual(deletions, [unsentPicture.filename],
    "a queued mutation rejected before dispatch must release its uploaded screenshot");

  // The capture itself refuses when the switch is off or the page gives nothing.
  await assert.rejects(service.screenshot(async () => "not-an-image"), /no screenshot/u);
  await assert.rejects(service.screenshot(async () => "data:image/png;base64,c2hvdA=="), /no screenshot/u);
  await assert.rejects(service.screenshot(async () => { throw new Error("The reading tab is no longer the active tab."); }),
    /no longer the active tab/u);
  options.anki.captureScreenshot = false;
  await assert.rejects(service.screenshot(async () => "data:image/jpeg;base64,c2hvdA=="), /turned off in Settings/u);
});

test("pronunciation enrichment keeps a failed or replaced screenshot unavailable", async t => {
  for (const outcome of ["stored", "replaced", "refused", "overwrite-refused"]) await t.test(outcome, async () => {
    const overwrite = outcome === "overwrite-refused";
    let fields = overwrite ? { Front: "猫", Back: "preserved" } : undefined;
    const updates = [];
    const mediaFiles = new Set();
    const options = globalThis.HDReaderOptions.normaliseOptions({ anki: { model: "Basic",
      duplicateBehavior: overwrite ? "overwrite" : "prevent", duplicateScope: "model",
      fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
        Back: { value: `${overwrite ? "preserved" : ""}{screenshot}{audio}`, overwriteMode: "overwrite" } } } });
    const gateway = { discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Back"],
      models: ["Basic"], decks: ["Default"], errors: [] }), async invoke(action, params) {
      if (action === "canAddNotesWithErrorDetail") return [{ canAdd: !overwrite,
        error: overwrite ? "cannot create note because it is a duplicate" : null }];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "findNotes") return [12];
      if (action === "getMediaFilesNames") return mediaFiles.has(params.pattern) ? [params.pattern] : [];
      if (action === "storeMediaFile") {
        if ((outcome === "refused" || overwrite) && params.filename.startsWith("hachidori-screenshot-")) {
          if (overwrite) fields.Back = "external edit";
          throw new Error("Screenshot upload acknowledgement lost");
        }
        mediaFiles.add(params.filename);
        return params.filename;
      }
      if (action === "deleteMediaFile") { mediaFiles.delete(params.filename); return null; }
      if (action === "addNote") { fields = { ...params.note.fields }; return 12; }
      if (action === "notesInfo") return [{ noteId: 12, modelName: "Basic",
        fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
      if (action === "updateNoteFields") { updates.push({ ...params.note.fields }); Object.assign(fields, params.note.fields); return null; }
      throw new Error(`Unexpected ${action}`);
    } };
    const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
      duplicateIndex: testIndex(() => overwrite ? [12] : []),
      readDictionaries: async () => [], engine: async () => ({ generation: 3, ready: true, loading: false }),
      offscreen: async message => message.type === "hd_anki_audio" ? { filename: AUDIO_FILENAME, data: AUDIO_DATA }
        : { fields: await buildAnkiFields(message.request, message.templates, { audio: message.audio }), media: [] },
    });
    const screenshot = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
    if (outcome === "replaced") await service.screenshot(async () => "data:image/jpeg;base64,bmV3");
    const result = await service.submit({ term: { expression: "猫", reading: "ねこ" }, generation: 3,
      configKey: (await service.status()).configKey, screenshot, captureUnavailable: ["animation"] });
    assert.equal(result.state, overwrite ? "updated" : "added");
    assert.equal(fields.Back, overwrite ? "external edit"
      : `${outcome === "stored" ? `<img src="${screenshot.filename}">` : ""}[sound:${AUDIO_FILENAME}]`);
    if (overwrite) {
      assert.deepEqual(updates, [{}], "failed media must not write back a value preserved from the duplicate snapshot");
      assert.match(result.warnings.join(" "), /pronunciation update was skipped/u);
    }
    if (outcome === "stored") assert.deepEqual(result.warnings, []);
    else assert.match(result.warnings.join(" "), /Screenshot: /u);
  });
});

test("worker selects the requested Template for destination, fields and screenshot policy", async () => {
  const base = globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE;
  const options = globalThis.HDReaderOptions.normaliseOptions({ anki: {
    url: "http://127.0.0.1:8765", apiKey: "", templates: [
      { ...base, id: "default", name: "Word", model: "Word", deck: "Words", captureScreenshot: true,
        fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" } } },
      { ...base, id: "sentence", name: "Sentence", model: "Sentence", deck: "Sentences", captureScreenshot: false,
        fieldTemplates: { Front: { value: "{sentence}", overwriteMode: "overwrite" } } },
    ],
  } });
  const notes = new Map();
  const writes = [];
  const gateway = {
    async discover(config) { return { connected: true, model: config.model, models: [config.model],
      decks: [config.deck], fields: ["Front"], errors: [] }; },
    async invoke(action, params) {
      if (action === "canAddNotesWithErrorDetail") return [{ canAdd: true, error: null }];
      if (action === "addNote") {
        const noteId = writes.length + 101;
        writes.push(params.note);
        notes.set(noteId, params.note);
        return noteId;
      }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId,
        modelName: notes.get(noteId).modelName,
        fields: Object.fromEntries(Object.entries(notes.get(noteId).fields)
          .map(([field, value]) => [field, { value }])) }));
      throw new Error(`Unexpected ${action}`);
    },
  };
  const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
    duplicateIndex: testIndex(), readDictionaries: async () => [],
    engine: async () => ({ generation: 9, ready: true, loading: false }),
    offscreen: async message => ({ fields: await buildAnkiFields(message.request, message.templates,
      { audio: message.audio }), media: [] }),
  });
  const screenshot = await service.screenshot(async () => "data:image/jpeg;base64,/9j/", "default");
  assert.match(screenshot.filename, /^hachidori-screenshot-/u);
  await assert.rejects(service.screenshot(async () => "data:image/jpeg;base64,/9j/", "sentence"),
    /turned off/u);
  await assert.rejects(service.screenshot(async () => "data:image/jpeg;base64,/9j/", "deleted"),
    /no longer available/u);

  const status = await service.status("sentence");
  const result = await service.submit({ templateId: "sentence", configKey: status.configKey,
    term: { expression: "猫", reading: "ねこ" }, sentence: "猫がいる。", generation: 9,
    trace: [], matched: "猫", matchOffset: 0, popupSelectionText: "", searchQuery: "猫",
    documentTitle: "Test", dictionaryAliases: {}, frequencyDictionaries: [] });
  assert.equal(result.state, "added");
  assert.deepEqual(writes, [{ deckName: "Sentences", modelName: "Sentence",
    fields: { Front: "<b>猫</b>がいる。" }, options: {
      allowDuplicate: false,
      duplicateScope: "collection",
      duplicateScopeOptions: { deckName: null, checkChildren: false, checkAllModels: false },
    }, tags: ["hachidori"] }]);
});

test("a recorded Netflix line is held until the note is written and stored as its own WAV, beside the screenshot", async () => {
  const uploads = [], deletions = [];
  let refuse = false, duplicate = false, lostReply = false, check = { canAdd: true }, fields = null;
  const options = globalThis.HDReaderOptions.normaliseOptions({
    experimental: { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.experimental, netflixMining: true },
    anki: { model: "Basic", deck: "Default", fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
      Back: { value: "{screenshot}{sentence-audio}", overwriteMode: "overwrite" } } } });
  const gateway = { discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Back"],
    models: ["Basic"], decks: ["Default"], errors: [] }),
    async invoke(action, params) {
      if (action === "canAddNotesWithErrorDetail") return [check];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "findNotes") return [12];
      if (action === "deleteMediaFile") { deletions.push(params.filename); return null; }
      if (action === "addNote") {
        if (duplicate) throw new Error("cannot create note because it is a duplicate");
        if (lostReply) throw new AnkiTransportError("Anki reply lost", { dispatched: true });
        fields = params.note.fields;
        return 12;
      }
      if (action === "notesInfo") return [{ noteId: 12, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
      if (action !== "storeMediaFile") throw new Error(`Unexpected ${action}`);
      uploads.push(params.filename);
      if (refuse && params.filename.endsWith(".wav")) throw new Error("media folder is read-only");
      return params.filename;
    } };
  const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
    duplicateIndex: testIndex(() => /duplicate/iu.test(check.error ?? "") ? [12] : []),
    readDictionaries: async () => [], engine: async () => ({ generation: 3, ready: true, loading: false }),
    offscreen: async message => ({ fields: await buildAnkiFields(message.request, message.templates, {}), media: [] }),
  });
  const request = { term: { expression: "猫", reading: "ねこ", rules: "", glossaries: [], frequencies: [], pitches: [] },
    generation: 3, trace: [], sentence: "猫", matched: "猫", matchOffset: 0, popupSelectionText: "", searchQuery: "猫",
    documentTitle: "Netflix", dictionaryAliases: {}, frequencyDictionaries: [],
    netflix: { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } } };
  const { configKey } = await service.status();
  const SENTENCE_AUDIO = /^hachidori-sentence-audio-[0-9a-f-]{36}\.wav$/u;

  // Holding stores nothing; only a WAV is held.
  await assert.rejects(service.sentenceAudio("bm90IHdhdg==", "default"), /no WAV audio/u);
  const held = await service.sentenceAudio(AUDIO_DATA, "default");
  assert.match(held.filename, SENTENCE_AUDIO);
  assert.equal(uploads.length, 0);
  const picture = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
  const added = await service.submit({ ...request, configKey, screenshot: picture, sentenceAudio: held });
  assert.equal(added.state, "added");
  assert.deepEqual(added.warnings, []);
  assert.deepEqual(uploads, [picture.filename, held.filename]);
  assert.equal(fields.Back, `<img src="${picture.filename}">[sound:${held.filename}]`);

  // A recording that is no longer the held one, and a refused upload, are warnings
  // on a note that is still written without a broken reference.
  const stale = await service.submit({ ...request, term: { ...request.term, expression: "犬" }, configKey, sentenceAudio: held });
  assert.match(stale.warnings.join(" "), /Sentence audio: the recorded line was replaced/u);
  assert.equal(fields.Back, "");
  refuse = true;
  const refusedLine = await service.sentenceAudio(AUDIO_DATA, "default");
  const refused = await service.submit({ ...request, term: { ...request.term, expression: "鳥" }, configKey,
    sentenceAudio: refusedLine });
  assert.equal(refused.state, "added");
  assert.match(refused.warnings.join(" "), /Sentence audio: media folder is read-only/u);
  assert.equal(fields.Back, "");
  assert.deepEqual(deletions, [refusedLine.filename]);
  refuse = false;
  deletions.length = 0;

  // A definitive no-write releases the held line; a definitively refused write
  // deletes the stored one; an uncertain write keeps it.
  check = { canAdd: false, error: "cannot create note because it is a duplicate" };
  const duplicateLine = await service.sentenceAudio(AUDIO_DATA, "default");
  assert.equal((await service.submit({ ...request, configKey, sentenceAudio: duplicateLine })).state, "duplicate");
  check = { canAdd: true };
  assert.match((await service.submit({ ...request, configKey, sentenceAudio: duplicateLine })).warnings.join(" "),
    /recorded line was replaced/u);
  duplicate = true;
  const rejectedLine = await service.sentenceAudio(AUDIO_DATA, "default");
  assert.equal((await service.submit({ ...request, term: { ...request.term, expression: "馬" }, configKey,
    sentenceAudio: rejectedLine })).state, "duplicate");
  assert.deepEqual(deletions, [rejectedLine.filename]);
  duplicate = false;
  deletions.length = 0;
  lostReply = true;
  const uncertainLine = await service.sentenceAudio(AUDIO_DATA, "default");
  assert.equal((await service.submit({ ...request, configKey, sentenceAudio: uncertainLine })).state, "uncertain");
  assert.equal(uploads.at(-1), uncertainLine.filename);
  assert.deepEqual(deletions, [], "an uncertain write must retain its uploaded line");
  lostReply = false;

  // An abandoned submission releases its own line only.
  const abandoned = await service.sentenceAudio(AUDIO_DATA, "default");
  assert.deepEqual(service.discardScreenshot({ token: "someone-else" }), { discarded: true });
  service.discardScreenshot({ token: abandoned.token });
  assert.match((await service.submit({ ...request, term: { ...request.term, expression: "牛" }, configKey,
    sentenceAudio: abandoned })).warnings.join(" "), /recorded line was replaced/u);

  await assert.rejects(service.sentenceAudio(AUDIO_DATA, "deleted"), /no longer available/u);
  options.experimental.netflixMining = false;
  await assert.rejects(service.sentenceAudio(AUDIO_DATA, "default"), /turned off in Settings/u);
});

test("a recorded Netflix GIF is held, stored under its own name, and falls back to the screenshot", async () => {
  const uploads = [], deletions = [];
  let refuse = false, duplicate = false, fields = null;
  const options = globalThis.HDReaderOptions.normaliseOptions({
    experimental: { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.experimental, netflixMining: true },
    anki: { model: "Basic", deck: "Default", fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
      // {gif} renders the GIF when present, otherwise the screenshot's <img>.
      Back: { value: "{gif}", overwriteMode: "overwrite" } } } });
  const gateway = { discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Back"],
    models: ["Basic"], decks: ["Default"], errors: [] }),
    async invoke(action, params) {
      if (action === "canAddNotesWithErrorDetail") return [{ canAdd: true }];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "findNotes") return [];
      if (action === "deleteMediaFile") { deletions.push(params.filename); return null; }
      if (action === "addNote") {
        if (duplicate) throw new Error("cannot create note because it is a duplicate");
        fields = params.note.fields;
        return 12;
      }
      if (action === "notesInfo") return [{ noteId: 12, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
      if (action !== "storeMediaFile") throw new Error(`Unexpected ${action}`);
      uploads.push(params.filename);
      if (refuse && params.filename.endsWith(".gif")) throw new Error("media folder is read-only");
      return params.filename;
    } };
  const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
    duplicateIndex: testIndex(() => []),
    readDictionaries: async () => [], engine: async () => ({ generation: 3, ready: true, loading: false }),
    offscreen: async message => ({ fields: await buildAnkiFields(message.request, message.templates, {}), media: [] }),
  });
  const request = { term: { expression: "猫", reading: "ねこ", rules: "", glossaries: [], frequencies: [], pitches: [] },
    generation: 3, trace: [], sentence: "猫", matched: "猫", matchOffset: 0, popupSelectionText: "", searchQuery: "猫",
    documentTitle: "Netflix", dictionaryAliases: {}, frequencyDictionaries: [],
    netflix: { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } } };
  const { configKey } = await service.status();
  const GIF = /^hachidori-gif-[0-9a-f-]{36}\.gif$/u;

  // Only a GIF is held; its filename is distinct from the WAV and the picture.
  await assert.rejects(service.gifImage("bm90IGdpZg==", "default"), /no GIF/u);
  const held = await service.gifImage(GIF_DATA, "default");
  assert.match(held.filename, GIF);
  assert.equal(uploads.length, 0);

  // The GIF is stored inside the write and the {gif} field references it.
  const added = await service.submit({ ...request, configKey, gif: held });
  assert.equal(added.state, "added");
  assert.deepEqual(added.warnings, []);
  assert.deepEqual(uploads, [held.filename]);
  assert.equal(fields.Back, `<img src="${held.filename}">`);

  // With the GIF marked unavailable, {gif} falls back to the screenshot's <img>.
  const picture = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
  const fellBack = await service.submit({ ...request, configKey, screenshot: picture,
    captureUnavailable: ["gif"] });
  assert.equal(fellBack.state, "added");
  assert.equal(fields.Back, `<img src="${picture.filename}">`, "{gif} rendered the screenshot instead");

  // A replaced GIF is a warning; the field keeps no broken reference.
  const stale = await service.submit({ ...request, term: { ...request.term, expression: "犬" }, configKey, gif: held });
  assert.match(stale.warnings.join(" "), /GIF: the recorded GIF was replaced/u);
  assert.equal(fields.Back, "");

  // A refused upload is a warning and the stored file is taken back out.
  refuse = true;
  const refusedGif = await service.gifImage(GIF_DATA, "default");
  const refused = await service.submit({ ...request, term: { ...request.term, expression: "鳥" }, configKey, gif: refusedGif });
  assert.equal(refused.state, "added");
  assert.match(refused.warnings.join(" "), /GIF: media folder is read-only/u);
  assert.deepEqual(deletions, [refusedGif.filename]);
  refuse = false;
  deletions.length = 0;

  // A definitively rejected note deletes its GIF; discarding by token releases it.
  duplicate = true;
  const rejectedGif = await service.gifImage(GIF_DATA, "default");
  assert.equal((await service.submit({ ...request, configKey, gif: rejectedGif })).state, "duplicate");
  assert.deepEqual(deletions, [rejectedGif.filename]);
  duplicate = false;
  const abandoned = await service.gifImage(GIF_DATA, "default");
  service.discardScreenshot({ token: abandoned.token });
  assert.match((await service.submit({ ...request, term: { ...request.term, expression: "牛" }, configKey, gif: abandoned })).warnings.join(" "),
    /recorded GIF was replaced/u);

  options.experimental.netflixMining = false;
  await assert.rejects(service.gifImage(GIF_DATA, "default"), /turned off in Settings/u);
});
