// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createAudioRing } from "../extension/capture-buffer.js";

const host = readFileSync(new URL("../extension/capture-host.js", import.meta.url), "utf8");

function clockContext() {
  const context = vm.createContext({ performance: { timeOrigin: 1_000_000_000_000 },
    timestamp: () => 1_000_000_000_500 });
  vm.runInContext(host.slice(host.indexOf("function audioTimestampOrigin("),
    host.indexOf("function startTimestampedAudio(")), context);
  return context;
}

test("raw audio uses the measured Chrome 150 shared clock or Chrome 152 page clock, never playback time", () => {
  const context = clockContext();
  const epoch = context.performance.timeOrigin;
  // Measured getDisplayMedia timestamps from real Chrome 150 and 152 probes.
  const video150 = { now: 162.1, timestamp: 4703322299 };
  const audio150 = { now: 131, timestamp: 4703291108 };
  const videoOrigin150 = epoch + video150.now - video150.timestamp / 1000;
  assert.equal(context.audioTimestampOrigin(audio150.timestamp / 1000, videoOrigin150), videoOrigin150);
  const video152 = { now: 172, timestamp: 4742585700 };
  const audio152 = { now: 128.4, timestamp: 107900 };
  const videoOrigin152 = epoch + video152.now - video152.timestamp / 1000;
  assert.equal(context.audioTimestampOrigin(audio152.timestamp / 1000, videoOrigin152), epoch);
  const sampleClock = context.createAudioSampleClock(epoch);
  assert.equal(sampleClock({ timestamp: audio152.timestamp, sampleRate: 48000, numberOfFrames: 480 }),
    epoch + 107.9, "buffered audio retains its capture anchor when processing starts later");
});

test("privacy-rounded AudioData timestamps make contiguous PCM while a dropped block remains an error", () => {
  const context = clockContext();
  const epoch = context.performance.timeOrigin;
  const sampleClock = context.createAudioSampleClock(epoch);
  const audio = createAudioRing({ maxAgeMs: 2000 });
  for (let index = 0; index < 100; index += 1) {
    const roundingUs = index === 0 ? 0 : index % 3 === 0 ? 100 : -1;
    const block = { timestamp: 107900 + index * 10000 + roundingUs,
      sampleRate: 48000, numberOfFrames: 480 };
    audio.append({ startMs: sampleClock(block), sampleRate: block.sampleRate,
      samples: new Float32Array(block.numberOfFrames).fill(0.25) });
  }
  const pcm = audio.select(epoch + 107.9, epoch + 1107.9);
  assert.equal(pcm.partial, false);
  assert.equal(pcm.samples.length, 48000);
  assert.throws(() => sampleClock({ timestamp: 1117900, sampleRate: 48000, numberOfFrames: 480 }),
    /clock was interrupted/u);
});

test("a backward raw video clock stops capture instead of silently skipping all subsequent frames", async () => {
  const frames = [], closed = [], errors = [];
  const sharedStream = {};
  const values = [1_000_000, 900_000].map(timestamp => ({ timestamp, displayWidth: 2, displayHeight: 2,
    close: () => closed.push(timestamp) }));
  class MediaStreamTrackProcessor {
    constructor() {
      this.readable = { getReader: () => ({ read: async () => values.length
        ? { value: values.shift(), done: false } : { done: true } }) };
    }
  }
  const context = vm.createContext({ MediaStreamTrackProcessor,
    stream: sharedStream, videoReader: null, processedVideoTrack: null, frameClockOriginMs: 0,
    config: { videoPreset: "standard" }, establishTrackMediaClock() {},
    captureDimensions: () => ({ width: 2, height: 2 }),
    captureFrame: async (_dimensions, _source, at) => frames.push(at),
    session: { videoDelivered() {} }, describe: error => error.message,
    stopCapture: error => { errors.push(error); context.stream = null; } });
  vm.runInContext(host.slice(host.indexOf("function startTimestampedFrames("),
    host.indexOf("function startFallbackFrames(")), context);
  context.startTimestampedFrames(sharedStream, { clone: () => ({ stop() {} }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(frames, [1000]);
  assert.match(errors[0], /video clock was interrupted/u);
  assert.deepEqual(closed, [1_000_000, 900_000]);
});

function workletContext() {
  const contexts = [], nodes = [], audio = [], errors = [];
  const sharedStream = {};
  class AudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.audioWorklet = { addModule: () => new Promise(resolve => { this.moduleReady = resolve; }) };
      contexts.push(this);
    }
    createMediaStreamSource() {
      const graph = { connect: () => graph };
      return graph;
    }
    createGain() { return { gain: {} }; }
    resume() { return new Promise(resolve => { this.resumed = resolve; }); }
  }
  class AudioWorkletNode {
    constructor() {
      this.port = { start() {}, addEventListener: (_type, callback) => { this.message = callback; } };
      nodes.push(this);
    }
  }
  const context = vm.createContext({ stream: sharedStream, audioContext: null, audioNode: null,
    AudioContext, AudioWorkletNode, MediaStream: class {}, Float32Array,
    timestamp: () => 20000, session: { addAudio: value => audio.push(value) },
    stopCapture: error => { errors.push(error); context.stream = null; } });
  vm.runInContext(host.slice(host.indexOf("async function startWorkletAudio("),
    host.indexOf("async function startAudio(")), context);
  return { context, contexts, nodes, audio, errors, sharedStream };
}

test("Stop during worklet module loading cannot attach a retired audio graph", async () => {
  const h = workletContext();
  const starting = h.context.startWorkletAudio(h.sharedStream, {});
  h.context.stream = null;
  h.context.audioContext = null;
  h.contexts[0].moduleReady();
  await starting;
  assert.equal(h.nodes.length, 0);
});

test("an audio processor rejected by a video-capable browser disposes its clone and starts the worklet", async () => {
  const h = workletContext();
  let cloneStopped = false;
  let sourceStopped = false;
  const clone = { stop: () => { cloneStopped = true; } };
  const source = { clone: () => clone, stop: () => { sourceStopped = true; } };
  h.sharedStream.getAudioTracks = () => [source];
  Object.assign(h.context, { config: { includeAnimation: true }, videoReader: {},
    audioReader: null, audioTrack: null,
    MediaStreamTrackProcessor: class {
      constructor({ track }) {
        assert.equal(track, clone);
        throw new TypeError("Audio tracks are not supported.");
      }
    } });
  vm.runInContext(host.slice(host.indexOf("function startTimestampedAudio("),
    host.indexOf("async function startWorkletAudio(")), h.context);
  vm.runInContext(host.slice(host.indexOf("async function startAudio("),
    host.indexOf("function stopTexthooker(")), h.context);
  const starting = h.context.startAudio(h.sharedStream);
  assert.equal(cloneStopped, true);
  assert.equal(sourceStopped, false);
  assert.equal(h.context.audioReader, null);
  assert.equal(h.context.audioTrack, null);
  assert.equal(h.contexts.length, 1, "the production worklet fallback creates its audio context");
  h.contexts[0].moduleReady();
  await new Promise(resolve => setImmediate(resolve));
  h.contexts[0].resumed();
  await starting;
  assert.equal(h.nodes.length, 1);
  assert.equal(h.context.stream, h.sharedStream);
  assert.deepEqual(h.errors, []);
});

test("worklet discontinuity stops its owning host even before resume calibration completes", async () => {
  const h = workletContext();
  const starting = h.context.startWorkletAudio(h.sharedStream, {});
  h.contexts[0].moduleReady();
  await new Promise(resolve => setImmediate(resolve));
  h.nodes[0].message({ data: { error: "The captured audio clock was interrupted." } });
  assert.match(h.errors[0], /Audio capture stopped.*clock was interrupted/u);
  assert.equal(h.context.stream, null);
  h.contexts[0].resumed();
  await starting;
  assert.equal(h.audio.length, 0);
});

test("worklet timing starts after resume and retired callbacks cannot write into a replacement capture", async () => {
  const h = workletContext();
  const starting = h.context.startWorkletAudio(h.sharedStream, {});
  h.contexts[0].moduleReady();
  await new Promise(resolve => setImmediate(resolve));
  h.contexts[0].currentTime = 5;
  h.contexts[0].resumed();
  await starting;
  const message = { data: { startFrame: 5 * 48000, samples: new Float32Array(2048).buffer } };
  h.nodes[0].message(message);
  assert.equal(h.audio[0].startMs, 20000);
  h.context.stream = {};
  h.context.audioContext = {};
  h.nodes[0].message(message);
  assert.equal(h.audio.length, 1);
});
