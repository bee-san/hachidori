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
  await page.goto(`${origin}/netflix-recorder.html`);
  const report = await page.evaluate(async () => {
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
      const ms = performance.now() - begin;
      const decoder = new ImageDecoder({ data: bytes, type: `image/${format}` });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      const frames = [];
      for (let index = 0; index < track.frameCount; index += 1) {
        const { image } = await decoder.decode({ frameIndex: index });
        const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        frames.push({ value: context.getImageData(20, 20, 1, 1).data[0], duration: image.duration });
        image.close();
      }
      results[format] = { ms, frames, loop: String(track.repetitionCount), bytes: Array.from(bytes) };
      decoder.close();
    }
    const { encodeSentenceAudio } = await import("./sentence-audio.js");
    const context = new AudioContext();
    const samples = Float32Array.from({ length: 96_000 }, (_, index) => 0.1 * Math.sin(2 * Math.PI * 440 * index / 48_000));
    for (const format of ["mp3", "opus"]) {
      const begin = performance.now();
      const bytes = await encodeSentenceAudio(samples, 48_000, { videoAudioFormat: format, videoAudioBitrate: 64 });
      const decoded = await context.decodeAudioData(bytes.slice().buffer);
      const signal = decoded.getChannelData(0);
      results[format] = { ms: performance.now() - begin, duration: decoded.duration,
        rms: Math.sqrt(signal.reduce((sum, value) => sum + value * value, 0) / signal.length), bytes: Array.from(bytes) };
    }
    await context.close();
    // Same 480×270, 2-second, 10-fps clip for three samples of each encoder.
    // GIF calls the exact encoder shipped before this change; worker startup
    // and transfer are included for WebP/AVIF, as in the production recorder.
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
  await page.evaluate(async () => chrome.storage.local.set({ options: { experimental: { youtubeMining: true } } }));
  await page.goto(`${origin}/settings.html#advanced`);
  await page.waitForSelector("#video-mining-settings:not([hidden])");
  await (await page.$("#video-mining-settings")).screenshot({ path: resolve(root, "test/tmp/ci/video-mining-settings.png") });
  writeFileSync(resolve(root, "test/tmp/ci/video-formats.json"), JSON.stringify(report, null, 2));
  console.log("PASS video formats", JSON.stringify(report));
} finally { await browser.close(); }
