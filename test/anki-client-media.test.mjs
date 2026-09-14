// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_LIMITS, MAX_LINKED_SCREENSHOT_BYTES, MAX_LINKED_SPEECH_BYTES,
  decodedBase64Length, validateLinkedAnkiClientMedia,
} from "../extension/anki-client-media.js";

const SCREENSHOT = "hachidori-screenshot-123e4567-e89b-42d3-a456-426614174000.jpg";
const SPEECH = `hachidori_${"a".repeat(64)}.wav`;
const speechPlan = {
  sourceId: "default-tts",
  sourceKey: JSON.stringify({ id: "default-tts", enabled: true, type: "text-to-speech-reading", url: "", voice: "" }),
  expression: "猫",
  reading: "ねこ",
};
const request = () => ({
  screenshot: { token: "screen-token", filename: SCREENSHOT },
  captureJobId: "job-1",
  capturePin: {
    animationFilename: "hachidori-abc123.avif",
    audioFilename: "hachidori-abc123.wav",
  },
  captureUnavailable: [],
  clientSpeech: speechPlan,
});
const envelope = () => ({
  screenshot: { token: "screen-token", filename: SCREENSHOT, data: "/9j/2Q==" },
  capture: {
    jobId: "job-1",
    warnings: ["source warning"],
    assets: {
      animation: { filename: "hachidori-abc123.avif", byteLength: 2, data: "AQI=" },
      audio: { filename: "hachidori-abc123.wav", byteLength: 1, data: "Aw==" },
    },
  },
  speech: { ...speechPlan, filename: SPEECH, byteLength: 4, data: "UklGRg==" },
});

test("linked screenshot, captured media and browser-speech WAV bytes are allowlisted against their request", () => {
  assert.equal(decodedBase64Length("AQI="), 2);
  assert.equal(decodedBase64Length("Aw=="), 1);
  assert.equal(decodedBase64Length("not base64"), null);
  assert.deepEqual(validateLinkedAnkiClientMedia(request(), envelope()), envelope());
});

test("missing, stale, malformed and mismatched linked media is rejected", () => {
  assert.throws(() => validateLinkedAnkiClientMedia(request(), {}), /missing media/u);
  const stale = envelope();
  stale.screenshot.token = "other";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), stale), /screenshot.*stale/u);
  const filename = envelope();
  filename.capture.assets.animation.filename = "hachidori-other.avif";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), filename), /animation.*stale/u);
  const malformed = envelope();
  malformed.capture.assets.audio.data = "***=";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), malformed), /audio.*invalid/u);
  const staleSpeech = envelope();
  staleSpeech.speech.sourceId = "other";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), staleSpeech), /browser-speech.*stale/u);
  const notWav = envelope();
  notWav.speech.data = "AQIDBA==";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), notWav), /browser-speech.*invalid/u);
  const notJpeg = envelope();
  notJpeg.screenshot.data = "AQI=";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), notJpeg), /screenshot.*invalid/u);
  const length = envelope();
  length.capture.assets.animation.byteLength = 1;
  assert.throws(() => validateLinkedAnkiClientMedia(request(), length), /animation.*invalid/u);
  const extra = envelope();
  extra.endpoint = "https://client.invalid";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), extra), /client-media envelope.*invalid/u);
});

test("linked media enforces the screenshot, AVIF and WAV byte limits", () => {
  const screenshot = request();
  delete screenshot.captureJobId;
  delete screenshot.clientSpeech;
  const screenshotMedia = {
    screenshot: {
      token: "screen-token",
      filename: SCREENSHOT,
      data: Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.alloc(MAX_LINKED_SCREENSHOT_BYTES - 2),
      ]).toString("base64"),
    },
  };
  assert.throws(() => validateLinkedAnkiClientMedia(screenshot, screenshotMedia), /screenshot.*size limit/u);

  for (const kind of ["animation", "audio"]) {
    const value = request();
    delete value.screenshot;
    delete value.clientSpeech;
    value.captureUnavailable = kind === "animation" ? ["audio"] : ["animation"];
    const bytes = Buffer.alloc(CAPTURE_LIMITS[kind] + 1);
    const media = { capture: { jobId: "job-1", warnings: [], assets: {
      [kind]: {
        filename: value.capturePin[kind === "animation" ? "animationFilename" : "audioFilename"],
        byteLength: bytes.byteLength,
        data: bytes.toString("base64"),
      },
    } } };
    assert.throws(() => validateLinkedAnkiClientMedia(value, media), new RegExp(`${kind}.*size limit`, "u"));
  }

  const speech = request();
  delete speech.screenshot;
  delete speech.captureJobId;
  const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(MAX_LINKED_SPEECH_BYTES)]);
  const media = { speech: {
    ...speechPlan,
    filename: SPEECH,
    byteLength: bytes.byteLength,
    data: bytes.toString("base64"),
  } };
  assert.throws(() => validateLinkedAnkiClientMedia(speech, media), /browser-speech.*size limit/u);
});

test("unavailable capture outputs may be omitted without inventing media", () => {
  const value = request();
  delete value.screenshot;
  delete value.clientSpeech;
  value.captureUnavailable = ["audio"];
  const media = envelope();
  delete media.screenshot;
  delete media.speech;
  delete media.capture.assets.audio;
  assert.deepEqual(validateLinkedAnkiClientMedia(value, media), media);
});
