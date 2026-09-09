// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAnkiOffscreenService } from "../extension/anki-offscreen.js";

test("Anki offscreen keeps TTS preflight silent and returns its captured WAV on submission", async () => {
  const requests = [];
  const source = { id: "tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "ja-voice" };
  const term = { expression: "猫", reading: "ねこ" };
  const service = createAnkiOffscreenService({
    AbortSignal,
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then(bytes => {
          this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
          this.onload();
        });
      }
    },
  }, async () => ({}), async (selected, selectedTerm, _signal, options) => {
    requests.push({ selected, selectedTerm, options });
    if (!options.record) return { recordingRequired: true };
    return { data: new Uint8Array([1, 2, 3, 4]),
      candidate: { name: "Japanese", text: "ねこ", voice: "ja-voice", index: 0 } };
  });
  assert.deepEqual(await service({ type: "hd_anki_audio", sources: [source], term, recordSpeech: false }),
    { recordingRequired: true });
  const recorded = await service({ type: "hd_anki_audio", sources: [source], term, recordSpeech: true });
  assert.equal(recorded.sourceId, source.id);
  assert.equal(recorded.candidate.text, term.reading);
  assert.equal(Buffer.from(recorded.data, "base64").toString("hex"), "01020304");
  assert.deepEqual(requests.map(request => request.options.record), [false, true]);
});
