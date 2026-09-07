// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import createAvifEncoderModule from "../extension/vendor/avif-encoder.mjs";
import {
  AVIF_TIMESCALE,
  createAvifSequenceEncoder,
  encodeJpegSequence,
  frameDurations,
} from "../extension/avif-sequence.js";
import { encodeCapturedAnimation } from "../extension/capture-encoder-client.js";
import { createAudioRing, createFrameRing, encodeMonoWav } from "../extension/capture-buffer.js";

function uint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

test("frame timing preserves observed spacing and rejects unordered or empty tails", () => {
  const frames = [{ timestampMs: 1000 }, { timestampMs: 1125 }, { timestampMs: 1400 }];
  assert.deepEqual(frameDurations(frames, 1600, 1000), [125, 275, 200]);
  assert.throws(() => frameDurations([frames[1], frames[0]], 1600), /increase/u);
  assert.throws(() => frameDurations(frames, 1400), /empty/u);
});

test("pinned libavif wasm emits a multi-frame AVIF sequence with exact sample timing", async () => {
  const module = await createAvifEncoderModule({
    locateFile: name => new URL(`../extension/vendor/${name}`, import.meta.url).pathname,
  });
  const encoder = createAvifSequenceEncoder(module, { width: 64, height: 64, timescale: 1000, quality: 55, speed: 8 });
  let output;
  try {
    for (let frame = 0; frame < 3; frame += 1) {
      const rgba = new Uint8Array(64 * 64 * 4);
      for (let index = 0; index < rgba.length; index += 4) {
        rgba[index] = frame * 100;
        rgba[index + 1] = (index / 4) % 256;
        rgba[index + 2] = 255 - frame * 80;
        rgba[index + 3] = 255;
      }
      encoder.add(rgba, 250);
    }
    output = encoder.finish();
  } finally {
    encoder.destroy();
  }
  assert.equal(new TextDecoder().decode(output.slice(4, 12)), "ftypavis");
  const sttsType = Buffer.from(output).indexOf(Buffer.from("stts"));
  assert.ok(sttsType > 4, "movie sample timing box is present");
  const box = sttsType - 4;
  assert.equal(uint32(output, box), 24);
  assert.equal(uint32(output, box + 12), 1);
  assert.equal(uint32(output, box + 16), 3);
  assert.equal(uint32(output, box + 20), 250);
});

test("production sequence export serializes the same duration as WAV after clipping an irregular predecessor", async () => {
  const module = await createAvifEncoderModule({
    locateFile: name => new URL(`../extension/vendor/${name}`, import.meta.url).pathname,
  });
  const frames = createFrameRing({ maxAgeMs: 10_000 });
  for (const timestampMs of [1000, 2000, 3000, 4000]) {
    frames.append({ timestampMs, width: 64, height: 64, data: new Uint8Array([timestampMs / 1000]) });
  }
  const audio = createAudioRing({ maxAgeMs: 10_000 });
  audio.append({ startMs: 1000, sampleRate: 48000, samples: new Float32Array(192000) });
  const startMs = 1050;
  const endMs = 4050.123;
  // Only bitmap decoding is substituted; timing, libavif and WAV serialization
  // are the same production path used by the dedicated encoder worker.
  const output = await encodeJpegSequence(module, frames.select(startMs, endMs), {
    endMs,
    createBitmap: async () => ({ close() {} }),
    createCanvas: () => ({ getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4).fill(255) }),
    }) }),
  });
  const mdhd = Buffer.from(output).indexOf(Buffer.from("mdhd")) - 4;
  assert.ok(mdhd > 0);
  assert.equal(uint32(output, mdhd + (output[mdhd + 8] === 1 ? 28 : 20)), AVIF_TIMESCALE);
  const stts = Buffer.from(output).indexOf(Buffer.from("stts")) - 4;
  let ticks = 0;
  let samples = 0;
  for (let index = 0; index < uint32(output, stts + 12); index += 1) {
    const count = uint32(output, stts + 16 + index * 8);
    samples += count;
    ticks += count * uint32(output, stts + 20 + index * 8);
  }
  const pcm = audio.select(startMs, endMs);
  const wav = encodeMonoWav(pcm.samples, pcm.sampleRate);
  assert.equal(samples, 4);
  assert.equal(ticks, (wav.byteLength - 44) / 2);
  assert.equal(ticks, Math.ceil((endMs - startMs) * 48));
});

test("encoder client transfers copied frame bytes, reports progress and terminates on success or timeout", async () => {
  const workers = [];
  class FakeWorker extends EventTarget {
    constructor(url, options) {
      super();
      this.url = String(url);
      this.options = options;
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message, transfer) {
      this.message = message;
      this.transfer = transfer;
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", { data: {
          type: "progress", id: message.id, completed: 1, total: 1, heapBytes: 16 * 1024 * 1024,
        } }));
        this.dispatchEvent(new MessageEvent("message", { data: {
          type: "result", id: message.id, ok: true, data: new Uint8Array([1, 2]).buffer,
        } }));
      });
    }
    terminate() { this.terminated = true; }
  }
  const source = new Uint8Array([9, 8, 7]);
  const progress = [];
  const output = await encodeCapturedAnimation([
    { timestampMs: 1, width: 2, height: 2, data: source },
  ], { endMs: 2, videoPreset: "compact" }, {
    WorkerClass: FakeWorker, timeoutMs: 100, onProgress: (...value) => progress.push(value),
  });
  source[0] = 0;
  assert.deepEqual([...output], [1, 2]);
  assert.deepEqual(progress, [[1, 1, 16 * 1024 * 1024]]);
  assert.deepEqual([...new Uint8Array(workers[0].message.frames[0].data)], [9, 8, 7]);
  assert.equal(workers[0].transfer.length, 1);
  assert.equal(workers[0].terminated, true);

  class SilentWorker extends EventTarget {
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  await assert.rejects(encodeCapturedAnimation([], {}, { WorkerClass: SilentWorker, timeoutMs: 1 }), /deadline/u);
});
