// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiMiningService } from "../extension/anki-mining.js";

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
      if (action === "addNote") { exists = true; notes.set(123, params.note.fields); return 123; }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId,
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

test("submissions recheck inside one queue so stale cross-tab preflight cannot add a second prevented note", async () => {
  const f = fixture();
  const { configKey } = await f.service.status();
  const request = { expression: "猫", configKey };
  assert.equal((await f.service.preflight(request)).canAdd, true);
  const [first, second] = await Promise.all([f.service.submit(request), f.service.submit(request)]);
  assert.equal(first.state, "added");
  assert.equal(first.noteId, 123);
  assert.equal(second.state, "duplicate");
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

test("the screenshot requirement follows the applied mapping and the Settings switch", async () => {
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

  // The whole configured mapping decides, not the subset this preflight applies:
  // the authoritative decision inside the write may apply that field after all.
  f.dependencies.buildFields = async () => ({ fields: { Front: "猫", Back: "" },
    templates: { Front: { value: "{expression}", overwriteMode: "overwrite" } } });
  assert.equal((await preflight()).screenshot, true);

  // The switch is the user's, so a mapped screenshot they turned off is not taken.
  f.change({ captureScreenshot: false });
  assert.equal((await preflight()).screenshot, false);
});
