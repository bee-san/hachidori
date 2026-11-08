// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental YouTube mining without YouTube: its switch, the scripts it
// registers, what the manifest exposes to YouTube, the video frame the worker
// reads for {screenshot}, and the GIF cropped to the video.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import "../extension/reader-options.js";
import { YOUTUBE_SCRIPTS, applyYouTubeFlag } from "../extension/youtube.js";
import { captureYouTubeFrame } from "../extension/youtube-frame.js";
import { createNetflixRecorder } from "../extension/netflix-capture.js";
import { readGif } from "./gif-structure.mjs";

const extension = new URL("../extension/", import.meta.url);
const IDS = ["hachidori-youtube-page", "hachidori-youtube-content"];

test("YouTube mining is an experimental flag beside Netflix's that starts off", () => {
  const { DEFAULT_OPTIONS, EXPERIMENTAL_FEATURES, normaliseOptions } = globalThis.HDReaderOptions;
  const ids = EXPERIMENTAL_FEATURES.map(entry => entry.id);
  assert.equal(ids.indexOf("youtubeMining"), ids.indexOf("netflixPreviewScreenshots") + 1, "it follows the Netflix switches");
  const feature = EXPERIMENTAL_FEATURES.find(entry => entry.id === "youtubeMining");
  assert.equal(feature.label, "YouTube mining");
  assert.match(feature.description, /\{sentence-audio\}.*\{gif\}.*\{screenshot\}/u);
  assert.match(feature.description, /not on Shorts, embedded videos or live streams/u);
  assert.equal(feature.section, undefined, "the flag has no Settings section of its own");
  assert.equal(DEFAULT_OPTIONS.experimental.youtubeMining, false);
  assert.equal(normaliseOptions({}).experimental.youtubeMining, false);
});

test("the flag registers the page script and the reader's scripts for www.youtube.com's top frame only", async () => {
  assert.deepEqual(YOUTUBE_SCRIPTS, [
    { id: "hachidori-youtube-page", matches: ["https://www.youtube.com/*"], js: ["netflix-page.js"],
      runAt: "document_start", allFrames: false, world: "MAIN" },
    { id: "hachidori-youtube-content", matches: ["https://www.youtube.com/*"],
      js: ["netflix-subtitles.js", "netflix-audio.js", "netflix-content.js", "youtube-content.js"], runAt: "document_start",
      allFrames: false, world: "ISOLATED" },
  ]);
  const calls = [];
  const active = new Set();
  const browser = { scripting: {
    async getRegisteredContentScripts({ ids }) { calls.push(["get", ids]); return ids.filter(id => active.has(id)).map(id => ({ id })); },
    async registerContentScripts(scripts) { calls.push(["register", scripts.map(script => script.id)]); for (const { id } of scripts) active.add(id); },
    async unregisterContentScripts({ ids }) { calls.push(["unregister", ids]); for (const id of ids) active.delete(id); },
  } };
  await Promise.all([true, false, true].map(enabled => applyYouTubeFlag(browser, enabled)));
  assert.deepEqual(calls.filter(([name]) => name !== "get"), [["register", IDS], ["unregister", IDS], ["register", IDS]]);
  assert.deepEqual(await applyYouTubeFlag({}, true), { supported: false, registered: false });
});

test("the manifest exposes only YouTube's recorder page and the MP3 encoder to www.youtube.com and asks for no new permission", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extension), "utf8"));
  assert.equal(/youtube/iu.test(JSON.stringify(manifest.content_scripts)), false, "no YouTube content script is declared");
  assert.equal(/youtube/iu.test(JSON.stringify([manifest.permissions, manifest.host_permissions,
    manifest.optional_permissions])), false);
  assert.deepEqual(manifest.web_accessible_resources.filter(entry => /youtube/iu.test(JSON.stringify(entry))),
    [{ resources: ["youtube-recorder.html"], matches: ["https://www.youtube.com/*"] },
    { resources: ["sentence-audio.js", "base64.js", "vendor/lamejs.js"],
      matches: ["https://www.netflix.com/*", "https://www.youtube.com/*"] }]);
  const page = await readFile(new URL("youtube-recorder.html", extension), "utf8");
  assert.match(page, /<script type="module" src="youtube-recorder\.js"><\/script>/u);
  assert.match(await readFile(new URL("youtube-recorder.js", extension), "utf8"),
    /connectNetflixRecorder\(globalThis, \{ port: "hachidori-youtube-recorder", site: "YouTube" \}\)/u);
});

// The worker serializes captureYouTubeFrame without its module scope into the
// page's isolated world, where it draws the player's video into a canvas.
function frameFixture({ href = "https://www.youtube.com/watch?v=Ab3dEf6hI9k", video } = {}) {
  const drawn = [];
  const canvas = { width: 0, height: 0,
    getContext: () => ({ drawImage: (...args) => drawn.push(args) }),
    toDataURL: (type, quality) => `data:${type};base64,/9j/${quality}` };
  const document = {
    querySelector: selector => (selector === "#movie_player video.html5-main-video" ? video : null),
    createElement: name => (name === "canvas" ? canvas : null),
  };
  const capture = runInNewContext(`(${captureYouTubeFrame.toString()})`, { window: { location: { href } }, document });
  // Its results, as plain values of this realm.
  return { capture: url => JSON.parse(JSON.stringify(capture(url))), drawn, canvas };
}

test("{screenshot} on YouTube is the frame the player shows, at the video's own size", () => {
  const video = { readyState: 4, videoWidth: 1920, videoHeight: 1080 };
  const f = frameFixture({ video });
  assert.deepEqual(f.capture("https://www.youtube.com/watch?v=Ab3dEf6hI9k"), { dataUrl: "data:image/jpeg;base64,/9j/0.92" });
  assert.deepEqual([f.canvas.width, f.canvas.height], [1920, 1080]);
  assert.deepEqual(f.drawn, [[video, 0, 0, 1920, 1080]]);
  // Another page, or the same page with no picture yet, is not this frame.
  assert.match(f.capture("https://www.youtube.com/watch?v=other").error, /page changed/u);
  assert.deepEqual(frameFixture({ video: { readyState: 1, videoWidth: 1920, videoHeight: 1080 } })
    .capture("https://www.youtube.com/watch?v=Ab3dEf6hI9k"), { none: true });
  assert.deepEqual(frameFixture().capture("https://www.youtube.com/watch?v=Ab3dEf6hI9k"), { none: true });
  // A protected video reads back as black, so the viewport is taken instead.
  assert.deepEqual(frameFixture({ video: { ...video, mediaKeys: {} } }).capture("https://www.youtube.com/watch?v=Ab3dEf6hI9k"),
    { none: true });
  const failing = frameFixture({ video });
  failing.canvas.toDataURL = () => { throw new Error("SecurityError"); };
  assert.match(failing.capture("https://www.youtube.com/watch?v=Ab3dEf6hI9k").error, /could not be read/u);
});

// A recorder window whose tab-capture video track delivers frames 1280 px wide,
// and the canvas that records what is drawn from them.
function cropWindow({ frameHeight = 720 } = {}) {
  const clock = { now: 2_000_000 };
  const draws = [];
  const streams = { audio: [], video: [] };
  const waiting = {};
  const reader = kind => ({
    read: () => new Promise(resolve => { if (streams[kind].length) resolve(streams[kind].shift()); else waiting[kind] = resolve; }),
    cancel: async () => waiting[kind]?.({ done: true }),
  });
  const push = (kind, value) => {
    const block = { value, done: false };
    if (waiting[kind]) { const resolve = waiting[kind]; waiting[kind] = null; resolve(block); } else streams[kind].push(block);
  };
  const window = {
    performance: { timeOrigin: 1_000_000, now: () => clock.now - 1_000_000 },
    chrome: { tabCapture: { async getMediaStreamId() { return "stream-id"; } } },
    navigator: { mediaDevices: { async getUserMedia() {
      const audio = { kind: "audio", stop() {} };
      const video = { kind: "video", stop() {} };
      return { getAudioTracks: () => [audio], getVideoTracks: () => [video], getTracks: () => [audio, video] };
    } } },
    MediaStreamTrackProcessor: class { constructor({ track }) { this.readable = { getReader: () => reader(track.kind) }; } },
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }); }
      getContext() {
        return { drawImage: (...args) => draws.push(args.slice(1)),
          getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4).fill(draws.length * 9) }) };
      }
    },
    setTimeout: (callback, ms) => (ms >= 1000 ? 1 : setTimeout(callback, 0)),
    clearTimeout: () => {},
  };
  const frame = (ms, level) => push("video", { timestamp: ms * 1000, displayWidth: 1280, displayHeight: frameHeight, level,
    close() {} });
  const audio = ms => push("audio", { timestamp: ms * 1000, numberOfFrames: 100, numberOfChannels: 1, sampleRate: 1000,
    copyTo(plane) { plane.fill(0.25); }, close() {} });
  return { window, clock, draws, frame, audio };
}

// Records one line of `crop` from frames `frameHeight` high: what was drawn
// from the first frame, and the GIF's size.
async function cropped(crop, frameHeight) {
  const { window, clock, draws, frame, audio } = cropWindow({ frameHeight });
  const recorder = createNetflixRecorder(window, { site: "YouTube" });
  await recorder.start({ targetTabId: 7, limitMs: 60_000, audio: false, gif: true, crop });
  clock.now = 1_001_100;
  for (let block = 0; block < 20; block++) audio(1000 + block * 100);
  for (let ms = 1400; ms <= 2200; ms += 100) frame(ms, ms);
  await new Promise(resolve => { setTimeout(resolve, 0); });
  await new Promise(resolve => { setTimeout(resolve, 0); });
  clock.now = 1_004_000;
  const clip = await recorder.finish({ startMs: 1000, endMs: 1600, anchors: [[1_001_500, 1000], [1_002_000, 1500]] });
  const gif = readGif(Buffer.from(clip.gif, "base64"));
  return { drawn: draws[0], size: [gif.width, gif.height], window };
}

test("a YouTube GIF keeps only the video's part of the tab it records", async () => {
  // 0.625 × 1280 = 800 px of video, scaled to the GIF's 480 px.
  const exact = await cropped({ left: 0.125, top: 0.125, width: 0.625, height: 0.5, aspect: 16 / 9 }, 720);
  assert.deepEqual(exact.drawn, [160, 90, 800, 360, 0, 0, 480, 216]);
  assert.deepEqual(exact.size, [480, 216]);
  // Chrome fits a 16:9 tab into frames 900 px high and centres it: 90 px bars
  // above and below, which the crop leaves out.
  const barred = await cropped({ left: 0, top: 0, width: 1, height: 1, aspect: 16 / 9 }, 900);
  assert.deepEqual(barred.drawn, [0, 90, 1280, 720, 0, 0, 480, 270]);
  const { window } = exact;
  await assert.rejects(createNetflixRecorder(window, { site: "YouTube" }).start({ targetTabId: "7", limitMs: 1 }),
    /The YouTube recording request is invalid/u);
});
