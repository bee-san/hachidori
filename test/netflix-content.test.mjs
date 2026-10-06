// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const read = path => readFile(new URL(path, import.meta.url), "utf8");
const SCRIPTS = await Promise.all(["../extension/netflix-subtitles.js", "../extension/netflix-content.js"].map(read));
const EPISODE = await read("data/netflix/episode.vtt");
const EPISODE_CC = await read("data/netflix/episode-cc.vtt");
const PAGE_EVENT = "hachidori-netflix-page";
const COMMAND_EVENT = "hachidori-netflix-command";

// Netflix's watch page as the reader sees it: the player's <video> and its
// subtitle layer, one span per line (synthetic markup).
function netflix(t, { movieId = "81000001", lines = ["お前、こんなとこで", "何してんの？"], timeMs = 2000 } = {}) {
  const dom = new JSDOM(`<!doctype html><div class="watch-video"><video></video><div class="player-timedtext">
    <div class="player-timedtext-text-container">${lines.map(line => `<span>${line}</span>`).join("<br>")}</div></div></div>`,
  { url: `https://www.netflix.com/watch/${movieId}`, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  for (const source of SCRIPTS) window.eval(source);
  const video = window.document.querySelector("video");
  Object.defineProperty(video, "currentTime", { value: timeMs / 1000, writable: true });
  const commands = [];
  window.document.addEventListener(COMMAND_EVENT, event => commands.push(JSON.parse(event.detail)));
  const post = message => window.document.dispatchEvent(new window.CustomEvent(PAGE_EVENT,
    { detail: typeof message === "string" ? message : JSON.stringify(message) }));
  const subtitle = (text, extra = {}) => post({ kind: "subtitle", movieId, trackId: "ja", closedCaptions: false,
    format: "webvtt", text, ...extra });
  const spans = () => [...window.document.querySelectorAll(".player-timedtext span")];
  // Values from the page's realm, compared as plain values of this one.
  const plain = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const api = window.HDNetflix;
  const reader = {
    observe: element => plain(api.observe(element)),
    resolve: observation => plain(api.resolve(observation)),
    miningFields: (...args) => plain(api.miningFields(...args)),
    record: async (...args) => plain(await api.record(...args)),
  };
  return { window, netflix: reader, video, commands, post, subtitle, spans,
    navigate: path => window.history.pushState({}, "", path) };
}

const cueOf = result => result.cue && { startMs: result.cue.startMs, endMs: result.cue.endMs, text: result.cue.text };

test("a hovered subtitle line pins its cue and the whole cue becomes the root sentence", t => {
  const f = netflix(t);
  f.subtitle(EPISODE);
  const [, second] = f.spans();
  const observation = f.netflix.observe(second);
  assert.deepEqual(observation, { movieId: "81000001", mediaTimeMs: 2000,
    lineText: "お前、こんなとこで何してんの？", hoveredText: "何してんの？" });
  // The line passing after the popup opened does not move the pin.
  f.video.currentTime = 30;
  assert.deepEqual(cueOf(f.netflix.resolve(observation)), { startMs: 1000, endMs: 3500, text: "お前、こんなとこで\n何してんの？" });
  assert.deepEqual(f.netflix.miningFields(observation, { sentence: "何してんの？", matchOffset: 2 }), {
    netflix: { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } },
    sentence: "お前、こんなとこで何してんの？", matchOffset: 11,
  });
  // A nested lookup inherits the cue and keeps its own sentence.
  assert.deepEqual(f.netflix.miningFields(observation), { netflix: { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } } });
  // A sentence the cue does not hold exactly once stays the reader's.
  assert.deepEqual(f.netflix.miningFields(observation, { sentence: "別の文", matchOffset: 0 }),
    { netflix: { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } } });
  // Text outside Netflix's subtitles is not a Netflix line at all.
  const title = f.window.document.createElement("h1");
  title.textContent = "タイトル";
  f.window.document.body.append(title);
  assert.equal(f.netflix.observe(title), null);
  assert.deepEqual(f.netflix.miningFields(null, { sentence: "タイトル", matchOffset: 0 }), {});
});

test("ruby readings are left out of the hovered line", t => {
  const f = netflix(t, { lines: ["<ruby>漢字<rt>かんじ</rt></ruby>を読む"], timeMs: 63_000 });
  f.subtitle(EPISODE);
  const observation = f.netflix.observe(f.spans()[0]);
  assert.equal(observation.lineText, "漢字を読む");
  assert.deepEqual(cueOf(f.netflix.resolve(observation)), { startMs: 62_003, endMs: 64_500, text: "漢字を読む" });
});

test("a line with no cue, or several, names the reason and missing timing is asked for again", t => {
  const f = netflix(t, { lines: ["はい"], timeMs: 9100 });
  const observation = f.netflix.observe(f.spans()[0]);
  assert.deepEqual(f.netflix.resolve(observation), { reason: "no-timeline" });
  assert.deepEqual(f.netflix.resolve(observation), { reason: "no-timeline" });
  assert.deepEqual(f.commands, [{ type: "resend", movieId: "81000001" }], "the page is asked once per movie");
  f.subtitle(EPISODE);
  assert.deepEqual(f.netflix.miningFields(observation), { netflix: { unavailable: "ambiguous" } });
  f.video.currentTime = 20;
  assert.deepEqual(f.netflix.resolve(f.netflix.observe(f.spans()[0])), { reason: "no-match" });
  // The page's own reasons pass through.
  for (const subtitles of ["image", "none", "failed"]) {
    const other = netflix(t, { movieId: "81000009" });
    other.post({ kind: "status", movieId: "81000009", subtitles });
    assert.deepEqual(other.netflix.resolve(other.netflix.observe(other.spans()[0])), { reason: subtitles });
    assert.deepEqual(other.commands, [], "a movie the page reported on is not asked for again");
  }
});

test("posts from the page are checked before they are used", t => {
  const f = netflix(t);
  const observation = () => f.netflix.observe(f.spans()[1]);
  for (const message of [
    "{not json", "null", "[]", { kind: "subtitle", movieId: 81000001, trackId: "ja", closedCaptions: false, format: "webvtt", text: EPISODE },
    { kind: "subtitle", movieId: "81000001", trackId: "", closedCaptions: false, format: "webvtt", text: EPISODE },
    { kind: "subtitle", movieId: "81000001", trackId: "ja", closedCaptions: "no", format: "webvtt", text: EPISODE },
    { kind: "subtitle", movieId: "81000001", trackId: "ja", closedCaptions: false, format: "srt", text: EPISODE },
    { kind: "subtitle", movieId: "81000001", trackId: "ja", closedCaptions: false, format: "webvtt", text: 3 },
    { kind: "status", movieId: "81000001", subtitles: "maybe" },
    { kind: "unknown", movieId: "81000001" },
  ]) f.post(message);
  f.window.document.dispatchEvent(new f.window.CustomEvent(PAGE_EVENT, { detail: { kind: "subtitle" } }));
  assert.deepEqual(f.netflix.resolve(observation()), { reason: "no-timeline" });
  // A file that does not parse is reported as unreadable rather than thrown.
  f.subtitle("not a subtitle file");
  assert.deepEqual(f.netflix.resolve(observation()), { reason: "failed" });
  f.subtitle(EPISODE);
  assert.equal(f.netflix.resolve(observation()).cue.startMs, 1000);
});

test("a new /watch/ page drops the old timeline, ignores its late posts and keeps the next episode's", t => {
  const f = netflix(t);
  f.subtitle(EPISODE);
  const first = f.netflix.observe(f.spans()[1]);
  assert.equal(f.netflix.resolve(first).cue.startMs, 1000);
  // Netflix prepares the next episode while this one plays.
  f.post({ kind: "subtitle", movieId: "81000002", trackId: "ja", closedCaptions: false, format: "webvtt", text: EPISODE });
  f.navigate("/watch/81000002?trackId=1");
  assert.deepEqual(f.netflix.resolve(first), { reason: "no-timeline" }, "the previous episode's timeline is gone");
  f.subtitle(EPISODE);
  assert.deepEqual(f.netflix.resolve(first), { reason: "no-timeline" }, "a late post for the previous episode is ignored");
  const second = f.netflix.observe(f.spans()[1]);
  assert.equal(second.movieId, "81000002");
  assert.equal(f.netflix.resolve(second).cue.startMs, 1000);
  // Coming back to an episode accepts its posts again.
  f.navigate("/watch/81000001");
  f.subtitle(EPISODE);
  assert.equal(f.netflix.resolve(f.netflix.observe(f.spans()[1])).cue.startMs, 1000);
});

test("with Japanese and Japanese [CC] tracks, the first line found in only one of them chooses it", t => {
  const f = netflix(t);
  f.subtitle(EPISODE);
  f.subtitle(EPISODE_CC, { trackId: "ja-cc", closedCaptions: true });
  // Both tracks hold this line: the plain track answers and nothing is chosen.
  const shared = f.netflix.resolve(f.netflix.observe(f.spans()[1]));
  assert.equal(shared.cue.trackId, "ja");
  // Only the [CC] track has the sound description.
  const [line] = f.spans();
  line.textContent = "（風の音）";
  f.spans()[1].remove();
  f.video.currentTime = 6;
  const description = f.netflix.resolve(f.netflix.observe(line));
  assert.deepEqual({ trackId: description.cue.trackId, startMs: description.cue.startMs }, { trackId: "ja-cc", startMs: 5500 });
  // From now on this episode reads the [CC] track only.
  line.textContent = "（犬の鳴き声）";
  assert.deepEqual(f.netflix.resolve(f.netflix.observe(line)), { reason: "no-match" });
  line.textContent = "何してんの？";
  f.video.currentTime = 2;
  const after = f.netflix.resolve(f.netflix.observe(line));
  assert.deepEqual({ trackId: after.cue.trackId, text: after.cue.text }, { trackId: "ja-cc", text: "（太郎）お前、こんなとこで\n何してんの？" });
});

test("recording starts the capture, has the page replay the cue, then finishes or cancels it", async t => {
  const f = netflix(t);
  const cue = { movieId: "81000001", startMs: 1000, endMs: 3500 };
  const sent = [];
  let replyToReplay = command => ({ kind: "replay", id: command.id, ok: true, anchors: [[5000, 950], [5100, 1050], ["x", 1], [1]] });
  f.window.document.addEventListener(COMMAND_EVENT, event => {
    const command = JSON.parse(event.detail);
    if (command.type === "replay") setTimeout(() => f.post(replyToReplay(command)), 0);
  });
  const send = async (type, fields) => {
    sent.push([type, JSON.parse(JSON.stringify(fields))]);
    if (type === "hd_netflix_capture_start") return { sessionId: "s1", padMs: 250 };
    if (type === "hd_netflix_capture_finish") return { token: "t1", filename: "hachidori-sentence-audio-a.wav" };
    return {};
  };
  assert.deepEqual(await f.netflix.record(cue, { send, templateId: "default" }),
    { token: "t1", filename: "hachidori-sentence-audio-a.wav" });
  assert.deepEqual(sent, [
    ["hd_netflix_capture_start", { cue }],
    ["hd_netflix_capture_finish", { sessionId: "s1", anchors: [[5000, 950], [5100, 1050]], templateId: "default" }],
  ]);
  const replay = f.commands.find(command => command.type === "replay");
  assert.deepEqual({ ...replay, id: typeof replay.id }, { type: "replay", id: "string", startMs: 1000, endMs: 3500, padMs: 250 });

  // A page without Netflix's player cancels the recording.
  sent.length = 0;
  replyToReplay = command => ({ kind: "replay", id: command.id, ok: false, error: "player" });
  assert.deepEqual(await f.netflix.record(cue, { send, templateId: "default" }), { unavailable: "player" });
  assert.deepEqual(sent.map(([type]) => type), ["hd_netflix_capture_start", "hd_netflix_capture_cancel"]);
  assert.deepEqual(sent[1][1], { sessionId: "s1" });

  // The worker's reasons, such as a missing capture grant, are returned as they are.
  sent.length = 0;
  assert.deepEqual(await f.netflix.record(cue, { send: async type => { sent.push(type); return { unavailable: "grant" }; },
    templateId: "default" }), { unavailable: "grant" });
  assert.deepEqual(sent, ["hd_netflix_capture_start"]);
  await assert.rejects(f.netflix.record(cue, { send: async () => ({}), templateId: "default" }), /did not start/u);
});
