// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createCaptureFrameEncoder } from "../extension/capture-frame-client.js";

function harness(options = {}) {
  let worker;
  class Worker {
    constructor() { worker = this; this.listeners = {}; this.messages = []; this.terminated = false; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    postMessage(data, transfers) { this.messages.push({ data, transfers }); }
    terminate() { this.terminated = true; }
  }
  const encoder = createCaptureFrameEncoder({ WorkerClass: Worker, ...options });
  return { encoder, worker };
}

test("frame capture transfers one cloned frame at a time and Stop rejects pending encoding", async () => {
  const h = harness();
  let closed = 0;
  const clone = { close: () => { closed += 1; } };
  const source = { clone: () => clone };
  const first = h.encoder.encode(source, { width: 640, height: 360 });
  assert.equal(h.worker.messages.length, 1);
  assert.equal(h.worker.messages[0].transfers[0], clone);
  await assert.rejects(h.encoder.encode(source, { width: 640, height: 360 }), /already being encoded/u);
  assert.equal(h.worker.messages.length, 1);
  assert.equal(closed, 1, "the rejected extra frame is closed");
  h.worker.listeners.message({ data: { bytes: new Uint8Array([1, 2]).buffer } });
  assert.deepEqual(await first, new Uint8Array([1, 2]));
  const pending = h.encoder.encode(source, { width: 640, height: 360 });
  h.encoder.close();
  await assert.rejects(pending, /stopped/u);
  assert.equal(h.worker.terminated, true);
  await assert.rejects(h.encoder.encode(source, { width: 640, height: 360 }), /stopped/u);
});

test("a preview bitmap finishing after Stop is closed without posting to a retired worker", async () => {
  let ready;
  let closed = false;
  const h = harness({ createBitmap: () => new Promise(resolve => { ready = resolve; }) });
  const pending = h.encoder.encode({}, { width: 640, height: 360 });
  h.encoder.close();
  ready({ close: () => { closed = true; } });
  await assert.rejects(pending, /stopped/u);
  assert.equal(closed, true);
  assert.equal(h.worker.messages.length, 0);
});
