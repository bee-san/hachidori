// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { recordCapturedSpeech } from "../extension/capture-speech.js";

function fixture({ audible = true, hold = false } = {}) {
  let now = 1000;
  const selections = [];
  const utterances = [];
  const voice = { voiceURI: "ja-voice", name: "Japanese", lang: "ja-JP" };
  const speech = {
    getVoices: () => [voice],
    cancel() { this.cancelled = (this.cancelled ?? 0) + 1; },
    speak(utterance) {
      utterances.push(utterance);
      if (hold) return;
      queueMicrotask(() => {
        utterance.onstart?.();
        now = 1100;
        utterance.onend?.();
      });
    },
  };
  const window = {
    speechSynthesis: speech,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
  };
  const session = {
    assertAudioCapture() { this.checked = true; },
    selectAudio(startMs, endMs) {
      selections.push({ startMs, endMs });
      return { sampleRate: 8000, samples: new Float32Array(800).fill(audible ? 0.25 : 0) };
    },
  };
  return { window, session, speech, utterances, selections, now: () => now };
}

test("captured speech uses the exact selected reading voice and returns canonical WAV bytes", async () => {
  const f = fixture();
  const result = await recordCapturedSpeech(f.window, f.session,
    { type: "text-to-speech-reading", voice: "ja-voice" },
    { expression: "猫", reading: "ねこ" }, new AbortController().signal,
    { now: f.now, preRollMs: 0, tailMs: 0, drainMs: 0 });
  assert.equal(f.session.checked, true);
  assert.equal(f.utterances[0].text, "ねこ");
  assert.equal(f.utterances[0].voice.name, "Japanese");
  assert.deepEqual(f.selections, [{ startMs: 1000, endMs: 1100 }]);
  assert.equal(new TextDecoder().decode(result.data.slice(0, 4)), "RIFF");
  assert.equal(result.candidate.name, "Japanese");
  assert.equal(f.speech.cancelled, 1);
});

test("captured speech rejects silence that indicates the selected share did not hear TTS", async () => {
  const f = fixture({ audible: false });
  await assert.rejects(recordCapturedSpeech(f.window, f.session,
    { type: "text-to-speech", voice: "" }, { expression: "猫", reading: "ねこ" },
    new AbortController().signal, { now: f.now, preRollMs: 0, tailMs: 0, drainMs: 0 }),
  /did not hear browser text-to-speech/u);
});

test("cancelling captured speech stops its utterance and never reads a partial interval", async () => {
  const f = fixture({ hold: true });
  const controller = new AbortController();
  const pending = recordCapturedSpeech(f.window, f.session,
    { type: "text-to-speech", voice: "" }, { expression: "猫", reading: "ねこ" },
    controller.signal, { now: f.now, preRollMs: 0, tailMs: 0, drainMs: 0 });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(f.speech.cancelled, 2);
  assert.deepEqual(f.selections, []);
});
