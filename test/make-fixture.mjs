#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates test/fixtures/hdw-fixture.zip, a Yomitan format-3 dictionary that
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

import { deflateRawSync, crc32, deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

export const TITLE = 'hdw-fixture';
export const MEDIA_PATH = 'media/kanji.png';

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
  author: 'hoshidicts-web test harness',
  url: 'https://example.invalid/hdw-fixture',
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
      data: { hdw: 'entry' },
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
  '.hdw-fixture-table {',
  '  border-collapse: collapse;',
  '}',
  '.hdw-fixture-table th {',
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
// TERMS above stays deliberately under that floor at five rows, so importing the
// primary fixture still produces the pre-4 layout: .hoshidicts_3 and no
// dict.zstd, which is exactly what a dictionary imported by an older engine looks
// like. TRAINING_SAMPLE_FLOOR pins that, so growing TERMS past eight rows fails
// loudly in node-smoke.mjs instead of silently retiring the migration coverage.
//
// This fixture goes over the floor, so between the two every marker the engine
// can write is exercised.
export const TRAINING_SAMPLE_FLOOR = 8;

export const TRAINED_TITLE = 'hdw-fixture-trained';
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
export function buildTitledZip(title, { banks = true } = {}) {
  const entries = [zipEntry('index.json', JSON.stringify({ ...index, title }))];
  if (banks) {
    entries.push(zipEntry('term_bank_1.json', JSON.stringify(TERMS)));
  }
  return buildZip(entries);
}

// A structurally valid archive with no index.json. dictionary_importer::import
// must report "could not find index.json" rather than throwing past the ABI.
export function buildNoIndexZip() {
  return buildZip([zipEntry('term_bank_1.json', JSON.stringify(TERMS))]);
}

// Not an archive at all. zip.cpp's EOCD scan has to bottom out and fail.
export function buildNotAZip() {
  return utf8('this is not a zip file, it is a plain text file. '.repeat(3));
}

const OUTPUTS = [
  ['hdw-fixture.zip', buildFixtureZip],
  ['hdw-fixture-trained.zip', buildTrainedZip],
  ['no-index.zip', buildNoIndexZip],
  ['not-a-zip.txt', buildNotAZip],
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

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const { path, bytes } of writeFixtures()) {
    console.log(`${bytes.toString().padStart(7)}  ${path}`);
  }
  console.log('\nexpected import counts:');
  for (const [k, v] of Object.entries(EXPECTED)) {
    console.log(`  ${k}: ${v}`);
  }
}
