// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createAnkiOffscreenService } from "../extension/anki-offscreen.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";

test("the production worker answers maturity only from the local duplicate index", async () => {
  let enabled = true, reads = 0;
  const service = createAnkiWorkerService({
    gateway: { invoke() { throw new Error("A maturity lookup must not call Anki"); } },
    readOptions: async () => ({ definitionBlurAnkiMature: enabled, anki: { model: "Japanese" } }),
    duplicateIndex: {
      async has(config, expression) {
        reads++;
        assert.equal(config.model, "Japanese");
        return expression === "猫";
      },
    },
  });
  assert.deepEqual(await service.maturity({ term: { expression: "猫" } }), { mature: true });
  assert.deepEqual(await service.maturity({ term: { expression: "犬" } }), { mature: false });
  enabled = false;
  assert.deepEqual(await service.maturity({ term: { expression: "猫" } }), { mature: false });
  assert.equal(reads, 2);
});

test("the offscreen refresh returns only compact rows and terminates its worker after success or failure", async () => {
  const source = { model: "Japanese", fields: ["expression"], apiKey: "fixture-key" };
  const rows = [["猫", true, [7, 9]]];
  for (const outcome of [{ rows }, { error: "Anki closed" }, { workerError: "Worker failed" }]) {
    let terminated = false;
    const service = createAnkiOffscreenService({ Worker: class {
      constructor(url, options) {
        assert.ok(url.pathname.endsWith("/anki-index-worker.js"));
        assert.deepEqual(options, { type: "module" });
      }
      postMessage(value) {
        assert.equal(value, source);
        if (outcome.workerError) this.onerror({ message: outcome.workerError });
        else this.onmessage({ data: outcome });
      }
      terminate() { terminated = true; }
    } });
    const request = service({ type: "hd_anki_index_refresh", source });
    if (outcome.rows) assert.deepEqual(await request, { rows });
    else await assert.rejects(request, new RegExp(outcome.error || outcome.workerError));
    assert.equal(terminated, true);
  }
});
