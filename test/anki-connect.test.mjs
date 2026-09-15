// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAnkiConnectClient } from "../extension/anki-connect.js";
import { startFakeAnkiConnect } from "./fake-ankiconnect.mjs";

function response(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("AnkiConnect requests use API v6 and the configured endpoint and key", async () => {
  const requests = [];
  const client = createAnkiConnectClient({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return response({ result: 6, error: null });
    },
  });

  assert.equal(await client.invoke("version", {}, {
    url: "http://127.0.0.1:9999/anki", apiKey: "secret",
  }), 6);
  assert.equal(requests[0].url, "http://127.0.0.1:9999/anki");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: "version", version: 6, params: {}, key: "secret",
  });
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "error");
});

test("AnkiConnect rejects transport, HTTP, envelope and action errors", async () => {
  const config = { url: "http://127.0.0.1:8765", apiKey: "" };
  await assert.rejects(createAnkiConnectClient({ fetch: async () => {
    throw new Error("socket details");
  } }).invoke("version", {}, config), /Open Anki with the AnkiConnect add-on installed/u);
  await assert.rejects(createAnkiConnectClient({ fetch: async () => response({}, { status: 503 })
  }).invoke("version", {}, config), /HTTP 503/u);
  await assert.rejects(createAnkiConnectClient({ fetch: async () => response({ result: 6 })
  }).invoke("version", {}, config), /invalid response/u);
  await assert.rejects(createAnkiConnectClient({ fetch: async () => response({ result: null, error: "bad action" })
  }).invoke("version", {}, config), /AnkiConnect: bad action/u);
});

test("connection discovery reads decks, models and the selected model fields", async () => {
  const actions = [];
  const results = {
    version: 6,
    deckNames: ["Default", "Mining", "Mining"],
    modelNames: ["Basic", "Japanese"],
    modelFieldNames: ["Expression", "Reading", "Meaning"],
  };
  const client = createAnkiConnectClient({ fetch: async (_url, options) => {
    const request = JSON.parse(options.body);
    actions.push(request);
    return response({ result: results[request.action], error: null });
  } });

  assert.deepEqual(await client.discover({
    url: "http://127.0.0.1:8765", apiKey: "", model: "Japanese",
  }), {
    version: 6,
    decks: ["Default", "Mining"],
    models: ["Basic", "Japanese"],
    model: "Japanese",
    fields: ["Expression", "Reading", "Meaning"],
  });
  assert.deepEqual(actions.map(({ action }) => action), [
    "version", "deckNames", "modelNames", "modelFieldNames",
  ]);
  assert.deepEqual(actions[3].params, { modelName: "Japanese" });
});

test("fake AnkiConnect service exercises the real HTTP transport", async () => {
  const service = await startFakeAnkiConnect({ apiKey: "secret" });
  try {
    const client = createAnkiConnectClient();
    assert.deepEqual(await client.discover({
      url: service.url, apiKey: "secret", model: "Japanese",
    }), {
      version: 6,
      decks: ["Default", "Mining"],
      models: ["Basic", "Japanese"],
      model: "Japanese",
      fields: ["Expression", "Reading", "Meaning"],
    });
    assert.equal(service.requests.length, 4);
    await assert.rejects(client.invoke("version", {}, {
      url: service.url, apiKey: "wrong",
    }), /valid API key/u);
  } finally {
    await service.close();
  }
});

test("connection discovery rejects incompatible versions and malformed name lists", async () => {
  const config = { url: "http://127.0.0.1:8765", apiKey: "", model: "" };
  const client = result => createAnkiConnectClient({ fetch: async () => response({ result, error: null }) });
  await assert.rejects(client(5).discover(config), /API version 6/u);
  let call = 0;
  await assert.rejects(createAnkiConnectClient({ fetch: async () => response({
    result: call++ === 0 ? 6 : ["Default", 2], error: null,
  }) }).discover(config), /invalid deckNames list/u);
});

test("AnkiConnect requests time out with an actionable error", async () => {
  const client = createAnkiConnectClient({ timeoutMs: 5, fetch: async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  } });
  await assert.rejects(client.invoke("version", {}, {
    url: "http://127.0.0.1:8765", apiKey: "",
  }), /timed out/u);
});

test("AnkiConnect timeout remains active while the response body is read", async () => {
  const client = createAnkiConnectClient({ timeoutMs: 5, fetch: async (_url, { signal }) => ({
    ok: true,
    status: 200,
    async json() {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  }) });
  await assert.rejects(client.invoke("version", {}, {
    url: "http://127.0.0.1:8765", apiKey: "",
  }), /timed out/u);
});
