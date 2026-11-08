// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { encodeSentenceAudio, levelGain, sentenceAudioBase64 } from "../extension/sentence-audio.js";

const tone = (amplitude, seconds = 1, rate = 48_000) => Float32Array.from({ length: rate * seconds },
  (_, index) => amplitude * Math.sin(2 * Math.PI * 440 * index / rate));
const dbfs = value => 20 * Math.log10(value);
const rms = samples => Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);

test("a line is levelled to -20 dBFS mean, as far as its loudest sample stays at or under -1 dBFS", () => {
  // A quiet line and a loud one come out at the same level.
  for (const amplitude of [0.001, 0.05, 0.9]) {
    const line = tone(amplitude);
    assert.ok(Math.abs(dbfs(rms(line) * levelGain(line)) + 20) < 0.01, `a ${amplitude} sine reaches -20 dBFS`);
  }
  // A click in a quiet line limits it: the click stops at -1 dBFS.
  const clicked = tone(0.001);
  clicked[100] = 0.5;
  assert.ok(Math.abs(dbfs(0.5 * levelGain(clicked)) + 1) < 0.01);
  assert.ok(dbfs(rms(clicked) * levelGain(clicked)) < -20);
  assert.equal(levelGain(new Float32Array(10)), 1);
});

test("a line is a mono MP3 at 64 kbit/s, about 8 kB a second, at the sound's own rate", async () => {
  for (const [rate, rateBits] of [[48_000, 0b01], [44_100, 0b00]]) {
    const mp3 = await encodeSentenceAudio(tone(0.05, 2, rate), rate);
    // MPEG-1 Layer III without CRC, 64 kbit/s, mono.
    assert.deepEqual([mp3[0], mp3[1]], [0xff, 0xfb]);
    assert.equal(mp3[2] >> 4, 0b0101);
    assert.equal((mp3[2] >> 2) & 0b11, rateBits);
    assert.equal(mp3[3] >> 6, 0b11);
    // Two seconds, plus the encoder's delay and its last frame.
    assert.ok(mp3.length >= 16_000 && mp3.length < 17_000, `${mp3.length} bytes`);
  }
  assert.match(await sentenceAudioBase64(tone(0.05), 48_000), /^\/[+/]/u, "how the worker knows an MP3");
  await assert.rejects(encodeSentenceAudio([0], 48_000), /Float32/u);
  await assert.rejects(encodeSentenceAudio(new Float32Array(1), 0), /sample rate/u);
});
