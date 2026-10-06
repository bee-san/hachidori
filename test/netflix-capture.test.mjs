// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { SENTENCE_PAD_MS, clipSamples, createNetflixCaptureService, encodeMonoWav, isSilent,
  mediaClockOffset } from "../extension/netflix-capture.js";

test("the media clock offset is the median of the page's (wall, media) pairs", () => {
  assert.equal(mediaClockOffset([[10_000, 1000], [10_101, 1100], [10_200, 1200]]), 9000);
  // A pair from before the seek settled cannot move it; malformed pairs are ignored.
  assert.equal(mediaClockOffset([[10_000, 1000], [10_100, 1100], [10_200, 1200], [10_250, 50_000], ["x", 1], [1]]), 9000);
  assert.equal(mediaClockOffset([[0, 0], [10, 20]]), -5);
  assert.equal(mediaClockOffset([]), null);
  assert.equal(mediaClockOffset(undefined), null);
});

test("a clip is exactly the recorded samples between two wall-clock times", () => {
  // 1 kHz: frame n is at originMs + n ms.
  const ramp = (start, length) => Float32Array.from({ length }, (_, index) => (start + index) / 1000);
  const chunks = [{ startFrame: 0, samples: ramp(0, 100) }, { startFrame: 100, samples: ramp(100, 100) }];
  assert.deepEqual([...clipSamples(chunks, { originMs: 5000, sampleRate: 1000, startMs: 5050, endMs: 5150 })],
    [...ramp(50, 100)]);
  // Frames nobody recorded stay silent, and the range is clamped to the recording.
  const gap = [{ startFrame: 0, samples: ramp(0, 10) }, { startFrame: 20, samples: ramp(20, 10) }];
  assert.deepEqual([...clipSamples(gap, { originMs: 0, sampleRate: 1000, startMs: -50, endMs: 100 })],
    [...ramp(0, 10), ...new Array(10).fill(0), ...ramp(20, 10)]);
  assert.equal(clipSamples(chunks, { originMs: 5000, sampleRate: 1000, startMs: 6000, endMs: 7000 }), null);
  assert.equal(clipSamples([], { originMs: 0, sampleRate: 1000, startMs: 0, endMs: 10 }), null);
  assert.equal(clipSamples(chunks, { originMs: null, sampleRate: 1000, startMs: 0, endMs: 10 }), null);
});

test("only exact zeros are silence, and the WAV is 16-bit mono PCM of the clip", () => {
  assert.equal(isSilent(new Float32Array(48)), true);
  assert.equal(isSilent(Float32Array.of(0, 0, 1e-7)), false);
  const wav = Buffer.from(encodeMonoWav(Float32Array.of(0, 0.5, -0.5, 1, -1, 2), 48_000));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.deepEqual([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28),
    wav.readUInt16LE(32), wav.readUInt16LE(34)], [1, 1, 48_000, 96_000, 2, 16]);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 12);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(index => wav.readInt16LE(44 + index * 2)), [0, 16383, -16384, 32767, -32768, 32767]);
  assert.throws(() => encodeMonoWav([0], 48_000), /Float32/u);
  assert.throws(() => encodeMonoWav(new Float32Array(1), 0), /sample rate/u);
});

// The offscreen document's media stack, enough to drive one recording: a tab
// stream, an AudioContext at 1 kHz whose clock reads 2 s at resume, and the
// worklet's port, through which the test delivers frames.
function captureWindow() {
  const stopped = [];
  const connections = [];
  const record = { stream: null, constraints: null, worklet: null, port: null, closed: false, timers: [] };
  const node = name => ({ name, connect(target) { connections.push([name, target.name]); return target; } });
  class AudioWorkletNode {
    constructor(context, processor) {
      this.name = processor;
      this.port = { onmessage: null, posted: [], postMessage(message) {
        this.posted.push(message);
        if (message.flush) queueMicrotask(() => this.onmessage({ data: { flushed: true } }));
      } };
      record.port = this.port;
    }
    connect(target) { connections.push([this.name, target.name]); return target; }
  }
  const window = {
    performance: { timeOrigin: 1_000_000, now: () => 500 },
    navigator: { mediaDevices: { async getUserMedia(constraints) {
      record.constraints = constraints;
      record.stream = { getTracks: () => [{ stop: () => stopped.push("audio") }] };
      return record.stream;
    } } },
    AudioContext: class {
      constructor() { this.sampleRate = 1000; this.currentTime = 2; this.destination = node("destination"); }
      audioWorklet = { addModule: async url => { record.worklet = url; } };
      createMediaStreamSource() { return node("source"); }
      createGain() { return { ...node("silence"), gain: { value: 1 } }; }
      async resume() {}
      async close() { record.closed = true; }
    },
    AudioWorkletNode,
    setTimeout: (callback, ms) => { record.timers.push({ callback, ms }); return record.timers.length; },
    clearTimeout: () => {},
  };
  return { window, record, stopped, connections };
}

test("a recording plays the tab on, trims to the cue's padded media time and stops the stream", async () => {
  const { window, record, stopped, connections } = captureWindow();
  const service = createNetflixCaptureService(window);
  assert.deepEqual(await service({ type: "hd_netflix_record_start", sessionId: "s1", streamId: "stream", limitMs: 60_000 }),
    { padMs: SENTENCE_PAD_MS });
  assert.deepEqual(record.constraints, { audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: "stream" } }, video: false });
  assert.match(record.worklet, /netflix-capture-worklet\.js$/u);
  assert.deepEqual(connections, [["source", "destination"], ["source", "hachidori-netflix-audio"],
    ["hachidori-netflix-audio", "silence"], ["silence", "destination"]], "the tab stays audible while it is recorded");
  assert.deepEqual(record.timers.map(timer => timer.ms), [60_000]);
  // Wall clock origin: 1_000_000 + 500 - 2 s of context time. Frame n is at 998_500 + n ms.
  const samples = Float32Array.from({ length: 4000 }, (_, index) => (index % 100) / 200 + 0.001);
  record.port.onmessage({ data: { startFrame: 0, samples: samples.slice(0, 2000).buffer } });
  record.port.onmessage({ data: { startFrame: 2000, samples: samples.slice(2000).buffer } });
  // The page played media 1000 ms at wall 999_000, so the cue 1000–2000 ms with
  // its 250 ms pads spans wall 998_750–1_000_250: frames 250–1750.
  const finished = await service({ type: "hd_netflix_record_finish", sessionId: "s1", startMs: 1000, endMs: 2000,
    anchors: [[999_000, 1000], [999_500, 1500]] });
  assert.deepEqual(record.port.posted, [{ flush: true }]);
  assert.deepEqual(stopped, ["audio"]);
  assert.equal(record.closed, true);
  const wav = Buffer.from(finished.data, "base64");
  assert.equal(finished.silent, false);
  assert.equal(wav.readUInt32LE(40), 1500 * 2);
  assert.deepEqual([...Array(1500).keys()].map(index => wav.readInt16LE(44 + index * 2)),
    [...samples.slice(250, 1750)].map(sample => Math.trunc(sample * 0x7fff)));
  await assert.rejects(service({ type: "hd_netflix_record_finish", sessionId: "s1", startMs: 1000, endMs: 2000,
    anchors: [[999_000, 1000]] }), /replaced or stopped/u);
});

test("silence, a line that never played, a stale session and an abandoned recording are told apart", async () => {
  const silent = captureWindow();
  const service = createNetflixCaptureService(silent.window);
  await service({ type: "hd_netflix_record_start", sessionId: "s1", streamId: "stream", limitMs: 1000 });
  silent.record.port.onmessage({ data: { startFrame: 0, samples: new Float32Array(3000).buffer } });
  assert.deepEqual(await service({ type: "hd_netflix_record_finish", sessionId: "s1", startMs: 1000, endMs: 1500,
    anchors: [[999_000, 1000]] }), { silent: true });

  const never = captureWindow();
  const second = createNetflixCaptureService(never.window);
  await second({ type: "hd_netflix_record_start", sessionId: "s2", streamId: "stream", limitMs: 1000 });
  await assert.rejects(second({ type: "hd_netflix_record_finish", sessionId: "s2", startMs: 0, endMs: 1, anchors: [] }),
    /did not play the line/u);
  assert.deepEqual(never.stopped, ["audio"], "a failed finish still stops the stream");

  // An unfinished recording stops itself and cannot be finished afterwards.
  const abandoned = captureWindow();
  const third = createNetflixCaptureService(abandoned.window);
  await third({ type: "hd_netflix_record_start", sessionId: "s3", streamId: "stream", limitMs: 1000 });
  abandoned.record.timers[0].callback();
  assert.deepEqual(abandoned.stopped, ["audio"]);
  await assert.rejects(third({ type: "hd_netflix_record_finish", sessionId: "s3", startMs: 0, endMs: 1, anchors: [[1, 1]] }),
    /replaced or stopped/u);
  // A newer recording replaces an older one, and cancel stops only its own.
  await third({ type: "hd_netflix_record_start", sessionId: "s4", streamId: "stream", limitMs: 1000 });
  await third({ type: "hd_netflix_record_start", sessionId: "s5", streamId: "stream", limitMs: 1000 });
  assert.deepEqual(abandoned.stopped, ["audio", "audio"]);
  assert.deepEqual(await third({ type: "hd_netflix_record_cancel", sessionId: "s4" }), { cancelled: true });
  assert.deepEqual(abandoned.stopped, ["audio", "audio"]);
  await third({ type: "hd_netflix_record_cancel", sessionId: "s5" });
  assert.deepEqual(abandoned.stopped, ["audio", "audio", "audio"]);
  await assert.rejects(third({ type: "hd_netflix_record_start", sessionId: "s6", streamId: "", limitMs: 1000 }), /invalid/u);
  await assert.rejects(third({ type: "hd_netflix_record_start", sessionId: "s6", streamId: "stream" }), /invalid/u);
  await assert.rejects(third({ type: "hd_unknown" }), /Unknown Netflix recording request/u);
});
