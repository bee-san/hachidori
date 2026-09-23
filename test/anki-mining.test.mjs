// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiMiningService, verifyAnkiFields } from "../extension/anki-mining.js";
import { AnkiTransportError, createAnkiGateway } from "../extension/anki.js";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";

function testIndex(resolve = async () => []) {
  const find = async (config, expression, invoke, cached = false) => {
    const value = await resolve(config, expression, invoke);
    const result = Array.isArray(value) ? { noteIds: value } : value;
    return {
      wordKey: expression,
      mature: result?.mature === true,
      noteIds: [...new Set(result?.noteIds ?? [])].sort((left, right) => left - right),
      cached: cached && (result?.noteIds ?? []).length > 0,
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
    peek: (config, expression) => find(config, expression, null, true),
    lookup: find,
    repair: find,
    async recordWrite() {},
    async has() { return false; },
  };
}

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
    duplicateIndex: testIndex(() => exists ? [123] : []),
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

test("View readiness uses only the canonical cache and a live preflight repairs a positive miss", async () => {
  const config = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
    fields: { ...globalThis.HDReaderOptions.normaliseOptions({}).anki.fields, expression: "Front" } };
  let cachedIds = [], liveLookups = 0, discoveries = 0;
  const duplicateIndex = {
    source: async () => ({ key: "test", model: "Basic", fields: ["front"] }),
    async peek(configValue, expression) {
      return { wordKey: expression, mature: false, noteIds: [...cachedIds], cached: cachedIds.length > 0 };
    },
    async lookup(configValue, expression) {
      liveLookups++;
      cachedIds = [42, 73];
      return { wordKey: expression, mature: false, noteIds: [...cachedIds], cached: false };
    },
    async repair(configValue, expression) {
      return this.lookup(configValue, expression);
    },
    async recordWrite() {},
  };
  const service = createAnkiMiningService({
    gateway: {
      async discover() {
        discoveries++;
        return { connected: true, model: "Basic", models: ["Basic"], decks: ["Default"],
          fields: ["Front", "Back"], errors: [] };
      },
      async invoke(action) { throw new Error(`Unexpected Anki request: ${action}`); },
    },
    readConfig: async () => config,
    duplicateIndex,
    buildFields: async request => ({ fields: { Front: request.term.expression, Back: "cat" } }),
  });
  const request = { term: { expression: "猫", reading: "" } };
  const cold = await service.view(request);
  assert.deepEqual(cold.noteIds, []);
  assert.equal(cold.cached, false);
  assert.equal(discoveries, 0);
  assert.equal(liveLookups, 0, "a cache miss remains unknown");

  const status = await service.status();
  const repaired = await service.preflight({ ...request, configKey: status.configKey });
  assert.deepEqual(repaired.noteIds, [42, 73]);
  assert.equal(liveLookups, 1);

  const warm = await service.view(request);
  assert.deepEqual(warm.noteIds, [42, 73]);
  assert.equal(warm.cached, true);
  assert.equal(warm.state, "duplicate");
  assert.equal(liveLookups, 1, "the repaired warm hit makes zero Anki lookups");
  assert.equal(discoveries, 1, "cache-only readiness does not repeat model discovery");
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
    return { ok: true, json: async () => answerAnkiConnect(request, (action, params) => {
      switch (action) {
        case "deckNames": return ["Default"];
        case "modelNames": return ["Basic"];
        case "modelFieldNames": return ["Front", "Back"];
        case "canAddNotesWithErrorDetail": return [{ canAdd: true }];
        case "storeMediaFile": return params.filename;
        case "addNote": fields = params.note.fields; return 27;
        case "notesInfo": return [{ noteId: 27, fields: Object.fromEntries(Object.entries(fields)
          .map(([field, value]) => [field, { value }])) }];
        case "updateNoteFields": fields = { ...fields, ...params.note.fields }; return null;
        case "guiBrowse": return [];
        default: throw new Error(`Unexpected action: ${action}`);
      }
    }) };
  } });
  const service = createAnkiMiningService({ gateway, readConfig: async () => config,
    duplicateIndex: testIndex(),
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
  await service.browse({ configKey: current.configKey, noteIds: [27] });
  const currentRequests = requests.slice(boundary);
  assert.ok(currentRequests.every(value => value.url === config.url && value.key === config.apiKey));
  for (const action of ["canAddNotesWithErrorDetail", "storeMediaFile", "addNote", "notesInfo", "updateNoteFields", "guiBrowse"]) {
    assert.ok(currentRequests.some(request => request.action === action), `${action} uses the new endpoint`);
  }
  assert.equal(currentRequests.find(request => request.action === "guiBrowse").params.query, "nid:27");
  config = { ...config, deck: "Changed" };
  const staleBrowseBoundary = requests.length;
  await assert.rejects(
    service.browse({ configKey: current.configKey, noteIds: [27], expression: "猫" }),
    /configuration changed/u,
  );
  assert.equal(requests.length, staleBrowseBoundary, "stale browsing never reaches AnkiConnect");
});

test("View in Anki repairs cached IDs before opening the exact live notes", async () => {
  const config = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
    fields: { ...globalThis.HDReaderOptions.normaliseOptions({}).anki.fields, expression: "Front" } };
  const calls = [];
  const service = createAnkiMiningService({
    gateway: { async invoke(action, params, apiKey, timeoutMs) {
      calls.push({ action, params });
      assert.equal(action, "guiBrowse");
      assert.equal(timeoutMs, 30_000, "opening Anki's browser gets time to finish before timing out");
      return [];
    } },
    readConfig: async () => config,
    duplicateIndex: testIndex(() => [8, 9]),
  });
  assert.deepEqual(await service.browse({ expression: "猫", noteIds: [7, 8] }), {
    opened: true,
    noteIds: [8, 9],
    repaired: true,
  });
  assert.deepEqual(calls, [{ action: "guiBrowse", params: { query: "nid:8,9" } }]);
});

test("View in Anki removes a stale positive row without opening an unrelated search", async () => {
  const config = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
    fields: { ...globalThis.HDReaderOptions.normaliseOptions({}).anki.fields, expression: "Front" } };
  let requests = 0;
  const service = createAnkiMiningService({
    gateway: { async invoke() { requests++; throw new Error("stale removal must not browse"); } },
    readConfig: async () => config,
    duplicateIndex: testIndex(() => []),
  });
  assert.deepEqual(await service.browse({ expression: "猫", noteIds: [7, 8] }), {
    opened: false,
    noteIds: [],
    repaired: true,
  });
  assert.equal(requests, 0);
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
  assert.equal(f.calls.filter(action => action === "canAddNotesWithErrorDetail").length, 2);
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

test("a field rewritten during the add warns but only a rewritten first field skips pronunciation enrichment", async () => {
  // AJT Japanese fills furigana on note_will_be_added, so the readback of an
  // unrelated field differs while the note is exactly the one Hachidori added.
  async function rewriteOnAdd(field) {
    const f = fixture();
    const invoke = f.gateway.invoke;
    f.gateway.invoke = async (action, params) => {
      if (action !== "addNote") return invoke(action, params);
      return invoke(action, { note: { ...params.note, fields: { ...params.note.fields, [field]: "rewritten by add-on" } } });
    };
    let enrichments = 0;
    const service = createAnkiMiningService({ ...f.dependencies, enrich: async () => { enrichments++; return []; } });
    const { configKey } = await service.status();
    const result = await service.submit({ expression: "猫", configKey });
    assert.equal(result.state, "added");
    assert.equal(result.noteId, 123);
    assert.match(result.warnings.join(" "), new RegExp(`field “${field}” was saved with different content`, "u"));
    return enrichments;
  }
  assert.equal(await rewriteOnAdd("Back"), 1, "an unrelated field an add-on rewrote must not withhold the pronunciation");
  assert.equal(await rewriteOnAdd("Front"), 0, "a first field Anki did not save as submitted is not enriched");
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
  assert.match(result.error, /Check Anki/u);
  assert.equal(writes, 1);
});

test("mining releases a queued unsent mutation but keeps a dispatched transport failure uncertain", async t => {
  for (const dispatched of [false, true]) await t.test(dispatched ? "dispatched" : "queued", async () => {
    const config = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
      fieldTemplates: {
        Front: { value: "{expression}", overwriteMode: "overwrite" },
        Back: { value: "{definition}", overwriteMode: "overwrite" },
      } };
    const actions = [];
    let blockers = [];
    const transport = createAnkiGateway({ fetch: async (_, options) => {
      const { action } = JSON.parse(options.body);
      actions.push(action);
      if (action === "canAddNotesWithErrorDetail") {
        return { ok: true, async json() { return { result: [{ canAdd: true, error: null }], error: null }; } };
      }
      if (action.startsWith("block-")) {
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      if (action === "addNote") throw new TypeError("connection reset after dispatch");
      assert.fail(`Unexpected ${action}`);
    } });
    const gateway = {
      async discover() {
        return { connected: true, model: "Basic", models: ["Basic"], decks: ["Default"],
          fields: ["Front", "Back"], errors: [] };
      },
      invoke: transport.invoke,
    };
    const released = [];
    const service = createAnkiMiningService({
      gateway,
      readConfig: async () => config,
      duplicateIndex: testIndex(),
      buildFields: async () => ({ fields: { Front: "猫", Back: "cat" } }),
      beforeWrite: async () => ({ owned: "request-media" }),
      beforeMutation: async () => {
        if (dispatched) return;
        blockers = Array.from({ length: 4 }, (_, index) =>
          transport.invoke(`block-${index}`, {}, "", index === 0 ? 10 : 1000, config.url).catch(error => error));
      },
      afterRejected: async ({ writeResources }) => { released.push(writeResources.owned); },
      enrich: async () => [],
    });
    const { configKey } = await service.status();
    const operation = service.submit({ expression: "猫", configKey });
    if (dispatched) {
      const result = await operation;
      assert.equal(result.state, "uncertain");
      assert.match(result.error, /Check Anki/u);
      assert.deepEqual(released, [], "a dispatched mutation may have written and must retain its resources");
      assert.equal(actions.filter(action => action === "addNote").length, 1);
    } else {
      await assert.rejects(operation, error =>
        error instanceof AnkiTransportError && error.dispatched === false && /timed out/u.test(error.message));
      assert.deepEqual(released, ["request-media"], "an unsent mutation has a definitive cleanup path");
      assert.equal(actions.includes("addNote"), false, "the rejected queued mutation never entered fetch");
      const blockerErrors = await Promise.all(blockers);
      assert.ok(blockerErrors.every(error => error instanceof AnkiTransportError && error.dispatched === true),
        "active sibling aborts remain outcome-uncertain");
    }
  });
});

test("overwrite mutations use the same pending-versus-dispatched failure boundary", async t => {
  for (const dispatched of [false, true]) await t.test(dispatched ? "dispatched" : "queued", async () => {
    const config = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
      duplicateBehavior: "overwrite",
      fieldTemplates: {
        Front: { value: "{expression}", overwriteMode: "overwrite" },
        Back: { value: "{definition}", overwriteMode: "overwrite" },
      } };
    const calls = [];
    const gateway = {
      async discover() {
        return { connected: true, model: "Basic", models: ["Basic"], decks: ["Default"],
          fields: ["Front", "Back"], errors: [] };
      },
      async invoke(action) {
        calls.push(action);
        if (action === "notesInfo") return [{ noteId: 123, modelName: "Basic",
          fields: { Front: { value: "猫" }, Back: { value: "old" } } }];
        if (action === "updateNoteFields") {
          throw new AnkiTransportError("update transport failed", { dispatched });
        }
        assert.fail(`Unexpected ${action}`);
      },
    };
    let releases = 0;
    const service = createAnkiMiningService({
      gateway,
      readConfig: async () => config,
      duplicateIndex: testIndex(() => [123]),
      buildFields: async () => ({ fields: { Front: "猫", Back: "cat" } }),
      beforeWrite: async () => ({ owned: true }),
      afterRejected: async () => { releases++; },
      enrich: async () => [],
    });
    const { configKey } = await service.status();
    const operation = service.submit({ expression: "猫", configKey });
    if (dispatched) {
      assert.equal((await operation).state, "uncertain");
      assert.equal(releases, 0);
    } else {
      await assert.rejects(operation, error =>
        error instanceof AnkiTransportError && error.dispatched === false);
      assert.equal(releases, 1);
    }
    assert.equal(calls.filter(action => action === "updateNoteFields").length, 1);
  });
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
    f.change({ duplicateBehavior: "overwrite", duplicateScope: "model", fieldTemplates: {
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
      duplicateIndex: testIndex(() => targetPresent ? [42] : []),
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
    duplicateIndex: testIndex(() => [123]),
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

test("each Template has an independent configuration identity and routes its note to the selected destination", async () => {
  const base = globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE;
  const configs = new Map([
    ["word", { ...base, url: "https://anki.example.test", apiKey: "key", model: "Word", deck: "Words",
      fields: { ...base.fields, expression: "Front" } }],
    ["sentence", { ...base, url: "https://anki.example.test", apiKey: "key", model: "Sentence", deck: "Sentences",
      fields: { ...base.fields, expression: "Front" } }],
  ]);
  const writes = [];
  let nextNoteId = 40;
  const saved = new Map();
  const gateway = {
    async discover(config) { return { connected: true, model: config.model, models: [config.model],
      decks: [config.deck], fields: ["Front"], errors: [] }; },
    async invoke(action, params) {
      if (action === "canAddNotesWithErrorDetail") return [{ canAdd: true, error: null }];
      if (action === "addNote") {
        const noteId = ++nextNoteId;
        writes.push({ noteId, deck: params.note.deckName, model: params.note.modelName, fields: params.note.fields });
        saved.set(noteId, params.note);
        return noteId;
      }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId,
        modelName: saved.get(noteId).modelName, cards: [], fields: Object.fromEntries(
          Object.entries(saved.get(noteId).fields).map(([field, value]) => [field, { value }])) }));
      throw new Error(`Unexpected ${action}`);
    },
  };
  const service = createAnkiMiningService({ gateway,
    readConfig: async templateId => configs.get(templateId) ?? null,
    duplicateIndex: testIndex(),
    buildFields: async request => ({ fields: { Front: request.term.expression } }),
    beforeWrite: async () => {}, enrich: async () => [],
  });
  const word = await service.status("word");
  const sentence = await service.status("sentence");
  assert.notEqual(word.configKey, sentence.configKey);
  assert.equal((await service.submit({ templateId: "word", configKey: word.configKey,
    term: { expression: "猫", reading: "ねこ" } })).state, "added");
  assert.equal((await service.submit({ templateId: "sentence", configKey: sentence.configKey,
    term: { expression: "猫がいる", reading: "ねこがいる" } })).state, "added");
  assert.deepEqual(writes.map(({ deck, model, fields }) => ({ deck, model, fields })), [
    { deck: "Words", model: "Word", fields: { Front: "猫" } },
    { deck: "Sentences", model: "Sentence", fields: { Front: "猫がいる" } },
  ]);
  configs.set("sentence", { ...configs.get("sentence"), deck: "Changed" });
  await assert.rejects(service.submit({ templateId: "sentence", configKey: sentence.configKey,
    term: { expression: "古い", reading: "ふるい" } }), /configuration changed/u);
  await assert.rejects(service.status("deleted"), /no longer available/u);
});

test("an empty first field names the note type, field, template and looked-up word", async () => {
  const f = fixture();
  const { configKey } = await f.service.status();
  await assert.rejects(f.service.submit({ expression: "  ", configKey }),
    /^Error: The first field of note type “Basic”, “Front”, is empty for this result: its template \{expression\} produced nothing for this result\. Anki requires it\.$/u);
  await assert.rejects(f.service.submit({ expression: "", term: { expression: "猫" }, configKey }),
    /produced nothing for “猫”\. Anki requires it\.$/u);
});

test("write-time refusals name the deck, note type and first field", async () => {
  const f = fixture();
  const invoke = f.gateway.invoke;
  let refusal = "cannot create note because it is a duplicate";
  f.gateway.invoke = async (action, params) => {
    if (action === "addNote") throw new Error(`AnkiConnect: ${refusal}`);
    return invoke(action, params);
  };
  const { configKey } = await f.service.status();
  const duplicate = await f.service.submit({ expression: "猫", configKey });
  assert.equal(duplicate.state, "duplicate");
  assert.equal(duplicate.error, "Anki already has a note in deck “Default” (note type “Basic”) whose first field “Front” is “猫”.");
  refusal = "cannot create note because it is empty";
  const empty = await f.service.submit({ expression: "<br>", configKey });
  assert.equal(empty.state, "uncertain");
  assert.match(empty.error, /Anki refused the note for deck “Default”, note type “Basic” because its first field “Front” is empty once Anki stripped its formatting\. \(AnkiConnect: cannot create note because it is empty\)$/u);
});

test("saved-field verification names the fields Anki lost or changed", async () => {
  const notes = { Front: "猫", Back: "dog" };
  const invoke = async () => [{ noteId: 5, fields: Object.fromEntries(Object.entries(notes).map(([field, value]) => [field, { value }])) }];
  await assert.rejects(verifyAnkiFields(invoke, 5, { Front: "猫", Back: "cat", Extra: "x" }),
    /^Error: Anki's saved note differs from the submitted values: field “Extra” is missing from note 5; field “Back” was saved with different content\. Inspect note 5 in Anki\.$/u);
  await assert.doesNotReject(verifyAnkiFields(invoke, 5, { Front: "猫" }));
});
