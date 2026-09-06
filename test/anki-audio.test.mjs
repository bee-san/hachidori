// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAudioRepository } from "../extension/audio-repository.js";
import { exportAnkiAudio } from "../extension/anki-audio.js";

const term = { expression: "猫", reading: "ねこ" };
const source = { id: "json", enabled: true, type: "custom-json", url: "https://example.test/list", voice: "" };
function fixture() {
  const downloads = [], probes = [], revoked = [];
  const candidates = [{ url: "https://example.test/bad.wav", name: "Invalid" }, { url: "https://example.test/good.wav", name: "Tokyo" }];
  const window = {
    URL: { createObjectURL(blob) { return `blob:${blob.size}`; }, revokeObjectURL(url) { revoked.push(url); } },
    FileReader: class {
      readAsDataURL(blob) { blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`; this.onload(); }); }
    },
    Audio: class {
      constructor() { probes.push(this); }
      load() { if (this.src) queueMicrotask(() => this.src === "blob:3" ? this.onerror?.() : this.onloadeddata?.()); }
      play() { assert.fail("Mining must not play audio"); }
      pause() { this.paused = true; }
      removeAttribute() { this.src = ""; }
    },
  };
  const repository = createAudioRepository({ window, fetch: async url => {
    if (url === source.url) return { ok: true, json: async () => ({ type: "audioSourceList", audioSources: candidates }) };
    downloads.push(url);
    return { ok: true, blob: async () => new Blob([url.endsWith("bad.wav") ? "bad" : "good audio"], { type: "audio/wav" }) };
  } });
  return { window, repository, downloads, probes, revoked, candidates };
}

test("Anki exports the first decodable pronunciation without playback and reuses the shared warm media", async () => {
  const f = fixture();
  try {
    const request = { sources: [source], term };
    const result = await exportAnkiAudio(f.window, f.repository, request, new AbortController().signal);
    assert.equal(result.candidate.name, "Tokyo");
    assert.equal(result.sourceId, source.id);
    assert.match(result.filename, /^hachidori_[0-9a-f]{64}\.wav$/u);
    assert.equal(Buffer.from(result.data, "base64").toString(), "good audio");
    assert.equal(f.downloads.length, 2);
    assert.ok(f.probes.every(probe => probe.paused && probe.src === ""));
    const selection = { sourceId: source.id, sourceKey: JSON.stringify(source), ...term, index: 1, ...f.candidates[1] };
    const again = await exportAnkiAudio(f.window, f.repository, { ...request, selection }, new AbortController().signal);
    assert.equal(again.filename, result.filename);
    assert.equal(f.downloads.length, 2, "selected warm media is not redownloaded");
    await assert.rejects(exportAnkiAudio(f.window, f.repository, { ...request, selection: { ...selection, name: "Changed" } },
      new AbortController().signal), /choices changed/u);
  } finally { f.repository.clear(); }
});

test("selected TTS warns without inventing audio or substituting a different pronunciation", async () => {
  const f = fixture();
  const speech = { ...source, id: "tts", type: "text-to-speech-reading", url: "" };
  const selection = { sourceId: speech.id, sourceKey: JSON.stringify(speech), ...term, index: 0, name: "System default", url: null };
  await assert.rejects(exportAnkiAudio(f.window, f.repository, { term, sources: [speech, source], selection },
    new AbortController().signal), /Browser text-to-speech cannot be attached/u);
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(f.probes, []);
});
