// SPDX-License-Identifier: GPL-3.0-or-later
import { createAudioPlayer } from "./audio-player.js";

const TEST_TERM = { expression: "聞く", reading: "きく" };
// Matches the reference Settings Test deadline; ordinary dictionary work never
// waits on this timer or the pronunciation's network/audio callbacks.
const TEST_TIMEOUT_MS = 15_000;

export function createAudioService(window) {
  const player = createAudioPlayer({ window, fetch: window.fetch.bind(window) });
  let active = null;
  let watchingVoices = false;

  function voices() {
    if (!watchingVoices) {
      window.speechSynthesis.addEventListener("voiceschanged", () => {
        window.chrome.runtime.sendMessage({ target: "hachidori-audio-ui", type: "hd_audio_voices_changed", voices: voices() })
          .catch(() => {}); // The Settings page may already have closed.
      });
      watchingVoices = true;
    }
    return window.speechSynthesis.getVoices().map(({ voiceURI, name, lang, localService, default: isDefault }) =>
      ({ voiceURI, name, lang, localService, default: isDefault }));
  }

  return async message => {
    if (message.type === "hd_audio_voices") return { voices: voices() };
    if (message.type === "hd_audio_stop") {
      if (active && active.owner === message.owner && active.requestId === message.playRequestId) player.stop();
      return { status: "cancelled" };
    }
    if (message.type !== "hd_audio_test") throw new Error("Unknown audio request.");
    const operation = { owner: message.owner, requestId: message.requestId };
    active = operation;
    const timer = window.setTimeout(() => {
      if (active === operation) player.stop(new Error("Audio Test timed out after 15 seconds."));
    }, TEST_TIMEOUT_MS);
    try { return await player.play(message.source, TEST_TERM); }
    finally {
      window.clearTimeout(timer);
      if (active === operation) active = null;
    }
  };
}
