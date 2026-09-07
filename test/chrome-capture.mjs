/*
 * Real-Chrome media-capture integration.
 *
 * This is intentionally separate from chrome-e2e.mjs: display-media selection
 * needs Chrome's test-only source chooser flags and, on Linux, a visible X
 * display (xvfb-run is sufficient).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { captureResourceMonitor } from "./capture-resources.mjs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(HERE, "fixtures/hachidori-fixture.zip");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const SOURCE_TITLE = "Hachidori Capture Fixture";
const PROFILE = process.env.HACHIDORI_CAPTURE_PROFILE
  || resolve(tmpdir(), `hachidori-capture-profile-${process.pid}`);
const SETTINGS_SCREENSHOT = process.env.HACHIDORI_MEDIA_SETTINGS_SCREENSHOT || "";
const CAPTURE_SCREENSHOT = process.env.HACHIDORI_CAPTURE_SCREENSHOT || "";
const ASSET_DIR = process.env.HACHIDORI_CAPTURE_ASSET_DIR || "";
let fixtureOrigin;
const FORCE_AUDIO_WORKLET = process.env.HACHIDORI_CAPTURE_FORCE_AUDIO_WORKLET === "1";

const CHECKS = [
  "real tab capture records bounded video and source audio",
  "default ten-second moving-text export decodes roughly eighty frames with equal AVIF/WAV duration",
  "dictionary lookups remain responsive during a full export",
  "closing and reopening controls preserves the recording and reading document",
  "service-worker restart recovers the same capture session and linked reader",
  "learned DOM timing falls back first, then pins an observed line",
  "animated AVIF and mono WAV upload through Anki one at a time",
  "Chrome decodes changing AVIF frames and non-silent WAV samples",
  "decoded flash and beep stay aligned within 125 ms",
  "live texthooker priority, active state and reconnect use the real loopback WebSocket",
  "a second pinned interval encodes and cleans up independently",
  "one linked reading document is enforced and navigation clears it without stopping capture",
  "capture-setting confirmation stops and clears without auto-rearming",
];

function cachedChrome() {
  const root = resolve(CACHE, "hachidori-browsers/chrome");
  if (!existsSync(root)) return "";
  for (const build of readdirSync(root).sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }))) {
    const candidate = resolve(root, build, "chrome-linux64/chrome");
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || cachedChrome();
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");

const FIXTURE_HTML = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${SOURCE_TITLE}</title>
    <style>
      html, body { margin: 0; min-height: 100%; background: #10141f; color: #f8fafc; font-family: sans-serif; }
      main { display: grid; place-items: center; gap: 24px; min-height: 100vh; }
      #scene, #fixture-canvas { width: min(80vw, 800px); aspect-ratio: 16 / 9; border-radius: 18px; box-shadow: 0 24px 60px #0008; }
      #subtitle-area { min-width: 26rem; padding: 18px 28px; border-radius: 12px; background: #000c; text-align: center; }
      #subtitle { font-size: 32px; }
      button { padding: 12px 20px; font: inherit; }
    </style>
  </head>
  <body>
    <main>
      <video id="scene" playsinline hidden></video>
      <canvas id="fixture-canvas" width="960" height="540"></canvas>
      <div id="subtitle-area"><span id="subtitle">最初の行</span></div>
      <button id="fixture-start" type="button">Start fixture audio</button>
    </main>
    <script>
      const scene = document.getElementById("scene");
      const canvas = document.getElementById("fixture-canvas");
      const context = canvas.getContext("2d");
      let frame = 0;
      let painting = true;
      let sceneMode = "dense";
      window.setFixtureSceneMode = mode => { sceneMode = mode; painting = true; };
      function paint() {
        frame += 1;
        if (painting && sceneMode !== "static") {
          const hue = frame % 360;
          const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
          gradient.addColorStop(0, "hsl(" + hue + " 80% 45%)");
          gradient.addColorStop(1, "hsl(" + ((hue + 130) % 360) + " 80% 30%)");
          context.fillStyle = gradient;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#fff";
          context.font = "bold 72px sans-serif";
          context.fillText("Hachidori " + frame, 80, 130);
          context.font = "26px sans-serif";
          for (let line = 0; sceneMode === "dense" && line < 10; line += 1) {
            context.fillText("日本語の読書と動く映像。空を飛ぶ鳥と青い海。" + frame, 40 + (frame % 30), 200 + line * 32);
          }
        }
        requestAnimationFrame(paint);
      }
      paint();
      window.setFixtureFrame = color => {
        painting = false;
        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);
      };
      window.triggerSyncMarker = async () => {
        canvas.hidden = true;
        scene.hidden = false;
        scene.src = "/sync.webm";
        await scene.play();
      };
      window.restoreFixtureScene = async () => {
        scene.pause();
        scene.removeAttribute("src");
        scene.load();
        scene.hidden = true;
        canvas.hidden = false;
        painting = true;
      };
      document.getElementById("fixture-start").addEventListener("click", async event => {
        const button = event.currentTarget;
        const audio = new AudioContext({ sampleRate: 48000 });
        const destination = audio.destination;
        const oscillator = new OscillatorNode(audio, { frequency: 440 });
        const gain = new GainNode(audio, { gain: 0.002 });
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await audio.resume();
        window.fixtureAudio = { audio, oscillator, gain, destination };
        button.textContent = "Fixture audio active";
        button.disabled = true;
      });
    </script>
  </body>
</html>`;

function reply(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  });
  res.end(body);
}

function readRequest(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

function synchronizationFixture() {
  // A muxed timeline places both transitions at one second. Independent
  // canvas/oscillator MediaStreams have different HTML video playout delays.
  return execFileSync(process.env.HACHIDORI_FFMPEG || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=960x540:r=30:d=4",
    "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,1\\,1.25)\\,0.25*sin(2*PI*1200*t)\\,0):s=48000:d=4",
    "-vf", "drawbox=color=white:t=fill:enable='between(t,1,1.25)',drawbox=color=red:t=fill:enable='between(t,1.3,2)',drawbox=color=blue:t=fill:enable='between(t,2,3)',drawbox=color=green:t=fill:enable='gte(t,3)'",
    "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-f", "webm", "pipe:1",
  ], { maxBuffer: 4 * 1024 * 1024 });
}

function createFixtureServer(anki) {
  const syncMedia = synchronizationFixture();
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      reply(res, 204, "");
      return;
    }
    if (req.url === "/sync.webm") {
      res.writeHead(200, { "content-type": "video/webm", "content-length": syncMedia.length });
      res.end(syncMedia);
      return;
    }
    if (req.url.split("?")[0] === "/fixture") {
      reply(res, 200, FIXTURE_HTML, "text/html");
      return;
    }
    if (req.url !== "/" || req.method !== "POST") {
      reply(res, 404, JSON.stringify({ error: "not found" }));
      return;
    }
    try {
      const request = JSON.parse((await readRequest(req)).toString("utf8"));
      const { action, params = {} } = request;
      anki.actions.push(action);
      let result;
      if (action === "deckNames") result = ["Default"];
      else if (action === "modelNames") result = ["CaptureModel"];
      else if (action === "modelFieldNames") result = ["Front", "Animation", "Audio"];
      else if (action === "canAddNotesWithErrorDetail") result = [{ canAdd: true, error: null }];
      else if (action === "addNote") {
        anki.note = structuredClone(params.note);
        result = 101;
      } else if (action === "notesInfo") {
        result = [{
          noteId: 101,
          modelName: "CaptureModel",
          cards: [],
          fields: Object.fromEntries(Object.entries(anki.note?.fields ?? {})
            .map(([field, value]) => [field, { value }])),
        }];
      } else if (action === "storeMediaFile") {
        anki.activeUploads += 1;
        anki.maxActiveUploads = Math.max(anki.maxActiveUploads, anki.activeUploads);
        await new Promise(done => setTimeout(done, 20));
        anki.media.set(params.filename, params.data);
        anki.activeUploads -= 1;
        result = params.filename;
      } else {
        throw new Error(`unexpected AnkiConnect action ${action}`);
      }
      reply(res, 200, JSON.stringify({ result, error: null }));
    } catch (error) {
      reply(res, 200, JSON.stringify({ result: null, error: error.message || String(error) }));
    }
  });
}

function websocketTextFrame(value) {
  const payload = Buffer.from(value, "utf8");
  if (payload.length <= 125) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error("test WebSocket frame is too large");
}

function attachTexthooker(server, state) {
  server.on("upgrade", (req, socket) => {
    if (req.url !== "/ws" || typeof req.headers["sec-websocket-key"] !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    state.origins.push(req.headers.origin || "");
    state.connections.push(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (state.current === socket) state.current = null;
    });
    state.current = socket;
  });
  state.send = value => {
    if (!state.current || state.current.destroyed) throw new Error("texthooker client is not connected");
    state.current.write(websocketTextFrame(value));
  };
  state.disconnect = () => {
    const socket = state.current;
    if (!socket) return false;
    socket.write(Buffer.from([0x88, 0x00]), () => socket.destroy());
    return true;
  };
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

async function extensionId(browser) {
  const target = await browser.waitForTarget(
    candidate => candidate.type() === "service_worker"
      && candidate.url().startsWith("chrome-extension://"),
    { timeout: 30_000 },
  );
  return new URL(target.url()).host;
}

async function extensionWorld(page, id) {
  const client = await page.createCDPSession();
  const contexts = new Map();
  client.on("Runtime.executionContextCreated", event => {
    contexts.set(event.context.id, event.context);
  });
  client.on("Runtime.executionContextDestroyed", event => {
    contexts.delete(event.executionContextId);
  });
  await client.send("Runtime.enable");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const context of contexts.values()) {
      if (context.origin !== `chrome-extension://${id}` || context.auxData?.isDefault !== false) continue;
      const checked = await client.send("Runtime.evaluate", {
        contextId: context.id,
        expression: "typeof globalThis.HDCapture === 'object'",
        returnByValue: true,
      }).catch(() => null);
      if (checked?.result?.value === true) {
        return {
          async evaluate(expression) {
            const result = await client.send("Runtime.evaluate", {
              contextId: context.id,
              expression,
              awaitPromise: true,
              returnByValue: true,
              userGesture: true,
            });
            if (result.exceptionDetails) {
              throw new Error(result.exceptionDetails.exception?.description
                || result.exceptionDetails.text || "isolated-world evaluation failed");
            }
            return result.result.value;
          },
        };
      }
    }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`Hachidori content world did not load; contexts: ${JSON.stringify(
    [...contexts.values()].map(context => ({
      id: context.id,
      name: context.name,
      origin: context.origin,
      auxData: context.auxData,
    })),
  )}`);
}

async function captureMessage(world, type, fields = {}) {
  const expression = `(async () => {
    const reply = await chrome.runtime.sendMessage(${JSON.stringify({
      target: "hachidori-capture",
      type,
      requestId: `capture-e2e-${type}`,
      ...fields,
    })});
    if (!reply?.ok) throw new Error(reply?.error || "capture request failed");
    return reply;
  })()`;
  return world.evaluate(expression);
}

async function captureControl(page, type, fields = {}) {
  return page.evaluate(async message => {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || "capture control failed");
    return reply;
  }, {
    target: "hachidori-capture",
    type,
    requestId: `capture-e2e-${type}`,
    ...fields,
  });
}

async function runtimeMessage(world, target, type, fields = {}) {
  const expression = `(async () => {
    const reply = await chrome.runtime.sendMessage(${JSON.stringify({
      target,
      type,
      requestId: `capture-e2e-${type}`,
      ...fields,
    })});
    if (!reply?.ok) throw new Error(reply?.error || "runtime request failed");
    return reply;
  })()`;
  return world.evaluate(expression);
}

async function lookupBenchmark(world, samples = 40) {
  return world.evaluate(`(async () => {
    const durations = [];
    for (let index = 0; index < ${samples + 5}; index += 1) {
      const started = performance.now();
      const reply = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_lookup",
        requestId: "capture-benchmark-" + index,
        text: "食べたかった",
        maxResults: 32,
        scanLength: 16,
        options: {},
      });
      if (!reply?.ok || !reply.results?.length) throw new Error(reply?.error || "benchmark lookup failed");
      if (index >= 5) durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const percentile = value => durations[Math.min(durations.length - 1,
      Math.max(0, Math.ceil(durations.length * value) - 1))];
    return {
      samples: durations.length,
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
      minimumMs: durations[0],
      maximumMs: durations.at(-1),
    };
  })()`);
}

async function writeOptions(page, patch) {
  return page.evaluate(async value => {
    const stored = await chrome.storage.local.get("options");
    const baseRevision = Number.isSafeInteger(stored.options?.revision) ? stored.options.revision : 0;
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      requestId: `capture-options-${crypto.randomUUID()}`,
      baseRevision,
      options: value,
    });
    if (!reply?.ok) throw new Error(reply?.error || "options write failed");
    return reply.options;
  }, patch);
}

function avifSampleCount(bytes) {
  return avifTiming(bytes).durations.length;
}

function avifTiming(bytes) {
  const type = bytes.indexOf(Buffer.from("stts"));
  assert.ok(type >= 4, "encoded AVIF has a sample timing box");
  const box = type - 4;
  const entries = bytes.readUInt32BE(box + 12);
  let offset = box + 16;
  const durations = [];
  for (let index = 0; index < entries; index += 1) {
    const count = bytes.readUInt32BE(offset);
    const duration = bytes.readUInt32BE(offset + 4);
    for (let sample = 0; sample < count; sample += 1) durations.push(duration);
    offset += 8;
  }
  const mdhdType = bytes.indexOf(Buffer.from("mdhd"));
  assert.ok(mdhdType >= 4, "encoded AVIF has a media timescale box");
  const mdhd = mdhdType - 4;
  const version = bytes[mdhd + 8];
  const timescale = bytes.readUInt32BE(mdhd + (version === 1 ? 28 : 20));
  assert.ok(timescale > 0);
  return { durations, timescale };
}

function wavSignalOnsetSeconds(bytes, threshold = 1000) {
  const sampleRate = bytes.readUInt32LE(24);
  for (let offset = 44; offset + 1 < bytes.length; offset += 2) {
    if (Math.abs(bytes.readInt16LE(offset)) >= threshold) {
      return ((offset - 44) / 2) / sampleRate;
    }
  }
  return null;
}

async function playbackHashes(page, base64) {
  const dimensions = await page.evaluate(async data => {
    const previous = document.getElementById("capture-avif-playback");
    previous?.remove();
    const image = new Image();
    image.id = "capture-avif-playback";
    image.src = `data:image/avif;base64,${data}`;
    image.style.position = "fixed";
    image.style.left = "0";
    image.style.top = "0";
    image.style.zIndex = "2147483647";
    document.body.append(image);
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, base64);
  const image = await page.$("#capture-avif-playback");
  assert.ok(image);
  const hashes = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const screenshot = await image.screenshot();
    hashes.push(createHash("sha256").update(screenshot).digest("hex"));
    await new Promise(done => setTimeout(done, 180));
  }
  await page.evaluate(() => document.getElementById("capture-avif-playback")?.remove());
  return { ...dimensions, hashes };
}

async function decodedFrameHashes(page, base64) {
  return page.evaluate(async data => {
    if (typeof ImageDecoder !== "function") return null;
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const decoder = new ImageDecoder({ data: bytes, type: "image/avif" });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const frameCount = track.frameCount;
    const repetitionCount = Number.isFinite(track.repetitionCount)
      ? track.repetitionCount : String(track.repetitionCount);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const hashes = [];
    const luminances = [];
    const whitePixelFractions = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const decoded = await decoder.decode({ frameIndex, completeFramesOnly: true });
      const image = decoded.image;
      canvas.width = image.displayWidth;
      canvas.height = image.displayHeight;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      let luminance = 0;
      let luminanceSamples = 0;
      for (let index = 0; index < pixels.length; index += 97) {
        hash ^= pixels[index];
        hash = Math.imul(hash, 16777619);
      }
      for (let index = 0; index + 2 < pixels.length; index += 4 * 997) {
        luminance += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
        luminanceSamples += 1;
      }
      hashes.push(hash >>> 0);
      luminances.push(luminance / luminanceSamples);
      let whitePixels = 0;
      for (let index = 0; index + 2 < pixels.length; index += 4) {
        if (Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) >= 240) whitePixels += 1;
      }
      whitePixelFractions.push(whitePixels / (canvas.width * canvas.height));
      image.close();
    }
    decoder.close();
    return {
      frameCount,
      repetitionCount,
      width: canvas.width,
      height: canvas.height,
      hashes,
      luminances,
      whitePixelFractions,
    };
  }, base64);
}

async function verifyFullRecentExport({ world, capture, source, pin, anki, stoppedLookup,
  expectMotion = true, assetName = "full-capture" }) {
  const ankiStatus = await runtimeMessage(world, "hachidori-anki", "hd_anki_status");
  const engineStatus = await runtimeMessage(world, "hoshidicts-offscreen", "hd_status");
  const started = performance.now();
  const exported = await captureMessage(world, "hd_capture_export", {
    token: pin.token, requirements: { includeAnimation: true, includeAudio: true },
  });
  const lookups = [];
  let job;
  const deadline = Date.now() + 35_000;
  do {
    job = await captureMessage(world, "hd_capture_job_status", { jobId: exported.jobId });
    if (job.state === "error") throw new Error(job.error);
    if (job.state !== "ready") {
      lookups.push(await lookupBenchmark(world, 20));
      await new Promise(done => setTimeout(done, 100));
    }
  } while (job.state !== "ready" && Date.now() < deadline);
  assert.equal(job.state, "ready", "the default ten-second export finishes within its watchdog");
  assert.ok(job.encoderHeapBytes > 0 && job.encoderHeapBytes <= 256 * 1024 * 1024,
    `measured encoder WebAssembly memory stays within its 256 MiB ceiling: ${job.encoderHeapBytes}`);
  const encodeMs = performance.now() - started;
  assert.ok(lookups.length > 0, "dictionary lookups are measured while encoding");
  for (const measured of lookups) {
    assert.ok(measured.medianMs <= Math.max(stoppedLookup.medianMs * 3, stoppedLookup.medianMs + 5),
      `encoding lookup latency: ${JSON.stringify({ stoppedLookup, measured })}`);
  }
  const result = await runtimeMessage(world, "hachidori-anki", "hd_anki_submit", { request: {
    term: { expression: "最初", reading: "さいしょ", glossaries: [], frequencies: [], pitches: [] },
    generation: engineStatus.generation, trace: [], sentence: "最初の行", matched: "最初", matchOffset: 0,
    popupSelectionText: "", searchQuery: "最初", documentTitle: SOURCE_TITLE,
    dictionaryAliases: {}, frequencyDictionaries: [], configKey: ankiStatus.configKey,
    capturePin: pin, captureJobId: exported.jobId, captureUnavailable: [],
  } });
  assert.equal(result.state, "added");
  const avif = Buffer.from(anki.media.get(pin.animationFilename), "base64");
  const wav = Buffer.from(anki.media.get(pin.audioFilename), "base64");
  const decoded = await decodedFrameHashes(source, avif.toString("base64"));
  const timing = avifTiming(avif);
  const videoSeconds = timing.durations.reduce((sum, value) => sum + value, 0) / timing.timescale;
  const audioSeconds = wav.readUInt32LE(40) / 2 / wav.readUInt32LE(24);
  assert.ok(Math.abs(videoSeconds - 10) <= 1 / 48000, `full animation duration ${videoSeconds}`);
  assert.ok(Math.abs(videoSeconds - audioSeconds) <= 1 / 48000, "AVIF and WAV cover the same ten seconds");
  if (expectMotion) {
    assert.ok(decoded.frameCount >= 70 && decoded.frameCount <= 90,
      `default moving-scene export has roughly eighty frames (${decoded.frameCount})`);
    assert.ok(new Set(decoded.hashes).size >= 50, "moving text genuinely changes throughout the full export");
  } else {
    assert.ok(decoded.frameCount >= 1, "a static scene retains its held frame for the full interval");
  }
  assert.equal(decoded.repetitionCount, "Infinity");
  if (ASSET_DIR) {
    mkdirSync(resolve(ASSET_DIR), { recursive: true });
    writeFileSync(resolve(ASSET_DIR, `${assetName}.avif`), avif);
    writeFileSync(resolve(ASSET_DIR, `${assetName}.wav`), wav);
  }
  const summary = { assetName, encodeMs, encoderHeapBytes: job.encoderHeapBytes,
    frames: decoded.frameCount, videoSeconds, audioSeconds,
    avifBytes: avif.length, wavBytes: wav.length, lookupRounds: lookups.length,
    maximumLookupMedianMs: Math.max(...lookups.map(value => value.medianMs)),
    maximumLookupP95Ms: Math.max(...lookups.map(value => value.p95Ms)) };
  console.log("FULL_EXPORT", JSON.stringify(summary));
  return summary;
}

async function main() {
  assert.ok(CHROME && existsSync(CHROME), "Chrome for Testing is available");
  assert.ok(existsSync(PUPPETEER), "puppeteer-core is available");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const extensionTree = execFileSync("git", ["rev-parse", "HEAD:extension"], { cwd: ROOT, encoding: "utf8" }).trim();
  const extensionModified = Boolean(execFileSync("git", ["status", "--porcelain", "--", "extension"],
    { cwd: ROOT, encoding: "utf8" }).trim());

  const anki = {
    actions: [],
    activeUploads: 0,
    maxActiveUploads: 0,
    media: new Map(),
    note: null,
  };
  const texthooker = { connections: [], origins: [], current: null, send: null, disconnect: null };
  const server = createFixtureServer(anki);
  attachTexthooker(server, texthooker);
  await listen(server);
  fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const puppeteer = await import(`file://${PUPPETEER}`);
  const launcher = puppeteer.default?.launch ? puppeteer.default : puppeteer;
  let browser, resources;
  try {
    browser = await launcher.launch({
      executablePath: CHROME,
      headless: process.env.HACHIDORI_CAPTURE_HEADFUL === "1" ? false : true,
      userDataDir: PROFILE,
      dumpio: process.env.HACHIDORI_DUMPIO === "1",
      args: [
        "--no-sandbox",
        ...(process.env.HACHIDORI_CAPTURE_X11 === "1" ? ["--ozone-platform=x11"] : []),
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
        "--enable-usermedia-screen-capturing",
        `--auto-select-tab-capture-source-by-title=${SOURCE_TITLE}`,
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
      ],
    });
    const id = await extensionId(browser);
    // Route every fixture Anki request before enabling mining. Never contact
    // a user's Anki process, which may already own the production port.
    const ankiClients = new Map();
    const ankiAttachments = new Map();
    let routeAnkiEnabled = true;
    const routeAnki = target => {
      if (!routeAnkiEnabled || target.type() !== "service_worker"
          || !target.url().startsWith(`chrome-extension://${id}/`)) return;
      if (ankiAttachments.has(target)) return ankiAttachments.get(target);
      const attachment = (async () => {
        const client = await target.createCDPSession();
        ankiClients.set(target, client);
        client.on("Fetch.requestPaused", async event => {
          try {
            const response = await fetch(fixtureOrigin, {
              method: event.request.method,
              headers: { "content-type": "application/json" },
              body: event.request.postData,
            });
            await client.send("Fetch.fulfillRequest", { requestId: event.requestId,
              responseCode: response.status,
              responseHeaders: [{ name: "content-type", value: "application/json" },
                { name: "access-control-allow-origin", value: "*" }],
              body: Buffer.from(await response.arrayBuffer()).toString("base64") });
          } catch {
            await client.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" });
          }
        });
        await client.send("Fetch.enable", { patterns: [{ urlPattern: "http://127.0.0.1:8765*" }] });
      })();
      ankiAttachments.set(target, attachment);
      return attachment;
    };
    await Promise.all(browser.targets().map(routeAnki));
    browser.on("targetcreated", target => { void routeAnki(target); });
    const startupTarget = await browser.waitForTarget(
      candidate => candidate.type() === "page"
        && candidate.url() === `chrome-extension://${id}/startup.html`,
      { timeout: 10_000 },
    ).catch(() => null);
    if (startupTarget) {
      const startupPage = await startupTarget.page();
      await startupPage?.close();
    }

    const source = await browser.newPage();
    await source.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await source.goto(`${fixtureOrigin}/fixture`, { waitUntil: "domcontentloaded" });
    await source.bringToFront();
    await source.click("#fixture-start");
    await source.waitForFunction(() => document.getElementById("fixture-start")?.disabled === true);

    const world = await extensionWorld(source, id);
    const settings = await browser.newPage();
    await settings.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await settings.goto(`chrome-extension://${id}/settings.html#add-dictionaries`, { waitUntil: "domcontentloaded" });
    await settings.waitForSelector("#add-dictionaries:not([hidden])");
    const importInput = await settings.$("#import-file");
    assert.ok(importInput, "Settings exposes dictionary import");
    await importInput.uploadFile(FIXTURE);
    const importState = await settings.waitForFunction(() => {
      const value = (document.getElementById("import-state")?.textContent || "").trim();
      return value.startsWith("Finished 1 of 1 archive") ? value : false;
    }, { timeout: 120_000, polling: 250 }).then(handle => handle.jsonValue());
    assert.equal(importState, "Finished 1 of 1 archive — 1 imported, 0 failed.",
      await settings.$eval("#import-detail", element => element.textContent));
    await settings.goto(`chrome-extension://${id}/settings.html#media`, { waitUntil: "domcontentloaded" });
    await settings.waitForSelector("#media:not([hidden])");

    const mediaCapture = {
      enabled: true,
      timingMode: "auto",
      includeAnimation: true,
      includeCapturedAudio: true,
      historySeconds: 60,
      clipSeconds: 10,
      videoPreset: "standard",
      estimatedOffsetMs: -500,
      texthooker: { enabled: true, url: `${fixtureOrigin.replace("http:", "ws:")}/ws`, format: "plain" },
      page: { nativeCues: true, domText: true, autoLearnArea: true },
    };
    const ankiConfig = {
      deck: "Default",
      model: "CaptureModel",
      apiKey: "",
      tags: ["hachidori", "capture-e2e"],
      fields: {
        expression: "",
        reading: "",
        definition: "",
        sentence: "",
        frequency: "",
        pitch: "",
        audio: "",
        captureAnimation: "",
        captureAudio: "",
      },
      checkForDuplicates: true,
      duplicateScope: "collection",
      duplicateScopeCheckAllModels: false,
      duplicateBehavior: "prevent",
      fieldTemplates: {
        Front: { value: "{expression}", overwriteMode: "overwrite" },
        Animation: { value: "{capture-animation}", overwriteMode: "overwrite" },
        Audio: { value: "{capture-audio}", overwriteMode: "overwrite" },
      },
    };
    await writeOptions(settings, { mediaCapture, anki: ankiConfig });
    await settings.reload({ waitUntil: "domcontentloaded" });
    await settings.waitForSelector("#media:not([hidden])");
    if (SETTINGS_SCREENSHOT) {
      // Keep the whole section inside the viewport before measuring its crop;
      // resizing during an element screenshot can shift the centered layout.
      await settings.setViewport({ width: 1440, height: 1600, deviceScaleFactor: 1 });
      await settings.waitForFunction(() => {
        const status = (document.getElementById("options-status")?.textContent || "").trim();
        return status === "Saved.";
      }, { timeout: 10_000, polling: 100 });
      mkdirSync(dirname(resolve(SETTINGS_SCREENSHOT)), { recursive: true });
      const mediaSection = await settings.$("#media");
      assert.ok(mediaSection, "Settings exposes the media-capture section");
      await settings.$eval("#options-status", element => { element.style.visibility = "hidden"; });
      try {
        await mediaSection.screenshot({ path: resolve(SETTINGS_SCREENSHOT) });
      } finally {
        await settings.$eval("#options-status", element => { element.style.visibility = ""; });
        await settings.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
      }
    }

    await source.bringToFront();
    const stoppedLookup = await lookupBenchmark(world);
    resources = await captureResourceMonitor(browser);
    await new Promise(done => setTimeout(done, 5000));

    let capture = await browser.newPage();
    await capture.setViewport({ width: 1280, height: 960, deviceScaleFactor: 1 });
    if (FORCE_AUDIO_WORKLET) {
      const target = await browser.waitForTarget(candidate => candidate.url() === `chrome-extension://${id}/offscreen.html`);
      const client = await target.createCDPSession();
      await client.send("Runtime.evaluate", { expression: "globalThis.__hachidoriForceAudioWorklet = true" });
      await client.detach();
    }
    await capture.goto(`chrome-extension://${id}/capture.html`, { waitUntil: "domcontentloaded" });
    await capture.waitForFunction(() => document.getElementById("capture-state")?.textContent === "Stopped",
      { polling: 100 });
    assert.equal(await capture.$eval("#capture-state", element => element.textContent), "Stopped",
      "saved settings never auto-arm capture");
    await capture.bringToFront();
    await resources.phase("recording");
    await capture.click("#capture-start");
    await capture.waitForFunction(() => {
      const state = document.getElementById("capture-state")?.textContent;
      const error = document.getElementById("capture-error")?.textContent;
      return state === "Recording" || Boolean(error);
    }, { timeout: 30_000, polling: 100 });
    const startError = await capture.$eval("#capture-error", element => element.textContent);
    assert.equal(startError, "", `display capture starts without an error: ${startError}`);
    await capture.bringToFront();
    await capture.waitForFunction(() =>
      (document.getElementById("texthooker-status")?.textContent || "").includes("waiting"),
    { timeout: 10_000, polling: 100 });
    assert.equal(texthooker.connections.length, 1);
    assert.equal(texthooker.origins[0], `chrome-extension://${id}`);
    await capture.waitForFunction(() => /[1-9][0-9]* frames/u.test(
      document.getElementById("video-history")?.textContent || ""), { polling: 100 });
    await capture.waitForFunction(() => {
      const value = document.getElementById("audio-history")?.textContent || "";
      return /[1-9][0-9,]* samples/u.test(value) || value.includes("unavailable");
    }, { polling: 100 });
    const audioHistory = await capture.$eval("#audio-history", element => element.textContent);
    assert.doesNotMatch(audioHistory, /unavailable/iu, "the selected tab supplies captured audio");
    await source.bringToFront();
    const throughputStart = await captureControl(capture, "hd_capture_status");
    const throughputStartedAt = performance.now();
    const sustainedSeconds = Number(process.env.HACHIDORI_CAPTURE_SUSTAINED_SECONDS) || 5;
    assert.ok(Number.isFinite(sustainedSeconds) && sustainedSeconds >= 5,
      "sustained capture duration must be at least five seconds");
    const throughputMeasurementSeconds = Math.min(5, sustainedSeconds);
    await new Promise(done => setTimeout(done, throughputMeasurementSeconds * 1000));
    const throughputElapsedSeconds = (performance.now() - throughputStartedAt) / 1000;
    const throughputEnd = await captureControl(capture, "hd_capture_status");
    const retentionEnd = throughputEnd;
    const captureThroughput = {
      seconds: throughputElapsedSeconds,
      framesPerSecond: (throughputEnd.history.frameCount - throughputStart.history.frameCount)
        / throughputElapsedSeconds,
      audioSamplesPerSecond: (throughputEnd.history.audioSamples - throughputStart.history.audioSamples)
        / throughputElapsedSeconds,
      retainedFrameBytes: retentionEnd.history.frameBytes,
      retainedFrameCount: retentionEnd.history.frameCount,
      retainedAudioSamples: retentionEnd.history.audioSamples,
      retainedVideoSeconds: (retentionEnd.history.frameNewestMs - retentionEnd.history.frameOldestMs) / 1000,
      retainedAudioSeconds: (retentionEnd.history.audioNewestMs - retentionEnd.history.audioOldestMs) / 1000,
    };
    assert.ok(captureThroughput.framesPerSecond >= 4 && captureThroughput.framesPerSecond <= 10,
      `capture frame throughput stays near its 8 fps budget: ${JSON.stringify(captureThroughput)}`);
    assert.ok(captureThroughput.audioSamplesPerSecond >= 40_000
      && captureThroughput.audioSamplesPerSecond <= 55_000,
    `capture audio follows its sample clock: ${JSON.stringify(captureThroughput)}`);
    assert.ok(captureThroughput.retainedFrameBytes <= 64 * 1024 * 1024);
    const recordingLookup = await lookupBenchmark(world);
    assert.ok(recordingLookup.medianMs <= Math.max(stoppedLookup.medianMs * 3, stoppedLookup.medianMs + 5),
      `capture should not materially delay dictionary lookup: ${JSON.stringify({ stoppedLookup, recordingLookup })}`);

    await capture.bringToFront();
    await capture.waitForFunction(title => [...document.querySelectorAll("#reading-tab option")]
      .some(option => option.textContent === title), { polling: 100 }, SOURCE_TITLE);
    const sourceTab = await capture.$eval("#reading-tab", (select, title) =>
      [...select.options].find(option => option.textContent === title)?.value, SOURCE_TITLE);
    assert.ok(sourceTab, "capture controls list the reading tab");
    await capture.select("#reading-tab", sourceTab);
    await capture.click("#link-page");
    await capture.waitForFunction(title =>
      document.getElementById("linked-page")?.textContent === title,
    { polling: 100 }, SOURCE_TITLE);

    await source.bringToFront();
    await capture.waitForFunction(async () => {
      const reply = await chrome.runtime.sendMessage({target:"hachidori-capture",type:"hd_capture_status"});
      return reply.ok && reply.history.newestMs - reply.history.oldestMs >= 10_100;
    }, { timeout: 20_000, polling: 100 });
    const beforeClose = await captureControl(settings, "hd_capture_status");
    await capture.close();
    await new Promise(done => setTimeout(done, 500));
    const afterClose = await captureControl(settings, "hd_capture_status");
    assert.equal(afterClose.state, "recording");
    assert.equal(afterClose.captureSessionId, beforeClose.captureSessionId);
    assert.equal(afterClose.linkedPage.documentId, beforeClose.linkedPage.documentId);
    assert.ok(afterClose.history.audioNewestMs > beforeClose.history.audioNewestMs);
    capture = await browser.newPage();
    await capture.setViewport({ width: 1280, height: 960, deviceScaleFactor: 1 });
    await capture.goto(`chrome-extension://${id}/capture.html`, { waitUntil: "domcontentloaded" });
    await capture.waitForFunction(() => document.getElementById("capture-state")?.textContent === "Recording");
    await capture.close();
    routeAnkiEnabled = false;
    await Promise.all(ankiAttachments.values());
    await Promise.all([...ankiClients.values()].map(client => client.detach().catch(() => {})));
    ankiClients.clear();
    ankiAttachments.clear();
    const oldWorkerTarget = browser.targets().find(target => target.type() === "service_worker"
      && target.url() === `chrome-extension://${id}/background.js`);
    assert.ok(oldWorkerTarget, "the original extension service worker is running");
    const oldWorker = await oldWorkerTarget.worker();
    // Puppeteer's close also detaches its worker session. A raw stopWorker
    // command can otherwise wait on the debugger that is testing the stop.
    const workerStopped = new Promise((resolveStopped, rejectStopped) => {
      const timer = setTimeout(() => {
        browser.off("targetdestroyed", destroyed);
        rejectStopped(new Error("the original service worker did not stop"));
      }, 10_000);
      function destroyed(target) {
        if (target !== oldWorkerTarget) return;
        clearTimeout(timer);
        browser.off("targetdestroyed", destroyed);
        resolveStopped();
      }
      browser.on("targetdestroyed", destroyed);
    });
    await oldWorker.close();
    await workerStopped;
    routeAnkiEnabled = true;
    const recovered = await captureControl(settings, "hd_capture_status");
    const replacementWorker = await browser.waitForTarget(target => target.type() === "service_worker"
      && target.url() === `chrome-extension://${id}/background.js` && target !== oldWorkerTarget,
    { timeout: 10_000 });
    assert.notEqual(replacementWorker, oldWorkerTarget);
    await Promise.all(browser.targets().map(routeAnki));
    capture = await browser.newPage();
    await capture.setViewport({ width: 1280, height: 960, deviceScaleFactor: 1 });
    await capture.goto(`chrome-extension://${id}/capture.html`, { waitUntil: "domcontentloaded" });
    await capture.waitForFunction(() => document.getElementById("capture-state")?.textContent === "Recording");
    assert.equal(recovered.state, "recording");
    assert.equal(recovered.captureSessionId, beforeClose.captureSessionId);
    assert.equal(recovered.linkedPage.documentId, beforeClose.linkedPage.documentId);

    // Match the focused reading/source page used for the stopped baseline.
    // Chrome can reduce a background canvas's capture cadence even while the
    // recorder keeps consuming every delivered frame.
    await source.bringToFront();
    const initialPin = await world.evaluate(`(async () => {
      const node = document.getElementById("subtitle").firstChild;
      const pin = await HDCapture.rootLookup({ anchor: node, sentence: node.nodeValue, query: node.nodeValue });
      globalThis.__capturePin = pin;
      return pin;
    })()`);
    assert.ok(initialPin, "the recovered reader can pin the retained capture history");
    assert.equal(initialPin.sourceLabel, "Recent clip",
      "the first learned DOM baseline has unknown onset and falls back");
    await resources.phase("full-export");
    const fullExport = await verifyFullRecentExport({ world, capture, source, pin: initialPin, anki, stoppedLookup });
    await resources.phase("recording");
    await world.evaluate("(async () => HDCapture.release(globalThis.__capturePin))()");

    const soakExports = [];
    if (sustainedSeconds > 5) {
      const soakStarted = performance.now();
      let cycle = 0;
      while ((performance.now() - soakStarted) / 1000 < sustainedSeconds) {
        const mode = ["static", "moving", "dense"][cycle % 3];
        await resources.phase(`soak-${mode}`);
        await source.evaluate(mode => window.setFixtureSceneMode(mode), mode);
        const remaining = sustainedSeconds - (performance.now() - soakStarted) / 1000;
        const periodEnd = performance.now() + Math.min(60, remaining) * 1000;
        while (performance.now() < periodEnd) {
          await new Promise(done => setTimeout(done, Math.min(10_000, periodEnd - performance.now())));
          const status = await captureControl(capture, "hd_capture_status");
          assert.equal(status.state, "recording");
          assert.ok(status.history.frameBytes <= 64 * 1024 * 1024);
          assert.ok(status.history.audioSamples <= 61 * 48000);
          console.log("SOAK", JSON.stringify({ seconds: (performance.now()-soakStarted)/1000,
            mode, history: status.history }));
        }
        const retainedPin = await world.evaluate(`(async () => {
          const node = document.getElementById("subtitle").firstChild;
          return HDCapture.rootLookup({anchor:node,sentence:node.nodeValue,query:node.nodeValue});
        })()`);
        assert.ok(retainedPin?.token, "sustained capture can still pin retained history");
        await resources.phase(`soak-export-${mode}`);
        soakExports.push(await verifyFullRecentExport({ world, capture, source, pin: retainedPin,
          anki, stoppedLookup, expectMotion: mode !== "static" && remaining >= 12,
          assetName: `soak-${cycle}-${mode}` }));
        cycle += 1;
      }
      await source.evaluate(() => window.setFixtureSceneMode("dense"));
      const retained = await captureControl(capture, "hd_capture_status");
      const audioSeconds = (retained.history.audioNewestMs-retained.history.audioOldestMs)/1000;
      assert.ok(audioSeconds > 0 && audioSeconds <= 61, `soaked retained audio duration ${audioSeconds}`);
      if (sustainedSeconds >= 70) assert.ok(audioSeconds >= 55, `full retained audio duration ${audioSeconds}`);
      captureThroughput.soakSeconds = (performance.now()-soakStarted)/1000;
      captureThroughput.soakExports = soakExports;
      captureThroughput.soakFinalHistory = retained.history;
      await resources.phase("recording");
    }

    await source.$eval("#subtitle", element => { element.textContent = "次の行"; });
    await new Promise(done => setTimeout(done, 250));
    const pin = await world.evaluate(`(async () => {
      const node = document.getElementById("subtitle").firstChild;
      const value = await HDCapture.rootLookup({ anchor: node, sentence: node.nodeValue, query: node.nodeValue });
      globalThis.__capturePin = value;
      return value;
    })()`);
    assert.equal(pin.sourceLabel, "Page-text estimate");

    const ankiStatus = await runtimeMessage(world, "hachidori-anki", "hd_anki_status");
    assert.equal(ankiStatus.available, true);
    const engineStatus = await runtimeMessage(world, "hoshidicts-offscreen", "hd_status");
    const request = {
      term: {
        expression: "次",
        reading: "つぎ",
        rules: "",
        glossaries: [],
        frequencies: [],
        pitches: [],
      },
      generation: engineStatus.generation,
      trace: [],
      sentence: "次の行",
      matched: "次",
      matchOffset: 0,
      popupSelectionText: "",
      searchQuery: "次",
      documentTitle: SOURCE_TITLE,
      dictionaryAliases: {},
      frequencyDictionaries: [],
      configKey: ankiStatus.configKey,
      capturePin: pin,
    };
    const preflight = await runtimeMessage(world, "hachidori-anki", "hd_anki_preflight", { request });
    assert.deepEqual(preflight.capture.requirements, { includeAnimation: true, includeAudio: true });

    const encodeStartedAt = performance.now();
    const exported = await captureMessage(world, "hd_capture_export", {
      token: pin.token,
      requirements: preflight.capture.requirements,
    });
    assert.equal(exported.state, "finishing");
    await source.bringToFront();
    await source.evaluate(() => window.triggerSyncMarker());
    // The final independently decoded AVIF must contain the white frame.
    // Controls no longer own a preview or any raw capture data.
    await new Promise(done => setTimeout(done, 350));
    const markerFrameTimestamp = (await captureControl(capture, "hd_capture_status")).history.frameNewestMs;
    await new Promise(done => setTimeout(done, 160));

    const markerDeadline = Date.now() + 2_000;
    let markerStatus;
    do {
      markerStatus = await captureControl(capture, "hd_capture_status");
      if (markerStatus.history.frameNewestMs <= markerFrameTimestamp) {
        await new Promise(done => setTimeout(done, 50));
      }
    } while (markerStatus.history.frameNewestMs <= markerFrameTimestamp
      && Date.now() < markerDeadline);
    assert.ok(markerStatus.history.frameNewestMs > markerFrameTimestamp,
      "capture continues sampling while the clocked synchronization fixture plays");

    await source.waitForFunction(() => document.getElementById("scene").currentTime >= 2.2,
      { timeout: 10_000, polling: 50 });
    await source.$eval("#subtitle", element => { element.textContent = "終了"; });

    let job;
    const deadline = Date.now() + 30_000;
    do {
      job = await captureMessage(world, "hd_capture_job_status", { jobId: exported.jobId });
      if (job.state === "error") throw new Error(job.error);
      if (job.state !== "ready") await new Promise(done => setTimeout(done, 100));
    } while (job.state !== "ready" && Date.now() < deadline);
    assert.equal(job.state, "ready");
    const encodeMs = performance.now() - encodeStartedAt;
    assert.ok(job.assets.animation?.byteLength > 0);
    assert.ok(job.assets.audio?.byteLength > 44);

    if (CAPTURE_SCREENSHOT) {
      mkdirSync(dirname(resolve(CAPTURE_SCREENSHOT)), { recursive: true });
      await capture.screenshot({ path: resolve(CAPTURE_SCREENSHOT), fullPage: true });
    }

    const submitted = await runtimeMessage(world, "hachidori-anki", "hd_anki_submit", {
      request: { ...request, captureJobId: exported.jobId, captureUnavailable: [] },
    });
    assert.equal(submitted.state, "added");
    assert.equal(anki.maxActiveUploads, 1, "captured assets upload one at a time");
    assert.equal(anki.note.fields.Animation, `<img src="${pin.animationFilename}">`);
    assert.equal(anki.note.fields.Audio, `[sound:${pin.audioFilename}]`);

    const animationBase64 = anki.media.get(pin.animationFilename);
    const audioBase64 = anki.media.get(pin.audioFilename);
    assert.ok(animationBase64);
    assert.ok(audioBase64);
    const avif = Buffer.from(animationBase64, "base64");
    const wav = Buffer.from(audioBase64, "base64");
    if (ASSET_DIR) {
      mkdirSync(resolve(ASSET_DIR), { recursive: true });
      writeFileSync(resolve(ASSET_DIR, "capture.avif"), avif);
      writeFileSync(resolve(ASSET_DIR, "capture.wav"), wav);
    }
    assert.equal(avif.subarray(4, 12).toString("ascii"), "ftypavis");
    assert.ok(avifSampleCount(avif) >= 2, "the captured AVIF contains changing timed frames");
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(wav.readUInt16LE(22), 1, "captured WAV is mono");
    const sampleRate = wav.readUInt32LE(24);
    const sampleCount = wav.readUInt32LE(40) / 2;
    assert.ok(sampleCount / sampleRate >= 0.4, "captured WAV covers the selected interval");
    let nonzero = false;
    for (let offset = 44; offset + 1 < wav.length; offset += 2) {
      if (wav.readInt16LE(offset) !== 0) { nonzero = true; break; }
    }
    assert.equal(nonzero, true, "captured tab audio contains the fixture tone");

    await source.bringToFront();
    const frameDecode = await decodedFrameHashes(source, animationBase64);
    assert.ok(frameDecode?.frameCount >= 2, "Chrome exposes multiple AVIF frames");
    assert.equal(frameDecode.repetitionCount, "Infinity", "the AVIF loops indefinitely");
    assert.ok(new Set(frameDecode.hashes).size >= 2,
      `Chrome decodes changing AVIF frames (${frameDecode.hashes.join(", ")})`);
    // The flash occupies at least 20% of these captured fixture layouts;
    // ordinary text occupies less than 1%. Surface resizing can letterbox the
    // video above the canvas center, so recognize its area instead of one pixel.
    const brightFrame = frameDecode.whitePixelFractions.findIndex(value => value >= 0.1);
    assert.ok(brightFrame >= 0,
      `Chrome decodes the synchronization flash (${frameDecode.whitePixelFractions.join(", ")})`);
    const timing = avifTiming(avif);
    assert.equal(timing.durations.length, frameDecode.frameCount);
    const videoMarkerSeconds = timing.durations.slice(0, brightFrame)
      .reduce((total, duration) => total + duration, 0) / timing.timescale;
    const audioMarkerSeconds = wavSignalOnsetSeconds(wav);
    assert.ok(audioMarkerSeconds !== null, "the captured WAV contains the synchronization beep");
    const syncOffsetMs = Math.abs(videoMarkerSeconds - audioMarkerSeconds) * 1000;
    assert.ok(syncOffsetMs <= 125,
      `decoded flash/beep alignment stays within 125 ms (${syncOffsetMs.toFixed(1)} ms)`);
    const decoded = await playbackHashes(source, animationBase64);
    assert.ok(decoded.width <= 640 && decoded.height <= 360);
    assert.ok(new Set(decoded.hashes).size >= 2,
      `Chrome plays the animated AVIF (${JSON.stringify({ frameDecode, playback: decoded.hashes })})`);

    await source.evaluate(() => window.restoreFixtureScene());
    texthooker.send("接続行");
    await capture.waitForFunction(() =>
      document.getElementById("texthooker-status")?.textContent === "Active",
    { polling: 100 });
    await source.$eval("#subtitle", element => { element.textContent = "接続行"; });
    await new Promise(done => setTimeout(done, 250));
    const texthookerPin = await world.evaluate(`(async () => {
      const node = document.getElementById("subtitle").firstChild;
      const value = await HDCapture.rootLookup({ anchor: node, sentence: node.nodeValue, query: node.nodeValue });
      globalThis.__capturePin = value;
      return value;
    })()`);
    assert.equal(texthookerPin.sourceLabel, "Texthooker estimate",
      "a usable live texthooker record wins over matching page text");
    await new Promise(done => setTimeout(done, 1000));
    assert.equal(await capture.$eval("#texthooker-status", element => element.textContent), "Active",
      "an accepted live record has no inactivity timeout");

    await resources.phase("repeat-export");
    const repeatEncodeStartedAt = performance.now();
    const repeatedExport = await captureMessage(world, "hd_capture_export", {
      token: texthookerPin.token,
      requirements: { includeAnimation: true, includeAudio: false },
    });
    await source.evaluate(() => window.setFixtureFrame("#7c3aed"));
    await new Promise(done => setTimeout(done, 500));
    await source.evaluate(() => window.setFixtureFrame("#f59e0b"));
    await new Promise(done => setTimeout(done, 500));
    texthooker.send("後続行");
    let repeatedJob;
    const repeatedDeadline = Date.now() + 30_000;
    do {
      repeatedJob = await captureMessage(world, "hd_capture_job_status", {
        jobId: repeatedExport.jobId,
      });
      if (repeatedJob.state === "error") throw new Error(repeatedJob.error);
      if (repeatedJob.state !== "ready") await new Promise(done => setTimeout(done, 100));
    } while (repeatedJob.state !== "ready" && Date.now() < repeatedDeadline);
    assert.equal(repeatedJob.state, "ready");
    assert.ok(repeatedJob.assets.animation?.byteLength > 0);
    assert.equal(Object.hasOwn(repeatedJob.assets, "audio"), false);
    const repeatEncodeMs = performance.now() - repeatEncodeStartedAt;
    assert.equal((await captureMessage(world, "hd_capture_cancel", {
      jobId: repeatedExport.jobId,
    })).cancelled, true);

    assert.equal(texthooker.disconnect(), true, "the fixture closes the active texthooker socket");
    await capture.waitForFunction(() =>
      ["Disconnected", "Connecting"].includes(document.getElementById("texthooker-status")?.textContent),
    { timeout: 5_000, polling: 100 }).catch(() => {});
    try {
      await capture.waitForFunction(() =>
        (document.getElementById("texthooker-status")?.textContent || "").includes("waiting"),
      { timeout: 10_000, polling: 100 });
    } catch (error) {
      const status = await capture.$eval("#texthooker-status", element => element.textContent);
      throw new Error(`texthooker did not reconnect: ${JSON.stringify({
        status,
        connections: texthooker.connections.length,
        current: Boolean(texthooker.current && !texthooker.current.destroyed),
      })}`, { cause: error });
    }
    assert.ok(texthooker.connections.length >= 2, "texthooker reconnects with a new connection epoch");
    texthooker.send("再接続");
    await capture.waitForFunction(() =>
      document.getElementById("texthooker-status")?.textContent === "Active",
    { polling: 100 });

    const alternate = await browser.newPage();
    await alternate.goto(`${fixtureOrigin}/fixture`, { waitUntil: "domcontentloaded" });
    await alternate.evaluate(() => { document.title = "Hachidori Alternate Reading Page"; });
    const alternateWorld = await extensionWorld(alternate, id);
    const alternateTab = (await captureControl(capture, "hd_capture_tabs")).tabs
      .find(tab => tab.title === "Hachidori Alternate Reading Page");
    assert.ok(alternateTab, "capture controls list a second reading page");
    await captureControl(capture, "hd_capture_link", { tabId: alternateTab.id });
    await capture.waitForFunction(() =>
      document.getElementById("linked-page")?.textContent === "Hachidori Alternate Reading Page",
    { polling: 100 });
    assert.equal(await world.evaluate(`(async () => {
      const node = document.getElementById("subtitle").firstChild;
      return HDCapture.rootLookup({ anchor: node, sentence: node.nodeValue, query: node.nodeValue });
    })()`), null, "linking a second reading page unlinks the first collector");
    const alternatePin = await alternateWorld.evaluate(`(async () => {
      const node = document.getElementById("subtitle").firstChild;
      const value = await HDCapture.rootLookup({ anchor: node, sentence: node.nodeValue, query: node.nodeValue });
      await HDCapture.release(value);
      return value;
    })()`);
    assert.equal(alternatePin.sourceLabel, "Recent clip");
    await captureControl(capture, "hd_capture_link", { tabId: Number(sourceTab) });
    await capture.waitForFunction(title =>
      document.getElementById("linked-page")?.textContent === title,
    { polling: 100 }, SOURCE_TITLE);
    assert.equal(await alternateWorld.evaluate(`(async () => {
      const node = document.getElementById("subtitle").firstChild;
      return HDCapture.rootLookup({ anchor: node, sentence: node.nodeValue, query: node.nodeValue });
    })()`), null, "relinking the first page unlinks the second collector");
    await alternate.close();

    await settings.bringToFront();
    const dismissed = new Promise(resolveDialog => settings.once("dialog", async dialog => {
      assert.match(dialog.message(), /stops the current capture/u);
      await dialog.dismiss();
      resolveDialog();
    }));
    await settings.select("#opt-media-history", "30");
    await dismissed;
    assert.equal(await settings.$eval("#opt-media-history", element => element.value), "60");
    assert.equal((await captureControl(settings, "hd_capture_status")).state, "recording");

    await source.goto(`${fixtureOrigin}/fixture?navigation=1`, {
      waitUntil: "domcontentloaded",
    });
    await capture.waitForFunction(() =>
      document.getElementById("linked-page")?.textContent === "No reading page is linked.",
    { timeout: 10_000, polling: 100 });
    assert.equal((await captureControl(settings, "hd_capture_status")).state, "recording",
      "reading-page navigation clears only the page binding");

    const accepted = new Promise(resolveDialog => settings.once("dialog", async dialog => {
      await dialog.accept();
      resolveDialog();
    }));
    await settings.select("#opt-media-history", "30");
    await accepted;
    await settings.waitForFunction(async () => {
      const stored = await chrome.storage.local.get("options");
      return stored.options?.mediaCapture?.historySeconds === 30;
    }, { timeout: 10_000 });
    await capture.waitForFunction(() => document.getElementById("capture-state")?.textContent === "Stopped",
      { timeout: 10_000, polling: 100 });
    await resources.phase("stopped");
    await source.bringToFront();
    const stopped = await captureControl(settings, "hd_capture_status");
    assert.equal(stopped.history.frameCount, 0);
    assert.equal(stopped.history.audioSamples, 0);
    assert.equal(stopped.linkedPage, null);
    await new Promise(done => setTimeout(done, 500));
    assert.equal((await captureControl(settings, "hd_capture_status")).state, "stopped",
      "settings changes do not auto-rearm capture");

    const storage = await settings.evaluate(async () => chrome.storage.local.get(null));
    const serialized = JSON.stringify(storage);
    assert.equal(serialized.includes("次の行"), false);
    assert.equal(serialized.includes(pin.animationFilename), false);
    assert.equal(serialized.includes(animationBase64.slice(0, 80)), false);

    await new Promise(done => setTimeout(done, 5000));
    const resourceReport = await resources.stop();
    resources = null;
    if (ASSET_DIR) writeFileSync(resolve(ASSET_DIR, "resources.json"), JSON.stringify(resourceReport, null, 2));
    console.log("RESOURCES", JSON.stringify(resourceReport.phases));
    for (const name of CHECKS) console.log(`PASS  ${name}`);
    console.log(`BENCH ${JSON.stringify({
      browser: await browser.version(),
      revision,
      extensionTree,
      extensionModified,
      stoppedLookup,
      fullExport,
      recordingLookup,
      captureThroughput,
      encodeMs,
      repeatEncodeMs,
      animationBytes: job.assets.animation.byteLength,
      audioBytes: job.assets.audio.byteLength,
      avifFrames: frameDecode.frameCount,
      syncOffsetMs,
    })}`);
    console.log(`${CHECKS.length} passed, 0 failed`);
  } finally {
    await resources?.stop().catch(() => {});
    texthooker.disconnect?.();
    for (const socket of texthooker.connections) socket.destroy();
    await browser?.close().catch(() => {});
    await new Promise(done => server.close(done));
    if (!process.env.HACHIDORI_CAPTURE_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
  }
}

await main();
