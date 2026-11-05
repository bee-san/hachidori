// SPDX-License-Identifier: GPL-3.0-or-later
// Experimental YouTube mining, the page's side: the video-site page script
// (extension/netflix-page.js) on www.youtube.com, in a main world with only
// what it touches there: XMLHttpRequest, the page's JSON, location, the
// document's events and YouTube's player element.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SOURCE = await readFile(new URL("../extension/netflix-page.js", import.meta.url), "utf8");
const PAGE_EVENT = "hachidori-youtube-page";
const COMMAND_EVENT = "hachidori-youtube-command";
const VIDEO = "Ab3dEf6hI9k";
const NEXT = "Zz9yX8wV7u_";
const JSON3 = '{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"はい"}]}]}';
const timedtext = query => `https://www.youtube.com/api/timedtext?${query}&pot=token&c=WEB`;

// The player's XMLHttpRequest: open() records the address, respond() delivers
// a response as the network would.
class FakeRequest extends EventTarget {
  open(method, url) { this.url = url; }
  respond(status, text, responseType = "") {
    Object.assign(this, { status, responseType, responseText: text });
    this.dispatchEvent(new Event("load"));
  }
}

// `player` is YouTube's #movie_player element: its video data, its methods and
// its classes; `video` the <video> inside it.
function page({ player = null, video = null } = {}) {
  const document = new EventTarget();
  document.getElementById = id => (id === "movie_player" ? player : null);
  document.querySelector = selector => (selector.startsWith("#movie_player video") ? video : null);
  const posted = [];
  document.addEventListener(PAGE_EVENT, event => posted.push(JSON.parse(event.detail)));
  // The script's capture listeners, which media events reach from the element
  // they are dispatched on (an EventTarget here has no tree to bubble through).
  const capturing = [];
  const listen = document.addEventListener.bind(document);
  document.addEventListener = (type, listener, options) => {
    if (options === true) capturing.push([type, listener]);
    return listen(type, listener, options);
  };
  // Each page's own class, so one page's hook never sees another's requests.
  const Request = class extends FakeRequest {};
  const fetched = [];
  const context = vm.createContext({ document, CustomEvent, EventTarget, Event, URL, Promise, Reflect, performance,
    setTimeout, clearTimeout, setInterval, clearInterval, XMLHttpRequest: Request,
    fetch: async url => { fetched.push(url); throw new Error("YouTube's page script fetches nothing"); },
    location: { href: `https://www.youtube.com/watch?v=${VIDEO}`, origin: "https://www.youtube.com", hostname: "www.youtube.com",
      pathname: "/watch", search: `?v=${VIDEO}` } });
  context.window = context;
  vm.runInContext(SOURCE, context);
  const command = message => document.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: JSON.stringify(message) }));
  const load = (url, ...response) => {
    const request = new Request();
    request.open("GET", url, true);
    request.respond(...response);
    return request;
  };
  const mediaEvent = (type, target) => { for (const [name, listener] of capturing) if (name === type) listener({ type, target }); };
  return { context, document, posted, command, load, Request, fetched, mediaEvent };
}

// YouTube's player element with its video data and classes.
function playerElement(data = { video_id: VIDEO, isLive: false }, methods = {}) {
  const classes = new Set();
  return { data, getVideoData() { return this.data; }, classList: { contains: name => classes.has(name), classes }, ...methods };
}

test("each caption file the player loads is posted as the video's track, in its language, and nothing else is read", () => {
  const player = playerElement();
  const { posted, load, Request } = page({ player });
  posted.length = 0;
  load(timedtext(`v=${VIDEO}&lang=ja&fmt=json3`), 200, JSON3);
  load(timedtext(`v=${VIDEO}&lang=en&kind=asr&tlang=ja&fmt=json3`), 200, JSON3);
  assert.deepEqual(posted, [
    { kind: "subtitle", movieId: VIDEO, trackId: "shown", closedCaptions: false, format: "json3", language: "ja", text: JSON3 },
    { kind: "subtitle", movieId: VIDEO, trackId: "shown", closedCaptions: false, format: "json3", language: "ja", text: JSON3 },
  ]);
  posted.length = 0;
  for (const [url, ...response] of [
    [timedtext(`v=${VIDEO}&lang=ja&fmt=srv3`), 200, "<timedtext/>"],
    [timedtext(`v=${VIDEO}&lang=ja`), 200, "<transcript/>"],
    [`https://www.youtube.com/api/stats/playback?v=${VIDEO}&lang=ja&fmt=json3`, 200, JSON3],
    [`https://example.test/api/timedtext?v=${VIDEO}&lang=ja&fmt=json3`, 200, JSON3],
    [timedtext("v=short&lang=ja&fmt=json3"), 200, JSON3],
    [timedtext(`v=${VIDEO}&lang=<b>&fmt=json3`), 200, JSON3],
    // Without its token YouTube answers with an empty file.
    [timedtext(`v=${VIDEO}&lang=ja&fmt=json3`), 200, ""],
    [timedtext(`v=${VIDEO}&lang=ja&fmt=json3`), 403, JSON3],
    [timedtext(`v=${VIDEO}&lang=ja&fmt=json3`), 200, JSON3, "json"],
  ]) load(url, ...response);
  assert.deepEqual(posted, []);
  // The player still gets its own request, opened as it asked.
  const request = new Request();
  request.open("GET", "/youtubei/v1/player", true);
  assert.equal(request.url, "/youtubei/v1/player");
});

test("on YouTube the page script leaves JSON alone, fetches nothing and reads no Netflix command", () => {
  const { context, fetched, posted, command } = page({ player: playerElement() });
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify([String(JSON.stringify), String(JSON.parse)])", context)),
    ["function stringify() { [native code] }", "function parse() { [native code] }"], "JSON is YouTube's own");
  const value = vm.runInContext('JSON.parse(\'{"result":{"movieId":1,"textTracks":[{"language":"ja","downloadables":{}}]}}\')', context);
  assert.equal(value.result.movieId, 1);
  assert.equal(vm.runInContext('JSON.stringify({ params: { profiles: ["heaac-2-dash"] } })', context),
    '{"params":{"profiles":["heaac-2-dash"]}}', "no WebVTT profile is added on YouTube");
  posted.length = 0;
  command({ type: "language", language: "en" });
  assert.deepEqual([fetched, posted], [[], []]);
});

test("the page says which video its player plays, when it changes and when the reader asks", () => {
  const player = playerElement();
  const { document, posted, command } = page({ player });
  assert.deepEqual(posted, [{ kind: "video", movieId: VIDEO }], "the script reports the player it finds");
  document.dispatchEvent(new Event("yt-navigate-finish"));
  assert.equal(posted.length, 1, "nothing changed");
  command({ type: "state" });
  assert.deepEqual(posted.at(-1), { kind: "video", movieId: VIDEO }, "asked, it says so again");
  player.data = { video_id: NEXT, isLive: false };
  document.dispatchEvent(new Event("yt-navigate-finish"));
  assert.deepEqual(posted.at(-1), { kind: "video", movieId: NEXT });
  player.data = { video_id: "not an id" };
  document.dispatchEvent(new Event("yt-player-updated"));
  assert.deepEqual(posted.at(-1), { kind: "video", movieId: null });
  // A page without the player has no video, which it says when asked.
  const empty = page();
  assert.deepEqual(empty.posted, []);
  empty.command({ type: "state" });
  assert.deepEqual(empty.posted, [{ kind: "video", movieId: null }]);
});

test("the page reports the video again on the main video's media events, and not on another element's", () => {
  const video = new EventTarget();
  const player = playerElement();
  const { posted, mediaEvent } = page({ player, video });
  posted.length = 0;
  player.data = { video_id: NEXT, isLive: false };
  mediaEvent("playing", new EventTarget());
  assert.deepEqual(posted, [], "an inline preview's video says nothing of the player's");
  for (const type of ["loadstart", "loadedmetadata", "playing"]) {
    player.data = { video_id: type === "loadstart" ? NEXT : VIDEO, isLive: false };
    mediaEvent(type, video);
  }
  assert.deepEqual(posted, [{ kind: "video", movieId: NEXT }, { kind: "video", movieId: VIDEO }],
    "each change is posted once, on the event that shows it");
});

test("a live stream is reported as such and its captions are not read", () => {
  const player = playerElement({ video_id: VIDEO, isLive: true });
  const { posted, load, command } = page({ player });
  assert.deepEqual(posted, [{ kind: "video", movieId: VIDEO }, { kind: "status", movieId: VIDEO, subtitles: "live" }]);
  load(timedtext(`v=${VIDEO}&lang=ja&fmt=json3`), 200, JSON3);
  assert.equal(posted.length, 2);
  posted.length = 0;
  command({ type: "resend", movieId: VIDEO });
  assert.deepEqual(posted, [{ kind: "status", movieId: VIDEO, subtitles: "live" }]);
});

test("a reader that missed a video's captions can ask again; only the playing and the latest video are kept", () => {
  const player = playerElement();
  const { document, posted, load, command } = page({ player });
  load(timedtext(`v=${VIDEO}&lang=ja&fmt=json3`), 200, JSON3);
  load(timedtext(`v=${VIDEO}&lang=en&fmt=json3`), 200, "{}");
  player.data = { video_id: NEXT };
  document.dispatchEvent(new Event("yt-navigate-finish"));
  load(timedtext(`v=${NEXT}&lang=ja&fmt=json3`), 200, JSON3);
  load(timedtext(`v=${NEXT}&lang=ja&tlang=fr&fmt=json3`), 200, JSON3);
  const third = "Third_video";
  load(timedtext(`v=${third}&lang=ja&fmt=json3`), 200, JSON3);
  posted.length = 0;
  for (const movieId of [VIDEO, NEXT, third]) command({ type: "resend", movieId });
  assert.deepEqual(posted.map(message => [message.movieId, message.language]), [[NEXT, "fr"], [third, "ja"]],
    "the first video is no longer kept, and each video keeps only its latest file");
});

// A <video> whose time advances while it plays, and YouTube's player methods
// that seek, play and pause it, as netflix-page.test.mjs builds Netflix's.
function playerFixture({ startMs = 7000, paused = true, rate = 1.5 } = {}) {
  const calls = [];
  const video = new EventTarget();
  let mediaMs = startMs, playingSince = null, currentRate = rate;
  const now = () => performance.now();
  Object.defineProperties(video, {
    currentTime: { get: () => (mediaMs + (playingSince === null ? 0 : (now() - playingSince) * currentRate)) / 1000 },
    paused: { get: () => playingSince === null },
    playbackRate: { get: () => currentRate, set: value => { calls.push(["element rate", value]); currentRate = value; } },
  });
  Object.assign(video, { seeking: false, ended: false });
  const stop = () => {
    if (playingSince !== null) mediaMs += (now() - playingSince) * currentRate;
    playingSince = null;
  };
  const player = playerElement({ video_id: VIDEO, isLive: false }, {
    seekTo(seconds, allowSeekAhead) {
      calls.push(["seekTo", seconds, allowSeekAhead]);
      const wasPlaying = playingSince !== null;
      stop();
      mediaMs = seconds * 1000;
      if (wasPlaying) playingSince = now();
      setTimeout(() => video.dispatchEvent(new Event("seeked")), 1);
    },
    playVideo() { calls.push(["playVideo", currentRate]); playingSince ??= now(); },
    pauseVideo() { calls.push(["pauseVideo"]); stop(); },
    getCurrentTime: () => video.currentTime,
    getPlaybackRate: () => currentRate,
    setPlaybackRate(value) { calls.push(["setPlaybackRate", value]); stop(); currentRate = value; if (!video.paused) playingSince = now(); },
  });
  if (!paused) playingSince = now();
  return { calls, video, player };
}

async function replied(posted) {
  for (let attempt = 0; attempt < 400 && !posted.some(message => message.kind === "replay"); attempt++) {
    await new Promise(resolve => { setTimeout(resolve, 5); });
  }
  return posted.find(message => message.kind === "replay");
}

test("a replay plays the cue at 1× through YouTube's player and restores the viewer's position, pause and speed", async () => {
  const { calls, video, player } = playerFixture();
  const { posted, command } = page({ player, video });
  command({ type: "replay", id: "r1", startMs: 1000, endMs: 1100, padMs: 50 });
  const reply = await replied(posted);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(calls.slice(0, 3), [["setPlaybackRate", 1], ["seekTo", 0.95, true], ["playVideo", 1]]);
  assert.deepEqual(calls.slice(3).map(([name]) => name), ["pauseVideo", "seekTo", "setPlaybackRate"]);
  assert.ok(Math.abs(calls[4][1] - 7) < 0.01, "playback returns to where the viewer was");
  assert.equal(calls.at(-1)[1], 1.5);
  assert.equal(video.paused, true);
  const offsets = reply.anchors.map(([wall, media]) => wall - media);
  assert.ok(reply.anchors.length > 0 && Math.max(...offsets) - Math.min(...offsets) < 40, JSON.stringify(offsets));
  assert.ok(calls.every(([name]) => name !== "element rate"), "the speed goes through the player");
});

test("a replay is refused while an ad plays, stops when one starts, and needs the player's video", async () => {
  const { calls, video, player } = playerFixture({ paused: false, rate: 1 });
  const { posted, command } = page({ player, video });
  player.classList.classes.add("ad-showing");
  command({ type: "replay", id: "r1", startMs: 1000, endMs: 1100, padMs: 50 });
  assert.deepEqual(await replied(posted), { kind: "replay", id: "r1", ok: false, error: "ad" });
  assert.deepEqual(calls, [], "nothing was touched");
  player.classList.classes.delete("ad-showing");
  posted.length = 0;
  command({ type: "replay", id: "r2", startMs: 1000, endMs: 3000, padMs: 0 });
  setTimeout(() => player.classList.classes.add("ad-showing"), 60);
  assert.deepEqual(await replied(posted), { kind: "replay", id: "r2", ok: false, error: "ad" });
  assert.equal(video.paused, false, "the viewer's playing video plays on");

  const missing = page({ player: playerElement() });
  missing.command({ type: "replay", id: "r3", startMs: 0, endMs: 10, padMs: 0 });
  assert.deepEqual(await replied(missing.posted), { kind: "replay", id: "r3", ok: false, error: "player" });
});

test("pause and resume go through YouTube's player and wait for a replay", async () => {
  const { calls, video, player } = playerFixture({ paused: false, rate: 1 });
  const { posted, command } = page({ player, video });
  command({ type: "pause" });
  command({ type: "resume" });
  assert.deepEqual(calls, [["pauseVideo"], ["playVideo", 1]]);
  calls.length = 0;
  command({ type: "replay", id: "r1", startMs: 7100, endMs: 7150, padMs: 0, playOn: true });
  command({ type: "pause" });
  await replied(posted);
  assert.ok(!calls.some(([name], index) => name === "pauseVideo" && index === 1), JSON.stringify(calls));
  assert.equal(calls.filter(([name]) => name === "seekTo").length, 0, "a line played on is not seeked");
});
