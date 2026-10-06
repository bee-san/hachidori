// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { GIF_MAX_FPS, encodeLoopingGif, selectGifFrames } from "../extension/netflix-gif.js";
import { readGif } from "./gif-structure.mjs";

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

test("the encoded GIF loops forever and its frames share the one global palette", () => {
  const width = 8;
  const height = 6;
  const entries = [
    { data: solidFrame(width, height, 20), delayMs: 100 },
    { data: solidFrame(width, height, 120), delayMs: 80 },
    { data: solidFrame(width, height, 220), delayMs: 100 },
  ];
  const gif = readGif(encodeLoopingGif(entries, width, height));
  assert.equal(gif.width, width);
  assert.equal(gif.height, height);
  // The NETSCAPE2.0 application extension with a repeat count of 0 loops forever.
  assert.equal(gif.loop, 0, "the loop count is 0 (forever)");
  // One palette for the line, quantised from every frame: a palette per frame
  // made a few seconds of real video take seconds to encode.
  assert.equal(gif.globalColorTable, true);
  assert.deepEqual(gif.frames.map(frame => frame.localColorTable), [false, false, false]);
});

test("each frame's delay is written in centiseconds in its graphic control extension", () => {
  const entries = [{ data: solidFrame(4, 4, 30), delayMs: 100 }, { data: solidFrame(4, 4, 90), delayMs: 50 }];
  assert.deepEqual(readGif(encodeLoopingGif(entries, 4, 4)).frames.map(frame => frame.delayCs), [10, 5]);
});

test("encoding rejects a frame that is not width×height RGBA", () => {
  assert.throws(() => encodeLoopingGif([{ data: solidFrame(4, 4, 0), delayMs: 100 },
    { data: solidFrame(2, 2, 0), delayMs: 100 }], 4, 4), /width×height RGBA/u);
});
