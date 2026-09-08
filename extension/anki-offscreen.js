// SPDX-License-Identifier: GPL-3.0-or-later
import { buildAnkiResourceFields } from "./anki-resources.js";
import { exportAnkiAudio } from "./anki-audio.js";

export function createAnkiOffscreenService(window, getAudioRepository) {
  return async message => {
    if (message.type === "hd_anki_audio") {
      return exportAnkiAudio(window, await getAudioRepository(), message, window.AbortSignal.timeout(30_000));
    }
    if (message.type !== "hd_anki_fields") throw new Error("Unknown Anki rendering request.");
    return buildAnkiResourceFields(message.request, message.templates, {
      document: window.document, dictionaryPaths: message.dictionaryPaths, audio: message.audio,
      styles: async () => {
        const reply = await window.chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_styles", requestId: message.requestId });
        if (!reply.ok || reply.generation !== message.request.generation) throw new Error(reply.error || "Dictionary styles changed during Anki preparation.");
        return reply.styles;
      },
    });
  };
}
