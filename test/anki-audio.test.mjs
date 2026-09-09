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

test("selected TTS records the exact browser voice through active capture without substituting another source", async () => {
  const f = fixture();
  const speech = { ...source, id: "tts", type: "text-to-speech-reading", url: "" };
  const selection = { sourceId: speech.id, sourceKey: JSON.stringify(speech), ...term, index: 0, name: "Automatic Japanese", url: null };
  const recordings = [];
  const result = await exportAnkiAudio(f.window, f.repository, { term, sources: [speech, source], selection },
    new AbortController().signal, { recordSpeechAudio: async (selected, selectedTerm, _signal, options) => {
      recordings.push({ selected, selectedTerm, options });
      return { data: new Uint8Array([1, 2, 3, 4]),
        candidate: { name: "Japanese", text: "ねこ", voice: "", index: 0 } };
    } });
  assert.equal(result.sourceId, speech.id);
  assert.equal(result.candidate.text, "ねこ");
  assert.equal(Buffer.from(result.data, "base64").toString("hex"), "01020304");
  assert.match(result.filename, /^hachidori_[0-9a-f]{64}\.wav$/u);
  assert.deepEqual(recordings, [{ selected: speech, selectedTerm: term, options: { record: true } }]);
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(f.probes, []);
});

test("silent TTS preflight defers exact audio while recording failures fall through to URL sources", async () => {
  const f = fixture();
  const speech = { ...source, id: "tts", type: "text-to-speech-reading", url: "" };
  const deferred = await exportAnkiAudio(f.window, f.repository, { term, sources: [speech, source], recordSpeech: false },
    new AbortController().signal, { recordSpeechAudio: async (_source, _term, _signal, { record }) => {
      assert.equal(record, false);
      return { recordingRequired: true };
    } });
  assert.deepEqual(deferred, { recordingRequired: true });
  assert.deepEqual(f.downloads, [], "preflight must not choose a lower-priority source than submission");
  const fallback = await exportAnkiAudio(f.window, f.repository, { term, sources: [speech, source] },
    new AbortController().signal, { recordSpeechAudio: async () => {
      throw new Error("The active media capture has no shared audio.");
    } });
  assert.equal(fallback.sourceId, source.id);
  assert.equal(fallback.candidate.name, "Tokyo");
});

test("selected TTS reports active-capture failures instead of substituting a different pronunciation", async () => {
  const f = fixture();
  const speech = { ...source, id: "tts", type: "text-to-speech-reading", url: "" };
  const selection = { sourceId: speech.id, sourceKey: JSON.stringify(speech), ...term, index: 0, name: "Automatic Japanese", url: null };
  await assert.rejects(exportAnkiAudio(f.window, f.repository, { term, sources: [speech, source], selection },
    new AbortController().signal, { recordSpeechAudio: async () => {
      throw new Error("Start media capture with shared audio before attaching browser text-to-speech to Anki.");
    } }), /Start media capture with shared audio/u);
  assert.deepEqual(f.downloads, []);
});

test("cancelling Anki media encoding aborts its reader and releases the playback-independent lease", { timeout: 1000 }, async () => {
  const f = fixture();
  const started = Promise.withResolvers();
  let aborted = false;
  f.window.FileReader = class {
    readAsDataURL() { started.resolve(); }
    abort() { aborted = true; }
  };
  const controller = new AbortController();
  const pending = exportAnkiAudio(f.window, f.repository, { sources: [source], term }, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(aborted, true);
  assert.ok(f.probes.every(probe => probe.paused && probe.src === ""));
  f.repository.clear();
  assert.deepEqual(f.revoked, ["blob:3", "blob:10"]);
});
