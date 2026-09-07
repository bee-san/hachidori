// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createCaptureSession } from "../extension/capture-session.js";

const baseConfig = structuredClone(globalThis.HDReaderOptions.DEFAULT_MEDIA_CAPTURE);

function harness(patch = {}, dependencies = {}) {
  let now = 10_000;
  let wall = 1_000;
  let id = 0;
  const timers = [];
  const encoded = [];
  const session = createCaptureSession({
    now: () => now,
    wallNow: () => wall,
    randomId: () => `id-${++id}`,
    setTimer(resolve, delay) { timers.push({ at: now + delay, resolve }); },
    encodeAnimation: dependencies.encodeAnimation ?? (async (frames, options, { onProgress }) => {
      encoded.push({ frames, options });
      onProgress(frames.length, frames.length);
      return new Uint8Array([1, 2, 3]);
    }),
  });
  session.configure({ ...baseConfig, ...patch,
    texthooker: { ...baseConfig.texthooker, ...patch.texthooker },
    page: { ...baseConfig.page, ...patch.page } });
  function advance(value) {
    now += value;
    wall += value;
    for (const timer of timers.splice(0).filter(timer => timer.at <= now)) timer.resolve();
  }
  return { session, advance, encoded, now: () => now };
}

function seed(h, { withText = true } = {}) {
  h.session.start({ sourceName: "Game tab", displaySurface: "browser" });
  for (let offset = 0; offset <= 5000; offset += 1000) {
    h.session.addFrame({ timestampMs: h.now() - 5000 + offset, width: 2, height: 2,
      data: new Uint8Array([offset / 1000 + 1]) });
  }
  h.session.addAudio({ startMs: h.now() - 5000, sampleRate: 8000, samples: new Float32Array(40_000).fill(0.25) });
  if (withText) h.session.textBegin({ sourceKind: "dom", sourceId: "tab:1", sourceEpoch: "doc:1",
    occurrenceId: "line:1", text: "猫がいる", startMs: h.now() - 2000 });
}

test("capture session rejects monitor capture, reports real history and clears only capture state on stop", () => {
  const h = harness({ enabled: true });
  assert.throws(() => h.session.start({ displaySurface: "monitor" }), /screen/u);
  seed(h);
  const status = h.session.status();
  assert.equal(status.state, "recording");
  assert.equal(status.mediaSource.name, "Game tab");
  assert.equal(status.history.frameCount, 6);
  assert.equal(status.history.audioSamples, 40_000);
  h.session.stop();
  assert.equal(h.session.status().state, "stopped");
  assert.equal(h.session.status().history.frameCount, 0);
});

test("root lookup pins once, shortens an unfinished DOM tail when the line closes, then exports one interval", async () => {
  const h = harness({ enabled: true, clipSeconds: 5, estimatedOffsetMs: 0 });
  seed(h);
  const pin = h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() });
  assert.equal(pin.sourceLabel, "Page-text estimate");
  assert.throws(() => h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() }), /already owns/u);
  h.advance(500);
  h.session.textClose({ sourceKind: "dom", sourceId: "tab:1", sourceEpoch: "doc:1", occurrenceId: "line:1" }, h.now());
  h.advance(1);
  await Promise.resolve();
  const started = h.session.beginExport(pin.token, { includeAnimation: true, includeAudio: true });
  assert.equal(started.state, "finishing");
  await new Promise(resolve => setImmediate(resolve));
  const status = h.session.jobStatus(started.jobId);
  assert.equal(status.state, "ready");
  assert.deepEqual(status.assets.animation, { filename: pin.animationFilename, byteLength: 3 });
  assert.equal(status.assets.audio.filename, pin.audioFilename);
  assert.equal(h.encoded.length, 1);
  assert.equal(h.encoded[0].options.endMs, h.now() - 1);
  assert.deepEqual([...h.session.jobAsset(started.jobId, "animation").data], [1, 2, 3]);
  assert.equal(h.session.completeExport(started.jobId), true);
  assert.equal(h.session.status().pinActive, false);
});

test("relinking caps a pending page-timed clip at the old document boundary", async () => {
  const h = harness({ enabled: true, clipSeconds: 5, estimatedOffsetMs: 0 });
  seed(h);
  h.session.setLinkedPage({ tabId: 1, documentId: "document-1", title: "First" });
  const pin = h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() });
  h.advance(500);
  h.session.setLinkedPage({ tabId: 2, documentId: "document-2", title: "Second" });
  h.advance(1);
  await Promise.resolve();
  const started = h.session.beginExport(pin.token, { includeAnimation: true, includeAudio: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.jobStatus(started.jobId).state, "ready");
  assert.equal(h.encoded[0].options.endMs, h.now() - 1);
});

test("recent fallback can be partial during warmup and jobs expose errors without a long request", async () => {
  const h = harness({ enabled: true, timingMode: "recent", includeAnimation: false });
  seed(h, { withText: false });
  const pin = h.session.pinLookup({ lookupText: "anything", lookupTimeMs: h.now() });
  assert.equal(pin.sourceLabel, "Recent clip");
  assert.equal(pin.partial, true);
  const job = h.session.beginExport(pin.token, { includeAnimation: false, includeAudio: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.jobStatus(job.jobId).state, "ready");
  assert.equal(h.session.jobAsset(job.jobId, "audio").data.length > 44, true);
});

test("an export takes independent ownership, blocks a second pin and releases only on completion", async () => {
  const h = harness({ enabled: true, timingMode: "recent", clipSeconds: 5 });
  seed(h, { withText: false });
  const pin = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: h.now() });
  const job = h.session.beginExport(pin.token, { includeAnimation: true, includeAudio: false });
  assert.equal(h.session.releasePin(pin.token), false, "popup cleanup cannot cancel an exporting job");
  assert.throws(() => h.session.pinLookup({ lookupText: "犬", lookupTimeMs: h.now() }), /still exporting/u);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.jobStatus(job.jobId).state, "ready");
  assert.equal(h.session.completeExport(job.jobId), true);
  assert.doesNotThrow(() => h.session.pinLookup({ lookupText: "犬", lookupTimeMs: h.now() }));
});

test("missing source audio keeps a mapped animation, reports partial output and never invents a WAV", async () => {
  const h = harness({ enabled: true, timingMode: "recent" });
  h.session.start({ sourceName: "Window", displaySurface: "window", audioAvailable: false });
  for (let offset = 0; offset < 5000; offset += 1000) {
    h.session.addFrame({ timestampMs: h.now() - 5000 + offset, width: 2, height: 2,
      data: new Uint8Array([offset / 1000 + 1]) });
  }
  const pin = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: h.now() });
  const job = h.session.beginExport(pin.token, { includeAnimation: true, includeAudio: true });
  await new Promise(resolve => setImmediate(resolve));
  const status = h.session.jobStatus(job.jobId);
  assert.equal(status.state, "ready");
  assert.equal(status.partial, true);
  assert.ok(status.assets.animation);
  assert.equal(status.assets.audio, undefined);
  assert.match(status.warnings.join(" "), /did not provide audio/u);
});

test("an audio-only mapping reports unavailable source audio instead of inventing an output", () => {
  const h = harness({ enabled: true, timingMode: "recent" });
  h.session.start({ sourceName: "Window", displaySurface: "window", audioAvailable: false });
  for (let offset = 0; offset < 5000; offset += 1000) {
    h.session.addFrame({ timestampMs: h.now() - 5000 + offset, width: 2, height: 2,
      data: new Uint8Array([offset / 1000 + 1]) });
  }
  const pin = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: h.now() });
  assert.throws(() => h.session.beginExport(pin.token, { includeAnimation: false, includeAudio: true }),
    /did not provide audio/u);

  const audioOnly = harness({
    enabled: true,
    timingMode: "recent",
    includeAnimation: false,
    includeCapturedAudio: true,
  });
  audioOnly.session.start({ sourceName: "Window", displaySurface: "window", audioAvailable: false });
  assert.throws(() => audioOnly.session.pinLookup({ lookupText: "猫", lookupTimeMs: audioOnly.now() }),
    /did not provide audio/u);
});

test("Stop aborts an encoder job and oversized animation output becomes an explicit job error", async () => {
  let aborted = false;
  const waiting = harness({ enabled: true, timingMode: "recent" }, {
    encodeAnimation: (_frames, _options, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("cancelled"));
      }, { once: true });
    }),
  });
  seed(waiting, { withText: false });
  const pin = waiting.session.pinLookup({ lookupText: "猫", lookupTimeMs: waiting.now() });
  const job = waiting.session.beginExport(pin.token, { includeAnimation: true, includeAudio: false });
  await new Promise(resolve => setImmediate(resolve));
  waiting.session.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.throws(() => waiting.session.jobStatus(job.jobId), /expired/u);

  const oversized = harness({ enabled: true, timingMode: "recent" }, {
    encodeAnimation: async () => new Uint8Array(4 * 1024 * 1024 + 1),
  });
  seed(oversized, { withText: false });
  const oversizedPin = oversized.session.pinLookup({ lookupText: "猫", lookupTimeMs: oversized.now() });
  const oversizedJob = oversized.session.beginExport(oversizedPin.token,
    { includeAnimation: true, includeAudio: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(oversized.session.jobStatus(oversizedJob.jobId).state, "error");
  assert.match(oversized.session.jobStatus(oversizedJob.jobId).error, /4 MiB/u);
});
