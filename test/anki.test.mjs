// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { AnkiTransportError, ankiMultiResults, createAnkiGateway, ankiAvailability } from "../extension/anki.js";
import { AnkiConnectError, answerAnkiConnect } from "./anki-connect-fake.mjs";

const { normaliseOptions, normaliseAnkiConnectUrl, validateOptionsPatch } = globalThis.HDReaderOptions;
const config = (patch = {}) => ({ ...normaliseOptions({}).anki, ...patch });
const envelope = payload => ({ ok: true, async json() { return payload; } });
const reply = result => envelope({ result, error: null });
// A fake AnkiConnect answering `body` through `handle(action, params)`.
const answer = async (body, handle) => envelope(await answerAnkiConnect(body, handle));
const deferred = () => {
  let resolve;
  const promise = new Promise(accept => {
    resolve = accept;
  });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test("global Anki configuration validates complete mappings and duplicate policies without input caps", () => {
  const defaults = config();
  assert.equal(defaults.deck, "Default");
  assert.equal(defaults.model, "");
  assert.equal(defaults.url, "http://127.0.0.1:8765");
  assert.equal(defaults.duplicateScope, "model");
  assert.equal(Object.hasOwn(defaults, "checkForDuplicates"), false);
  assert.equal(Object.hasOwn(defaults, "duplicateScopeCheckAllModels"), false);
  const value = config({ model: "日本語", tags: Array.from({ length: 300 }, (_, i) => `tag${i}`),
    fields: { ...defaults.fields, expression: "日本語".repeat(300) }, duplicateScope: "deck", duplicateBehavior: "new" });
  const canonical = normaliseOptions({ anki: value }).anki;
  assert.deepEqual(validateOptionsPatch({ anki: value }), { anki: canonical });
  assert.deepEqual(canonical.templates[0], {
    id: "default",
    name: "Default",
    ...Object.fromEntries(globalThis.HDReaderOptions.ANKI_TEMPLATE_CONFIG_KEYS.map(key => [key, canonical[key]])),
  });
  for (const bad of [null, [], { ...value, model: 42 }, { ...value, fields: {} },
    { ...value, tags: [false] }, { ...value, duplicateScope: "profile" }]) {
    assert.throws(() => validateOptionsPatch({ anki: bad }));
  }
  assert.equal(normaliseOptions({ anki: {
    ...value,
    duplicateScope: "collection",
    duplicateScopeCheckAllModels: false,
  } }).anki.duplicateScope, "model");
  assert.equal(normaliseOptions({ anki: {
    ...value,
    duplicateScope: "collection",
    duplicateScopeCheckAllModels: true,
  } }).anki.duplicateScope, "all");
  assert.equal(normaliseOptions({ anki: {
    ...value,
    duplicateScope: "deck-root",
  } }).anki.duplicateScope, "deck");
  assert.equal(normaliseOptions({ anki: {
    ...value,
    checkForDuplicates: false,
    duplicateBehavior: "overwrite",
  } }).anki.duplicateBehavior, "new");
});

test("Anki discovery is one multi batch that binds every sub-action, fixes the envelope and retains field order", async () => {
  const requests = [];
  const gateway = createAnkiGateway({ fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    return answer(body, action => ({ deckNames: ["Default", "日本語", "Default"], modelNames: ["Basic"],
      modelFieldNames: ["Front", "Back"] }[action]));
  } });
  const result = await gateway.discover({ model: "Basic", apiKey: "local-key" });
  assert.deepEqual(result, { connected: true, model: "Basic", decks: ["Default", "日本語"],
    models: ["Basic"], fields: ["Front", "Back"], errors: [] });
  assert.equal(requests.length, 1, "discovery costs one AnkiConnect round trip");
  const [{ url, options, body }] = requests;
  assert.equal(url, "http://127.0.0.1:8765");
  assert.equal(options.method, "POST");
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(body.action, "multi");
  assert.equal(body.version, 6);
  assert.equal(body.key, "local-key");
  // AnkiConnect checks the key and picks the reply shape per sub-action.
  assert.deepEqual(body.params.actions, [
    { action: "deckNames", params: {}, version: 6, key: "local-key" },
    { action: "modelNames", params: {}, version: 6, key: "local-key" },
    { action: "modelFieldNames", params: { modelName: "Basic" }, version: 6, key: "local-key" },
  ]);
});

test("multi replies must be one API-v6 envelope per sub-action and unwrap to the first sub-action failure", async () => {
  let result;
  const requests = [];
  const gateway = createAnkiGateway({ fetch: async (_, options) => { requests.push(JSON.parse(options.body)); return reply(result); } });
  const actions = [{ action: "findNotes", params: { query: "a" } }, { action: "findNotes", params: { query: "b" } }];
  for (result of [null, [], [{ result: [1], error: null }], [{ result: [1], error: null }, [2]],
    [{ result: [1], error: null }, { result: [2] }], [{ result: [1], error: null }, { result: [2], error: 5 }]]) {
    await assert.rejects(gateway.invoke("multi", { actions }), /invalid response/u);
  }
  result = [{ result: [1], error: null }, { result: null, error: "collection is not available" }];
  const replies = await gateway.invoke("multi", { actions });
  assert.deepEqual(replies, result);
  assert.throws(() => ankiMultiResults(replies), /AnkiConnect: collection is not available/u);
  assert.throws(() => ankiMultiResults([{ result: null, error: "valid api key must be provided" }]), /API key/u);
  assert.deepEqual(ankiMultiResults([{ result: [1], error: null }, { result: [], error: null }]), [[1], []]);
  // Only the action and params of a sub-action reach the wire; a caller cannot
  // smuggle another key or version into the conversation.
  result = [{ result: ["Default"], error: null }];
  await gateway.invoke("multi", { actions: [{ action: "deckNames", params: {}, key: "other", version: 5, extra: true }] }, "");
  assert.deepEqual(requests.at(-1).params.actions, [{ action: "deckNames", params: {}, version: 6 }]);
  await gateway.invoke("multi", { actions: [{ action: "deckNames", params: {}, key: "other" }] }, "mine");
  assert.deepEqual(requests.at(-1).params.actions, [{ action: "deckNames", params: {}, version: 6, key: "mine" }]);
});

test("the AnkiConnect fake answers like the add-on: bare results below API v5, envelopes otherwise, fixture faults propagate", async () => {
  const handle = action => { if (action === "boom") throw new Error("fixture fault"); return [action]; };
  assert.deepEqual(await answerAnkiConnect({ action: "deckNames" }, handle), ["deckNames"]);
  assert.deepEqual(await answerAnkiConnect({ action: "multi", version: 6, params: { actions: [
    { action: "deckNames" }, { action: "modelNames", version: 6 }] } }, handle),
  { result: [["deckNames"], { result: ["modelNames"], error: null }], error: null });
  assert.deepEqual(await answerAnkiConnect({ action: "x", version: 6 }, () => { throw new AnkiConnectError("nope"); }),
    { result: null, error: "nope" });
  await assert.rejects(answerAnkiConnect({ action: "boom", version: 6 }, handle), /fixture fault/u);
  // A gateway that stopped binding API v6 to sub-actions fails the envelope check.
  const unbound = createAnkiGateway({ fetch: async (_, options) => {
    const body = JSON.parse(options.body);
    body.params.actions.forEach(entry => delete entry.version);
    return answer(body, () => []);
  } });
  assert.match((await unbound.discover({ model: "" })).errors.join(" "), /invalid response/u);
});

test("Anki endpoint settings normalize HTTP(S) URLs and preserve legacy defaults without repairing invalid URLs to localhost", () => {
  for (const [value, expected] of [
    ["http://localhost:8765/", "http://localhost:8765"],
    [" https://anki.example:443/connect?profile=Japanese#ignored ", "https://anki.example/connect?profile=Japanese"],
  ]) {
    assert.equal(normaliseAnkiConnectUrl(value), expected);
    assert.equal(validateOptionsPatch({ anki: config({ url: value }) }).anki.url, expected);
  }
  const legacy = config();
  delete legacy.url;
  assert.equal(validateOptionsPatch({ anki: legacy }).anki.url, "http://127.0.0.1:8765");
  for (const url of ["", null, 123, "file:///tmp/anki", "javascript:alert(1)",
    "https://user:password@anki.example/", "https://anki.example/\n", "http://anki.example/\u007f"]) {
    assert.equal(normaliseAnkiConnectUrl(url), null);
    assert.throws(() => validateOptionsPatch({ anki: config({ url }) }));
    assert.equal(normaliseOptions({ anki: { url } }).anki.url, "", "invalid stored endpoints stay unavailable");
  }
});

test("custom discovery and direct calls use only their selected endpoint; invalid URLs never send fallback requests", async () => {
  const requests = [];
  const gateway = createAnkiGateway({ fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return answer(body, action => ({ deckNames: ["Default"], modelNames: ["Basic"], modelFieldNames: ["Front", "Back"], guiBrowse: [] }[action]));
  } });
  const url = "https://anki.example/connect?profile=Japanese";
  assert.equal((await gateway.discover({ model: "Basic", apiKey: "remote-key", url })).connected, true);
  await gateway.invoke("guiBrowse", { query: "猫" }, "remote-key", 500, url);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.url === url && request.body.key === "remote-key"));
  assert.ok(requests[0].body.params.actions.every(entry => entry.key === "remote-key"));
  for (const invalid of ["", "file:///tmp/anki", "http://user:secret@anki.example", "https://anki.example/\n"]) {
    const result = await gateway.discover({ model: "Basic", url: invalid });
    assert.equal(result.connected, false);
    assert.match(result.errors.join(" "), /valid HTTP or HTTPS/u);
    await assert.rejects(gateway.invoke("guiBrowse", {}, "remote-key", 500, invalid), /valid HTTP or HTTPS/u);
  }
  assert.equal(requests.length, 2);
});

test("Anki requests use bounded endpoint lanes and start each timeout only when transport dispatches", async () => {
  const heldResponses = Array.from({ length: 4 }, deferred);
  const requests = [];
  const gateway = createAnkiGateway({ fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, action: body.action, signal: options.signal });
    if (body.action.startsWith("held-")) return heldResponses[Number(body.action.slice(5))].promise;
    return reply("queued-result");
  } });
  const url = "http://127.0.0.1:18769";
  const held = heldResponses.map((_, index) => gateway.invoke(`held-${index}`, {}, "", 100, url));
  const queued = gateway.invoke("queued", {}, "", 10, url);
  await tick();
  assert.deepEqual(requests.map(request => request.action), ["held-0", "held-1", "held-2", "held-3"]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(requests.map(request => request.action), ["held-0", "held-1", "held-2", "held-3"],
    "a queued request must not consume its transport deadline");
  heldResponses[0].resolve(reply("held-result-0"));
  assert.equal(await queued, "queued-result");
  assert.deepEqual(requests.map(request => request.action),
    ["held-0", "held-1", "held-2", "held-3", "queued"]);
  assert.equal(requests[4].signal.aborted, false);
  for (let index = 1; index < heldResponses.length; index += 1) {
    heldResponses[index].resolve(reply(`held-result-${index}`));
  }
  assert.deepEqual(await Promise.all(held),
    ["held-result-0", "held-result-1", "held-result-2", "held-result-3"]);
});

test("Anki queues are isolated by normalized endpoint", async () => {
  const responses = new Map();
  const requests = [];
  const gateway = createAnkiGateway({ fetch: async (url, options) => {
    requests.push({ url, action: JSON.parse(options.body).action });
    const response = deferred();
    responses.set(url, response);
    return response.promise;
  } });
  const first = gateway.invoke("first", {}, "", 100, "http://127.0.0.1:18769/");
  const second = gateway.invoke("second", {}, "", 100, "http://127.0.0.1:18770");
  await tick();
  assert.deepEqual(requests, [
    { url: "http://127.0.0.1:18769", action: "first" },
    { url: "http://127.0.0.1:18770", action: "second" },
  ]);
  responses.get("http://127.0.0.1:18769").resolve(reply("first-result"));
  responses.get("http://127.0.0.1:18770").resolve(reply("second-result"));
  assert.deepEqual(await Promise.all([first, second]), ["first-result", "second-result"]);
});

test("Anki transport failure marks pending work unsent, aborts dispatched siblings conservatively and reconnects", async () => {
  let mode = "stalled";
  let requestCount = 0;
  const signals = [];
  const gateway = createAnkiGateway({ timeoutMs: 1000, fetch: async (_, { signal }) => {
    requestCount += 1;
    signals.push(signal);
    if (mode === "connected") return reply("reconnected");
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } });
  const pending = Array.from({ length: 8 }, (_, index) =>
    gateway.invoke(`request-${index}`, {}, "", index === 0 ? 10 : 1000));
  const settled = await Promise.allSettled(pending);
  assert.equal(requestCount, 4, "a failed transport must not spend another timeout on each queued request");
  assert.ok(signals.slice(1).every(signal =>
    signal.reason instanceof AnkiTransportError && signal.reason.dispatched === true),
    "the first failure deliberately aborts already-dispatched siblings");
  for (const [index, result] of settled.entries()) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof AnkiTransportError);
    assert.match(result.reason.message, /timed out/u);
    assert.equal(result.reason.dispatched, index < 4,
      "only requests that entered a transport lane have an uncertain mutation outcome");
    assert.equal(Object.getOwnPropertyDescriptor(result.reason, "dispatched").enumerable, false);
  }
  mode = "connected";
  assert.equal(await gateway.invoke("retry", {}), "reconnected");
  assert.equal(requestCount, 5);
});

test("Anki API failures do not poison unrelated queued requests", async () => {
  let requestCount = 0;
  const gateway = createAnkiGateway({ fetch: async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return { ok: true, async json() { return { result: null, error: "first request rejected" }; } };
    }
    return reply("second-result");
  } });
  const first = gateway.invoke("first", {});
  const second = gateway.invoke("second", {});
  await assert.rejects(first, /first request rejected/u);
  assert.equal(await second, "second-result");
  assert.equal(requestCount, 2);
});

test("Anki transport stress stays bounded and preserves request order", async () => {
  let active = 0;
  let maximumActive = 0;
  const started = [];
  const gateway = createAnkiGateway({ timeoutMs: 50, fetch: async (_, options) => {
    const { action } = JSON.parse(options.body);
    started.push(action);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, (Number(action.slice(7)) % 4) + 1));
    active -= 1;
    return reply(action);
  } });
  const actions = Array.from({ length: 80 }, (_, index) => `stress-${index}`);
  assert.deepEqual(await Promise.all(actions.map(action => gateway.invoke(action, {}))), actions);
  assert.deepEqual(started, actions);
  assert.equal(maximumActive, 4);
});

test("discovery distinguishes partial, malformed, permission and offline failures and retries afresh", async () => {
  let mode = "partial";
  const gateway = createAnkiGateway({ fetch: async (_, options) => {
    const body = JSON.parse(options.body);
    if (mode === "offline") throw new TypeError("Failed to fetch");
    if (mode === "permission") return { ok: false, status: 403 };
    if (mode === "malformed") return { ok: true, async json() { return { result: [] }; } };
    return answer(body, (action, params) => {
      if (mode === "partial" && action === "deckNames") return [12];
      if (action === "modelFieldNames" && params.modelName !== "Basic") throw new AnkiConnectError(`model was not found: ${params.modelName}`);
      return action === "modelNames" ? ["Basic"] : action === "modelFieldNames" ? ["Front"] : ["Default"];
    });
  } });
  const partial = await gateway.discover({ model: "Basic" });
  assert.equal(partial.connected, true);
  assert.deepEqual(partial.fields, ["Front"]);
  assert.deepEqual(partial.errors, ["AnkiConnect returned an invalid deckNames list."]);
  for (const [next, pattern] of [["offline", /Open Anki/u], ["permission", /permission/u], ["malformed", /invalid response/u]]) {
    mode = next;
    const result = await gateway.discover({ model: "Basic" });
    assert.equal(result.connected, false);
    assert.match(result.errors.join(" "), pattern);
    assert.deepEqual(result.fields, []);
  }
  mode = "success";
  assert.equal((await gateway.discover({ model: "Basic" })).errors.length, 0);
  // The speculative field request for an absent note type is not an error.
  const absent = await gateway.discover({ model: "Missing" });
  assert.deepEqual(absent, { connected: true, model: "Missing", decks: ["Default"], models: ["Basic"], fields: [], errors: [] });
});

test("Anki discovery accepts replies slower than the old 1.25-second deadline", async () => {
  const gateway = createAnkiGateway({ fetch: (_, { body, signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(answer(JSON.parse(body), () => [])), 1500);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) });
  assert.equal((await gateway.discover({ model: "" })).connected, true);
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
