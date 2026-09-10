// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiMiningService } from "../extension/anki-mining.js";
import { createAnkiGateway } from "../extension/anki.js";

function fixture() {
  let config = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
    fields: { ...globalThis.HDReaderOptions.normaliseOptions({}).anki.fields, expression: "Front", definition: "Back" } };
  let exists = false, discovers = 0;
  const calls = [];
  const notes = new Map();
  const gateway = {
    async discover() { discovers++; return { connected: true, model: "Basic", models: ["Basic"], decks: ["Default"], fields: ["Front", "Back"], errors: [] }; },
    async invoke(action, params) {
      calls.push(action);
      if (action === "canAddNotesWithErrorDetail") return [{ canAdd: !exists, error: exists ? "cannot create note because it is a duplicate" : null }];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "findNotes") return exists ? [123] : [];
      if (action === "addNote") { exists = true; notes.set(123, params.note.fields); return 123; }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(notes.get(noteId)).map(([field, value]) => [field, { value }])) }));
      throw new Error(`Unexpected ${action}`);
    },
  };
  const dependencies = { gateway, readConfig: async () => config,
    buildFields: async request => ({ fields: { Front: request.expression, Back: "cat" } }), beforeWrite: async () => {}, enrich: async () => [] };
  const service = createAnkiMiningService(dependencies);
  return { service, gateway, calls, dependencies, get discovers() { return discovers; },
    config: () => config, change(patch) { config = { ...config, ...patch }; } };
}

test("mining readiness shares its short source-backed cache and skips Anki when no model is configured", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.status(), f.service.status()]);
  assert.equal(a.available, true);
  assert.equal(a.configKey, b.configKey);
  assert.match(a.configKey, /^[0-9a-f]{64}$/u, "reader correlation does not expose the saved configuration or API key");
  assert.equal(f.discovers, 1);
  f.change({ model: "" });
  assert.equal((await f.service.status()).available, false);
  assert.equal(f.discovers, 1);
});

test("endpoint changes invalidate mining readiness and bind duplicates, media, writes, enrichment and browsing to one endpoint", async () => {
  let config = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki,
    url: "https://first.example/anki", apiKey: "profile-key", model: "Basic",
    fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
      Back: { value: "{definition}", overwriteMode: "overwrite" } } };
  const requests = [];
  let fields;
  const gateway = createAnkiGateway({ fetch: async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, ...request });
    let result;
    switch (request.action) {
      case "deckNames": result = ["Default"]; break;
      case "modelNames": result = ["Basic"]; break;
      case "modelFieldNames": result = ["Front", "Back"]; break;
      case "canAddNotesWithErrorDetail": result = [{ canAdd: true }]; break;
      case "storeMediaFile": result = request.params.filename; break;
      case "addNote": fields = request.params.note.fields; result = 27; break;
      case "notesInfo": result = [{ noteId: 27, fields: Object.fromEntries(Object.entries(fields)
        .map(([field, value]) => [field, { value }])) }]; break;
      case "updateNoteFields": fields = { ...fields, ...request.params.note.fields }; result = null; break;
      case "guiBrowse": result = []; break;
      default: throw new Error(`Unexpected action: ${request.action}`);
    }
    return { ok: true, json: async () => ({ result, error: null }) };
  } });
  const service = createAnkiMiningService({ gateway, readConfig: async () => config,
    buildFields: async () => ({ fields: { Front: "猫", Back: "cat" } }),
    beforeWrite: async ({ invoke }) => {
      await invoke("storeMediaFile", { filename: "capture.wav", data: "YQ==" }, 30_000);
    },
    enrich: async ({ invoke, noteId }) => {
      await invoke("updateNoteFields", { note: { id: noteId, fields: { Back: "cat[sound:capture.wav]" } } });
      return [];
    },
  });
  const previous = await service.status();
  assert.ok(requests.every(request => request.url === "https://first.example/anki"));
  config = { ...config, url: "https://second.example/anki" };
  const boundary = requests.length;
  const current = await service.status();
  assert.notEqual(current.configKey, previous.configKey);
  await assert.rejects(service.submit({ configKey: previous.configKey }), /configuration changed/u);
  assert.equal(requests.some(request => request.action === "addNote"), false);
  const request = { configKey: current.configKey };
  assert.equal((await service.preflight(request)).canAdd, true);
  assert.equal((await service.submit(request)).state, "added");
  await service.browse({ noteIds: [27], expression: "猫" });
  const currentRequests = requests.slice(boundary);
  assert.ok(currentRequests.every(value => value.url === config.url && value.key === config.apiKey));
  for (const action of ["canAddNotesWithErrorDetail", "storeMediaFile", "addNote", "notesInfo", "updateNoteFields", "guiBrowse"]) {
    assert.ok(currentRequests.some(request => request.action === action), `${action} uses the new endpoint`);
  }
  assert.equal(currentRequests.find(request => request.action === "guiBrowse").params.query, "nid:27");
});

test("submissions recheck inside one queue so stale cross-tab preflight cannot add a second prevented note", async () => {
  const f = fixture();
  const { configKey } = await f.service.status();
  const request = { expression: "猫", configKey };
  assert.equal((await f.service.preflight(request)).canAdd, true);
  const [first, second] = await Promise.all([f.service.submit(request), f.service.submit(request)]);
  assert.equal(first.state, "added");
  assert.equal(first.noteId, 123);
  assert.equal(second.state, "duplicate");
  assert.deepEqual(second.noteIds, [123]);
  assert.equal(f.calls.filter(action => action === "addNote").length, 1);
  assert.equal(f.calls.filter(action => action === "canAddNotesWithErrorDetail").length, 3);
  assert.equal(f.discovers, 3, "each mutation refreshes authoritative model fields");
});

test("a committed note with failed readback skips enrichment and stale configuration never reaches mutation", async () => {
  const f = fixture();
  const { configKey } = await f.service.status();
  f.change({ tags: ["changed"] });
  await assert.rejects(f.service.submit({ expression: "猫", configKey }), /configuration changed/u);
  assert.equal(f.calls.includes("addNote"), false);
  const invoke = f.gateway.invoke;
  f.gateway.invoke = async (action, params) => {
    if (action === "notesInfo") throw new Error("readback offline");
    return invoke(action, params);
  };
  let enrichments = 0;
  const service = createAnkiMiningService({ ...f.dependencies, enrich: async () => { enrichments++; return []; } });
  const status = await service.status();
  const result = await service.submit({ expression: "猫", configKey: status.configKey });
  assert.equal(result.state, "added");
  assert.equal(result.noteId, 123);
  assert.match(result.warnings.join(" "), /readback offline/u);
  assert.equal(enrichments, 0, "do not enrich from fields whose committed values could not be verified");
  assert.equal(f.calls.filter(action => action === "addNote").length, 1);
});

test("enrichment failure cannot turn a verified textual add into a duplicate-inviting failed submission", async () => {
  const f = fixture();
  const service = createAnkiMiningService({ ...f.dependencies, enrich: async () => { throw new Error("audio unavailable"); } });
  const { configKey } = await service.status();
  const result = await service.submit({ expression: "猫", configKey });
  assert.equal(result.state, "added");
  assert.equal(result.noteId, 123);
  assert.deepEqual(result.warnings, ["audio unavailable"]);
  assert.equal(f.calls.filter(action => action === "addNote").length, 1);
});

test("an ambiguous mutation failure is not retried or reported as a confirmed failed add", async () => {
  const f = fixture();
  const invoke = f.gateway.invoke;
  let writes = 0;
  f.gateway.invoke = async (action, params) => {
    if (action === "addNote") { writes++; throw new Error("connection lost after send"); }
    return invoke(action, params);
  };
  const { configKey } = await f.service.status();
  const result = await f.service.submit({ expression: "猫", configKey });
  assert.equal(result.state, "uncertain");
  assert.match(result.error, /View in Anki/u);
  assert.equal(writes, 1);
});

test("overwrite mode still prevents an external duplicate created after preflight found no target", async () => {
  const f = fixture();
  f.change({ duplicateBehavior: "overwrite" });
  const invoke = f.gateway.invoke;
  f.gateway.invoke = async (action, params) => {
    if (action === "addNote") {
      assert.equal(params.note.options.allowDuplicate, false);
      throw new Error("cannot create note because it is a duplicate");
    }
    return invoke(action, params);
  };
  const { configKey } = await f.service.status();
  assert.equal((await f.service.submit({ expression: "猫", configKey })).state, "duplicate");
});

test("the screenshot requirement follows the configured mapping and the Settings switch", async () => {
  const f = fixture();
  const term = { expression: "猫", reading: "" };
  const preflight = async () => {
    const { configKey } = await f.service.status();
    return f.service.preflight({ term, expression: "猫", generation: 3, configKey });
  };
  // Nothing maps {screenshot}: the reader is not asked to take one.
  assert.equal((await preflight()).screenshot, false);

  const templates = { Front: { value: "{expression}", overwriteMode: "overwrite" },
    Back: { value: "{screenshot}", overwriteMode: "overwrite" } };
  f.change({ fieldTemplates: templates });
  f.dependencies.buildFields = async () => ({ fields: { Front: "猫", Back: "" }, templates });
  assert.equal((await preflight()).screenshot, true);

  // The switch is the user's, so a mapped screenshot they turned off is not taken.
  f.change({ captureScreenshot: false });
  assert.equal((await preflight()).screenshot, false);
});

test("a coalesced screenshot remains prepared when the overwrite target disappears before writing", async () => {
  for (const unavailable of [false, true]) {
    const f = fixture();
    f.change({ duplicateBehavior: "overwrite", duplicateScope: "collection", fieldTemplates: {
      Front: { value: "{expression}", overwriteMode: "overwrite" },
      Back: { value: "{screenshot}", overwriteMode: "coalesce" },
    } });
    let targetPresent = true, preparations = 0, saved;
    const invoke = f.gateway.invoke;
    f.gateway.invoke = async (action, params) => {
      if (action === "canAddNotesWithErrorDetail" && targetPresent) {
        return [{ canAdd: false, error: "cannot create note because it is a duplicate" }];
      }
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "findNotes") return [42];
      if (action === "notesInfo" && targetPresent) return [{ noteId: 42, modelName: "Basic",
        fields: { Front: { value: "猫" }, Back: { value: '<img src="existing.jpg">' } } }];
      if (action === "addNote") saved = params.note.fields;
      return invoke(action, params);
    };
    const service = createAnkiMiningService({ ...f.dependencies,
      buildFields: async request => ({ fields: { Front: "猫", Back: request.screenshot
        ? `<img src="${request.screenshot.filename}">` : "" } }),
      beforeWrite: async () => { preparations++; } });
    const { configKey } = await service.status();
    const request = { expression: "猫", configKey };
    assert.equal((await service.preflight(request)).screenshot, true);
    assert.equal(preparations, 0, "preflight must not upload media");
    assert.equal(f.calls.includes("addNote"), false);
    targetPresent = false;
    const attempted = unavailable ? { captureUnavailable: ["screenshot"] }
      : { screenshot: { token: "picture", filename: "picture.jpg" } };
    assert.equal((await service.submit({ ...request, ...attempted })).state, "added");
    assert.equal(preparations, 1, "a captured or explicitly unavailable picture permits the write");
    assert.equal(saved.Back, unavailable ? "" : '<img src="picture.jpg">');
  }
});

test("overwrite leaves preserved fields out of the mutation when Anki changes during preparation", async () => {
  const f = fixture();
  const fieldTemplates = {
    Front: { value: "{expression}", overwriteMode: "coalesce" },
    Keep: { value: "incoming", overwriteMode: "skip" },
    Fill: { value: "incoming", overwriteMode: "coalesce" },
    Fallback: { value: "", overwriteMode: "coalesce-new" },
    Back: { value: "cat", overwriteMode: "overwrite" },
  };
  f.change({ duplicateBehavior: "overwrite", fieldTemplates });
  f.gateway.discover = async () => ({ connected: true, model: "Basic", models: ["Basic"], decks: ["Default"],
    fields: Object.keys(fieldTemplates), errors: [] });
  let fields = { Front: "猫", Keep: "old keep", Fill: "old fill", Fallback: "old fallback", Back: "old definition" };
  const updates = [];
  f.gateway.invoke = async (action, params) => {
    if (action === "canAddNotesWithErrorDetail") return [{ canAdd: false, error: "cannot create note because it is a duplicate" }];
    if (action === "modelNamesAndIds") return { Basic: 1 };
    if (action === "findNotes") return [123];
    if (action === "notesInfo") return [{ noteId: 123, modelName: "Basic", fields: Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [field, { value }]),
    ) }];
    if (action === "updateNoteFields") { updates.push(params.note.fields); Object.assign(fields, params.note.fields); return null; }
    assert.fail(`Unexpected ${action}`);
  };
  const service = createAnkiMiningService({ ...f.dependencies,
    buildFields: async () => ({ fields: { Front: "猫", Keep: "incoming", Fill: "incoming", Fallback: "", Back: "cat" } }),
    beforeWrite: async () => {
      // Anki stays editable while Hachidori prepares media for the write.
      Object.assign(fields, { Keep: "edited keep", Fill: "edited fill", Fallback: "edited fallback" });
    },
  });
  const { configKey } = await service.status();
  const result = await service.submit({ expression: "猫", configKey });
  assert.equal(result.state, "updated");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(updates, [{ Back: "cat" }]);
  assert.deepEqual(fields, { Front: "猫", Keep: "edited keep", Fill: "edited fill", Fallback: "edited fallback", Back: "cat" });
});
