// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeBase64 } from "./base64.js";

// Experimental Netflix mining, the offscreen document's side. While the page
// replays one subtitle line, this records the tab's audio from a
// chrome.tabCapture stream, then cuts the line out of it by the media times the
// page reported and encodes a mono WAV for Anki. Only that WAV leaves here.

// The audio kept before and after the cue.
export const SENTENCE_PAD_MS = 250;
// How long the worklet has to hand over its last samples.
const FLUSH_TIMEOUT_MS = 1000;

// Wall-clock minus media time while the line played at 1×: the median of the
// page's (wall ms, media ms) pairs, so a stale pair from the seek cannot move it.
export function mediaClockOffset(anchors) {
  const offsets = (Array.isArray(anchors) ? anchors : [])
    .filter(pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite))
    .map(([wall, media]) => wall - media)
    .sort((left, right) => left - right);
  if (offsets.length === 0) return null;
  const middle = Math.floor(offsets.length / 2);
  return offsets.length % 2 === 1 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
}

// The recorded samples between two wall-clock times. Chunks carry the context
// frame of their first sample; frame 0 is at `originMs`. Missing frames stay
// silent, and the range is clamped to what was recorded.
export function clipSamples(chunks, { originMs, sampleRate, startMs, endMs }) {
  if (!Number.isFinite(originMs) || !(sampleRate > 0) || !(endMs > startMs) || chunks.length === 0) return null;
  let recordedStart = Infinity;
  let recordedEnd = -Infinity;
  for (const chunk of chunks) {
    recordedStart = Math.min(recordedStart, chunk.startFrame);
    recordedEnd = Math.max(recordedEnd, chunk.startFrame + chunk.samples.length);
  }
  const from = Math.max(recordedStart, Math.round((startMs - originMs) * sampleRate / 1000));
  const to = Math.min(recordedEnd, Math.round((endMs - originMs) * sampleRate / 1000));
  if (!(to > from)) return null;
  const output = new Float32Array(to - from);
  for (const chunk of chunks) {
    const begin = Math.max(from, chunk.startFrame);
    const end = Math.min(to, chunk.startFrame + chunk.samples.length);
    if (end > begin) output.set(chunk.samples.subarray(begin - chunk.startFrame, end - chunk.startFrame), begin - from);
  }
  return output;
}

// Protected playback can deliver a stream of exact zeros. Quiet audio is not silence.
export const isSilent = samples => samples.every(sample => sample === 0);

function setAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.codePointAt(index));
}

// 16-bit mono PCM WAV, revived from the removed media recorder's capture-buffer.js.
export function encodeMonoWav(samples, sampleRate) {
  if (!(samples instanceof Float32Array)) throw new Error("WAV input must be mono Float32 samples.");
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("The WAV sample rate is invalid.");
  const byteLength = 44 + samples.length * 2;
  const output = new ArrayBuffer(byteLength);
  const view = new DataView(output);
  setAscii(view, 0, "RIFF");
  view.setUint32(4, byteLength - 8, true);
  setAscii(view, 8, "WAVE");
  setAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  setAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(output);
}

export function createNetflixCaptureService(window, {
  now = () => window.performance.timeOrigin + window.performance.now(),
} = {}) {
  let session = null;

  function stop(current) {
    window.clearTimeout(current.timer);
    for (const track of current.stream.getTracks()) track.stop();
    current.context?.close().catch(() => {});
    if (session === current) session = null;
  }

  function owned(sessionId) {
    if (session === null || session.sessionId !== sessionId) {
      throw new Error("The recording of this line was replaced or stopped.");
    }
    return session;
  }

  async function start({ sessionId, streamId, limitMs }) {
    if (typeof sessionId !== "string" || typeof streamId !== "string" || streamId === ""
        || !Number.isFinite(limitMs) || limitMs <= 0) throw new Error("The Netflix recording request is invalid.");
    if (session !== null) stop(session);
    const stream = await window.navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    const current = { sessionId, stream, context: null, node: null, chunks: [], originMs: null, timer: null, flushed: null };
    session = current;
    try {
      const context = new window.AudioContext({ latencyHint: "interactive" });
      current.context = context;
      await context.audioWorklet.addModule(new URL("./netflix-capture-worklet.js", import.meta.url).href);
      const source = context.createMediaStreamSource(stream);
      // A captured tab goes quiet for the user; its sound plays on from here.
      source.connect(context.destination);
      const node = new window.AudioWorkletNode(context, "hachidori-netflix-audio");
      node.port.onmessage = ({ data }) => {
        if (data?.samples instanceof ArrayBuffer) {
          current.chunks.push({ startFrame: data.startFrame, samples: new Float32Array(data.samples) });
        } else if (data?.flushed === true) current.flushed?.();
      };
      const silence = context.createGain();
      silence.gain.value = 0;
      source.connect(node).connect(silence).connect(context.destination);
      await context.resume();
      current.originMs = now() - context.currentTime * 1000;
      current.node = node;
      // A recording nobody finishes still ends, which gives the tab its sound back.
      current.timer = window.setTimeout(() => stop(current), limitMs);
    } catch (error) {
      stop(current);
      throw error;
    }
    return { padMs: SENTENCE_PAD_MS };
  }

  function flush(current) {
    return new Promise(resolve => {
      const timer = window.setTimeout(resolve, FLUSH_TIMEOUT_MS);
      current.flushed = () => {
        window.clearTimeout(timer);
        resolve();
      };
      current.node.port.postMessage({ flush: true });
    });
  }

  async function finish({ sessionId, startMs, endMs, anchors }) {
    const current = owned(sessionId);
    const sampleRate = current.context.sampleRate;
    try {
      await flush(current);
    } finally {
      stop(current);
    }
    const offset = mediaClockOffset(anchors);
    if (offset === null) throw new Error("Netflix did not play the line, so nothing was recorded.");
    const samples = clipSamples(current.chunks, { originMs: current.originMs, sampleRate,
      startMs: startMs - SENTENCE_PAD_MS + offset, endMs: endMs + SENTENCE_PAD_MS + offset });
    if (samples === null) throw new Error("No audio was recorded while the line played.");
    if (isSilent(samples)) return { silent: true };
    return { silent: false, data: encodeBase64(encodeMonoWav(samples, sampleRate)) };
  }

  return async message => {
    switch (message.type) {
      case "hd_netflix_record_start": return start(message);
      case "hd_netflix_record_finish": return finish(message);
      case "hd_netflix_record_cancel":
        if (session?.sessionId === message.sessionId) stop(session);
        return { cancelled: true };
      default: throw new Error("Unknown Netflix recording request.");
    }
  };
}
