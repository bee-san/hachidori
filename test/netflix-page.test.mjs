// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SOURCE = await readFile(new URL("../extension/netflix-page.js", import.meta.url), "utf8");
const PAGE_EVENT = "hachidori-netflix-page";
const COMMAND_EVENT = "hachidori-netflix-command";

// A main world with only what netflix-page.js touches: the page's JSON, fetch,
// location, Netflix's player global and a <video>.
function page({ pathname = "/watch/81000001", subtitles = {}, player = null, video = null } = {}) {
  const document = new EventTarget();
  document.querySelector = selector => (selector === ".watch-video video" || selector === "video" ? video : null);
  const posted = [];
  const fetched = [];
  document.addEventListener(PAGE_EVENT, event => posted.push(JSON.parse(event.detail)));
  const context = vm.createContext({
    document, CustomEvent, EventTarget, ArrayBuffer, Promise, Reflect, performance, setTimeout, clearTimeout,
    location: { pathname },
    fetch: async url => {
      fetched.push(url);
      if (!Object.hasOwn(subtitles, url)) return { ok: false, status: 404 };
      return { ok: true, status: 200, text: async () => subtitles[url] };
    },
    netflix: player && { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
      getAllPlayerSessionIds: () => ["old", "current"],
      getVideoPlayerBySessionId: id => (id === "current" ? player : null),
    } }) } } } },
  });
  context.window = context;
  // Values the page builds, with the page's own Array and Object.
  const evaluate = code => vm.runInContext(code, context);
  const original = { stringify: evaluate("JSON.stringify"), parse: evaluate("JSON.parse") };
  vm.runInContext(SOURCE, context);
  const command = message => document.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: JSON.stringify(message) }));
  return { context, evaluate, original, posted, fetched, command };
}

const settle = () => new Promise(resolve => { setTimeout(resolve, 0); });

function manifest(textTracks, movieId = 81000001) {
  return JSON.stringify({ version: 2, result: { movieId, textTracks } });
}

const vtt = url => ({ "webvtt-lssdh-ios8": { urls: [{ url }] } });

test("the stringify hook adds the WebVTT profile once and leaves every other value byte-identical", () => {
  const { context, evaluate, original } = page();
  context.request = evaluate('({ url: "/manifest", params: { profiles: ["heaac-2-dash", "playready-h264mpl30-dash"] } })');
  const first = evaluate("JSON.stringify(request)");
  const second = evaluate("JSON.stringify(request)");
  assert.equal(first, '{"url":"/manifest","params":{"profiles":["webvtt-lssdh-ios8","heaac-2-dash","playready-h264mpl30-dash"]}}');
  assert.equal(second, first, "the profile is added only once");
  // A list found by its profile names rather than its key, as Subadub does.
  context.renamed = evaluate('({ a: { b: [["x"], { list: ["simplesdh"] }] } })');
  assert.equal(evaluate("JSON.stringify(renamed)"), '{"a":{"b":[["x"],{"list":["webvtt-lssdh-ios8","simplesdh"]}]}}');
  // Netflix's user profiles are objects, not profile names, and stay as they are.
  for (const code of ['({ profiles: [{ name: "Bee" }] })', '({ profiles: [] })', '"text"', "42", "null",
    '({ when: new Date(0), list: [1, "two", null], nested: { deep: { profiles: ["unknown-profile", 3] } } })',
    "new Uint8Array([1, 2, 3])", '[{ x: undefined, y: () => 1 }]']) {
    context.value = evaluate(code);
    assert.equal(evaluate("JSON.stringify(value)"), original.stringify(context.value), code);
    assert.equal(evaluate('JSON.stringify(value, null, 2)'), original.stringify(context.value, null, 2), code);
  }
  // A cyclic value still reaches JSON.stringify's own TypeError, and an
  // inspection failure becomes the error Netflix would have had anyway.
  context.cyclic = evaluate("(() => { const value = { profiles: [] }; value.self = value; return value; })()");
  assert.throws(() => evaluate("JSON.stringify(cyclic)"), error => error.name === "TypeError" && /circular/iu.test(error.message));
  context.throwing = evaluate('({ get boom() { throw new Error("getter failed"); } })');
  assert.throws(() => evaluate("JSON.stringify(throwing)"), /getter failed/u);
});

test("the parse hook keeps Japanese text tracks only, fetches them and posts plain data", async () => {
  const subtitles = { "https://cdn.test/ja.vtt": "WEBVTT\n", "https://cdn.test/ja-cc.xml": "<tt/>" };
  const { evaluate, original, posted, fetched, context } = page({ subtitles });
  context.text = manifest([
    { id: "forced", language: "ja", isForcedNarrative: true, downloadables: vtt("https://cdn.test/forced.vtt") },
    { id: "off", language: "ja", isNoneTrack: true, downloadables: vtt("https://cdn.test/off.vtt") },
    { id: "image", language: "ja", isImageBased: true, downloadables: vtt("https://cdn.test/image.vtt") },
    { id: "en", language: "en", downloadables: vtt("https://cdn.test/en.vtt") },
    { id: "ja", language: "ja", rawTrackType: "subtitles", downloadables: vtt("https://cdn.test/ja.vtt") },
    { trackId: 7, bcp47: "ja-JP", rawTrackType: "CLOSEDCAPTIONS",
      downloadables: { "dfxp-ls-sdh": { urls: { cdn1: "https://cdn.test/ja-cc.xml" } } } },
  ]);
  assert.deepEqual(evaluate("JSON.parse(text)"), original.parse(context.text), "Netflix gets its value unchanged");
  await settle();
  assert.deepEqual(fetched, ["https://cdn.test/ja.vtt", "https://cdn.test/ja-cc.xml"]);
  assert.deepEqual(posted, [
    { kind: "subtitle", movieId: "81000001", trackId: "ja", closedCaptions: false, format: "webvtt", text: "WEBVTT\n" },
    { kind: "subtitle", movieId: "81000001", trackId: "7", closedCaptions: true, format: "ttml", text: "<tt/>" },
  ]);
  // Unrelated parses neither fetch nor post.
  for (const text of ['{"result":{"movieId":1}}', '{"textTracks":[]}', "[1,2]", '"result"', "null"]) {
    context.text = text;
    assert.deepEqual(evaluate("JSON.parse(text)"), original.parse(text));
  }
  await settle();
  assert.equal(fetched.length, 2);
  assert.equal(posted.length, 2);
});

test("the page reports image-only, missing and unreadable Japanese subtitles and ignores previews", async () => {
  const report = async (tracks, options) => {
    const { context, evaluate, posted, fetched } = page(options);
    context.text = manifest(tracks);
    evaluate("JSON.parse(text)");
    await settle();
    return { posted, fetched };
  };
  assert.deepEqual((await report([{ language: "ja", isImageBased: true, downloadables: {} }])).posted,
    [{ kind: "status", movieId: "81000001", subtitles: "image" }]);
  assert.deepEqual((await report([{ language: "en", downloadables: vtt("https://cdn.test/en.vtt") }])).posted,
    [{ kind: "status", movieId: "81000001", subtitles: "none" }]);
  assert.deepEqual((await report([{ id: "ja", language: "ja", downloadables: vtt("https://cdn.test/missing.vtt") }])).posted,
    [{ kind: "status", movieId: "81000001", subtitles: "failed" }]);
  // Browse pages play previews; their manifests fetch nothing.
  const preview = await report([{ id: "ja", language: "ja", downloadables: vtt("https://cdn.test/ja.vtt") }],
    { pathname: "/browse" });
  assert.deepEqual(preview, { posted: [], fetched: [] });
});

test("a reader that missed the subtitles can ask for them again", async () => {
  const { context, evaluate, posted, command } = page({ subtitles: { "https://cdn.test/ja.vtt": "WEBVTT\n" } });
  context.text = manifest([{ id: "ja", language: "ja", downloadables: vtt("https://cdn.test/ja.vtt") }]);
  evaluate("JSON.parse(text)");
  await settle();
  posted.length = 0;
  command({ type: "resend", movieId: "81000001" });
  command({ type: "resend", movieId: "99" });
  assert.deepEqual(posted, [{ kind: "subtitle", movieId: "81000001", trackId: "ja", closedCaptions: false,
    format: "webvtt", text: "WEBVTT\n" }]);
});

// A <video> whose time advances while playing, which a write to currentTime
// would fail (Netflix stops with M7375), and a Netflix player that seeks it.
function playerFixture({ startMs = 7000, paused = true, rate = 1.5 } = {}) {
  const calls = [];
  const video = new EventTarget();
  let mediaMs = startMs, playingSince = null;
  const now = () => performance.now();
  Object.defineProperties(video, {
    currentTime: {
      get: () => (mediaMs + (playingSince === null ? 0 : now() - playingSince)) / 1000,
      set: () => { throw new Error("currentTime was written"); },
    },
    paused: { get: () => playingSince === null },
  });
  Object.assign(video, { seeking: false, ended: false, playbackRate: rate });
  const pause = () => {
    if (playingSince !== null) mediaMs += now() - playingSince;
    playingSince = null;
  };
  const player = {
    seek(ms) {
      calls.push(["seek", ms]);
      const wasPlaying = playingSince !== null;
      pause();
      mediaMs = ms;
      if (wasPlaying) playingSince = now();
      setTimeout(() => video.dispatchEvent(new Event("seeked")), 1);
    },
    play() { calls.push(["play", video.playbackRate]); if (playingSince === null) playingSince = now(); },
    pause() { calls.push(["pause"]); pause(); },
    getCurrentTime: () => video.currentTime * 1000,
  };
  if (!paused) playingSince = now();
  return { calls, video, player };
}

async function replayed(posted) {
  for (let attempt = 0; attempt < 400 && !posted.some(message => message.kind === "replay"); attempt++) {
    await new Promise(resolve => { setTimeout(resolve, 5); });
  }
  return posted.find(message => message.kind === "replay");
}

test("a replay plays the cue at 1× through Netflix's player and restores the viewer's position, pause and speed", async () => {
  const { calls, video, player } = playerFixture();
  const { posted, command } = page({ player, video });
  command({ type: "replay", id: "r1", startMs: 1000, endMs: 1100, padMs: 50 });
  const reply = await replayed(posted);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.id, "r1");
  assert.deepEqual(calls[0], ["seek", 950], "the replay starts one pad before the cue");
  assert.deepEqual(calls[1], ["play", 1], "the line plays at 1×");
  const restored = calls.slice(2);
  assert.deepEqual(restored.map(([name]) => name), ["pause", "seek"]);
  assert.ok(Math.abs(restored[1][1] - 7000) < 1, "playback returns to where the viewer was");
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.paused, true);
  // Every pair is (wall clock, media time) at 1×, from the clip's start to its end.
  assert.ok(reply.anchors.length > 0);
  const offsets = reply.anchors.map(([wall, media]) => wall - media);
  assert.ok(Math.max(...offsets) - Math.min(...offsets) < 40, JSON.stringify(offsets));
  assert.ok(reply.anchors.at(-1)[1] >= 1100);
});

test("a replay of a playing video resumes it, and a page without the player or a second replay is refused", async () => {
  const { calls, video, player } = playerFixture({ paused: false, rate: 1 });
  const { posted, command } = page({ player, video });
  command({ type: "replay", id: "r1", startMs: 500, endMs: 550, padMs: 25 });
  command({ type: "replay", id: "r2", startMs: 500, endMs: 550, padMs: 25 });
  const busy = await replayed(posted);
  assert.deepEqual(busy, { kind: "replay", id: "r2", ok: false, error: "busy" });
  for (let attempt = 0; attempt < 400 && posted.length < 2; attempt++) await new Promise(resolve => { setTimeout(resolve, 5); });
  assert.equal(posted[1].ok, true);
  assert.deepEqual(calls.at(-1)[0], "play", "a video that was playing plays on");
  assert.equal(video.paused, false);

  const missing = page({ video });
  missing.command({ type: "replay", id: "r3", startMs: 0, endMs: 10, padMs: 0 });
  assert.deepEqual(await replayed(missing.posted), { kind: "replay", id: "r3", ok: false, error: "player" });
  // Malformed commands do nothing.
  for (const message of [{ type: "replay", id: 3, startMs: 0, endMs: 1, padMs: 0 },
    { type: "replay", id: "x", startMs: 2, endMs: 1, padMs: 0 }, { type: "unknown" }]) missing.command(message);
  missing.context.document.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: "{not json" }));
  await settle();
  assert.equal(missing.posted.length, 1);
});
