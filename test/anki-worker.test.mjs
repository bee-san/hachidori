// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";
import { buildAnkiFields } from "../extension/anki-values.js";

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
  const calls = [], audioRequests = [];
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
      return { fields: Object.fromEntries(Object.entries(message.templates).map(([field, template]) =>
        [field, template.value.replace("{expression}", "猫").replace("{audio}", message.audio)])), media: [] };
    },
  });
  const request = { term: { expression: "猫", reading: "ねこ", rules: "", glossaries: [], frequencies: [], pitches: [] },
    generation: 3, trace: [], sentence: "猫", matched: "猫", matchOffset: 0, popupSelectionText: "", searchQuery: "猫", documentTitle: "Test",
    dictionaryAliases: {}, frequencyDictionaries: [] };
  return { service, calls, audioRequests, request, changedGeneration() { generation++; },
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

function captureFixture({
  templates = {
    Front: { value: "{expression}", overwriteMode: "overwrite" },
    Media: { value: "{capture-animation}", overwriteMode: "overwrite" },
    CapturedAudio: { value: "{capture-audio}", overwriteMode: "overwrite" },
  },
  model = "Basic",
  mediaCapture = {},
  duplicate = false,
  existingFields,
  failFirstWrite = false,
  failReadback = false,
  stopAfterLastUpload = false,
  stopDuringFinalConfigRead = false,
  stopDuringWrite = false,
  assets = {
    animation: { filename: "hachidori-abc123.avif", data: "AQI=", byteLength: 2 },
    audio: { filename: "hachidori-abc123.wav", data: "Aw==", byteLength: 1 },
  },
  warnings = [],
} = {}) {
  const calls = [];
  const endpointCalls = [];
  const storedMedia = [];
  const renderedTemplates = [];
  let fields = duplicate ? structuredClone(existingFields
    ?? { Front: "猫", Media: "kept", CapturedAudio: "" }) : null;
  let writes = 0;
  let captureAvailable = true, uploads = 0;
  const options = globalThis.HDReaderOptions.normaliseOptions({
    mediaCapture: {
      ...globalThis.HDReaderOptions.DEFAULT_MEDIA_CAPTURE,
      enabled: true,
      ...mediaCapture,
    },
    anki: {
      model,
      deck: "Default",
      duplicateBehavior: duplicate ? "overwrite" : "prevent",
      fieldTemplates: templates,
    },
  });
  const gateway = {
    discover: async () => ({ connected: true, model, fields: Object.keys(templates),
      models: [model], decks: ["Default"], errors: [] }),
    async invoke(action, params, apiKey, timeoutMs, url) {
      calls.push(action);
      endpointCalls.push({ action, url });
      if (action === "canAddNotesWithErrorDetail") {
        return [{ canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null }];
      }
      if (action === "modelNamesAndIds") return { [model]: 7 };
      if (action === "findNotes") return duplicate ? [44] : [];
      if (action === "addNote") {
        if (stopDuringWrite) captureAvailable = false;
        if (failFirstWrite && writes++ === 0) throw new Error("connection lost after send");
        fields = params.note.fields;
        return 12;
      }
      if (action === "updateNoteFields") {
        if (stopDuringWrite) captureAvailable = false;
        fields = { ...fields, ...params.note.fields };
        return null;
      }
      if (action === "notesInfo") {
        if (failReadback) throw new Error("readback failed");
        const noteId = params.notes[0];
        return [{ noteId, modelName: model, cards: [], fields: Object.fromEntries(
          Object.entries(fields).map(([field, value]) => [field, { value }]),
        ) }];
      }
      if (action === "storeMediaFile") {
        uploads++;
        storedMedia.push(params.filename);
        if (stopAfterLastUpload && uploads === Object.keys(assets).length) captureAvailable = false;
        return params.filename;
      }
      throw new Error(`Unexpected ${action}`);
    },
  };
  const captureCalls = [];
  const capture = async message => {
    captureCalls.push(message);
    if (!captureAvailable) throw new Error("The media export job expired.");
    if (message.type === "hd_capture_job_status") {
      return { ok: true, state: "ready", warnings,
        assets: Object.fromEntries(Object.entries(assets).map(([kind, asset]) =>
          [kind, { filename: asset.filename, byteLength: asset.byteLength }])) };
    }
    if (message.type === "hd_capture_asset") {
      const asset = assets[message.kind];
      return { ok: true, filename: asset.filename, data: asset.data };
    }
    if (message.type === "hd_capture_complete") return { ok: true, completed: true };
    if (message.type === "hd_capture_cancel") return { ok: true, cancelled: true };
    throw new Error(`Unexpected capture ${message.type}`);
  };
  const service = createAnkiWorkerService({
    gateway,
    duplicateIndex: testIndex(() => duplicate ? [44] : []),
    readOptions: async () => {
      if (stopDuringFinalConfigRead && uploads === Object.keys(assets).length) captureAvailable = false;
      return options;
    },
    readDictionaries: async () => [],
    engine: async message => {
      calls.push(message.type);
      return { generation: 3, ready: true, loading: false };
    },
    offscreen: async message => {
      renderedTemplates.push(structuredClone(message.templates));
      return {
        fields: Object.fromEntries(Object.entries(message.templates).map(([field, template]) => [field,
          template.value
            .replaceAll("{expression}", "猫")
            .replaceAll("{screenshot}", message.request.captureUnavailable?.includes("screenshot")
              ? "" : `<img src="${message.request.screenshot?.filename || ""}">`)
            .replaceAll("{capture-animation}", message.request.captureUnavailable?.includes("animation")
              ? "" : `<img src="${message.request.capturePin?.animationFilename || ""}">`)
            .replaceAll("{capture-audio}", message.request.captureUnavailable?.includes("audio")
              ? "" : `[sound:${message.request.capturePin?.audioFilename || ""}]`)])),
        media: [],
      };
    },
    capture,
  });
  const request = {
    term: { expression: "猫", reading: "ねこ", rules: "", glossaries: [], frequencies: [], pitches: [] },
    generation: 3,
    trace: [],
    sentence: "猫",
    matched: "猫",
    matchOffset: 0,
    popupSelectionText: "",
    searchQuery: "猫",
    documentTitle: "Test",
    dictionaryAliases: {},
    frequencyDictionaries: [],
    capturePin: {
      token: "pin-token",
      captureSessionId: "capture-session",
      sourceKind: "cue",
      sourceLabel: "Video cue",
      partial: false,
      animationFilename: "hachidori-abc123.avif",
      audioFilename: "hachidori-abc123.wav",
      readyAtMs: Date.now(),
    },
  };
  return { service, calls, endpointCalls, storedMedia, renderedTemplates, captureCalls, request,
    changeEndpoint(url) { options.anki.url = url; },
    stop() { captureAvailable = false; },
    get configuredTemplates() { return options.anki.fieldTemplates; },
    get fields() { return fields; } };
}

function presetCaptureTemplates(family, {
  picture = "before{screenshot}after",
  audio = "",
  pictureMode = "append",
  audioMode = "coalesce-new",
} = {}) {
  if (family === "senren") {
    return {
      word: { value: "{expression}", overwriteMode: "overwrite" },
      picture: { value: picture, overwriteMode: pictureMode },
      sentenceAudio: { value: audio, overwriteMode: audioMode },
    };
  }
  return {
    Expression: { value: "{expression}", overwriteMode: "overwrite" },
    Picture: { value: picture, overwriteMode: pictureMode },
    SentenceAudio: { value: audio, overwriteMode: audioMode },
  };
}

test("pinned Kiku, Lapis and Senren clips route stock picture and sentence-audio fields without changing saved templates", async t => {
  for (const [family, model] of [["kiku", "Kiku v2"], ["lapis", "Lapis-1.4"], ["senren", "Senren (2026)"]]) {
    await t.test(family, async () => {
      const templates = presetCaptureTemplates(family);
      const saved = structuredClone(templates);
      const f = captureFixture({ model, templates });
      f.request.configKey = (await f.service.status()).configKey;
      const preflight = await f.service.preflight(f.request);
      assert.deepEqual(preflight.capture.requirements,
        { includeAnimation: true, includeAudio: true, includeScreenshot: false });
      assert.equal(preflight.screenshot, false);
      const picture = family === "senren" ? "picture" : "Picture";
      const audio = family === "senren" ? "sentenceAudio" : "SentenceAudio";
      assert.equal(f.renderedTemplates.at(-1)[picture].value, "before{capture-animation}after");
      assert.equal(f.renderedTemplates.at(-1)[picture].overwriteMode, "append");
      assert.equal(f.renderedTemplates.at(-1)[audio].value, "{capture-audio}");
      assert.equal(f.renderedTemplates.at(-1)[audio].overwriteMode, "coalesce-new");

      f.request.captureJobId = `job-${family}`;
      assert.equal((await f.service.submit(f.request)).state, "added");
      assert.equal(f.fields[picture], 'before<img src="hachidori-abc123.avif">after');
      assert.equal(f.fields[audio], "[sound:hachidori-abc123.wav]");
      assert.deepEqual(f.storedMedia, ["hachidori-abc123.avif", "hachidori-abc123.wav"]);
      assert.deepEqual(f.configuredTemplates, saved);
    });
  }
});

test("automatic preset routing follows independent outputs and preserves custom, disabled and unpinned mappings", async t => {
  const variants = [
    {
      name: "animation only",
      mediaCapture: { includeAnimation: true, includeCapturedAudio: false },
      capture: { includeAnimation: true, includeAudio: false, includeScreenshot: false },
      screenshot: false,
      picture: "before{capture-animation}after",
      audio: "",
    },
    {
      name: "audio only",
      mediaCapture: { includeAnimation: false, includeCapturedAudio: true },
      capture: { includeAnimation: false, includeAudio: true, includeScreenshot: true },
      screenshot: true,
      picture: "before{screenshot}after",
      audio: "{capture-audio}",
    },
    {
      name: "capture disabled",
      mediaCapture: { enabled: false },
      capture: null,
      screenshot: true,
      picture: "before{screenshot}after",
      audio: "",
    },
  ];
  for (const variant of variants) await t.test(variant.name, async () => {
    const f = captureFixture({
      model: "Kiku v2",
      templates: presetCaptureTemplates("kiku"),
      mediaCapture: variant.mediaCapture,
    });
    f.request.configKey = (await f.service.status()).configKey;
    const preflight = await f.service.preflight(f.request);
    assert.deepEqual(preflight.capture?.requirements ?? null, variant.capture);
    assert.equal(preflight.screenshot, variant.screenshot);
    assert.equal(f.renderedTemplates.at(-1).Picture.value, variant.picture);
    assert.equal(f.renderedTemplates.at(-1).SentenceAudio.value, variant.audio);
  });

  await t.test("nonblank sentence audio", async () => {
    const f = captureFixture({
      model: "Kiku",
      templates: presetCaptureTemplates("kiku", { audio: "custom {audio}" }),
    });
    f.request.configKey = (await f.service.status()).configKey;
    const preflight = await f.service.preflight(f.request);
    assert.deepEqual(preflight.capture.requirements,
      { includeAnimation: true, includeAudio: false, includeScreenshot: false });
    assert.equal(f.renderedTemplates.at(-1).SentenceAudio.value, "custom {audio}");
  });

  await t.test("custom model", async () => {
    const f = captureFixture({ model: "My Kiku", templates: presetCaptureTemplates("kiku") });
    f.request.configKey = (await f.service.status()).configKey;
    const preflight = await f.service.preflight(f.request);
    assert.equal(preflight.capture, null);
    assert.equal(preflight.screenshot, true);
    assert.deepEqual(f.renderedTemplates.at(-1), f.configuredTemplates);
  });

  await t.test("request cache remains immutable", async () => {
    const f = captureFixture({ model: "Kiku", templates: presetCaptureTemplates("kiku") });
    f.request.configKey = (await f.service.status()).configKey;
    assert.equal((await f.service.preflight(f.request)).screenshot, false);
    delete f.request.capturePin;
    const unpinned = await f.service.preflight(f.request);
    assert.equal(unpinned.capture, null);
    assert.equal(unpinned.screenshot, true);
    assert.equal(f.renderedTemplates.at(-1).Picture.value, "before{screenshot}after");
    assert.equal(f.renderedTemplates.at(-1).SentenceAudio.value, "");
  });
});

test("automatic preset routing happens before overwrite filtering so retained fields need no export or upload", async () => {
  const templates = presetCaptureTemplates("kiku", {
    picture: "{screenshot}",
    pictureMode: "coalesce",
    audioMode: "coalesce",
  });
  const existingFields = {
    Expression: "猫",
    Picture: '<img src="existing.avif">',
    SentenceAudio: "[sound:existing.wav]",
  };
  const f = captureFixture({ model: "Kiku", templates, duplicate: true, existingFields });
  f.request.configKey = (await f.service.status()).configKey;
  const preflight = await f.service.preflight(f.request);
  assert.equal(preflight.action, "overwrite");
  assert.equal(preflight.capture, null);
  assert.equal(preflight.screenshot, false);
  assert.equal((await f.service.submit(f.request)).state, "updated");
  assert.deepEqual(f.fields, existingFields);
  assert.deepEqual(f.captureCalls, []);
  assert.deepEqual(f.storedMedia, []);
});

test("captured media preflight stays read-only and submission uploads referenced assets before the note", async () => {
  const f = captureFixture();
  f.request.configKey = (await f.service.status()).configKey;
  const preflight = await f.service.preflight(f.request);
  assert.deepEqual(preflight.capture.requirements, { includeAnimation: true, includeAudio: true, includeScreenshot: false });
  assert.equal(preflight.capture.sourceLabel, "Video cue");
  assert.deepEqual(f.captureCalls, []);
  assert.equal(f.calls.includes("storeMediaFile"), false);

  f.request.captureJobId = "job-1";
  const result = await f.service.submit(f.request);
  assert.equal(result.state, "added");
  assert.equal(f.fields.Media, '<img src="hachidori-abc123.avif">');
  assert.equal(f.fields.CapturedAudio, "[sound:hachidori-abc123.wav]");
  assert.deepEqual(f.captureCalls.map(call => call.type),
    ["hd_capture_job_status", "hd_capture_asset", "hd_capture_asset", "hd_capture_job_status", "hd_capture_complete"]);
  assert.ok(f.calls.lastIndexOf("storeMediaFile") < f.calls.indexOf("addNote"));
});

test("host mining uploads externally supplied screenshot and AVIF/WAV bytes without touching host capture state", async () => {
  const screenshot = {
    token: "linked-screen",
    filename: "hachidori-screenshot-123e4567-e89b-42d3-a456-426614174000.jpg",
  };
  const f = captureFixture({
    templates: {
      Front: { value: "{expression}", overwriteMode: "overwrite" },
      Screenshot: { value: "{screenshot}", overwriteMode: "overwrite" },
      Media: { value: "{capture-animation}", overwriteMode: "overwrite" },
      CapturedAudio: { value: "{capture-audio}", overwriteMode: "overwrite" },
    },
  });
  f.request.configKey = (await f.service.status()).configKey;
  f.request.captureJobId = "linked-job";
  f.request.screenshot = screenshot;
  const result = await f.service.submitClient(f.request, {
    screenshot: { ...screenshot, data: "/9j/2Q==" },
    capture: {
      jobId: "linked-job",
      warnings: ["client warning"],
      assets: {
        animation: { filename: "hachidori-abc123.avif", byteLength: 2, data: "AQI=" },
        audio: { filename: "hachidori-abc123.wav", byteLength: 1, data: "Aw==" },
      },
    },
  });
  assert.equal(result.state, "added");
  assert.match(result.warnings.join(" "), /client warning/u);
  assert.equal(f.fields.Screenshot, `<img src="${screenshot.filename}">`);
  assert.equal(f.fields.Media, '<img src="hachidori-abc123.avif">');
  assert.equal(f.fields.CapturedAudio, "[sound:hachidori-abc123.wav]");
  assert.deepEqual(f.storedMedia, [screenshot.filename, "hachidori-abc123.avif", "hachidori-abc123.wav"]);
  assert.deepEqual(f.captureCalls, [], "Chrome must not consult its own capture session for Brave-owned media");
  assert.ok(f.calls.filter(call => call === "hd_status").length >= 4, "every host-side generation guard remains active");
});

test("client media export and outcome cleanup stay local to the reading browser", async () => {
  const f = captureFixture({
    templates: {
      Front: { value: "{expression}", overwriteMode: "overwrite" },
      Media: { value: "{capture-animation}", overwriteMode: "overwrite" },
      CapturedAudio: { value: "{capture-audio}", overwriteMode: "overwrite" },
    },
    warnings: ["local warning"],
  });
  f.request.captureJobId = "client-job";
  const media = await f.service.clientMedia(f.request);
  assert.deepEqual(media, {
    capture: {
      jobId: "client-job",
      warnings: ["local warning"],
      assets: {
        animation: { filename: "hachidori-abc123.avif", byteLength: 2, data: "AQI=" },
        audio: { filename: "hachidori-abc123.wav", byteLength: 1, data: "Aw==" },
      },
    },
  });
  assert.deepEqual(f.captureCalls.map(call => call.type),
    ["hd_capture_job_status", "hd_capture_asset", "hd_capture_asset"]);
  await f.service.settleClientMedia(f.request, "added");
  assert.equal(f.captureCalls.at(-1).type, "hd_capture_complete");

  f.request.captureJobId = "client-rejected";
  await f.service.settleClientMedia(f.request, "duplicate");
  assert.equal(f.captureCalls.at(-1).type, "hd_capture_cancel");
});

test("host generation validation rejects stale externally supplied media before any Anki write", async () => {
  const f = captureFixture();
  f.request.configKey = (await f.service.status()).configKey;
  f.request.generation = 2;
  f.request.captureJobId = "stale-job";
  await assert.rejects(f.service.submitClient(f.request, {
    capture: {
      jobId: "stale-job",
      warnings: [],
      assets: {
        animation: { filename: "hachidori-abc123.avif", byteLength: 2, data: "AQI=" },
        audio: { filename: "hachidori-abc123.wav", byteLength: 1, data: "Aw==" },
      },
    },
  }), /dictionary generation changed/u);
  assert.equal(f.calls.includes("addNote"), false);
  assert.equal(f.calls.includes("storeMediaFile"), false);
  assert.deepEqual(f.captureCalls, []);
});

test("Stop during the final capture upload or config read prevents a new add or overwrite", async () => {
  for (const duplicate of [false, true]) {
    for (const stopPoint of ["stopAfterLastUpload", "stopDuringFinalConfigRead"]) {
      const f = captureFixture({ duplicate, [stopPoint]: true });
      f.request.configKey = (await f.service.status()).configKey;
      f.request.captureJobId = "job-stopped";
      await assert.rejects(f.service.submit(f.request), /export job expired/u);
      assert.equal(f.calls.filter(action => action === "storeMediaFile").length, 2);
      assert.equal(f.calls.includes("addNote"), false);
      assert.equal(f.calls.includes("updateNoteFields"), false);
    }
  }
});

test("Stop after a mutation was sent preserves its confirmed result", async () => {
  for (const duplicate of [false, true]) {
    const f = captureFixture({ duplicate, stopDuringWrite: true });
    f.request.configKey = (await f.service.status()).configKey;
    f.request.captureJobId = "job-sent";
    const result = await f.service.submit(f.request);
    assert.equal(result.state, duplicate ? "updated" : "added");
    assert.match(result.warnings.join(" "), /Captured media cleanup.*export job expired/u);
  }
});

test("overwrite skip policy can suppress all captured media without a pin, export or upload", async () => {
  const f = captureFixture({
    duplicate: true,
    templates: {
      Front: { value: "{expression}", overwriteMode: "overwrite" },
      Media: { value: "{capture-animation}", overwriteMode: "skip" },
      CapturedAudio: { value: "", overwriteMode: "overwrite" },
    },
  });
  delete f.request.capturePin;
  f.request.configKey = (await f.service.status()).configKey;
  const preflight = await f.service.preflight(f.request);
  assert.equal(preflight.action, "overwrite");
  assert.equal(preflight.capture, null);
  const result = await f.service.submit(f.request);
  assert.equal(result.state, "updated");
  assert.equal(f.fields.Media, "kept");
  assert.deepEqual(f.captureCalls, []);
  assert.equal(f.calls.includes("storeMediaFile"), false);
});

test("unchanged captured fields do not require another export or upload", async () => {
  const f = captureFixture({ duplicate: true, templates: {
    Front: { value: "{expression}", overwriteMode: "overwrite" },
    Media: { value: "{capture-animation}", overwriteMode: "overwrite" },
    CapturedAudio: { value: "", overwriteMode: "overwrite" },
  } });
  f.fields.Media = '<img src="hachidori-abc123.avif">';
  f.request.configKey = (await f.service.status()).configKey;
  assert.equal((await f.service.preflight(f.request)).capture, null);
  assert.equal((await f.service.submit(f.request)).state, "updated");
  assert.equal(f.fields.Media, '<img src="hachidori-abc123.avif">');
  assert.deepEqual(f.captureCalls, []);
  assert.equal(f.calls.includes("storeMediaFile"), false);
});

test("an uncertain note write retains confirmed capture uploads for an explicit retry", async () => {
  const f = captureFixture({
    failFirstWrite: true,
    templates: {
      Front: { value: "{expression}", overwriteMode: "overwrite" },
      Media: { value: "{capture-animation}", overwriteMode: "overwrite" },
    },
  });
  f.request.configKey = (await f.service.status()).configKey;
  f.request.captureJobId = "job-retry";
  assert.equal((await f.service.submit(f.request)).state, "uncertain");
  assert.equal(f.captureCalls.filter(call => call.type === "hd_capture_asset").length, 1);
  assert.equal(f.calls.filter(call => call === "storeMediaFile").length, 1);
  const retry = await f.service.submit(f.request);
  assert.equal(retry.state, "added");
  assert.equal(f.captureCalls.filter(call => call.type === "hd_capture_asset").length, 1);
  assert.equal(f.calls.filter(call => call === "storeMediaFile").length, 1);
  assert.equal(f.captureCalls.filter(call => call.type === "hd_capture_complete").length, 1);
});

test("an uncertain capture retried at a different Anki endpoint uploads its media to that endpoint", async () => {
  const f = captureFixture({ failFirstWrite: true, templates: {
    Front: { value: "{expression}", overwriteMode: "overwrite" },
    Media: { value: "{capture-animation}", overwriteMode: "overwrite" },
  } });
  f.request.configKey = (await f.service.status()).configKey;
  f.request.captureJobId = "job-other-endpoint";
  assert.equal((await f.service.submit(f.request)).state, "uncertain");
  f.changeEndpoint("https://other-anki.example/api");
  f.request.configKey = (await f.service.status()).configKey;
  assert.equal((await f.service.submit(f.request)).state, "added");
  assert.deepEqual(f.endpointCalls.filter(call => call.action === "storeMediaFile").map(call => call.url),
    ["http://127.0.0.1:8765", "https://other-anki.example/api"]);
  assert.equal(f.captureCalls.filter(call => call.type === "hd_capture_asset").length, 2);
});

test("a confirmed note releases its capture job even when field readback fails", async () => {
  const f = captureFixture({
    failReadback: true,
    templates: {
      Front: { value: "{expression}", overwriteMode: "overwrite" },
      Media: { value: "{capture-animation}", overwriteMode: "overwrite" },
    },
  });
  f.request.configKey = (await f.service.status()).configKey;
  f.request.captureJobId = "job-readback";
  const result = await f.service.submit(f.request);
  assert.equal(result.state, "added");
  assert.match(result.warnings.join(" "), /readback failed/u);
  assert.equal(f.captureCalls.filter(call => call.type === "hd_capture_complete").length, 1);
});

test("missing captured audio writes the mapped animation only and returns the source warning", async () => {
  const f = captureFixture({
    assets: {
      animation: { filename: "hachidori-abc123.avif", data: "AQI=", byteLength: 2 },
    },
    warnings: ["The shared source did not provide audio; this note will use animation only."],
  });
  f.request.configKey = (await f.service.status()).configKey;
  f.request.captureJobId = "job-video-only";
  f.request.captureUnavailable = ["audio"];
  const result = await f.service.submit(f.request);
  assert.equal(result.state, "added");
  assert.equal(f.fields.Media, '<img src="hachidori-abc123.avif">');
  assert.equal(f.fields.CapturedAudio, "");
  assert.match(result.warnings.join(" "), /did not provide audio/u);
  assert.equal(f.captureCalls.filter(call => call.type === "hd_capture_asset").length, 1);
});

test("a mining screenshot is held until the note is written, then stored under its own name", async () => {
  const uploads = [];
  const deletions = [];
  let refuse = false, duplicate = false, lostReply = false;
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
        if (lostReply) throw new Error("Anki reply lost");
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
