// SPDX-License-Identifier: GPL-3.0-or-later
//
// Experimental Crunchyroll mining in a real Chrome, without Crunchyroll: a
// fixture page served at https://www.crunchyroll.com/watch/GTEST12345/… by
// request interception, with a Bitmovin-style player around a <video> whose
// sound is one tone until 2.75 s and another after it, and a stand-in for the
// user script that shows Crunchyroll's Japanese subtitles (the Script Store's
// Jimaku Player): it marks its line for Hachidori, posts its subtitle file's
// timing on load and posts it again when the reader asks
// (docs/architecture.md, Crunchyroll mining). A fake AnkiConnect takes the
// notes. Crunchyroll is never contacted: request interception serves the
// fixture, and the browser resolves no host but 127.0.0.1.
//
// - The page is open before Crunchyroll mining is switched on, so its reader
//   gets the scripts late and missed the user script's first post; it asks for
//   the timing again, and the user script's answer gives the line its cue.
// - Hovering the playing line pauses the <video> and leaving resumes it.
// - A note from the line gets the whole line as its sentence and, without a
//   replay, the line's audio cut from what was heard: the cue with its pads,
//   the first tone before 2.75 s and the second after it.
// - Switched off, hovering pauses nothing.
// With HACHIDORI_CRUNCHYROLL_AVIF=1 (headful, Chrome 152 or newer: it clicks
// the toolbar button through CDP's Extensions.triggerAction; under Xvfb on
// Linux), a {gif} note in the AVIF format gets an animated AVIF of the line,
// cropped to the video and without the player's controls or the user script's
// drawing, saved to test/tmp/ci/:
//
//   node test/make-fixture.mjs && HACHIDORI_CRUNCHYROLL_AVIF=1 xvfb-run -a node test/chrome-crunchyroll.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
import { MP3_SLACK_MS, decodeSentenceAudio } from "./sentence-audio-decode.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require(process.env.HACHIDORI_PUPPETEER || "puppeteer-core");
const extension = realpathSync(resolve(root, "extension"));
const chromePath = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${require("./package.json").config.chrome}/chrome-linux64/chrome`);
const output = resolve(root, "test/tmp/ci");
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-crunchyroll-"));
const AVIF = process.env.HACHIDORI_CRUNCHYROLL_AVIF === "1";
const EPISODE = "GTEST12345";
const WATCH = `https://www.crunchyroll.com/watch/${EPISODE}/the-first-episode`;
const RATE = 48_000;
const SECONDS = 8;
// The first tone plays until CHANGE_MS, the second after it.
const LOW_HZ = 440;
const HIGH_HZ = 880;
const CHANGE_MS = 2750;
const CUE = { startMs: 2000, endMs: 3600 };
const PAD_MS = 250;

// An unpacked extension's ID is derived from its absolute path.
const extensionId = path => [...createHash("sha256").update(path).digest("hex").slice(0, 32)]
  .map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");

// SECONDS of 16-bit mono at a quarter of full scale.
function twoToneWav() {
  const samples = SECONDS * RATE;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  for (const [offset, value, bytes] of [[16, 16, 4], [20, 1, 2], [22, 1, 2], [24, RATE, 4], [28, RATE * 2, 4], [32, 2, 2],
    [34, 16, 2]]) {
    if (bytes === 4) wav.writeUInt32LE(value, offset);
    else wav.writeUInt16LE(value, offset);
  }
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const hz = index * 1000 / RATE < CHANGE_MS ? LOW_HZ : HIGH_HZ;
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * index / RATE) * 0x2000), 44 + index * 2);
  }
  return wav;
}

// Crunchyroll's watch page as far as the feature uses it: the player's
// container with its <video> and controls (bright green), and the user
// script's drawing, its button (magenta) and its line, marked for Hachidori.
// A blue band moves over the player from outside it, so a recording of the
// tab has frames that change.
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Crunchyroll fixture</title>
<style>body{margin:0;background:#000;color:#fff;font:16px sans-serif}
.bitmovinplayer-container{position:relative;width:960px;height:540px;margin:20px 0 0 20px;background:#000}
video{width:100%;height:100%;display:block}
.bmpui-ui-uicontainer{position:absolute;left:0;right:0;top:0;height:48px;background:rgb(0,255,0)}
#jp-host{position:absolute;inset:0;pointer-events:none}
#jp-fab{position:absolute;right:12px;top:60px;width:40px;height:40px;border:0;background:rgb(255,0,255)}
#jp-overlay{position:absolute;left:0;right:0;bottom:10%;text-align:center}
#jp-overlay-text{display:inline-block;padding:4px 12px;font-size:36px;white-space:pre-wrap;pointer-events:auto}
#band{position:absolute;left:20px;top:260px;width:120px;height:80px;background:rgb(0,0,255);pointer-events:none}
h1{margin:16px 20px;font-size:20px}</style>
<div class="bitmovinplayer-container"><video preload="auto"></video><div class="bmpui-ui-uicontainer"></div>
<div id="jp-host" data-hachidori-over-video><button id="jp-fab" type="button">字</button>
<div id="jp-overlay" data-hachidori-subtitles><span id="jp-overlay-text" data-hachidori-subtitle-line>朝ごはんを
<span id="word">食べたかった</span></span></div></div></div>
<div id="band"></div>
<h1>Hachidori · Crunchyroll player fixture</h1>
<script>
const band = document.getElementById("band");
(function move(now) {
  band.style.transform = \`translateX(\${(now / 3) % 800}px)\`;
  requestAnimationFrame(move);
}(0));
const evidence = window.__fixture = { posts: 0, resends: 0, ready: false };
// The user script's subtitle file, in the video's time: its sync offset is
// already applied.
const file = "WEBVTT\\n\\n00:00:02.000 --> 00:00:03.600\\n朝ごはんを\\n食べたかった\\n\\n00:00:05.000 --> 00:00:06.500\\nまたね\\n";
function post() {
  evidence.posts++;
  document.dispatchEvent(new CustomEvent("hachidori-crunchyroll-page", { detail: JSON.stringify({ kind: "subtitle",
    movieId: "${EPISODE}", trackId: "jimaku", closedCaptions: false, format: "webvtt", text: file }) }));
}
document.addEventListener("hachidori-crunchyroll-command", event => {
  const command = JSON.parse(event.detail);
  if (command.type !== "resend" || command.movieId !== "${EPISODE}") return;
  evidence.resends++;
  post();
});
post();
const video = document.querySelector("video");
video.addEventListener("loadeddata", () => { evidence.ready = true; }, { once: true });
// A blob is seekable; an intercepted response without range support is not.
fetch("/fixture/line.wav").then(response => response.blob()).then(blob => { video.src = URL.createObjectURL(blob); });
</script>`;

// The reader's own world and the popup's Anki statuses, through CDP: Puppeteer
// reaches neither the content scripts' isolated world nor the popup's closed
// shadow root, which CDP's piercing DOM sees through.
async function inReader(tab, expression) {
  const session = await tab.createCDPSession();
  try {
    const contexts = [];
    session.on("Runtime.executionContextCreated", event => contexts.push(event.context));
    await session.send("Runtime.enable");
    const reader = contexts.find(context => context.origin.startsWith("chrome-extension://") && context.auxData?.type === "isolated");
    return reader ? (await session.send("Runtime.evaluate", { expression, contextId: reader.id, returnByValue: true })).result.value
      : undefined;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function statuses(tab) {
  const session = await tab.createCDPSession();
  try {
    const { root: documentRoot } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const found = [];
    const text = node => (node.nodeType === 3 ? node.nodeValue : (node.children ?? []).map(text).join(""));
    (function walk(node) {
      const attributes = node.attributes ?? [];
      const at = attributes.indexOf("class");
      if (at >= 0 && attributes[at + 1].includes("gsm-hoshidicts-anki-status")) found.push(text(node));
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    }(documentRoot));
    return found;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function until(probe, message, ms = 15_000) {
  for (const deadline = Date.now() + ms; !(await probe());) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(done => setTimeout(done, 100));
  }
}

// Zero crossings per second over `ms` of `samples` from `fromMs`: twice a tone's frequency.
function crossingsPerSecond(samples, rate, fromMs, ms) {
  const from = Math.round(fromMs * rate / 1000);
  const to = from + Math.round(ms * rate / 1000);
  let crossings = 0;
  for (let index = from + 1; index < to; index++) if ((samples[index - 1] < 0) !== (samples[index] < 0)) crossings++;
  return crossings * 1000 / ms;
}

const notes = [];
const media = new Map();
const anki = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const reply = await answerAnkiConnect(JSON.parse(body), (action, params) => {
    const answers = { version: 6, deckNames: ["Default"], modelNames: ["Basic"], modelNamesAndIds: { Basic: 1 },
      modelFieldNames: ["Front", "Back"], findNotes: [], findCards: [] };
    if (Object.hasOwn(answers, action)) return answers[action];
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
    executablePath: chromePath, headless: !AVIF, enableExtensions: true, userDataDir: profile, pipe: true,
    // Tab capture records the window's own view, which an emulated viewport would not match.
    ...(AVIF ? { defaultViewport: null } : {}),
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
      "--autoplay-policy=no-user-gesture-required",
      ...(AVIF ? ["--enable-unsafe-extension-debugging", "--window-size=1040,760"] : []),
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
        requestId: "crunchyroll-fixture-import", blobUrl, fileName: "hachidori-fixture.zip" });
      if (!reply.ok) throw new Error(reply.error);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, readFileSync(resolve(root, "test/fixtures/hachidori-fixture.zip")).toString("base64"));
  console.log("fixture imported");
  // `back` maps the Basic note type's Back field, `mining` sets the switch
  // (the complete experimental record, as Settings writes it), and the rest
  // are options as they are.
  const writeOptions = ({ back, mining, ...rest }) => settings.evaluate(async (patch, ankiUrl) => {
    const { options } = await chrome.storage.local.get("options");
    const next = { ...patch.rest };
    if (patch.back !== undefined) {
      next.anki = { ...HDReaderOptions.DEFAULT_OPTIONS.anki, url: ankiUrl, model: "Basic", duplicateBehavior: "new",
        fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
          Back: { value: patch.back, overwriteMode: "overwrite" } } };
    }
    if (patch.mining !== undefined) {
      next.experimental = { ...HDReaderOptions.DEFAULT_OPTIONS.experimental, ...options.experimental,
        crunchyrollMining: patch.mining };
    }
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: next });
    if (!reply.ok) throw new Error(reply.error);
  }, { back, mining, rest }, `http://127.0.0.1:${anki.address().port}`);
  await writeOptions({ hoverEnabled: true, lookupMode: "hover", back: "{sentence}<br>{sentence-audio}" });
  const registered = () => settings.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts())
    .map(script => script.id).filter(scriptId => scriptId.startsWith("hachidori-crunchyroll")).length);

  const tab = await browser.newPage();
  tab.setDefaultTimeout(60_000);
  if (!AVIF) await tab.setViewport({ width: 1040, height: 700 });
  await tab.setRequestInterception(true);
  const wav = twoToneWav();
  tab.on("request", request => {
    const url = new URL(request.url());
    if (url.href === WATCH) return request.respond({ contentType: "text/html; charset=utf-8", body: page });
    if (url.href === "https://www.crunchyroll.com/fixture/line.wav") return request.respond({ contentType: "audio/wav", body: wav });
    if (url.origin === "https://www.crunchyroll.com") return request.respond({ status: 404, body: "" });
    return request.continue();
  });
  tab.on("pageerror", error => console.log("watch page error:", error.message));
  // The episode is open, and the user script has posted its timing, before
  // the switch goes on. Chrome loads no media in a tab in the background.
  await tab.bringToFront();
  await tab.goto(WATCH);
  // Polled by time: a headful window under Xvfb need not paint, which stalls
  // Puppeteer's default animation-frame polling.
  await tab.waitForFunction(() => window.__fixture?.ready === true, { polling: 100 });
  await writeOptions({ mining: true });
  await until(async () => (await registered()) === 2, "the Crunchyroll scripts are registered once the switch is on");
  console.log("Crunchyroll mining on");

  let box = await (await tab.$("#word")).boundingBox();
  const onWord = () => [box.x + 12, box.y + box.height / 2];
  const away = [1000, 8];
  const playback = () => tab.evaluate(() => ({ paused: document.querySelector("video").paused,
    mediaMs: document.querySelector("video").currentTime * 1000, ...window.__fixture }));
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
  }
  // Hover the word until its popup is ready, then add with the popup's Alt+E
  // keybind. Another Add replaces a recording under way, so a note whose
  // line is recorded and encoded (AV1 is slow in software) is given `patienceMs`.
  async function addNote(patienceMs = 10_000) {
    const added = notes.length;
    const deadline = Date.now() + 60_000 + patienceMs;
    while (notes.length === added && Date.now() < deadline) {
      await tab.mouse.move(box.x + 4, box.y + box.height / 2);
      await new Promise(done => setTimeout(done, 300));
      await tab.mouse.move(...onWord());
      await new Promise(done => setTimeout(done, 700));
      await tab.keyboard.down("Alt");
      await tab.keyboard.press("KeyE");
      await tab.keyboard.up("Alt");
      for (const until = Date.now() + patienceMs; notes.length === added && Date.now() < until;) {
        await new Promise(done => setTimeout(done, 500));
      }
    }
    assert.equal(notes.length, added + 1, `a note was added (${(await statuses(tab)).join(" | ")})`);
    return notes.at(-1);
  }

  // The reader that arrived late asks for the timing it missed, and the user
  // script's answer pins the line's cue.
  await tab.evaluate(atMs => { document.querySelector("video").currentTime = atMs / 1000; }, CUE.startMs + 500);
  const resolved = () => inReader(tab, `JSON.stringify(HDCrunchyroll.resolve(HDCrunchyroll.observe(document.getElementById("word"))))`);
  await until(async () => JSON.parse((await resolved()) ?? "null")?.cue?.startMs === CUE.startMs,
    "the reader resolves the line to its cue from what the user script posted");
  assert.deepEqual([(await playback()).posts, (await playback()).resends], [2, 1],
    "the user script posted on load and once more when the late reader asked");
  console.log("a reader that arrived late got the user script's timing");

  // Hovering the playing line pauses the <video>; leaving the line and the popup resumes it.
  await playFrom(CUE.startMs + 200);
  await tab.mouse.move(...onWord());
  await until(async () => (await playback()).paused, "hovering the playing line pauses it");
  await new Promise(done => setTimeout(done, 1500));
  await tab.screenshot({ path: resolve(output, "crunchyroll-popup.png") });
  await tab.mouse.move(...away);
  await until(async () => !(await playback()).paused, "leaving the line and the popup resumes it");
  console.log("hover pause and resume");

  // A line heard at 1× is cut from what was kept, without a replay: paused
  // just after its padded end, while the line still matches its cue.
  await playFrom(1500);
  await tab.waitForFunction(end => document.querySelector("video").currentTime * 1000 >= end,
    { timeout: 10_000, polling: 100 }, CUE.endMs + PAD_MS + 50);
  await tab.evaluate(() => document.querySelector("video").pause());
  const before = await playback();
  let note = await addNote();
  assert.match(note.fields.Back, /^朝ごはんを<b>食べたかった<\/b><br>\[sound:/u, "the sentence is the whole cue, with its audio");
  const audioFile = /\[sound:(hachidori-sentence-audio-[0-9a-f-]{36}\.mp3)\]/u.exec(note.fields.Back)?.[1];
  const { rate, mono, samples } = await decodeSentenceAudio(settings, media.get(audioFile));
  assert.ok(mono, "the MP3 is mono");
  const durationMs = samples.length * 1000 / rate;
  const cutMs = CUE.endMs - CUE.startMs + 2 * PAD_MS;
  assert.ok(durationMs >= cutMs - 5 && durationMs <= cutMs + MP3_SLACK_MS, `the clip is the cue with its pads (${durationMs} ms)`);
  // The clip starts at media 1750 ms: the first tone until 1000 ms into it, the second after.
  const change = CHANGE_MS - (CUE.startMs - PAD_MS);
  const low = crossingsPerSecond(samples, rate, change - 800, 600);
  const high = crossingsPerSecond(samples, rate, change + 200, 600);
  assert.ok(Math.abs(low - 2 * LOW_HZ) < 40 && Math.abs(high - 2 * HIGH_HZ) < 40,
    `each tone is where it played: ${low.toFixed(0)} and ${high.toFixed(0)} crossings a second`);
  const after = await playback();
  assert.ok(Math.abs(after.mediaMs - before.mediaMs) < 1, "nothing replayed or moved the video");
  console.log(`a heard line: whole-cue sentence and ${durationMs.toFixed(1)} ms of its audio, cut without a replay`);

  if (AVIF) {
    // A click on Hachidori's toolbar button lets it record the tab.
    for (let attempt = 1; ; attempt++) {
      await tab.bringToFront();
      await tab.triggerExtensionAction((await browser.extensions()).get(id));
      const popup = await browser.waitForTarget(target => target.url() === `chrome-extension://${id}/toolbar.html`);
      await (await popup.asPage()).close();
      const granted = await worker.evaluate(async () => {
        const [watching] = await chrome.tabs.query({ url: "https://www.crunchyroll.com/*" });
        return chrome.tabCapture.getMediaStreamId({ targetTabId: watching.id }).then(() => true, () => false);
      });
      if (granted) break;
      assert.ok(attempt < 3, "a click on the toolbar button lets Hachidori record the tab");
    }
    await tab.bringToFront();
    // The pixels of each frame of the line's animation: none of the player's
    // controls (green) or the user script's button (magenta) may be in it.
    const pixels = (base64, type) => settings.evaluate(async (data, mime) => {
      const decoder = new ImageDecoder({ data: Uint8Array.from(atob(data), character => character.charCodeAt(0)), type: mime });
      await decoder.tracks.ready;
      const frames = [];
      for (let index = 0; index < decoder.tracks.selectedTrack.frameCount; index++) {
        const { image } = await decoder.decode({ frameIndex: index });
        const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const { data: rgba } = context.getImageData(0, 0, image.displayWidth, image.displayHeight);
        let green = 0, magenta = 0, blue = 0, blueX = 0;
        for (let at = 0; at < rgba.length; at += 4) {
          const [red, greenValue, blueValue] = [rgba[at], rgba[at + 1], rgba[at + 2]];
          if (red < 80 && greenValue > 180 && blueValue < 80) green++;
          if (red > 180 && greenValue < 80 && blueValue > 180) magenta++;
          if (red < 80 && greenValue < 80 && blueValue > 180) { blue++; blueX += (at / 4) % image.displayWidth; }
        }
        // Where the moving band is, to the nearest 10 px.
        frames.push({ green, magenta, band: blue > 0 ? Math.round(blueX / blue / 10) * 10 : null });
        image.close();
      }
      const { displayWidth: width, displayHeight: height } = (await decoder.decode()).image;
      decoder.close();
      return { width, height, frames };
    }, base64, type);

    await writeOptions({ back: "{gif}", videoImageFormat: "avif" });
    await leaveLine();
    await tab.evaluate(() => { document.querySelector("video").currentTime = 3.7; });
    const began = Date.now();
    note = await addNote(120_000);
    const avifFile = /^<img src="(hachidori-gif-[0-9a-f-]{36}\.avif)">$/u.exec(note.fields.Back)?.[1];
    assert.ok(avifFile, `the note holds the line's AVIF: ${note.fields.Back} (${(await statuses(tab)).join(" | ")})`);
    writeFileSync(resolve(output, "crunchyroll-line.avif"), Buffer.from(media.get(avifFile), "base64"));
    const animation = await pixels(media.get(avifFile), "image/avif");
    // The 960 × 540 player keeps only the video, 16:9.
    assert.ok(Math.abs(animation.width / animation.height - 16 / 9) < 0.03, `the AVIF is cropped to the video: ${animation.width} × ${animation.height}`);
    assert.ok(animation.frames.length > 1 && new Set(animation.frames.map(frame => frame.band)).size > 1,
      `the AVIF has frames that change: ${JSON.stringify(animation.frames.slice(0, 8))}`);
    assert.ok(animation.frames.every(frame => frame.green === 0 && frame.magenta === 0),
      "no frame shows the player's controls or the user script's button");
    console.log(`{gif} as AVIF: ${animation.width} × ${animation.height}, ${animation.frames.length} frames, `
      + `${(Buffer.from(media.get(avifFile), "base64").length / 1024).toFixed(1)} KiB, cropped to the video, `
      + `${((Date.now() - began) / 1000).toFixed(1)} s from Add`);
  }

  // Switched off, the page that still has the scripts pauses nothing.
  await writeOptions({ mining: false });
  await until(async () => (await registered()) === 0, "the Crunchyroll scripts are unregistered once the switch is off");
  await new Promise(done => setTimeout(done, 500));
  await playFrom(1500);
  await tab.mouse.move(...onWord());
  await new Promise(done => setTimeout(done, 1500));
  assert.equal((await playback()).paused, false, "switched off, hovering pauses nothing");
  passed = true;
  console.log(`Crunchyroll mining fixture: ${notes.length} notes; the user script's timing for a late reader, hover pause `
    + `and resume, a heard line's whole-cue sentence and audio without a replay${AVIF ? ", an AVIF of the line cropped to "
    + "the video" : ""}, and nothing paused with the switch off — passed`);
} finally {
  await browser?.close();
  anki.close();
  if (passed) rmSync(profile, { recursive: true, force: true });
  else console.log(`profile kept at ${profile}`);
}
