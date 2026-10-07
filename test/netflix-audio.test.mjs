// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/netflix-audio.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const { createLineAudio, encodeMonoWav, isSilent, wavBase64 } = globalThis.HDNetflixAudio;
const MOVIE = "81000001";
const TIME_ORIGIN = 1_000_000;
const RATE = 1000;
const BLOCK = 10;
// The fixture's sound is a ramp of its own media time, so a clip shows which
// media times it holds.
const level = mediaMs => mediaMs / 100_000;
const settle = () => new Promise(done => { setImmediate(done); });

// A watch page whose <video> plays on a timeline the test drives, Web Audio
// that hands the element's sound to a track processor in 10 ms blocks at
// 1 kHz, and the clock both read. Blocks arrive `latency` ms after they end,
// and every ninth is stamped 9 ms late, as Chrome 152 does.
function playback(t, { contextState = "running", allowed = true, taken = false, latency = 15 } = {}) {
  const dom = new JSDOM(`<!doctype html><div class="watch-video"><video></video></div>`,
    { url: `https://www.netflix.com/watch/${MOVIE}` });
  t.after(() => dom.window.close());
  const { window } = dom;
  const video = window.document.querySelector("video");
  let now = TIME_ORIGIN + 5000;
  // From wall time `at` the media time runs from `media` at `rate` (0: stopped).
  const timeline = [{ at: now, media: 0, rate: 0 }];
  const entryAt = wall => timeline.findLast(entry => entry.at <= wall);
  const mediaAt = wall => { const entry = entryAt(wall); return entry.media + (wall - entry.at) * entry.rate; };
  const state = { paused: true, seeking: false, ended: false, playbackRate: 1, readyState: 4 };
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaAt(now) / 1000 });
  for (const key of Object.keys(state)) {
    Object.defineProperty(video, key, { configurable: true, get: () => state[key], set: value => { state[key] = value; } });
  }
  const record = { contexts: [], sources: [], sinks: [], stoppedTracks: 0, cancelledReaders: 0, closed: 0, queue: null };
  const env = { allowed, movie: MOVIE };
  let queue = [];
  let wake = null;
  class AudioContext extends EventTarget {
    constructor() {
      super();
      this.state = contextState;
      this.destination = { node: "destination" };
      record.contexts.push(this);
    }
    async resume() {
      if (!env.allowed || this.state === "running") return;
      this.state = "running";
      this.dispatchEvent(new Event("statechange"));
    }
    async close() { record.closed += 1; this.state = "closed"; }
    createMediaElementSource(element) {
      if (taken) throw new Error("HTMLMediaElement already connected previously to a different MediaElementSourceNode.");
      const source = { element, connected: new Set(),
        connect(node) { this.connected.add(node); return node; },
        disconnect(node) { if (node === undefined) this.connected.clear(); else this.connected.delete(node); } };
      record.sources.push(source);
      return source;
    }
  }
  class MediaStreamAudioDestinationNode {
    constructor(context, options) {
      this.options = options;
      const track = { stop: () => { record.stoppedTracks += 1; } };
      this.stream = { getAudioTracks: () => [track] };
      record.sinks.push(this);
    }
  }
  class MediaStreamTrackProcessor {
    constructor({ maxBufferSize }) {
      record.queue = maxBufferSize;
      this.readable = { getReader: () => ({
        read: () => new Promise(done => { if (queue.length) done(queue.shift()); else wake = done; }),
        cancel: async () => { record.cancelledReaders += 1; wake?.({ done: true }); wake = null; queue = []; },
      }) };
    }
  }
  const host = { document: window.document, performance: { timeOrigin: TIME_ORIGIN }, AudioContext,
    MediaStreamAudioDestinationNode, MediaStreamTrackProcessor, setTimeout, clearTimeout,
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window) };
  const lineAudio = createLineAudio(host, { video: () => video, movie: () => env.movie, now: () => now });

  // The element's sound: its media ramp while it plays, silence otherwise.
  let renderedTo = now;
  let blocks = 0;
  const pending = [];
  function render() {
    for (; renderedTo + BLOCK <= now; renderedTo += BLOCK) {
      const wall = renderedTo;
      const samples = Float32Array.from({ length: BLOCK }, (_, index) => (entryAt(wall + index).rate === 0 ? 0
        : level(mediaAt(wall + index))));
      blocks += 1;
      const stamped = wall + (blocks % 9 === 0 ? 9 : 0);
      pending.push({ at: wall + BLOCK + latency, value: { timestamp: (stamped - TIME_ORIGIN) * 1000, numberOfFrames: BLOCK,
        numberOfChannels: 1, sampleRate: RATE, close() {},
        copyTo(target, { frameOffset = 0, frameCount = BLOCK }) { target.set(samples.subarray(frameOffset, frameOffset + frameCount)); } } });
    }
  }
  async function deliver() {
    while (pending.length && pending[0].at <= now) {
      const { value } = pending.shift();
      if (wake) {
        const resume = wake;
        wake = null;
        resume({ done: false, value });
      } else {
        queue.push({ done: false, value });
      }
      await settle();
    }
  }
  async function advance(ms) {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 5);
      render();
      await deliver();
    }
  }
  // Changes what the video does now. Chrome changes the element at once and
  // its event follows; `late` holds the event back for that many milliseconds.
  // A seek moves the media time to `media`.
  async function change(types, update, { late = 0, media = mediaAt(now) } = {}) {
    update(state);
    timeline.push({ at: now, media, rate: state.paused || state.seeking ? 0 : state.playbackRate });
    if (late) await advance(late);
    for (const type of [types].flat()) video.dispatchEvent(new window.Event(type));
  }
  const play = () => change(["play", "playing"], media => { media.paused = false; });
  const pause = options => change("pause", media => { media.paused = true; }, options);
  async function seek(to) {
    await change("seeking", media => { media.seeking = true; }, { media: to });
    await change(["seeked", ...(state.paused ? [] : ["playing"])], media => { media.seeking = false; }, { media: to });
  }
  const rate = value => change("ratechange", media => { media.playbackRate = value; });
  // How many of a clip's samples, from media time `from`, hold the media time they should.
  const matching = (clip, from, first = 0, last = clip.samples.length) => clip.samples.subarray(first, last)
    .filter((sample, index) => Math.abs(sample * 100_000 - (from + first + index)) <= 2).length;
  return { window, video, lineAudio, record, env, advance, play, pause, seek, rate, matching,
    get now() { return now; }, mediaNow: () => mediaAt(now) };
}

test("a line heard at 1× is cut from the buffer by its cue's media time", async t => {
  const f = playback(t);
  f.lineAudio.start();
  assert.equal(f.record.queue, 100, "the processor queues a second, so a busy page drops nothing");
  assert.deepEqual(f.record.sinks.map(sink => sink.options), [{ channelCount: 1 }], "Web Audio mixes the copy to mono");
  assert.equal(f.lineAudio.ready(), true);
  await f.play();
  await f.advance(3000);
  const clip = f.lineAudio.clip(MOVIE, 1000, 2000);
  assert.equal(clip.sampleRate, RATE);
  assert.equal(clip.samples.length, 1000);
  assert.equal(f.matching(clip, 1000), 1000, "every sample is the media time it should be, within 2 ms");
  assert.equal(f.lineAudio.covers(MOVIE, 1000, 2000), true);
  // Not heard yet, or another episode.
  assert.equal(f.lineAudio.clip(MOVIE, 2500, 3500), null);
  assert.equal(f.lineAudio.covers(MOVIE, 2500, 3500), false);
  assert.equal(f.lineAudio.clip("81000002", 1000, 2000), null);
  // The video keeps playing through the graph: the source feeds the speakers and the copy.
  const [source] = f.record.sources;
  assert.deepEqual([...source.connected].map(node => node.node ?? "copy"), ["destination", "copy"]);
});

test("a line paused partway joins the part played on, and silence after the pause is not heard", async t => {
  const f = playback(t);
  f.lineAudio.start();
  await f.play();
  await f.advance(1500);
  const paused = f.mediaNow();
  // Chrome's pause event comes after the element has stopped: the copy's
  // blocks until then are silence and must not count as heard.
  await f.pause({ late: 120 });
  await f.advance(500);
  assert.equal(f.lineAudio.covers(MOVIE, 1000, paused), true, "the start of the line was heard");
  assert.equal(f.lineAudio.covers(MOVIE, 1000, paused + 100), false, "nothing after the pause was");
  assert.equal(f.lineAudio.clip(MOVIE, 1000, 2200), null);
  await f.play();
  await f.advance(1000);
  const clip = f.lineAudio.clip(MOVIE, 1000, 2200);
  assert.ok(clip, "the two hearings cover the line");
  assert.equal(f.matching(clip, 1000, 0, paused - 1000 - 10), paused - 1000 - 10, "the part heard before the pause");
  assert.equal(f.matching(clip, 1000, paused - 1000 + 20), clip.samples.length - (paused - 1000 + 20), "the part played on");
});

test("only 1× playback is kept, speed changes and seeks end a stretch, and only the last 30 seconds stay", async t => {
  const f = playback(t);
  f.lineAudio.start();
  await f.play();
  await f.advance(1000);
  await f.rate(1.5);
  await f.advance(1000);
  await f.rate(1);
  await f.advance(1000);
  const sped = f.mediaNow() - 1000;
  assert.equal(f.lineAudio.covers(MOVIE, 100, 900), true);
  assert.equal(f.lineAudio.covers(MOVIE, 1100, 2400), false, "the line played at 1.5× was not kept");
  assert.equal(f.lineAudio.covers(MOVIE, sped + 100, sped + 900), true, "back at 1× it is");
  await f.seek(10_000);
  await f.advance(1000);
  assert.equal(f.lineAudio.covers(MOVIE, 10_100, 10_900), true);
  assert.equal(f.lineAudio.covers(MOVIE, sped + 500, 10_500), false, "a seek is no hearing of what it skipped");
  // A /watch/ address for the next episode while it plays starts its own stretch.
  f.env.movie = "81000002";
  await f.advance(1000);
  assert.equal(f.lineAudio.covers(MOVIE, 10_100, 10_900), true, "the previous episode's hearing is kept");
  assert.equal(f.lineAudio.covers("81000002", 11_200, 11_900), true);
  // After 40 more seconds, the first are gone.
  await f.advance(40_000);
  assert.equal(f.lineAudio.clip("81000002", 11_200, 11_900), null, "older than the window");
  const end = f.mediaNow();
  assert.ok(f.lineAudio.clip("81000002", end - 29_000, end - 28_000), "within the window");
});

test("the buffer waits for Chrome to let the page start audio, and the switch frees it", async t => {
  // A context Chrome has not let start: nothing joins it until a gesture.
  const f = playback(t, { contextState: "suspended", allowed: false });
  f.lineAudio.start();
  assert.equal(f.record.contexts.length, 1);
  assert.equal(f.record.sources.length, 0, "the video stays out of a graph that is not running");
  assert.equal(f.lineAudio.ready(), false);
  f.env.allowed = true;
  f.window.dispatchEvent(new f.window.Event("pointerdown"));
  await settle();
  assert.equal(f.record.sources.length, 1, "a click starts it and the video joins");
  assert.equal(f.lineAudio.ready(), true);
  await f.play();
  await f.advance(2000);
  assert.ok(f.lineAudio.clip(MOVIE, 500, 1500));

  // Off: the copy's reader and track stop, the copy leaves the graph, and what
  // was kept is freed. The video keeps playing through the graph.
  f.lineAudio.stop();
  const [source] = f.record.sources;
  assert.equal(f.record.cancelledReaders, 1);
  assert.equal(f.record.stoppedTracks, 1);
  assert.deepEqual([...source.connected].map(node => node.node), ["destination"]);
  assert.equal(f.lineAudio.ready(), false);
  assert.equal(f.lineAudio.clip(MOVIE, 500, 1500), null);
  assert.equal(f.record.closed, 0, "a graph the video plays through stays open");
  await f.advance(1000);
  assert.equal(f.lineAudio.covers(MOVIE, 2100, 2900), false, "nothing is kept while off");
  // On again: a new copy of the same source.
  f.lineAudio.start();
  assert.equal(f.lineAudio.ready(), true);
  assert.equal(f.record.sources.length, 1);
  assert.equal(f.record.sinks.length, 2);
  await f.advance(1500);
  assert.ok(f.lineAudio.clip(MOVIE, f.mediaNow() - 1000, f.mediaNow() - 100));

  // Never switched on, nothing is made; a graph nothing joined is closed when switched off.
  const idle = playback(t);
  await idle.play();
  await idle.advance(500);
  assert.equal(idle.record.contexts.length, 0);
  const waiting = playback(t, { contextState: "suspended", allowed: false });
  waiting.lineAudio.start();
  waiting.lineAudio.stop();
  assert.equal(waiting.record.closed, 1);
  // A video another graph already has stays with tab capture.
  const owned = playback(t, { taken: true });
  owned.lineAudio.start();
  assert.equal(owned.lineAudio.ready(), false);
  assert.equal(owned.record.sinks.length, 0);
});

test("settled waits for what has played until now to arrive", async t => {
  const f = playback(t, { latency: 40 });
  f.lineAudio.start();
  await f.play();
  await f.advance(1000);
  let done = false;
  const settled = f.lineAudio.settled(500).then(() => { done = true; });
  await f.advance(20);
  assert.equal(done, false, "blocks rendered before the call are still on their way");
  await f.advance(40);
  await settled;
  assert.equal(done, true);
  // With nothing arriving, it gives up after its timeout.
  f.lineAudio.stop();
  f.lineAudio.start();
  const started = Date.now();
  await f.lineAudio.settled(30);
  assert.ok(Date.now() - started < 1000);
});

test("only exact zeros are silence, and a clip is a 16-bit mono PCM WAV in base64", () => {
  assert.equal(isSilent(new Float32Array(48)), true);
  assert.equal(isSilent(Float32Array.of(0, 0, 1e-7)), false);
  const samples = Float32Array.of(0, 0.5, -0.5, 1, -1, 2);
  const wav = Buffer.from(encodeMonoWav(samples, 48_000));
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
  // Longer than one base64 chunk, so the chunks join up.
  const long = Float32Array.from({ length: 20_000 }, (_, index) => Math.sin(index / 7));
  const encoded = wavBase64({ samples: long, sampleRate: 48_000 });
  assert.match(encoded, /^UklG/u);
  assert.deepEqual(Buffer.from(encoded, "base64"), Buffer.from(encodeMonoWav(long, 48_000)));
});
