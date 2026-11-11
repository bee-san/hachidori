// SPDX-License-Identifier: GPL-3.0-or-later
// Exercise the shipped encoders and their CSP in a real extension page. Decode
// every animation frame, not just its poster, and the Opus/MP3 audio independently.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const build = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8")).config.chrome;
const executablePath = process.env.HACHIDORI_CHROME || resolve(root, `test/tmp/browsers/chrome/linux-${build}/chrome-linux64/chrome`);
const extension = resolve(root, "extension");
const browser = await puppeteer.launch({ executablePath, headless: true, args: [
  ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
] });
mkdirSync(resolve(root, "test/tmp/ci"), { recursive: true });
try {
  const target = await browser.waitForTarget(target => target.type() === "service_worker");
  const { protocol, host } = new URL(target.url());
  const origin = `${protocol}//${host}`;
  const page = await browser.newPage();
  await page.exposeFunction("saveVideoFormat", (format, bytes) => {
    writeFileSync(resolve(root, `test/tmp/ci/video-formats.${format}`), Buffer.from(bytes));
  });
  await page.goto(`${origin}/netflix-recorder.html`);
  const { still, ...report } = await page.evaluate(async () => {
    const width = 160, height = 90;
    const entries = [40, 120, 210].map((value, index) => ({ delayMs: [100, 150, 200][index],
      data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, channel) => channel % 4 === 3 ? 255 : value) }));
    const results = {};
    for (const format of ["gif", "webp", "avif"]) {
      const worker = new Worker(new URL("video-image-worker.js", location.href), { type: "module" });
      const begin = performance.now();
      let bytes;
      try {
        bytes = await new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.bytes);
          worker.onerror = event => reject(new Error(event.message));
          worker.postMessage({ entries, width, height, options: { videoImageFormat: format, videoImageQuality: 70 } });
        });
      } finally { worker.terminate(); }
      await globalThis.saveVideoFormat(format, Array.from(bytes));
      const ms = performance.now() - begin;
      const decoder = new ImageDecoder({ data: bytes, type: `image/${format}` });
      try { await decoder.tracks.ready; }
      catch (error) { throw new Error(`${format}: ${error.message}`); }
      const track = decoder.tracks.selectedTrack;
      const frames = [];
      for (let index = 0; index < track.frameCount; index += 1) {
        const { image } = await decoder.decode({ frameIndex: index }).catch(error => {
          throw new Error(`${format} frame ${index}: ${error.message}`, { cause: error });
        });
        const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        frames.push({ value: context.getImageData(20, 20, 1, 1).data[0], duration: image.duration });
        image.close();
      }
      results[format] = { ms, frames, loop: String(track.repetitionCount), bytes: Array.from(bytes) };
      decoder.close();
    }
    const { encodeStillAvif } = await import("./video-avif.js");
    const stillCanvas = new OffscreenCanvas(161, 91);
    const stillContext = stillCanvas.getContext("2d");
    stillContext.fillStyle = "rgb(120, 120, 120)";
    stillContext.fillRect(0, 0, stillCanvas.width, stillCanvas.height);
    const stillBytes = await encodeStillAvif(stillCanvas);
    await globalThis.saveVideoFormat("still.avif", Array.from(stillBytes));
    const stillDecoder = new ImageDecoder({ data: stillBytes, type: "image/avif" });
    let stillImage;
    try {
      await stillDecoder.tracks.ready;
      stillImage = await createImageBitmap(new Blob([stillBytes], { type: "image/avif" }));
      stillContext.clearRect(0, 0, stillCanvas.width, stillCanvas.height);
      stillContext.drawImage(stillImage, 0, 0);
      results.still = { brand: new TextDecoder().decode(stillBytes.subarray(4, 12)),
        size: [stillImage.width, stillImage.height], frames: stillDecoder.tracks.selectedTrack.frameCount,
        value: stillContext.getImageData(160, 90, 1, 1).data[0] };
    } catch (error) {
      throw new Error(`still AVIF: ${error.message}`, { cause: error });
    } finally {
      stillImage?.close();
      stillDecoder.close();
    }
    const { encodeSentenceAudio } = await import("./sentence-audio.js");
    const context = new AudioContext();
    for (const [name, format, rate] of [["mp3", "mp3", 48_000], ["opus", "opus", 48_000], ["opus-44100.opus", "opus", 44_100]]) {
      const samples = Float32Array.from({ length: 2 * rate }, (_, index) => 0.1 * Math.sin(2 * Math.PI * 440 * index / rate));
      const begin = performance.now();
      const bytes = await encodeSentenceAudio(samples, rate, { videoAudioFormat: format, videoAudioBitrate: 64 });
      const decoded = await context.decodeAudioData(bytes.slice().buffer);
      const signal = decoded.getChannelData(0);
      results[name] = { ms: performance.now() - begin, duration: decoded.duration,
        rms: Math.sqrt(signal.reduce((sum, value) => sum + value * value, 0) / signal.length), bytes: Array.from(bytes) };
    }
    await context.close();
    // Same 480×270, 2-second, 10-fps clip for three samples of each encoder.
    // GIF calls the exact encoder shipped before this change. These targeted
    // timings exclude replay, worker transport, decoding and Anki requests.
    const detailed = Array.from({ length: 20 }, (_, frame) => ({ delayMs: 100,
      data: Uint8ClampedArray.from({ length: 480 * 270 * 4 }, (_, index) => {
        if (index % 4 === 3) return 255;
        const x = Math.floor(index / 4) % 480, y = Math.floor(index / (4 * 480));
        return ((x + frame * 5 + index % 4 * 40) ^ (y * 2)) & 255;
      }) }));
    const { encodeLoopingGif } = await import("./netflix-gif.js");
    const { encodeVideoImage } = await import("./video-image.js");
    results.benchmark = {};
    for (const format of ["baseline-gif", "gif", "webp", "avif"]) {
      const samples = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const begin = performance.now();
        const bytes = format === "baseline-gif" ? encodeLoopingGif(detailed, 480, 270)
          : await encodeVideoImage(detailed, 480, 270, { videoImageFormat: format, videoImageQuality: 70 });
        samples.push({ ms: performance.now() - begin, bytes: bytes.length });
      }
      results.benchmark[format] = samples;
    }
    return results;
  });
  assert.equal(still.brand, "ftypavif", "the screenshot has a still AVIF container");
  assert.equal(still.frames, 1, "the screenshot decodes to one frame");
  assert.deepEqual(still.size, [161, 91], "the screenshot preserves odd dimensions");
  assert.ok(Math.abs(still.value - 120) < 12, "the screenshot preserves the last pixel");
  for (const [format, result] of Object.entries(report)) {
    if (format === "benchmark") continue;
    writeFileSync(resolve(root, `test/tmp/ci/video-formats.${format}`), Buffer.from(result.bytes));
    result.bytes = result.bytes.length;
    if (result.frames) {
      assert.equal(result.frames.length, 3, `${format} is an animation, not a still image`);
      result.frames.forEach((frame, index) => {
        assert.ok(Math.abs(frame.value - [40, 120, 210][index]) < 12, `${format} frame ${index}: ${frame.value}`);
        assert.ok(Math.abs(frame.duration / 1000 - [100, 150, 200][index]) <= (format === "gif" ? 10 : 2), `${format} timing`);
      });
      assert.equal(result.loop, "Infinity", `${format} loops indefinitely`);
    } else {
      assert.ok(Math.abs(result.duration - 2) < 0.1, `${format} preserves the whole line`);
      assert.ok(result.rms > 0.08 && result.rms < 0.12, `${format} preserves the levelled sound`);
    }
  }
  writeFileSync(resolve(root, "test/tmp/ci/video-formats.json"), JSON.stringify(report, null, 2));
  console.log("PASS video formats", JSON.stringify(report));
  await page.goto(`${origin}/settings.html#anki`);
  // The installer's welcome tab can take focus while the encoders run.
  await page.bringToFront();
  await page.waitForSelector("#video-mining-settings", { visible: true });
  const clip = await page.$eval("#video-mining-settings", element => {
    element.scrollIntoView({ block: "center", behavior: "instant" });
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x: x + scrollX, y: y + scrollY, width, height };
  });
  await page.screenshot({ path: resolve(root, "test/tmp/ci/video-mining-settings.png"), clip });
} finally { await browser.close(); }
