// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reference test set for word segmentation (#520, phase 1).
//
// About fifty original Japanese lines in the register of NHK Easy news, a
// visual novel and anime subtitles, each with the split a hover would show and
// the headword of every content word. No copyrighted text is reproduced; the
// lines are written for this test.
//
// node-smoke scores both the greedy longest-match parse and `hdw_segment`'s
// best split against this set, so the engine's choice can be judged against the
// greedy fallback the issue would otherwise ship. Scoring needs a dictionary
// that answers every word, so this module also builds one small Yomitan term
// dictionary and one frequency dictionary covering exactly the words the lines
// use, written with the same hand-rolled ZIP writer as make-fixture.mjs.

import { buildTitledZip } from './make-fixture.mjs';

export const SEGMENTATION_DICTIONARY_TITLE = 'segmentation-reference';
export const SEGMENTATION_FREQUENCY_TITLE = 'segmentation-reference-frequency';

// Each line is its surface, then the words a correct split finds: [surface,
// headword, fn?]. A word is listed in reading order and covers consecutive
// characters; particles and other function words are included so the split is
// complete, with a third `true` element. Punctuation between words is skipped
// by the scanner and is not a word.
//
// `conjugated: true` marks a line that exercises deinflection: at least one
// surface differs from its dictionary headword.
export const REFERENCE_LINES = [
  // --- NHK Easy register: short, plain, informative sentences. ---
  // A conjugated word is one span taking its dictionary form, the way a hover
  // shows it and the way the status feature colours it (食べなかった by 食べる).
  { text: '今日は朝からとても寒いです。', conjugated: false, words: [
    ['今日は', '今日は'], ['朝', '朝'], ['から', 'から', true], ['とても', 'とても'],
    ['寒い', '寒い'], ['です', 'です', true] ] },
  { text: '昨日の夜に大きな地震がありました。', conjugated: true, words: [
    ['昨日', '昨日'], ['の', 'の', true], ['夜', '夜'], ['に', 'に', true], ['大きな', '大きな'],
    ['地震', '地震'], ['が', 'が', true], ['ありました', 'ある'] ] },
  { text: '警察は男の人を駅の近くで見つけました。', conjugated: true, words: [
    ['警察', '警察'], ['は', 'は', true], ['男', '男'], ['の', 'の', true], ['人', '人'], ['を', 'を', true],
    ['駅', '駅'], ['の', 'の', true], ['近く', '近く'], ['で', 'で', true], ['見つけました', '見つける'] ] },
  { text: '新しい電車が来月から走ります。', conjugated: true, words: [
    ['新しい', '新しい'], ['電車', '電車'], ['が', 'が', true], ['来月', '来月'], ['から', 'から', true],
    ['走ります', '走る'] ] },
  { text: '子供たちは公園で元気に遊んでいます。', conjugated: true, words: [
    ['子供', '子供'], ['たち', 'たち', true], ['は', 'は', true], ['公園', '公園'], ['で', 'で', true],
    ['元気', '元気'], ['に', 'に', true], ['遊んでいます', '遊ぶ'] ] },
  { text: '多くの人が祭りに集まりました。', conjugated: true, words: [
    ['多く', '多く'], ['の', 'の', true], ['人', '人'], ['が', 'が', true], ['祭り', '祭り'], ['に', 'に', true],
    ['集まりました', '集まる'] ] },
  { text: '病院の前に新しい店ができました。', conjugated: true, words: [
    ['病院', '病院'], ['の', 'の', true], ['前', '前'], ['に', 'に', true], ['新しい', '新しい'],
    ['店', '店'], ['が', 'が', true], ['できました', 'できる'] ] },
  { text: '天気がよくないので試合は中止です。', conjugated: true, words: [
    ['天気', '天気'], ['が', 'が', true], ['よくない', '良い'], ['ので', 'ので', true], ['試合', '試合'],
    ['は', 'は', true], ['中止', '中止'], ['です', 'です', true] ] },
  { text: '先生が子供に本を読んで聞かせました。', conjugated: true, words: [
    ['先生', '先生'], ['が', 'が', true], ['子供', '子供'], ['に', 'に', true], ['本', '本'], ['を', 'を', true],
    ['読んで', '読む'], ['聞かせました', '聞く'] ] },
  { text: '多くの外国人が日本の文化に興味を持っています。', conjugated: true, words: [
    ['多く', '多く'], ['の', 'の', true], ['外国', '外国'], ['人', '人'], ['が', 'が', true], ['日本', '日本'],
    ['の', 'の', true], ['文化', '文化'], ['に', 'に', true], ['興味', '興味'], ['を', 'を', true],
    ['持っています', '持つ'] ] },

  // --- Visual novel register: inner voice, softer, with compounds. ---
  { text: '気がするけど、やっぱり気のせいだ。', conjugated: false, words: [
    ['気がする', '気がする'], ['けど', 'けど', true], ['やっぱり', 'やっぱり'], ['気のせい', '気のせい'], ['だ', 'だ', true] ] },
  { text: '一人暮らしを始めたばかりで、まだ慣れない。', conjugated: true, words: [
    ['一人暮らし', '一人暮らし'], ['を', 'を', true], ['始めた', '始める'], ['ばかり', 'ばかり', true], ['で', 'で', true],
    ['まだ', 'まだ'], ['慣れない', '慣れる'] ] },
  { text: '放課後の教室は、いつもより静かだった。', conjugated: true, words: [
    ['放課後', '放課後'], ['の', 'の', true], ['教室', '教室'], ['は', 'は', true], ['いつも', 'いつも'],
    ['より', 'より', true], ['静か', '静か'], ['だった', 'だ', true] ] },
  { text: 'どうしてそんなことを言うのか分からなかった。', conjugated: true, words: [
    ['どうして', 'どうして'], ['そんな', 'そんな'], ['こと', '事'], ['を', 'を', true], ['言う', '言う'], ['の', 'の', true],
    ['か', 'か', true], ['分からなかった', '分かる'] ] },
  { text: '手を伸ばしても、届かない場所にある。', conjugated: true, words: [
    ['手', '手'], ['を', 'を', true], ['伸ばして', '伸ばす'], ['も', 'も', true], ['届かない', '届く'],
    ['場所', '場所'], ['に', 'に', true], ['ある', 'ある'] ] },
  { text: '君の笑顔を見ると、胸が苦しくなる。', conjugated: true, words: [
    ['君', '君'], ['の', 'の', true], ['笑顔', '笑顔'], ['を', 'を', true], ['見る', '見る'], ['と', 'と', true],
    ['胸', '胸'], ['が', 'が', true], ['苦しく', '苦しい'], ['なる', 'なる'] ] },
  { text: 'あの日の約束を、今でも覚えている。', conjugated: true, words: [
    ['あの', 'あの'], ['日', '日'], ['の', 'の', true], ['約束', '約束'], ['を', 'を', true], ['今', '今'],
    ['でも', 'でも', true], ['覚えている', '覚える'] ] },
  { text: '取り扱いには十分に気をつけてほしい。', conjugated: true, words: [
    ['取り扱い', '取り扱い'], ['に', 'に', true], ['は', 'は', true], ['十分', '十分'], ['に', 'に', true],
    ['気をつけて', '気をつける'], ['ほしい', '欲しい'] ] },
  { text: '思い出したくないことばかり思い出す。', conjugated: true, words: [
    ['思い出したくない', '思い出す'], ['こと', '事'], ['ばかり', 'ばかり', true], ['思い出す', '思い出す'] ] },
  { text: '泣きたいのに、涙が出てこなかった。', conjugated: true, words: [
    ['泣きたい', '泣く'], ['のに', 'のに', true], ['涙', '涙'], ['が', 'が', true], ['出てこなかった', '出る'] ] },

  // --- Anime subtitle register: spoken, contracted, exclamatory. ---
  { text: 'まさかこんなところで会うとは思わなかった。', conjugated: true, words: [
    ['まさか', 'まさか'], ['こんな', 'こんな'], ['ところ', '所'], ['で', 'で', true], ['会う', '会う'], ['と', 'と', true],
    ['は', 'は', true], ['思わなかった', '思う'] ] },
  { text: 'もう逃げるつもりはない。', conjugated: false, words: [
    ['もう', 'もう'], ['逃げる', '逃げる'], ['つもり', 'つもり'], ['は', 'は', true], ['ない', '無い'] ] },
  { text: 'ちゃんと話を聞いてくれよ。', conjugated: true, words: [
    ['ちゃんと', 'ちゃんと'], ['話', '話'], ['を', 'を', true], ['聞いて', '聞く'], ['くれ', 'くれる'], ['よ', 'よ', true] ] },
  { text: 'そんなことで諦めるわけにはいかない。', conjugated: false, words: [
    ['そんな', 'そんな'], ['こと', '事'], ['で', 'で', true], ['諦める', '諦める'], ['わけにはいかない', 'わけにはいかない'] ] },
  { text: '食べなかったのに、怒られてしまった。', conjugated: true, words: [
    ['食べなかった', '食べる'], ['のに', 'のに', true], ['怒られて', '怒る'], ['しまった', 'しまう', true] ] },
  { text: '守ってみせるって約束しただろう。', conjugated: true, words: [
    ['守って', '守る'], ['みせる', '見せる', true], ['って', 'って', true], ['約束', '約束'], ['した', 'する'],
    ['だろう', 'だ', true] ] },
  { text: '早く行かないと間に合わないぞ。', conjugated: true, words: [
    ['早く', '早い'], ['行かない', '行く'], ['と', 'と', true], ['間に合わない', '間に合う'], ['ぞ', 'ぞ', true] ] },
  { text: 'お前なんかに負けるわけがない。', conjugated: false, words: [
    ['お前', 'お前'], ['なんか', 'なんか', true], ['に', 'に', true], ['負ける', '負ける'], ['わけがない', 'わけがない'] ] },
  { text: '泣いてる場合じゃないだろ。', conjugated: true, words: [
    ['泣いてる', '泣く'], ['場合', '場合'], ['じゃない', 'じゃない', true], ['だろ', 'だ', true] ] },
  { text: 'どうやってここまで来たんだ。', conjugated: true, words: [
    ['どうやって', 'どうやって'], ['ここ', 'ここ'], ['まで', 'まで', true], ['来た', '来る'], ['ん', 'ん', true], ['だ', 'だ', true] ] },

  // --- Boundary cases the greedy parser gets wrong (issue Design 2). ---
  // 外 would steal が from いる, so the whole-line best split must win here.
  { text: '白い猫がいる。', conjugated: false, words: [
    ['白い', '白い'], ['猫', '猫'], ['が', 'が', true], ['いる', 'いる'] ] },
  { text: '鳥が空を飛んでいく。', conjugated: true, words: [
    ['鳥', '鳥'], ['が', 'が', true], ['空', '空'], ['を', 'を', true], ['飛んでいく', '飛ぶ'] ] },
  { text: '彼はここにいると思う。', conjugated: false, words: [
    ['彼', '彼'], ['は', 'は', true], ['ここ', 'ここ'], ['に', 'に', true], ['いる', 'いる'], ['と', 'と', true], ['思う', '思う'] ] },
  { text: '時間がない。', conjugated: false, words: [
    ['時間', '時間'], ['が', 'が', true], ['ない', '無い'] ] },
  { text: '意外といける味だ。', conjugated: false, words: [
    ['意外と', '意外と'], ['いける', 'いける'], ['味', '味'], ['だ', 'だ', true] ] },

  // --- More conjugation coverage. ---
  { text: '呼ばれて振り返った。', conjugated: true, words: [
    ['呼ばれて', '呼ぶ'], ['振り返った', '振り返る'] ] },
  { text: '走らせてもらえますか。', conjugated: true, words: [
    ['走らせてもらえます', '走る'], ['か', 'か', true] ] },
  { text: '読ませられたくなかった。', conjugated: true, words: [
    ['読ませられたくなかった', '読む'] ] },
  { text: '食べ過ぎてしまった。', conjugated: true, words: [
    ['食べ過ぎて', '食べ過ぎる'], ['しまった', 'しまう', true] ] },
  { text: '帰りたくなっちゃった。', conjugated: true, words: [
    ['帰りたく', '帰る'], ['なっちゃった', 'なる'] ] },

  // --- Kana-written content words with kanji headwords (Design 2 reading). ---
  { text: 'きれいな景色が見たい。', conjugated: true, words: [
    ['きれい', '綺麗'], ['な', 'な', true], ['景色', '景色'], ['が', 'が', true], ['見たい', '見る'] ] },
  { text: 'ありがとうと伝えたかった。', conjugated: true, words: [
    ['ありがとう', '有り難う'], ['と', 'と', true], ['伝えたかった', '伝える'] ] },
  { text: 'だんだん寒くなってきた。', conjugated: true, words: [
    ['だんだん', '段々'], ['寒く', '寒い'], ['なってきた', 'なる'] ] },

  // --- Longer, mixed lines. ---
  { text: '駅前の新しいカフェでコーヒーを飲んだ。', conjugated: true, words: [
    ['駅前', '駅前'], ['の', 'の', true], ['新しい', '新しい'], ['カフェ', 'カフェ'], ['で', 'で', true],
    ['コーヒー', 'コーヒー'], ['を', 'を', true], ['飲んだ', '飲む'] ] },
  { text: '週末は家族で温泉に行く予定だ。', conjugated: false, words: [
    ['週末', '週末'], ['は', 'は', true], ['家族', '家族'], ['で', 'で', true], ['温泉', '温泉'], ['に', 'に', true],
    ['行く', '行く'], ['予定', '予定'], ['だ', 'だ', true] ] },
  { text: '約束の時間に遅れてごめん。', conjugated: true, words: [
    ['約束', '約束'], ['の', 'の', true], ['時間', '時間'], ['に', 'に', true], ['遅れて', '遅れる'], ['ごめん', 'ごめん'] ] },
  { text: '雨が降り出す前に帰ろう。', conjugated: true, words: [
    ['雨', '雨'], ['が', 'が', true], ['降り出す', '降り出す'], ['前', '前'], ['に', 'に', true], ['帰ろう', '帰る'] ] },
];

// Every (expression, reading) a reference headword needs, plus the function
// words, so one small dictionary answers every lookup the lines make. The
// reading is only used to build the dictionary; the test keys on the headword.
// A compound whose pieces are also words (今日 inside 今日は, 気 inside
// 気がする) is listed too, so the greedy and best splits really have the choice
// the issue describes. The third field is the deinflection rules.
const TERM_ENTRIES = [
  ['今日', 'きょう', ''], ['今日は', 'こんにちは', ''], ['朝', 'あさ', ''], ['とても', 'とても', ''],
  ['寒い', 'さむい', 'adj-i'], ['昨日', 'きのう', ''], ['夜', 'よる', ''], ['大きな', 'おおきな', ''],
  ['地震', 'じしん', ''], ['ある', 'ある', 'v5'], ['警察', 'けいさつ', ''], ['男', 'おとこ', ''],
  ['人', 'ひと', ''], ['駅', 'えき', ''], ['近く', 'ちかく', ''], ['見つける', 'みつける', 'v1'],
  ['新しい', 'あたらしい', 'adj-i'], ['電車', 'でんしゃ', ''], ['来月', 'らいげつ', ''], ['走る', 'はしる', 'v5'],
  ['子供', 'こども', ''], ['公園', 'こうえん', ''], ['元気', 'げんき', ''], ['遊ぶ', 'あそぶ', 'v5'],
  ['いる', 'いる', 'v1'], ['多く', 'おおく', ''], ['祭り', 'まつり', ''], ['集まる', 'あつまる', 'v5'],
  ['病院', 'びょういん', ''], ['前', 'まえ', ''], ['店', 'みせ', ''], ['できる', 'できる', 'v1'],
  ['天気', 'てんき', ''], ['良い', 'よい', 'adj-i'], ['試合', 'しあい', ''], ['中止', 'ちゅうし', ''],
  ['先生', 'せんせい', ''], ['本', 'ほん', ''], ['読む', 'よむ', 'v5'], ['聞く', 'きく', 'v5'],
  ['外国', 'がいこく', ''], ['日本', 'にほん', ''], ['文化', 'ぶんか', ''], ['興味', 'きょうみ', ''],
  ['持つ', 'もつ', 'v5'],
  ['気がする', 'きがする', 'vs'], ['やっぱり', 'やっぱり', ''], ['気のせい', 'きのせい', ''],
  ['一人暮らし', 'ひとりぐらし', ''], ['始める', 'はじめる', 'v1'], ['まだ', 'まだ', ''], ['慣れる', 'なれる', 'v1'],
  ['放課後', 'ほうかご', ''], ['教室', 'きょうしつ', ''], ['いつも', 'いつも', ''], ['静か', 'しずか', ''],
  ['どうして', 'どうして', ''], ['そんな', 'そんな', ''], ['事', 'こと', ''], ['言う', 'いう', 'v5'],
  ['分かる', 'わかる', 'v5'], ['手', 'て', ''], ['伸ばす', 'のばす', 'v5'], ['届く', 'とどく', 'v5'],
  ['場所', 'ばしょ', ''], ['君', 'きみ', ''], ['笑顔', 'えがお', ''], ['見る', 'みる', 'v1'],
  ['胸', 'むね', ''], ['苦しい', 'くるしい', 'adj-i'], ['なる', 'なる', 'v5'], ['あの', 'あの', ''],
  ['日', 'ひ', ''], ['約束', 'やくそく', 'vs'], ['今', 'いま', ''], ['覚える', 'おぼえる', 'v1'],
  ['取り扱い', 'とりあつかい', ''], ['十分', 'じゅうぶん', ''], ['気をつける', 'きをつける', 'v1'],
  ['欲しい', 'ほしい', 'adj-i'], ['思い出す', 'おもいだす', 'v5'], ['泣く', 'なく', 'v5'], ['涙', 'なみだ', ''],
  ['出る', 'でる', 'v1'], ['来る', 'くる', 'vk'],
  ['まさか', 'まさか', ''], ['こんな', 'こんな', ''], ['所', 'ところ', ''], ['会う', 'あう', 'v5'],
  ['思う', 'おもう', 'v5'], ['もう', 'もう', ''], ['逃げる', 'にげる', 'v1'], ['つもり', 'つもり', ''],
  ['無い', 'ない', 'adj-i'], ['ちゃんと', 'ちゃんと', ''], ['話', 'はなし', ''], ['くれる', 'くれる', 'v1'],
  ['諦める', 'あきらめる', 'v1'], ['わけにはいかない', 'わけにはいかない', ''], ['食べる', 'たべる', 'v1'],
  ['怒る', 'おこる', 'v5'], ['しまう', 'しまう', 'v5'], ['守る', 'まもる', 'v5'], ['見せる', 'みせる', 'v1'],
  ['する', 'する', 'vs'], ['早い', 'はやい', 'adj-i'], ['行く', 'いく', 'v5'], ['間に合う', 'まにあう', 'v5'],
  ['お前', 'おまえ', ''], ['負ける', 'まける', 'v1'], ['わけがない', 'わけがない', ''], ['場合', 'ばあい', ''],
  ['じゃない', 'じゃない', ''], ['どうやって', 'どうやって', ''], ['ここ', 'ここ', ''],
  ['白い', 'しろい', 'adj-i'], ['猫', 'ねこ', ''], ['外', 'そと', ''], ['外', 'がい', ''], ['鳥', 'とり', ''], ['空', 'そら', ''],
  ['飛ぶ', 'とぶ', 'v5'], ['彼', 'かれ', ''], ['時間', 'じかん', ''], ['意外と', 'いがいと', ''],
  ['いける', 'いける', 'v1'], ['味', 'あじ', ''],
  ['呼ぶ', 'よぶ', 'v5'], ['振り返る', 'ふりかえる', 'v5'], ['もらう', 'もらう', 'v5'],
  ['食べ過ぎる', 'たべすぎる', 'v1'], ['待つ', 'まつ', 'v5'], ['有り難う', 'ありがとう', ''], ['帰る', 'かえる', 'v5'],
  ['綺麗', 'きれい', ''], ['景色', 'けしき', ''], ['段々', 'だんだん', ''],
  ['駅前', 'えきまえ', ''], ['カフェ', 'カフェ', ''], ['コーヒー', 'コーヒー', ''], ['飲む', 'のむ', 'v5'],
  ['週末', 'しゅうまつ', ''], ['家族', 'かぞく', ''], ['温泉', 'おんせん', ''], ['予定', 'よてい', ''],
  ['毎朝', 'まいあさ', ''], ['遅れる', 'おくれる', 'v1'], ['ごめん', 'ごめん', ''], ['雨', 'あめ', ''],
  ['降り出す', 'ふりだす', 'v5'], ['伝える', 'つたえる', 'v1'], ['彼女', 'かのじょ', ''], ['彼女', 'かのじょ', ''],
  // Function words. They are headwords too, so a span lands on them.
  ['は', 'は', ''], ['が', 'が', ''], ['を', 'を', ''], ['に', 'に', ''], ['で', 'で', ''],
  ['と', 'と', ''], ['の', 'の', ''], ['も', 'も', ''], ['から', 'から', ''], ['より', 'より', ''],
  ['まで', 'まで', ''], ['か', 'か', ''], ['よ', 'よ', ''], ['ぞ', 'ぞ', ''], ['ね', 'ね', ''],
  ['な', 'な', ''], ['ので', 'ので', ''], ['のに', 'のに', ''], ['けど', 'けど', ''], ['ばかり', 'ばかり', ''],
  ['なんか', 'なんか', ''], ['でも', 'でも', ''], ['だ', 'だ', ''], ['です', 'です', ''], ['ます', 'ます', ''],
  ['たち', 'たち', ''], ['って', 'って', ''], ['ん', 'ん', ''],
];

// A frequency rank for every content headword, so the best split can break
// ties by frequency the way a hover ranks results.
function frequencyRows() {
  const seen = new Set();
  const rows = [];
  let rank = 1;
  for (const [expression] of TERM_ENTRIES) {
    if (seen.has(expression)) continue;
    seen.add(expression);
    rows.push([expression, 'freq', { value: rank, displayValue: String(rank) }]);
    rank += 1;
  }
  return rows;
}

export function buildSegmentationDictionaryZip() {
  const seen = new Set();
  const terms = [];
  TERM_ENTRIES.forEach(([expression, reading, rules], index) => {
    const key = `${expression}\u0000${reading}`;
    if (seen.has(key)) return;
    seen.add(key);
    // [expression, reading, definitionTags, rules, score, [glossary], sequence, termTags]
    terms.push([expression, reading, '', rules, TERM_ENTRIES.length - index,
      [`reference gloss for ${expression}`], index, '']);
  });
  return buildTitledZip(SEGMENTATION_DICTIONARY_TITLE, { terms });
}

export function buildSegmentationFrequencyZip() {
  return buildTitledZip(SEGMENTATION_FREQUENCY_TITLE, { banks: false, termMeta: frequencyRows() });
}

// The expected spans of one line, in code-point offsets (the reference lines
// use no surrogate-pair characters): content words with their headword, and
// function words flagged. Punctuation between words is skipped.
export function expectedSpans(line) {
  const chars = Array.from(line.text);
  const spans = [];
  let cursor = 0;
  for (const [word, headword, fn] of line.words) {
    const wordChars = Array.from(word);
    while (cursor < chars.length && chars.slice(cursor, cursor + wordChars.length).join('') !== word) {
      cursor += 1;
    }
    spans.push({ start: cursor, length: wordChars.length, headword, functionWord: fn === true });
    cursor += wordChars.length;
  }
  return spans;
}

// The greedy longest-match parse the issue compares against (Yomitan's
// scanning parser): at each position take the first result of one lookup and
// skip past what it matched. `lookupFirst(text)` is that result, or undefined.
export function greedySpans(text, lookupFirst) {
  const chars = Array.from(text);
  const spans = [];
  for (let index = 0; index < chars.length;) {
    const result = lookupFirst(chars.slice(index).join(''));
    const length = result?.matched ? Array.from(result.matched).length : 0;
    if (length > 0) spans.push({ start: index, length, headword: result.term.expression });
    index += Math.max(length, 1);
  }
  return spans;
}

// Scores hdw_segment's best split and the greedy parse against the reference
// set, with whatever dictionaries the engine has loaded: `segment(text)` is
// hdw_segment's spans for a line, `lookupFirst(text)` the first hdw_lookup
// result, both with the same options. node-smoke scores the dictionaries
// above; benchmark/segmentation.mjs scores real archives the same way.
export function scoreReferenceSet({ segment, lookupFirst }) {
  const score = {
    lines: REFERENCE_LINES.length, words: 0, bestWords: 0, greedyWords: 0, bestLines: 0, greedyLines: 0,
    functionWords: 0, conjugatedLines: 0, conjugatedRecovered: 0,
  };
  const key = (span) => `${span.start}:${span.length}:${span.headword}`;
  for (const line of REFERENCE_LINES) {
    const expected = expectedSpans(line);
    const expectedKeys = new Set(expected.map(key));
    const spans = segment(line.text);
    const best = spans.map((span) => ({ start: span.start, length: span.length, headword: span.candidates[0]?.expression }));
    const greedy = greedySpans(line.text, lookupFirst);
    const bestHits = best.filter((span) => expectedKeys.has(key(span))).length;
    const greedyHits = greedy.filter((span) => expectedKeys.has(key(span))).length;
    score.words += expected.length;
    score.bestWords += bestHits;
    score.greedyWords += greedyHits;
    if (bestHits === expected.length && best.length === expected.length) score.bestLines += 1;
    if (greedyHits === expected.length && greedy.length === expected.length) score.greedyLines += 1;
    const byPosition = new Map(spans.map((span) => [`${span.start}:${span.length}`, span]));
    for (const word of expected) {
      if (byPosition.get(`${word.start}:${word.length}`)?.functionWord === word.functionWord) score.functionWords += 1;
    }
    if (line.conjugated) {
      score.conjugatedLines += 1;
      // Every content word whose surface differs from its headword is recovered.
      const recovered = line.words.every(([surface, headword, fn]) => fn || surface === headword
        || best.some((span) => span.headword === headword
          && line.text.slice(span.start, span.start + Array.from(surface).length) === surface));
      if (recovered) score.conjugatedRecovered += 1;
    }
  }
  return score;
}

export function formatReferenceScore(score) {
  const percent = (count) => `${((100 * count) / score.words).toFixed(1)}%`;
  return [
    `reference set: ${score.lines} lines, ${score.words} words`,
    `best split : ${score.bestWords}/${score.words} words (${percent(score.bestWords)}), `
      + `${score.bestLines}/${score.lines} lines exact`,
    `greedy     : ${score.greedyWords}/${score.words} words (${percent(score.greedyWords)}), `
      + `${score.greedyLines}/${score.lines} lines exact`,
    `function-word flag: ${score.functionWords}/${score.words} correct`,
    `conjugated lines fully recovered: ${score.conjugatedRecovered}/${score.conjugatedLines}`,
  ];
}
