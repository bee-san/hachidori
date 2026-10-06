// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { SENTENCE_PAD_MS, clipSamples, createAudioFrameClock, createNetflixRecorder, encodeMonoWav, isSilent,
  mediaClockOffset } from "../extension/netflix-capture.js";
import { readGif } from "./gif-structure.mjs";

test("the media clock offset is the median of the page's (wall, media) pairs", () => {
  assert.equal(mediaClockOffset([[10_000, 1000], [10_101, 1100], [10_200, 1200]]), 9000);
  // A pair from before the seek settled cannot move it; malformed pairs are ignored.
  assert.equal(mediaClockOffset([[10_000, 1000], [10_100, 1100], [10_200, 1200], [10_250, 50_000], ["x", 1], [1]]), 9000);
  assert.equal(mediaClockOffset([[0, 0], [10, 20]]), -5);
  assert.equal(mediaClockOffset([]), null);
  assert.equal(mediaClockOffset(undefined), null);
});

test("captured blocks are placed by counted samples on the page clock, or on the raw clock they arrived in", () => {
  // Page-relative timestamps: frame 0 is at timeOrigin + the first timestamp.
  const page = createAudioFrameClock({ timeOrigin: 1_000_000, now: () => 1_000_120 });
  assert.equal(page.place({ timestampUs: 100_000, frames: 480, sampleRate: 48_000 }), 0);
  assert.equal(page.originMs, 1_000_100);
  // Privacy-rounded timestamps of contiguous blocks keep the sample count.
  assert.equal(page.place({ timestampUs: 110_100, frames: 480, sampleRate: 48_000 }), 480);
  assert.equal(page.place({ timestampUs: 119_900, frames: 480, sampleRate: 48_000 }), 960);
  // A real gap moves the count.
  assert.equal(page.place({ timestampUs: 200_000, frames: 480, sampleRate: 48_000 }), 4800);
  assert.equal(page.endFrame, 5280);
  // A raw monotonic timestamp far from the page clock is anchored at arrival.
  const raw = createAudioFrameClock({ timeOrigin: 1_000_000, now: () => 1_000_500 });
  assert.equal(raw.place({ timestampUs: 9_000_000_000, frames: 480, sampleRate: 48_000 }), 0);
  assert.equal(raw.originMs, 1_000_490);
  assert.equal(raw.place({ timestampUs: 9_000_010_000, frames: 480, sampleRate: 48_000 }), 480);
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

// The recorder frame's media stack: tabCapture, a tab stream, and a track
// processor whose blocks the test delivers. The page clock reads `clock.now`.
function recorderWindow({ grant = true } = {}) {
  const clock = { now: 2_000_000 };
  const record = { streamIds: [], constraints: null, stopped: 0, cancelled: 0, timers: [], push: null };
  const blocks = [];
  let wake = null;
  const window = {
    performance: { timeOrigin: 1_000_000, now: () => clock.now - 1_000_000 },
    chrome: { tabCapture: { async getMediaStreamId({ targetTabId }) {
      record.streamIds.push(targetTabId);
      if (!grant) throw new Error("Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.");
      return "stream-id";
    } } },
    navigator: { mediaDevices: { async getUserMedia(constraints) {
      record.constraints = constraints;
      const track = { stop: () => { record.stopped++; } };
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    } } },
    MediaStreamTrackProcessor: class {
      constructor({ track }) {
        assert.ok(track);
        this.readable = { getReader: () => ({
          read: () => new Promise(resolve => {
            if (blocks.length) resolve(blocks.shift());
            else wake = resolve;
          }),
          cancel: async () => { record.cancelled++; wake?.({ done: true }); },
        }) };
      }
    },
    setTimeout: (callback, ms) => {
      if (ms >= 1000) { record.timers.push({ callback, ms }); return record.timers.length; }
      return setTimeout(callback, 0);
    },
    clearTimeout: () => {},
  };
  // One block of `frames` samples at 1 kHz, stereo with equal channels.
  record.push = (timestampMs, frames, value) => {
    const block = { value: { timestamp: timestampMs * 1000, numberOfFrames: frames, numberOfChannels: 2, sampleRate: 1000,
      copyTo(plane) { plane.fill(value); }, close() {} }, done: false };
    if (wake) { const resolve = wake; wake = null; resolve(block); } else blocks.push(block);
  };
  return { window, record, clock };
}

const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });

test("the recorder opens its own tab's stream, trims to the cue's padded media time and stops the stream", async () => {
  const { window, record, clock } = recorderWindow();
  const recorder = createNetflixRecorder(window);
  assert.deepEqual(await recorder.start({ targetTabId: 7, limitMs: 60_000 }), { padMs: SENTENCE_PAD_MS });
  assert.deepEqual(record.streamIds, [7]);
  assert.deepEqual(record.constraints, { audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: "stream-id" } }, video: false });
  assert.deepEqual(record.timers.map(timer => timer.ms), [60_000]);
  // Page-relative timestamps: the block at 1_000 ms is at wall 1_001_000 and
  // arrives as it ends. Each 100-frame block is 100 ms at 1 kHz with its own level.
  clock.now = 1_001_100;
  for (let block = 0; block < 30; block++) record.push(1000 + block * 100, 100, (block + 1) / 64);
  await tick();
  clock.now = 1_001_000 + 3000;
  // The page played media 1000 ms at wall 1_001_500: the cue 1000–2000 ms with
  // its 250 ms pads is wall 1_001_250–1_002_750, frames 250–1750.
  const clip = await recorder.finish({ startMs: 1000, endMs: 2000, anchors: [[1_001_500, 1000], [1_002_000, 1500]] });
  assert.equal(clip.silent, false);
  assert.ok(record.stopped >= 1 && record.cancelled >= 1, "the stream and its reader are stopped");
  const wav = Buffer.from(clip.data, "base64");
  assert.equal(wav.readUInt32LE(24), 1000);
  assert.equal(wav.readUInt32LE(40), 1500 * 2);
  const levels = [...Array(1500).keys()].map(index => wav.readInt16LE(44 + index * 2));
  assert.equal(levels[0], Math.trunc(3 / 64 * 0x7fff), "the clip starts in the block holding frame 250");
  assert.equal(levels.at(-1), Math.trunc(18 / 64 * 0x7fff), "and ends in the block holding frame 1749");
  await assert.rejects(recorder.finish({ startMs: 1000, endMs: 2000, anchors: [[1, 1]] }), /replaced or stopped/u);
});

test("a missing grant, silence, a line that never played and an abandoned recording are told apart", async () => {
  const ungranted = recorderWindow({ grant: false });
  assert.deepEqual(await createNetflixRecorder(ungranted.window).start({ targetTabId: 7, limitMs: 1000 }), { unavailable: "grant" });
  assert.equal(ungranted.record.constraints, null, "no stream is opened without a grant");

  const silent = recorderWindow();
  const recorder = createNetflixRecorder(silent.window);
  await recorder.start({ targetTabId: 7, limitMs: 1000 });
  silent.clock.now = 1_001_100;
  for (let block = 0; block < 30; block++) silent.record.push(1000 + block * 100, 100, 0);
  await tick();
  silent.clock.now = 1_004_000;
  assert.deepEqual(await recorder.finish({ startMs: 1000, endMs: 1500, anchors: [[1_001_500, 1000]] }), { silent: true });

  const never = recorderWindow();
  const second = createNetflixRecorder(never.window);
  await second.start({ targetTabId: 7, limitMs: 1000 });
  await assert.rejects(second.finish({ startMs: 0, endMs: 1, anchors: [] }), /did not play the line/u);
  assert.equal(never.record.stopped, 1, "a failed finish still stops the stream");

  // An unfinished recording stops itself and cannot be finished afterwards.
  const abandoned = recorderWindow();
  const third = createNetflixRecorder(abandoned.window);
  await third.start({ targetTabId: 7, limitMs: 1000 });
  abandoned.record.timers[0].callback();
  assert.equal(abandoned.record.stopped, 1);
  await assert.rejects(third.finish({ startMs: 0, endMs: 1, anchors: [[1, 1]] }), /replaced or stopped/u);
  // A newer recording replaces an older one; stop ends the current one.
  await third.start({ targetTabId: 7, limitMs: 1000 });
  await third.start({ targetTabId: 7, limitMs: 1000 });
  assert.equal(abandoned.record.stopped, 2);
  third.stop();
  assert.equal(abandoned.record.stopped, 3);
  await assert.rejects(third.start({ targetTabId: "7", limitMs: 1000 }), /invalid/u);
  await assert.rejects(third.start({ targetTabId: 7 }), /invalid/u);
});

// A recorder window that also serves a video track and the OffscreenCanvas the
// GIF path draws frames into. Audio and video each have their own reader whose
// blocks the test pushes; getImageData returns a solid frame of the colour the
// last drawn VideoFrame carried, so a decoded GIF has recognisable frames.
function gifRecorderWindow() {
  const clock = { now: 2_000_000 };
  const record = { constraints: null, stopped: 0, cancelled: 0, timers: [], pushAudio: null, pushVideo: null };
  const streams = { audio: { blocks: [], wake: null }, video: { blocks: [], wake: null } };
  const reader = store => ({
    read: () => new Promise(resolve => { if (store.blocks.length) resolve(store.blocks.shift()); else store.wake = resolve; }),
    cancel: async () => { record.cancelled++; store.wake?.({ done: true }); },
  });
  let lastDraw = 0;
  const window = {
    performance: { timeOrigin: 1_000_000, now: () => clock.now - 1_000_000 },
    chrome: { tabCapture: { async getMediaStreamId() { return "stream-id"; } } },
    navigator: { mediaDevices: { async getUserMedia(constraints) {
      record.constraints = constraints;
      const audio = { kind: "audio", stop: () => { record.stopped++; } };
      const video = { kind: "video", stop: () => { record.stopped++; } };
      return { getAudioTracks: () => [audio], getVideoTracks: () => constraints.video ? [video] : [],
        getTracks: () => [audio, ...(constraints.video ? [video] : [])] };
    } } },
    MediaStreamTrackProcessor: class {
      constructor({ track }) { this.readable = { getReader: () => reader(track.kind === "video" ? streams.video : streams.audio) }; }
    },
    OffscreenCanvas: class {
      constructor(width, height) { this.width = width; this.height = height; }
      getContext() {
        return { drawImage: frame => { lastDraw = frame.level; },
          getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(lastDraw) }) };
      }
    },
    setTimeout: (callback, ms) => { if (ms >= 1000) { record.timers.push({ callback, ms }); return record.timers.length; } return setTimeout(callback, 0); },
    clearTimeout: () => {},
  };
  record.pushAudio = (timestampMs, frames, value) => {
    const block = { value: { timestamp: timestampMs * 1000, numberOfFrames: frames, numberOfChannels: 1, sampleRate: 1000,
      copyTo(plane) { plane.fill(value); }, close() {} }, done: false };
    if (streams.audio.wake) { const resolve = streams.audio.wake; streams.audio.wake = null; resolve(block); } else streams.audio.blocks.push(block);
  };
  record.pushVideo = (timestampMs, level) => {
    const block = { value: { timestamp: timestampMs * 1000, displayWidth: 960, displayHeight: 540, codedWidth: 960,
      codedHeight: 540, level, close() {} }, done: false };
    if (streams.video.wake) { const resolve = streams.video.wake; streams.video.wake = null; resolve(block); } else streams.video.blocks.push(block);
  };
  return { window, record, clock };
}

const settle = () => new Promise(resolve => { setTimeout(resolve, 0); });

test("with gif, the recorder opens the video track and encodes a looping GIF of the cue window", async () => {
  const { window, record, clock } = gifRecorderWindow();
  const recorder = createNetflixRecorder(window);
  await recorder.start({ targetTabId: 7, limitMs: 60_000, gif: true });
  // Both tracks are requested from the one stream.
  assert.deepEqual(record.constraints.video, { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: "stream-id" } });
  clock.now = 1_001_100;
  // Audio so the clip is not empty, and video frames every 40 ms (25 fps). The
  // page played media 1000 ms at wall 1_001_500, so offset is 1_000_500 and a
  // frame at timestamp T lands at media T − 500; frames at 1500–2100 ms map to
  // the cue window 1000–1600 ms, thinned to <=10 fps.
  for (let block = 0; block < 20; block++) record.pushAudio(1000 + block * 100, 100, (block + 1) / 64);
  for (let ms = 1400; ms <= 2200; ms += 40) record.pushVideo(ms, (ms / 40) % 200);
  await settle();
  await settle();
  clock.now = 1_001_000 + 3000;
  // The cue 1000–1600 ms is the GIF window.
  const clip = await recorder.finish({ startMs: 1000, endMs: 1600, anchors: [[1_001_500, 1000], [1_002_000, 1500]] });
  assert.equal(typeof clip.gif, "string", "a GIF was encoded");
  const gif = readGif(Buffer.from(clip.gif, "base64"));
  assert.ok(gif.frames.length > 1, `the GIF has more than one frame (${gif.frames.length})`);
  assert.equal(gif.loop, 0, "the GIF loops forever");
  // The downscale keeps the aspect ratio within 480 px wide (960×540 → 480×270).
  assert.equal(gif.width, 480);
  assert.equal(gif.height, 270);
  assert.ok(record.stopped >= 2, "the audio and video tracks are both stopped");
});

test("without gif, no video track is opened and no GIF is returned", async () => {
  const { window, record, clock } = gifRecorderWindow();
  const recorder = createNetflixRecorder(window);
  await recorder.start({ targetTabId: 7, limitMs: 60_000 });
  assert.equal(record.constraints.video, false);
  clock.now = 1_001_100;
  for (let block = 0; block < 20; block++) record.pushAudio(1000 + block * 100, 100, (block + 1) / 64);
  await settle();
  clock.now = 1_001_000 + 3000;
  const clip = await recorder.finish({ startMs: 1000, endMs: 1600, anchors: [[1_001_500, 1000], [1_002_000, 1500]] });
  assert.equal(clip.gif, undefined, "no GIF without a {gif} field");
  assert.equal(clip.silent, false);
});

test("for a {gif} field alone, the recorder returns the GIF and encodes no WAV", async () => {
  const { window, record, clock } = gifRecorderWindow();
  const recorder = createNetflixRecorder(window);
  await recorder.start({ targetTabId: 7, limitMs: 60_000, audio: false, gif: true });
  // The audio track is still opened: it mutes the tab and paces the finish.
  assert.notEqual(record.constraints.audio, false);
  clock.now = 1_001_100;
  for (let block = 0; block < 20; block++) record.pushAudio(1000 + block * 100, 100, (block + 1) / 64);
  for (let ms = 1400; ms <= 2200; ms += 40) record.pushVideo(ms, (ms / 40) % 200);
  await settle();
  await settle();
  clock.now = 1_001_000 + 3000;
  const clip = await recorder.finish({ startMs: 1000, endMs: 1600, anchors: [[1_001_500, 1000], [1_002_000, 1500]] });
  assert.deepEqual(Object.keys(clip), ["gif"], "only the GIF leaves the frame");
  assert.equal(Buffer.from(clip.gif, "base64").toString("ascii", 0, 6), "GIF89a");
});
