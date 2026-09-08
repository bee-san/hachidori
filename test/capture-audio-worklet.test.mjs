// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function processorFixture() {
  const messages = [];
  let Processor;
  class AudioWorkletProcessor {
    constructor() { this.port = { postMessage: message => messages.push(message) }; }
  }
  const context = vm.createContext({ AudioWorkletProcessor, Float32Array, currentFrame: 0,
    registerProcessor: (_name, value) => { Processor = value; } });
  vm.runInContext(readFileSync(new URL("../extension/capture-audio-worklet.js", import.meta.url), "utf8"), context);
  const processor = new Processor();
  return { messages, process(frame, channels) {
    context.currentFrame = frame;
    return processor.process([channels]);
  } };
}

test("worklet permits startup without input and preserves the first active sample anchor", () => {
  const f = processorFixture();
  const channels = [new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.75)];
  f.process(0, []);
  f.process(128, []);
  for (let frame = 256; frame < 2304; frame += 128) f.process(frame, channels);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].startFrame, 256);
  assert.deepEqual(new Float32Array(f.messages[0].samples), new Float32Array(2048).fill(0.5));
});

test("worklet refuses an empty-input quantum instead of collapsing a gap into its partial batch", () => {
  const f = processorFixture();
  const channels = [new Float32Array(128).fill(0.25)];
  for (let quantum = 0; quantum < 17; quantum += 1) {
    f.process(quantum * 128, quantum === 4 ? [] : channels);
  }
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].error, /clock was interrupted/u);
  assert.equal(f.messages[0].samples, undefined);
});

test("worklet reports a jumped sample clock once and never resumes that capture epoch", () => {
  const f = processorFixture();
  const channels = [new Float32Array(128)];
  f.process(0, channels);
  f.process(256, channels);
  for (let frame = 384; frame < 4096; frame += 128) f.process(frame, channels);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].error, /clock was interrupted/u);
});
