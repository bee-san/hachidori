// SPDX-License-Identifier: GPL-3.0-or-later
//
// Experimental Netflix mining in a real Chrome, without Netflix: a fixture page
// served at https://www.netflix.com/watch/81000001 by request interception, with
// a fake Netflix player over a <video> whose sound is a different tone each
// second, a synthetic manifest and WebVTT, and a fake AnkiConnect. Netflix's
// player API lists a second session after the watch page's own, the next
// episode it prepares, which must never be paused, played or seeked (#548).
//
// The watch page is open before Netflix mining is switched on, as when the
// switch is turned on in Settings while watching (#548): its reader must get
// the Netflix scripts, so that hovering the playing line pauses it through the
// player and leaving resumes it, and its note says that the episode's timing
// needs a reload. After the reload it mines the subtitle word through the real
// popup. Each note's WAV, decoded, must be the cue with its pads, audible
// except within 125 ms of its ends, with the tone of every second the padded
// cue covers and no other, each change of tone within 125 ms of its place:
// - before any click on Hachidori's toolbar button: a line the viewer heard is
//   cut from what was kept (no seek, player call or recorder frame), a line
//   not heard is replayed audibly through the player (no recorder frame), and
//   a line hover pause stopped partway plays on to its end without a seek;
//   with {gif} mapped too, the note says Chrome has not let Hachidori record
//   the tab and still gets the sentence audio, and on a page whose own Web
//   Audio graph has the video, sentence audio says the same;
// - after the click (CDP's Extensions.triggerAction runs the action as a click
//   does, which grants tab capture on the tab), that page's line is recorded
//   from the tab while it replays, and one replay of a line never heard
//   records a looping GIF that Chrome decodes into more than one distinct
//   frame while the line audio keeps its sound, each seeking only through the
//   player and restoring the viewer's state.
// Then hover pause around a note's replay; a note added while the viewer plays
// it on over the line must leave it paused, never played on while the recorder
// runs, until the pointer leaves; a note whose only Netflix field is {gif} gets
// the GIF alone; and nothing pauses once the switch is off.
//
// Netflix is never contacted: request interception serves the fixture, and the
// browser resolves no host but 127.0.0.1, so not even a preconnect leaves.
//
// Not part of the default runs. The browser runs headful because headless
// Chrome captures tab audio as silence, and needs Extensions.triggerAction,
// which CDP has had since Chromium r1577676 (January 2026), so not the
// manifest's minimum Chrome 128. On Linux without a display, run it under Xvfb:
//
//   node test/make-fixture.mjs && xvfb-run -a node test/chrome-netflix-mining.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require(process.env.HACHIDORI_PUPPETEER || "puppeteer-core");
const extension = realpathSync(resolve(root, "extension"));
const chrome = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${require("./package.json").config.chrome}/chrome-linux64/chrome`);
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-netflix-mining-"));
const WATCH = "https://www.netflix.com/watch/81000001";
// The same page playing its video through its own Web Audio graph.
const OWN_GRAPH = `${WATCH}?graph=page`;
const SAMPLE_RATE = 48_000;
const AUDIO_SECONDS = 8;
// The fixture's tone in each second of media time: 400 Hz, 600 Hz, … 1800 Hz.
const toneHz = second => 400 + 200 * second;
const CUE = { startMs: 2000, endMs: 3600 };
const PAD_MS = 250;
const TOLERANCE_MS = 125;

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

const manifest = JSON.stringify({ version: 2, result: { movieId: 81000001, textTracks: [
  { id: "ja-forced", language: "ja", isForcedNarrative: true, downloadables: {} },
  { id: "ja-track", language: "ja", rawTrackType: "subtitles", isImageBased: false,
    downloadables: { "webvtt-lssdh-ios8": { urls: [{ url: "https://www.netflix.com/fixture/ja.vtt" }] } } },
] } });
const vtt = `WEBVTT\n\n1\n00:00:02.000 --> 00:00:03.600 position:50.00%,middle align:middle\n&lrm;朝ごはんを\n&lrm;食べたかった\n`;

// The parts of Netflix's watch page the feature uses. The fake player seeks
// with the element's own setter and records it; any other write counts. It
// also records each play and pause it is asked for, and whether a play came
// while Hachidori's recorder frame was in the page (the tab is muted then).
// Like Netflix's, its session is named `watch-…`, says which movie it plays
// and has its element inside the player; Netflix's player API lists after it
// the next episode it prepares, whose element is outside the player and whose
// calls are recorded as `background`.
const page = `<!doctype html><meta charset="utf-8"><title>Netflix fixture</title>
<style>body{margin:0;background:#000;color:#fff;font:40px sans-serif}
.player-timedtext{position:absolute;left:0;right:0;top:300px;text-align:center}
#motion{position:absolute;left:0;top:0;width:1200px;height:260px;display:block}</style>
<div class="watch-video"><div data-uia="player" data-videoid="81000001"><video preload="auto"></video>
<canvas id="motion" width="1200" height="260"></canvas>
<div class="player-timedtext"><div class="player-timedtext-text-container"><span>朝ごはんを</span><br><span id="word">食べたかった</span></div></div></div></div>
<script>
// A moving coloured band so the captured tab has visibly changing frames: the
// GIF of the replay must then decode with more than one frame.
const motion = document.getElementById("motion");
const paint = motion.getContext("2d");
function animate(now) {
  paint.fillStyle = "#102040";
  paint.fillRect(0, 0, motion.width, motion.height);
  const x = (now / 4) % (motion.width + 200) - 100;
  paint.fillStyle = \`hsl(\${(now / 10) % 360}, 80%, 55%)\`;
  paint.fillRect(x, 40, 180, 180);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
const video = document.querySelector("video");
// With ?graph, the page plays its video through its own Web Audio graph, as
// another extension can. Hachidori cannot keep that element's sound, so its
// lines are recorded with tab capture while they replay.
if (new URLSearchParams(location.search).has("graph")) {
  const graph = new AudioContext();
  graph.createMediaElementSource(video).connect(graph.destination);
}
const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
const evidence = window.__fixture = { seeks: [], calls: [], background: [], directWrites: 0, profiles: null, frames: 0 };
// Every recorder frame the extension adds, which tab capture needs and the line audio does not.
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) if (node.nodeName === "IFRAME") evidence.frames++;
}).observe(document.documentElement, { childList: true, subtree: true });
let seeking = false;
Object.defineProperty(video, "currentTime", { configurable: true,
  get() { return native.get.call(this); },
  set(value) { if (!seeking) evidence.directWrites++; native.set.call(this, value); } });
const player = {
  seek(ms) { evidence.seeks.push(ms); seeking = true; video.currentTime = ms / 1000; seeking = false; },
  play() { evidence.calls.push(document.querySelector("iframe") ? "play while recording" : "play"); return video.play(); },
  pause() { evidence.calls.push("pause"); video.pause(); },
  getCurrentTime() { return video.currentTime * 1000; },
  getMovieId: () => 81000001,
  getElement: () => video,
};
const nextEpisode = {
  seek(ms) { evidence.background.push(["seek", ms]); },
  play() { evidence.background.push(["play"]); return Promise.resolve(); },
  pause() { evidence.background.push(["pause"]); },
  getCurrentTime: () => 0,
  getMovieId: () => 81000002,
  getElement: () => document.createElement("video"),
};
const sessions = new Map([["watch-1", player], ["watch-2", nextEpisode]]);
window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
  getAllPlayerSessionIds: () => [...sessions.keys()], getVideoPlayerBySessionId: id => sessions.get(id) ?? null } }) } } } };
video.addEventListener("loadeddata", () => {
  player.seek(3500);
  video.playbackRate = 1.25;
  // Netflix's manifest exchange, as its bundle makes it.
  evidence.profiles = JSON.parse(JSON.stringify({ params: { profiles: ["heaac-2-dash", "playready-h264mpl30-dash"] } })).params.profiles;
  JSON.parse(${JSON.stringify(manifest)});
  evidence.ready = true;
}, { once: true });
// A blob is seekable; an intercepted response without range support is not.
fetch("/fixture/line.wav").then(response => response.blob()).then(blob => { video.src = URL.createObjectURL(blob); });
</script>`;

// The reader's own world and the popup's Anki statuses, through CDP: Puppeteer
// reaches neither the content scripts' isolated world nor the popup's closed
// shadow root, which CDP's piercing DOM sees through. `expression` is
// evaluated in the reader's world.
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

// What the reader's own world sees, for a failure report.
async function diagnose(tab) {
  const { value: reader, statuses } = await readerState(tab, `JSON.stringify({ netflix: typeof HDNetflix,
    subtitles: typeof HDNetflixSubtitles, observation: HDNetflix?.observe(document.getElementById("word")),
    resolved: HDNetflix?.resolve(HDNetflix.observe(document.getElementById("word"))) })`);
  return { statuses, reader, page: await tab.evaluate(() => JSON.stringify(window.__fixture)),
    video: await tab.evaluate(() => JSON.stringify((v => ({ t: v.currentTime, ready: v.readyState, seeking: v.seeking,
      duration: v.duration, paused: v.paused, error: v.error?.message ?? null }))(document.querySelector("video")))) };
}

// Polls `probe` until it is true, for at most `ms`.
async function waitUntil(probe, message, ms = 10_000) {
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

// The RMS above which a 20 ms window holds the fixture's tone (a quarter of
// full scale, about 0.18) rather than silence.
const AUDIBLE_RMS = 0.05;
// A near-silent run this long is a silence: the clip's silent edge or a gap at
// a join, never one of the tone's zero crossings.
const SILENCE_MS = 1;

// What a clip of the fixture's sound holds, in 20 ms windows every 10 ms:
// each window's RMS, whether it holds a silence, and the strongest of the
// fixture's tones in it; the longest run of near-silent samples and where it
// starts; and where each change of second's tone falls: the first audible
// window centre with no silence at which the next tone is the stronger. A
// window that holds a sound's onset after a silence spreads it over every
// frequency, so only windows with no silence tell which tone it is.
// `fromMs` is the media time of the clip's first sample.
function analyseClip(samples, rate, fromMs) {
  const length = Math.round(rate / 50);
  const toMs = fromMs + samples.length * 1000 / rate;
  const silenceFrames = Math.round(SILENCE_MS * rate / 1000);
  const silences = [];
  let gap = 0, longestGap = 0, gapEnd = 0;
  samples.forEach((sample, index) => {
    gap = Math.abs(sample) < 0.01 ? gap + 1 : 0;
    if (gap > longestGap) [longestGap, gapEnd] = [gap, index + 1];
    if (gap === silenceFrames) silences.push({ start: index + 1 - gap, end: index + 1 });
    else if (gap > silenceFrames) silences.at(-1).end = index + 1;
  });
  const silent = (start, end) => silences.some(silence => silence.start < end && silence.end > start);
  const windows = [];
  for (let start = 0; start + length <= samples.length; start += Math.round(length / 2)) {
    let energy = 0;
    for (let index = start; index < start + length; index++) energy += samples[index] ** 2;
    const powers = Array.from({ length: AUDIO_SECONDS }, (_, second) => tonePower(samples, rate, toneHz(second), start, length));
    windows.push({ centreMs: fromMs + (start + length / 2) * 1000 / rate, rms: Math.sqrt(energy / length),
      silent: silent(start, start + length), strongest: powers.indexOf(Math.max(...powers)) });
  }
  const changes = [];
  for (let second = Math.ceil(fromMs / 1000); second * 1000 < toMs; second++) {
    const boundary = second * 1000;
    let found = null;
    for (let centre = Math.max(fromMs + 10, boundary - 300); centre <= Math.min(toMs - 10, boundary + 300) && found === null; centre++) {
      const start = Math.round((centre - fromMs) * rate / 1000) - length / 2;
      let energy = 0;
      for (let index = start; index < start + length; index++) energy += samples[index] ** 2;
      if (Math.sqrt(energy / length) > AUDIBLE_RMS && !silent(start, start + length)
          && tonePower(samples, rate, toneHz(second), start, length) > tonePower(samples, rate, toneHz(second - 1), start, length)) {
        found = centre;
      }
    }
    changes.push({ boundary, foundMs: found });
  }
  return { windows, longestGapMs: longestGap * 1000 / rate, gapAtMs: fromMs + (gapEnd - longestGap) * 1000 / rate, changes };
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

const id = extensionId(extension);
let browser;
let passed = false;
try {
  browser = await puppeteer.launch({
    executablePath: chrome, headless: false, enableExtensions: true, userDataDir: profile,
    // Over a pipe, with extension debugging on, CDP can run the toolbar action as a click does.
    pipe: true,
    // Request interception answers the page's requests, but Chrome preconnects
    // to an address it is about to load before any request exists, so every
    // host but the fake AnkiConnect's loopback address is left unresolvable.
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
      "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-extension-debugging",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  console.log(`browser ${await browser.version()}`);
  const workerTarget = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  assert.equal(new URL(workerTarget.url()).host, id, "the computed extension ID is the one Chrome loaded");
  const worker = await workerTarget.worker();
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120_000);
  settings.on("pageerror", error => console.log("settings error:", error.message));
  await settings.goto(`chrome-extension://${id}/settings.html#advanced`);
  await settings.bringToFront();
  console.log("settings loaded");
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))],
      { type: "application/zip" }));
    try {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: "netflix-fixture-import", blobUrl, fileName: "hachidori-fixture.zip" });
      if (!reply.ok) throw new Error(reply.error);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, readFileSync(resolve(root, "test/fixtures/hachidori-fixture.zip")).toString("base64"));
  console.log("fixture imported");
  // The Basic note type's Back field template, written through the options queue.
  const mapBack = back => settings.evaluate(async (ankiUrl, value) => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { hoverEnabled: true, lookupMode: "hover",
        // The same word is added again and again.
        anki: { ...HDReaderOptions.DEFAULT_OPTIONS.anki, url: ankiUrl, model: "Basic", captureScreenshot: false,
          duplicateBehavior: "new",
          fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
            Back: { value, overwriteMode: "overwrite" } } } } });
    if (!reply.ok) throw new Error(reply.error);
  }, `http://127.0.0.1:${anki.address().port}`, back);
  await mapBack("{sentence}<br>{sentence-audio}");
  // The switch, through the options queue. The open Netflix page keeps its
  // scripts, which follow the switch once its reader has the new options. The
  // worker applies the switch just after the write's reply; Settings is a
  // background tab here, where Chrome pauses animation frames and slows
  // timers, so the registered scripts are polled from Node.
  async function setSwitch(enabled) {
    await settings.evaluate(async on => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options.revision, options: { experimental: { ...options.experimental, netflixMining: on } } });
      if (!reply.ok) throw new Error(reply.error);
    }, enabled);
    for (const deadline = Date.now() + 30_000; ;) {
      const registered = await settings.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
      if (registered === (enabled ? 2 : 0)) break;
      assert.ok(Date.now() < deadline, `the Netflix scripts follow the switch (${registered} registered)`);
      await new Promise(done => setTimeout(done, 100));
    }
    await new Promise(done => setTimeout(done, 500));
  }

  const tab = await browser.newPage();
  tab.setDefaultTimeout(60_000);
  await tab.setViewport({ width: 1200, height: 700 });
  await tab.setRequestInterception(true);
  const wav = toneWav();
  tab.on("request", request => {
    const url = request.url();
    // A locked-down page: no frames of its own, no capture features. The
    // extension's recorder frame and tab capture must still work.
    if (url === WATCH || url === OWN_GRAPH) {
      return request.respond({ contentType: "text/html; charset=utf-8", body: page, headers: {
        "Content-Security-Policy": "frame-src 'none'; child-src 'none'; object-src 'none'",
        "Permissions-Policy": "microphone=(), camera=(), display-capture=()" } });
    }
    if (url === "https://www.netflix.com/fixture/ja.vtt") {
      return request.respond({ contentType: "text/vtt; charset=utf-8", headers: { "Access-Control-Allow-Origin": "*" }, body: vtt });
    }
    if (url === "https://www.netflix.com/fixture/line.wav") return request.respond({ contentType: "audio/wav", body: wav });
    if (url.startsWith("https://www.netflix.com/")) return request.respond({ status: 404, body: "" });
    return request.continue();
  });
  tab.on("pageerror", error => console.log("watch page error:", error.message));
  // The watch page is opened while the switch is still off.
  await tab.goto(WATCH);
  await tab.waitForFunction(() => window.__fixture?.ready === true);
  console.log("watch page ready, Netflix mining off");
  await tab.bringToFront();
  let box = await (await tab.$("#word")).boundingBox();
  const onWord = () => [box.x + 12, box.y + box.height / 2];
  const away = [1150, 30];
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
    if (notes.length === added) console.log("diagnostics:", JSON.stringify(await diagnose(tab)));
    assert.equal(notes.length, added + 1, `a note was added (${notes.length - added})`);
    return notes.at(-1);
  }
  // Chrome's own GIF decoder: the frame count, loop count and size, and how many
  // decoded frames differ, from the GIF the fake AnkiConnect stored.
  async function decodeGif(filename) {
    const bytes = Buffer.from(media.get(filename), "base64");
    const decoded = await settings.evaluate(async base64 => {
      const decoder = new ImageDecoder({ data: Uint8Array.from(atob(base64), character => character.charCodeAt(0)),
        type: "image/gif" });
      await decoder.tracks.ready;
      await decoder.completed;
      const track = decoder.tracks.selectedTrack;
      const digests = new Set();
      let width = 0, height = 0;
      for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
        const { image } = await decoder.decode({ frameIndex });
        width = image.displayWidth;
        height = image.displayHeight;
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        image.close();
        const pixels = context.getImageData(0, 0, width, height).data;
        digests.add([...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))].join(","));
      }
      decoder.close();
      return { frames: track.frameCount, loop: String(track.repetitionCount), width, height, distinct: digests.size };
    }, bytes.toString("base64"));
    return { ...decoded, kib: bytes.length / 1024 };
  }

  // The note's WAV, decoded, must be the cue with its pads, with the
  // fixture's tone for every second of media time the padded cue covers and
  // no other: each audible window that holds no silence, away from a change of
  // tone, holds its own second's tone, and each change lands within
  // TOLERANCE_MS of its place. It must be audible throughout, except within
  // TOLERANCE_MS of its ends, where a clip that is that late or early holds
  // what played before or after the line.
  function checkLineAudio(back, label) {
    const filename = /\[sound:(hachidori-sentence-audio-[0-9a-f-]{36}\.wav)\]/u.exec(back)?.[1];
    assert.ok(filename, `${label}: the note references the line's WAV: ${back}`);
    const clip = Buffer.from(media.get(filename), "base64");
    assert.equal(clip.toString("ascii", 0, 4), "RIFF");
    assert.equal(clip.readUInt16LE(22), 1, `${label}: the WAV is mono`);
    const rate = clip.readUInt32LE(24);
    const samples = new Float32Array(clip.readUInt32LE(40) / 2);
    for (let index = 0; index < samples.length; index++) samples[index] = clip.readInt16LE(44 + index * 2) / 0x8000;
    const fromMs = CUE.startMs - PAD_MS;
    const toMs = CUE.endMs + PAD_MS;
    const durationMs = samples.length * 1000 / rate;
    const { windows, longestGapMs, gapAtMs, changes } = analyseClip(samples, rate, fromMs);
    const expected = new Set();
    for (let second = Math.floor(fromMs / 1000); second * 1000 < toMs; second++) expected.add(second);
    const audible = windows.filter(window => window.rms > AUDIBLE_RMS && !window.silent);
    const heard = new Set(audible.map(window => window.strongest));
    const inside = windows.filter(window => window.centreMs - fromMs > TOLERANCE_MS && toMs - window.centreMs > TOLERANCE_MS);
    const quietest = Math.min(...inside.map(window => window.rms));
    const misplaced = audible.filter(window => Math.abs(window.centreMs - Math.round(window.centreMs / 1000) * 1000) > TOLERANCE_MS
      && window.strongest !== Math.floor(window.centreMs / 1000));
    const offsets = changes.map(change => (change.foundMs === null ? null : change.foundMs - change.boundary));
    console.log(`${label}: clip ${durationMs.toFixed(1)} ms at ${rate} Hz; tones ${[...heard].sort().map(toneHz).join(", ")} Hz; `
      + `changes of tone at ${offsets.map(offset => (offset === null ? "none" : `${offset >= 0 ? "+" : ""}${offset} ms`)).join(", ")}; `
      + `quietest 20 ms inside at ${quietest.toFixed(3)} RMS; longest near-silent run ${longestGapMs.toFixed(1)} ms`
      + `${longestGapMs > 0 ? ` at media ${gapAtMs.toFixed(1)} ms` : ""}`);
    assert.ok(Math.abs(durationMs - (toMs - fromMs)) <= 5, `${label}: the clip is the cue with its pads (${durationMs} ms)`);
    assert.ok(quietest > AUDIBLE_RMS, `${label}: no 20 ms of the clip is silent, away from its ends (${quietest})`);
    assert.deepEqual([...heard].sort(), [...expected].sort(), `${label}: the clip holds the tones of the padded cue's seconds and no other`);
    assert.deepEqual(misplaced.map(window => Math.round(window.centreMs)), [], `${label}: each second's tone is where it was played`);
    assert.ok(offsets.every(offset => offset !== null && Math.abs(offset) <= TOLERANCE_MS),
      `${label}: each change of tone is within ${TOLERANCE_MS} ms of its place (${offsets})`);
  }

  // The fixture's record of the extension's player calls and the video's state.
  // The viewer plays and pauses with the element's own play() and pause(), so
  // the record holds only the extension's calls.
  const playback = () => tab.evaluate(() => ({ paused: document.querySelector("video").paused,
    calls: [...window.__fixture.calls], seeks: window.__fixture.seeks.length, seekTargets: [...window.__fixture.seeks],
    directWrites: window.__fixture.directWrites, frames: window.__fixture.frames, background: [...window.__fixture.background],
    rate: document.querySelector("video").playbackRate, mediaMs: document.querySelector("video").currentTime * 1000 }));
  // Away from the line for long enough that an open popup hides, so the next
  // hover looks the word up afresh rather than showing the note just added.
  async function leaveLine() {
    await tab.mouse.move(...away);
    await new Promise(done => setTimeout(done, 600));
  }
  async function playFrom(ms, rate = 1) {
    await leaveLine();
    await tab.evaluate(async (from, speed) => {
      window.netflix.appContext.state.playerApp.getAPI().videoPlayer.getVideoPlayerBySessionId("watch-1").seek(from);
      const video = document.querySelector("video");
      video.playbackRate = speed;
      await video.play();
    }, ms, rate);
    return playback();
  }
  // The video paused at `ms`, at `rate`.
  async function standAt(ms, rate = 1) {
    await leaveLine();
    await tab.evaluate((at, speed) => {
      window.netflix.appContext.state.playerApp.getAPI().videoPlayer.getVideoPlayerBySessionId("watch-1").seek(at);
      const video = document.querySelector("video");
      video.pause();
      video.playbackRate = speed;
    }, ms, rate);
    return playback();
  }
  // Waits for the extension's next player calls and the paused state they leave.
  async function waitForCalls(start, added, paused, message) {
    try {
      await tab.waitForFunction((count, wanted) => window.__fixture.calls.length === count
        && document.querySelector("video").paused === wanted, { timeout: 10_000 }, start.calls.length + added, paused);
    } catch {
      const now = await playback();
      assert.fail(`${message}: calls ${JSON.stringify(now.calls.slice(start.calls.length))}, paused ${now.paused}`);
    }
  }
  const waitForStatus = (pattern, message) => waitUntil(async () => (await readerState(tab)).statuses
    .some(status => pattern.test(status)), message);

  // #548: the switch goes on in Settings while the watch page is open. Chrome
  // adds the registered scripts only to pages that load after that, so before
  // the fix this page never paused and its notes had no sentence audio.
  let start = await playFrom(CUE.startMs + 200);
  await tab.mouse.move(...onWord());
  await new Promise(done => setTimeout(done, 1000));
  let after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "with the switch off, hovering pauses nothing");
  assert.equal((await readerState(tab, "typeof HDNetflix")).value, "undefined", "the page has no Netflix scripts yet");
  // That popup closes first: its Anki readiness was checked with the switch
  // off, which the worker refuses once the switch has changed.
  await leaveLine();
  await settings.bringToFront();
  await settings.waitForSelector("#opt-experimental-netflixMining", { visible: true });
  await settings.click("#opt-experimental-netflixMining");
  await settings.waitForFunction(async () => (await chrome.scripting.getRegisteredContentScripts()).length === 2);
  console.log("Netflix scripts registered");
  await tab.bringToFront();
  await waitUntil(async () => (await readerState(tab, "typeof HDNetflix?.setHoverPause")).value === "function",
    "the open watch page gets the Netflix scripts once the switch is on");
  // The reader turns hover pause on once the worker has answered, just after
  // the scripts run, so the pointer enters the line until the video pauses.
  start = await playFrom(CUE.startMs + 200);
  await waitUntil(async () => {
    await tab.mouse.move(...away);
    await new Promise(done => setTimeout(done, 400));
    await tab.mouse.move(...onWord());
    await new Promise(done => setTimeout(done, 400));
    return (await playback()).calls.length > start.calls.length;
  }, "hovering the playing line pauses it in the page that got the scripts late");
  await waitForCalls(start, 1, true, "hovering the playing line pauses it in the page that got the scripts late");
  await tab.mouse.move(...away);
  await waitForCalls(start, 2, false, "leaving the line and the popup resumes it");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pause", "play"], "the page that got the scripts late pauses and resumes through the player");
  assert.deepEqual(after.background, [], "the next episode's session was never paused, played or seeked");
  // Netflix read this episode's subtitle list before the page's hooks were
  // there, so its note gets no timing and says to reload the page.
  let note = await addNote();
  assert.doesNotMatch(note.fields.Back, /\[sound:/u, "without the episode's timing there is no sentence audio");
  await waitForStatus(/Sentence audio: Netflix's subtitle timing for this episode was not found\. Reload the Netflix page/u,
    "the note says to reload the Netflix page");
  console.log("late scripts: hover pause and resume through the player; the note says to reload");

  // Reloaded, the page has the scripts from the start.
  await leaveLine();
  await tab.reload();
  await tab.waitForFunction(() => window.__fixture?.ready === true);
  box = await (await tab.$("#word")).boundingBox();
  console.log("watch page reloaded");

  // No toolbar click yet: sentence audio needs no capture grant. A line the
  // viewer heard at 1× is cut from what was kept: no seek, no player call and
  // no recorder frame. It is paused just after its padded end, while the
  // subtitle would still be matched to its cue.
  await playFrom(1500);
  await tab.waitForFunction(end => document.querySelector("video").currentTime * 1000 >= end, { timeout: 10_000 },
    CUE.endMs + PAD_MS + 50);
  await tab.evaluate(() => document.querySelector("video").pause());
  start = await playback();
  note = await addNote();
  assert.match(note.fields.Back, /^朝ごはんを<b>食べたかった<\/b>/u, "the sentence is the whole cue");
  checkLineAudio(note.fields.Back, "heard");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "nothing replayed or played the line");
  assert.equal(after.seeks, start.seeks, "nothing seeked");
  assert.equal(after.frames, start.frames, "no recorder frame");
  assert.ok(Math.abs(after.mediaMs - start.mediaMs) < 1, "the video stayed where the viewer left it");

  // A line heard only at 1.25× was not kept (turning the switch off and on
  // frees what was): it replays once through the player, audibly, since no
  // recorder frame mutes the tab, and the viewer's position, pause and speed
  // are restored.
  await setSwitch(false);
  await setSwitch(true);
  await playFrom(1500, 1.25);
  await tab.waitForFunction(() => document.querySelector("video").currentTime >= 3.4, { timeout: 10_000 });
  await tab.evaluate(() => document.querySelector("video").pause());
  start = await playback();
  note = await addNote();
  checkLineAudio(note.fields.Back, "replayed");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["play", "pause"], "the line was replayed once through the player");
  assert.deepEqual(after.seekTargets.slice(start.seeks), [CUE.startMs - PAD_MS, after.seekTargets.at(-1)],
    `one seek to the padded cue and one back: ${after.seekTargets.slice(start.seeks)}`);
  assert.ok(Math.abs(after.seekTargets.at(-1) - start.mediaMs) < 50, "the replay returns to the viewer's position");
  assert.equal(after.frames, start.frames, "no recorder frame");
  assert.ok(after.paused && after.rate === 1.25, `the paused video keeps its speed (${after.rate})`);

  // Hovered while it plays, the line stops partway: adding it plays the rest
  // once, audibly and without seeking, and stops at its end. The line was
  // just replayed in full, so the line audio starts afresh again.
  await setSwitch(false);
  await setSwitch(true);
  start = await playFrom(1700);
  await tab.waitForFunction(() => document.querySelector("video").currentTime >= 1.9, { timeout: 10_000 });
  await tab.mouse.move(...onWord());
  await waitForCalls(start, 1, true, "hovering the playing line pauses it partway");
  const pausedAt = (await playback()).mediaMs;
  assert.ok(pausedAt > CUE.startMs - PAD_MS && pausedAt < CUE.endMs - 1000, `paused partway through the line (${pausedAt} ms)`);
  note = await addNote();
  checkLineAudio(note.fields.Back, "played on");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pause", "play", "pause"], "the rest of the line played once");
  assert.equal(after.seeks, start.seeks, "nothing seeked");
  assert.equal(after.frames, start.frames, "no recorder frame");
  assert.ok(after.paused && after.mediaMs >= CUE.endMs + PAD_MS - 30, `it stopped at the line's end (${after.mediaMs} ms)`);
  await tab.mouse.move(...away);
  await waitForCalls(start, 4, false, "leaving plays the video on from the line's end");

  // With {gif} mapped too, tab capture needs the grant: the GIF says so, and
  // the sentence audio of the line just heard is still attached.
  await mapBack("{sentence}<br>{sentence-audio}<br>{gif}");
  start = await standAt(CUE.endMs + PAD_MS + 50);
  note = await addNote();
  checkLineAudio(note.fields.Back, "heard, with a GIF but no grant");
  assert.doesNotMatch(note.fields.Back, /hachidori-gif-/u, "no GIF without the grant");
  await waitForStatus(/GIF: Chrome has not let Hachidori record this tab yet\. Click Hachidori's toolbar button/u,
    "the note says the GIF needs the toolbar button");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "nothing was replayed without the grant");

  // When the page's own Web Audio graph has the video, Hachidori cannot keep
  // its sound, and sentence audio falls back to recording the tab while the
  // line replays, as every Netflix note did before #545. That needs the grant:
  // without it the note says so, and nothing is replayed.
  await mapBack("{sentence}<br>{sentence-audio}");
  await leaveLine();
  await tab.goto(OWN_GRAPH);
  await tab.waitForFunction(() => window.__fixture?.ready === true);
  box = await (await tab.$("#word")).boundingBox();
  start = await standAt(3500);
  note = await addNote();
  assert.doesNotMatch(note.fields.Back, /\[sound:/u, "without the grant, tab capture records nothing");
  await waitForStatus(/Sentence audio: Chrome has not let Hachidori record this tab yet\. Click Hachidori's toolbar button/u,
    "a line Hachidori cannot keep says sentence audio needs the toolbar button");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "nothing was replayed without the grant");
  console.log("without a capture grant: heard, replayed and played-on lines recorded; tab capture asks for the toolbar button");

  // A click on Hachidori's toolbar button in the watch tab. CDP runs the
  // action as a click does, granting tab capture on the window's active tab,
  // and opens the toolbar popup, which is closed again. The worker checks the
  // grant as the recorder will.
  for (let attempt = 1; ; attempt++) {
    await tab.bringToFront();
    const extensions = await browser.extensions().catch(error => {
      throw new Error(`this browser's DevTools protocol cannot click the toolbar button: ${error.message}`);
    });
    await tab.triggerExtensionAction(extensions.get(id));
    const popup = await browser.waitForTarget(target => target.url() === `chrome-extension://${id}/toolbar.html`);
    await (await popup.asPage()).close();
    const granted = await worker.evaluate(async () => {
      const [watching] = await chrome.tabs.query({ url: "https://www.netflix.com/*" });
      return chrome.tabCapture.getMediaStreamId({ targetTabId: watching.id }).then(() => true, () => false);
    });
    if (granted) break;
    assert.ok(attempt < 3, "a click on the toolbar button lets Hachidori record the tab");
  }
  await tab.bringToFront();
  console.log("toolbar button clicked");

  // With the grant, the page whose graph has the video records the line from
  // the tab while it replays once through the player, muted, and the
  // viewer's state is restored.
  start = await standAt(3500, 1.25);
  note = await addNote();
  checkLineAudio(note.fields.Back, "recorded from the tab");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["play while recording", "pause"],
    "the line was replayed once through the player while the recorder ran");
  assert.deepEqual(after.seekTargets.slice(start.seeks), [CUE.startMs - PAD_MS, after.seekTargets.at(-1)],
    `one seek to the padded cue and one back: ${after.seekTargets.slice(start.seeks)}`);
  assert.ok(Math.abs(after.seekTargets.at(-1) - 3500) < 50, "the replay returns to the viewer's position");
  assert.equal(after.frames - start.frames, 1, "one recorder frame");
  assert.ok(after.paused && after.rate === 1.25, `the paused video keeps its speed (${after.rate})`);

  // Back on the page whose sound Hachidori keeps. The grant lasts across
  // Netflix's navigations, which stay on its origin.
  await mapBack("{sentence}<br>{sentence-audio}<br>{gif}");
  await leaveLine();
  await tab.goto(WATCH);
  await tab.waitForFunction(() => window.__fixture?.ready === true);
  box = await (await tab.$("#word")).boundingBox();

  // A line never heard at 1× ({gif} mapped): one replay records the GIF with
  // tab capture, and the line audio keeps that replay's sound for the WAV.
  await setSwitch(false);
  await setSwitch(true);
  start = await standAt(3500, 1.25);
  note = await addNote();
  if (!/\[sound:/u.test(note.fields.Back)) console.log("diagnostics:", JSON.stringify(await diagnose(tab)));
  assert.match(note.fields.Back, /^朝ごはんを<b>食べたかった<\/b>/u, "the sentence is the whole cue");
  checkLineAudio(note.fields.Back, "replayed for its GIF");
  // The {gif} field holds the line's animated GIF: Chrome decodes it into more
  // than one distinct frame, from the moving band the fixture painted while the
  // line played, looping forever and at most 480 px wide.
  const gifFile = /<img src="(hachidori-gif-[0-9a-f-]{36}\.gif)">/u.exec(note.fields.Back)?.[1];
  assert.ok(gifFile, `the note references the line's GIF: ${note.fields.Back}`);
  const gif = await decodeGif(gifFile);
  console.log(`gif ${gif.kib.toFixed(1)} KiB, ${gif.width}×${gif.height}, ${gif.frames} frames decoded, ${gif.distinct} distinct`);
  assert.ok(gif.frames > 1 && gif.distinct > 1, `the GIF decodes into more than one distinct frame: ${JSON.stringify(gif)}`);
  assert.equal(gif.loop, "Infinity", "the GIF loops forever");
  assert.ok(gif.width > 0 && gif.width <= 480, `the GIF is at most 480 px wide (${gif.width})`);
  after = await playback();
  assert.deepEqual(await tab.evaluate(() => window.__fixture.profiles), ["webvtt-lssdh-ios8", "heaac-2-dash", "playready-h264mpl30-dash"]);
  assert.equal(after.directWrites, 0, "nothing but Netflix's player wrote currentTime");
  assert.deepEqual(after.seekTargets.slice(start.seeks), [CUE.startMs - PAD_MS, after.seekTargets.at(-1)],
    `one replay, there and back: ${after.seekTargets.slice(start.seeks)}`);
  assert.ok(Math.abs(after.seekTargets.at(-1) - 3500) < 50, "the replay returns to the viewer's position");
  assert.equal(after.frames - start.frames, 1, "one recorder frame, for the GIF");
  assert.equal(after.paused, true, "the paused video stays paused");
  assert.equal(after.rate, 1.25, "the viewer's speed is restored");

  // Hover pause and resume through the player.
  start = await playFrom(CUE.startMs + 200);
  await tab.mouse.move(...onWord());
  await waitForCalls(start, 1, true, "hovering the playing line pauses it");
  await tab.mouse.move(...away);
  await waitForCalls(start, 2, false, "leaving the line and the popup resumes it");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pause", "play"], "hovering pauses and leaving resumes, through the player");
  assert.equal(after.seeks, start.seeks, "the hover pause never seeks");

  // A note added during the hover pause: the replay restores the pause, and
  // leaving afterwards still resumes.
  start = await playFrom(CUE.startMs + 200);
  note = await addNote();
  assert.match(note.fields.Back, /\[sound:hachidori-sentence-audio-/u, "the paused line was recorded");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pause", "play while recording", "pause"],
    "the replay played the line and kept the pause");
  assert.equal(after.paused, true);
  await tab.mouse.move(...away);
  await waitForCalls(start, 4, false, "leaving after the replay resumes");
  assert.equal((await playback()).calls.at(-1), "play", "the resume goes through the player");

  // A note added while the viewer has played the video on over the line: it
  // stays paused, not played on in the muted tab, while the pointer is still
  // there, and plays on once the pointer leaves.
  start = await playFrom(CUE.startMs + 200);
  await tab.mouse.move(...onWord());
  await waitForCalls(start, 1, true, "hovering pauses before the viewer plays");
  await tab.evaluate(() => document.querySelector("video").play());
  await addNote();
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pause", "play while recording", "pause"],
    "the replay restored the playing video paused");
  assert.equal(after.paused, true, "the video stays paused while the pointer is on the line");
  await tab.mouse.move(...away);
  await waitForCalls(start, 4, false, "leaving after mining plays the video on");
  assert.equal((await playback()).calls.at(-1), "play", "the video plays on after the recorder has stopped");

  // A note whose only Netflix field is {gif}: the line is recorded for its GIF
  // alone, with no sentence audio. The paused video is placed inside the cue.
  await mapBack("{gif}");
  await standAt(CUE.startMs + 200);
  note = await addNote();
  const onlyGif = /^<img src="(hachidori-gif-[0-9a-f-]{36}\.gif)">$/u.exec(note.fields.Back)?.[1];
  assert.ok(onlyGif, `the {gif}-only note holds the line's GIF alone: ${note.fields.Back}`);
  const second = await decodeGif(onlyGif);
  assert.ok(second.frames > 1 && second.distinct > 1, `the {gif}-only GIF decodes into distinct frames: ${JSON.stringify(second)}`);

  // Switched off, the page that still has the scripts pauses nothing.
  await setSwitch(false);
  start = await playFrom(CUE.startMs + 200);
  await tab.mouse.move(...onWord());
  await new Promise(done => setTimeout(done, 1500));
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "switched off, hovering pauses nothing");
  assert.equal(after.paused, false);
  assert.equal(after.directWrites, 0, "the hover pause wrote no currentTime either");
  assert.deepEqual(after.background, [], "the next episode's session was never paused, played or seeked");
  passed = true;
  console.log(`Netflix mining fixture: ${notes.length} notes; a page open before the switch went on got the scripts, `
    + "paused and resumed, and said to reload; without a capture grant, line audio heard, replayed and played on, "
    + "tab capture asking for the toolbar button; after the click, a line recorded from the tab, a GIF and its line "
    + "audio from one replay, a {gif}-only note; each WAV the cue's seconds' tones; playback restored, hover pause and "
    + "resume through the watch session only, no play while recording — passed");
} finally {
  await browser?.close();
  anki.close();
  if (passed) rmSync(profile, { recursive: true, force: true });
  else console.log(`profile kept at ${profile}`);
}
