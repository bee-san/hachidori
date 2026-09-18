// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createEmbeddedSpeechCaptureHost } from "../extension/speech-capture.js";

function fixture(capture) {
  let listener = null;
  const timers = new Set();
  const window = {
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    setTimeout(callback) {
      const timer = { callback };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
    chrome: {
      runtime: {
        id: "hachidori-id",
        getURL: path => `chrome-extension://hachidori-id/${path}`,
        onMessage: {
          addListener(value) { listener = value; },
          removeListener(value) {
            if (listener === value) listener = null;
          },
        },
      },
    },
  };
  const dispose = createEmbeddedSpeechCaptureHost(window, { capture });
  const sender = {
    id: "hachidori-id",
    url: "chrome-extension://hachidori-id/offscreen.html",
  };
  const send = (message, customSender = sender) => new Promise((resolve, reject) => {
    const asynchronous = listener(message, customSender, resolve);
    if (!asynchronous) queueMicrotask(() => reject(new Error("message was rejected")));
  });
  return { dispose, get listener() { return listener; }, send, timers, window };
}

test("dedicated extension page returns the captured WAV bytes and selected voice", async () => {
  const calls = [];
  const f = fixture(async (...args) => {
    calls.push(args);
    return {
      data: new Uint8Array(Buffer.from("RIFFaudio")),
      candidate: { name: "Japanese", text: "ねこ", voice: "ja-voice", index: 0 },
    };
  });
  const reply = await f.send({
    target: "hachidori-embedded-speech-capture",
    type: "hd_embedded_speech_capture",
    requestId: "capture-1",
    captureId: "capture-1",
    source: { type: "text-to-speech-reading", voice: "ja-voice" },
    term: { expression: "猫", reading: "ねこ" },
    record: true,
  });
  assert.equal(reply.ok, true);
  assert.equal(Buffer.from(reply.data, "base64").toString(), "RIFFaudio");
  assert.equal(reply.candidate.name, "Japanese");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][4].record, true);
  assert.equal(f.timers.size, 0);
  f.dispose();
  assert.equal(f.listener, null);
});

test("capture page rejects callers outside the exact Hachidori offscreen document", () => {
  const f = fixture(async () => ({ recordingRequired: true }));
  const message = {
    target: "hachidori-embedded-speech-capture",
    type: "hd_embedded_speech_capture",
    requestId: "capture-2",
    captureId: "capture-2",
    record: false,
  };
  assert.equal(f.listener(message, {
    id: "other-extension",
    url: "chrome-extension://hachidori-id/offscreen.html",
  }, () => {}), false);
  assert.equal(f.listener(message, {
    id: "hachidori-id",
    url: "chrome-extension://hachidori-id/settings.html",
  }, () => {}), false);
  f.dispose();
});

test("capture cancellation aborts the active Web Speech operation", async () => {
  let captureSignal;
  const f = fixture(async (_window, _source, _term, signal) => {
    captureSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const capture = f.send({
    target: "hachidori-embedded-speech-capture",
    type: "hd_embedded_speech_capture",
    requestId: "capture-3",
    captureId: "capture-3",
    source: { type: "text-to-speech", voice: "" },
    term: { expression: "猫", reading: "ねこ" },
    record: true,
  });
  await new Promise(resolve => setImmediate(resolve));
  let cancelReply;
  assert.equal(f.listener({
    target: "hachidori-embedded-speech-capture",
    type: "hd_embedded_speech_capture_cancel",
    requestId: "capture-3",
    captureId: "capture-3",
  }, {
    id: "hachidori-id",
    url: "chrome-extension://hachidori-id/offscreen.html",
  }, reply => { cancelReply = reply; }), false);
  assert.equal(cancelReply.ok, true);
  assert.equal(captureSignal.aborted, true);
  const reply = await capture;
  assert.equal(reply.ok, false);
  assert.match(reply.error, /cancelled/u);
  assert.equal(f.timers.size, 0);
  f.dispose();
});
