// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/netflix-audio.js";

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
// subtitle layer, one span per line (synthetic markup). `lineAudio` stands in
// for what netflix-audio.js keeps of the video's sound.
function netflix(t, { movieId = "81000001", lines = ["お前、こんなとこで", "何してんの？"], timeMs = 2000, lineAudio } = {}) {
  const dom = new JSDOM(`<!doctype html><div class="watch-video"><video></video><div class="player-timedtext">
    <div class="player-timedtext-text-container">${lines.map(line => `<span>${line}</span>`).join("<br>")}</div></div></div>`,
  { url: `https://www.netflix.com/watch/${movieId}`, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.chrome = { runtime: { getURL: path => `chrome-extension://hachidori/${path}` } };
  if (lineAudio) window.HDNetflixAudio = { ...globalThis.HDNetflixAudio, createLineAudio: () => lineAudio };
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
    setHoverPause: enabled => api.setHoverPause(enabled),
    setLineAudio: enabled => api.setLineAudio(enabled),
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
    const frames = [...f.window.document.querySelectorAll("iframe")];
    frameDuring.push(frames.map(frame => [frame.src, frame.style.getPropertyValue("display"), frame.getAttribute("aria-hidden")]));
    if (type === "hd_netflix_capture_start") return { sessionId: "s1", padMs: 250 };
    if (type === "hd_netflix_capture_finish") return { audio: { token: "t1", filename: "hachidori-sentence-audio-a.wav" }, gif: null };
    return {};
  };
  const frameDuring = [];
  assert.deepEqual(await f.netflix.record(cue, { send, templateId: "default" }),
    { audio: { token: "t1", filename: "hachidori-sentence-audio-a.wav" }, gif: null });
  // The hidden recorder frame is in the page for the recording only.
  assert.deepEqual(frameDuring, [[["chrome-extension://hachidori/netflix-recorder.html", "none", "true"]],
    [["chrome-extension://hachidori/netflix-recorder.html", "none", "true"]]]);
  assert.equal(f.window.document.querySelectorAll("iframe").length, 0);
  assert.deepEqual(sent, [
    ["hd_netflix_capture_start", { cue, audio: true, gif: false }],
    ["hd_netflix_capture_finish", { sessionId: "s1", anchors: [[5000, 950], [5100, 1050]], templateId: "default" }],
  ]);
  const replay = f.commands.find(command => command.type === "replay");
  assert.deepEqual({ ...replay, id: typeof replay.id }, { type: "replay", id: "string", startMs: 1000, endMs: 3500, padMs: 250,
    keepPaused: false });

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
  assert.equal(f.window.document.querySelectorAll("iframe").length, 0, "a failed start removes the recorder frame");

  // With gif set, the recorder is asked for the video track too, and the GIF
  // the finish returns is passed through beside the audio.
  sent.length = 0;
  replyToReplay = command => ({ kind: "replay", id: command.id, ok: true, anchors: [[5000, 950], [5100, 1050]] });
  const gifSend = async (type, fields) => {
    sent.push([type, JSON.parse(JSON.stringify(fields))]);
    if (type === "hd_netflix_capture_start") return { sessionId: "s2", padMs: 250 };
    if (type === "hd_netflix_capture_finish") return { audio: { token: "t2", filename: "a.wav" }, gif: { token: "g2", filename: "hachidori-gif-a.gif" } };
    return {};
  };
  assert.deepEqual(await f.netflix.record(cue, { send: gifSend, templateId: "default", gif: true }),
    { audio: { token: "t2", filename: "a.wav" }, gif: { token: "g2", filename: "hachidori-gif-a.gif" } });
  assert.deepEqual(sent[0], ["hd_netflix_capture_start", { cue, audio: true, gif: true }]);
  // A {gif} field alone asks the recorder for no WAV.
  sent.length = 0;
  await f.netflix.record(cue, { send: gifSend, templateId: "default", audio: false, gif: true });
  assert.deepEqual(sent[0], ["hd_netflix_capture_start", { cue, audio: false, gif: true }]);
});

// What netflix-audio.js keeps, scripted: `heard` answers each clip in turn
// (null when the line was not all heard), `covers` whether a span was heard.
function heardAudio({ ready = true, heard = [], covers = () => false } = {}) {
  const calls = [];
  const clips = [...heard];
  return { calls, lineAudio: {
    start() { calls.push("start"); },
    stop() { calls.push("stop"); },
    ready: () => ready,
    covers(movieId, from, to) { calls.push(["covers", movieId, from, to]); return covers(from, to); },
    clip(movieId, from, to) { calls.push(["clip", movieId, from, to]); return clips.length > 1 ? clips.shift() : clips[0] ?? null; },
    async settled() { calls.push("settled"); },
  } };
}
const LINE = { samples: Float32Array.from({ length: 480 }, (_, index) => Math.sin(index / 5)), sampleRate: 48_000 };

// The page's side of a replay: answers each replay command as it comes.
function answerReplays(f, answer = command => ({ kind: "replay", id: command.id, ok: true, anchors: [[5000, 950]] })) {
  const replays = [];
  f.window.document.addEventListener(COMMAND_EVENT, event => {
    const command = JSON.parse(event.detail);
    if (command.type !== "replay") return;
    replays.push(command);
    setTimeout(() => f.post(answer(command)), 0);
  });
  return replays;
}

test("a line the viewer heard is cut from what was kept: no replay, recorder frame or tab capture", async t => {
  const audio = heardAudio({ heard: [LINE] });
  const f = netflix(t, { lineAudio: audio.lineAudio });
  const replays = answerReplays(f);
  f.netflix.setLineAudio(true);
  const cue = { movieId: "81000001", startMs: 1000, endMs: 3500 };
  const sent = [];
  let concealed = 0;
  const send = async (type, fields) => {
    sent.push([type, fields]);
    assert.equal(f.window.document.querySelectorAll("iframe").length, 0, "no recorder frame");
    return { type: `${type}_result`, ok: true, token: "t1", filename: "hachidori-sentence-audio-a.wav" };
  };
  const conceal = during => { concealed += 1; return during(); };
  assert.deepEqual(await f.netflix.record(cue, { send, templateId: "default", conceal }),
    { audio: { token: "t1", filename: "hachidori-sentence-audio-a.wav" } });
  assert.deepEqual(audio.calls, ["start", "settled", ["clip", "81000001", 750, 3750]]);
  assert.deepEqual(sent.map(([type, fields]) => [type, fields.templateId]), [["hd_netflix_line_audio", "default"]]);
  assert.deepEqual(Buffer.from(sent[0][1].data, "base64"), Buffer.from(globalThis.HDNetflixAudio.encodeMonoWav(LINE.samples, 48_000)));
  assert.equal(replays.length, 0);
  assert.equal(concealed, 0, "nothing is captured, so the reader stays visible");

  // Exact zeros are silence, and nothing is sent; a linked worker holds nothing.
  const silent = heardAudio({ heard: [{ samples: new Float32Array(480), sampleRate: 48_000 }] });
  const quiet = netflix(t, { lineAudio: silent.lineAudio });
  quiet.netflix.setLineAudio(true);
  sent.length = 0;
  assert.deepEqual(await quiet.netflix.record(cue, { send, templateId: "default" }), { audio: { unavailable: "silent" } });
  assert.equal(sent.length, 0);
  assert.deepEqual(await f.netflix.record(cue, { send: async () => ({ unavailable: "linked" }), templateId: "default" }),
    { audio: { unavailable: "linked" } });
  // The switch off stops it.
  f.netflix.setLineAudio(false);
  assert.equal(audio.calls.at(-1), "stop");
});

test("a line stopped partway plays on from where it stands, and one not heard replays audibly", async t => {
  const cue = { movieId: "81000001", startMs: 1000, endMs: 3500 };
  const send = async () => ({ token: "t1", filename: "a.wav" });
  // Paused at 2000 ms, inside the line, with its start heard: the page plays on.
  const partway = heardAudio({ heard: [null, LINE], covers: (from, to) => from === 750 && to === 2000 });
  const f = netflix(t, { lineAudio: partway.lineAudio });
  const replays = answerReplays(f);
  f.netflix.setLineAudio(true);
  assert.deepEqual(await f.netflix.record(cue, { send, templateId: "default" }), { audio: { token: "t1", filename: "a.wav" } });
  assert.deepEqual(replays.map(({ id, ...command }) => command),
    [{ type: "replay", startMs: 1000, endMs: 3500, padMs: 250, keepPaused: false, playOn: true }]);
  assert.deepEqual(partway.calls.filter(call => call !== "settled"), ["start", ["clip", "81000001", 750, 3750],
    ["covers", "81000001", 750, 2000], ["clip", "81000001", 750, 3750]]);

  // The start not heard, or the video past the line: the whole line is replayed.
  const unheard = heardAudio({ heard: [null, LINE] });
  const g = netflix(t, { lineAudio: unheard.lineAudio });
  const replayed = answerReplays(g);
  g.netflix.setLineAudio(true);
  await g.netflix.record(cue, { send, templateId: "default" });
  const past = heardAudio({ heard: [null, LINE], covers: () => true });
  const p = netflix(t, { lineAudio: past.lineAudio, timeMs: 9000 });
  const pastReplays = answerReplays(p);
  p.netflix.setLineAudio(true);
  await p.netflix.record(cue, { send, templateId: "default" });
  assert.deepEqual([...replayed, ...pastReplays].map(command => command.playOn), [undefined, undefined]);

  // A replay Netflix's player refuses, or one that leaves the line unheard, says so.
  const refused = heardAudio({ heard: [null] });
  const h = netflix(t, { lineAudio: refused.lineAudio });
  answerReplays(h, command => ({ kind: "replay", id: command.id, ok: false, error: "player" }));
  h.netflix.setLineAudio(true);
  assert.deepEqual(await h.netflix.record(cue, { send, templateId: "default" }), { audio: { unavailable: "player" } });
  const missed = heardAudio({ heard: [null] });
  const m = netflix(t, { lineAudio: missed.lineAudio });
  answerReplays(m);
  m.netflix.setLineAudio(true);
  assert.deepEqual(await m.netflix.record(cue, { send, templateId: "default" }), { audio: { unavailable: "unheard" } });
  // Not keeping the video's sound yet, the tab recorder records the line as before.
  const idle = heardAudio({ ready: false });
  const i = netflix(t, { lineAudio: idle.lineAudio });
  idle.lineAudio.ready = () => false;
  const types = [];
  await i.netflix.record(cue, { send: async (type, fields) => { types.push([type, fields.audio]); return { unavailable: "grant" }; },
    templateId: "default" });
  assert.deepEqual(types, [["hd_netflix_capture_start", true]]);
});

test("a {gif} field records with tab capture concealed, and its sentence audio comes from what was kept", async t => {
  const cue = { movieId: "81000001", startMs: 1000, endMs: 3500 };
  // The GIF's replay plays the line, so the line audio has it afterwards.
  const audio = heardAudio({ heard: [null, LINE] });
  const f = netflix(t, { lineAudio: audio.lineAudio });
  const replays = answerReplays(f);
  f.netflix.setLineAudio(true);
  const sent = [];
  let hidden = false;
  const send = async (type, fields) => {
    sent.push([type, fields.audio, fields.gif, hidden]);
    if (type === "hd_netflix_capture_start") return { sessionId: "s1", padMs: 250 };
    if (type === "hd_netflix_capture_finish") return { audio: null, gif: { token: "g1", filename: "hachidori-gif-a.gif" } };
    return { token: "t1", filename: "a.wav" };
  };
  const conceal = async during => {
    hidden = true;
    try {
      return await during();
    } finally {
      hidden = false;
    }
  };
  assert.deepEqual(await f.netflix.record(cue, { send, templateId: "default", gif: true, conceal }), {
    gif: { token: "g1", filename: "hachidori-gif-a.gif" }, audio: { token: "t1", filename: "a.wav" } });
  // Concealed for the tab capture only.
  assert.deepEqual(sent, [["hd_netflix_capture_start", false, true, true], ["hd_netflix_capture_finish", undefined, undefined, true],
    ["hd_netflix_line_audio", undefined, undefined, false]]);
  assert.equal(replays.length, 1, "one replay records both");

  // Without a capture grant the GIF says why, and the line still plays for its audio.
  const ungranted = heardAudio({ heard: [null, null, LINE] });
  const g = netflix(t, { lineAudio: ungranted.lineAudio });
  const replayed = answerReplays(g);
  g.netflix.setLineAudio(true);
  const grantless = async type => (type === "hd_netflix_capture_start" ? { unavailable: "grant" } : { token: "t2", filename: "b.wav" });
  assert.deepEqual(await g.netflix.record(cue, { send: grantless, templateId: "default", gif: true }), {
    gif: { unavailable: "grant" }, audio: { token: "t2", filename: "b.wav" } });
  assert.equal(replayed.length, 1);

  // A GIF recording the worker refuses outright costs only the GIF.
  const refused = heardAudio({ heard: [null, null, LINE] });
  const h = netflix(t, { lineAudio: refused.lineAudio });
  const played = answerReplays(h);
  h.netflix.setLineAudio(true);
  const inactive = async type => {
    if (type === "hd_netflix_capture_start") throw new Error("The Netflix tab is no longer the active tab.");
    return { token: "t3", filename: "c.wav" };
  };
  assert.deepEqual(await h.netflix.record(cue, { send: inactive, templateId: "default", gif: true }), {
    gif: { unavailable: "The Netflix tab is no longer the active tab." }, audio: { token: "t3", filename: "c.wav" } });
  assert.equal(played.length, 1, "the line still plays for its audio");
});

// Where the fixture's two lines are drawn: a gap between them, inside
// Netflix's subtitle layer that spans the player.
const LINE_RECTS = [{ left: 400, top: 560, right: 800, bottom: 600 }, { left: 460, top: 604, right: 740, bottom: 644 }];
const ON_LINE = [600, 580];
const BETWEEN_LINES = [600, 602];
const AWAY = [600, 300];
const settle = () => new Promise(resolve => { setTimeout(resolve, 0); });

// A playing video whose lines are laid out at LINE_RECTS, and a page that
// pauses and plays it on command as Netflix's player does: the element's state
// changes at once and its event follows.
function playing(t, options) {
  const f = netflix(t, options);
  const { window, video } = f;
  let paused = false;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  const rects = new Map(f.spans().map((span, index) => [span.firstChild, [LINE_RECTS[index]]]));
  window.Range.prototype.getClientRects = function getClientRects() { return rects.get(this.startContainer) ?? []; };
  const fire = type => video.dispatchEvent(new window.Event(type));
  // What the viewer, or a replay, does to the element.
  const media = type => {
    if (type === "play" || type === "pause") paused = type === "pause";
    fire(type);
  };
  window.document.addEventListener(COMMAND_EVENT, event => {
    const { type } = JSON.parse(event.detail);
    if (type !== "pause" && type !== "resume") return;
    paused = type === "pause";
    setTimeout(() => fire(paused ? "pause" : "play"), 0);
  });
  const move = ([clientX, clientY]) => window.document.body.dispatchEvent(new window.MouseEvent("mousemove",
    { bubbles: true, clientX, clientY }));
  const popup = shown => window.dispatchEvent(new window.CustomEvent(shown ? "hachidori-popup-shown" : "hachidori-popup-hidden"));
  const hoverCommands = () => f.commands.filter(command => command.type === "pause" || command.type === "resume")
    .map(command => command.type);
  return { ...f, fire, media, move, popup, hoverCommands, paused: () => paused, setPaused: value => { paused = value; },
    layout: (node, rect) => rects.set(node, [rect]) };
}

// Mines the line as the page replays it: seek and play the clip, let the test
// act while it plays, then restore the video's paused state (paused when the
// reader asks to keep it so) and answer. The restore's events report
// themselves after the answer, as the element's do. `finishing` runs when the
// reader asks the worker to finish, while the recorder still runs. Resolves
// with the replay command.
async function mine(f, { during = () => {}, finishing = () => {} } = {}) {
  let replay = null;
  const replayPage = event => {
    const command = JSON.parse(event.detail);
    if (command.type !== "replay") return;
    replay = command;
    const playOn = !f.paused() && command.keepPaused !== true;
    setTimeout(() => {
      f.media("seeking");
      f.media("seeked");
      f.media("play");
      during();
      f.setPaused(!playOn);
      f.post({ kind: "replay", id: command.id, ok: true, anchors: [[5000, 950], [5100, 1050]] });
      setTimeout(() => { for (const type of ["pause", "seeking", "seeked", ...(playOn ? ["play"] : [])]) f.fire(type); }, 0);
    }, 0);
  };
  f.window.document.addEventListener(COMMAND_EVENT, replayPage);
  const send = async type => {
    if (type === "hd_netflix_capture_start") return { sessionId: "s1", padMs: 250 };
    finishing();
    return { token: "t1", filename: "hachidori-sentence-audio-a.wav" };
  };
  try {
    await f.netflix.record({ movieId: "81000001", startMs: 1000, endMs: 3500 }, { send, templateId: "default" });
    return replay;
  } finally {
    f.window.document.removeEventListener(COMMAND_EVENT, replayPage);
    await settle();
  }
}

test("hovering a playing subtitle pauses it until the pointer has left the line and the popup", async t => {
  const f = playing(t);
  // A second box at the top of the picture: each box has its own bounds.
  const top = f.window.document.createElement("div");
  top.className = "player-timedtext-text-container";
  top.innerHTML = "<span>（ナレーション）</span>";
  f.window.document.querySelector(".player-timedtext").append(top);
  f.layout(top.firstChild.firstChild, { left: 500, top: 40, right: 700, bottom: 80 });
  f.netflix.setHoverPause(true);
  f.move(AWAY);
  f.move(ON_LINE);
  f.move(BETWEEN_LINES);
  assert.deepEqual(f.hoverCommands(), ["pause"], "entering pauses once; the gap between the lines is the subtitle");
  assert.equal(f.paused(), true);
  // The popup, nested ones included, keeps it paused once the pointer has left the line.
  f.popup(true);
  f.move(AWAY);
  await settle();
  assert.deepEqual(f.hoverCommands(), ["pause"]);
  f.popup(false);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume"]);
  assert.equal(f.paused(), false);
  await settle();
  // Without the popup, leaving the line resumes at once.
  f.move(ON_LINE);
  f.move(AWAY);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume", "pause", "resume"]);
  await settle();
  // A video that was already paused is left alone.
  f.media("pause");
  f.move(ON_LINE);
  f.move(AWAY);
  assert.equal(f.hoverCommands().length, 4);

  const empty = playing(t, { lines: [] });
  empty.netflix.setHoverPause(true);
  for (const point of [AWAY, ON_LINE, BETWEEN_LINES, AWAY]) empty.move(point);
  assert.deepEqual(empty.hoverCommands(), [], "an empty subtitle layer pauses nothing");
});

test("what the viewer plays, pauses or seeks while hovering is left as the viewer left it", async t => {
  const takeOvers = {
    play: f => f.media("play"),
    "play then pause": f => { f.media("play"); f.media("pause"); },
    seek: f => { f.media("seeking"); f.media("seeked"); },
  };
  for (const [name, takeOver] of Object.entries(takeOvers)) {
    const f = playing(t);
    f.netflix.setHoverPause(true);
    f.move(ON_LINE);
    await settle();
    takeOver(f);
    f.move(BETWEEN_LINES);
    f.move(AWAY);
    assert.deepEqual(f.hoverCommands(), ["pause"], name);
  }
});

test("a replay is never paused or resumed, and the hover pause it interrupted still resumes", async t => {
  // The viewer's own pause: entering the line during the replay's playback pauses nothing.
  const viewer = playing(t);
  viewer.netflix.setHoverPause(true);
  viewer.media("pause");
  viewer.move(ON_LINE);
  await mine(viewer, { during: () => {
    viewer.move(AWAY);
    viewer.move(ON_LINE);
    viewer.move(AWAY);
  } });
  assert.deepEqual(viewer.hoverCommands(), []);
  assert.equal(viewer.paused(), true);

  // Neither the replay's own play and seeks nor its seek back undo the hover pause.
  const held = playing(t);
  held.netflix.setHoverPause(true);
  held.move(ON_LINE);
  held.popup(true);
  held.move(AWAY);
  await mine(held);
  assert.deepEqual(held.hoverCommands(), ["pause"]);
  held.popup(false);
  assert.deepEqual(held.hoverCommands(), ["pause", "resume"]);

  // Leaving while the line is recorded resumes once the recorder has stopped:
  // Chrome mutes the tab until then.
  const left = playing(t);
  left.netflix.setHoverPause(true);
  left.move(ON_LINE);
  left.popup(true);
  await mine(left, {
    during: () => {
      left.popup(false);
      left.move(AWAY);
      assert.deepEqual(left.hoverCommands(), ["pause"], "nothing resumes during the replay");
    },
    finishing: () => {
      // The replay has answered; the recorder still runs.
      left.move(ON_LINE);
      left.move(AWAY);
      assert.deepEqual(left.hoverCommands(), ["pause"], "nothing resumes while the recorder runs");
    },
  });
  assert.deepEqual(left.hoverCommands(), ["pause", "resume"]);
});

test("mining leaves the video paused until the recording is over and the pointer has left, even if the viewer played it", async t => {
  const f = playing(t);
  f.netflix.setHoverPause(true);
  f.move(ON_LINE);
  await settle();
  f.media("play");
  f.popup(true);
  assert.equal((await mine(f)).keepPaused, true, "the page is asked to restore the video paused");
  assert.equal(f.paused(), true);
  f.move(AWAY);
  assert.deepEqual(f.hoverCommands(), ["pause"], "the popup still holds it");
  f.popup(false);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume"]);
  await settle();
  // Mined with the pointer away, it plays on once the recorder has stopped, not before.
  await mine(f, { finishing: () => assert.deepEqual(f.hoverCommands(), ["pause", "resume"]) });
  assert.deepEqual(f.hoverCommands(), ["pause", "resume", "resume"]);
  assert.equal(f.paused(), false);
  await settle();
  // Without hover pause, the replay restores the viewer's state as it was.
  f.netflix.setHoverPause(false);
  assert.equal((await mine(f)).keepPaused, false);
  assert.equal(f.paused(), false);
  assert.equal(f.hoverCommands().length, 3);
});

test("a line played on stays paused at its end until the pointer leaves, and seeks nowhere", async t => {
  const cue = { movieId: "81000001", startMs: 1000, endMs: 3500 };
  const send = async () => ({ token: "t1", filename: "a.wav" });
  const playOn = f => f.window.document.addEventListener(COMMAND_EVENT, event => {
    const command = JSON.parse(event.detail);
    if (command.type !== "replay") return;
    assert.equal(command.playOn, true);
    // The page plays the rest of the line and pauses at its end.
    setTimeout(() => {
      f.media("play");
      f.media("pause");
      f.post({ kind: "replay", id: command.id, ok: true, anchors: [] });
    }, 0);
  });
  const f = playing(t, { lineAudio: heardAudio({ heard: [null, LINE], covers: () => true }).lineAudio });
  f.netflix.setHoverPause(true);
  f.netflix.setLineAudio(true);
  playOn(f);
  f.move(ON_LINE);
  f.popup(true);
  await f.netflix.record(cue, { send, templateId: "default" });
  assert.deepEqual(f.hoverCommands(), ["pause"], "nothing resumes while the popup is open");
  f.move(AWAY);
  f.popup(false);
  assert.deepEqual(f.hoverCommands(), ["pause", "resume"], "leaving resumes the video at the line's end");
  await settle();

  // Nothing waits for a seek back: the viewer's next seek takes the pause over.
  const g = playing(t, { lineAudio: heardAudio({ heard: [null, LINE], covers: () => true }).lineAudio });
  g.netflix.setHoverPause(true);
  g.netflix.setLineAudio(true);
  playOn(g);
  g.move(ON_LINE);
  g.popup(true);
  await g.netflix.record(cue, { send, templateId: "default" });
  g.media("seeking");
  g.media("seeked");
  g.move(AWAY);
  g.popup(false);
  assert.deepEqual(g.hoverCommands(), ["pause"]);
});

test("a new /watch/ page drops the resume, and nothing pauses while the reader has hover pause off", async t => {
  const f = playing(t);
  f.move(ON_LINE);
  f.move(AWAY);
  assert.deepEqual(f.hoverCommands(), [], "off until the reader turns it on");
  f.netflix.setHoverPause(true);
  f.move(ON_LINE);
  f.navigate("/watch/81000002");
  f.move(AWAY);
  assert.deepEqual(f.hoverCommands(), ["pause"], "the next episode is not resumed");
  await settle();
  f.media("play");
  f.move(ON_LINE);
  assert.deepEqual(f.hoverCommands(), ["pause", "pause"]);
  // Nor when the popup that held the pause closes on the next episode.
  f.popup(true);
  f.move(AWAY);
  f.navigate("/watch/81000003");
  f.popup(false);
  assert.deepEqual(f.hoverCommands(), ["pause", "pause"]);
  await settle();
  f.media("play");
  f.move(ON_LINE);
  assert.deepEqual(f.hoverCommands(), ["pause", "pause", "pause"]);
  // Turned off with its pause in force, it resumes nothing and pauses nothing.
  f.netflix.setHoverPause(false);
  f.popup(true);
  f.popup(false);
  f.move(AWAY);
  f.media("play");
  f.move(ON_LINE);
  f.move(AWAY);
  assert.deepEqual(f.hoverCommands(), ["pause", "pause", "pause"]);
  // Back on, the next line entered pauses again.
  f.netflix.setHoverPause(true);
  f.move(ON_LINE);
  assert.deepEqual(f.hoverCommands(), ["pause", "pause", "pause", "pause"]);
});
