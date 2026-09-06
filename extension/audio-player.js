// SPDX-License-Identifier: GPL-3.0-or-later
import { audioSourceUrl, parseAudioSourceList } from "./audio-sources.js";

// One pronunciation owner; URLs and native speech callbacks never outlive the
// operation that created them. This runs in the offscreen document, not WASM.
export function createAudioPlayer({ window, fetch }) {
  let current = null;

  function stop(reason = new DOMException("Playback stopped.", "AbortError")) {
    current?.abort(reason);
    current = null;
  }

  async function response(url, signal) {
    const result = await fetch(url, { credentials: "omit", signal });
    if (!result.ok) throw new Error(`Audio provider returned HTTP ${result.status}.`);
    return result;
  }

  async function playUrl(candidate, signal) {
    const blob = await (await response(candidate.url, signal)).blob();
    signal.throwIfAborted();
    // Fetching in extension origin then playing one owned blob also works with
    // the extension's COEP policy when a provider has no CORP response header.
    const url = window.URL.createObjectURL(blob);
    const audio = new window.Audio(url);
    let abort;
    const ended = new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error("The pronunciation could not be decoded or played."));
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.all([Promise.resolve().then(() => audio.play()), ended]);
    } finally {
      signal.removeEventListener("abort", abort);
      audio.onended = audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      window.URL.revokeObjectURL(url);
    }
  }

  async function playSpeech(source, term, signal) {
    const speech = window.speechSynthesis;
    const voices = speech.getVoices();
    if (voices.length === 0) throw new Error("No speech voices are available in this browser.");
    const text = source.type === "text-to-speech-reading" ? term.reading || term.expression : term.expression;
    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    const voice = voices.find(voice => voice.voiceURI === source.voice || voice.name === source.voice);
    if (source.voice && !voice) throw new Error("The selected speech voice is no longer available. Choose another voice in Audio Settings.");
    if (voice) utterance.voice = voice;
    let abort;
    try {
      await new Promise((resolve, reject) => {
        utterance.onend = resolve;
        utterance.onerror = () => reject(new Error("Text-to-speech could not be played."));
        abort = () => {
          // Cancel synchronously, before a newer operation can speak. A late
          // finally calling global speech.cancel() would stop that new voice.
          utterance.onend = utterance.onerror = null;
          speech.cancel();
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        speech.speak(utterance);
      });
      return { name: voice?.name || "System default", text, voice: source.voice };
    } finally {
      signal.removeEventListener("abort", abort);
      utterance.onend = utterance.onerror = null;
    }
  }

  async function candidates(source, term, signal) {
    if (!source.url) return [];
    const url = audioSourceUrl(source.url, term);
    if (source.type === "custom") return [{ url, name: "" }];
    if (source.type !== "custom-json") throw new Error("Unknown audio source type.");
    return parseAudioSourceList(await (await response(url, signal)).json());
  }

  async function firstPlayable(found, signal) {
    let failure;
    for (const entry of found) {
      try {
        await playUrl(entry, signal);
        return entry;
      } catch (error) {
        signal.throwIfAborted();
        failure = error;
      }
    }
    throw failure;
  }

  return {
    stop,
    async play(source, term) {
      stop();
      const controller = new AbortController();
      current = controller;
      const { signal } = controller;
      try {
        let candidate;
        if (source.type === "text-to-speech" || source.type === "text-to-speech-reading") {
          candidate = await playSpeech(source, term, signal);
        } else {
          const found = await candidates(source, term, signal);
          signal.throwIfAborted();
          if (found.length === 0) return { status: "no-result" };
          candidate = await firstPlayable(found, signal);
        }
        signal.throwIfAborted();
        return { status: "success", sourceId: source.id, candidate };
      } catch (error) {
        if (signal.aborted && signal.reason?.name === "AbortError") return { status: "cancelled" };
        throw signal.aborted ? signal.reason : error;
      } finally {
        if (current === controller) current = null;
      }
    },
  };
}
