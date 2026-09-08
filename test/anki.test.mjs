// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiGateway, ankiAvailability } from "../extension/anki.js";

const { normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
const config = (patch = {}) => ({ ...normaliseOptions({}).anki, ...patch });
const reply = result => ({ ok: true, async json() { return { result, error: null }; } });

test("global Anki configuration validates complete mappings and duplicate policies without input caps", () => {
  const defaults = config();
  assert.equal(defaults.deck, "Default");
  assert.equal(defaults.model, "");
  assert.equal(defaults.checkForDuplicates, true);
  const value = config({ model: "日本語", tags: Array.from({ length: 300 }, (_, i) => `tag${i}`),
    fields: { ...defaults.fields, expression: "日本語".repeat(300) }, duplicateScope: "deck-root", duplicateBehavior: "new" });
  assert.deepEqual(validateOptionsPatch({ anki: value }), { anki: value });
  assert.deepEqual(normaliseOptions({ anki: value }).anki, value);
  for (const bad of [null, [], { ...value, model: 42 }, { ...value, fields: {} },
    { ...value, tags: [false] }, { ...value, duplicateScope: "profile" }, { ...value, checkForDuplicates: "yes" }]) {
    assert.throws(() => validateOptionsPatch({ anki: bad }));
  }
});

test("Anki discovery fixes the endpoint and envelope, reads independent lists concurrently and retains field order", async () => {
  const requests = [];
  const gateway = createAnkiGateway({ fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    return reply({ deckNames: ["Default", "日本語", "Default"], modelNames: ["Basic"],
      modelFieldNames: ["Front", "Back"] }[body.action]);
  } });
  const result = await gateway.discover({ model: "Basic", apiKey: "local-key" });
  assert.deepEqual(result, { connected: true, model: "Basic", decks: ["Default", "日本語"],
    models: ["Basic"], fields: ["Front", "Back"], errors: [] });
  assert.deepEqual(requests.map(r => r.body.action), ["deckNames", "modelNames", "modelFieldNames"]);
  for (const { url, options, body } of requests) {
    assert.equal(url, "http://127.0.0.1:8765");
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(body.version, 6);
    assert.equal(body.key, "local-key");
  }
  assert.deepEqual(requests[2].body.params, { modelName: "Basic" });
});

test("discovery distinguishes partial, malformed, permission and offline failures and retries afresh", async () => {
  let mode = "partial";
  const gateway = createAnkiGateway({ fetch: async (_, options) => {
    const { action } = JSON.parse(options.body);
    if (mode === "offline") throw new TypeError("Failed to fetch");
    if (mode === "permission") return { ok: false, status: 403 };
    if (mode === "malformed") return { ok: true, async json() { return { result: [] }; } };
    if (mode === "partial" && action === "deckNames") return reply([12]);
    return reply(action === "modelNames" ? ["Basic"] : action === "modelFieldNames" ? ["Front"] : ["Default"]);
  } });
  const partial = await gateway.discover({ model: "Basic" });
  assert.equal(partial.connected, true);
  assert.deepEqual(partial.fields, ["Front"]);
  assert.equal(partial.errors.length, 1);
  for (const [next, pattern] of [["offline", /Open Anki/u], ["permission", /permission/u], ["malformed", /invalid response/u]]) {
    mode = next;
    const result = await gateway.discover({ model: "Basic" });
    assert.equal(result.connected, false);
    assert.match(result.errors.join(" "), pattern);
    assert.deepEqual(result.fields, []);
  }
  mode = "success";
  assert.equal((await gateway.discover({ model: "Basic" })).errors.length, 0);
});

test("Anki discovery timeouts abort the fetch and API errors are not mislabeled offline", async () => {
  const gateway = createAnkiGateway({ timeoutMs: 5, fetch: (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  assert.match((await gateway.discover({ model: "" })).errors.join(" "), /timed out/u);
  const stalledBody = createAnkiGateway({ timeoutMs: 5, fetch: async (_, { signal }) => ({ ok: true,
    json: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  }) });
  assert.match((await stalledBody.discover({ model: "" })).errors.join(" "), /timed out/u);
  const denied = createAnkiGateway({ fetch: async () => ({ ok: true,
    async json() { return { result: null, error: "valid api key must be provided" }; } }) });
  assert.match((await denied.discover({ model: "" })).errors.join(" "), /API key/u);
});

test("availability revalidates retained choices, all mappings and the first model field without changing configuration", () => {
  const value = config({ model: "Basic", fields: { ...config().fields, expression: "front", definition: "Back" } });
  const before = structuredClone(value);
  const discovery = { connected: true, model: "Basic", decks: ["Default"], models: ["Basic"],
    fields: ["Front", "Back"], errors: [] };
  assert.deepEqual(ankiAvailability(value, discovery), []);
  assert.match(ankiAvailability(value, { ...discovery, decks: [] }).join(" "), /deck/u);
  assert.match(ankiAvailability(value, { ...discovery, fields: ["Other", "Back"] }).join(" "), /front.*unavailable/iu);
  assert.match(ankiAvailability(value, { ...discovery, fields: ["Other", "Front", "Back"] }).join(" "), /first field/u);
  assert.match(ankiAvailability(value, { ...discovery, model: "Old" }).join(" "), /Refresh/u);
  const capturedFirst = config({ model: "Basic", fieldTemplates: {
    Front: { value: "{capture-animation}", overwriteMode: "overwrite" },
    Back: { value: "{expression}", overwriteMode: "overwrite" },
  } });
  assert.match(ankiAvailability(capturedFirst, discovery).join(" "), /captured media.*first field/iu);
  assert.deepEqual(value, before);
});
