// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental Crunchyroll mining without Crunchyroll: its switch, the scripts
// it registers, what the manifest exposes to Crunchyroll, the page script's
// replay, pause and resume through the player's <video>, and the reader fed
// by a user script that shows the subtitles and posts their timing, as the
// Script Store's Jimaku Player does (docs/architecture.md, Crunchyroll mining).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import vm from "node:vm";
import "../extension/reader-options.js";
import { CRUNCHYROLL_SCRIPTS, applyCrunchyrollFlag } from "../extension/crunchyroll.js";

const extension = new URL("../extension/", import.meta.url);
const read = path => readFile(new URL(path, extension), "utf8");
const IDS = ["hachidori-crunchyroll-page", "hachidori-crunchyroll-content"];
const PAGE_EVENT = "hachidori-crunchyroll-page";
const COMMAND_EVENT = "hachidori-crunchyroll-command";
const EPISODE = "GTEST12345";
const WATCH = `https://www.crunchyroll.com/de/watch/${EPISODE}/the-first-episode`;

test("Crunchyroll mining is an experimental flag after Netflix's that starts off and names Jimaku Player", () => {
  const { DEFAULT_OPTIONS, EXPERIMENTAL_FEATURES, normaliseOptions } = globalThis.HDReaderOptions;
  const ids = EXPERIMENTAL_FEATURES.map(entry => entry.id);
  assert.equal(ids.indexOf("crunchyrollMining"), ids.indexOf("netflixMining") + 1);
  const feature = EXPERIMENTAL_FEATURES.find(entry => entry.id === "crunchyrollMining");
  assert.equal(feature.label, "Crunchyroll mining");
  assert.match(feature.description, /\{sentence-audio\}.*\{gif\}/u);
  assert.match(feature.description, /Jimaku Player from the Script Store/u);
  assert.equal(feature.section, undefined, "the flag has no Settings section of its own");
  assert.equal(DEFAULT_OPTIONS.experimental.crunchyrollMining, false);
  assert.equal(normaliseOptions({}).experimental.crunchyrollMining, false);
});

test("the flag registers the page script and the reader's scripts for www.crunchyroll.com's top frame only", async () => {
  assert.deepEqual(CRUNCHYROLL_SCRIPTS, [
    { id: "hachidori-crunchyroll-page", matches: ["https://www.crunchyroll.com/*"], js: ["netflix-page.js"],
      runAt: "document_start", allFrames: false, world: "MAIN" },
    { id: "hachidori-crunchyroll-content", matches: ["https://www.crunchyroll.com/*"],
      js: ["netflix-subtitles.js", "netflix-audio.js", "netflix-content.js", "crunchyroll-content.js"],
      runAt: "document_start", allFrames: false, world: "ISOLATED" },
  ]);
  const calls = [];
  const active = new Set();
  const browser = { scripting: {
    async getRegisteredContentScripts({ ids }) { return ids.filter(id => active.has(id)).map(id => ({ id })); },
    async registerContentScripts(scripts) { calls.push(["register", scripts.map(script => script.id)]); for (const { id } of scripts) active.add(id); },
    async unregisterContentScripts({ ids }) { calls.push(["unregister", ids]); for (const id of ids) active.delete(id); },
  } };
  await Promise.all([true, false].map(enabled => applyCrunchyrollFlag(browser, enabled)));
  assert.deepEqual(calls, [["register", IDS], ["unregister", IDS]]);
});

test("the manifest exposes Crunchyroll's recorder page and the MP3 encoder to www.crunchyroll.com and asks for no new permission", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(/crunchyroll/iu.test(JSON.stringify([manifest.content_scripts, manifest.permissions,
    manifest.host_permissions, manifest.optional_permissions])), false);
  assert.deepEqual(manifest.web_accessible_resources.filter(entry => /crunchyroll/iu.test(JSON.stringify(entry))),
    [{ resources: ["crunchyroll-recorder.html"], matches: ["https://www.crunchyroll.com/*"] },
    { resources: ["sentence-audio.js", "base64.js", "vendor/lamejs.js", "vendor/mediabunny/mediabunny.js"],
      matches: ["https://www.netflix.com/*", "https://www.youtube.com/*", "https://www.crunchyroll.com/*"] }]);
  assert.match(await read("crunchyroll-recorder.html"), /<script type="module" src="crunchyroll-recorder\.js"><\/script>/u);
  assert.match(await read("crunchyroll-recorder.js"),
    /connectNetflixRecorder\(globalThis, \{ port: "hachidori-crunchyroll-recorder", site: "Crunchyroll" \}\)/u);
});

// The page script on www.crunchyroll.com, in a main world with only what it
// touches there: the document's events and the player's <video>, whose time
// advances while it plays and whose own seeking reports `seeked`.
function crunchyrollPage({ startMs = 7000, paused = true, rate = 1.5, withVideo = true } = {}) {
  const calls = [];
  const video = new EventTarget();
  let mediaMs = startMs, playingSince = null, currentRate = rate;
  const now = () => performance.now();
  const stop = () => {
    if (playingSince !== null) mediaMs += (now() - playingSince) * currentRate;
    playingSince = null;
  };
  Object.defineProperties(video, {
    currentTime: {
      get: () => (mediaMs + (playingSince === null ? 0 : (now() - playingSince) * currentRate)) / 1000,
      set: seconds => {
        calls.push(["currentTime", seconds]);
        const wasPlaying = playingSince !== null;
        stop();
        mediaMs = seconds * 1000;
        if (wasPlaying) playingSince = now();
        setTimeout(() => video.dispatchEvent(new Event("seeked")), 1);
      },
    },
    paused: { get: () => playingSince === null },
    playbackRate: { get: () => currentRate, set: value => { calls.push(["playbackRate", value]); stop(); currentRate = value; } },
  });
  Object.assign(video, { seeking: false, ended: false,
    play: async () => { calls.push(["play", currentRate]); playingSince ??= now(); },
    pause: () => { calls.push(["pause"]); stop(); } });
  if (!paused) playingSince = now();
  const document = new EventTarget();
  document.querySelector = selector => (withVideo && selector.endsWith("video") ? video : null);
  const posted = [];
  document.addEventListener(PAGE_EVENT, event => posted.push(JSON.parse(event.detail)));
  const fetched = [];
  const context = vm.createContext({ document, CustomEvent, EventTarget, Event, URL, Promise, Reflect, performance,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async url => { fetched.push(url); throw new Error("Crunchyroll's page script fetches nothing"); },
    location: { href: WATCH, origin: "https://www.crunchyroll.com", hostname: "www.crunchyroll.com",
      pathname: new URL(WATCH).pathname, search: "" } });
  context.window = context;
  return { context, document, video, calls, posted, fetched,
    run: async source => vm.runInContext(source, context),
    command: message => document.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: JSON.stringify(message) })) };
}

async function replyOf(posted) {
  for (let attempt = 0; attempt < 400 && !posted.some(message => message.kind === "replay"); attempt++) {
    await new Promise(done => { setTimeout(done, 5); });
  }
  return posted.find(message => message.kind === "replay");
}

const pageSource = await read("netflix-page.js");

test("on Crunchyroll the page script reads no subtitles: JSON stays the page's, nothing is fetched or posted", async () => {
  const page = crunchyrollPage();
  await page.run(pageSource);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify([String(JSON.stringify), String(JSON.parse)])", page.context)),
    ["function stringify() { [native code] }", "function parse() { [native code] }"]);
  page.command({ type: "resend", movieId: EPISODE });
  page.command({ type: "language", language: "en" });
  await new Promise(done => { setTimeout(done, 20); });
  assert.deepEqual([page.fetched, page.posted, page.calls], [[], [], []], "a user script posts the subtitles itself");
});

test("a replay plays the cue at 1× through the <video> and restores the viewer's position, pause and speed", async () => {
  const page = crunchyrollPage();
  await page.run(pageSource);
  page.command({ type: "replay", id: "r1", startMs: 1000, endMs: 1100, padMs: 50 });
  const reply = await replyOf(page.posted);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(page.calls.slice(0, 3), [["playbackRate", 1], ["currentTime", 0.95], ["play", 1]]);
  assert.deepEqual(page.calls.slice(3).map(([name]) => name), ["pause", "currentTime", "playbackRate"]);
  assert.ok(Math.abs(page.calls[4][1] - 7) < 0.01, "playback returns to where the viewer was");
  assert.equal(page.calls.at(-1)[1], 1.5);
  assert.equal(page.video.paused, true);
  assert.ok(reply.anchors.length > 0);

  const missing = crunchyrollPage({ withVideo: false });
  await missing.run(pageSource);
  missing.command({ type: "replay", id: "r2", startMs: 0, endMs: 10, padMs: 0 });
  assert.deepEqual(await replyOf(missing.posted), { kind: "replay", id: "r2", ok: false, error: "player" });
});

test("hover pause and resume go through the <video>", async () => {
  const page = crunchyrollPage({ paused: false, rate: 1 });
  await page.run(pageSource);
  page.command({ type: "pause" });
  assert.equal(page.video.paused, true);
  page.command({ type: "resume" });
  assert.equal(page.video.paused, false);
  assert.deepEqual(page.calls, [["pause"], ["play", 1]]);
});

// The reader on a Crunchyroll watch page as a user script leaves it: the
// player's <video> and controls, and the script's subtitles over the video,
// marked for Hachidori (data-hachidori-subtitles, -subtitle-line and
// -over-video).
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const READER = await Promise.all(["netflix-subtitles.js", "netflix-content.js", "crunchyroll-content.js"].map(read));
const vtt = cues => `WEBVTT\n\n${cues.map(([from, to, text]) => `${from} --> ${to}\n${text}`).join("\n\n")}\n`;

function reader(t, { timeMs = 2500, url = WATCH } = {}) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body><h1>Episode 1</h1>
    <div class="bitmovinplayer-container"><video></video><div class="bmpui-ui-uicontainer">0:02</div>
    <div id="jp-host" data-hachidori-over-video><button id="jp-fab">字</button>
    <div id="jp-overlay" data-hachidori-subtitles><span id="jp-overlay-text" data-hachidori-subtitle-line>朝ごはんを
食べたかった</span></div></div></div></body></html>`, { url, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.chrome = { runtime: { getURL: path => `chrome-extension://hachidori/${path}` } };
  const commands = [];
  window.document.addEventListener(COMMAND_EVENT, event => commands.push(JSON.parse(event.detail)));
  for (const source of READER) window.eval(source);
  const video = window.document.querySelector("video");
  Object.defineProperty(video, "currentTime", { value: timeMs / 1000, writable: true });
  // What a user script posts: its file as WebVTT in the video's time.
  const post = (text, extra = {}) => window.document.dispatchEvent(new window.CustomEvent(PAGE_EVENT, { detail: JSON.stringify(
    { kind: "subtitle", movieId: EPISODE, trackId: "jimaku", closedCaptions: false, format: "webvtt", text, ...extra }) }));
  const plain = value => JSON.parse(JSON.stringify(value));
  const api = window.HDCrunchyroll;
  return { window, api, video, commands, post, line: window.document.getElementById("jp-overlay-text"),
    observe: element => plain(api.observe(element)), miningFields: (...args) => plain(api.miningFields(...args)) };
}

test("a user script's posted subtitles pin the hovered line's cue on a localised watch address, and the whole cue becomes the root sentence", t => {
  const page = reader(t);
  page.post(vtt([["00:00:02.000", "00:00:03.600", "朝ごはんを\n食べたかった"], ["00:00:05.000", "00:00:06.500", "またね"]]));
  const observation = page.observe(page.line);
  assert.equal(observation.movieId, EPISODE);
  assert.equal(observation.mediaTimeMs, 2500);
  assert.deepEqual(page.miningFields(observation, { sentence: "食べたかった", matchOffset: 0 }),
    { crunchyroll: { cue: { movieId: EPISODE, startMs: 2000, endMs: 3600 } }, sentence: "朝ごはんを食べたかった", matchOffset: 5 });
  assert.equal(page.api.observe(page.window.document.querySelector("h1")), null, "the page's own text is no subtitle");
  assert.equal(page.window.HDNetflix, undefined, "netflix-content.js makes Netflix's reader on Netflix only");
});

test("a timeline posted again replaces the track's, as a user script does after it is synced", t => {
  const page = reader(t);
  page.post(vtt([["00:00:01.000", "00:00:01.800", "朝ごはんを\n食べたかった"]]));
  assert.deepEqual(page.miningFields(page.observe(page.line)), { crunchyroll: { unavailable: "no-match" } });
  page.post(vtt([["00:00:02.200", "00:00:03.400", "朝ごはんを\n食べたかった"]]));
  assert.deepEqual(page.miningFields(page.observe(page.line)).crunchyroll,
    { cue: { movieId: EPISODE, startMs: 2200, endMs: 3400 } });
});

test("without a timeline the reader asks the user script once to post it again, and says why there is none", t => {
  const page = reader(t);
  const observation = page.observe(page.line);
  assert.deepEqual(page.miningFields(observation), { crunchyroll: { unavailable: "no-timeline" } });
  assert.deepEqual(page.miningFields(observation), { crunchyroll: { unavailable: "no-timeline" } });
  assert.deepEqual(page.commands, [{ type: "resend", movieId: EPISODE }]);
  const elsewhere = reader(t, { url: "https://www.crunchyroll.com/series/GABC/a-show" });
  assert.equal(elsewhere.observe(elsewhere.line).movieId, null, "a page that is no episode's has no movie");
});
