// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGsmTexthookerMessage,
  parsePlainTexthookerMessage,
  parseTexthookerMessage,
} from "../extension/texthooker-protocol.js";

test("plain texthooker accepts only live non-JSON text and ignores acknowledgements", () => {
  assert.deepEqual(parsePlainTexthookerMessage("猫がいる"), { type: "line", text: "猫がいる" });
  for (const value of ["", "  ", "True", "False", "{\"sentence\":\"history\"}", null]) {
    assert.equal(parsePlainTexthookerMessage(value), null);
  }
  assert.equal(parsePlainTexthookerMessage("x".repeat(4097)), null);
  assert.equal(parsePlainTexthookerMessage("x".repeat(64 * 1024 + 1)), null);
});

test("GSM texthooker accepts the explicit text_received schema and preserves occurrence identity", () => {
  const payload = { event: "text_received", sentence: "猫がいる", data: {
    id: "line-1", text: "ignored fallback", session_id: "session-1", history: false,
    translation: "there is a cat",
  } };
  assert.deepEqual(parseGsmTexthookerMessage(JSON.stringify(payload)), {
    type: "line", id: "line-1", sessionId: "session-1", text: "猫がいる",
  });
  assert.deepEqual(parseGsmTexthookerMessage({ event: "reset_checkboxes" }), { type: "reset" });
});

test("GSM parser ignores snapshots, history, translations, malformed and unrelated events", () => {
  const base = { event: "text_received", sentence: "猫", data: {
    id: "line-1", session_id: "session-1", history: false,
  } };
  for (const value of [
    "not json",
    { ...base, event: "audio_ready" },
    { ...base, data: { ...base.data, history: true } },
    { ...base, data: { ...base.data, id: "" } },
    { ...base, data: { ...base.data, session_id: "" } },
    { event: "translation", sentence: "cat" },
    { ...base, sentence: "x".repeat(4097) },
    [{ ...base }],
  ]) assert.equal(parseGsmTexthookerMessage(value), null);
  assert.throws(() => parseTexthookerMessage("future", "text"), /unsupported/u);
});
