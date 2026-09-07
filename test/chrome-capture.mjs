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
import { createServer } from "node:http";
import { createHash } from "node:crypto";
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
const FORCE_AUDIO_WORKLET = process.env.HACHIDORI_CAPTURE_FORCE_AUDIO_WORKLET === "1";

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
      #scene { width: min(80vw, 800px); aspect-ratio: 16 / 9; border-radius: 18px; box-shadow: 0 24px 60px #0008; }
      #subtitle-area { min-width: 26rem; padding: 18px 28px; border-radius: 12px; background: #000c; text-align: center; }
      #subtitle { font-size: 32px; }
      button { padding: 12px 20px; font: inherit; }
    </style>
  </head>
  <body>
    <main>
      <video id="scene" autoplay playsinline></video>
      <canvas id="fixture-canvas" width="960" height="540" hidden></canvas>
      <div id="subtitle-area"><span id="subtitle">最初の行</span></div>
      <button id="fixture-start" type="button">Start fixture audio</button>
    </main>
    <script>
      const scene = document.getElementById("scene");
      const canvas = document.getElementById("fixture-canvas");
      const context = canvas.getContext("2d");
      let frame = 0;
      let painting = true;
      let videoTrack = null;
      function paint() {
        frame += 1;
        if (painting) {
          const hue = frame % 360;
          const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
          gradient.addColorStop(0, "hsl(" + hue + " 80% 45%)");
          gradient.addColorStop(1, "hsl(" + ((hue + 130) % 360) + " 80% 30%)");
          context.fillStyle = gradient;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#fff";
          context.font = "bold 72px sans-serif";
          context.fillText("Hachidori " + frame, 80, 280);
        }
        videoTrack?.requestFrame();
        requestAnimationFrame(paint);
      }
      paint();
      window.setFixtureFrame = color => {
        painting = false;
        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);
        videoTrack?.requestFrame();
      };
      window.triggerSyncMarker = () => {
        if (!window.fixtureAudio) throw new Error("fixture audio is not active");
        const { audio, destination } = window.fixtureAudio;
        const start = audio.currentTime + 0.05;
        const end = start + 0.25;
        painting = false;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        videoTrack.requestFrame();
        const oscillator = new OscillatorNode(audio, { frequency: 1200 });
        const gain = new GainNode(audio, { gain: 0.22 });
        oscillator.connect(gain).connect(destination);
        oscillator.start(start);
        oscillator.stop(end);
        return { start, end };
      };
      document.getElementById("fixture-start").addEventListener("click", async event => {
        const button = event.currentTarget;
        const audio = new AudioContext({ sampleRate: 48000 });
        const destination = audio.createMediaStreamDestination();
        const oscillator = new OscillatorNode(audio, { frequency: 440 });
        const gain = new GainNode(audio, { gain: 0 });
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await audio.resume();
        const canvasStream = canvas.captureStream(0);
        videoTrack = canvasStream.getVideoTracks()[0];
        scene.srcObject = new MediaStream([videoTrack, ...destination.stream.getAudioTracks()]);
        videoTrack.requestFrame();
        await scene.play();
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

function createFixtureServer(anki) {
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      reply(res, 204, "");
      return;
    }
    if (req.url === "/fixture") {
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
    server.listen(8765, "127.0.0.1", resolveListen);
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
    const centerLuminances = [];
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
      const center = (Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4;
      centerLuminances.push((pixels[center] + pixels[center + 1] + pixels[center + 2]) / 3);
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
      centerLuminances,
    };
  }, base64);
}

async function main() {
  assert.ok(CHROME && existsSync(CHROME), "Chrome for Testing is available");
  assert.ok(existsSync(PUPPETEER), "puppeteer-core is available");

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
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const puppeteer = await import(`file://${PUPPETEER}`);
  const launcher = puppeteer.default?.launch ? puppeteer.default : puppeteer;
  let browser;
  try {
    browser = await launcher.launch({
      executablePath: CHROME,
      headless: process.env.HACHIDORI_CAPTURE_HEADFUL === "1" ? false : true,
      userDataDir: PROFILE,
      dumpio: process.env.HACHIDORI_DUMPIO === "1",
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
        "--enable-usermedia-screen-capturing",
        `--auto-select-tab-capture-source-by-title=${SOURCE_TITLE}`,
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
      ],
    });
    const id = await extensionId(browser);
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
    await source.goto("http://127.0.0.1:8765/fixture", { waitUntil: "domcontentloaded" });
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
    assert.equal(importState, "Finished 1 of 1 archive — 1 imported, 0 failed.");
    await settings.goto(`chrome-extension://${id}/settings.html#media`, { waitUntil: "domcontentloaded" });
    await settings.waitForSelector("#media:not([hidden])");

    const mediaCapture = {
      enabled: true,
      timingMode: "auto",
      includeAnimation: true,
      includeCapturedAudio: true,
      historySeconds: 60,
      clipSeconds: 5,
      videoPreset: "standard",
      estimatedOffsetMs: -500,
      texthooker: { enabled: true, url: "ws://127.0.0.1:8765/ws", format: "plain" },
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
      }
    }

    const stoppedLookup = await lookupBenchmark(world);

    const capture = await browser.newPage();
    await capture.setViewport({ width: 1280, height: 960, deviceScaleFactor: 1 });
    if (FORCE_AUDIO_WORKLET) {
      await capture.evaluateOnNewDocument(() => {
        globalThis.__hachidoriForceAudioWorklet = true;
      });
    }
    await capture.goto(`chrome-extension://${id}/capture.html`, { waitUntil: "domcontentloaded" });
    await capture.waitForFunction(() => document.getElementById("capture-state")?.textContent === "Stopped",
      { polling: 100 });
    assert.equal(await capture.$eval("#capture-state", element => element.textContent), "Stopped",
      "saved settings never auto-arm capture");
    await capture.bringToFront();
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
    const sustainedSeconds = Math.max(5,
      Math.min(90, Number(process.env.HACHIDORI_CAPTURE_SUSTAINED_SECONDS) || 5));
    const throughputMeasurementSeconds = Math.min(5, sustainedSeconds);
    await new Promise(done => setTimeout(done, throughputMeasurementSeconds * 1000));
    const throughputElapsedSeconds = (performance.now() - throughputStartedAt) / 1000;
    const throughputEnd = await captureControl(capture, "hd_capture_status");
    const remainingSustainedSeconds = sustainedSeconds - throughputMeasurementSeconds;
    if (remainingSustainedSeconds > 0) {
      await new Promise(done => setTimeout(done, remainingSustainedSeconds * 1000));
    }
    const retentionEnd = remainingSustainedSeconds > 0
      ? await captureControl(capture, "hd_capture_status")
      : throughputEnd;
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
    if (sustainedSeconds >= 65) {
      assert.ok(captureThroughput.retainedVideoSeconds >= 55
        && captureThroughput.retainedVideoSeconds <= 61);
      assert.ok(captureThroughput.retainedAudioSeconds >= 55
        && captureThroughput.retainedAudioSeconds <= 61);
    }
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

    const initialPin = await world.evaluate(`(async () => {
      const node = document.getElementById("subtitle").firstChild;
      const pin = await HDCapture.rootLookup({ anchor: node, sentence: node.nodeValue, query: node.nodeValue });
      globalThis.__capturePin = pin;
      return pin;
    })()`);
    assert.equal(initialPin.sourceLabel, "Recent clip",
      "the first learned DOM baseline has unknown onset and falls back");
    await world.evaluate("(async () => HDCapture.release(globalThis.__capturePin))()");

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
    await capture.bringToFront();
    await source.evaluate(() => window.triggerSyncMarker());
    assert.deepEqual(await source.$eval("#fixture-canvas", canvas => {
      const pixel = canvas.getContext("2d").getImageData(10, 10, 1, 1).data;
      return [...pixel];
    }), [255, 255, 255, 255]);
    await capture.waitForFunction(() => {
      const video = document.getElementById("capture-preview");
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, video.videoWidth / 2, video.videoHeight / 2, 1, 1, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return (pixel[0] + pixel[1] + pixel[2]) / 3 >= 240;
    }, { timeout: 3_000, polling: 50 });
    const markerFrameTimestamp = (await captureControl(capture, "hd_capture_status")).history.frameNewestMs;
    await new Promise(done => setTimeout(done, 160));
    await source.evaluate(() => window.setFixtureFrame("#fff"));
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
      "capture samples the synchronization flash before the fixture advances");
    await source.evaluate(() => window.setFixtureFrame("#e11d48"));
    await new Promise(done => setTimeout(done, 400));
    await source.evaluate(() => window.setFixtureFrame("#2563eb"));
    await new Promise(done => setTimeout(done, 400));
    await source.evaluate(() => window.setFixtureFrame("#16a34a"));
    await new Promise(done => setTimeout(done, 400));
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
    const brightFrame = frameDecode.centerLuminances.findIndex(value => value >= 240);
    assert.ok(brightFrame >= 0,
      `Chrome decodes the synchronization flash (${frameDecode.centerLuminances.join(", ")})`);
    const timing = avifTiming(avif);
    assert.equal(timing.durations.length, frameDecode.frameCount);
    const videoMarkerSeconds = timing.durations.slice(0, brightFrame)
      .reduce((total, duration) => total + duration, 0) / timing.timescale;
    const audioMarkerSeconds = wavSignalOnsetSeconds(wav);
    assert.ok(audioMarkerSeconds !== null, "the captured WAV contains the synchronization beep");
    const syncOffsetMs = Math.abs(videoMarkerSeconds - audioMarkerSeconds) * 1000;
    assert.ok(syncOffsetMs <= 300,
      `decoded flash/beep alignment stays within 300 ms (${syncOffsetMs.toFixed(1)} ms)`);
    const decoded = await playbackHashes(source, animationBase64);
    assert.ok(decoded.width <= 640 && decoded.height <= 360);
    assert.ok(new Set(decoded.hashes).size >= 2,
      `Chrome plays the animated AVIF (${JSON.stringify({ frameDecode, playback: decoded.hashes })})`);

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
    await alternate.goto("http://127.0.0.1:8765/fixture", { waitUntil: "domcontentloaded" });
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

    await source.goto("http://127.0.0.1:8765/fixture?navigation=1", {
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

    console.log("PASS  real tab capture records bounded video and source audio");
    console.log("PASS  learned DOM timing falls back first, then pins an observed line");
    console.log("PASS  animated AVIF and mono WAV upload through Anki one at a time");
    console.log("PASS  Chrome decodes changing AVIF frames and non-silent WAV samples");
    console.log("PASS  decoded flash and beep stay aligned within 300 ms");
    console.log("PASS  live texthooker priority, active state and reconnect use the real loopback WebSocket");
    console.log("PASS  a second pinned interval encodes and cleans up independently");
    console.log("PASS  one linked reading document is enforced and navigation clears it without stopping capture");
    console.log("PASS  capture-setting confirmation stops and clears without auto-rearming");
    console.log(`BENCH ${JSON.stringify({
      stoppedLookup,
      recordingLookup,
      captureThroughput,
      encodeMs,
      repeatEncodeMs,
      animationBytes: job.assets.animation.byteLength,
      audioBytes: job.assets.audio.byteLength,
      avifFrames: frameDecode.frameCount,
      syncOffsetMs,
    })}`);
    console.log("9 passed, 0 failed");
  } finally {
    texthooker.disconnect?.();
    for (const socket of texthooker.connections) socket.destroy();
    await browser?.close().catch(() => {});
    await new Promise(done => server.close(done));
    if (!process.env.HACHIDORI_CAPTURE_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
  }
}

await main();
