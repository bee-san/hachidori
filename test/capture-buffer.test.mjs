// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAudioRing,
  createCapturePinStore,
  createFrameRing,
  encodeMonoWav,
} from "../extension/capture-buffer.js";
import { AVIF_TIMESCALE, frameDurations } from "../extension/avif-sequence.js";

test("frame history stores compressed bytes, evicts by age and bytes, and pins bounded copies", () => {
  const ring = createFrameRing({ maxBytes: 8, maxAgeMs: 1000, maxFrameBytes: 4 });
  ring.append({ timestampMs: 1000, width: 2, height: 1, data: new Uint8Array([1, 2, 3, 4]) });
  const source = new Uint8Array([5, 6, 7, 8]);
  ring.append({ timestampMs: 1500, width: 2, height: 1, data: source });
  source[0] = 99;
  assert.deepEqual([...ring.select(1000, 1600)[1].data], [5, 6, 7, 8]);
  ring.append({ timestampMs: 2200, width: 2, height: 1, data: new Uint8Array([9, 10, 11, 12]) });
  assert.deepEqual(ring.size(), { count: 2, bytes: 8 });
  assert.equal(ring.oldestTimestamp(), 1500);
  assert.throws(() => ring.append({ timestampMs: 2200, width: 2, height: 1, data: new Uint8Array([1]) }), /increase/u);
  assert.throws(() => ring.append({ timestampMs: 2300, width: 2, height: 1, data: new Uint8Array(5) }), /limit/u);
  assert.throws(() => ring.select(1500, 2300, 7), /pinned-frame/u);
});

test("irregular frames retain their start predecessor and give AVIF and WAV identical sample durations", () => {
  const frames = createFrameRing({ maxAgeMs: 3000 });
  const audio = createAudioRing({ maxAgeMs: 3000 });
  for (const timestampMs of [1000, 2000, 3000, 4000, 4050]) {
    frames.append({ timestampMs, width: 2, height: 2, data: new Uint8Array([timestampMs / 1000]) });
  }
  assert.equal(frames.oldestTimestamp(), 1050, "age keeps the predecessor but advertises the retention boundary");
  audio.append({ startMs: 1050, sampleRate: 48000, samples: new Float32Array(144048) });
  for (const endMs of [4050, 4050.123]) {
    const selected = frames.select(1050, endMs);
    assert.equal(selected[0].timestampMs, 1050);
    assert.equal(selected[0].data[0], 1, "first displayed pixels come from the preceding frame");
    const pcm = audio.select(1050, endMs);
    assert.equal(pcm.partial, false);
    const animationTicks = frameDurations(selected, endMs).reduce((sum, value) => sum + value, 0);
    assert.equal(animationTicks / AVIF_TIMESCALE, pcm.samples.length / pcm.sampleRate);
  }
  assert.throws(() => frames.select(999, 4050), /start/u);
});

test("audio history maps its sample clock into one mono interval and marks silence gaps partial", () => {
  const ring = createAudioRing({ maxAgeMs: 10_000 });
  ring.append({ startMs: 1000, sampleRate: 8000, samples: new Float32Array([0, 0.25, 0.5, 0.75]) });
  ring.append({ startMs: 1001, sampleRate: 8000, samples: new Float32Array([-1, -0.5]) });
  const selected = ring.select(1000, 1002, 8000);
  assert.equal(selected.samples.length, 16);
  assert.equal(selected.sampleRate, 8000);
  assert.equal(selected.partial, true);
  assert.equal(selected.samples[0], 0);
  assert.equal(selected.samples[2], 0.5);
  assert.equal(selected.samples[8], -1);
});

test("overlapping audio blocks cannot hide a genuine gap in the exported interval", () => {
  const ring = createAudioRing({ maxAgeMs: 10_000 });
  for (const startMs of [1000, 1000, 1750]) {
    ring.append({ startMs, sampleRate: 8000, samples: new Float32Array(4000) });
  }
  assert.equal(ring.covers(1000, 2000), false);
  assert.equal(ring.select(1000, 2000).partial, true);
});

test("WAV output is canonical mono PCM16, clips values and enforces its serialized cap", () => {
  const wav = encodeMonoWav(new Float32Array([-2, -1, 0, 0.5, 2]), 8000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(52, true), 32767);
  assert.throws(() => encodeMonoWav(new Float32Array(20), 8000, 60), /exceeds/u);
});

test("one expiring capture pin owns export globally and releases only by token", () => {
  let now = 1000;
  const pins = createCapturePinStore({ now: () => now, lifetimeMs: 100 });
  const first = pins.create({ label: "one" });
  assert.equal(pins.get(first.token).label, "one");
  assert.throws(() => pins.create({ label: "two" }), /already owns/u);
  assert.equal(pins.release("wrong"), false);
  assert.equal(pins.release(first.token), true);
  const second = pins.create({ label: "two" });
  now = 1100;
  assert.equal(pins.get(second.token), null);
  assert.equal(pins.active(), false);
});
