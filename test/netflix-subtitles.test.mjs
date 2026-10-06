// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/netflix-subtitles.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const { DOMParser } = new JSDOM("").window;
const { cueSentence, matchCue, matchingCues, normaliseCueText, parseSubtitles, parseTtml, parseWebVtt } = globalThis.HDNetflixSubtitles;
const fixture = name => readFile(new URL(`data/netflix/${name}`, import.meta.url), "utf8");

// The timeline both synthetic episode files carry.
const EPISODE = [
  { startMs: 1000, endMs: 3500, text: "お前、こんなとこで\n何してんの？" },
  { startMs: 4000, endMs: 5250, text: "散歩してただけだよ" },
  { startMs: 5000, endMs: 7000, text: "（犬の鳴き声）" },
  { startMs: 8000, endMs: 9000, text: "はい" },
  { startMs: 9200, endMs: 10000, text: "はい" },
  { startMs: 62003, endMs: 64500, text: "漢字を読む" },
  { startMs: 3_600_000, endMs: 3_602_000, text: "トム&ジェリー。" },
];

test("WebVTT cues keep exact times and plain text without marks, tags, readings or entities", async () => {
  assert.deepEqual(parseWebVtt(await fixture("episode.vtt")), EPISODE);
  // CRLF, a BOM, a header comment and comma decimals are still WebVTT.
  assert.deepEqual(parseWebVtt("\ufeffWEBVTT - Netflix\r\n\r\n00:01,5 --> 00:02,25\r\n<i>行こう</i>\r\n"),
    [{ startMs: 1500, endMs: 2250, text: "行こう" }]);
  // A cue that ends before it starts, or has no text, is not a line.
  assert.deepEqual(parseWebVtt("WEBVTT\n\n00:00:05.000 --> 00:00:04.000\n逆\n\n00:00:06.000 --> 00:00:07.000\n&lrm;\n"), []);
  // Readings with tags inside them, <rp> parentheses and a stray tag end.
  assert.deepEqual(parseWebVtt("WEBVTT\n\n00:01.000 --> 00:02.000\n<ruby>今日<rp>(</rp><rt><c.r>きょう</c></rt><rp>)</rp></ruby>は<b>晴れ</b>>\n"),
    [{ startMs: 1000, endMs: 2000, text: "今日は晴れ>" }]);
  assert.throws(() => parseWebVtt("1\n00:00:01,000 --> 00:00:02,000\nSRT\n"), /not a WebVTT/u);
});

test("TTML cues read ticks, clock and offset times, dur, line breaks and ruby styles", async () => {
  assert.deepEqual(parseTtml(await fixture("episode.ttml"), { DOMParser }), EPISODE);
  // Frames count against ttp:frameRate, and a container's begin offsets its paragraphs.
  const framed = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25">
    <body><div begin="10s"><p begin="00:00:01:12" end="00:00:02:00">一</p><p begin="2s" end="50f">二</p></div></body></tt>`;
  assert.deepEqual(parseTtml(framed, { DOMParser }), [
    { startMs: 11_480, endMs: 12_000, text: "一" },
    { startMs: 12_000, endMs: 12_000, text: "二" },
  ]);
  // Without a tick rate or frame rate, TTML counts ticks in seconds.
  assert.deepEqual(parseTtml('<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="3t" end="4t">三</p></body></tt>',
    { DOMParser }), [{ startMs: 3000, endMs: 4000, text: "三" }]);
  assert.throws(() => parseTtml("<tt><p>unclosed</tt>", { DOMParser }), /not a TTML/u);
  assert.throws(() => parseTtml("<html></html>", { DOMParser }), /not a TTML/u);
  assert.throws(() => parseTtml("<tt/>", { DOMParser: undefined }), /XML parser/u);
  assert.deepEqual(parseSubtitles("ttml", await fixture("episode.ttml"), { DOMParser }),
    parseSubtitles("webvtt", await fixture("episode.vtt")));
  assert.throws(() => parseSubtitles("srt", ""), /Unsupported subtitle format/u);
});

test("cue text and hovered lines compare without spaces, line breaks or direction marks", () => {
  assert.equal(normaliseCueText("\u200eお前、 こんなとこで\n何してんの？\u3000"), "お前、こんなとこで何してんの？");
  // NFC: a decomposed dakuten matches its composed form.
  assert.equal(normaliseCueText("か\u3099"), "が");
});

test("a hovered line belongs to the one cue active near the video's time that contains it", async () => {
  const cues = parseWebVtt(await fixture("episode.vtt"));
  // The whole two-line container, and either line on its own.
  assert.equal(matchCue(cues, 2000, "お前、こんなとこで何してんの？"), cues[0]);
  assert.equal(matchCue(cues, 2000, "何してんの？"), cues[0]);
  // Within ±500 ms of the cue, but not beyond.
  assert.equal(matchCue(cues, 3999, "何してんの？"), cues[0]);
  assert.equal(matchCue(cues, 4001, "何してんの？"), null);
  assert.equal(matchCue(cues, 500, "お前、"), cues[0]);
  assert.equal(matchCue(cues, 499, "お前、"), null);
  // Overlapping cues are told apart by their text.
  assert.equal(matchCue(cues, 5100, "散歩してただけだよ"), cues[1]);
  assert.equal(matchCue(cues, 5100, "（犬の鳴き声）"), cues[2]);
  // The same line twice within the tolerance is ambiguous.
  assert.equal(matchingCues(cues, 9100, "はい").length, 2);
  assert.equal(matchCue(cues, 9100, "はい"), null);
  assert.equal(matchCue(cues, 8500, "はい"), cues[3]);
  // Nothing to compare, or no video time, matches nothing.
  assert.equal(matchCue(cues, 2000, " \n"), null);
  assert.equal(matchCue(cues, null, "何してんの？"), null);
  assert.equal(matchCue(cues, 2000, "違う台詞"), null);
});

test("the whole cue becomes the sentence with the match where the reader put it", () => {
  const cue = "お前、こんなとこで\n何してんの？";
  assert.deepEqual(cueSentence(cue, "何してんの？", 0), { sentence: "お前、こんなとこで何してんの？", matchOffset: 9 });
  assert.deepEqual(cueSentence(cue, "こんなとこで", 2), { sentence: "お前、こんなとこで何してんの？", matchOffset: 5 });
  // A sentence that is not in the cue exactly once keeps the reader's sentence.
  assert.equal(cueSentence(cue, "どこ？", 0), null);
  assert.equal(cueSentence("はい\nはい", "はい", 0), null);
  assert.equal(cueSentence(cue, "", 0), null);
  assert.equal(cueSentence(cue, "何してんの？", Number.NaN), null);
});
