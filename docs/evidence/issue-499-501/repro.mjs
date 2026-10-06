// One-off #499 reproduction, not committed. A local server answers the way
// friedrich-de/yomitan-ultimate-audio's worker does (src/routes/audio.ts and
// src/lib/yomitanResponse.ts): /audio/list returns an itty-router json()
// audioSourceList, /audio/get serves every file as audio/mpeg, a bad key is
// refused with JSON 403, and nothing sends CORS or CORP headers. A real
// Chrome runs the extension's own Settings Test (hd_audio_test) and popup
// play path against it.
// Usage: node repro.mjs <extension dir> <mp3 file>
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const [extension, mp3Path] = process.argv.slice(2);
const mp3 = readFileSync(mp3Path);
const KEY = "patron-key";
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  requests.push(`${url.pathname}${url.search}`);
  const json = (status, value) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === "/page") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end("<!doctype html><title>Sign in</title><p>Please sign in to continue.</p>");
  }
  if (url.searchParams.get("apiKey") !== KEY) return json(403, { status: 403, error: "Invalid API key" });
  if (url.pathname === "/audio/list") {
    const origin = `http://127.0.0.1:${server.address().port}`;
    return json(200, { type: "audioSourceList", audioSources: [
      { name: "NHK16 聞く", url: `${origin}/audio/get/nhk16/${encodeURIComponent("聞く.mp3")}?apiKey=${KEY}` },
      { name: "TTS (Default - No DB)", url: `${origin}/audio/tts?term=${encodeURIComponent(url.searchParams.get("term"))}&apiKey=${KEY}` },
    ] });
  }
  if (url.pathname.startsWith("/audio/get/") || url.pathname === "/audio/tts") {
    response.writeHead(200, { "content-type": "audio/mpeg" });
    return response.end(mp3);
  }
  return json(400, { status: 400, error: "Bad Request" });
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const list = `http://127.0.0.1:${port}/audio/list?term={term}&reading={reading}&apiKey=`;

const require = createRequire(resolve(process.env.HACHIDORI_TOOLING, "package.json"));
const puppeteer = require("puppeteer-core");
const profile = mkdtempSync(resolve(tmpdir(), "hd-499-"));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true,
  headless: true, userDataDir: profile, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-audio-output", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker");
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/settings.html#audio`);
  const test = source => page.evaluate(async source => {
    const started = performance.now();
    const reply = await chrome.runtime.sendMessage({ target: "hachidori-audio", type: "hd_audio_test",
      source: { id: "ultimate", enabled: true, voice: "", ...source }, requestId: crypto.randomUUID() });
    return { ...reply, ms: Math.round(performance.now() - started) };
  }, source);
  const results = {};
  for (const [label, source] of [
    ["Audio URL (custom), list URL + valid key", { type: "custom", url: list + KEY }],
    ["Yomitan JSON (custom-json), list URL + valid key", { type: "custom-json", url: list + KEY }],
    ["Yomitan JSON (custom-json), list URL + wrong key", { type: "custom-json", url: list + "wrong" }],
    ["Audio URL (custom), direct recording URL", { type: "custom", url: `http://127.0.0.1:${port}/audio/get/nhk16/x.mp3?apiKey=${KEY}` }],
    ["Yomitan JSON (custom-json), direct recording URL", { type: "custom-json", url: `http://127.0.0.1:${port}/audio/get/nhk16/x.mp3?apiKey=${KEY}` }],
    ["Audio URL (custom), HTML page with HTTP 200", { type: "custom", url: `http://127.0.0.1:${port}/page` }],
    ["Audio URL (custom), recording URL + wrong key", { type: "custom", url: `http://127.0.0.1:${port}/audio/get/nhk16/x.mp3?apiKey=wrong` }],
  ]) results[label] = await test(source);
  console.log(JSON.stringify({ results, requests }, null, 2));
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
