// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  requestEmbeddedSpeech,
  recordEmbeddedSpeech,
} from "../extension/embedded-speech-capture.js";
import { encodeMonoWav } from "../extension/capture-buffer.js";

function fixture({ audible = true, audioTrack = true, hold = false } = {}) {
  const audioSamples = new Float32Array(800).fill(audible ? 0.25 : 0);
  const tracks = [
    ...(audioTrack ? [{ kind: "audio", stopped: false, stop() { this.stopped = true; } }] : []),
    { kind: "video", stopped: false, stop() { this.stopped = true; } },
  ];
  const stream = {
    getAudioTracks: () => tracks.filter(track => track.kind === "audio"),
    getTracks: () => tracks,
  };
  let processor = null;
  let keepalive = null;
  const outputSamples = new Float32Array(audioSamples.length).fill(0.5);
  const context = {
    sampleRate: 8_000,
    destination: {},
    state: "running",
    closed: false,
    createMediaStreamSource() {
      return {
        connected: null,
        connect(node) { this.connected = node; },
        disconnect() { this.connected = null; },
      };
    },
    createScriptProcessor() {
      processor = {
        onaudioprocess: null,
        connected: null,
        lastConnected: null,
        connect(node) { this.connected = this.lastConnected = node; },
        disconnect() { this.connected = null; },
      };
      return processor;
    },
    createGain() {
      keepalive = {
        gain: { value: 1 },
        connected: null,
        lastConnected: null,
        connect(node) { this.connected = this.lastConnected = node; },
        disconnect() { this.connected = null; },
      };
      return keepalive;
    },
    resume: async () => {},
    close: async () => { context.closed = true; },
  };
  const voice = { voiceURI: "ja-voice", name: "Japanese", lang: "ja-JP" };
  const utterances = [];
  const speech = {
    getVoices: () => [voice],
    cancel() { this.cancelled = (this.cancelled ?? 0) + 1; },
    speak(utterance) {
      utterances.push(utterance);
      if (hold) return;
      queueMicrotask(() => {
        utterance.onstart?.();
        processor.onaudioprocess?.({
          inputBuffer: {
            numberOfChannels: 2,
            length: audioSamples.length,
            sampleRate: context.sampleRate,
            getChannelData: () => audioSamples,
          },
          outputBuffer: {
            numberOfChannels: 1,
            getChannelData: () => outputSamples,
          },
        });
        utterance.onend?.();
      });
    },
  };
  const displayRequests = [];
  const window = {
    AudioContext: class { constructor() { return context; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    navigator: {
      mediaDevices: {
        async getDisplayMedia(constraints) {
          displayRequests.push(constraints);
          return stream;
        },
      },
    },
    speechSynthesis: speech,
  };
  return {
    context,
    displayRequests,
    get keepalive() { return keepalive; },
    outputSamples,
    get processor() { return processor; },
    speech,
    tracks,
    utterances,
    window,
  };
}

const immediateTimer = callback => {
  queueMicrotask(callback);
  return 1;
};

test("embedded speech captures the exact selected voice as a bounded mono WAV", async () => {
  const f = fixture();
  const result = await recordEmbeddedSpeech(f.window,
    { type: "text-to-speech-reading", voice: "ja-voice" },
    { expression: "猫", reading: "ねこ" },
    new AbortController().signal,
    { setTimer: immediateTimer, clearTimer() {}, tailMs: 0 });
  assert.deepEqual(f.displayRequests, [{ audio: true, video: true }]);
  assert.equal(f.utterances[0].text, "ねこ");
  assert.equal(f.utterances[0].voice.name, "Japanese");
  assert.equal(new TextDecoder().decode(result.data.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(result.data.slice(8, 12)), "WAVE");
  const view = new DataView(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8_000);
  assert.equal(result.candidate.name, "Japanese");
  assert.equal(f.keepalive.gain.value, 0);
  assert.equal(f.processor.lastConnected, f.keepalive);
  assert.equal(f.keepalive.lastConnected, f.context.destination);
  assert.ok(f.outputSamples.every(sample => sample === 0));
  assert.equal(f.processor.connected, null);
  assert.equal(f.keepalive.connected, null);
  assert.ok(f.tracks.every(track => track.stopped));
  assert.equal(f.context.closed, true);
  assert.equal(f.speech.cancelled, 1);
});

test("embedded speech prefers host-synthesized WAV bytes and plays those exact bytes", async () => {
  const wav = encodeMonoWav(new Float32Array(800).fill(0.25), 8_000);
  const voice = {
    voiceURI: "Mandarin espeak",
    name: "Mandarin espeak",
    lang: "zh",
    localService: true,
    default: true,
  };
  const syntheses = [];
  const played = [];
  const urls = new Map();
  class Audio {
    set src(value) { this._src = value; }
    get src() { return this._src; }
    play() {
      played.push(urls.get(this.src));
      queueMicrotask(() => this.onended?.());
      return Promise.resolve();
    }
    pause() {}
    removeAttribute() { this._src = ""; }
    load() {}
  }
  const window = {
    Audio,
    Blob,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    URL: {
      createObjectURL(blob) {
        const url = `blob:${urls.size}`;
        urls.set(url, blob);
        return url;
      },
      revokeObjectURL(url) { urls.delete(url); },
    },
    atob: value => Buffer.from(value, "base64").toString("binary"),
    gsmHachidoriSpeech: {
      async synthesize(request) {
        syntheses.push(request);
        return { ok: true, data: Buffer.from(wav).toString("base64") };
      },
    },
    navigator: {
      mediaDevices: {
        async getDisplayMedia() {
          throw new Error("frame capture must not run after native synthesis");
        },
      },
    },
    speechSynthesis: {
      getVoices: () => [voice],
    },
  };
  const result = await recordEmbeddedSpeech(window,
    { type: "text-to-speech-reading", voice: voice.voiceURI },
    { expression: "食べる", reading: "たべる" },
    new AbortController().signal);
  assert.deepEqual(result.data, wav);
  assert.equal(result.candidate.name, voice.name);
  assert.deepEqual(syntheses, [{
    text: "たべる",
    voice,
  }]);
  assert.equal(played.length, 1);
  assert.deepEqual(new Uint8Array(await played[0].arrayBuffer()), wav);
  assert.equal(urls.size, 0);
});

test("an authoritative host synthesis failure does not fall through to playback-only frame audio", async () => {
  const voice = { voiceURI: "voice", name: "Voice", lang: "ja-JP" };
  let displayRequests = 0;
  const window = {
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    gsmHachidoriSpeech: {
      async synthesize() {
        return { ok: false, error: "injected synthesis failure" };
      },
    },
    navigator: {
      mediaDevices: {
        async getDisplayMedia() {
          displayRequests += 1;
          throw new Error("unexpected frame capture");
        },
      },
    },
    speechSynthesis: {
      getVoices: () => [voice],
    },
  };
  await assert.rejects(recordEmbeddedSpeech(window,
    { type: "text-to-speech", voice: voice.voiceURI },
    { expression: "猫", reading: "ねこ" },
    new AbortController().signal),
  /injected synthesis failure/u);
  assert.equal(displayRequests, 0);
});

test("embedded speech preflight stays silent and does not request frame capture", async () => {
  const f = fixture();
  const result = await recordEmbeddedSpeech(f.window,
    { type: "text-to-speech", voice: "ja-voice" },
    { expression: "猫", reading: "ねこ" },
    new AbortController().signal,
    { record: false });
  assert.deepEqual(result, { recordingRequired: true });
  assert.deepEqual(f.displayRequests, []);
  assert.deepEqual(f.utterances, []);
});

test("embedded speech reports missing frame-capture APIs as a type error", async () => {
  const f = fixture();
  delete f.window.navigator.mediaDevices.getDisplayMedia;
  await assert.rejects(recordEmbeddedSpeech(f.window,
    { type: "text-to-speech", voice: "" },
    { expression: "猫", reading: "ねこ" },
    new AbortController().signal),
  error => error instanceof TypeError && /capture is unavailable/u.test(error.message));
});

test("embedded speech rejects silent capture and releases every media resource", async () => {
  const f = fixture({ audible: false });
  await assert.rejects(recordEmbeddedSpeech(f.window,
    { type: "text-to-speech", voice: "" },
    { expression: "猫", reading: "ねこ" },
    new AbortController().signal,
    { setTimer: immediateTimer, clearTimer() {}, tailMs: 0 }),
  /did not capture audible browser text-to-speech/u);
  assert.ok(f.tracks.every(track => track.stopped));
  assert.equal(f.context.closed, true);
});

test("embedded speech rejects a frame without an audio track and releases its stream", async () => {
  const f = fixture({ audioTrack: false });
  await assert.rejects(recordEmbeddedSpeech(f.window,
    { type: "text-to-speech", voice: "" },
    { expression: "猫", reading: "ねこ" },
    new AbortController().signal),
  error => error instanceof TypeError && /audio track/u.test(error.message));
  assert.ok(f.tracks.every(track => track.stopped));
  assert.equal(f.context.closed, false);
});

test("cancelling embedded speech stops the utterance and frame capture", async () => {
  const f = fixture({ hold: true });
  const controller = new AbortController();
  const pending = recordEmbeddedSpeech(f.window,
    { type: "text-to-speech", voice: "" },
    { expression: "猫", reading: "ねこ" },
    controller.signal,
    { setTimer: immediateTimer, clearTimer() {}, tailMs: 0 });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.ok(f.tracks.every(track => track.stopped));
  assert.equal(f.context.closed, true);
  assert.equal(f.speech.cancelled, 2);
});

test("offscreen mining receives byte-backed speech from the host page", async () => {
  const messages = [];
  const window = {
    atob: value => Buffer.from(value, "base64").toString("binary"),
    crypto: { randomUUID: () => "capture-1" },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return {
            ok: true,
            data: Buffer.from("RIFFaudio").toString("base64"),
            candidate: { name: "Japanese", text: "ねこ", voice: "ja-voice", index: 0 },
          };
        },
      },
    },
  };
  const result = await requestEmbeddedSpeech(window,
    { type: "text-to-speech-reading", voice: "ja-voice" },
    { expression: "猫", reading: "ねこ" },
    new AbortController().signal);
  assert.equal(Buffer.from(result.data).toString(), "RIFFaudio");
  assert.equal(result.candidate.name, "Japanese");
  assert.deepEqual(messages, [{
    target: "hachidori-embedded-speech-capture",
    type: "hd_embedded_speech_capture",
    requestId: "capture-1",
    captureId: "capture-1",
    source: { type: "text-to-speech-reading", voice: "ja-voice" },
    term: { expression: "猫", reading: "ねこ" },
    record: true,
  }]);
});

test("aborting an offscreen request asks the host to stop its capture", async () => {
  let resolveCapture;
  const messages = [];
  const window = {
    atob: value => Buffer.from(value, "base64").toString("binary"),
    crypto: { randomUUID: () => "capture-2" },
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          if (message.type === "hd_embedded_speech_capture_cancel") return Promise.resolve({ ok: true });
          return new Promise(resolve => { resolveCapture = resolve; });
        },
      },
    },
  };
  const controller = new AbortController();
  const pending = requestEmbeddedSpeech(window,
    { type: "text-to-speech", voice: "ja-voice" },
    { expression: "猫", reading: "ねこ" },
    controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(messages.at(-1).type, "hd_embedded_speech_capture_cancel");
  resolveCapture({ ok: false, error: "cancelled" });
});
