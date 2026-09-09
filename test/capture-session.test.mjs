// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { createCaptureSession, MEDIA_DRAIN_MS } from "../extension/capture-session.js";

const baseConfig = structuredClone(globalThis.HDReaderOptions.DEFAULT_MEDIA_CAPTURE);

function harness(patch = {}, dependencies = {}) {
  let now = 10_000;
  let wall = 1_000;
  let id = 0;
  const timers = new Set();
  const encoded = [];
  const session = createCaptureSession({
    now: () => now,
    wallNow: () => wall,
    randomId: () => `id-${++id}`,
    setTimer(resolve, delay) {
      const timer = { at: now + delay, resolve };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
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
    for (const timer of timers) {
      if (timer.at > now) continue;
      timers.delete(timer);
      timer.resolve();
    }
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

test("capture session accepts explicit monitor capture, reports real history and clears only capture state on stop", () => {
  const h = harness({ enabled: true });
  assert.equal(h.session.start({ displaySurface: "monitor" }).mediaSource.displaySurface, "monitor");
  h.session.stop();
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

test("browser speech can select complete active capture audio without accepting a clock gap", () => {
  const h = harness({ enabled: true, includeCapturedAudio: true });
  h.session.start({ audioAvailable: true });
  h.session.addAudio({ startMs: 9000, sampleRate: 8000, samples: new Float32Array(4000).fill(0.25) });
  h.session.addAudio({ startMs: 9600, sampleRate: 8000, samples: new Float32Array(3200).fill(0.25) });
  assert.equal(h.session.selectAudio(9600, 10_000).samples.length, 19_200);
  assert.throws(() => h.session.selectAudio(9000, 10_000), /did not record all/u);
  h.session.stop();
  assert.throws(() => h.session.assertAudioCapture(), /Start media capture with shared audio/u);
});

test("document unlink and replacement release unsubmitted pins while an admitted export retains ownership", async () => {
  const h = harness({ enabled: true, timingMode: "recent", includeCapturedAudio: false, clipSeconds: 5 });
  seed(h, { withText: false });
  h.session.setLinkedPage({ tabId: 1, documentId: "old-document" });
  const abandoned = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: h.now() });
  h.session.setLinkedPage(null);
  h.session.setLinkedPage({ tabId: 2, documentId: "new-document" });
  assert.equal(h.session.releasePin(abandoned.token), false);
  const replacement = h.session.pinLookup({ lookupText: "犬", lookupTimeMs: h.now() });
  h.session.setLinkedPage({ tabId: 2, documentId: "navigated-document" });
  assert.equal(h.session.releasePin(replacement.token), false);
  const submitted = h.session.pinLookup({ lookupText: "鳥", lookupTimeMs: h.now() });
  const job = h.session.beginExport(submitted.token, { includeAnimation: true, includeAudio: false });
  h.session.setLinkedPage(null);
  h.session.setLinkedPage({ tabId: 3, documentId: "another-document" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.jobStatus(job.jobId).state, "ready");
  assert.equal(h.session.completeExport(job.jobId), true);
  assert.ok(h.session.pinLookup({ lookupText: "次", lookupTimeMs: h.now() }).token);
});

test("dismissing an expired pin releases its retained clip once after status prunes its token", async () => {
  const h = harness({ enabled: true, timingMode: "recent", includeCapturedAudio: false, clipSeconds: 5 });
  seed(h, { withText: false });
  const pin = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: h.now() });
  await new Promise(resolve => setImmediate(resolve));
  h.advance(2 * 60 * 1000);
  assert.equal(h.session.status().pinActive, false);
  assert.equal(h.session.releasePin("another-token"), false);
  assert.equal(h.session.releasePin(pin.token), true, "the session still owns the expired clip until dismissal");
  assert.equal(h.session.releasePin(pin.token), false, "dismissal retires that ownership exactly once");
  assert.doesNotThrow(() => h.session.releasePin(undefined));
});

test("root lookup pins once, shortens an unfinished DOM tail when the line closes, then exports one interval", async () => {
  const h = harness({ enabled: true, clipSeconds: 5, estimatedOffsetMs: 0 });
  seed(h);
  const pin = h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() });
  assert.equal(pin.sourceLabel, "Page-text estimate");
  assert.throws(() => h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() }), /already owns/u);
  h.advance(500);
  h.session.addAudio({ startMs: 10_000, sampleRate: 8000, samples: new Float32Array(4000) });
  h.session.videoDelivered(h.now());
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

test("relinking caps an admitted pending page-timed export at the old document boundary", async () => {
  const h = harness({ enabled: true, clipSeconds: 5, estimatedOffsetMs: 0 });
  seed(h);
  h.session.setLinkedPage({ tabId: 1, documentId: "document-1", title: "First" });
  const pin = h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() });
  const started = h.session.beginExport(pin.token, { includeAnimation: true, includeAudio: false });
  h.advance(500);
  h.session.addAudio({ startMs: 10_000, sampleRate: 8000, samples: new Float32Array(4000) });
  h.session.videoDelivered(h.now());
  h.session.setLinkedPage({ tabId: 2, documentId: "document-2", title: "Second" });
  h.advance(1);
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.jobStatus(started.jobId).state, "ready");
  assert.equal(h.encoded[0].options.endMs, h.now() - 1);
});

test("closed texthooker lines remain eligible only in the current live feed epoch", () => {
  const h = harness({ enabled: true, estimatedOffsetMs: 0 });
  seed(h, { withText: false });
  const record = { sourceKind: "texthooker", sourceId: "feed", sourceEpoch: "connection:1",
    occurrenceId: "line:1", text: "猫がいる", startMs: 7000 };
  h.session.textBegin(record);
  h.session.textClose(record, 9000);
  h.session.setTexthooker("Active", true);
  const oldLine = h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() });
  assert.equal(oldLine.sourceKind, "texthooker");
  h.session.releasePin(oldLine.token);
  h.session.setTexthooker("Disconnected", false);
  h.session.textBegin({ ...record, sourceEpoch: "connection:2", occurrenceId: "line:2",
    text: "犬がいる", startMs: 9500 });
  h.session.setTexthooker("Active", true);
  const staleLine = h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() });
  assert.equal(staleLine.sourceKind, "recent");
  h.session.releasePin(staleLine.token);
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

for (const futureTail of [false, true]) {
  test(`${futureTail ? "future" : "recent"} clips drain late audio and video without moving their anchor`, async () => {
    const h = harness({ enabled: true, timingMode: futureTail ? "auto" : "recent",
      clipSeconds: 5, estimatedOffsetMs: 0 });
    h.session.start();
    for (const timestampMs of [5000, 7000, 9000]) {
      h.session.addFrame({ timestampMs, width: 2, height: 2, data: new Uint8Array([1]) });
    }
    h.session.addAudio({ startMs: 5000, sampleRate: 8000, samples: new Float32Array(39760).fill(0.25) });
    if (futureTail) h.session.textBegin({ sourceKind: "dom", sourceId: "tab:1", sourceEpoch: "doc:1",
      occurrenceId: "line:1", text: "猫がいる", startMs: 8000 });
    const pin = h.session.pinLookup({ lookupText: "猫がいる", lookupTimeMs: h.now() });
    const endMs = futureTail ? 13_000 : 10_000;
    assert.equal(pin.readyAtMs, endMs);
    const job = h.session.beginExport(pin.token, { includeAnimation: true, includeAudio: true });
    if (futureTail) {
      h.advance(3000);
      h.session.addAudio({ startMs: 9970, sampleRate: 8000, samples: new Float32Array(24000).fill(0.25) });
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.session.jobStatus(job.jobId).state, "finishing");
    h.advance(50);
    h.session.addAudio({ startMs: endMs - 30, sampleRate: 8000, samples: new Float32Array(320).fill(0.75) });
    assert.equal(h.session.jobStatus(job.jobId).state, "finishing", "waits for the in-flight JPEG too");
    h.session.addFrame({ timestampMs: endMs - 10, width: 2, height: 2, data: new Uint8Array([9]) });
    h.session.videoDelivered(endMs + 10);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.session.jobStatus(job.jobId).state, "ready");
    assert.equal(h.session.jobStatus(job.jobId).partial, false);
    assert.equal(h.encoded[0].options.endMs, endMs);
    assert.equal(h.encoded[0].frames[0].timestampMs, futureTail ? 8000 : 5000);
    assert.equal(h.encoded[0].frames.at(-1).data[0], 9);
    const wav = h.session.jobAsset(job.jobId, "audio").data;
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(view.getInt16(wav.length - 2, true), 24575, "WAV includes the delivered tail");
  });
}

test("the bounded drain reports missing continuous audio instead of exporting silent gaps", async () => {
  const h = harness({ enabled: true, timingMode: "recent", clipSeconds: 5 });
  h.session.start();
  for (const timestampMs of [5000, 9000, 10_000]) {
    h.session.addFrame({ timestampMs, width: 2, height: 2, data: new Uint8Array([1]) });
  }
  // The newest block reaches the endpoint, but a real 100 ms gap remains.
  h.session.addAudio({ startMs: 5000, sampleRate: 8000, samples: new Float32Array(16000) });
  h.session.addAudio({ startMs: 7100, sampleRate: 8000, samples: new Float32Array(23200) });
  const pin = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: h.now() });
  const job = h.session.beginExport(pin.token, { includeAnimation: true, includeAudio: true });
  await new Promise(resolve => setImmediate(resolve));
  h.advance(MEDIA_DRAIN_MS - 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.jobStatus(job.jobId).state, "finishing");
  h.advance(1);
  await new Promise(resolve => setImmediate(resolve));
  const status = h.session.jobStatus(job.jobId);
  assert.equal(status.state, "error");
  assert.match(status.error, /missing samples/u);
  assert.deepEqual(status.assets, {});
  assert.equal(h.encoded.length, 0);
});

test("a stationary video holds its last frame after the drain and Stop cancels a draining pin", async () => {
  const h = harness({ enabled: true, timingMode: "recent", clipSeconds: 5 });
  h.session.start();
  h.session.addFrame({ timestampMs: 5000, width: 2, height: 2, data: new Uint8Array([1]) });
  h.session.addAudio({ startMs: 5000, sampleRate: 8000, samples: new Float32Array(40000) });
  const pin = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: h.now() });
  const job = h.session.beginExport(pin.token, { includeAnimation: true, includeAudio: false });
  await new Promise(resolve => setImmediate(resolve));
  h.advance(MEDIA_DRAIN_MS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.jobStatus(job.jobId).state, "ready");
  assert.equal(h.encoded[0].frames.length, 1);
  assert.equal(h.encoded[0].frames[0].timestampMs, 5000);
  assert.equal(h.encoded[0].options.endMs, 10_000);
  h.session.completeExport(job.jobId);

  const audioPin = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: 10_000 });
  const audioJob = h.session.beginExport(audioPin.token, { includeAnimation: false, includeAudio: true });
  await new Promise(resolve => setImmediate(resolve));
  h.advance(MEDIA_DRAIN_MS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.jobStatus(audioJob.jobId).state, "ready");
  h.session.completeExport(audioJob.jobId);

  const stoppedPin = h.session.pinLookup({ lookupText: "猫", lookupTimeMs: h.now() });
  const stoppedJob = h.session.beginExport(stoppedPin.token, { includeAnimation: true, includeAudio: true });
  await new Promise(resolve => setImmediate(resolve));
  h.session.stop();
  h.advance(MEDIA_DRAIN_MS);
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => h.session.jobStatus(stoppedJob.jobId), /expired/u);
  assert.equal(h.encoded.length, 1, "the stopped draining pin never encodes");
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
  for (let offset = 0; offset <= 5000; offset += 1000) {
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
