// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LINKED_SCREENSHOT_BYTES, MAX_LINKED_SPEECH_BYTES,
  decodedBase64Length, validateLinkedAnkiClientMedia,
} from "../extension/anki-client-media.js";

const SCREENSHOT = "hachidori-screenshot-123e4567-e89b-42d3-a456-426614174000.jpg";
const SPEECH = `hachidori_${"a".repeat(64)}.wav`;
const speechPlan = {
  sourceId: "default-tts", sourceKey: "voice-1", expression: "猫", reading: "ねこ",
};
const request = () => ({ screenshot: { token: "screen-token", filename: SCREENSHOT },
  captureUnavailable: [], clientSpeech: speechPlan });
const envelope = () => ({ screenshot: { token: "screen-token", filename: SCREENSHOT, data: "/9j/2Q==" },
  speech: { ...speechPlan, filename: SPEECH, byteLength: 4, data: "UklGRg==" } });

test("linked screenshot and browser-speech WAV bytes are allowlisted against the request", () => {
  assert.equal(decodedBase64Length("AQI="), 2);
  assert.equal(decodedBase64Length("not base64"), null);
  assert.deepEqual(validateLinkedAnkiClientMedia(request(), envelope()), envelope());
  assert.throws(() => validateLinkedAnkiClientMedia(request(), { ...envelope(), capture: {} }), /client-media envelope.*invalid/u);
});

test("missing, stale and malformed linked media is rejected", () => {
  assert.throws(() => validateLinkedAnkiClientMedia(request(), {}), /missing media/u);
  const stale = envelope(); stale.screenshot.token = "other";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), stale), /screenshot.*stale/u);
  const staleSpeech = envelope(); staleSpeech.speech.sourceId = "other";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), staleSpeech), /browser-speech.*stale/u);
  const notWav = envelope(); notWav.speech.data = "AQIDBA==";
  assert.throws(() => validateLinkedAnkiClientMedia(request(), notWav), /browser-speech.*invalid/u);
});

test("linked screenshots and speech retain their size limits", () => {
  const screenshot = request(); delete screenshot.clientSpeech;
  const screenshotMedia = { screenshot: { token: "screen-token", filename: SCREENSHOT,
    data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_LINKED_SCREENSHOT_BYTES - 2)]).toString("base64") } };
  assert.throws(() => validateLinkedAnkiClientMedia(screenshot, screenshotMedia), /screenshot.*size limit/u);
  const speech = request(); delete speech.screenshot;
  const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(MAX_LINKED_SPEECH_BYTES)]);
  const media = { speech: { ...speechPlan, filename: SPEECH, byteLength: bytes.byteLength, data: bytes.toString("base64") } };
  assert.throws(() => validateLinkedAnkiClientMedia(speech, media), /browser-speech.*size limit/u);
});
