// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { GIF_MAX_FPS, encodeLoopingGif, gifDelayCentiseconds, selectGifFrames } from "../extension/netflix-gif.js";

// A tiny RGBA frame of one solid colour, so a palette is trivial but valid.
const solidFrame = (width, height, value) => new Uint8ClampedArray(width * height * 4).fill(value);

test("the kept frames are the cue's own window, thinned to at most GIF_MAX_FPS", () => {
  // 50 fps (20 ms apart) across a 400 ms span; only [100, 300] is the cue.
  const frames = [];
  for (let ms = 0; ms <= 400; ms += 20) frames.push({ mediaMs: ms, data: solidFrame(2, 2, ms) });
  const kept = selectGifFrames(frames, { startMs: 100, endMs: 300 });
  // 100 ms spacing at 10 fps over a 200 ms window: 100, 200, 300.
  assert.deepEqual(kept.map(entry => entry.frame.mediaMs), [100, 200, 300]);
  // No two kept frames are closer than 1000 / GIF_MAX_FPS apart.
  for (let index = 1; index < kept.length; index++) {
    assert.ok(kept[index].frame.mediaMs - kept[index - 1].frame.mediaMs >= 1000 / GIF_MAX_FPS - 1);
  }
  // Each frame's delay is the gap to the next; the last holds for the median gap.
  assert.deepEqual(kept.map(entry => entry.delayMs), [100, 100, 100]);
  // Frames outside the cue are dropped, and a cue with no frame yields nothing.
  assert.equal(selectGifFrames(frames, { startMs: 1000, endMs: 2000 }).length, 0);
  assert.equal(selectGifFrames([], { startMs: 0, endMs: 100 }).length, 0);
});

test("a single-frame cue still produces one looping frame with a positive delay", () => {
  const kept = selectGifFrames([{ mediaMs: 150, data: solidFrame(2, 2, 10) }], { startMs: 100, endMs: 300 });
  assert.equal(kept.length, 1);
  assert.ok(kept[0].delayMs >= 20);
});

test("the encoded GIF has a GIF89a header, the loop marker, and a frame per entry", () => {
  const width = 8;
  const height = 6;
  const entries = [
    { data: solidFrame(width, height, 20), delayMs: 100 },
    { data: solidFrame(width, height, 120), delayMs: 80 },
    { data: solidFrame(width, height, 220), delayMs: 100 },
  ];
  const bytes = encodeLoopingGif(entries, width, height);
  const buffer = Buffer.from(bytes);
  assert.equal(buffer.toString("ascii", 0, 6), "GIF89a");
  // The logical screen descriptor carries the dimensions little-endian.
  assert.equal(buffer.readUInt16LE(6), width);
  assert.equal(buffer.readUInt16LE(8), height);
  // The NETSCAPE2.0 application extension with a repeat count of 0 loops forever.
  const netscape = buffer.indexOf("NETSCAPE2.0", 0, "ascii");
  assert.ok(netscape >= 0, "the loop extension is present");
  assert.equal(buffer.readUInt16LE(netscape + 11 + 2), 0, "the loop count is 0 (forever)");
  // One graphic control extension (0x21 0xF9) and one image separator (0x2C) per frame.
  let gceCount = 0;
  let imageCount = 0;
  for (let index = 0; index < buffer.length - 1; index++) {
    if (buffer[index] === 0x21 && buffer[index + 1] === 0xf9) gceCount++;
    if (buffer[index] === 0x2c) imageCount++;
  }
  assert.equal(gceCount, entries.length);
  assert.equal(imageCount, entries.length);
  assert.equal(buffer.at(-1), 0x3b, "the GIF ends with its trailer");
});

test("each frame's delay is written in centiseconds in its graphic control extension", () => {
  const entries = [{ data: solidFrame(4, 4, 30), delayMs: 100 }, { data: solidFrame(4, 4, 90), delayMs: 50 }];
  const buffer = Buffer.from(encodeLoopingGif(entries, 4, 4));
  const delays = [];
  for (let index = 0; index < buffer.length - 1; index++) {
    // GCE: 0x21 0xF9 0x04 <packed> <delay LE16> <transparent> 0x00
    if (buffer[index] === 0x21 && buffer[index + 1] === 0xf9 && buffer[index + 2] === 0x04) {
      delays.push(buffer.readUInt16LE(index + 4));
    }
  }
  assert.deepEqual(delays, entries.map(entry => gifDelayCentiseconds(entry.delayMs)));
  assert.deepEqual(delays, [10, 5]);
});

test("encoding rejects an empty set, bad dimensions, or a mis-sized frame", () => {
  assert.throws(() => encodeLoopingGif([], 4, 4), /at least one frame/u);
  assert.throws(() => encodeLoopingGif([{ data: solidFrame(4, 4, 0), delayMs: 100 }], 0, 4), /dimensions/u);
  assert.throws(() => encodeLoopingGif([{ data: solidFrame(2, 2, 0), delayMs: 100 }], 4, 4), /width×height RGBA/u);
});
