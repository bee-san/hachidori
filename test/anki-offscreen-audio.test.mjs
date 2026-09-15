// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAnkiOffscreenService } from "../extension/anki-offscreen.js";

test("Anki offscreen returns native host TTS without consulting media capture", async () => {
  const source = { id: "tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "browser-voice" };
  const service = createAnkiOffscreenService({ AbortSignal }, async () => ({}));
  assert.deepEqual(await service({
    type: "hd_anki_audio",
    sources: [source],
    term: { expression: "猫", reading: "ねこ" },
  }), {
    fieldValue: "[anki:tts lang=ja_JP cloze_blank=\"[...]\"]ねこ[/anki:tts]",
    sourceId: source.id,
  });
});
