// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { audioSourceUrl, parseAudioSourceList } from "../extension/audio-sources.js";

const { DEFAULT_OPTIONS, normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
const source = (id, patch = {}) => ({ id, type: "custom", enabled: true, url: "", voice: "", ...patch });

test("audio source options retain ordered enabled and disabled rows without a source-count cap", () => {
  assert.deepEqual(DEFAULT_OPTIONS.audioSources, []);
  const sources = Array.from({ length: 33 }, (_, index) => source(String(index), { enabled: index % 2 === 0,
    type: ["custom", "custom-json", "text-to-speech", "text-to-speech-reading"][index % 4] }));
  assert.deepEqual(validateOptionsPatch({ audioSources: sources }), { audioSources: sources });
  assert.deepEqual(normaliseOptions({ audioSources: sources }).audioSources, sources);
});

test("audio source options reject invalid types and duplicate row identities", () => {
  for (const sources of [null, {}, [source("")], [source("a"), source("a")],
    [source("a", { type: "jisho" })], [source("a", { enabled: "true" })], [source("a", { voice: null })]]) {
    assert.throws(() => validateOptionsPatch({ audioSources: sources }));
  }
});

test("audio URL templates encode term, expression, reading and language without changing stored text", () => {
  const url = "https://example.test/audio/{expression}?term={term}&reading={reading}&lang={language}&unknown={unknown}";
  assert.equal(audioSourceUrl(url, { expression: "聞く &!'", reading: "きく/" }),
    "https://example.test/audio/%E8%81%9E%E3%81%8F%20%26%21%27?term=%E8%81%9E%E3%81%8F%20%26%21%27&reading=%E3%81%8D%E3%81%8F%2F&lang=ja&unknown={unknown}");
  assert.equal(audioSourceUrl("http://localhost:5050/?term={term}", { expression: "食", reading: "" }),
    "http://localhost:5050/?term=%E9%A3%9F");
  for (const value of ["file:///tmp/audio.wav", "javascript:alert(1)", "https://user:secret@example.test/",
    "https://{term}.example.test/audio", "https://example.test/\nsecret"]) {
    assert.throws(() => audioSourceUrl(value, { expression: "聞く", reading: "きく" }));
  }
});

test("Yomitan audio lists preserve ordered named candidates and distinguish empty from malformed results", () => {
  const candidates = [{ url: "https://example.test/one.mp3", name: "Tokyo" },
    { url: "https://example.test/two.mp3" }, { url: "https://example.test/one.mp3", name: "Tokyo" }];
  assert.deepEqual(parseAudioSourceList({ type: "audioSourceList", audioSources: candidates }),
    candidates.map(item => ({ name: "", ...item })));
  assert.deepEqual(parseAudioSourceList({ type: "audioSourceList", audioSources: [] }), []);
  for (const value of [null, [], { type: "wrong", audioSources: [] }, { type: "audioSourceList", audioSources: [{}] },
    { type: "audioSourceList", audioSources: [{ url: "data:audio/wav;base64,AAAA" }] }]) {
    assert.throws(() => parseAudioSourceList(value));
  }
});
