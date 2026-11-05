// SPDX-License-Identifier: GPL-3.0-or-later
//
// Experimental YouTube mining in a real Chrome, without YouTube: a fixture page
// served at https://www.youtube.com/watch?v=Ab3dEf6hI9k by request
// interception, with a fake YouTube player (#movie_player's methods) over a
// <video> whose sound is a different tone each second, a caption track the
// player loads as json3 through XMLHttpRequest, as YouTube's does, and shows
// in YouTube's caption markup, and a fake AnkiConnect. YouTube is never
// contacted: request interception serves the fixture, and the browser
// resolves no host but 127.0.0.1, so not even a preconnect leaves.
//
// With Settings → Advanced → Experimental features → YouTube mining on:
// - the player's caption file reaches the reader, and hovering the playing
//   caption pauses the video through the player and leaving resumes it;
// - a note from the caption gets the whole line as its sentence and, with no
//   replay, seek or recorder frame, the line's audio cut from what was heard:
//   the cue with its pads, audible, with each second's tone where it played;
// - its {screenshot} is the video's own frame: a video of frames (a canvas
//   stream) gives a JPEG of the video's size and colour, not the viewport;
// - the player's next video (navigation inside the page) has its own timeline;
// - and with the switch off, hovering pauses nothing.
// With HACHIDORI_YOUTUBE_GIF=1 (headful, Chrome 152 or newer: it clicks the
// toolbar button through CDP's Extensions.triggerAction), a {gif} note gets a
// looping GIF of the line cropped to the video, saved to test/tmp/ci/.
//
//   HACHIDORI_CHROME=/path/to/chrome node test/chrome-youtube.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require(process.env.HACHIDORI_PUPPETEER || "puppeteer-core");
const extension = realpathSync(resolve(root, "extension"));
const chrome = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${require("./package.json").config.chrome}/chrome-linux64/chrome`);
const output = resolve(root, "test/tmp/ci");
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-youtube-"));
const GIF = process.env.HACHIDORI_YOUTUBE_GIF === "1";
const VIDEO = "Ab3dEf6hI9k";
const NEXT = "Zz9yX8wV7u_";
const WATCH = `https://www.youtube.com/watch?v=${VIDEO}`;
const SAMPLE_RATE = 48_000;
const AUDIO_SECONDS = 8;
// The fixture's tone in each second of media time: 400 Hz, 600 Hz, … 1800 Hz.
const toneHz = second => 400 + 200 * second;
const CUE = { startMs: 2000, endMs: 3600 };
const PAD_MS = 250;

// An unpacked extension's ID is derived from its absolute path.
function extensionId(path) {
  const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hex].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

// AUDIO_SECONDS of 16-bit mono at a quarter of full scale, each second its own tone.
function toneWav() {
  const samples = AUDIO_SECONDS * SAMPLE_RATE;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const hz = toneHz(Math.floor(index / SAMPLE_RATE));
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * index / SAMPLE_RATE) * 0x2000), 44 + index * 2);
  }
  return wav;
}

// The caption files the fixture's player loads, written for this test in
// YouTube's json3 shape: a typed track whose cue is two lines, and the next
// video's.
const captions = {
  [VIDEO]: JSON.stringify({ wireMagic: "pb3", events: [
    { tStartMs: CUE.startMs, dDurationMs: CUE.endMs - CUE.startMs, segs: [{ utf8: "朝ごはんを\n食べたかった" }] },
    { tStartMs: 5000, dDurationMs: 1500, segs: [{ utf8: "またね" }] }] }),
  [NEXT]: JSON.stringify({ wireMagic: "pb3", events: [
    { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: "パンを食べたかった" }] }] }),
};

// The parts of YouTube's watch page the feature uses. The player element has
// YouTube's methods, which record each call; the captions are the loaded
// track's first line, in YouTube's markup, shown once the file has loaded.
// `__canvasVideo` plays a canvas of one colour instead of the tone, a video
// of frames, and `__toneVideo` the tone again; `__navigate` moves to the
// next video as YouTube's app does.
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>YouTube fixture</title>
<style>body{margin:0;background:#0f0f0f;color:#f1f1f1;font:16px Roboto,Arial,sans-serif}
#movie_player{position:relative;width:854px;height:480px;margin:24px 0 0 48px;background:#000;overflow:hidden}
.html5-video-container{position:absolute;inset:0}
video{width:100%;height:100%;display:block}
#motion{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ytp-caption-window-container{position:absolute;inset:0;pointer-events:none}
.caption-window{position:absolute;left:50%;bottom:6%;transform:translateX(-50%);text-align:center;pointer-events:auto}
.caption-visual-line{display:block}
.ytp-caption-segment{background:rgba(8,8,8,.75);color:#fff;font-size:32px;padding:0 6px;white-space:pre-wrap}
h1{margin:16px 48px;font-size:20px;font-weight:500}p{margin:0 48px;color:#aaa}</style>
<div id="movie_player" class="html5-video-player"><div class="html5-video-container">
<video class="video-stream html5-main-video" preload="auto"></video></div>
<canvas id="motion" width="854" height="480"></canvas>
<div class="ytp-caption-window-container" id="ytp-caption-window-container"></div></div>
<h1>Hachidori · YouTube player fixture</h1><p>Synthetic page: no YouTube content.</p>
<script>
// A band moving over the player, so a recording of the tab has frames that change.
const motion = document.getElementById("motion").getContext("2d");
(function animate(now) {
  motion.clearRect(0, 0, 854, 480);
  motion.fillStyle = \`hsl(\${(now / 10) % 360}, 80%, 55%)\`;
  motion.fillRect((now / 4) % 1054 - 200, 60, 180, 180);
  requestAnimationFrame(animate);
}(0));
const player = document.getElementById("movie_player");
const video = player.querySelector("video");
const evidence = window.__fixture = { calls: [], frames: 0, captions: [], ready: false };
let videoId = new URLSearchParams(location.search).get("v");
Object.assign(player, {
  getVideoData: () => ({ video_id: videoId, isLive: false }),
  seekTo(seconds) { evidence.calls.push("seekTo"); video.currentTime = seconds; },
  playVideo() { evidence.calls.push("playVideo"); video.play(); },
  pauseVideo() { evidence.calls.push("pauseVideo"); video.pause(); },
  getCurrentTime: () => video.currentTime,
  getPlaybackRate: () => video.playbackRate,
  setPlaybackRate(rate) { video.playbackRate = rate; },
});
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) if (node.nodeName === "IFRAME") evidence.frames++;
}).observe(document.documentElement, { childList: true, subtree: true });
const container = document.getElementById("ytp-caption-window-container");
function show(text) {
  container.innerHTML = '<div class="caption-window ytp-caption-window-bottom" id="caption-window-_0"><span class="captions-text">'
    + text.split("\\n").map((line, index) => '<span class="caption-visual-line"><span class="ytp-caption-segment"'
      + (index === 1 ? ' id="word"' : "") + ">" + line + "</span></span>").join("") + "</span></div>";
}
function loadCaptions(id) {
  const request = new XMLHttpRequest();
  request.open("GET", "/api/timedtext?v=" + id + "&ei=fixture&caps=asr&lang=ja&fmt=json3&xorb=2&pot=fixture-token&c=WEB");
  request.onload = () => {
    const [first] = JSON.parse(request.responseText).events;
    show(first.segs.map(segment => segment.utf8).join(""));
    evidence.captions.push(id);
  };
  request.send();
}
window.__navigate = id => {
  videoId = id;
  history.pushState({}, "", "/watch?v=" + id);
  document.dispatchEvent(new Event("yt-navigate-finish"));
  loadCaptions(id);
};
window.__canvasVideo = async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const paint = canvas.getContext("2d");
  const draw = () => { paint.fillStyle = "rgb(200, 40, 160)"; paint.fillRect(0, 0, 320, 180); requestAnimationFrame(draw); };
  draw();
  video.srcObject = canvas.captureStream(15);
  await video.play();
  await new Promise(done => { if (video.videoWidth) done(); else video.addEventListener("resize", done, { once: true }); });
};
let tone = null;
window.__toneVideo = async () => {
  video.srcObject = null;
  video.src = tone;
  await new Promise(done => video.addEventListener("canplay", done, { once: true }));
};
video.addEventListener("loadeddata", () => {
  loadCaptions(videoId);
  evidence.ready = true;
}, { once: true });
// A blob is seekable; an intercepted response without range support is not.
fetch("/fixture/line.wav").then(response => response.blob()).then(blob => { video.src = tone = URL.createObjectURL(blob); });
</script>`;

// The reader's own world and the popup's Anki statuses, through CDP: Puppeteer
// reaches neither the content scripts' isolated world nor the popup's closed
// shadow root, which CDP's piercing DOM sees through.
async function readerState(tab, expression = null) {
  const session = await tab.createCDPSession();
  try {
    const contexts = [];
    session.on("Runtime.executionContextCreated", event => contexts.push(event.context));
    await session.send("Runtime.enable");
    const reader = contexts.find(context => context.origin.startsWith("chrome-extension://") && context.auxData?.type === "isolated");
    const value = reader && expression !== null ? (await session.send("Runtime.evaluate",
      { expression, contextId: reader.id, returnByValue: true, awaitPromise: true })).result.value : undefined;
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const statuses = [];
    const text = node => (node.nodeType === 3 ? node.nodeValue : (node.children ?? []).map(text).join(""));
    (function walk(node) {
      const attributes = node.attributes ?? [];
      const index = attributes.indexOf("class");
      if (index >= 0 && attributes[index + 1].includes("gsm-hoshidicts-anki-status")) statuses.push(text(node));
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    }(root));
    return { value, statuses };
  } finally {
    await session.detach().catch(() => {});
  }
}

// Polls `probe` until it is true, for at most `ms`.
async function waitUntil(probe, message, ms = 15_000) {
  for (const deadline = Date.now() + ms; !(await probe());) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(done => setTimeout(done, 100));
  }
}

// The power of `hz` in a Hann-windowed stretch of `length` samples from `from` (Goertzel).
function tonePower(samples, rate, hz, from, length) {
  const coefficient = 2 * Math.cos(2 * Math.PI * hz / rate);
  let previous = 0, beforePrevious = 0;
  for (let index = 0; index < length; index++) {
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1));
    const current = samples[from + index] * weight + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  return previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious;
}

const notes = [];
const media = new Map();
const anki = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const reply = await answerAnkiConnect(JSON.parse(body), (action, params) => {
    if (action === "version") return 6;
    if (action === "deckNames") return ["Default"];
    if (action === "modelNames") return ["Basic"];
    if (action === "modelNamesAndIds") return { Basic: 1 };
    if (action === "modelFieldNames") return ["Front", "Back"];
    if (["findNotes", "findCards"].includes(action)) return [];
    if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
    if (action === "getMediaFilesNames") return media.has(params.pattern) ? [params.pattern] : [];
    if (action === "storeMediaFile") { media.set(params.filename, params.data); return params.filename; }
    if (action === "addNote") { notes.push(params.note); return notes.length; }
    if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
      fields: Object.fromEntries(Object.entries(notes[noteId - 1].fields).map(([field, value]) => [field, { value }])) }));
    throw new Error(`Unexpected Anki action: ${action}`);
  });
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(reply));
});
await new Promise(done => anki.listen(0, "127.0.0.1", done));

mkdirSync(output, { recursive: true });
const id = extensionId(extension);
let browser;
let passed = false;
try {
  browser = await puppeteer.launch({
    executablePath: chrome, headless: !GIF, enableExtensions: true, userDataDir: profile, pipe: true,
    // Tab capture records the window's own view, which an emulated viewport
    // would not match, so the GIF run uses the real window.
    ...(GIF ? { defaultViewport: null } : {}),
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
      "--autoplay-policy=no-user-gesture-required",
      ...(GIF ? ["--enable-unsafe-extension-debugging", "--window-size=1000,720"] : []),
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  console.log(`browser ${await browser.version()}`);
  const workerTarget = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  assert.equal(new URL(workerTarget.url()).host, id, "the computed extension ID is the one Chrome loaded");
  const worker = await workerTarget.worker();
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120_000);
  await settings.goto(`chrome-extension://${id}/settings.html#advanced`);
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))],
      { type: "application/zip" }));
    try {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: "youtube-fixture-import", blobUrl, fileName: "hachidori-fixture.zip" });
      if (!reply.ok) throw new Error(reply.error);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, readFileSync(resolve(root, "test/fixtures/hachidori-fixture.zip")).toString("base64"));
  console.log("fixture imported");
  // The Basic note type's Back field template and the switch, through the options queue.
  const writeOptions = patch => settings.evaluate(async (value, ankiUrl) => {
    const { options } = await chrome.storage.local.get("options");
    const next = { ...value };
    if (next.back !== undefined) {
      next.anki = { ...HDReaderOptions.DEFAULT_OPTIONS.anki, url: ankiUrl, model: "Basic", duplicateBehavior: "new",
        fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
          Back: { value: next.back, overwriteMode: "overwrite" } } };
      delete next.back;
    }
    if (next.youtube !== undefined) {
      // The complete record, as Settings writes it.
      next.experimental = { ...HDReaderOptions.DEFAULT_OPTIONS.experimental, ...options.experimental, youtubeMining: next.youtube };
      delete next.youtube;
    }
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: next });
    if (!reply.ok) throw new Error(reply.error);
  }, patch, `http://127.0.0.1:${anki.address().port}`);
  await writeOptions({ hoverEnabled: true, lookupMode: "hover", back: "{sentence}<br>{sentence-audio}" });
  const registered = () => settings.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts())
    .map(script => script.id).filter(scriptId => scriptId.startsWith("hachidori-youtube")).length);
  await writeOptions({ youtube: true });
  await waitUntil(async () => (await registered()) === 2, "the YouTube scripts are registered once the switch is on");
  console.log("YouTube mining on");

  const tab = await browser.newPage();
  tab.setDefaultTimeout(60_000);
  if (!GIF) await tab.setViewport({ width: 1000, height: 640 });
  await tab.setRequestInterception(true);
  const wav = toneWav();
  const timedtext = [];
  tab.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === "https://www.youtube.com" && url.pathname === "/watch") {
      return request.respond({ contentType: "text/html; charset=utf-8", body: page });
    }
    if (url.origin === "https://www.youtube.com" && url.pathname === "/api/timedtext") {
      timedtext.push(url.searchParams.get("v"));
      return request.respond({ contentType: "application/json; charset=UTF-8", body: captions[url.searchParams.get("v")] ?? "" });
    }
    if (url.href === "https://www.youtube.com/fixture/line.wav") return request.respond({ contentType: "audio/wav", body: wav });
    if (url.origin === "https://www.youtube.com") return request.respond({ status: 404, body: "" });
    return request.continue();
  });
  tab.on("pageerror", error => console.log("watch page error:", error.message));
  await tab.goto(WATCH);
  await tab.waitForFunction(() => window.__fixture?.ready === true && window.__fixture.captions.length === 1);
  await tab.bringToFront();
  assert.deepEqual(timedtext, [VIDEO], "the player loaded its caption file once, and Hachidori fetched nothing");
  // The reader has the player's caption file as the video's timeline: inside
  // the cue, the caption resolves to it.
  await tab.evaluate(atMs => { document.querySelector("video").currentTime = atMs / 1000; }, CUE.startMs + 500);
  const resolved = () => readerState(tab, `JSON.stringify(HDYouTube.resolve(HDYouTube.observe(document.getElementById("word"))))`);
  await waitUntil(async () => JSON.parse((await resolved()).value ?? "null")?.cue?.startMs === CUE.startMs,
    "the reader resolves the caption to its cue from the player's file");
  console.log("the player's caption file reached the reader");

  let box = await (await tab.$("#word")).boundingBox();
  const onWord = () => [box.x + 12, box.y + box.height / 2];
  const away = [985, 8];
  const playback = () => tab.evaluate(() => ({ paused: document.querySelector("video").paused, calls: [...window.__fixture.calls],
    frames: window.__fixture.frames, mediaMs: document.querySelector("video").currentTime * 1000 }));
  async function leaveLine() {
    await tab.mouse.move(...away);
    await new Promise(done => setTimeout(done, 600));
  }
  async function playFrom(ms) {
    await leaveLine();
    await tab.evaluate(async from => {
      const video = document.querySelector("video");
      video.currentTime = from / 1000;
      await video.play();
    }, ms);
    return playback();
  }
  // Hover the word until its popup is ready, then add with the popup's Alt+E keybind.
  async function addNote() {
    const added = notes.length;
    const deadline = Date.now() + 60_000;
    while (notes.length === added && Date.now() < deadline) {
      await tab.mouse.move(box.x + 4, box.y + box.height / 2);
      await new Promise(done => setTimeout(done, 300));
      await tab.mouse.move(...onWord());
      await new Promise(done => setTimeout(done, 700));
      await tab.keyboard.down("Alt");
      await tab.keyboard.press("KeyE");
      await tab.keyboard.up("Alt");
      for (let wait = 0; wait < 20 && notes.length === added; wait++) await new Promise(done => setTimeout(done, 500));
    }
    assert.equal(notes.length, added + 1, `a note was added (${(await readerState(tab)).statuses.join(" | ")})`);
    return notes.at(-1);
  }

  // Hovering the playing caption pauses the video through YouTube's player,
  // and leaving the caption and the popup resumes it.
  let start = await playFrom(CUE.startMs + 200);
  await tab.mouse.move(...onWord());
  await waitUntil(async () => (await playback()).paused, "hovering the playing caption pauses it");
  await new Promise(done => setTimeout(done, 1500));
  await tab.screenshot({ path: resolve(output, "youtube-popup.png") });
  await tab.mouse.move(...away);
  await waitUntil(async () => !(await playback()).paused, "leaving the caption and the popup resumes it");
  let after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pauseVideo", "playVideo"], "through YouTube's player");
  console.log("hover pause and resume through the player");

  // A line the viewer heard at 1× is cut from what was kept: no seek, player
  // call or recorder frame. It is paused just after its padded end, while the
  // caption is still matched to its cue.
  await playFrom(1500);
  await tab.waitForFunction(end => document.querySelector("video").currentTime * 1000 >= end, { timeout: 10_000 },
    CUE.endMs + PAD_MS + 50);
  await tab.evaluate(() => document.querySelector("video").pause());
  start = await playback();
  let note = await addNote();
  assert.match(note.fields.Back, /^朝ごはんを<b>食べたかった<\/b><br>\[sound:/u, "the sentence is the whole cue, with its audio");
  const audioFile = /\[sound:(hachidori-sentence-audio-[0-9a-f-]{36}\.wav)\]/u.exec(note.fields.Back)?.[1];
  const clip = Buffer.from(media.get(audioFile), "base64");
  const rate = clip.readUInt32LE(24);
  const samples = new Float32Array(clip.readUInt32LE(40) / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = clip.readInt16LE(44 + index * 2) / 0x8000;
  const fromMs = CUE.startMs - PAD_MS;
  const durationMs = samples.length * 1000 / rate;
  assert.ok(Math.abs(durationMs - (CUE.endMs - CUE.startMs + 2 * PAD_MS)) <= 5, `the clip is the cue with its pads (${durationMs} ms)`);
  // Each second's tone is where it played, away from the changes of tone.
  for (const atMs of [1850, 2500, 3500]) {
    const length = Math.round(rate / 50);
    const from = Math.round((atMs - fromMs) * rate / 1000) - length / 2;
    let energy = 0;
    for (let index = from; index < from + length; index++) energy += samples[index] ** 2;
    const powers = Array.from({ length: AUDIO_SECONDS }, (_, second) => tonePower(samples, rate, toneHz(second), from, length));
    assert.ok(Math.sqrt(energy / length) > 0.05, `the clip is audible at media ${atMs} ms`);
    assert.equal(powers.indexOf(Math.max(...powers)), Math.floor(atMs / 1000), `media ${atMs} ms holds its second's tone`);
  }
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "nothing replayed or played the line");
  assert.equal(after.frames, start.frames, "no recorder frame");
  console.log(`a heard line: whole-cue sentence and ${durationMs.toFixed(1)} ms of its audio, cut without a replay`);

  // {screenshot} is the video's own frame: on a video of frames the stored
  // JPEG has the video's size and colour, not the viewport's.
  await writeOptions({ back: "{screenshot}" });
  await leaveLine();
  await tab.evaluate(() => window.__canvasVideo());
  note = await addNote();
  const pictureFile = /<img src="(hachidori-screenshot-[0-9a-f-]{36}\.jpg)">/u.exec(note.fields.Back)?.[1];
  assert.ok(pictureFile, `the note references its screenshot: ${note.fields.Back}`);
  const picture = await settings.evaluate(async base64 => {
    const decoder = new ImageDecoder({ data: Uint8Array.from(atob(base64), character => character.charCodeAt(0)), type: "image/jpeg" });
    const { image } = await decoder.decode();
    const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const [red, green, blue] = context.getImageData(image.displayWidth / 2, image.displayHeight / 2, 1, 1).data;
    return { width: image.displayWidth, height: image.displayHeight, red, green, blue };
  }, media.get(pictureFile));
  assert.deepEqual([picture.width, picture.height], [320, 180], `the screenshot is the video's frame: ${JSON.stringify(picture)}`);
  assert.ok(Math.abs(picture.red - 200) < 24 && Math.abs(picture.green - 40) < 24 && Math.abs(picture.blue - 160) < 24,
    `the screenshot shows the video's picture: ${JSON.stringify(picture)}`);
  console.log("{screenshot}: the video's own frame");

  // The player moves to the next video inside the page: its caption file
  // becomes the timeline, and the previous video's is dropped.
  await leaveLine();
  await tab.evaluate(next => window.__navigate(next), NEXT);
  await tab.waitForFunction(() => window.__fixture.captions.length === 2);
  assert.deepEqual(timedtext, [VIDEO, NEXT]);
  await tab.evaluate(async () => {
    await window.__toneVideo();
    document.querySelector("video").currentTime = 2;
  });
  const next = await readerState(tab, `JSON.stringify((() => {
    const observation = HDYouTube.observe(document.querySelector(".ytp-caption-segment"));
    return { movieId: observation.movieId, cue: HDYouTube.resolve(observation).cue ?? null };
  })())`);
  assert.deepEqual(JSON.parse(next.value), { movieId: NEXT, cue: { movieId: NEXT, trackId: "shown", startMs: 1000, endMs: 5000,
    text: "パンを食べたかった" } }, "the next video's line resolves to its own cue");
  console.log("the next video has its own timeline");

  if (GIF) {
    // A click on Hachidori's toolbar button lets it record the tab; a {gif}
    // note then records the line once and keeps only the video of the tab.
    await tab.goto(WATCH);
    await tab.waitForFunction(() => window.__fixture?.ready === true && window.__fixture.captions.length === 1);
    box = await (await tab.$("#word")).boundingBox();
    await writeOptions({ back: "{gif}" });
    for (let attempt = 1; ; attempt++) {
      await tab.bringToFront();
      await tab.triggerExtensionAction((await browser.extensions()).get(id));
      const popup = await browser.waitForTarget(target => target.url() === `chrome-extension://${id}/toolbar.html`);
      await (await popup.asPage()).close();
      const granted = await worker.evaluate(async () => {
        const [watching] = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
        return chrome.tabCapture.getMediaStreamId({ targetTabId: watching.id }).then(() => true, () => false);
      });
      if (granted) break;
      assert.ok(attempt < 3, "a click on the toolbar button lets Hachidori record the tab");
    }
    await tab.bringToFront();
    await tab.evaluate(() => { document.querySelector("video").currentTime = 3.7; });
    note = await addNote();
    const gifFile = /<img src="(hachidori-gif-[0-9a-f-]{36}\.gif)">/u.exec(note.fields.Back)?.[1];
    if (!gifFile) await new Promise(done => setTimeout(done, 1000));
    assert.ok(gifFile, `the note references the line's GIF: ${note.fields.Back} (${(await readerState(tab)).statuses.join(" | ")})`);
    const bytes = Buffer.from(media.get(gifFile), "base64");
    const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
    // The GIF keeps the 854 × 480 player alone, so it has the player's shape.
    assert.ok(Math.abs(width / height - 854 / 480) < 0.05, `the GIF is cropped to the video (${width} × ${height})`);
    writeFileSync(resolve(output, "youtube-line.gif"), bytes);
    console.log(`{gif}: ${width} × ${height}, ${(bytes.length / 1024).toFixed(1)} KiB, cropped to the video`);
  }

  // Switched off, the page that still has the scripts pauses nothing.
  await writeOptions({ youtube: false });
  await waitUntil(async () => (await registered()) === 0, "the YouTube scripts are unregistered once the switch is off");
  await new Promise(done => setTimeout(done, 500));
  box = await (await tab.$(".ytp-caption-segment")).boundingBox();
  start = await playFrom(1500);
  await tab.mouse.move(...onWord());
  await new Promise(done => setTimeout(done, 1500));
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "switched off, hovering pauses nothing");
  assert.equal(after.paused, false, "the video plays on");
  passed = true;
  console.log(`YouTube mining fixture: ${notes.length} notes; the player's caption file, hover pause and resume, `
    + "a heard line's whole-cue sentence and audio without a replay, the video's frame as {screenshot}, the next video's "
    + `timeline${GIF ? ", a {gif} cropped to the video" : ""}, and nothing paused with the switch off — passed`);
} finally {
  await browser?.close();
  anki.close();
  if (passed) rmSync(profile, { recursive: true, force: true });
  else console.log(`profile kept at ${profile}`);
}
