// SPDX-License-Identifier: GPL-3.0-or-later
// YouTube mining's caption timelines: YouTube's json3 files as
// cues (extension/netflix-subtitles.js), from fixtures in test/data/youtube/
// written for these tests in the shape of the files YouTube's player loads.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "../extension/netflix-subtitles.js";

const { cueSentence, matchCue, matchingCues, parseJson3, parseSubtitles } = globalThis.HDNetflixSubtitles;
const fixture = name => readFile(new URL(`data/youtube/${name}`, import.meta.url), "utf8");
const plain = cues => cues.map(({ startMs, endMs, shownUntilMs, text }) => ({ startMs, endMs, text,
  ...(shownUntilMs === undefined ? {} : { shownUntilMs }) }));

test("a typed track's events are cues from their start for their duration, as plain text", async () => {
  const cues = parseSubtitles("json3", await fixture("manual.json"));
  assert.deepEqual(plain(cues), [
    { startMs: 1000, endMs: 3500, text: "今日は駅前の喫茶店で\n友達と待ち合わせをした。" },
    { startMs: 4000, endMs: 6000, text: "雨が降りそうだから" },
    // Segments join; direction marks go; a line break alone is no cue.
    { startMs: 6200, endMs: 8000, text: "傘を持っていこう。" },
    // json3 text is never markup.
    { startMs: 11_000, endMs: 13_000, text: "<i>そうだね</i>" },
  ]);
});

test("an auto-generated line ends where the next line of its window starts, and stays shown until its own end", async () => {
  const cues = parseJson3(await fixture("asr.json"));
  assert.deepEqual(plain(cues), [
    { startMs: 2000, endMs: 4200, shownUntilMs: 7200, text: "えっと今日は朝ごはんを食べてから" },
    { startMs: 4200, endMs: 7200, shownUntilMs: 9200, text: "散歩に行こうと思って" },
    // Nothing follows it in time, so it keeps its own end.
    { startMs: 7200, endMs: 9200, text: "。" },
    { startMs: 20_010, endMs: 23_010, text: "よし" },
  ]);
  // At 6 s the window shows both lines: the earlier one, rolled up, is still
  // matched by its text, and the line being said by the words shown so far.
  const first = matchCue(cues, 6000, "えっと今日は朝ごはんを食べてから");
  assert.deepEqual({ startMs: first.startMs, endMs: first.endMs }, { startMs: 2000, endMs: 4200 });
  assert.equal(matchCue(cues, 6000, "散歩に行こうと")?.startMs, 4200);
  // Once it has rolled out of the window, it is not.
  assert.equal(matchCue(cues, 7800, "えっと今日は朝ごはんを食べてから"), null);
  // A Netflix cue has no shown time, and matches by its own end as before.
  assert.deepEqual(matchingCues([{ startMs: 0, endMs: 1000, text: "はい" }], 1600, "はい"), []);
});

test("a cue's sentence is the whole line, joined as Japanese captions wrap", async () => {
  const [cue] = parseJson3(await fixture("manual.json"));
  assert.deepEqual(cueSentence(cue.text, "友達と待ち合わせをした。", 3),
    { sentence: "今日は駅前の喫茶店で友達と待ち合わせをした。", matchOffset: 13 });
});

test("a file that is not json3 is refused, and odd events are left out", () => {
  for (const source of ["", "WEBVTT\n", "{}", '{"events":{}}', "[1,2]", "null"]) {
    assert.throws(() => parseJson3(source), /not a json3 caption file/u, source);
  }
  const cues = parseJson3(JSON.stringify({ events: [null, 3, { tStartMs: "1", segs: [{ utf8: "a" }] },
    { tStartMs: 5, segs: "text" }, { tStartMs: 7, segs: [{ utf8: 4 }, { utf8: "い" }] },
    { tStartMs: -50, dDurationMs: 100, segs: [{ utf8: "う" }] }, { tStartMs: 9, dDurationMs: Number.NaN, segs: [{}] }] }));
  assert.deepEqual(plain(cues), [{ startMs: 0, endMs: 100, text: "う" }, { startMs: 7, endMs: 7, text: "い" }]);
});
