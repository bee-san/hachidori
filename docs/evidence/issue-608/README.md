<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Issue #608 evidence: kifuku from a dictionary's word class

No dictionary data is stored here. The scripts read archives downloaded
locally; paths in them are the author's machine.

## Screenshots

`shots.mjs <extension dir> <prefix>` renders the production popup view,
`glossary.js` and `reader.css` of one checkout in headless Chrome 152 with
**Show pitch accent colours** on. Each lookup is a synthetic term in the
engine's reply shape, with the word classes a dictionary gives it and one pitch.
`grid.py` lays out main (`origin/main` 4745397e) above this PR.

![Light palette](issue-608-light.png)

![Default (dark) palette](issue-608-default.png)

## Which dictionaries tag nouns with a verb or adjective class

`survey.py` read the term banks of about 110 archives (MarvNC's collection, the
ixodid collection, the recommended set) and kept only counts and the rules of a
few probe words. None of the recommended dictionaries gives 自由 a class. The
ones that give nouns or na-adjectives a verb or adjective class:

| Dictionary | Rules on nouns and na-adjectives |
|---|---|
| 講談社 日本語大辞典 第二版 (and 双解版) | `adj-i` on na-adjectives: 自由 `adj-i n`, 静か, 綺麗, 好き, 大切 |
| 精選版 日本国語大辞典 (MarvNC's copy) | `vs` on 10,338 headwords that end in neither する nor 為る (料理, 授業, ランク, わくわく) |
| 旺文社標準国語辞典 第八版 | `vs` on 7,398 such headwords, 7,145 of them also `n`, which Yomitan already excludes |
| 漢字源 | `v5` on na-adjectives and nouns: 面倒, 陽気, 嫌, 坐 |

Yomitan d3c54c1 classifies the same way main does:
`getPitchCategory("じゆう", 2, isNonNounVerbOrAdjective(["adj-i", "n"]))` is
`kifuku`.

## Before and after on real data

`dump.py <term dictionaries> <pitch sources> <out.jsonl>` merges each
(expression, reading)'s rules across the term dictionaries, as hoshidicts
does, and keeps the ones with a class and a pitch. `compare.mjs` classifies
every pitch with main's and this PR's `HDGlossary.pitchAccentCategory`. Pitch
sources: NHK2016, 三省堂, 大辞林, 大辞泉 and 新明解 pitch dictionaries, and Kanjium's
`accents.txt`.

| Term dictionaries | Pitches of terms with a class | Changed |
|---|---:|---:|
| Jitendex 2026-10-03 | 15,720 | 0 |
| + JMdict, Bee's Ultimate Grammar, 新明解 8, 三省堂 8, NHK term dictionary | 20,485 | 0 |
| + 精選版 日本国語大辞典, 漢字源 | 30,784 | 3,075 kifuku → positional |
| Jitendex + 講談社 日本語大辞典 | 34,149 | 1,496 kifuku → positional, 自由 [2] → nakadaka |
| Jitendex, JMdict, 新明解 8, 三省堂 8, NHK term dictionary, 精選版, 漢字源, and seven ixodid dictionaries (講談社 日本語大辞典, 旺文社標準国語辞典, 学研 新世紀ビジュアル大辞典 and four 古語 dictionaries) | 93,442 | 2,649 kifuku → positional |

Every change is a kifuku pitch moved to its positional group. The only verbs
and adjectives among them are seven pitches of classical words:

- 得 う [1], the classical verb written in kanji alone. 大修館新全訳古語辞典,
  学研全訳古語辞典 and 旺文社古語辞典 tag it `v1`. JMdict's tag, `v2a-s`, is one
  neither Yomitan nor Hachidori counts, so with JMdict alone it was already
  atamadaka.
- Six classical i-adjectives ending in し, from 古語 and 国語 dictionaries: 遅し,
  いぶせし, 未だし, 愛し かなし, 遥けし and 全し. Counting し would keep them
  kifuku, but 講談社 tags nouns ending in し `adj-i` (遠回し, 聞こえよがし,
  お人好し, 引っ切り無し). With Jitendex and 講談社 installed, counting し kept 14
  of those nouns' pitches kifuku and saved no real adjective, so only い counts.

The rest are suru nouns (シュリンク and ハッスル `vs`; a suru ending matches only in
hiragana, so ハッスル does not end in する), onomatopoeic adverbs (ぷすぷす
`adv vs`), and nouns and na-adjectives (遠回し `adj-i n`, スムース `adj-i`).

`parity.mjs` compares this PR with Yomitan's own functions over 14,994 cases (22
words, every downstep and H/L pattern, 14 class sets): equal wherever every
class fits the headword (10,398), otherwise only kifuku turned positional
(4,596), and 0 other differences.

## Timing

`bench.mjs` times `pitchAccentCategory` itself, main and this PR alternating
round by round (31 rounds each, Node 22.23.1, a shared 64-core host at load
60-70). Median ns per call, two runs each:

| Input | main | this PR |
|---|---:|---:|
| 37,917 pitches of terms with a verb or adjective class (worst case) | 216, 204, 215, 220 | 224, 216, 230, 229 |
| 93,442 pitches of terms with any class (`dump.py`) | 275, 272 | 287, 281 |
| 125,054 Jitendex terms with a pitch in NHK2016 or Kanjium (`dump-all.py`) | 314, 317 | 311, 315 |

That is about 10-30 ns per call over main on the worst case (the audit measured
+20-30 ns). The classifier tests word classes only for a downstep that can be
kifuku, and its verb and adjective endings match katakana themselves, so it
never converts the expression. Earlier
heads of this PR converted it with `toHiragana`: 448 ns on the worst case before
the reorder (f7ba133e), and 745-846 ns when every expression was converted up
front (29f3e7d1). `fuzz.mjs` found those endings equal to
`toHiragana` followed by the hiragana endings on 400,000 random mixed-script
expressions. The suru ending then dropped its katakana (the audit's N7), which
changes one real pitch, ハッスル [1].

`render-bench.mjs` renders a 16-result reply (each result with a class and three
pitches, so 64 classifications) through the production view and `reader.css`,
main and this PR in two pages of one Chrome 152, alternating, 300 samples after
20 warm-ups. Median `renderResults` 6.7 / 6.5 ms on main and 6.6 / 6.4 ms on
this PR; with forced style and layout 19.8 / 18.7 ms and 19.1 / 18.7 ms.
