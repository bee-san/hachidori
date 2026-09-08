// SPDX-License-Identifier: GPL-3.0-or-later
import { buildAnkiResourceFields } from "./anki-resources.js";
import { exportAnkiAudio } from "./anki-audio.js";

// Parse the complete notesInfo response away from the background and engine
// request threads; only compact words cross back to the serialized cache commit.
async function refreshMatureWords(window, source) {
  const worker = new window.Worker(new URL("./anki-maturity-worker.js", import.meta.url), { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve({ words: data.words });
      worker.onerror = event => reject(new Error(event.message || "Anki maturity refresh worker failed."));
      worker.postMessage(source);
    });
  } finally {
    worker.terminate();
  }
}

export function createAnkiOffscreenService(window, getAudioRepository) {
  return async message => {
    if (message.type === "hd_anki_maturity_refresh") return refreshMatureWords(window, message.source);
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
