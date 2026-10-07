// SPDX-License-Identifier: GPL-3.0-or-later
//
// Experimental Netflix mining in a real Chrome, without Netflix: a fixture page
// served at https://www.netflix.com/watch/81000001 by request interception, with
// a fake Netflix player over a <video> whose audio is silence and one beep, a
// synthetic manifest and WebVTT, and a fake AnkiConnect. It mines the subtitle
// word through the real popup and requires the stored WAV's beep within 125 ms
// of its place and a looping GIF of the line that Chrome decodes into more than
// one distinct frame, seeking only through the player and the viewer's state
// restored.
// Hovering the line of the playing video must then pause it through the player
// and moving away resume it, also around a second note's replay; a note added
// while the viewer plays it on over the line must leave it paused, never
// played on while the recorder runs, until the pointer leaves; a note whose
// only Netflix field is {gif} gets the GIF alone; and nothing pauses once the
// switch is off.
//
// Not part of the default runs. Chrome grants tab capture only after a user
// invokes the extension on the tab; --allowlisted-extension-id stands in for
// that click here, which is Chromium's own allowlist for capture tests. The
// browser runs headful because headless Chrome captures tab audio as silence;
// on Linux without a display, run it under Xvfb:
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
const SAMPLE_RATE = 48_000;
const BEEP_MS = 2500;
const CUE = { startMs: 2000, endMs: 3600 };
const PAD_MS = 250;

// An unpacked extension's ID is derived from its absolute path.
function extensionId(path) {
  const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hex].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

// Six seconds of 16-bit mono silence with a 100 ms, 1 kHz beep at BEEP_MS.
function beepWav() {
  const samples = 6 * SAMPLE_RATE;
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
  const from = BEEP_MS * SAMPLE_RATE / 1000;
  for (let index = from; index < from + SAMPLE_RATE / 10; index++) {
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 1000 * index / SAMPLE_RATE) * 0x3fff), 44 + index * 2);
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
const page = `<!doctype html><meta charset="utf-8"><title>Netflix fixture</title>
<style>body{margin:0;background:#000;color:#fff;font:40px sans-serif}
.player-timedtext{position:absolute;left:0;right:0;top:300px;text-align:center}
#motion{position:absolute;left:0;top:0;width:1200px;height:260px;display:block}</style>
<div class="watch-video"><video preload="auto"></video>
<canvas id="motion" width="1200" height="260"></canvas>
<div class="player-timedtext"><div class="player-timedtext-text-container"><span>朝ごはんを</span><br><span id="word">食べたかった</span></div></div></div>
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
const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
const evidence = window.__fixture = { seeks: [], calls: [], directWrites: 0, profiles: null, frames: 0 };
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
};
window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
  getAllPlayerSessionIds: () => ["session"], getVideoPlayerBySessionId: () => player } }) } } } };
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

// What the reader's own world sees, for a failure report.
async function diagnose(tab) {
  const session = await tab.createCDPSession();
  const contexts = [];
  session.on("Runtime.executionContextCreated", event => contexts.push(event.context));
  await session.send("Runtime.enable");
  const reader = contexts.find(context => context.origin.startsWith("chrome-extension://") && context.auxData?.type === "isolated");
  const evaluate = async (expression, contextId) => (await session.send("Runtime.evaluate",
    { expression, contextId, returnByValue: true, awaitPromise: true })).result.value;
  // The popup's closed shadow root is visible to CDP's piercing DOM.
  const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  const statuses = [];
  const text = node => (node.nodeType === 3 ? node.nodeValue : (node.children ?? []).map(text).join(""));
  (function walk(node) {
    const attributes = node.attributes ?? [];
    const index = attributes.indexOf("class");
    if (index >= 0 && attributes[index + 1].includes("gsm-hoshidicts-anki-status")) statuses.push(text(node));
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  }(root));
  return {
    statuses,
    page: await evaluate("JSON.stringify(window.__fixture)"),
    video: await evaluate(`JSON.stringify((v => ({ t: v.currentTime, ready: v.readyState, seeking: v.seeking, duration: v.duration,
      paused: v.paused, error: v.error?.message ?? null, src: v.currentSrc }))(document.querySelector("video")))`),
    readerVideo: reader && await evaluate(`JSON.stringify((v => ({ t: v.currentTime, ready: v.readyState, duration: v.duration }))(document.querySelector("video")))`, reader.id),
    contexts: contexts.map(context => [context.name, context.origin, context.auxData?.type]),
    reader: reader && await evaluate(`JSON.stringify({ netflix: typeof HDNetflix, subtitles: typeof HDNetflixSubtitles,
      observation: HDNetflix?.observe(document.getElementById("word")),
      resolved: HDNetflix?.resolve(HDNetflix.observe(document.getElementById("word"))) })`, reader.id),
  };
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
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
      "--autoplay-policy=no-user-gesture-required", `--allowlisted-extension-id=${id}`,
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  assert.equal(new URL(worker.url()).host, id, "the computed extension ID is the one Chrome loaded");
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
  await settings.waitForSelector("#opt-experimental-netflixMining", { visible: true });
  await settings.click("#opt-experimental-netflixMining");
  await settings.waitForFunction(async () => (await chrome.scripting.getRegisteredContentScripts()).length === 2);
  console.log("Netflix scripts registered");
  // The Basic note type's Back field template, written through the options queue.
  const mapBack = back => settings.evaluate(async (ankiUrl, value) => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { hoverEnabled: true, lookupMode: "hover",
        // The same word is added again during the hover pause.
        anki: { ...HDReaderOptions.DEFAULT_OPTIONS.anki, url: ankiUrl, model: "Basic", captureScreenshot: false,
          duplicateBehavior: "new",
          fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
            Back: { value, overwriteMode: "overwrite" } } } } });
    if (!reply.ok) throw new Error(reply.error);
  }, `http://127.0.0.1:${anki.address().port}`, back);
  await mapBack("{sentence}<br>{sentence-audio}<br>{gif}");
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
  const wav = beepWav();
  tab.on("request", request => {
    const url = request.url();
    // A locked-down page: no frames of its own, no capture features. The
    // extension's recorder frame and tab capture must still work.
    if (url === WATCH) {
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
  await tab.goto(WATCH);
  await tab.waitForFunction(() => window.__fixture?.ready === true);
  console.log("watch page ready");
  await tab.bringToFront();
  const word = await tab.$("#word");
  const box = await word.boundingBox();
  // Hover the word until its popup is ready, then add with the popup's Alt+E keybind.
  async function addNote() {
    const added = notes.length;
    const deadline = Date.now() + 60_000;
    while (notes.length === added && Date.now() < deadline) {
      await tab.mouse.move(box.x + 4, box.y + box.height / 2);
      await new Promise(done => setTimeout(done, 300));
      await tab.mouse.move(box.x + 12, box.y + box.height / 2);
      await new Promise(done => setTimeout(done, 700));
      await tab.keyboard.down("Alt");
      await tab.keyboard.press("KeyE");
      await tab.keyboard.up("Alt");
      for (let wait = 0; wait < 20 && notes.length === added; wait++) await new Promise(done => setTimeout(done, 500));
    }
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

  // The note's WAV must hold the cue with its pads, with the fixture's beep
  // within 125 ms of its place.
  function checkLineAudio(back, label) {
    const filename = /\[sound:(hachidori-sentence-audio-[0-9a-f-]{36}\.wav)\]/u.exec(back)?.[1];
    assert.ok(filename, `${label}: the note references the line's WAV: ${back}`);
    const clip = Buffer.from(media.get(filename), "base64");
    assert.equal(clip.toString("ascii", 0, 4), "RIFF");
    const rate = clip.readUInt32LE(24);
    const count = clip.readUInt32LE(40) / 2;
    let first = -1;
    for (let index = 0; index < count; index++) {
      if (Math.abs(clip.readInt16LE(44 + index * 2)) > 0x1000) { first = index; break; }
    }
    const expected = BEEP_MS - (CUE.startMs - PAD_MS);
    const found = first * 1000 / rate;
    console.log(`${label}: clip ${(count / rate).toFixed(3)} s at ${rate} Hz; beep at ${found.toFixed(1)} ms, expected ${expected} ms`);
    assert.ok(first >= 0 && Math.abs(found - expected) <= 125, `${label}: the beep is within 125 ms (${found} vs ${expected})`);
    assert.ok(Math.abs(count / rate * 1000 - (CUE.endMs - CUE.startMs + 2 * PAD_MS)) <= 50,
      `${label}: the clip is the cue with its pads`);
  }

  // A line never heard at 1× ({gif} mapped): one replay records the GIF with
  // tab capture, and the line audio keeps that replay's sound for the WAV.
  await addNote();
  assert.equal(notes.length, 1, "one note was added");
  const [note] = notes;
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
  const evidence = await tab.evaluate(() => {
    const video = document.querySelector("video");
    return { ...window.__fixture, currentTime: video.currentTime, paused: video.paused, rate: video.playbackRate };
  });
  assert.deepEqual(evidence.profiles, ["webvtt-lssdh-ios8", "heaac-2-dash", "playready-h264mpl30-dash"]);
  assert.equal(evidence.directWrites, 0, "nothing but Netflix's player wrote currentTime");
  assert.equal(evidence.seeks.length, 3, `one replay, there and back: ${evidence.seeks}`);
  assert.equal(evidence.seeks[1], CUE.startMs - PAD_MS, "the replay seeks to the cue's padded start");
  assert.ok(Math.abs(evidence.seeks.at(-1) - 3500) < 50, `the replay returns to the viewer's position: ${evidence.seeks}`);
  assert.equal(evidence.frames, 1, "one recorder frame, for the GIF");
  assert.equal(evidence.paused, true, "the paused video stays paused");
  assert.equal(evidence.rate, 1.25, "the viewer's speed is restored");

  // Hover pause. The viewer plays from inside the cue with the element's own
  // play(), so the fixture's log holds only the extension's calls.
  const away = [1150, 30];
  const onWord = [box.x + 12, box.y + box.height / 2];
  const playback = () => tab.evaluate(() => ({ paused: document.querySelector("video").paused,
    calls: [...window.__fixture.calls], seeks: window.__fixture.seeks.length, directWrites: window.__fixture.directWrites,
    frames: window.__fixture.frames, mediaMs: document.querySelector("video").currentTime * 1000 }));
  async function playFrom(ms) {
    await tab.mouse.move(...away);
    await tab.evaluate(async from => {
      window.netflix.appContext.state.playerApp.getAPI().videoPlayer.getVideoPlayerBySessionId().seek(from);
      const video = document.querySelector("video");
      video.playbackRate = 1;
      await video.play();
    }, ms);
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

  let start = await playFrom(CUE.startMs + 200);
  await tab.mouse.move(...onWord);
  await waitForCalls(start, 1, true, "hovering the playing line pauses it");
  await tab.mouse.move(...away);
  await waitForCalls(start, 2, false, "leaving the line and the popup resumes it");
  let after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pause", "play"], "hovering pauses and leaving resumes, through the player");
  assert.equal(after.seeks, start.seeks, "the hover pause never seeks");

  // A note added during the hover pause: the replay restores the pause, and
  // leaving afterwards still resumes.
  start = await playFrom(CUE.startMs + 200);
  await addNote();
  assert.equal(notes.length, 2, "a second note was added during the hover pause");
  assert.match(notes[1].fields.Back, /\[sound:hachidori-sentence-audio-/u, "the paused line was recorded");
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
  await tab.mouse.move(...onWord);
  await waitForCalls(start, 1, true, "hovering pauses before the viewer plays");
  await tab.evaluate(() => document.querySelector("video").play());
  await addNote();
  assert.equal(notes.length, 3, "a third note was added while the video played");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pause", "play while recording", "pause"],
    "the replay restored the playing video paused");
  assert.equal(after.paused, true, "the video stays paused while the pointer is on the line");
  await tab.mouse.move(...away);
  await waitForCalls(start, 4, false, "leaving after mining plays the video on");
  assert.equal((await playback()).calls.at(-1), "play", "the video plays on after the recorder has stopped");

  // Without {gif}, a line the viewer heard at 1× is cut from what was kept: no
  // seek, no player call and no recorder frame. The earlier notes' replays
  // played the whole line, so the switch is turned off and on first: off frees
  // what the line audio kept. The line is paused just after its padded end,
  // while the subtitle would still be matched to its cue.
  await mapBack("{sentence}<br>{sentence-audio}");
  await setSwitch(false);
  await setSwitch(true);
  start = await playFrom(1500);
  await tab.waitForFunction(end => document.querySelector("video").currentTime * 1000 >= end, { timeout: 10_000 },
    CUE.endMs + PAD_MS + 50);
  await tab.evaluate(() => document.querySelector("video").pause());
  start = await playback();
  await addNote();
  assert.equal(notes.length, 4, "a fourth note was added for a line already heard");
  checkLineAudio(notes[3].fields.Back, "heard");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "nothing replayed or played the line");
  assert.equal(after.seeks, start.seeks, "nothing seeked");
  assert.equal(after.frames, start.frames, "no recorder frame");
  assert.ok(Math.abs(after.mediaMs - start.mediaMs) < 1, "the video stayed where the viewer left it");

  // Hovered while it plays, the line stops partway: adding it plays the rest
  // once, audibly and without seeking, and stops at its end. The line was
  // just heard in full, so the line audio starts afresh again.
  await setSwitch(false);
  await setSwitch(true);
  start = await playFrom(1700);
  await tab.waitForFunction(() => document.querySelector("video").currentTime >= 1.9, { timeout: 10_000 });
  await tab.mouse.move(...onWord);
  await waitForCalls(start, 1, true, "hovering the playing line pauses it partway");
  const pausedAt = (await playback()).mediaMs;
  assert.ok(pausedAt < BEEP_MS, `paused before the beep (${pausedAt} ms), so the beep is in the part played on`);
  await addNote();
  assert.equal(notes.length, 5, "a fifth note was added for a line stopped partway");
  checkLineAudio(notes[4].fields.Back, "played on");
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), ["pause", "play", "pause"], "the rest of the line played once");
  assert.equal(after.seeks, start.seeks, "nothing seeked");
  assert.equal(after.frames, start.frames, "no recorder frame");
  assert.ok(after.paused && after.mediaMs >= CUE.endMs + PAD_MS - 30, `it stopped at the line's end (${after.mediaMs} ms)`);
  await tab.mouse.move(...away);
  await waitForCalls(start, 4, false, "leaving plays the video on from the line's end");

  // A note whose only Netflix field is {gif}: the line is recorded for its GIF
  // alone, with no sentence audio. The paused video is placed inside the cue.
  await mapBack("{gif}");
  await tab.mouse.move(...away);
  await tab.evaluate(ms => {
    window.netflix.appContext.state.playerApp.getAPI().videoPlayer.getVideoPlayerBySessionId().seek(ms);
    document.querySelector("video").pause();
  }, CUE.startMs + 200);
  await addNote();
  assert.equal(notes.length, 6, "a sixth note was added with only {gif} mapped");
  const onlyGif = /^<img src="(hachidori-gif-[0-9a-f-]{36}\.gif)">$/u.exec(notes[5].fields.Back)?.[1];
  assert.ok(onlyGif, `the {gif}-only note holds the line's GIF alone: ${notes[5].fields.Back}`);
  const second = await decodeGif(onlyGif);
  assert.ok(second.frames > 1 && second.distinct > 1, `the {gif}-only GIF decodes into distinct frames: ${JSON.stringify(second)}`);

  // Switched off, the page that still has the scripts pauses nothing.
  await setSwitch(false);
  start = await playFrom(CUE.startMs + 200);
  await tab.mouse.move(...onWord);
  await new Promise(done => setTimeout(done, 1500));
  after = await playback();
  assert.deepEqual(after.calls.slice(start.calls.length), [], "switched off, hovering pauses nothing");
  assert.equal(after.paused, false);
  assert.equal(after.directWrites, 0, "the hover pause wrote no currentTime either");
  passed = true;
  console.log("Netflix mining fixture: 6 notes, line audio within 125 ms replayed for a GIF, cut from what was heard and played on, a decoded looping GIF, a {gif}-only note, playback restored, hover pause and resume through the player, no play while recording — passed");
} finally {
  await browser?.close();
  anki.close();
  if (passed) rmSync(profile, { recursive: true, force: true });
  else console.log(`profile kept at ${profile}`);
}
