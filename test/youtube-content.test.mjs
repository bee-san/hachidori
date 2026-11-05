// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental YouTube mining, the reader's side: the video-site layer
// (extension/netflix-content.js) with YouTube's description
// (extension/youtube-content.js), on a jsdom page with YouTube's player and
// caption markup (synthetic) and the json3 fixtures of test/data/youtube/.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/netflix-audio.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const read = path => readFile(new URL(path, import.meta.url), "utf8");
const SCRIPTS = await Promise.all(["../extension/netflix-subtitles.js", "../extension/netflix-content.js",
  "../extension/youtube-content.js"].map(read));
const ASR = await read("data/youtube/asr.json");
const MANUAL = await read("data/youtube/manual.json");
const PAGE_EVENT = "hachidori-youtube-page";
const COMMAND_EVENT = "hachidori-youtube-command";
const VIDEO = "Ab3dEf6hI9k";
const NEXT = "Zz9yX8wV7u_";

// YouTube's watch page as the reader sees it: the player with its video and
// an auto-generated caption window of two rows.
function youtube(t, { rows = ["えっと今日は朝ごはんを食べてから", "散歩に行こうと"], timeMs = 6000, lineAudio, captured } = {}) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body><h1 id="title">動画のタイトル</h1>
    <div id="movie_player" class="html5-video-player"><div class="html5-video-container">
    <video class="video-stream html5-main-video"></video></div>
    <div class="ytp-caption-window-container" id="ytp-caption-window-container">
    <div class="caption-window ytp-caption-window-bottom ytp-caption-window-rollup" id="caption-window-1"><span
    class="captions-text">${rows.map(row => `<span class="caption-visual-line"><span class="ytp-caption-segment">${row}</span></span>`)
    .join("")}</span></div></div></div></body></html>`,
  { url: `https://www.youtube.com/watch?v=${VIDEO}`, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.chrome = { runtime: { getURL: path => `chrome-extension://hachidori/${path}` } };
  if (lineAudio) {
    window.HDNetflixAudio = { ...globalThis.HDNetflixAudio, createLineAudio: (_window, options) => {
      captured?.(options);
      return lineAudio;
    } };
  }
  const commands = [];
  window.document.addEventListener(COMMAND_EVENT, event => commands.push(JSON.parse(event.detail)));
  for (const source of SCRIPTS) window.eval(source);
  const video = window.document.querySelector("video");
  Object.defineProperty(video, "currentTime", { value: timeMs / 1000, writable: true });
  const post = message => window.document.dispatchEvent(new window.CustomEvent(PAGE_EVENT, { detail: JSON.stringify(message) }));
  const subtitle = (text, extra = {}) => post({ kind: "subtitle", movieId: VIDEO, trackId: "shown", closedCaptions: false,
    format: "json3", language: "ja", text, ...extra });
  const segments = () => [...window.document.querySelectorAll(".ytp-caption-segment")];
  const plain = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const api = window.HDYouTube;
  const reader = {
    observe: element => plain(api.observe(element)),
    resolve: observation => plain(api.resolve(observation)),
    miningFields: (...args) => plain(api.miningFields(...args)),
    record: async (...args) => plain(await api.record(...args)),
    captionLanguage: element => api.captionLanguage(element),
  };
  return { window, youtube: reader, api, video, commands, post, subtitle, segments };
}

const cueOf = result => result.cue && { startMs: result.cue.startMs, endMs: result.cue.endMs, text: result.cue.text };

test("YouTube's reader is its own, and asks the page which video plays", t => {
  const f = youtube(t);
  assert.equal(f.window.HDNetflix, undefined, "netflix-content.js makes Netflix's reader on Netflix only");
  assert.equal(typeof f.window.HDYouTube.observe, "function");
  assert.deepEqual(f.commands, [{ type: "state" }]);
});

test("a caption row pins its cue in the video the player plays, and the whole cue becomes the root sentence", t => {
  const f = youtube(t, { rows: ["えっと今日は朝ごはんを食べてから", "散歩に行こうと"] });
  f.post({ kind: "video", movieId: VIDEO });
  f.subtitle(ASR);
  const [first, second] = f.segments();
  const observation = f.youtube.observe(first);
  assert.deepEqual(observation, { movieId: VIDEO, mediaTimeMs: 6000,
    lineText: "えっと今日は朝ごはんを食べてから散歩に行こうと", hoveredText: "えっと今日は朝ごはんを食べてから" });
  // The window shows two lines, so the row decides, and the rolled-up row is still the line it was.
  assert.deepEqual(cueOf(f.youtube.resolve(observation)), { startMs: 2000, endMs: 4200, text: "えっと今日は朝ごはんを食べてから" });
  assert.deepEqual(cueOf(f.youtube.resolve(f.youtube.observe(second))), { startMs: 4200, endMs: 7200, text: "散歩に行こうと思って" });
  assert.deepEqual(f.youtube.miningFields(f.youtube.observe(second), { sentence: "行こうと", matchOffset: 0 }),
    { youtube: { cue: { movieId: VIDEO, startMs: 4200, endMs: 7200 } }, sentence: "散歩に行こうと思って", matchOffset: 3 });
  // Text outside the player's captions is not a caption line.
  assert.equal(f.youtube.observe(f.window.document.getElementById("title")), null);
});

test("the latest caption file is the video's one track, and its language is the captions'", t => {
  const f = youtube(t, { rows: ["雨が降りそうだから"], timeMs: 5000 });
  f.post({ kind: "video", movieId: VIDEO });
  f.subtitle(MANUAL);
  const [row] = f.segments();
  assert.equal(f.youtube.resolve(f.youtube.observe(row)).cue.startMs, 4000);
  assert.equal(f.youtube.captionLanguage(row), "ja");
  // Captions switched to another track: the lines on screen are its lines.
  f.subtitle(ASR, { language: "en" });
  assert.deepEqual(f.youtube.resolve(f.youtube.observe(row)), { reason: "no-match" });
  assert.equal(f.youtube.captionLanguage(row), "en");
  assert.equal(f.youtube.captionLanguage(f.window.document.getElementById("title")), null, "only captions have it");
  f.subtitle(MANUAL, { language: "not a language" });
  assert.equal(f.youtube.captionLanguage(row), null);
});

test("the player's next video drops the previous one's timeline, and a video without one is asked for again", t => {
  const f = youtube(t, { rows: ["雨が降りそうだから"], timeMs: 5000 });
  f.post({ kind: "video", movieId: VIDEO });
  f.subtitle(MANUAL);
  const before = f.youtube.observe(f.segments()[0]);
  f.post({ kind: "video", movieId: NEXT });
  assert.deepEqual(f.youtube.resolve(before), { reason: "no-timeline" }, "the previous video's timeline is gone");
  f.subtitle(MANUAL);
  assert.deepEqual(f.youtube.resolve(before), { reason: "no-timeline" }, "a late file for it is ignored");
  const now = f.youtube.observe(f.segments()[0]);
  assert.equal(now.movieId, NEXT);
  f.commands.length = 0;
  assert.deepEqual(f.youtube.resolve(now), { reason: "no-timeline" });
  assert.deepEqual(f.commands, [{ type: "resend", movieId: NEXT }]);
  f.subtitle(MANUAL, { movieId: NEXT });
  assert.equal(f.youtube.resolve(now).cue.startMs, 4000);
  // YouTube's own reasons, and a post that names no video, change nothing else.
  f.post({ kind: "status", movieId: NEXT, subtitles: "image" });
  f.post({ kind: "video", movieId: "../../etc" });
  assert.equal(f.youtube.observe(f.segments()[0]).movieId, null);
  f.post({ kind: "video", movieId: NEXT });
  f.post({ kind: "status", movieId: "Live_stream", subtitles: "live" });
  f.post({ kind: "video", movieId: "Live_stream" });
  assert.deepEqual(f.youtube.resolve(f.youtube.observe(f.segments()[0])), { reason: "live" });
});

test("an ad's captions and sound are not the video's", t => {
  let options = null;
  const lineAudio = { start() {}, stop() {}, ready: () => true };
  const f = youtube(t, { lineAudio, captured: value => { options = value; } });
  f.post({ kind: "video", movieId: VIDEO });
  f.subtitle(ASR);
  f.api.setLineAudio(true);
  const player = f.window.document.getElementById("movie_player");
  assert.equal(options.movie(), VIDEO);
  assert.equal(options.video(), f.video);
  player.classList.add("ad-showing");
  assert.equal(f.youtube.observe(f.segments()[0]), null);
  assert.equal(options.movie(), null, "what plays during an ad is kept for no video");
  player.classList.remove("ad-showing");
  assert.equal(options.movie(), VIDEO);
});

test("a YouTube line is recorded with YouTube's requests and recorder page, its GIF cropped to the video", async t => {
  const f = youtube(t);
  f.post({ kind: "video", movieId: VIDEO });
  f.window.document.addEventListener(COMMAND_EVENT, event => {
    const command = JSON.parse(event.detail);
    if (command.type === "replay") setTimeout(() => f.post({ kind: "replay", id: command.id, ok: true, anchors: [[5000, 950]] }), 0);
  });
  f.video.getBoundingClientRect = () => ({ left: 128, top: 96, right: 768, bottom: 456, width: 640, height: 360 });
  const sent = [];
  const frames = [];
  const send = async (type, fields) => {
    sent.push([type, JSON.parse(JSON.stringify(fields))]);
    frames.push([...f.window.document.querySelectorAll("iframe")].map(frame => frame.src));
    if (type === "hd_youtube_capture_start") return { sessionId: "s1", padMs: 250 };
    return { audio: null, gif: { token: "g1", filename: "hachidori-gif-a.gif" } };
  };
  const cue = { movieId: VIDEO, startMs: 2000, endMs: 4200 };
  assert.deepEqual(await f.youtube.record(cue, { send, templateId: "default", audio: false, gif: true }),
    { audio: null, gif: { token: "g1", filename: "hachidori-gif-a.gif" } });
  // jsdom's window is 1024 × 768.
  assert.deepEqual(sent, [
    ["hd_youtube_capture_start", { cue, audio: false, gif: true,
      crop: { left: 0.125, top: 0.125, width: 0.625, height: 0.46875, aspect: 1024 / 768 } }],
    ["hd_youtube_capture_finish", { sessionId: "s1", anchors: [[5000, 950]], templateId: "default" }],
  ]);
  assert.deepEqual(frames[0], ["chrome-extension://hachidori/youtube-recorder.html"]);
  assert.equal(f.commands.find(command => command.type === "replay")?.startMs, 2000);
  // An ad refuses the replay, which the note names.
  const refusing = youtube(t);
  refusing.window.document.addEventListener(COMMAND_EVENT, event => {
    const command = JSON.parse(event.detail);
    if (command.type === "replay") setTimeout(() => refusing.post({ kind: "replay", id: command.id, ok: false, error: "ad" }), 0);
  });
  const cancelled = [];
  assert.deepEqual(await refusing.youtube.record(cue, { send: async (type, fields) => {
    cancelled.push(type);
    return type === "hd_youtube_capture_start" ? { sessionId: "s2", padMs: 250 } : { cancelled: true, fields };
  }, templateId: "default", audio: false, gif: true }), { unavailable: "ad" });
  assert.deepEqual(cancelled, ["hd_youtube_capture_start", "hd_youtube_capture_cancel"]);
});

// A playing video whose caption rows are laid out at ROWS, and a page that
// pauses and plays it on command, as netflix-content.test.mjs lays out Netflix's.
const ROWS = [{ left: 300, right: 700, top: 560, bottom: 590 }, { left: 300, right: 600, top: 592, bottom: 622 }];
function playing(t) {
  const f = youtube(t);
  f.post({ kind: "video", movieId: VIDEO });
  let paused = false;
  Object.defineProperty(f.video, "paused", { configurable: true, get: () => paused });
  const rects = new Map(f.segments().map((segment, index) => [segment.firstChild, [ROWS[index]]]));
  f.window.Range.prototype.getClientRects = function getClientRects() { return rects.get(this.startContainer) ?? []; };
  f.window.document.addEventListener(COMMAND_EVENT, event => {
    const { type } = JSON.parse(event.detail);
    if (type === "pause" || type === "resume") paused = type === "pause";
  });
  const move = ([clientX, clientY]) => f.window.document.body.dispatchEvent(new f.window.MouseEvent("mousemove",
    { bubbles: true, clientX, clientY }));
  const popup = shown => f.window.dispatchEvent(new f.window.CustomEvent(shown ? "hachidori-popup-shown" : "hachidori-popup-hidden"));
  const hoverCommands = () => f.commands.filter(command => command.type === "pause" || command.type === "resume")
    .map(command => command.type);
  return { ...f, move, popup, hoverCommands, paused: () => paused };
}

test("hovering a caption pauses the video until the pointer leaves it and the popup; YouTube drags its captions itself", t => {
  const f = playing(t);
  f.api.setHoverPause(true);
  f.api.setSubtitleDragging(true);
  f.move([500, 575]);
  assert.deepEqual(f.hoverCommands(), ["pause"]);
  f.popup(true);
  f.move([500, 300]);
  assert.deepEqual(f.hoverCommands(), ["pause"], "the popup keeps the pause");
  f.popup(false);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume"]);
  assert.equal(f.window.document.querySelector("style"), null, "no stylesheet moves YouTube's captions");
  const down = new f.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 500, clientY: 575 });
  f.segments()[0].dispatchEvent(down);
  assert.equal(down.defaultPrevented, false, "YouTube's own caption drag starts as it would");
});

test("a lookup pauses the video when it is of a caption, not when it is of the page around the player", t => {
  const f = playing(t);
  f.api.setHoverPause(true);
  // A word of the title: content.js observes the popup's anchor as it shows it.
  assert.equal(f.youtube.observe(f.window.document.getElementById("title")), null);
  f.popup(true);
  assert.deepEqual(f.hoverCommands(), []);
  f.popup(false);
  // A caption looked up from the keyboard, with the pointer elsewhere.
  f.youtube.observe(f.segments()[1]);
  f.popup(true);
  assert.deepEqual(f.hoverCommands(), ["pause"]);
  f.popup(false);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume"]);
  // A selection shows the popup before its lookup is observed: the
  // observation decides then, and a later lookup in the same popup does not.
  f.popup(true);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume"]);
  f.youtube.observe(f.segments()[0]);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume", "pause"]);
  f.popup(false);
  f.popup(true);
  f.youtube.observe(f.window.document.getElementById("title"));
  f.youtube.observe(f.segments()[0]);
  f.popup(false);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume", "pause", "resume"]);
});
