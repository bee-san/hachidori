// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";
import { buildAnkiFields } from "../extension/anki-values.js";

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

function captureFixture({
  templates = {
    Front: { value: "{expression}", overwriteMode: "overwrite" },
    Media: { value: "{capture-animation}", overwriteMode: "overwrite" },
    CapturedAudio: { value: "{capture-audio}", overwriteMode: "overwrite" },
  },
  duplicate = false,
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
  let fields = duplicate ? { Front: "猫", Media: "kept", CapturedAudio: "" } : null;
  let writes = 0;
  let captureAvailable = true, uploads = 0;
  const options = globalThis.HDReaderOptions.normaliseOptions({
    mediaCapture: {
      ...globalThis.HDReaderOptions.DEFAULT_MEDIA_CAPTURE,
      enabled: true,
    },
    anki: {
      model: "Basic",
      deck: "Default",
      duplicateBehavior: duplicate ? "overwrite" : "prevent",
      fieldTemplates: templates,
    },
  });
  const gateway = {
    discover: async () => ({ connected: true, model: "Basic", fields: Object.keys(templates),
      models: ["Basic"], decks: ["Default"], errors: [] }),
    async invoke(action, params) {
      calls.push(action);
      if (action === "canAddNotesWithErrorDetail") {
        return [{ canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null }];
      }
      if (action === "modelNamesAndIds") return { Basic: 7 };
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
        return [{ noteId, modelName: "Basic", cards: [], fields: Object.fromEntries(
          Object.entries(fields).map(([field, value]) => [field, { value }]),
        ) }];
      }
      if (action === "storeMediaFile") {
        uploads++;
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
    throw new Error(`Unexpected capture ${message.type}`);
  };
  const service = createAnkiWorkerService({
    gateway,
    readOptions: async () => {
      if (stopDuringFinalConfigRead && uploads === Object.keys(assets).length) captureAvailable = false;
      return options;
    },
    readDictionaries: async () => [],
    engine: async message => {
      calls.push(message.type);
      return { generation: 3, ready: true, loading: false };
    },
    offscreen: async message => ({
      fields: Object.fromEntries(Object.entries(message.templates).map(([field, template]) => [field,
        template.value
          .replaceAll("{expression}", "猫")
          .replaceAll("{capture-animation}", message.request.captureUnavailable?.includes("animation")
            ? "" : `<img src="${message.request.capturePin?.animationFilename || ""}">`)
          .replaceAll("{capture-audio}", message.request.captureUnavailable?.includes("audio")
            ? "" : `[sound:${message.request.capturePin?.audioFilename || ""}]`)])),
      media: [],
    }),
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
  return { service, calls, captureCalls, request, stop() { captureAvailable = false; }, get fields() { return fields; } };
}

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
  let refuse = false, duplicate = false;
  const notes = new Map();
  let fields = null;
  const options = globalThis.HDReaderOptions.normaliseOptions({ anki: { model: "Basic", deck: "Default", apiKey: "local-key",
    fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
      Audio: { value: "{screenshot}", overwriteMode: "overwrite" } } } });
  const gateway = { discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Audio"],
    models: ["Basic"], decks: ["Default"], errors: [] }),
    async invoke(action, params, apiKey) {
      if (action === "canAddNotesWithErrorDetail") return [{ canAdd: true }];
      if (action === "deleteMediaFile") { deletions.push(params.filename); return null; }
      if (action === "addNote") {
        if (duplicate) throw new Error("cannot create note because it is a duplicate");
        fields = params.note.fields;
        notes.set(12, fields);
        return 12;
      }
      if (action === "notesInfo") return [{ noteId: 12, fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
      if (action !== "storeMediaFile") throw new Error(`Unexpected ${action}`);
      uploads.push({ ...params, apiKey });
      if (refuse) throw new Error("media folder is read-only");
      return params.filename;
    } };
  const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
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

  // The capture itself refuses when the switch is off or the page gives nothing.
  await assert.rejects(service.screenshot(async () => "not-an-image"), /no screenshot/u);
  await assert.rejects(service.screenshot(async () => { throw new Error("The reading tab is no longer the active tab."); }),
    /no longer the active tab/u);
  options.anki.captureScreenshot = false;
  await assert.rejects(service.screenshot(async () => "data:image/jpeg;base64,c2hvdA=="), /turned off in Settings/u);
});

test("pronunciation enrichment keeps a failed or replaced screenshot unavailable", async t => {
  for (const outcome of ["stored", "replaced", "refused"]) await t.test(outcome, async () => {
    let fields;
    const options = globalThis.HDReaderOptions.normaliseOptions({ anki: { model: "Basic",
      fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
        Back: { value: "{screenshot}{audio}", overwriteMode: "overwrite" } } } });
    const gateway = { discover: async () => ({ connected: true, model: "Basic", fields: ["Front", "Back"],
      models: ["Basic"], decks: ["Default"], errors: [] }), async invoke(action, params) {
      if (action === "canAddNotesWithErrorDetail") return [{ canAdd: true }];
      if (action === "storeMediaFile") {
        if (outcome === "refused" && params.filename.startsWith("hachidori-screenshot-")) {
          throw new Error("Screenshot upload acknowledgement lost");
        }
        return params.filename;
      }
      if (action === "deleteMediaFile") return null;
      if (action === "addNote") { fields = { ...params.note.fields }; return 12; }
      if (action === "notesInfo") return [{ noteId: 12,
        fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])) }];
      if (action === "updateNoteFields") { Object.assign(fields, params.note.fields); return null; }
      throw new Error(`Unexpected ${action}`);
    } };
    const service = createAnkiWorkerService({ gateway, readOptions: async () => options,
      readDictionaries: async () => [], engine: async () => ({ generation: 3, ready: true, loading: false }),
      offscreen: async message => message.type === "hd_anki_audio" ? { filename: "checked.wav", data: "YXVkaW8=" }
        : { fields: await buildAnkiFields(message.request, message.templates, { audio: message.audio }), media: [] },
    });
    const screenshot = await service.screenshot(async () => "data:image/jpeg;base64,c2hvdA==");
    if (outcome === "replaced") await service.screenshot(async () => "data:image/jpeg;base64,bmV3");
    const result = await service.submit({ term: { expression: "猫", reading: "ねこ" }, generation: 3,
      configKey: (await service.status()).configKey, screenshot, captureUnavailable: ["animation"] });
    assert.equal(result.state, "added");
    assert.equal(fields.Back, `${outcome === "stored" ? `<img src="${screenshot.filename}">` : ""}[sound:checked.wav]`);
    if (outcome === "stored") assert.deepEqual(result.warnings, []);
    else assert.match(result.warnings.join(" "), /Screenshot: /u);
  });
});
