#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates test/fixtures/hachidori-fixture.zip, a Yomitan format-3 dictionary that
// covers every shape the extension renders, plus the malformed archives the
// error-path tests need.
//
// The ZIP container is written by hand: node ships zlib but no zip writer, and
// the engine's reader (third_party/hoshidicts/src/zip/zip.cpp) only needs the
// central directory, the local file headers, and raw deflate streams. Adding a
// dependency to produce 700 bytes of headers is not worth it.
//
// Nothing here is pretty-printed. The engine hands back `glossary` as the raw
// bytes of the glossary array straight out of term_bank_1.json, so minified
// JSON makes that string exactly predictable for node-smoke.mjs.

import { createDeflateRaw, deflateRawSync, crc32, deflateSync } from 'node:zlib';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

export const TITLE = 'hachidori-fixture';
export const MEDIA_PATH = 'media/kanji.png';
export const ATOMIC_REPLACEMENT_TITLE = 'hachidori-atomic-replacement';
export const ATOMIC_REPLACEMENT_QUERY = '更新語';

// ---------------------------------------------------------------------------
// ZIP writer
// ---------------------------------------------------------------------------

const utf8 = (s) => Buffer.from(s, 'utf8');

// STORE for tiny or already-compressed payloads, DEFLATE otherwise. Both paths
// have to work: zip.cpp special-cases method 0 and method 8 and rejects the rest.
const STORE = 0;
const DEFLATE = 8;

function zipEntry(name, data, method) {
  const raw = Buffer.isBuffer(data) ? data : utf8(data);
  const chosen = method ?? (raw.length > 64 ? DEFLATE : STORE);
  const body = chosen === DEFLATE ? deflateRawSync(raw, { level: 9 }) : raw;
  return { name: utf8(name), raw, body, method: chosen, crc: crc32(raw) >>> 0 };
}

function buildZip(entries) {
  const chunks = [];
  const records = [];
  let offset = 0;

  for (const e of entries) {
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 name flag
    lfh.writeUInt16LE(e.method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x21, 12); // mod date: 2000-01-01
    lfh.writeUInt32LE(e.crc, 14);
    lfh.writeUInt32LE(e.body.length, 18);
    lfh.writeUInt32LE(e.raw.length, 22);
    lfh.writeUInt16LE(e.name.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length; zip.cpp adds it to data_offset

    records.push({ ...e, lfhOffset: offset });
    chunks.push(lfh, e.name, e.body);
    offset += lfh.length + e.name.length + e.body.length;
  }

  const cdStart = offset;
  for (const e of records) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // UTF-8 name flag
    cdh.writeUInt16LE(e.method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(e.crc, 16);
    cdh.writeUInt32LE(e.body.length, 20);
    cdh.writeUInt32LE(e.raw.length, 24);
    cdh.writeUInt16LE(e.name.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs
    cdh.writeUInt32LE(e.lfhOffset, 42);
    chunks.push(cdh, e.name);
    offset += cdh.length + e.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  // Zero-length comment keeps the EOCD at exactly size-22, which is where
  // zip.cpp starts its backwards scan.
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

function forgeZip(entries, { eocdEntries } = {}) {
  const chunks = [];
  const records = [];
  let offset = 0;

  for (const e of entries) {
    const name = utf8(e.name);
    const body = e.body ?? Buffer.alloc(0);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(e.method ?? STORE, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(e.crc ?? 0, 14);
    lfh.writeUInt32LE((e.lfhCompressed ?? body.length) >>> 0, 18);
    lfh.writeUInt32LE((e.lfhUncompressed ?? body.length) >>> 0, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);

    records.push({ ...e, name, body, lfhOffset: offset });
    chunks.push(lfh, name, body);
    offset += lfh.length + name.length + body.length;
  }

  const cdStart = offset;
  for (const e of records) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(e.method ?? STORE, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(e.crc ?? 0, 16);
    cdh.writeUInt32LE((e.cdCompressed ?? e.body.length) >>> 0, 20);
    cdh.writeUInt32LE((e.cdUncompressed ?? e.body.length) >>> 0, 24);
    cdh.writeUInt16LE(e.name.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cdh.writeUInt32LE(e.lfhOffset, 42);
    chunks.push(cdh, e.name);
    offset += cdh.length + e.name.length;
  }

  const declared = eocdEntries ?? records.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(declared & 0xffff, 8);
  eocd.writeUInt16LE(declared & 0xffff, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// A real 16x16 PNG, built here so the media assertions can check a genuine
// file signature rather than a made-up byte string.
// ---------------------------------------------------------------------------

function pngChunk(type, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

export function makePng(size = 16) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // A diagonal so the image is visibly not blank if anyone opens it.
  const scanlines = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const on = x === y || x + y === size - 1;
      row[1 + x * 3] = on ? 0x33 : 0xf0;
      row[2 + x * 3] = on ? 0x66 : 0xf0;
      row[3 + x * 3] = on ? 0xcc : 0xf0;
    }
    scanlines.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(scanlines), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Dictionary content
// ---------------------------------------------------------------------------

const index = {
  title: TITLE,
  format: 3,
  revision: 'test-1',
  sequenced: true,
  isUpdatable: false,
  author: 'Hachidori test harness',
  url: 'https://example.invalid/hachidori-fixture',
  description: 'synthetic dictionary covering every shape the extension renders',
  attribution: 'GPL-3.0-or-later',
  sourceLanguage: 'ja',
  targetLanguage: 'en',
};

// Yomitan structured content: nested inline tags, a list, a table, and an img
// whose path resolves to the media entry below.
const structuredContent = {
  type: 'structured-content',
  content: [
    {
      tag: 'div',
      data: { hachidori: 'entry' },
      content: [
        { tag: 'span', style: { fontWeight: 'bold' }, content: 'Chinese characters' },
        {
          tag: 'ul',
          content: [
            { tag: 'li', content: 'kanji' },
            { tag: 'li', content: [{ tag: 'em', content: 'Han' }, ' characters'] },
          ],
        },
        {
          tag: 'table',
          content: [
            {
              tag: 'tbody',
              content: [
                {
                  tag: 'tr',
                  content: [
                    { tag: 'th', content: 'on' },
                    { tag: 'td', content: 'カン' },
                  ],
                },
                {
                  tag: 'tr',
                  content: [
                    { tag: 'th', content: 'kun' },
                    { tag: 'td', content: 'あざ' },
                  ],
                },
              ],
            },
          ],
        },
        {
          tag: 'img',
          path: MEDIA_PATH,
          width: 16,
          height: 16,
          title: 'kanji glyph',
          alt: 'kanji',
          collapsible: false,
        },
      ],
    },
  ],
};

// [expression, reading, definitionTags, rules, score, glossary, sequence, termTags]
//
// 食べる carries `rules: "v1"`, which is what makes 食べたかった reachable:
// Lookup::filter_by_pos drops any candidate whose rules do not satisfy the
// deinflection's part-of-speech conditions.
//
// The second 食べる row has empty rules on purpose. It gives the term two
// glossaries without DictionaryQuery::query_raw concatenating "v1 v1".
export const TERMS = [
  ['食べる', 'たべる', 'vt', 'v1', 120, ['to eat', 'to live on (e.g. a salary)'], 1, 'ichidan'],
  ['食べる', 'たべる', 'col', '', 10, ['(colloquial) to make a living'], 1, 'ichidan'],
  ['漢字', 'かんじ', 'n', '', 100, [structuredContent, 'Chinese character'], 2, 'common'],
  // Empty reading: the importer substitutes the expression, so this stays a
  // single hash entry and a kana-only lookup has to hit the expression.
  ['ありがとう', '', 'int', '', 80, ['thank you', 'thanks'], 3, 'uk'],
  ['読む', 'よむ', 'vt', 'v5', 60, ['to read'], 4, ''],
  ['食', 'たべもの', 'n', '', 1000, ['unrelated term-dictionary definition'], 5, ''],
];

// [expression, mode, data]
//
// Both accepted frequency shapes appear: the nested {"frequency":{...}} object
// and the flat {"value":...}. yomitan_parser::parse_frequency tries them in a
// specific order, so covering both catches a regression in either branch.
export const TERM_META = [
  ['食べる', 'freq', { reading: 'たべる', frequency: { value: 142, displayValue: '142位' } }],
  ['読む', 'freq', { value: 88, displayValue: '88' }],
  [
    '食べる',
    'pitch',
    {
      reading: 'たべる',
      // position as int and as a pattern string; nasal as a bare int and
      // devoice as an array, since both are variant<int, vector<int>>.
      pitches: [{ position: 2 }, { position: 0, nasal: 1, devoice: [1, 2] }, { position: 'LHH' }],
    },
  ],
  ['食べる', 'ipa', { reading: 'たべる', transcriptions: [{ ipa: 'tabeɾɯ' }] }],
];

// [character, onyomi, kunyomi, tags, definitions, stats]
export const KANJI = [
  [
    '食',
    'ショク ジキ',
    'く.う た.べる',
    'jouyou grade2',
    ['food', 'eat', 'meal'],
    { strokes: '9', grade: '2', freq: '382' },
  ],
];

// [name, category, order, notes, score]
export const TAGS = [
  ['vt', 'expression', 0, 'transitive verb', 0],
  ['col', 'dictionary', 0, 'colloquial', 0],
  ['n', 'partOfSpeech', 0, 'noun', 0],
  ['int', 'partOfSpeech', 0, 'interjection', 0],
  ['uk', 'dictionary', 0, 'usually written using kana alone', 0],
  ['ichidan', 'expression', 0, 'ichidan verb', 0],
  ['common', 'frequent', 0, 'common word', 1],
];

export const STYLES = [
  '.hachidori-fixture-table {',
  '  border-collapse: collapse;',
  '}',
  '.hachidori-fixture-table th {',
  '  text-align: left;',
  '  padding-right: 0.5em;',
  '}',
].join('\n');

// The counts hdw_import must report. Derived from the data above rather than
// hardcoded, so editing a bank cannot silently desync the expectation.
export const EXPECTED = {
  title: TITLE,
  termCount: TERMS.length,
  metaCount: TERM_META.length,
  frequencyCount: TERM_META.filter((m) => m[1] === 'freq').length,
  pitchCount: TERM_META.filter((m) => m[1] === 'pitch' || m[1] === 'ipa').length,
  kanjiCount: KANJI.length,
  mediaCount: 1,
};

// ---------------------------------------------------------------------------
// Trained-zstd-dictionary fixture
// ---------------------------------------------------------------------------
//
// The importer trains a zstd dictionary from the *first* term bank and, when that
// succeeds, writes a dict.zstd and marks the directory .hoshidicts_4 instead of
// .hoshidicts_3. train_zstd_dict gives up unless it can sample at least eight
// glossaries, and ZDICT needs a few kilobytes on top of that to converge.
//
// TERMS above stays deliberately under that floor at six rows, so importing the
// primary fixture still produces the pre-4 layout: .hoshidicts_3 and no
// dict.zstd, which is exactly what a dictionary imported by an older engine looks
// like. TRAINING_SAMPLE_FLOOR pins that, so growing TERMS past eight rows fails
// loudly in node-smoke.mjs instead of silently retiring the compatibility coverage.
//
// This fixture goes over the floor, so between the two every marker the engine
// can write is exercised.
export const TRAINING_SAMPLE_FLOOR = 8;

export const TRAINED_TITLE = 'hachidori-fixture-trained';
export const TRAINED_ROWS = 48;

// Distinct expressions, spread out in the CJK block so no two rows collide, with
// kana readings built from the same index. The glossaries share their phrasing on
// purpose: a trained dictionary is only worth anything when the samples have
// structure in common, and a fixture that defeats the training would test nothing.
const KANA = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ'];

// Row 0 is the deinflection target: `rules: "v1"` is what makes 食べたかった
// reach it, so the trained dictionary gets checked through a real lookup and not
// just through the marker on disk.
export const TRAINED_TERMS = [
  ['食べる', 'たべる', 'vt', 'v1', 120, ['to eat', 'to live on (e.g. a salary)'], 1, 'ichidan'],
  ...Array.from({ length: TRAINED_ROWS }, (_, i) => {
    const expression = String.fromCodePoint(0x4e00 + i * 7);
    const reading = [KANA[i % KANA.length], KANA[(i * 3) % KANA.length], KANA[(i * 7) % KANA.length]].join('');
    return [
      expression,
      reading,
      'n',
      '',
      100 - i,
      [
        `sample entry number ${i}`,
        `a deliberately repetitive english gloss so the trained zstd dictionary has shared structure to learn, entry ${i}`,
      ],
      i + 10,
      'common',
    ];
  }),
];

export function buildTrainedZip() {
  return buildZip([
    zipEntry('index.json', JSON.stringify({ ...index, title: TRAINED_TITLE })),
    zipEntry('term_bank_1.json', JSON.stringify(TRAINED_TERMS)),
  ]);
}

export const MANY_BANK_TITLE = 'hachidori-fixture-many-banks';
export const MANY_BANK_COUNT = TRAINED_TERMS.length + 19;

export function buildManyBankZip() {
  const entries = [
    zipEntry('index.json', JSON.stringify({ ...index, title: MANY_BANK_TITLE })),
    zipEntry('term_bank_1.json', JSON.stringify(TRAINED_TERMS)),
  ];
  for (let bank = 2; bank <= 20; bank += 1) {
    const expression = String.fromCodePoint(0x7000 + bank);
    entries.push(zipEntry(`term_bank_${bank}.json`, JSON.stringify([
      [expression, expression, 'n', '', 0, [`scheduler bank ${bank}`], 1000 + bank, ''],
    ])));
  }
  return buildZip(entries);
}

export const GENERIC_KANJI_TITLE = 'hachidori-generic-kanji-fixture';
export const GENERIC_KANJI_GLOSSARY = 'term-only single-kanji definition';

export function buildGenericKanjiZip() {
  return buildZip([
    zipEntry('index.json', JSON.stringify({ ...index, title: GENERIC_KANJI_TITLE })),
    zipEntry('term_bank_1.json', JSON.stringify([
      ['食', 'しょく', '', '', 100, [GENERIC_KANJI_GLOSSARY], 1, ''],
      ['食食', 'しょくしょく', '', '', 90, ['duplicate-kanji focus fixture'], 2, ''],
    ])),
  ]);
}

// Long-key fixture: keys longer than 16 code points, which the ordinary scan
// (scanLength 16) can never reach. The importer lists them in scan.idx by their
// first eight code points and the engine extends a lookup to them only when the
// text begins like one (hoshidicts src/scan_index.hpp).
export const LONG_KEY_TITLE = 'hachidori-long-key-fixture';
// 27 code points.
export const LONG_KEY_PROVERB = '身体髪膚これを父母に受くあえて毀傷せざるは孝の始めなり';
export const LONG_KEY_PROVERB_READING = 'しんたいはっぷこれをふぼにうくあえてきしょうせざるはこうのはじめなり';
// 17 code points, ichidan, so 〜られなかった deinflects to it.
export const LONG_KEY_PHRASE = '自分の思うところをはっきりと述べる';
export const LONG_KEY_PHRASE_INFLECTED = '自分の思うところをはっきりと述べられなかった';
export const LONG_KEY_LENGTH = Array.from(LONG_KEY_PROVERB_READING).length;
// Yomitan scores are JSON numbers, not integers: real dictionaries carry
// fractions (frequency-derived scores) and values past int32. hoshidicts stores
// the score as a double since .hoshidicts_5, and these two pin that the whole
// path -- importer, blobs.bin, lookup, the wasm JSON boundary -- keeps them.
export const LONG_KEY_PROVERB_SCORE = 1099511627776.5;
export const LONG_KEY_PHRASE_SCORE = -0.25;

export function buildLongKeyZip() {
  return buildZip([
    zipEntry('index.json', JSON.stringify({ ...index, title: LONG_KEY_TITLE })),
    zipEntry('term_bank_1.json', JSON.stringify([
      [LONG_KEY_PROVERB, LONG_KEY_PROVERB_READING, '', '', LONG_KEY_PROVERB_SCORE, ['the body is a gift from one\'s parents'], 1, ''],
      [LONG_KEY_PHRASE, 'じぶんのおもうところをはっきりとのべる', '', 'v1', LONG_KEY_PHRASE_SCORE, ['to state one\'s view plainly'], 2, ''],
      ['身体', 'しんたい', '', '', 80, ['body'], 3, ''],
    ])),
  ]);
}

// DictionaryQuery keys terms on (expression, reading), with an empty reading in
// the bank meaning "same as the expression".
export const termKey = (expression, reading) => [expression, reading || expression].join('|');

// The exact glossary strings the engine returns, per term key, in term-bank
// order. glossary is handed back as the raw bytes of the glossary array, so
// these are byte-for-byte what a lookup must produce.
export const EXPECTED_GLOSSARIES = (() => {
  const byKey = new Map();
  for (const [expression, reading, , , , glossary] of TERMS) {
    const key = termKey(expression, reading);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(JSON.stringify(glossary));
  }
  return byKey;
})();

export function fixtureEntries() {
  return [
    zipEntry('index.json', JSON.stringify(index)),
    // A directory record. get_files() must skip it, or mediaCount is wrong.
    zipEntry('media/', Buffer.alloc(0), STORE),
    zipEntry('term_bank_1.json', JSON.stringify(TERMS)),
    zipEntry('term_meta_bank_1.json', JSON.stringify(TERM_META)),
    zipEntry('kanji_bank_1.json', JSON.stringify(KANJI)),
    zipEntry('tag_bank_1.json', JSON.stringify(TAGS)),
    zipEntry('styles.css', STYLES),
    zipEntry(MEDIA_PATH, makePng(), STORE),
  ];
}

export function buildFixtureZip() {
  return buildZip(fixtureEntries());
}

// The fixture with a different declared title, and optionally with the term bank
// stripped so the import fails *after* the importer has read the title and
// derived a directory from it. That is the only moment a title can do damage,
// which is what the path-traversal and failed-re-import tests need.
export function buildTitledZip(title, {
  banks = true,
  terms = TERMS,
  termMeta = [],
  mediaEntries = [],
  frequencyMode,
  styles = '',
  revision = index.revision,
  indexUrl,
  downloadUrl,
  indexOverrides = {},
  rawTermBank = null,
} = {}) {
  const archiveIndex = {
    ...index,
    title,
    revision,
    frequencyMode,
    indexUrl,
    downloadUrl,
    ...indexOverrides,
  };
  const entries = [zipEntry('index.json', JSON.stringify(archiveIndex))];
  if (banks) {
    entries.push(zipEntry('term_bank_1.json', rawTermBank ?? JSON.stringify(terms)));
  }
  if (termMeta.length > 0) {
    entries.push(zipEntry('term_meta_bank_1.json', JSON.stringify(termMeta)));
  }
  if (styles) {
    entries.push(zipEntry('styles.css', styles));
  }
  for (const [path, bytes] of mediaEntries) entries.push(zipEntry(path, bytes));
  return buildZip(entries);
}

export function buildMisdeclaredOversizedIndexZip(actualBytes, declaredBytes = 1024) {
  const padding = 'x'.repeat(actualBytes);
  const raw = Buffer.from(JSON.stringify({ ...index, title: 'oversized-index', padding }));
  const body = deflateRawSync(raw, { level: 9 });
  return forgeZip([{
    name: 'index.json',
    method: DEFLATE,
    body,
    crc: crc32(raw) >>> 0,
    lfhCompressed: body.length,
    lfhUncompressed: declaredBytes,
    cdCompressed: body.length,
    cdUncompressed: declaredBytes,
  }]);
}

export function buildAtomicReplacementZip(revision, definition, overrides = {}) {
  return buildTitledZip(ATOMIC_REPLACEMENT_TITLE, {
    revision,
    terms: [[ATOMIC_REPLACEMENT_QUERY, 'こうしんご', '', '', 0, [definition], 1, '']],
    ...overrides,
  });
}

export function externalLinksFixture(destinationUrl) {
  const title = 'external-links-fixture';
  const query = '参照';
  const archive = buildTitledZip(title, { terms: [[query, 'さんしょう', '', '', 0, [
    { type: 'structured-content', content: { tag: 'div', content: [
      'Reference: ', { tag: 'a', href: destinationUrl, content: '外部辞典 <reference>' },
      { tag: 'ul', content: ['usage', 'examples', 'sources'].map(label => ({ tag: 'li', content: {
        tag: 'a', href: `${destinationUrl.split('#')[0]}#${label}`, content: label,
      } })) },
    ] } },
  ], 1, '']] });
  return { title, query, archive };
}

export function nestedLinksFixture() {
  const title = 'nested-links-fixture';
  const query = '連鎖語';
  const child = '食用語';
  const reading = 'しょくようご';
  const grandchild = '終点';
  const missing = '未登録語';
  const link = (query, primaryReading, label) => ({ tag: 'a',
    href: `?query=${encodeURIComponent(query)}&primary_reading=${encodeURIComponent(primaryReading)}`,
    content: label,
  });
  const glossary = (text, hoverTerm, next, missingTerm = null) => {
    const content = [
      text, ' 定義内の語：', { tag: 'span', content: hoverTerm }, '。 ',
    ];
    if (missingTerm) {
      content.push('未登録：', { tag: 'span', content: missingTerm }, '。 ');
    }
    content.push(next,
      { tag: 'img', path: 'media/kanji.png', width: 16, height: 16 });
    return [{ type: 'structured-content', content: { tag: 'div', content } }];
  };
  const archive = buildTitledZip(title, { mediaEntries: [['media/kanji.png', makePng()]], terms: [
    [query, 'れんさご', '', '', 0, glossary('A linked definition.', child,
      link(child, reading, 'Open the referenced entry'), missing), 1, ''],
    [child, reading, '', '', 0, glossary('The referenced entry.', grandchild,
      link(grandchild, 'しゅうてん', 'Continue to the final entry')), 2, ''],
    [grandchild, 'しゅうてん', '', '', 0, glossary('The final entry.', query,
      link(query, 'れんさご', 'Return to the first entry')), 3, ''],
  ] });
  return { title, query, child, reading, grandchild, missing, archive };
}

export function dictionaryTabsFixture() {
  const nested = nestedLinksFixture();
  const rootReading = 'れんさご';
  const companions = [
    ['dictionary-tabs-usage', [
      { tag: 'p', content: 'Usage: a linked expression in running text.' },
      { tag: 'p', content: '用例を読み、前後の文脈から言葉の意味を確かめる。' },
    ]],
    ['dictionary-tabs-examples', [
      { tag: 'p', content: 'Examples in source order:' },
      { tag: 'ol', content: [
        '一つ目の例。', '二つ目の例は少し長く、使われる場面も示す。', '三つ目の例。',
      ].map(content => ({ tag: 'li', content })) },
    ]],
    ['dictionary-tabs-reference', [
      { tag: 'p', content: 'Reference: related meanings and usage.' },
    ]],
  ].map(([title, content]) => ({ title, archive: buildTitledZip(title, { terms: [
    [nested.query, rootReading, '', '', 0, [{ type: 'structured-content', content: { tag: 'div', content } }], 1, ''],
  ] }) }));
  return { ...nested, rootReading, dictionaries: [{ title: nested.title, archive: nested.archive }, ...companions] };
}

// A clicked-kanji group: two kanji-bank-only dictionaries and one term
// dictionary whose single-kanji entries answer the same characters (by default
// 食, the kanji the ordinary fixture's verb 食べる links to). In memory, so the
// generated fixture files and their documented counts are unchanged.
export function kanjiGroupFixture(entries = [['食', 'しょく']]) {
  const kanji = (title, meaning, strokes) => ({ title, kind: 'kanji', archive: buildZip([
    zipEntry('index.json', JSON.stringify({ ...index, title })),
    zipEntry('kanji_bank_1.json', JSON.stringify(entries.map(([character]) =>
      [character, 'ショク ジキ', 'く.う た.べる', 'jouyou', [meaning], { strokes }]))),
  ]) });
  const termTitle = 'kanji-group-terms';
  const termGlossary = 'kanji-group term single-kanji entry';
  return {
    character: entries[0][0],
    termGlossary,
    dictionaries: [
      kanji('kanji-group-first', 'kanji-group first meaning', '9'),
      { title: termTitle, kind: 'term', archive: buildTitledZip(termTitle, {
        terms: entries.map(([character, reading]) => [character, reading, '', '', 100, [termGlossary], 1, '']),
      }) },
      kanji('kanji-group-second', 'kanji-group second meaning', '9'),
    ],
  };
}

export function frequencyRankingFixture() {
  const query = '頻度語';
  const readings = ['あ', 'い', 'う'];
  const dictionaries = [
    ['Frequency rank mode', 'rank-based', [20, 10, 30]],
    ['Frequency occurrence mode', 'occurrence-based', [1, 2, 9]],
  ].map(([title, frequencyMode, values]) => ({
    title,
    frequencyMode,
    archive: buildTitledZip(title, {
      frequencyMode,
      terms: readings.map((reading, index) =>
        [query, reading, '', '', 30 - index * 10, [`${title}: ${reading}`], index, '']),
      termMeta: readings.map((reading, index) =>
        [query, 'freq', { reading, frequency: { value: values[index] } }]),
    }),
  }));
  return { query, dictionaries };
}

export function compactSummaryFixture() {
  const query = '要約', child = '要約語', summaryLookup = '短い説明', broken = '欠損図';
  const illustrated = 'compact-summary-illustrated', plain = 'compact-summary-text';
  const image = path => ({ tag: 'img', path, width: 16, height: 16 });
  const leading = [{ type: 'structured-content', content: { tag: 'div', content: [
    { tag: 'span', data: { content: 'part-of-speech' }, content: 'noun' },
    { ...image('media/kanji.png'), collapsed: true },
    { tag: 'ul', data: { content: 'glossary' }, content: [
      { tag: 'li', content: '短い説明 • • 使い方' }, { tag: 'li', content: '別の意味' },
    ] },
    { tag: 'a', href: `?query=${encodeURIComponent(child)}&primary_reading=${encodeURIComponent('ようやくご')}`,
      content: 'Open the related term' },
  ] } }];
  return { query, child, summaryLookup, broken, illustrated, plain, leading, dictionaries: [
    { title: illustrated, archive: buildTitledZip(illustrated, { mediaEntries: [['media/kanji.png', makePng()]], terms: [
      [query, 'ようやく', '', '', 0, leading, 1, ''],
      [child, 'ようやくご', '', '', 0, ['Text before the image.', image('media/kanji.png')], 2, ''],
      [summaryLookup, 'みじかいせつめい', '', '', 0, ['The compact summary lookup target.'], 3, ''],
      [broken, 'けっそんず', '', '', 0, [image('media/missing.png'), 'The text remains available.'], 4, ''],
    ] }) },
    { title: plain, archive: buildTitledZip(plain, { mediaEntries: [
      ['media/missing.png', Buffer.concat([makePng(), Buffer.from([1])])],
      ['media/kanji.png', Buffer.concat([makePng(), Buffer.from([1])])],
    ], terms: [
      [query, 'ようやく', '', '', 0, ['Alternative first', 'Alternative second'], 1, ''],
      [summaryLookup, 'みじかいせつめい', '', '', 0, ['Alternative compact summary target.'], 2, ''],
    ] }) },
  ] };
}

// 大辞泉's の nests part-of-speech groups, numbered senses, ㋐ sub-senses and
// ruby examples 25+ values deep, which is the shape that hit the former depth
// limit (#287). Placeholder text stands in for the publisher's; the hierarchy
// is what matters. `summary` is the compact preview the extractor owes each
// group: every gloss in order, without the part-of-speech label or examples.
export function structuredContentDeepFixture() {
  const title = 'structured-content-deep-fixture';
  const query = 'の';
  const leaf = '第一語義の細分㋑の説明。';
  const marked = (tag, marker, content) => ({ tag, data: { content: marker }, content });
  const example = () => marked('div', 'examples', [marked('span', 'example', [
    '「', { tag: 'ruby', content: ['用例', { tag: 'rt', content: 'ようれい' }] }, '」',
  ])]);
  const subsense = (mark, gloss) => ({ tag: 'li', content: [marked('div', 'subsense', [
    marked('span', 'sense-mark', mark),
    marked('span', 'gloss', [{ tag: 'span', lang: 'ja', content: gloss }]),
    example(),
  ])] });
  const sense = (number, gloss, subsenses = []) => ({ tag: 'li', content: [marked('div', 'sense', [
    marked('span', 'sense-number', number),
    marked('span', 'gloss', gloss),
    ...subsenses.length ? [marked('ol', 'subsenses', subsenses.map(entry => subsense(...entry)))] : [],
  ])] });
  const group = (partOfSpeech, senses) => ({ tag: 'li', content: [marked('div', 'sense-group', [
    marked('span', 'part-of-speech', partOfSpeech),
    marked('ol', 'senses', senses.map(entry => sense(...entry))),
  ])] });
  const glossary = [{ type: 'structured-content', content: [marked('div', 'entry', [
    marked('div', 'headword', [{ tag: 'span', lang: 'ja', content: query }]),
    marked('div', 'body', [marked('ol', 'sense-groups', [
      group('［格助］', [
        ['１', '第一語義の説明。', [['㋐', '第一語義の細分㋐の説明。'], ['㋑', leaf]]],
        ['２', '第二語義の説明。'],
      ]),
      group('［終助］', [['１', '第三語義の説明。']]),
    ])]),
  ])] }];
  return {
    title, query, leaf, glossary: JSON.stringify(glossary),
    summary: ['１第一語義の説明。㋐第一語義の細分㋐の説明。 ㋑第一語義の細分㋑の説明。 ２第二語義の説明。', '１第三語義の説明。'],
    archive: () => buildTitledZip(title, { terms: [[query, query, '', '', 0, glossary, 1, '']] }),
  };
}

export function imageSizingFixture() {
  const cases = [
    ['landscape', { width: 200, height: 100 }, 200, 50],
    ['portrait', { width: 67, height: 100 }, 67, 100 / 67 * 100],
    ['preferred width', { width: 200, height: 100, preferredWidth: 100 }, 100, 100],
    ['preferred height', { width: 200, height: 100, preferredHeight: 50 }, 100, 25],
    ['both preferred', { width: 200, height: 100, preferredWidth: 100, preferredHeight: 50 }, 100, 50],
    ['em', { width: 3, height: 2, sizeUnits: 'em' }, 3, 2 / 3 * 100],
    ['preferred em', { width: 3, height: 2, preferredWidth: 1.5, sizeUnits: 'em' }, 1.5, 2 / 1.5 * 100],
    ['tall aspect', { width: 1, height: 1e9 }, 1, 10_000],
    ['intermediate overflow', { width: 1e308, height: 1e308, preferredHeight: 100 }, 100, 1e-304],
    ['intermediate underflow', { width: Number.MIN_VALUE, height: Number.MIN_VALUE, preferredHeight: 0.5 }, 0.5, 10_000],
    ['second grouping overflow', { width: 1e-14, height: Number.MIN_VALUE, preferredHeight: 1e-310 }, 0.20240225330731, 1e-294],
    ['valid original grouping', { width: 1.5, height: Number.MIN_VALUE, preferredHeight: Number.MIN_VALUE }, 2, 0],
    ['over display width', { width: 1e308, height: 1, preferredHeight: 1e308 }, 1024, 100],
    ['under display width', { width: 1e-300, height: 1e300, preferredHeight: 1e-300 }, 0.1, 100],
  ].map(([name, dimensions, width, padding]) => ({ name, dimensions, width, padding }));
  const title = 'dictionary-image-sizing-fixture';
  const query = '画像寸法';
  const bytes = makePng();
  const path = 'media/sizing.png';
  const archive = buildTitledZip(title, { terms: [[query, 'がぞうすんぽう', '', '', 0,
    cases.map(({ name, dimensions }) => ({ type: 'structured-content', content: {
      tag: 'div', content: [name, { tag: 'img', path, alt: name, ...dimensions }],
    } })), 1, '']], mediaEntries: [[path, bytes]] });
  return { archive, bytes, cases, path, query, title };
}

// Meikyo-style gaiji: a PNG glyph, plus the shapes the real 明鏡国語辞典 第三版
// and 小学館例解学習国語 conversions use. Their gaiji are viewBox-only SVGs
// (no intrinsic size) sized by dictionary CSS in Yomitan's em-per-pixel
// convention, and their appendix entries hide a converter `<head>` tail
// through a Japanese-keyed data attribute.
export function gaijiSizingFixture() {
  const title = 'meikyo-gaiji-compat-fixture';
  const query = '外字表示';
  const path = 'gaiji/bs-arrow.png';
  const svgPath = 'gaiji/参考.svg';
  const bytes = makePng();
  const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
    + '<path d="M992,512L512,992L32,512L512,32Z" fill="#c00"/></svg>');
  const data = { class: 'gaiji', glyph: 'bs-arrow', 'unsafe key': 'ignored' };
  const svgData = { ...data, img: '' };
  // `width`/`height` are the rendered box in a real browser at the 16px
  // glossary font; `inlineWidth` is the style the renderer writes (null: the
  // decoded natural width in px).
  const cases = [
    { name: 'natural', dimensions: {}, inlineWidth: null, width: 16, height: 16 },
    { name: 'explicit', dimensions: { width: 40, height: 20 }, inlineWidth: '40px', width: 40, height: 20 },
    { name: 'em', dimensions: { width: 2, height: 1, sizeUnits: 'em' }, inlineWidth: '2em', width: 32, height: 16 },
    // Chrome decodes a viewBox-only SVG as 150x150; the dictionary's Yomitan
    // rule `width: 15em !important` must land at 15px, not 15 text ems.
    { name: 'viewbox-svg', path: svgPath, data: svgData, dimensions: {}, inlineWidth: null, width: 15, height: 15 },
  ];
  const hiddenHeadText = 'content="width=device-width, initial-scale = 1.0" />';
  const styles = [
    '.gloss-sc-span[data-sc-class="gaiji"] > .gloss-sc-a[data-sc-glyph="bs-arrow"] .gloss-sc-img {',
    '  filter: invert(0.9);',
    '}',
    'span[data-sc-img][data-sc-class="gaiji"] .gloss-image-container {',
    '  width: 15em !important;',
    '}',
    '[data-sc付録] [data-sc-head] {',
    '  display: none;',
    '}',
  ].join('\n');
  const archive = buildTitledZip(title, {
    mediaEntries: [[path, bytes], [svgPath, svgBytes]],
    styles,
    terms: [[query, 'がいじひょうじ', '', '', 0, [{
      type: 'structured-content',
      content: {
        tag: 'div',
        content: [
          ...cases.map((entry) => ({
            tag: 'p',
            content: [
              `${entry.name}: `,
              {
                tag: 'span',
                data: entry.data ?? data,
                content: { tag: 'img', path: entry.path ?? path, alt: `${entry.name} gaiji`, data: entry.data ?? data, ...entry.dimensions },
              },
            ],
          })),
          {
            tag: 'p',
            data: { '付録': '' },
            content: [
              { tag: 'span', data: { head: '' }, content: { tag: 'span', data: { meta: '', name: 'viewport' }, content: hiddenHeadText } },
              '記号一覧',
            ],
          },
        ],
      },
    }], 1, '']],
  });
  return { archive, bytes, cases, data, hiddenHeadText, path, query, styles, svgBytes, svgPath, title };
}

export function imagePreviewFixture() {
  // Genuine 16x16 AVIF, generated once with FFmpeg 7.0.1 / libaom-av1:
  // ffmpeg -f lavfi -i color=c=0x3676d9:s=16x16:d=0.04 -frames:v 1
  //   -c:v libaom-av1 -cpu-used 8 -crf 30 -still-picture 1 -f avif blue.avif
  // SHA-256: ef64ea8fb6ab6da6b0b2049d7102157c0c6ea587841b86efa6dcff55f72ee66b
  // Keeping the encoded bytes here avoids a test-time encoder dependency.
  const avif = Buffer.from(
    'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAA' +
    'AAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MA' +
    'AAAARAAAAQABAAAAAQAAASEAAAAaAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNv' +
    'bG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAQAAAAEAAAABBwaXhpAAAAAAMICAgA' +
    'AAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAi' +
    'bWRhdAoGGAz/2gCAMhAXgAAASAAQAprs5iUJK26P', 'base64');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64">' +
    '<rect width="96" height="64" fill="#edf5ff"/><circle cx="73" cy="17" r="9" fill="#ffd478"/>' +
    '<path d="M0 64V49L31 17L65 64Z" fill="#648f8c"/><path d="M34 64L69 29L96 55V64Z" fill="#3d6d70"/></svg>');
  const images = [
    { path: 'media/blue.avif', bytes: avif, type: 'image/avif', width: 16, height: 16, alt: 'Blue AVIF sample' },
    { path: 'media/mountains.svg', bytes: svg, type: 'image/svg+xml', width: 96, height: 64, alt: 'Mountain illustration' },
  ];
  const title = 'dictionary-image-preview-fixture';
  const query = '拡大画像';
  const archive = buildTitledZip(title, { terms: [[query, 'かくだいがぞう', '', '', 0, [
    'Hover or focus an image for a larger view.',
    { type: 'structured-content', content: [
      ...images.map(({ path, alt }) => ({ tag: 'img', path, width: 64, height: 64, alt })),
      { tag: 'p', content: 'The next illustration is farther down this definition. Tab to it to test keyboard focus.\n' + '\n'.repeat(35) },
      { tag: 'img', path: images[1].path, width: 64, height: 64, alt: 'Focus this illustration below the fold' },
      { tag: 'a', href: '?query=食べる', content: 'Look up 食べる' },
    ] },
  ], 1, '']], mediaEntries: images.map(({ path, bytes }) => [path, bytes]) });
  return { archive, images, query, title };
}

// Kanji dictionaries ship stroke-order strips and headword glyphs as
// black-on-transparent SVGs tagged `appearance: "monochrome"`, which Yomitan
// draws in the text colour. The same glyph is rendered once tagged and once
// untagged so the recolouring can be proven to touch only the tagged image.
export function monochromeImageFixture() {
  const title = 'dictionary-monochrome-image-fixture';
  const query = '単色画像';
  const path = 'media/glyph.svg';
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">'
    + '<rect x="10" y="10" width="80" height="80"/></svg>');
  const cases = [
    { name: 'monochrome', appearance: 'monochrome' },
    { name: 'auto', appearance: 'auto' },
  ];
  const archive = buildTitledZip(title, { terms: [[query, 'たんしょくがぞう', '', '', 0, [
    { type: 'structured-content', content: cases.map(({ name, appearance }) => ({
      tag: 'img', path, width: 64, height: 64, alt: `${name} glyph`, appearance,
    })) },
  ], 1, '']], mediaEntries: [[path, bytes]] });
  return { archive, bytes, cases, path, query, title };
}

// Small deterministic stand-ins for the recommended downloads. The browser
// suite serves these bytes for the production catalogue URLs, so CI exercises
// the complete download/import path without depending on live publishers.
// `paddingBytes` adds one stored media file so a real-Chrome download of the
// otherwise tiny archive arrives in several chunks and shows measurable progress.
export function buildRecommendedZip({
  title,
  revision,
  indexUrl,
  downloadUrl,
  capabilities,
  paddingBytes = 0,
}) {
  const supported = new Set(capabilities);
  const entries = [zipEntry('index.json', JSON.stringify({
    ...index,
    title,
    revision,
    isUpdatable: true,
    indexUrl,
    downloadUrl,
  }))];
  if (supported.has('term')) {
    entries.push(zipEntry('term_bank_1.json', JSON.stringify([
      ['辞書', 'じしょ', 'n', '', 1, [`${title} term fixture`], 1, ''],
      // The word the first-run practice sentence invites a real lookup of.
      ['食べる', 'たべる', 'v1', 'v1', 1, [`${title} verb fixture`], 2, ''],
    ])));
  }
  if (supported.has('freq')) {
    entries.push(zipEntry('term_meta_bank_1.json', JSON.stringify([
      ['辞書', 'freq', { value: 1, displayValue: '1' }],
    ])));
  }
  if (supported.has('pitch')) {
    entries.push(zipEntry('term_meta_bank_2.json', JSON.stringify([
      ['辞書', 'pitch', { reading: 'じしょ', pitches: [{ position: 1 }] }],
    ])));
  }
  if (supported.has('kanji')) {
    entries.push(zipEntry('kanji_bank_1.json', JSON.stringify([
      ['辞', 'ジ', 'や.める', '', ['word'], { strokes: '13' }],
    ])));
  }
  if (supported.has('media')) {
    entries.push(zipEntry('media/recommended.png', makePng(4), STORE));
  }
  if (paddingBytes > 0) {
    entries.push(zipEntry('media/padding.bin', Buffer.alloc(paddingBytes, 0x5a), STORE));
  }
  return buildZip(entries);
}

// A structurally valid archive with no index.json. dictionary_importer::import
// must report "could not find index.json" rather than throwing past the ABI.
export function buildNoIndexZip() {
  return buildZip([zipEntry('term_bank_1.json', JSON.stringify(TERMS))]);
}

// The preflight parser must reject an unreadable index before the importer can
// derive any filesystem path from archive data.
export function buildMalformedIndexZip() {
  return buildZip([zipEntry('index.json', '{"title":')]);
}

// Not an archive at all. zip.cpp's EOCD scan has to bottom out and fail.
export function buildNotAZip() {
  return utf8('this is not a zip file, it is a plain text file. '.repeat(3));
}

export const FORMER_ARCHIVE_LIMITS = {
  MAX_ENTRIES: 4096,
  MAX_ENTRY_UNCOMPRESSED: 268435456,
  MAX_TOTAL_UNCOMPRESSED: 1610612736,
  MAX_EXPANSION_RATIO: 512,
};

export const ARCHIVE_ERRORS = {
  entries: 'archive declares too many entries',
  entryExpanded: 'archive entry expands beyond the per-entry limit',
  totalExpanded: 'archive expands beyond the aggregate limit',
  ratio: 'archive entry compression ratio exceeds the limit',
  forgedSize: 'archive entry sizes disagree between headers',
  tinyCompressed: 'archive entry has no compressed data for its declared size',
};

function hostileBaseEntries() {
  return [];
}

export function buildEntryCountZip(count) {
  const entries = fixtureEntries();
  while (entries.length < count) {
    entries.push(zipEntry(`unused-${entries.length}/`, Buffer.alloc(0), STORE));
  }
  return buildZip(entries);
}

function deterministicBytes(size) {
  const bytes = Buffer.allocUnsafe(size);
  let state = 0x6d2b79f5;
  for (let i = 0; i < bytes.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

async function compressedPayload(size, noiseSize) {
  const compressor = createDeflateRaw({ level: 9 });
  const chunks = [];
  let checksum = 0;
  compressor.on('data', (chunk) => chunks.push(chunk));
  const ended = once(compressor, 'end');
  const write = async (chunk) => {
    checksum = crc32(chunk, checksum) >>> 0;
    if (!compressor.write(chunk)) {
      await once(compressor, 'drain');
    }
  };
  if (noiseSize > 0) {
    await write(deterministicBytes(noiseSize));
  }
  const zeros = Buffer.alloc(1024 * 1024);
  let remaining = size - noiseSize;
  while (remaining > 0) {
    const chunk = remaining >= zeros.length ? zeros : zeros.subarray(0, remaining);
    await write(chunk);
    remaining -= chunk.length;
  }
  compressor.end();
  await ended;
  return { body: Buffer.concat(chunks), crc: checksum, size };
}

function forgedEntry(entry) {
  return {
    name: entry.name,
    method: entry.method,
    body: entry.body,
    crc: entry.crc,
    lfhCompressed: entry.body.length,
    lfhUncompressed: entry.raw.length,
    cdCompressed: entry.body.length,
    cdUncompressed: entry.raw.length,
  };
}

function payloadEntry(payload) {
  return {
    name: 'styles.css',
    method: payload.method ?? DEFLATE,
    body: payload.body,
    crc: payload.crc,
    lfhCompressed: payload.body.length,
    lfhUncompressed: payload.size,
    cdCompressed: payload.body.length,
    cdUncompressed: payload.size,
  };
}

function forgedFixtureEntries() {
  return fixtureEntries().map(forgedEntry);
}

export async function buildEntryExpandedZip(size) {
  const noiseSize = Math.ceil(size / (FORMER_ARCHIVE_LIMITS.MAX_EXPANSION_RATIO - 64));
  const payload = await compressedPayload(size, noiseSize);
  if (size > payload.body.length * FORMER_ARCHIVE_LIMITS.MAX_EXPANSION_RATIO) {
    throw new Error('entry-expanded fixture also crosses the former ratio cap');
  }
  return forgeZip([...forgedFixtureEntries(), payloadEntry(payload)]);
}

export async function buildTotalExpandedZip(total) {
  const size = FORMER_ARCHIVE_LIMITS.MAX_ENTRY_UNCOMPRESSED / 2;
  const noiseSize = Math.ceil(size / (FORMER_ARCHIVE_LIMITS.MAX_EXPANSION_RATIO - 64));
  const payload = await compressedPayload(size, noiseSize);
  if (size > payload.body.length * FORMER_ARCHIVE_LIMITS.MAX_EXPANSION_RATIO) {
    throw new Error('aggregate fixture also crosses the former ratio cap');
  }
  const entries = forgedFixtureEntries();
  let remaining = total;
  while (remaining >= size) {
    entries.push(payloadEntry(payload));
    remaining -= size;
  }
  if (remaining > 0) {
    const body = Buffer.alloc(remaining);
    entries.push(payloadEntry({ body, crc: crc32(body) >>> 0, size: remaining, method: STORE }));
  }
  return forgeZip(entries);
}

export async function buildRatioZip(ratio) {
  const payload = await compressedPayload((ratio + 1) * 4096, 0);
  if (payload.size <= payload.body.length * ratio) {
    throw new Error('ratio fixture does not cross the requested ratio');
  }
  return forgeZip([...forgedFixtureEntries(), payloadEntry(payload)]);
}

// A deflate entry whose local and central uncompressed sizes disagree; the
// parser cannot trust either without the other agreeing.
export function buildForgedSizeZip() {
  const entries = hostileBaseEntries();
  const stream = deflateRawSync(utf8('x'), { level: 9 });
  entries.push({
    name: 'term_bank_1.json',
    method: DEFLATE,
    body: stream,
    crc: 0,
    lfhCompressed: stream.length,
    lfhUncompressed: 1,
    cdCompressed: stream.length,
    cdUncompressed: 4096,
  });
  return forgeZip(entries);
}

// A deflate entry that declares output but carries no compressed bytes, an
// impossible stream the reader must refuse before handing it to the decoder.
export function buildTinyCompressedZip() {
  const entries = hostileBaseEntries();
  entries.push({
    name: 'term_bank_1.json',
    method: DEFLATE,
    body: Buffer.alloc(0),
    crc: 0,
    lfhCompressed: 0,
    lfhUncompressed: 4096,
    cdCompressed: 0,
    cdUncompressed: 4096,
  });
  return forgeZip(entries);
}

const OUTPUTS = [
  ['hachidori-fixture.zip', buildFixtureZip],
  ['hachidori-fixture-trained.zip', buildTrainedZip],
  ['hachidori-fixture-many-banks.zip', buildManyBankZip],
  ['hachidori-generic-kanji-fixture.zip', buildGenericKanjiZip],
  ['parent-title.zip', () => buildTitledZip('..', { banks: false })],
  ['malformed-index.zip', buildMalformedIndexZip],
  ['no-index.zip', buildNoIndexZip],
  ['not-a-zip.txt', buildNotAZip],
  ['atomic-replacement-v1.zip', () => buildAtomicReplacementZip('1', 'atomic replacement version one')],
  ['atomic-replacement-v2.zip', () => buildAtomicReplacementZip('2', 'atomic replacement version two')],
  ['atomic-replacement-v3.zip', () => buildAtomicReplacementZip('3', 'atomic replacement separate copy')],
  ['atomic-replacement-same-v2.zip', () => buildAtomicReplacementZip('2', 'same revision reimport')],
  ['atomic-replacement-lower-v1.zip', () => buildAtomicReplacementZip('1', 'lower revision reimport')],
  ['atomic-replacement-missing-version.zip', () => buildAtomicReplacementZip(undefined, 'missing revision', {
    indexOverrides: { revision: undefined },
  })],
  ['atomic-replacement-malformed-version.zip', () => buildAtomicReplacementZip('2..1', 'malformed revision')],
  ['atomic-replacement-nonnumeric-version.zip', () => buildAtomicReplacementZip('release-two', 'nonnumeric revision')],
  ['atomic-replacement-corrupt.zip', () => buildAtomicReplacementZip('4', 'corrupt bank', { rawTermBank: '{' })],
];

export function writeFixtures(dir = FIXTURES) {
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, build] of OUTPUTS) {
    const bytes = build();
    const path = join(dir, name);
    writeFileSync(path, bytes);
    written.push({ path, name, bytes: bytes.length });
  }
  return written;
}

if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  for (const { path, bytes } of writeFixtures()) {
    console.log(`${bytes.toString().padStart(7)}  ${path}`);
  }
  console.log('\nexpected import counts:');
  for (const [k, v] of Object.entries(EXPECTED)) {
    console.log(`  ${k}: ${v}`);
  }
}
