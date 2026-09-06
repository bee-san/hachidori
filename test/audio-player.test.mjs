// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAudioPlayer } from "../extension/audio-player.js";

const term = { expression: "聞く", reading: "きく" };
const source = { id: "source", type: "custom", enabled: true, url: "https://example.test/{reading}.wav", voice: "" };

function environment({ failFirst = false, hold = false } = {}) {
  const audio = [], revoked = [], utterances = [];
  let voiceReads = 0;
  const voice = { voiceURI: "ja-voice", name: "Japanese", lang: "ja-JP" };
  const window = {
    Audio: class {
      constructor(src) { this.src = src; this.error = { code: 4 }; audio.push(this); }
      play() {
        if (!hold) queueMicrotask(() => {
          if (failFirst && audio.length === 1) this.onerror?.();
          else this.onended?.();
        });
        return Promise.resolve();
      }
      pause() { this.paused = true; }
      removeAttribute() { this.src = ""; }
      load() { this.released = true; }
    },
    URL: { createObjectURL: () => `blob:${audio.length}`, revokeObjectURL: url => revoked.push(url) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {
      getVoices() { voiceReads += 1; return [voice]; },
      speak(utterance) { this.active = utterance; utterances.push(utterance); if (!hold) queueMicrotask(() => utterance.onend?.()); },
      cancel() { if (this.active) this.active.cancelled = true; this.active = null; },
    },
  };
  return { window, audio, revoked, utterances, voice, voiceReads: () => voiceReads };
}

test("source testing tries ordered JSON candidates through real player cleanup, not just successful downloads", async () => {
  const env = environment({ failFirst: true });
  const requests = [];
  const player = createAudioPlayer({ window: env.window, fetch: async (url, options) => {
    requests.push({ url, credentials: options.credentials });
    return url.endsWith(".json") ? { ok: true, json: async () => ({ type: "audioSourceList", audioSources: [
      { url: "https://example.test/invalid.wav", name: "First" }, { url: "https://example.test/valid.wav", name: "Second" },
    ] }) } : { ok: true, blob: async () => new Blob(["audio"], { type: "audio/wav" }) };
  } });
  const result = await player.play({ ...source, type: "custom-json", url: "https://example.test/list.json" }, term);
  assert.equal(result.status, "success");
  assert.equal(result.candidate.name, "Second");
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.credentials === "omit"));
  assert.deepEqual(env.revoked, ["blob:0", "blob:1"]);
  assert.ok(env.audio.every(audio => audio.paused && audio.released && audio.src === ""));
  assert.equal(env.voiceReads(), 0);
});

test("an accepted play promise is not a completed Test and stopping releases only its current audio", async () => {
  const env = environment({ hold: true });
  const player = createAudioPlayer({ window: env.window, fetch: async () => ({ ok: true, blob: async () => new Blob(["audio"]) }) });
  let settled = false;
  const pending = player.play(source, term).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  player.stop();
  assert.equal((await pending).status, "cancelled");
  assert.deepEqual(env.revoked, ["blob:0"]);
  assert.ok(env.audio[0].paused && env.audio[0].released);
});

test("a newer Test cancels pending discovery without letting its reply disturb newer playback", async () => {
  const env = environment();
  let aborted = false;
  const player = createAudioPlayer({ window: env.window, fetch: async (url, { signal }) => {
    if (url.endsWith("pending.json")) return new Promise((_, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    });
    return { ok: true, blob: async () => new Blob(["audio"]) };
  } });
  const old = player.play({ ...source, type: "custom-json", url: "https://example.test/pending.json" }, term);
  const current = player.play(source, term);
  assert.equal((await old).status, "cancelled");
  assert.equal((await current).status, "success");
  assert.equal(aborted, true);
  assert.equal(env.audio.length, 1);
});

test("Tests distinguish empty candidate lists from provider failures and use the selected TTS voice and text", async () => {
  const env = environment();
  const player = createAudioPlayer({ window: env.window, fetch: async url => url.includes("empty")
    ? { ok: true, json: async () => ({ type: "audioSourceList", audioSources: [] }) }
    : { ok: false, status: 503 } });
  assert.equal((await player.play({ ...source, type: "custom-json", url: "https://example.test/empty" }, term)).status, "no-result");
  await assert.rejects(player.play(source, term), /503/u);
  for (const type of ["text-to-speech", "text-to-speech-reading"]) {
    assert.equal((await player.play({ ...source, type, voice: "ja-voice" }, term)).status, "success");
  }
  assert.deepEqual(env.utterances.map(utterance => utterance.text), ["聞く", "きく"]);
  assert.ok(env.utterances.every(utterance => utterance.voice === env.voice && utterance.lang === "ja-JP"));
});

test("retiring an old speech Test cannot cancel the newer utterance", async () => {
  const env = environment({ hold: true });
  const player = createAudioPlayer({ window: env.window, fetch: () => assert.fail("TTS must not fetch audio") });
  const speech = { ...source, type: "text-to-speech", voice: "ja-voice" };
  const old = player.play(speech, term);
  const current = player.play(speech, { ...term, expression: "新しい" });
  try {
    assert.equal((await old).status, "cancelled");
    assert.equal(env.utterances[1].cancelled, undefined);
    env.utterances[1].onend();
    assert.equal((await current).status, "success");
  } finally { player.stop(); }
});
