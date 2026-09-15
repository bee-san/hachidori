// SPDX-License-Identifier: GPL-3.0-or-later
import { selectedAudioPlan } from "./audio-repository.js";
import { ankiMediaFilename } from "./anki-resources.js";
import { escapeAnkiHtml } from "./anki-templates.js";

const MIME_EXTENSIONS = { "audio/aac": "aac", "audio/flac": "flac", "audio/mp4": "m4a", "audio/mpeg": "mp3",
  "audio/ogg": "ogg", "audio/wav": "wav", "audio/webm": "webm", "audio/x-wav": "wav", "application/ogg": "ogg" };

async function base64(window, blob, signal) {
  signal.throwIfAborted();
  const reader = new window.FileReader();
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      reader.onerror = () => reject(reader.error);
      abort = () => { reader.abort(); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      reader.readAsDataURL(blob);
    });
  } finally {
    signal.removeEventListener("abort", abort);
    reader.onload = reader.onerror = null;
  }
}

async function candidateFile(window, repository, candidate, signal) {
  const lease = await repository.acquire(candidate, signal);
  let audio, abort;
  try {
    signal.throwIfAborted();
    audio = new window.Audio();
    audio.preload = "auto";
    await new Promise((resolve, reject) => {
      audio.onloadeddata = resolve;
      audio.onerror = () => { lease.invalidate(); reject(new Error("The pronunciation could not be decoded.")); };
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      audio.src = lease.url;
      audio.load();
    });
    signal.throwIfAborted();
    const suffix = new URL(candidate.url).pathname.split(".").at(-1).toLowerCase();
    const mime = lease.blob.type.split(";")[0].toLowerCase();
    const fallbackExtension = /^[a-z0-9]+$/u.test(suffix) ? suffix : "bin";
    const extension = Object.hasOwn(MIME_EXTENSIONS, mime) ? MIME_EXTENSIONS[mime] : fallbackExtension;
    const bytes = await lease.blob.arrayBuffer();
    signal.throwIfAborted();
    const filename = await ankiMediaFilename(bytes, extension);
    const data = await base64(window, lease.blob, signal);
    signal.throwIfAborted();
    return { filename, data, candidate };
  } finally {
    if (audio) {
      signal.removeEventListener("abort", abort);
      audio.onloadeddata = audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    lease.release();
  }
}

function ankiTtsField(source, term) {
  const text = source.type === "text-to-speech-reading" ? term.reading || term.expression : term.expression;
  const escaped = escapeAnkiHtml(text).replaceAll("[", "&#91;").replaceAll("]", "&#93;");
  return `[anki:tts lang=ja_JP cloze_blank="[...]"]${escaped}[/anki:tts]`;
}

export function ankiAudioFieldValue(audio) {
  if (typeof audio?.fieldValue === "string" && audio.fieldValue !== "") return audio.fieldValue;
  if (typeof audio?.filename === "string" && audio.filename !== "") return `[sound:${audio.filename}]`;
  throw new Error("The pronunciation source returned no Anki audio value.");
}

// Read-only planning stays separate from popup playback. Native TTS returns a
// deterministic Anki field value; downloadable bytes and their digest stay
// paired through duplicate checking and later upload.
export async function exportAnkiAudio(window, repository, {
  sources,
  term,
  selection,
}, signal) {
  const plan = selection ? await selectedAudioPlan(repository, sources, term, selection, signal) : { sources };
  let failure;
  for (const source of plan.sources) {
    if (source.type.startsWith("text-to-speech")) {
      return { fieldValue: ankiTtsField(source, term), sourceId: source.id };
    }
    try {
      const candidates = plan.candidate ? [plan.candidate] : await repository.candidates(source, term, signal);
      for (const [index, candidate] of candidates.entries()) {
        try {
          return { ...await candidateFile(window, repository, { ...candidate, index: candidate.index ?? index }, signal), sourceId: source.id };
        } catch (error) { signal.throwIfAborted(); failure = error; }
      }
    } catch (error) { signal.throwIfAborted(); failure = error; }
  }
  throw failure ?? new Error("No downloadable pronunciation is available for this result.");
}
