#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract test for the wasm C ABI. Runs the real hoshidicts.wasm on the real
// fixture dictionary in plain MEMFS and checks both the values and the JSON
// shape the extension is coded against.
//
// Zero dependencies, one shared module instance, assertions in dependency order
// (import -> add_dict -> lookup -> error paths -> reset). Every check prints its
// own PASS/FAIL line so a failure names exactly which part of the contract broke.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import {
  ARCHIVE_ERRORS,
  EXPECTED,
  EXPECTED_GLOSSARIES,
  FORMER_ARCHIVE_LIMITS,
  MANY_BANK_COUNT,
  MANY_BANK_TITLE,
  MEDIA_PATH,
  STYLES,
  TAGS,
  TERMS,
  LONG_KEY_TITLE,
  LONG_KEY_PROVERB,
  LONG_KEY_PHRASE,
  LONG_KEY_PHRASE_INFLECTED,
  LONG_KEY_PHRASE_SCORE,
  LONG_KEY_PROVERB_SCORE,
  LONG_KEY_LENGTH,
  buildLongKeyZip,
  TITLE,
  TRAINED_TERMS,
  TRAINED_TITLE,
  TRAINING_SAMPLE_FLOOR,
  buildDataDescriptorZip,
  buildUncompressedSizeDescriptorZip,
  buildZip64Zip,
  buildEntryCountZip,
  buildEntryExpandedZip,
  buildFixtureZip,
  buildForgedSizeZip,
  buildMalformedIndexZip,
  buildManyBankZip,
  buildNoIndexZip,
  buildNotAZip,
  buildRatioZip,
  buildTinyCompressedZip,
  buildTitledZip,
  buildTotalExpandedZip,
  buildTrainedZip,
  makePng,
  termKey,
  writeFixtures,
} from './make-fixture.mjs';
import {
  CUSTOM_DICTIONARY_TITLE,
  buildCustomDictionaryZip,
  customDictionarySemanticRevision,
  parseCustomDictionary,
} from '../extension/custom-dictionary.js';
import {
  REFERENCE_LINES,
  SEGMENTATION_DICTIONARY_TITLE,
  SEGMENTATION_FREQUENCY_TITLE,
  buildSegmentationDictionaryZip,
  buildSegmentationFrequencyZip,
  expectedSpans,
} from './segmentation-reference.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VARIANT = { fallback: 'hoshidicts', 'threaded-idbfs': 'hoshidicts-threaded-idbfs' }[process.env.HACHIDORI_WASM_VARIANT] ?? 'hoshidicts-threaded';
const MODULE_PATH = join(HERE, '..', 'extension', 'vendor', `${VARIANT}.mjs`);
const WASM_PATH = join(HERE, '..', 'extension', 'vendor', `${VARIANT}.wasm`);
const DICT_DIR = `/dicts/${TITLE}`;
const TRAINED_DIR = `/dicts/${TRAINED_TITLE}`;
const MANY_BANK_DIR = `/dicts/${MANY_BANK_TITLE}`;
const CUSTOM_DICTIONARY_DIR = `/dicts/${CUSTOM_DICTIONARY_TITLE}`;

// Every marker query.cpp still recognises, newest first. The importer writes
// .hoshidicts_6 when it trained a zstd dictionary for the term banks and
// .hoshidicts_5 when it did not, so a test that pins one specific marker pins
// which branch the fixture happened to take. _4 and _3 are the same pair from
// engines that stored the term score as an int32 rather than a double. This
// list is what both wasm/bindings.cpp's dictionary_files_present and
// engine-service.js's MARKER_FILES have to accept.
const MARKER_FILES = ['.hoshidicts_6', '.hoshidicts_5', '.hoshidicts_4', '.hoshidicts_3', '.hoshidicts_2', '.hoshidicts_1'];

// dict.zstd exists only alongside .hoshidicts_6 (or _4), so it is never part of
// the required set.
const REQUIRED_FILES = ['index.json', 'hash.table', 'bloom.filter', 'blobs.bin'];

// ---------------------------------------------------------------------------
// Tiny assert harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
let group = '';

const G = (name) => {
  group = name;
  console.log(`\n# ${name}`);
};

function check(name, fn) {
  const label = `${group} :: ${name}`;
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures.push({ label, message: e.message });
    console.log(`  FAIL  ${name}`);
    for (const line of String(e.message).split('\n')) console.log(`        ${line}`);
  }
}

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}\n  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
  }
}

function same(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected: ${b}\n  actual:   ${a}`);
}

// ---------------------------------------------------------------------------
// Structural validation of contract B
//
// A shape is 'string' | 'number' | 'int' | 'boolean', {key: shape} for an object
// with exactly that key set, or arrayOf(shape).
// ---------------------------------------------------------------------------

const arrayOf = (shape) => ({ __array: shape });

const TRACE = { name: 'string', description: 'string' };
const GLOSSARY = { dictionary: 'string', glossary: 'string', definitionTags: 'string', termTags: 'string' };
const FREQUENCY = { value: 'int', displayValue: 'string' };
const FREQUENCY_ENTRY = { dictionary: 'string', frequencies: arrayOf(FREQUENCY) };
const PITCH = { position: 'int', pattern: 'string', nasal: arrayOf('int'), devoice: arrayOf('int') };
const PITCH_ENTRY = { dictionary: 'string', pitches: arrayOf(PITCH), transcriptions: arrayOf('string') };
const TERM = {
  expression: 'string',
  reading: 'string',
  rules: 'string',
  // A double since .hoshidicts_5; older layouts hold an int32 and read back as
  // an integral number.
  score: 'number',
  glossaries: arrayOf(GLOSSARY),
  frequencies: arrayOf(FREQUENCY_ENTRY),
  pitches: arrayOf(PITCH_ENTRY),
};
const LOOKUP_RESULT = {
  matched: 'string',
  deinflected: 'string',
  trace: arrayOf(TRACE),
  term: TERM,
  preprocessorSteps: 'int',
};
const LOOKUP_RESPONSE = { results: arrayOf(LOOKUP_RESULT), dictionaryCount: 'int' };
const SEGMENT_CANDIDATE = { expression: 'string', reading: 'string' };
const SEGMENT_WORD = { start: 'int', length: 'int', functionWord: 'boolean', candidates: arrayOf(SEGMENT_CANDIDATE) };
const SEGMENT_SPAN = {
  start: 'int',
  length: 'int',
  functionWord: 'boolean',
  candidates: arrayOf(SEGMENT_CANDIDATE),
  alternative: arrayOf(SEGMENT_WORD),
};
const SEGMENT_RESPONSE = { spans: arrayOf(SEGMENT_SPAN) };
const KANJI_STAT = { name: 'string', value: 'string' };
const KANJI_ENTRY = {
  dictionary: 'string',
  onyomi: 'string',
  kunyomi: 'string',
  tags: 'string',
  definitions: arrayOf('string'),
  stats: arrayOf(KANJI_STAT),
};
const LOOKUP_KANJI = { character: 'string', entries: arrayOf(KANJI_ENTRY), frequencies: arrayOf(FREQUENCY_ENTRY) };
const STYLE = { dictionary: 'string', styles: 'string' };
const TAG = { name: 'string', category: 'string', order: 'number', notes: 'string', score: 'number' };
const DICTIONARY_TAGS = { dictionary: 'string', tags: arrayOf(TAG) };
// The fixture's tag bank as hdw_tags returns it, in bank order.
const FIXTURE_TAGS = [{ dictionary: TITLE, tags: TAGS.map(([name, category, order, notes, score]) =>
  ({ name, category, order, notes, score })) }];
const IMPORT_REPORT = {
  success: 'boolean',
  title: 'string',
  termCount: 'int',
  metaCount: 'int',
  frequencyCount: 'int',
  pitchCount: 'int',
  kanjiCount: 'int',
  mediaCount: 'int',
  skippedRecordCount: 'int',
  unresolvedRedirectCount: 'int',
  missingResourceCount: 'int',
  unreadableResourceCount: 'int',
  error: 'string',
};
// What a successful MDX import left out; a Yomitan archive reports 0 for each.
const MDX_LOSS_COUNTS = ['skippedRecordCount', 'unresolvedRedirectCount', 'missingResourceCount',
  'unreadableResourceCount'];

function shapeProblems(value, shape, path = '$', out = []) {
  if (typeof shape === 'string') {
    if (shape === 'int') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        out.push(`${path}: expected integer, got ${typeof value} ${show(value)}`);
      }
    } else if (typeof value !== shape) {
      out.push(`${path}: expected ${shape}, got ${typeof value} ${show(value)}`);
    }
    return out;
  }

  if (shape.__array) {
    if (!Array.isArray(value)) {
      out.push(`${path}: expected array, got ${typeof value} ${show(value)}`);
      return out;
    }
    value.forEach((item, i) => shapeProblems(item, shape.__array, `${path}[${i}]`, out));
    return out;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
    return out;
  }

  for (const key of Object.keys(shape)) {
    if (!Object.hasOwn(value, key)) out.push(`${path}.${key}: missing`);
    else shapeProblems(value[key], shape[key], `${path}.${key}`, out);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) out.push(`${path}.${key}: unexpected key (contract has no such field)`);
  }
  return out;
}

function conforms(value, shape, what) {
  const problems = shapeProblems(value, shape);
  if (problems.length) throw new Error(`${what} violates the JSON contract:\n  ${problems.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const REPO_ROOT = join(HERE, '..');
const shortPath = (p) => relative(REPO_ROOT, p) || p;

if (!existsSync(MODULE_PATH) || !existsSync(WASM_PATH)) {
  const missing = [MODULE_PATH, WASM_PATH].filter((p) => !existsSync(p));
  console.error(`node-smoke: ${missing.join('\nnode-smoke: ')}\nnot found.\n`);
  console.error('Build the wasm module first:\n');
  console.error('    ./wasm/build.sh\n');
  console.error('(that script sources wasm/env.sh, which puts a python >= 3.10 and emsdk on PATH)');
  process.exit(2);
}

console.log('writing fixtures:');
for (const { path, bytes } of writeFixtures()) {
  console.log(`  ${String(bytes).padStart(7)}  ${shortPath(path)}`);
}

const { default: createHoshidicts } = await import(MODULE_PATH);
const M = await createHoshidicts();

const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
const lastError = () => call('hdw_last_error', 'string', [], []);
const initStorage = (persistent = 0) => call('hdw_init_storage', 'number', ['number'], [persistent]);
const hdwImport = (zip, out, lowRam = 0) =>
  JSON.parse(call('hdw_import', 'string', ['string', 'string', 'number'], [zip, out, lowRam]));
const addDict = (path, kind, paged = 0) =>
  call('hdw_add_dict', 'number', ['string', 'number', 'number'], [path, kind, paged]);
const lookupRaw = (text, maxResults = 32, scanLength = 16, options = '') =>
  call('hdw_lookup', 'string', ['string', 'number', 'number', 'string'], [text, maxResults, scanLength, options]);
const lookup = (...args) => JSON.parse(lookupRaw(...args));
const lookupDictionary = (text, path, maxResults = 32, scanLength = 16, options = '') => JSON.parse(
  call(
    'hdw_lookup_dictionary',
    'string',
    ['string', 'string', 'number', 'number', 'string'],
    [text, path, maxResults, scanLength, options],
  ),
);
const segmentRaw = (text, scanLength = 16, options = '') =>
  call('hdw_segment', 'string', ['string', 'number', 'string'], [text, scanLength, options]);
const segment = (...args) => JSON.parse(segmentRaw(...args));
const kanji = (character) => JSON.parse(call('hdw_kanji', 'string', ['string'], [character]));
const styles = () => JSON.parse(call('hdw_styles', 'string', [], []));
const tags = () => JSON.parse(call('hdw_tags', 'string', [], []));
const media = (dictionary, path) => call('hdw_media', 'number', ['string', 'string'], [dictionary, path]);
const mediaBytes = (length) => {
  // 'pointer', as offscreen.js uses: only that return type is masked back to
  // unsigned, and with a heap grown past 2GB a raw i32 address reads negative.
  const ptr = call('hdw_media_data', 'pointer', [], []);
  return Uint8Array.from(M.HEAPU8.subarray(ptr, ptr + length));
};
const reset = () => call('hdw_reset', null, [], []);
const entriesOf = (dir) => M.FS.readdir(dir).filter((n) => n !== '.' && n !== '..');
const markerOf = (entries) => MARKER_FILES.find((m) => entries.includes(m));

// Plain MEMFS here; the browser asks the same ABI call for a persistent OPFS
// backend. Keeping creation behind the ABI makes both mounts exercise the same
// logical /dicts path.
M.FS.mkdir('/work');
G('hdw_init_storage');
check('native import exceptions keep their decoding and release helpers', () => {
  eq(typeof M.getExceptionMessage, 'function', 'getExceptionMessage');
  eq(typeof M.decrementExceptionRefcount, 'function', 'decrementExceptionRefcount');
});
check('memory storage initializes /dicts', () => {
  eq(initStorage(0), 1, `storage init failed: ${lastError()}`);
  ok(Array.isArray(M.FS.readdir('/dicts')), '/dicts was not created');
});
M.FS.writeFile('/work/fixture.zip', buildFixtureZip());
M.FS.writeFile('/work/malformed-index.zip', buildMalformedIndexZip());
M.FS.writeFile('/work/no-index.zip', buildNoIndexZip());
M.FS.writeFile('/work/not-a-zip.txt', buildNotAZip());

// ---------------------------------------------------------------------------

G('hdw_import');

const report = hdwImport('/work/fixture.zip', '/dicts');
console.log(`  actual counts: ${JSON.stringify(report)}`);

check('report conforms to ImportReport', () => conforms(report, IMPORT_REPORT, 'ImportReport'));
check('success', () => eq(report.success, true, `import failed: ${report.error}`));
check('error is empty on success', () => eq(report.error, '', 'error should be empty'));
check('title', () => eq(report.title, EXPECTED.title, 'title'));
for (const key of ['termCount', 'metaCount', 'frequencyCount', 'pitchCount', 'kanjiCount', 'mediaCount']) {
  check(key, () => eq(report[key], EXPECTED[key], key));
}
check('a Yomitan archive reports no MDX import losses', () => {
  for (const key of MDX_LOSS_COUNTS) eq(report[key], 0, key);
});
check('last_error cleared after a successful import', () => eq(lastError(), '', 'hdw_last_error'));
check('output directory laid out as add_dict expects', () => {
  const entries = entriesOf(DICT_DIR);
  ok(
    markerOf(entries) !== undefined,
    `${DICT_DIR} carries none of ${JSON.stringify(MARKER_FILES)}; got ${JSON.stringify(entries.sort())}`,
  );
  for (const required of REQUIRED_FILES) {
    ok(entries.includes(required), `${DICT_DIR}/${required} missing; got ${JSON.stringify(entries.sort())}`);
  }
});

// This fixture is the on-disk compatibility case: fewer term rows than train_zstd_dict needs,
// so the importer skips training and lays the directory out exactly the way every
// pre-4 engine did. Everything below that loads it is therefore also proof that a
// dictionary imported before the zstd-dictionary change still works.
check('the primary fixture stays under the zstd training floor', () =>
  ok(
    TERMS.length < TRAINING_SAMPLE_FLOOR,
    `TERMS has ${TERMS.length} rows; at ${TRAINING_SAMPLE_FLOOR} the importer starts training a zstd ` +
      `dictionary and this fixture stops covering the pre-4 layout`,
  ));

check('the untrained import is a .hoshidicts_5 directory with no dict.zstd', () => {
  const entries = entriesOf(DICT_DIR);
  eq(markerOf(entries), '.hoshidicts_5', `marker in ${DICT_DIR}: ${JSON.stringify(entries.sort())}`);
  ok(!entries.includes('dict.zstd'), 'dict.zstd should not exist without a trained dictionary');
});

// ---------------------------------------------------------------------------

G('mmap output files (Emscripten fd regression)');

// memory::map_rw ftruncates the file to its final length before mmapping it, so
// hash.table and bloom.filter are the right *size* even when the mapping's
// writes never reach the file. Before the wasm branch's fix that is exactly what
// happened: zero-filled tables, an import that still reported success, and every
// lookup silently returning nothing. Checking the length alone would not catch
// it, so these read the bytes and check the headers and the payload.
const hashTable = M.FS.readFile(`${DICT_DIR}/hash.table`);
const bloomFilter = M.FS.readFile(`${DICT_DIR}/bloom.filter`);
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

check('hash.table is non-empty', () => ok(hashTable.length > 0, 'hash.table has zero length'));
check('bloom.filter is non-empty', () => ok(bloomFilter.length > 0, 'bloom.filter has zero length'));

check('hash.table content is not zero-filled', () => {
  const capacity = view(hashTable).getUint32(0, true);
  ok(capacity >= 16, `capacity header is ${capacity}, expected >= 16 (zeroed file?)`);
  eq(hashTable.length, 4 + capacity * 16, 'hash.table length for the declared capacity');
  let occupied = 0;
  for (let slot = 0; slot < capacity; slot++) {
    if (view(hashTable).getBigUint64(4 + slot * 16, true) !== 0n) occupied++;
  }
  console.log(`        capacity=${capacity} occupied slots=${occupied}`);
  ok(occupied > 0, 'every hash slot is zero: the mmap writes never reached the file');
});

check('bloom.filter content is not zero-filled', () => {
  const v = view(bloomFilter);
  const numBits = Number(v.getBigUint64(0, true));
  const numHashes = Number(v.getBigUint64(8, true));
  ok(numBits >= 64 && (numBits & (numBits - 1)) === 0, `num_bits header is ${numBits}, expected a power of two >= 64`);
  eq(numHashes, 7, 'num_hashes header');
  eq(bloomFilter.length, 16 + numBits / 8, 'bloom.filter length for the declared num_bits');
  const set = bloomFilter.subarray(16).reduce((n, b) => n + (b === 0 ? 0 : 1), 0);
  console.log(`        num_bits=${numBits} non-zero payload bytes=${set}`);
  ok(set > 0, 'the whole bit array is zero: the mmap writes never reached the file');
});

// ---------------------------------------------------------------------------

G('hdw_add_dict');

// One imported directory registered under all four kinds. The fixture carries
// term, meta and kanji banks in a single zip, and DictionaryQuery keeps a
// separate vector per kind, so this is how one zip serves every query path.
const KINDS = { term: 0, freq: 1, pitch: 2, kanji: 3 };
for (const [name, kind] of Object.entries(KINDS)) {
  check(`kind ${kind} (${name}) accepted`, () => {
    eq(addDict(DICT_DIR, kind), 1, `add_dict(${name}) rejected: ${lastError()}`);
    eq(lastError(), '', 'hdw_last_error after a successful add_dict');
  });
}

const DICTIONARY_COUNT = Object.keys(KINDS).length;

// ---------------------------------------------------------------------------

G('memory (one heap copy per package; media, and paged entries, read from disk)');

// Emscripten's mmap copies a mapped file into linear memory. A package added
// as several kinds shares the kind added first (query.cpp add_dict_), media.bin
// is read from disk when a file is asked for, and a paged package keeps
// blobs.bin on disk as well and reads its pages through a bounded cache.
// engine-service.js's hd_memory counts the same files.
const INDEX_FILES = ['hash.table', 'bloom.filter', 'media.idx', 'scan.idx', 'dict.zstd'];
const fileBytes = (module, dir, names) => names.reduce((sum, name) => {
  try {
    return sum + module.FS.stat(`${dir}/${name}`).size;
  } catch {
    return sum;
  }
}, 0);
// Touch the heap through glue first: a pthread that grew the memory leaves
// this thread's view stale until then.
const heapOf = (module) => {
  module.FS.stat('/dicts');
  return module.HEAPU8.byteLength;
};
const heapBytes = () => heapOf(M);
const heapAfterImport = heapBytes();
console.log(`  heap after import + ${DICTIONARY_COUNT} adds: ${heapAfterImport}`);
check('the fixture carries every file the loader reads', () => {
  for (const name of ['hash.table', 'bloom.filter', 'blobs.bin', 'media.bin', 'media.idx']) {
    ok(M.FS.stat(`${DICT_DIR}/${name}`).size > 0, `${name} is empty or missing`);
  }
});

// Each measurement loads a copy of the fixture into a fresh module, with one
// file padded so that it dominates everything the loader could hold: the
// heap's growth over the adds then shows whether that file was copied in, and
// how often. Padding past the records changes no lookup.
const PAD_BYTES = 16 * 1024 * 1024;
const PARITY_WORDS = ['食べる', '食べたかった', '漢字', 'ありがとう', '読む', '食', 'みつからない'];
async function loadPaddedCopy({ padded, kinds, paged, indexPaged = 0 }) {
  const F = await createHoshidicts();
  const fcall = (name, ret, types, args) => F.ccall(name, ret, types, args);
  eq(fcall('hdw_init_storage', 'number', ['number'], [0]), 1, 'fresh module storage');
  F.FS.mkdir(DICT_DIR);
  for (const name of entriesOf(DICT_DIR)) {
    let bytes = M.FS.readFile(`${DICT_DIR}/${name}`);
    if (name === padded && name === 'hash.table') {
      const old = Buffer.from(bytes);
      const capacity = old.readUInt32LE(0) + PAD_BYTES / 16;
      const grown = Buffer.alloc(4 + capacity * 16);
      grown.writeUInt32LE(capacity);
      for (let at = 4; at < old.length; at += 16) {
        const hash = old.readBigUInt64LE(at);
        if (hash === 0n) continue;
        let pos = Number(hash % BigInt(capacity));
        while (grown.readBigUInt64LE(4 + pos * 16) !== 0n) pos = (pos + 1) % capacity;
        old.copy(grown, 4 + pos * 16, at, at + 16);
      }
      bytes = grown;
    } else if (name === padded) {
      const grown = new Uint8Array(bytes.length + PAD_BYTES);
      grown.set(bytes);
      bytes = grown;
    }
    F.FS.writeFile(`${DICT_DIR}/${name}`, bytes);
  }
  const before = heapOf(F);
  const allocatedBefore = JSON.parse(fcall('hdw_memory_stats', 'string', [], [])).liveAllocatedBytes;
  for (const kind of kinds) {
    eq(fcall('hdw_add_dict', 'number', ['string', 'number', 'number', 'number'], [DICT_DIR, kind, paged, indexPaged]), 1,
      `add kind ${kind}: ${fcall('hdw_last_error', 'string', [], [])}`);
  }
  const growth = heapOf(F) - before;
  const allocationDelta = JSON.parse(fcall('hdw_memory_stats', 'string', [], [])).liveAllocatedBytes - allocatedBefore;
  const lookups = PARITY_WORDS.map((word) =>
    fcall('hdw_lookup', 'string', ['string', 'number', 'number', 'string'], [word, 32, 16, '']));
  const kanjiJson = fcall('hdw_kanji', 'string', ['string'], ['食']);
  const mediaLength = fcall('hdw_media', 'number', ['string', 'string'], [TITLE, MEDIA_PATH]);
  const mediaPtr = fcall('hdw_media_data', 'pointer', [], []);
  const mediaCopy = Uint8Array.from(F.HEAPU8.subarray(mediaPtr, mediaPtr + mediaLength));
  const pageCacheBytes = fcall('hdw_page_cache_bytes', 'number', [], []);
  return { F, growth, allocationDelta, lookups, kanjiJson, mediaCopy, pageCacheBytes };
}

const ALL_KINDS = Object.values(KINDS);
const residentIndex = await loadPaddedCopy({ padded: 'hash.table', kinds: ALL_KINDS, paged: 1 });
const pagedIndex = await loadPaddedCopy({ padded: 'hash.table', kinds: ALL_KINDS, paged: 1, indexPaged: 1 });
check('paged hashes avoid the padded index allocation', () => {
  eq(residentIndex.allocationDelta >= PAD_BYTES, true, 'resident hash allocation');
  eq(pagedIndex.allocationDelta < PAD_BYTES, true, 'paged hash allocation');
});
check('paged hashes preserve complete term, inflection, frequency, pitch, kanji and media results', () => {
  eq(JSON.stringify(pagedIndex.lookups), JSON.stringify(residentIndex.lookups), 'lookup structures and order');
  eq(pagedIndex.kanjiJson, residentIndex.kanjiJson, 'kanji');
  eq(JSON.stringify([...pagedIndex.mediaCopy]), JSON.stringify([...residentIndex.mediaCopy]), 'media');
});
check('entry and hash pages use one cache and unload together', () => {
  const F = pagedIndex.F;
  const stats = JSON.parse(F.ccall('hdw_memory_stats', 'string', [], []));
  eq(stats.entries.bytes + stats.indexes.bytes, pagedIndex.pageCacheBytes, 'combined cache accounting');
  eq(stats.pageCacheBudgetBytes, 32 * 1024 * 1024, 'shared cache budget');
  eq(stats.indexes.reads > 0, true, 'index storage reads');
  eq(F.ccall('hdw_hash_index_paged', 'number', ['string'], [DICT_DIR]), 1, 'actual index storage');
  eq(F.ccall('hdw_remove_dict', 'number', ['string'], [DICT_DIR]), 4, 'all kinds removed');
  eq(F.ccall('hdw_page_cache_bytes', 'number', [], []), 0, 'cached generation released');
});
for (const copy of [residentIndex, pagedIndex]) if (copy.F.PThread) copy.F.PThread.terminateAllThreads();

const sharedCopy = await loadPaddedCopy({ padded: 'blobs.bin', kinds: ALL_KINDS, paged: 0 });
const sharedResident = fileBytes(sharedCopy.F, DICT_DIR, [...INDEX_FILES, 'blobs.bin']);
console.log(`  four kinds, blobs.bin padded: resident ${sharedResident}, heap growth ${sharedCopy.growth}`);
check('four kinds of one package hold one copy of its files', () => {
  ok(sharedCopy.growth >= PAD_BYTES / 2, `heap grew ${sharedCopy.growth}; was the padded blobs.bin copied in at all?`);
  ok(sharedCopy.growth < 2 * sharedResident, `heap grew ${sharedCopy.growth} for ${sharedResident} resident bytes`);
});

const mediaCopy = await loadPaddedCopy({ padded: 'media.bin', kinds: [KINDS.term], paged: 0 });
const mediaFileBytes = fileBytes(mediaCopy.F, DICT_DIR, ['media.bin']);
console.log(`  media.bin padded to ${mediaFileBytes}: heap growth ${mediaCopy.growth}`);
check('media.bin stays on disk', () => {
  ok(mediaCopy.growth < mediaFileBytes / 4, `heap grew ${mediaCopy.growth} for a ${mediaFileBytes}-byte media.bin`);
  ok(Buffer.from(mediaCopy.mediaCopy).equals(makePng()), 'media read from disk differs from the archived bytes');
});

const pagedCopy = await loadPaddedCopy({ padded: 'blobs.bin', kinds: ALL_KINDS, paged: 1 });
const pagedBlobs = fileBytes(pagedCopy.F, DICT_DIR, ['blobs.bin']);
console.log(`  paged, blobs.bin padded to ${pagedBlobs}: heap growth ${pagedCopy.growth}, `
  + `page cache after lookups ${pagedCopy.pageCacheBytes}`);
check('a paged package keeps blobs.bin on disk', () => {
  ok(pagedCopy.growth < pagedBlobs / 4, `heap grew ${pagedCopy.growth} for a ${pagedBlobs}-byte blobs.bin`);
  ok(pagedCopy.pageCacheBytes > 0 && pagedCopy.pageCacheBytes < pagedBlobs,
    `page cache holds ${pagedCopy.pageCacheBytes} of ${pagedBlobs} bytes`);
});
check('paged and mapped entries answer with byte-identical JSON', () => {
  PARITY_WORDS.forEach((word, index) => {
    eq(pagedCopy.lookups[index], sharedCopy.lookups[index], `hdw_lookup(${word})`);
    eq(pagedCopy.lookups[index], lookupRaw(word, 32, 16, ''), `hdw_lookup(${word}) against the unpadded package`);
  });
  const withTerms = sharedCopy.lookups.map((json) => JSON.parse(json).results[0]?.term).filter(Boolean);
  ok(withTerms.some((term) => term.frequencies.length > 0) && withTerms.some((term) => term.pitches.length > 0),
    'the parity words cover frequency and pitch data');
  eq(pagedCopy.kanjiJson, sharedCopy.kanjiJson, 'hdw_kanji(食)');
  ok(JSON.parse(pagedCopy.kanjiJson).entries.length > 0, 'the parity kanji has an entry');
  ok(Buffer.from(pagedCopy.mediaCopy).equals(Buffer.from(sharedCopy.mediaCopy)), 'hdw_media bytes');
});
check('a mapped engine reports no page cache', () => {
  eq(sharedCopy.pageCacheBytes, 0, 'mapped page cache bytes');
  eq(call('hdw_page_cache_bytes', 'number', [], []), 0, 'main module page cache bytes');
});

// ---------------------------------------------------------------------------

G('hdw_lookup');

const AUTO_OPTIONS = JSON.stringify({ frequencyDictionary: '', frequencyOrder: 'auto', primaryReading: '' });

check('response conforms to the lookup contract', () => {
  conforms(lookup('食べたかった', 32, 16, AUTO_OPTIONS), LOOKUP_RESPONSE, 'lookup response');
});

check('dictionaryCount counts every successful add_dict', () => {
  eq(lookup('食べる').dictionaryCount, DICTIONARY_COUNT, 'dictionaryCount');
});

// The primary fixture carries a single-kanji 食 term (for the clicked-kanji
// generic-dictionary path), so a scan of a 食… surface now also matches that
// shorter headword. The verb stays first (results are ordered by scan length),
// and the only extra row is that 食 entry.
const verbAndKanji = (results) => {
  eq(results.length, 2, 'result count');
  const extra = results[1];
  eq(extra.matched, '食', 'the extra match is the single-kanji headword');
  eq(extra.term.expression, '食', 'extra expression');
  return results[0];
};

check('exact match', () => {
  const { results } = lookup('食べる');
  const r = verbAndKanji(results);
  eq(r.matched, '食べる', 'matched');
  eq(r.deinflected, '食べる', 'deinflected');
  same(r.trace, [], 'trace should be empty for an uninflected match');
  eq(r.preprocessorSteps, 0, 'preprocessorSteps');
  eq(r.term.expression, '食べる', 'expression');
  eq(r.term.reading, 'たべる', 'reading');
  eq(r.term.rules, 'v1', 'rules');
  eq(r.term.score, 120, 'score should be the max across merged entries');
});

check('glossaries arrive raw, in term-bank order, one per bank row', () => {
  const { glossaries } = lookup('食べる').results[0].term;
  same(
    glossaries.map((g) => g.glossary),
    EXPECTED_GLOSSARIES.get(termKey('食べる', 'たべる')),
    'raw glossary strings',
  );
  same(
    glossaries.map((g) => [g.dictionary, g.definitionTags, g.termTags]),
    [
      [TITLE, 'vt', 'ichidan'],
      [TITLE, 'col', 'ichidan'],
    ],
    'per-glossary dictionary and tags',
  );
});

check('structured-content glossary is not pre-parsed', () => {
  const { glossaries } = lookup('漢字').results[0].term;
  eq(glossaries.length, 1, 'glossary count');
  const raw = glossaries[0].glossary;
  same([raw], EXPECTED_GLOSSARIES.get(termKey('漢字', 'かんじ')), 'raw structured-content string');
  const parsed = JSON.parse(raw);
  eq(parsed[0].type, 'structured-content', 'glossary[0].type');
  eq(parsed[1], 'Chinese character', 'glossary[1] plain string');
  const div = parsed[0].content[0];
  eq(div.tag, 'div', 'nested root tag');
  const tags = div.content.map((c) => c.tag);
  same(tags, ['span', 'ul', 'table', 'img'], 'nested child tags');
  eq(div.content[3].path, MEDIA_PATH, 'img path');
});

check('deinflected match records the transform chain', () => {
  const { results } = lookup('食べたかった');
  const r = verbAndKanji(results);
  eq(r.matched, '食べたかった', 'matched should be the surface form');
  eq(r.deinflected, '食べる', 'deinflected should be the dictionary form');
  same(
    r.trace.map((t) => t.name),
    ['-た', '-たい'],
    'trace names, in application order',
  );
  ok(
    r.trace.every((t) => t.description.length > 0),
    'every trace step should carry a description',
  );
  eq(r.term.expression, '食べる', 'expression');
});

check('deinflection survives a five-step chain', () => {
  const { results } = lookup('食べさせられたくなかった');
  const primary = verbAndKanji(results);
  same(
    primary.trace.map((t) => t.name),
    ['-た', 'negative', '-たい', 'potential or passive', 'causative'],
    'trace names',
  );
  eq(primary.term.expression, '食べる', 'expression');
});

check('kana-only entry (empty reading in the bank)', () => {
  const { results } = lookup('ありがとう');
  eq(results.length, 1, 'result count');
  eq(results[0].term.expression, 'ありがとう', 'expression');
  eq(results[0].term.reading, 'ありがとう', 'reading should fall back to the expression');
  eq(results[0].term.rules, '', 'rules');
  same(
    results[0].term.glossaries.map((g) => g.glossary),
    EXPECTED_GLOSSARIES.get(termKey('ありがとう', '')),
    'glossary',
  );
});

check('reading-only query reaches the kanji headword', () => {
  const { results } = lookup('たべる');
  eq(results.length, 1, 'result count');
  eq(results[0].matched, 'たべる', 'matched');
  eq(results[0].term.expression, '食べる', 'expression');
});

check('text preprocessing preserves raw matched kana, width, decomposition, and kanji variants', () => {
  for (const [query, expression] of [
    ['タベル', '食べる'], ['ﾀﾍﾞﾙ', '食べる'], ['たへ\u3099る', '食べる'], ['讀む', '読む'],
  ]) {
    const { results } = lookup(query);
    eq(results.length, 1, `${query}: result count`);
    eq(results[0].matched, query, `${query}: matched`);
    eq(results[0].term.expression, expression, `${query}: expression`);
    ok(results[0].preprocessorSteps > 0, `${query}: normalization should cost preprocessor steps`);
  }
});

check('miss returns an empty result set, not an error', () => {
  for (const text of ['犬猫鳥', 'xyzzy']) {
    const response = lookup(text);
    same(response.results, [], `results for ${text}`);
    eq(response.dictionaryCount, DICTIONARY_COUNT, 'dictionaryCount on a miss');
  }
  eq(lastError(), '', 'a miss is not an error');
});

check('maxResults 0 and empty text are treated as no-ops', () => {
  same(lookup('食べる', 0).results, [], 'maxResults 0');
  same(lookup('食べる', 32, 0).results, [], 'scanLength 0');
  same(lookup('').results, [], 'empty text');
});

// ---------------------------------------------------------------------------

G('frequencies and pitches');

check('nested {"frequency":{...}} meta shape', () => {
  same(
    lookup('食べる').results[0].term.frequencies,
    [{ dictionary: TITLE, frequencies: [{ value: 142, displayValue: '142位' }] }],
    'frequencies',
  );
});

check('flat {"value":...} meta shape', () => {
  same(
    lookup('読む').results[0].term.frequencies,
    [{ dictionary: TITLE, frequencies: [{ value: 88, displayValue: '88' }] }],
    'frequencies',
  );
});

check('pitch positions, patterns, nasal and devoice', () => {
  const { pitches } = lookup('食べる').results[0].term;
  eq(pitches.length, 1, 'one pitch entry per pitch dictionary');
  eq(pitches[0].dictionary, TITLE, 'dictionary');
  same(
    pitches[0].pitches,
    [
      { position: 2, pattern: '', nasal: [], devoice: [] },
      { position: 0, pattern: '', nasal: [1], devoice: [1, 2] },
      { position: 0, pattern: 'LHH', nasal: [], devoice: [] },
    ],
    'pitches: int position, bare-int nasal, array devoice, string position as pattern',
  );
});

check('ipa transcriptions merge into the same pitch entry', () => {
  same(lookup('食べる').results[0].term.pitches[0].transcriptions, ['tabeɾɯ'], 'transcriptions');
});

// ---------------------------------------------------------------------------

G('text frequencies');

// Yomitan's schema lets a frequency be a string, bare or under a reading, and
// some lists store every rank that way (monogatari: "324/37459"). As in
// Yomitan's Translator._getFrequencyInfo, the text is displayed unchanged and
// its first number is the value. The package gets its own output directory so
// the /dicts checks below still see only the fixture.
const TEXT_FREQUENCY_TITLE = 'text-frequency-fixture';
const TEXT_FREQUENCY_OUT = '/work/text-frequency';
M.FS.mkdir(TEXT_FREQUENCY_OUT);
M.FS.writeFile('/work/text-frequency.zip', buildTitledZip(TEXT_FREQUENCY_TITLE, {
  banks: false,
  termMeta: [
    ['食べる', 'freq', '324/37459'],
    ['読む', 'freq', { reading: 'よむ', frequency: 'five (5)' }],
    ['読む', 'freq', { reading: 'とく', frequency: 'six (6)' }],
  ],
}));
const textFrequencyReport = hdwImport('/work/text-frequency.zip', TEXT_FREQUENCY_OUT);
check('a frequency-only archive of text values imports', () => {
  eq(textFrequencyReport.success, true, `import failed: ${textFrequencyReport.error}`);
  eq(textFrequencyReport.frequencyCount, 3, 'frequencyCount');
});
eq(addDict(`${TEXT_FREQUENCY_OUT}/${TEXT_FREQUENCY_TITLE}`, KINDS.freq), 1, `add text frequencies: ${lastError()}`);

check('a bare text frequency shows its text, with its first number as the value', () => {
  same(
    lookup('食べる').results[0].term.frequencies,
    [
      { dictionary: TITLE, frequencies: [{ value: 142, displayValue: '142位' }] },
      { dictionary: TEXT_FREQUENCY_TITLE, frequencies: [{ value: 324, displayValue: '324/37459' }] },
    ],
    'frequencies',
  );
});

check('a text frequency under a reading applies to that reading only', () => {
  same(
    lookup('読む').results[0].term.frequencies,
    [
      { dictionary: TITLE, frequencies: [{ value: 88, displayValue: '88' }] },
      { dictionary: TEXT_FREQUENCY_TITLE, frequencies: [{ value: 5, displayValue: 'five (5)' }] },
    ],
    'frequencies',
  );
});

// ---------------------------------------------------------------------------

G('hdw_kanji / hdw_styles / hdw_tags / hdw_media');

check('kanji hit conforms and carries sorted stats', () => {
  const result = kanji('食');
  conforms(result, LOOKUP_KANJI, 'LookupKanji');
  eq(result.character, '食', 'character');
  eq(result.entries.length, 1, 'entry count');
  const e = result.entries[0];
  eq(e.dictionary, TITLE, 'dictionary');
  eq(e.onyomi, 'ショク ジキ', 'onyomi');
  eq(e.kunyomi, 'く.う た.べる', 'kunyomi');
  eq(e.tags, 'jouyou grade2', 'tags');
  same(e.definitions, ['food', 'eat', 'meal'], 'definitions');
  // The engine stores stats in an unordered_map; the binding sorts by name.
  same(
    e.stats,
    [
      { name: 'freq', value: '382' },
      { name: 'grade', value: '2' },
      { name: 'strokes', value: '9' },
    ],
    'stats, sorted by name',
  );
});

check('kanji miss returns the documented empty sentinel', () => {
  for (const character of ['犬', '']) {
    same(kanji(character), { character: '', entries: [], frequencies: [] }, `kanji(${show(character)})`);
  }
});

// MarvNC's kanji frequency lists hold nothing but a kanji_meta_bank (#512).
// Loaded as a frequency dictionary, their rows reach a kanji lookup and not a
// term spelled with the same character.
const KANJI_FREQUENCY_TITLE = 'kanji-frequency-fixture';
const KANJI_FREQUENCY_OUT = '/work/kanji-frequency';
M.FS.mkdir(KANJI_FREQUENCY_OUT);
M.FS.writeFile('/work/kanji-frequency.zip', buildTitledZip(KANJI_FREQUENCY_TITLE, {
  banks: false,
  frequencyMode: 'rank-based',
  kanjiMeta: [['食', 'freq', { value: 7, displayValue: '7 (12732)' }], ['飲', 'freq', 9]],
}));
const kanjiFrequencyReport = hdwImport('/work/kanji-frequency.zip', KANJI_FREQUENCY_OUT);
check('a kanji_meta_bank-only archive imports as a frequency dictionary', () => {
  eq(kanjiFrequencyReport.success, true, `import failed: ${kanjiFrequencyReport.error}`);
  eq(kanjiFrequencyReport.termCount, 0, 'termCount');
  eq(kanjiFrequencyReport.kanjiCount, 0, 'kanjiCount');
  eq(kanjiFrequencyReport.frequencyCount, 2, 'frequencyCount');
});
eq(addDict(`${KANJI_FREQUENCY_OUT}/${KANJI_FREQUENCY_TITLE}`, KINDS.freq), 1, `add kanji frequencies: ${lastError()}`);

check('a kanji lookup carries the kanji frequencies', () => {
  const result = kanji('食');
  conforms(result, LOOKUP_KANJI, 'LookupKanji');
  same(
    result.frequencies,
    [{ dictionary: KANJI_FREQUENCY_TITLE, frequencies: [{ value: 7, displayValue: '7 (12732)' }] }],
    'frequencies',
  );
});

check('a term spelled like the kanji gets no kanji frequency', () => {
  const dictionaries = (lookup('食').results[0]?.term.frequencies ?? []).map(({ dictionary }) => dictionary);
  ok(!dictionaries.includes(KANJI_FREQUENCY_TITLE), `term frequencies: ${JSON.stringify(dictionaries)}`);
});

check('styles come from the imported index.json', () => {
  const result = styles();
  conforms(result, arrayOf(STYLE), 'hdw_styles');
  same(result, [{ dictionary: TITLE, styles: STYLES }], 'styles');
});

check('tag banks come from the imported index.json, every row in bank order', () => {
  const result = tags();
  eq(lastError(), '', 'hdw_last_error');
  conforms(result, arrayOf(DICTIONARY_TAGS), 'hdw_tags');
  same(result, FIXTURE_TAGS, 'tags');
});

check('media returns the byte length and the real file bytes', () => {
  const expected = makePng();
  const length = media(TITLE, MEDIA_PATH);
  eq(length, expected.length, 'byte length');
  const bytes = mediaBytes(length);
  same(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG signature in the returned bytes',
  );
  ok(Buffer.from(bytes).equals(expected), 'returned bytes differ from the fixture file');
});

check('media absence returns 0 without setting an error', () => {
  eq(media(TITLE, 'media/nope.png'), 0, 'unknown path');
  eq(lastError(), '', 'a missing media file is not an error');
  eq(media('no-such-dictionary', MEDIA_PATH), 0, 'unknown dictionary');
  eq(lastError(), '', 'an unknown dictionary is not an error');
});

check('media with a null argument is rejected, not crashed', () => {
  eq(media(TITLE, null), 0, 'null path');
  ok(lastError().length > 0, 'hdw_last_error should be populated');
});

// ---------------------------------------------------------------------------

G('error paths (none may abort the module)');

check('importing a plain text file fails cleanly', () => {
  const r = hdwImport('/work/not-a-zip.txt', '/dicts');
  conforms(r, IMPORT_REPORT, 'ImportReport');
  eq(r.success, false, 'success');
  eq(r.error, 'failed to open zip', 'error');
  eq(lastError(), r.error, 'hdw_last_error should mirror report.error');
});

check('importing a zip with no index.json fails cleanly', () => {
  const r = hdwImport('/work/no-index.zip', '/dicts');
  eq(r.success, false, 'success');
  eq(r.error, 'could not find index.json', 'error');
  eq(r.title, '', 'title');
  eq(lastError(), r.error, 'hdw_last_error');
});

check('an unreadable index is rejected by the preflight before import', () => {
  const r = hdwImport('/work/malformed-index.zip', '/dicts');
  eq(r.success, false, 'success');
  eq(r.error, 'could not parse index.json before import', 'error');
  eq(r.title, '', 'title');
  eq(lastError(), r.error, 'hdw_last_error');
});

check('importing a path that does not exist fails cleanly', () => {
  const r = hdwImport('/work/absent.zip', '/dicts');
  eq(r.success, false, 'success');
  ok(r.error.length > 0, 'error should be populated');
  ok(lastError().length > 0, 'hdw_last_error should be populated');
});

check('a failed import leaves the already-imported dictionary alone', () => {
  const entries = M.FS.readdir('/dicts').filter((n) => n !== '.' && n !== '..');
  same(entries, [TITLE], '/dicts contents');
});

check('add_dict rejects an empty path', () => {
  eq(addDict('', 0), 0, 'return value');
  eq(lastError(), 'empty dictionary path', 'hdw_last_error');
});

check('add_dict rejects a directory with no version marker', () => {
  eq(addDict('/work', 0), 0, 'return value');
  eq(lastError(), 'not an imported dictionary directory: /work', 'hdw_last_error');
});

check('add_dict rejects a directory that does not exist', () => {
  eq(addDict('/dicts/absent', 0), 0, 'return value');
  eq(lastError(), 'not an imported dictionary directory: /dicts/absent', 'hdw_last_error');
});

check('add_dict rejects out-of-range kinds', () => {
  for (const kind of [-1, 4, 7]) {
    eq(addDict(DICT_DIR, kind), 0, `kind ${kind} return value`);
    eq(lastError(), `unknown dictionary kind ${kind}`, `kind ${kind} hdw_last_error`);
  }
});

check('malformed options_json falls back instead of throwing', () => {
  for (const options of ['{', '{"frequencyOrder":42}', 'not json at all', '[]']) {
    const raw = lookupRaw('食べる', 32, 16, options);
    // The documented fallback body. dictionaryCount is 0 here even though
    // dictionaries are loaded, because the fallback is a literal.
    eq(raw, '{"results":[],"dictionaryCount":0}', `fallback body for options ${show(options)}`);
    ok(lastError().length > 0, `hdw_last_error should be populated for options ${show(options)}`);
  }
});

check('unset options are accepted in every documented spelling', () => {
  for (const options of ['', null, AUTO_OPTIONS, '{}', '{"bogus":1,"frequencyOrder":"auto"}']) {
    const { results } = lookup('食べる', 32, 16, options);
    eq(results.length, 2, `results for options ${show(options)}`);
    eq(results[0].term.expression, '食べる', `verb result for options ${show(options)}`);
    eq(lastError(), '', `hdw_last_error for options ${show(options)}`);
  }
  for (const order of ['auto', 'ascending', 'descending', 'disabled']) {
    const options = JSON.stringify({ frequencyDictionary: TITLE, frequencyOrder: order, primaryReading: 'たべる' });
    eq(lookup('食べる', 32, 16, options).results.length, 2, `results for frequencyOrder ${order}`);
  }
});

check('the module is still alive after every error path', () => {
  eq(lookup('食べたかった').results[0].term.expression, '食べる', 'expression');
  eq(kanji('食').entries.length, 1, 'kanji entry count');
  eq(media(TITLE, MEDIA_PATH), makePng().length, 'media byte length');
});

// ---------------------------------------------------------------------------

G('archive parsing without fixed resource caps');

let hostileSeq = 0;
const importHostile = (bytes) => {
  const path = `/work/hostile-${hostileSeq++}.zip`;
  M.FS.writeFile(path, bytes);
  const r = hdwImport(path, '/dicts');
  try {
    M.FS.unlink(path);
  } catch {
    // never written
  }
  return r;
};
const rejectedWith = (bytes, message, what) => {
  const r = importHostile(bytes);
  eq(r.success, false, `${what} should be rejected`);
  eq(r.error, message, `${what} error`);
  eq(lastError(), message, `${what} hdw_last_error`);
};
const acceptedWithoutResourceCap = (bytes, what) => {
  const r = importHostile(bytes);
  same(
    {
      title: r.title,
      termCount: r.termCount,
      metaCount: r.metaCount,
      frequencyCount: r.frequencyCount,
      pitchCount: r.pitchCount,
      kanjiCount: r.kanjiCount,
      mediaCount: r.mediaCount,
    },
    EXPECTED,
    `${what} import report`,
  );
  eq(r.success, true, `${what} success: ${r.error}`);
  reset();
  eq(addDict(DICT_DIR, 0), 1, `${what} add_dict: ${lastError()}`);
  eq(lookup('食べたかった').results[0].term.expression, '食べる', `${what} lookup`);
};

const resourceBoundaryArchives = {
  entries: buildEntryCountZip(FORMER_ARCHIVE_LIMITS.MAX_ENTRIES + 1),
  entryExpanded: await buildEntryExpandedZip(FORMER_ARCHIVE_LIMITS.MAX_ENTRY_UNCOMPRESSED + 1),
  totalExpanded: await buildTotalExpandedZip(FORMER_ARCHIVE_LIMITS.MAX_TOTAL_UNCOMPRESSED + 1),
  ratio: await buildRatioZip(FORMER_ARCHIVE_LIMITS.MAX_EXPANSION_RATIO + 1),
};

check('entry counts above the former cap are not rejected by a fixed limit', () =>
  acceptedWithoutResourceCap(resourceBoundaryArchives.entries, 'entry count'));

check('expanded entries above the former cap are not rejected by a fixed limit', () =>
  acceptedWithoutResourceCap(resourceBoundaryArchives.entryExpanded, 'expanded entry'));

check('aggregate expanded bytes above the former cap are not rejected by a fixed limit', () =>
  acceptedWithoutResourceCap(resourceBoundaryArchives.totalExpanded, 'aggregate expanded bytes'));

check('compression ratios above the former cap are not rejected by a fixed limit', () =>
  acceptedWithoutResourceCap(resourceBoundaryArchives.ratio, 'compression ratio'));

check('a forged local/central size disagreement is refused', () =>
  rejectedWith(buildForgedSizeZip(), ARCHIVE_ERRORS.forgedSize, 'forged size'));

check('entries that defer their sizes to data descriptors import like the fixture (#491)', () =>
  acceptedWithoutResourceCap(buildDataDescriptorZip(), 'data descriptors'));

check('data-descriptor entries whose local headers keep the uncompressed size import (#512)', () =>
  acceptedWithoutResourceCap(buildUncompressedSizeDescriptorZip(), 'uncompressed-size descriptors'));

check('entries whose sizes and offsets are in Zip64 extra fields import like the fixture', () =>
  acceptedWithoutResourceCap(buildZip64Zip('both'), 'Zip64 extra fields'));

check('Zip64 entries whose local headers keep only the sentinel, as zip.js writes them, import', () =>
  acceptedWithoutResourceCap(buildZip64Zip('central'), 'zip.js Zip64'));

check('a data-descriptor entry whose local header records other sizes is refused', () =>
  rejectedWith(buildForgedSizeZip({ dataDescriptor: true }), ARCHIVE_ERRORS.forgedSize, 'forged descriptor size'));

check('a deflate entry with no compressed data for its declared size is refused', () =>
  rejectedWith(buildTinyCompressedZip(), ARCHIVE_ERRORS.tinyCompressed, 'tiny compressed'));

check('a failed malformed import leaves the already-imported dictionary alone', () => {
  const entries = M.FS.readdir('/dicts').filter((n) => n !== '.' && n !== '..');
  same(entries, [TITLE], '/dicts contents');
});

check('the module is still alive after malformed-archive rejection', () => {
  eq(lookup('食べたかった').results[0].term.expression, '食べる', 'expression');
});

// ---------------------------------------------------------------------------

G('hdw_reset');

reset();

check('reset drops every dictionary', () => {
  eq(lastError(), '', 'hdw_last_error');
  same(lookup('食べる'), { results: [], dictionaryCount: 0 }, 'lookup with zero dictionaries');
  same(kanji('食'), { character: '', entries: [], frequencies: [] }, 'kanji with zero dictionaries');
  same(styles(), [], 'styles with zero dictionaries');
  same(tags(), [], 'tags with zero dictionaries');
  eq(media(TITLE, MEDIA_PATH), 0, 'media with zero dictionaries');
});

check('dictionaries can be reloaded from the same MEMFS directory', () => {
  eq(addDict(DICT_DIR, 0), 1, `add_dict after reset: ${lastError()}`);
  eq(lookup('食べたかった').results[0].term.expression, '食べる', 'expression');
  same(tags(), FIXTURE_TAGS, 'tags after the reload');
});

// Linear memory never shrinks: the import high-water mark stays for the life
// of the module, which is what the extension's engine recycling reclaims.
const heapAfterReload = heapBytes();
console.log(`  heap after reset + 1 add: ${heapAfterReload} (after import: ${heapAfterImport})`);
check('the heap keeps the import high-water mark after a reset', () => {
  ok(heapAfterReload >= heapAfterImport, `heap shrank from ${heapAfterImport} to ${heapAfterReload}`);
});

// ---------------------------------------------------------------------------

G('hdw_import staging');

// hdw_import stages every import in a scratch directory and only moves the
// result into place once it is complete, so a failed re-import cannot destroy
// the copy it replaces. A Yomitan title is any string (MarvNC's own include
// "Nico/Pixiv", #512): the package lives in folder_name(title), one plain path
// component, so no title reaches outside /dicts. engine-service.js computes
// the same folder to find the files again; its function is checked against
// the folders the engine actually writes.
const dictionaryFolderName = (() => {
  const source = readFileSync(join(HERE, '..', 'extension', 'engine-service.js'), 'utf8');
  const start = source.indexOf('function dictionaryFolderName(');
  const end = source.indexOf('\n}\n', start) + 3;
  return new Function(`${source.slice(start, end)}\nreturn dictionaryFolderName;`)();
})();
reset();
M.FS.writeFile('/root-canary.txt', 'canary');
const rootBefore = M.FS.readdir('/').filter((n) => n !== '.' && n !== '..').sort();
const dictsNow = () => M.FS.readdir('/dicts').filter((n) => n !== '.' && n !== '..').sort();

for (const title of ['..', '../../..', '../escaped', 'sub/dir', '.', 'Nico/Pixiv', 'back\\slash', 'Japanese-Mongolian/日・モ辞典']) {
  check(`a title of ${show(title)} imports into its own folder and escapes nothing`, () => {
    const archive = `/work/titled-${dictionaryFolderName(title).replace(/[^A-Za-z0-9]/gu, '_')}.zip`;
    M.FS.writeFile(archive, buildTitledZip(title));
    const r = hdwImport(archive, '/dicts');
    conforms(r, IMPORT_REPORT, 'ImportReport');
    eq(r.success, true, `import failed: ${r.error}`);
    eq(r.title, title, 'the report keeps the title');
    const folder = dictionaryFolderName(title);
    ok(!folder.includes('/') && folder !== '.' && folder !== '..', `folder ${show(folder)} is one path component`);
    same(dictsNow(), [TITLE, folder].sort(), '/dicts holds the fixture and the new folder, and no staging debris');
    same(M.FS.readdir('/').filter((n) => n !== '.' && n !== '..').sort(), rootBefore, 'filesystem root');
    eq(addDict(`/dicts/${folder}`, KINDS.term), 1, `add_dict: ${lastError()}`);
    eq(lookup('食べたかった').results[0].term.glossaries.some((g) => g.dictionary === title), true,
      'a lookup names the dictionary by its title');
    reset();
    for (const name of M.FS.readdir(`/dicts/${folder}`)) {
      if (name !== '.' && name !== '..') M.FS.unlink(`/dicts/${folder}/${name}`);
    }
    M.FS.rmdir(`/dicts/${folder}`);
    same(dictsNow(), [TITLE], 'cleanup');
  });
}

for (const title of ['', '.hdw-import', '.hdw-remove']) {
  check(`a title of ${show(title)} is refused and destroys nothing`, () => {
    M.FS.writeFile('/work/titled.zip', buildTitledZip(title));
    const r = hdwImport('/work/titled.zip', '/dicts');
    conforms(r, IMPORT_REPORT, 'ImportReport');
    eq(r.success, false, 'success');
    ok(r.error.length > 0, 'error should be populated');
    eq(lastError(), r.error, 'hdw_last_error should mirror report.error');
    same(dictsNow(), [TITLE], '/dicts should still hold exactly the imported dictionary and no staging debris');
    same(M.FS.readdir('/').filter((n) => n !== '.' && n !== '..').sort(), rootBefore, 'filesystem root');
  });
}

check('a failed re-import leaves the installed dictionary loadable', () => {
  M.FS.writeFile('/work/no-banks.zip', buildTitledZip(TITLE, { banks: false }));
  const r = hdwImport('/work/no-banks.zip', '/dicts');
  eq(r.success, false, 'success');
  eq(r.error, 'empty dictionary', 'error');
  eq(r.title, TITLE, 'title');
  const entries = entriesOf(DICT_DIR);
  ok(
    markerOf(entries) !== undefined && REQUIRED_FILES.every((f) => entries.includes(f)),
    `${DICT_DIR} lost files to the failed re-import: ${JSON.stringify(entries.sort())}`,
  );
  reset();
  eq(addDict(DICT_DIR, 0), 1, `add_dict after the failed re-import: ${lastError()}`);
  eq(lookup('食べたかった').results[0].term.expression, '食べる', 'expression');
});

check('a successful re-import replaces the dictionary in place', () => {
  reset();
  const r = hdwImport('/work/fixture.zip', '/dicts');
  eq(r.success, true, `re-import failed: ${r.error}`);
  eq(r.title, TITLE, 'title');
  same(
    M.FS.readdir('/dicts').filter((n) => n !== '.' && n !== '..'),
    [TITLE],
    '/dicts after a re-import',
  );
  eq(addDict(DICT_DIR, 0), 1, `add_dict after the re-import: ${lastError()}`);
  eq(lookup('食べたかった').results[0].term.expression, '食べる', 'expression');
  same(tags(), FIXTURE_TAGS, 'tags after the re-import');
});

// ---------------------------------------------------------------------------

G('trained zstd dictionary (.hoshidicts_6) and the previous engine\'s layouts beside it');

// Upstream trains a zstd dictionary from the first term bank when it can sample
// enough glossaries. Doing so changes two things on disk -- the marker becomes
// .hoshidicts_6 and a dict.zstd appears -- and it changes how blobs.bin is
// encoded: glossaries are compressed against that dictionary, so a lookup only
// returns the right bytes if query.cpp found and loaded it. The lookups below are
// the real assertion; the marker checks only say which branch was taken.
reset();
M.FS.writeFile('/work/trained.zip', buildTrainedZip());
const trained = hdwImport('/work/trained.zip', '/dicts', 1);
console.log(`  trained import: ${JSON.stringify(trained)}`);

check('the trained import succeeds', () => {
  conforms(trained, IMPORT_REPORT, 'ImportReport');
  eq(trained.success, true, `import failed: ${trained.error}`);
  eq(trained.title, TRAINED_TITLE, 'title');
  eq(trained.termCount, TRAINED_TERMS.length, 'termCount');
});

check('a trained import is a .hoshidicts_6 directory with a dict.zstd', () => {
  const entries = entriesOf(TRAINED_DIR);
  eq(markerOf(entries), '.hoshidicts_6', `marker in ${TRAINED_DIR}: ${JSON.stringify(entries.sort())}`);
  ok(entries.includes('dict.zstd'), `dict.zstd missing; got ${JSON.stringify(entries.sort())}`);
  ok(M.FS.readFile(`${TRAINED_DIR}/dict.zstd`).length > 0, 'dict.zstd is empty');
  for (const required of REQUIRED_FILES) {
    ok(entries.includes(required), `${TRAINED_DIR}/${required} missing`);
  }
});

check('add_dict accepts the .hoshidicts_6 directory', () =>
  eq(addDict(TRAINED_DIR, 0), 1, `add_dict: ${lastError()}`));

check('glossaries compressed against the trained dictionary decompress', () => {
  // Row 0 is 食べる with rules v1, so this also runs the deinflection path.
  const first = lookup('食べたかった').results[0];
  eq(first.term.expression, '食べる', 'expression');
  same(
    first.term.glossaries.map((g) => g.glossary),
    [JSON.stringify(TRAINED_TERMS[0][5])],
    'glossary bytes for 食べる',
  );

  // A generated row, so the assertion covers a glossary the trained dictionary
  // actually had samples of rather than only the hand-written one.
  const [expression, , , , , glossary] = TRAINED_TERMS[TRAINED_TERMS.length - 1];
  const last = lookup(expression).results[0];
  eq(last.term.expression, expression, 'expression');
  same(
    last.term.glossaries.map((g) => g.glossary),
    [JSON.stringify(glossary)],
    `glossary bytes for ${expression}`,
  );
});

// dict.zstd is not optional once the marker says _4. The binding rejects an
// absent or empty file, and the query engine validates non-empty bytes as a full
// trained dictionary before it reports the load successful.
const trainedDictionaryPath = `${TRAINED_DIR}/dict.zstd`;
const trainedDictionaryBytes = M.FS.readFile(trainedDictionaryPath);
for (const [what, write] of [
  ['missing', null],
  ['zero length', new Uint8Array(0)],
  ['invalid', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
]) {
  check(`add_dict refuses a .hoshidicts_6 directory whose dict.zstd is ${what}`, () => {
    reset();
    M.FS.unlink(trainedDictionaryPath);
    if (write !== null) {
      M.FS.writeFile(trainedDictionaryPath, write);
    }
    try {
      eq(addDict(TRAINED_DIR, 0), 0, 'add_dict should refuse the directory');
      ok(lastError().includes(TRAINED_DIR), `hdw_last_error should name the directory: ${lastError()}`);
      eq(lookup('食べたかった').dictionaryCount, 0, 'nothing should be loaded');
    } finally {
      if (M.FS.analyzePath(trainedDictionaryPath).exists) {
        M.FS.unlink(trainedDictionaryPath);
      }
      M.FS.writeFile(trainedDictionaryPath, trainedDictionaryBytes);
    }
  });
}

check('the restored trained dictionary remains loadable', () => {
  same([...M.FS.readFile(trainedDictionaryPath)], [...trainedDictionaryBytes], 'restored dict.zstd bytes');
  reset();
  eq(addDict(TRAINED_DIR, 0), 1, `add_dict with dict.zstd restored: ${lastError()}`);
  eq(lookup('食べたかった').results[0].term.expression, '食べる', 'expression');
});

// The compatibility case, stated on its own rather than inferred from the
// earlier groups: after upgrading the engine a user still has directories the
// previous engine imported sitting next to whatever they import next. test/legacy
// holds two such directories, written by the engine at hoshidicts 1ec66fe from
// the same fixture zips make-fixture.mjs produces today: legacy-3 is the
// untrained layout (.hoshidicts_3, int32 score, no dict.zstd) and legacy-4 the
// trained one (.hoshidicts_4, dict.zstd). They are not regenerated by the
// build, which is the point -- they pin bytes the current importer no longer
// writes. query.cpp still reads both, so each has to load, at the same time as
// a fresh .hoshidicts_5 import, from the same query object, and report the
// same expression and score as that import does.
const LEGACY_ROOT = join(HERE, 'legacy');
const copyLegacy = (name, dir) => {
  M.FS.mkdir(dir);
  for (const entry of readdirSync(join(LEGACY_ROOT, name))) {
    M.FS.writeFile(`${dir}/${entry}`, new Uint8Array(readFileSync(join(LEGACY_ROOT, name, entry))));
  }
};
const LEGACY_3_DIR = '/dicts/legacy-3';
const LEGACY_4_DIR = '/dicts/legacy-4';
copyLegacy('legacy-3', LEGACY_3_DIR);
copyLegacy('legacy-4', LEGACY_4_DIR);

check('a .hoshidicts_3 directory from the previous engine still loads beside a fresh import', () => {
  reset();
  eq(markerOf(entriesOf(LEGACY_3_DIR)), '.hoshidicts_3', 'legacy marker');
  ok(!entriesOf(LEGACY_3_DIR).includes('dict.zstd'), 'dict.zstd should be absent');
  eq(markerOf(entriesOf(DICT_DIR)), '.hoshidicts_5', 'fresh marker');
  eq(addDict(LEGACY_3_DIR, 0), 1, `add_dict legacy: ${lastError()}`);
  eq(addDict(DICT_DIR, 0), 1, `add_dict fresh: ${lastError()}`);
  const response = lookup('食べたかった');
  eq(response.dictionaryCount, 2, 'both directories are loaded');
  // Same expression and reading from two dictionaries merge into one term, so
  // the legacy directory shows up as a second copy of each fresh glossary.
  const merged = response.results.find((r) => r.term.expression === '食べる');
  ok(merged, `no 食べる in ${JSON.stringify(response.results.map((r) => r.term.expression))}`);
  const fresh = TERMS.filter((row) => row[0] === '食べる').length;
  eq(merged.term.glossaries.length, fresh * 2, `glossaries from both directories; got ${JSON.stringify(merged.term.glossaries)}`);
  // The int32 score of the old layout and the double of the new one must read
  // back as the same number, or the score change silently reorders results.
  eq(merged.term.score, 120, 'score across both layouts');
  // The previous engine only counted its tag banks: until it is imported
  // again, that directory has no tags, and the fresh one keeps its own.
  same(tags(), FIXTURE_TAGS, 'tags beside a directory imported before tag banks were stored');
});

check('a .hoshidicts_4 directory from the previous engine still decompresses its glossaries', () => {
  reset();
  eq(markerOf(entriesOf(LEGACY_4_DIR)), '.hoshidicts_4', 'legacy marker');
  ok(entriesOf(LEGACY_4_DIR).includes('dict.zstd'), 'dict.zstd should be present');
  eq(addDict(LEGACY_4_DIR, 0), 1, `add_dict: ${lastError()}`);
  const first = lookup('食べたかった').results[0];
  eq(first.term.expression, '食べる', 'expression');
  same(
    first.term.glossaries.map((g) => g.glossary),
    [JSON.stringify(TRAINED_TERMS[0][5])],
    'glossaries decompressed against the trained dictionary',
  );
});

check('a _3 and a _4 dictionary load together and both answer', () => {
  reset();
  eq(addDict(DICT_DIR, 0), 1, `add_dict ${DICT_DIR}: ${lastError()}`);
  eq(addDict(TRAINED_DIR, 0), 1, `add_dict ${TRAINED_DIR}: ${lastError()}`);

  const names = lookup('食べたかった').results[0].term.glossaries.map((g) => g.dictionary);
  ok(names.includes(TITLE), `${TITLE} missing from ${JSON.stringify(names)}`);
  ok(names.includes(TRAINED_TITLE), `${TRAINED_TITLE} missing from ${JSON.stringify(names)}`);

  // Only the _4 dictionary holds this one, and only the _3 one holds 漢字.
  const [expression] = TRAINED_TERMS[1];
  eq(lookup(expression).results[0].term.expression, expression, `${expression} from the _4 dictionary`);
  eq(lookup('漢字').results[0].term.expression, '漢字', '漢字 from the _3 dictionary');
});

G('multi-bank pthread scheduler');

M.FS.writeFile('/work/many-banks.zip', buildManyBankZip());
const manyBankReport = hdwImport('/work/many-banks.zip', '/dicts', 0);
check('twenty term banks import through the bounded worker pool', () => {
  eq(manyBankReport.success, true, manyBankReport.error);
  eq(manyBankReport.termCount, MANY_BANK_COUNT, 'term count');
  eq(markerOf(entriesOf(MANY_BANK_DIR)), '.hoshidicts_6', 'trained marker');
});
check('the last scheduled bank is indexed and loadable', () => {
  reset();
  eq(addDict(MANY_BANK_DIR, 0), 1, lastError());
  const expression = String.fromCodePoint(0x7000 + 20);
  eq(lookup(expression).results[0]?.term.expression, expression, 'last bank expression');
});

G('interrupted install recovery');

const recovery = await createHoshidicts();
const recoveryFs = recovery.FS;
const mkdirTree = (path) => recoveryFs.mkdirTree(path);
const copyInstalledFiles = (destination, names) => {
  mkdirTree(destination);
  for (const name of names) {
    recoveryFs.writeFile(`${destination}/${name}`, M.FS.readFile(`${DICT_DIR}/${name}`));
  }
};
const installedFiles = entriesOf(DICT_DIR);
const split = Math.ceil(installedFiles.length / 2);

mkdirTree('/dicts/.hdw-import/new/partial-backup');
copyInstalledFiles('/dicts/partial-backup', installedFiles.slice(0, split));
copyInstalledFiles('/dicts/.hdw-import/replaced/partial-backup', installedFiles.slice(split));

mkdirTree('/dicts/.hdw-import/new/committed-backup');
copyInstalledFiles('/dicts/.hdw-import/replaced/committed-backup', installedFiles);
recoveryFs.writeFile('/dicts/.hdw-import/replaced/committed-backup/.backup-ready', new Uint8Array());
copyInstalledFiles('/dicts/committed-backup', ['blobs.bin']);

mkdirTree('/dicts/.hdw-import/new/uncommitted-new');
copyInstalledFiles('/dicts/.hdw-import/replaced/uncommitted-new', installedFiles);
recoveryFs.writeFile('/dicts/.hdw-import/replaced/uncommitted-new/.backup-ready', new Uint8Array());
recoveryFs.writeFile('/dicts/.hdw-import/replaced/uncommitted-new/old-only', new Uint8Array([1]));
copyInstalledFiles('/dicts/uncommitted-new', installedFiles);
recoveryFs.writeFile('/dicts/uncommitted-new/new-only', new Uint8Array([1]));

mkdirTree('/dicts/.hdw-import/new/committed-new');
copyInstalledFiles('/dicts/.hdw-import/replaced/committed-new', installedFiles.slice(0, -1));
recoveryFs.writeFile('/dicts/.hdw-import/replaced/committed-new/.backup-ready', new Uint8Array());
recoveryFs.writeFile('/dicts/.hdw-import/replaced/committed-new/old-only', new Uint8Array([1]));
copyInstalledFiles('/dicts/committed-new', installedFiles);
recoveryFs.writeFile('/dicts/committed-new/.new-committed', new Uint8Array());
recoveryFs.writeFile('/dicts/committed-new/new-only', new Uint8Array([1]));

mkdirTree('/dicts/.hdw-import/new/corrupt-new');
copyInstalledFiles('/dicts/.hdw-import/replaced/corrupt-new', installedFiles);
recoveryFs.writeFile('/dicts/.hdw-import/replaced/corrupt-new/.backup-ready', new Uint8Array());
for (const name of installedFiles) {
  mkdirTree('/dicts/corrupt-new');
  recoveryFs.writeFile(`/dicts/corrupt-new/${name}`, new Uint8Array());
}

const cleanupCrashTitles = installedFiles.map((_, deleted) => `cleanup-crash-${deleted}`);
cleanupCrashTitles.push(`cleanup-crash-${installedFiles.length}`);
for (let deleted = 0; deleted < cleanupCrashTitles.length; deleted += 1) {
  const title = cleanupCrashTitles[deleted];
  copyInstalledFiles(`/dicts/.hdw-import/replaced/${title}`, installedFiles.slice(deleted));
  recoveryFs.writeFile(`/dicts/.hdw-import/replaced/${title}/.backup-ready`, new Uint8Array());
  copyInstalledFiles(`/dicts/${title}`, installedFiles);
  recoveryFs.writeFile(`/dicts/${title}/.new-committed`, new Uint8Array());
  recoveryFs.writeFile(`/dicts/${title}/new-only`, new Uint8Array([1]));
}

mkdirTree('/dicts/.hdw-import/new/first-install');
recoveryFs.writeFile('/dicts/.hdw-import/new/first-install/index.json', new Uint8Array([1]));
copyInstalledFiles('/dicts/first-install', ['blobs.bin']);

const recoveryCall = (name, ret, types, args) => recovery.ccall(name, ret, types, args);
const recoveryInit = recoveryCall('hdw_init_storage', 'number', ['number'], [0]);
check('storage initialization recovers interrupted installs', () =>
  eq(recoveryInit, 1, recoveryCall('hdw_last_error', 'string', [], [])));
check('a partially moved backup is merged back without deleting the files left in place', () =>
  eq(recoveryCall('hdw_add_dict', 'number', ['string', 'number', 'number'], ['/dicts/partial-backup', 0, 0]), 1,
    recoveryCall('hdw_last_error', 'string', [], [])));
check('a committed backup replaces a partial new destination', () =>
  eq(recoveryCall('hdw_add_dict', 'number', ['string', 'number', 'number'], ['/dicts/committed-backup', 0, 0]), 1,
    recoveryCall('hdw_last_error', 'string', [], [])));
check('a complete but uncommitted new destination is rolled back', () => {
  eq(recoveryFs.analyzePath('/dicts/uncommitted-new/old-only').exists, true, 'old backup sentinel');
  eq(recoveryFs.analyzePath('/dicts/uncommitted-new/new-only').exists, false, 'new destination sentinel');
});
check('a committed new destination wins over a partially deleted backup', () => {
  eq(recoveryFs.analyzePath('/dicts/committed-new/new-only').exists, true, 'new destination sentinel');
  eq(recoveryFs.analyzePath('/dicts/committed-new/old-only').exists, false, 'old backup sentinel');
});
check('a corrupt destination cannot displace the last valid backup', () => {
  recoveryCall('hdw_reset', null, [], []);
  eq(recoveryCall('hdw_add_dict', 'number', ['string', 'number', 'number'], ['/dicts/corrupt-new', 0, 0]), 1,
    recoveryCall('hdw_last_error', 'string', [], []));
  const result = recoveryCall('hdw_lookup', 'string', ['string', 'number', 'number', 'string'],
    ['食べる', 8, 16, '{}']);
  eq(JSON.parse(result).results[0]?.term?.expression, '食べる', 'restored backup lookup');
});
check('every interrupted backup-cleanup prefix preserves the committed replacement', () => {
  for (const title of cleanupCrashTitles) {
    eq(recoveryFs.analyzePath(`/dicts/${title}/new-only`).exists, true, `${title} destination`);
    eq(recoveryFs.analyzePath(`/dicts/${title}/.new-committed`).exists, false, `${title} commit marker`);
    eq(recoveryFs.analyzePath(`/dicts/.hdw-import/replaced/${title}`).exists, false, `${title} backup`);
  }
});
check('a partial first install is removed', () =>
  eq(recoveryFs.analyzePath('/dicts/first-install').exists, false, 'partial destination'));
check('recovery removes transaction debris', () =>
  eq(recoveryFs.analyzePath('/dicts/.hdw-import').exists, false, 'staging directory'));

G('hdw_lookup_dictionary');

const SELECTED_TITLE = 'selected-dictionary-fixture';
const SELECTED_DIR = `/dicts/${SELECTED_TITLE}`;
M.FS.writeFile('/work/selected.zip', buildTitledZip(SELECTED_TITLE));
const selectedReport = hdwImport('/work/selected.zip', '/dicts');
reset();
eq(addDict(DICT_DIR, 0), 1, `add primary dictionary: ${lastError()}`);
eq(addDict(DICT_DIR, 1), 1, `add frequency dictionary: ${lastError()}`);
eq(addDict(DICT_DIR, 2), 1, `add pitch dictionary: ${lastError()}`);

check('a dictionary-scoped lookup rejects a path that is not loaded', () => {
  const response = lookupDictionary('食べる', SELECTED_DIR);
  conforms(response, LOOKUP_RESPONSE, 'unloaded dictionary lookup');
  eq(response.results.length, 0, 'unloaded path result count');
});

eq(addDict(SELECTED_DIR, 0), 1, `add selected dictionary: ${lastError()}`);
const selectedLookup = lookupDictionary('食べる', SELECTED_DIR, 1);
check('a dictionary-scoped lookup conforms to the lookup contract', () => {
  conforms(selectedLookup, LOOKUP_RESPONSE, 'dictionary-scoped lookup');
  eq(selectedLookup.dictionaryCount, 4, 'overall loaded capability count');
});
check('a dictionary-scoped lookup returns only the requested term dictionary', () => {
  ok(selectedReport.success, `selected fixture import failed: ${selectedReport.error}`);
  eq(selectedLookup.results.length, 1, 'selected result count');
  ok(
    selectedLookup.results[0].term.glossaries.every(({ dictionary }) => dictionary === SELECTED_TITLE),
    JSON.stringify(selectedLookup.results[0].term.glossaries),
  );
});
check('a dictionary-scoped lookup retains shared frequency and pitch metadata', () => {
  eq(selectedLookup.results[0].term.frequencies[0]?.dictionary, TITLE, 'frequency dictionary');
  eq(selectedLookup.results[0].term.pitches[0]?.dictionary, TITLE, 'pitch dictionary');
});

G('definition score order (#472)');

check('definitions sort by score within each dictionary, keeping ties, tags and dictionary priority', () => {
  const titles = ['definition-order-first', 'definition-order-second'];
  const paths = titles.map(title => `/dicts/${title}`);
  const terms = [
    ['青タン', 'あおタン', 'hanafuda', '', -4, ['hanafuda'], 2723740, ''],
    ['青タン', 'あおタン', 'colloquial', '', 0, ['bruise'], 2223970, ''],
    ['青タン', 'あおタン', 'tie', '', 0, ['equal-score later row'], 3, ''],
    ['青タン', 'あおタン', 'fraction-low', '', -0.75, ['lower fraction'], 4, ''],
    ['青タン', 'あおタン', 'fraction-high', '', -0.25, ['higher fraction'], 5, ''],
  ];
  const expected = [terms[1], terms[2], terms[4], terms[3], terms[0]]
    .map(row => [JSON.stringify(row[5]), row[2]]);
  const secondTerms = [['青タン', 'あおタン', 'second', '', 100, ['second dictionary'], 6, '']];
  for (const [index, title] of titles.entries()) {
    const zipPath = `/work/${title}.zip`;
    M.FS.writeFile(zipPath, buildTitledZip(title, { terms: index === 0 ? terms : secondTerms }));
    ok(hdwImport(zipPath, '/dicts').success, lastError());
  }
  const project = term => term.glossaries.map(({ glossary, definitionTags }) => [glossary, definitionTags]);
  const second = [[JSON.stringify(secondTerms[0][5]), secondTerms[0][2]]];
  for (const paged of [0, 1]) {
    reset();
    paths.forEach(path => eq(addDict(path, 0, paged), 1, lastError()));
    const response = lookup('青タン');
    conforms(response, LOOKUP_RESPONSE, 'definition ordering response');
    same(project(response.results[0].term), [...expected, ...second], `dictionary priority, paged=${paged}`);
    eq(response.results[0].term.score, 100, 'merged score still keeps its maximum');
    same(project(lookupDictionary('青タン', paths[0]).results[0].term), expected, 'selected dictionary');
    eq(call('hdw_set_dict_order', 'number', ['string'], [JSON.stringify([...paths].reverse())]), 1, lastError());
    same(project(lookup('青タン').results[0].term), [...second, ...expected], 'reordered dictionaries');
  }
});

G('long keys beyond the scan length');

const LONG_KEY_DIR = `/dicts/${LONG_KEY_TITLE}`;
M.FS.writeFile('/work/long-key.zip', buildLongKeyZip());
const longKeyReport = hdwImport('/work/long-key.zip', '/dicts');
const longKeyTail = 'と昔から言われている。';
const longKeyExpressions = (response) => response.results.map((result) => result.term.expression);

check('the importer writes a long-key scan index', () => {
  ok(longKeyReport.success, `long-key fixture import failed: ${longKeyReport.error}`);
  const header = M.FS.readFile(`${LONG_KEY_DIR}/scan.idx`).subarray(0, 16);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  eq(view.getUint32(0, true), 0x49534448, 'scan.idx magic');
  eq(view.getUint32(4, true), 1, 'scan.idx version');
  eq(view.getUint16(12, true), LONG_KEY_LENGTH, 'scan.idx longest key');
});

reset();
eq(addDict(LONG_KEY_DIR, 0), 1, `add long-key dictionary: ${lastError()}`);

check('fractional and beyond-int32 scores survive import, lookup and the JSON boundary', () => {
  const response = lookup(LONG_KEY_PROVERB + longKeyTail, 32, 16, AUTO_OPTIONS);
  const proverb = response.results.find((result) => result.term.expression === LONG_KEY_PROVERB);
  eq(proverb?.term.score, LONG_KEY_PROVERB_SCORE, 'a score past int32 with a fraction');
  const phrase = lookup(LONG_KEY_PHRASE_INFLECTED + longKeyTail, 32, 16, AUTO_OPTIONS)
    .results.find((result) => result.term.expression === LONG_KEY_PHRASE);
  eq(phrase?.term.score, LONG_KEY_PHRASE_SCORE, 'a negative fractional score');
});

check('scanLength 16 still finds a 27-code-point key when the text begins like it', () => {
  const response = lookup(LONG_KEY_PROVERB + longKeyTail, 32, 16, AUTO_OPTIONS);
  conforms(response, LOOKUP_RESPONSE, 'long-key lookup');
  const proverb = response.results.find((result) => result.term.expression === LONG_KEY_PROVERB);
  ok(proverb !== undefined, `proverb missing from ${JSON.stringify(longKeyExpressions(response))}`);
  eq(proverb?.matched, LONG_KEY_PROVERB, 'the whole proverb is the matched text');
  ok(longKeyExpressions(response).includes('身体'), 'the short key is still reported');
});

check('an inflected long phrase is found through deinflection', () => {
  const response = lookup(LONG_KEY_PHRASE_INFLECTED + longKeyTail, 32, 16, AUTO_OPTIONS);
  ok(longKeyExpressions(response).includes(LONG_KEY_PHRASE), JSON.stringify(longKeyExpressions(response)));
});

check('text that does not begin like a long key keeps the ordinary scan', () => {
  const response = lookup('食べられなかった' + LONG_KEY_PROVERB, 32, 16, AUTO_OPTIONS);
  ok(!longKeyExpressions(response).includes(LONG_KEY_PROVERB), 'no extension for an unrelated prefix');
});

check('a scan shorter than eight code points never extends', () => {
  const response = lookup(LONG_KEY_PROVERB + longKeyTail, 32, 4, AUTO_OPTIONS);
  same(longKeyExpressions(response), ['身体'], 'scan 4 results');
});

check('a dictionary-scoped lookup extends through its own index', () => {
  const response = lookupDictionary(LONG_KEY_PROVERB + longKeyTail, LONG_KEY_DIR, 32, 16, AUTO_OPTIONS);
  ok(longKeyExpressions(response).includes(LONG_KEY_PROVERB), JSON.stringify(longKeyExpressions(response)));
});

G('MDX import');

// hoshidicts imports an MDict .mdx directly (format decided by content, not
// extension) and reads `<stem>.mdd` beside it for media and stylesheets. The
// fixtures in test/mdict are byte copies of the engine's own
// (tests/fixtures/mdict, written by gen_fixtures.py; committed here because
// the smoke suites run without the submodule). v2_utf8_lzo_html is an HTML MDX
// with an @@@LINK alias, duplicate headwords, a StyleSheet substitution and an
// MDD holding a PNG, a CSS file and a traversal key. hdw_import's title
// pre-check reads index.json out of a ZIP, so this is also the proof that an
// MDict file gets past it and through the same staging.
const MDX_FIXTURES = join(HERE, 'mdict');
const MDX_TITLE = 'HTML Fixture';
const MDX_DIR = `/dicts/${MDX_TITLE}`;
M.FS.mkdir('/work/mdx');
for (const name of ['v2_utf8_lzo_html.mdx', 'v2_utf8_lzo_html.mdd']) {
  M.FS.writeFile(`/work/mdx/${name}`, new Uint8Array(readFileSync(join(MDX_FIXTURES, name))));
}
reset();
const mdxReport = hdwImport('/work/mdx/v2_utf8_lzo_html.mdx', '/dicts');
console.log(`  mdx import: ${JSON.stringify(mdxReport)}`);

check('an .mdx with its .mdd imports through hdw_import', () => {
  conforms(mdxReport, IMPORT_REPORT, 'ImportReport');
  eq(mdxReport.success, true, `import failed: ${mdxReport.error}`);
  eq(mdxReport.title, MDX_TITLE, 'title from the MDX header');
  eq(mdxReport.termCount, 8, 'seven entries plus the alias headword');
  // style.css, utf16.css and img/pic.png; a disabled sound:// link imports nothing.
  eq(mdxReport.mediaCount, 3, 'referenced MDD assets and the stylesheets');
  ok(M.FS.readdir('/dicts').includes(MDX_TITLE), '/dicts holds the MDX beside the ZIP imports');
  ok(!M.FS.readdir('/dicts').includes('.hdw-import'), 'no staging directory left behind');
  ok(markerOf(entriesOf(MDX_DIR)) !== undefined, `no marker in ${JSON.stringify(entriesOf(MDX_DIR).sort())}`);
});

check('the MDX import report counts what it left out', () => {
  eq(mdxReport.skippedRecordCount, 0, 'skippedRecordCount');
  eq(mdxReport.unresolvedRedirectCount, 1, 'missing-alias (@@@LINK=nowhere) is unresolved');
  eq(mdxReport.missingResourceCount, 1, '../evil.png is a traversal key, so no MDD provides it');
  eq(mdxReport.unreadableResourceCount, 0, 'unreadableResourceCount');
});

check('an .mdx chosen without its .mdd reports its images and styles missing', () => {
  const out = '/work/mdx-alone';
  M.FS.mkdir(out);
  M.FS.mkdir('/work/mdx-alone-source');
  M.FS.writeFile('/work/mdx-alone-source/Alone.mdx',
    new Uint8Array(readFileSync(join(MDX_FIXTURES, 'v2_utf8_lzo_html.mdx'))));
  const r = hdwImport('/work/mdx-alone-source/Alone.mdx', out);
  conforms(r, IMPORT_REPORT, 'ImportReport');
  eq(r.success, true, `import failed: ${r.error}`);
  eq(r.mediaCount, 0, 'no media without an MDD');
  eq(r.missingResourceCount, 2, 'img/pic.png and evil.png are missing');
  eq(r.unresolvedRedirectCount, 1, 'missing-alias is unresolved');
});

check('the MDX dictionary loads and answers like a Yomitan one', () => {
  reset();
  eq(addDict(MDX_DIR, 0), 1, `add_dict: ${lastError()}`);
  const eat = lookup('食べる', 32, 16, AUTO_OPTIONS);
  conforms(eat, LOOKUP_RESPONSE, 'mdx lookup');
  eq(eat.results[0]?.term.expression, '食べる', 'expression');
  const glossary = eat.results[0]?.term.glossaries[0];
  eq(glossary?.dictionary, MDX_TITLE, 'glossary dictionary');
  ok(String(glossary?.glossary).includes('to eat'), `StyleSheet-expanded glossary: ${glossary?.glossary}`);
  eq(lookup('alias').results[0]?.term.expression, 'alias', 'the @@@LINK alias is a headword of its target');
  eq(lookup('missing-alias').results.length, 0, 'an alias to a missing target is dropped');
});

check('MDD stylesheets and media come through hdw_styles and hdw_media', () => {
  const sheets = styles();
  eq(sheets.length, 1, `one stylesheet, got ${JSON.stringify(sheets)}`);
  eq(sheets[0].dictionary, MDX_TITLE, 'stylesheet dictionary');
  ok(sheets[0].styles.includes('.mdx-red'), 'MDD CSS is the dictionary stylesheet');
  const length = media(MDX_TITLE, 'mdict-media/img/pic.png');
  eq(length, 69, 'PNG byte length');
  same([...mediaBytes(length).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
  eq(media(MDX_TITLE, 'mdict-media/evil.png'), 0, 'a traversal MDD key is not imported');
  eq(media(MDX_TITLE, 'mdict-media/a.spx'), 0, 'a disabled sound:// file is not imported');
});

check('an .mdd on its own is refused and leaves no debris', () => {
  reset();
  const r = hdwImport('/work/mdx/v2_utf8_lzo_html.mdd', '/dicts');
  eq(r.success, false, 'success');
  ok(r.error.includes('MDD resource file'), `error: ${r.error}`);
  ok(!M.FS.readdir('/dicts').includes('.hdw-import'), 'no staging directory left behind');
});

// Issue #437's reproduction, copied from the engine's fixtures like the pair
// above: key_rules.mdx with MDict's default key rules (no KeyCaseSensitive or
// StripKey attribute), key_rules_exact.mdx with KeyCaseSensitive="Yes"
// StripKey="No"; css_charsets.mdd with Shift_JIS sheets with and without
// @charset, a windows-1252 sheet that declares it (and undecodable ones the
// engine leaves out); and legacy_font.mdx with three <font size> elements.
const importMdx = (stem, companions = []) => {
  M.FS.mkdir(`/work/${stem}`);
  for (const name of [`${stem}.mdx`, ...companions]) {
    M.FS.writeFile(`/work/${stem}/${name}`, new Uint8Array(readFileSync(join(MDX_FIXTURES, name))));
  }
  reset();
  const report = hdwImport(`/work/${stem}/${stem}.mdx`, '/dicts');
  if (report.success) {
    eq(addDict(`/dicts/${report.title}`, 0), 1, `add_dict ${report.title}: ${lastError()}`);
  }
  return report;
};
const headword = (text) => lookup(text).results.find((result) => result.term.expression === text);

check('@@@LINK aliases follow MDict\'s default key rules and chains', () => {
  const report = importMdx('key_rules');
  eq(report.success, true, `import failed: ${report.error}`);
  eq(report.termCount, 7, 'three entries, three aliases and the two-hop alias');
  for (const [alias, definition] of [['ティーシャツ', 'T-shirt'], ['ワイファイ', 'wireless LAN'], ['AliasOne', 'definition']]) {
    const glossary = String(headword(alias)?.term.glossaries[0]?.glossary);
    ok(glossary.includes(definition), `${alias} carries its target's definition: ${glossary}`);
  }
});

check('KeyCaseSensitive="Yes" StripKey="No" resolve only exact targets', () => {
  const report = importMdx('key_rules_exact');
  eq(report.success, true, `import failed: ${report.error}`);
  eq(report.termCount, 5, 'three entries and the two exactly spelled aliases');
  eq(headword('ティーシャツ'), undefined, '@@@LINK=tシャツ does not match Tシャツ');
  eq(headword('ワイファイ'), undefined, '@@@LINK=WiFi does not match Wi-Fi');
  ok(headword('AliasOne'), 'the exact two-hop chain still resolves');
});

check('Shift_JIS and windows-1252 MDD stylesheets import as UTF-8', () => {
  const report = importMdx('css_charsets', ['css_charsets.mdd']);
  eq(report.success, true, `import failed: ${report.error}`);
  const sheet = styles().find((entry) => entry.dictionary === report.title)?.styles ?? '';
  ok(sheet.includes('.日本 { color: red; }'), `Shift_JIS sheet with @charset decoded: ${sheet}`);
  ok(sheet.includes('.日本 { color: green; }'), 'Shift_JIS sheet without @charset decoded');
  ok(sheet.includes('.café { color: red; }'), 'windows-1252 sheet decoded');
  ok(!sheet.includes('@charset'), 'no @charset rule left in the combined sheet');
  ok(!sheet.includes('\ufffd'), 'no replacement characters');
});

check('<font size> becomes a CSS keyword and inline style wins', () => {
  const report = importMdx('legacy_font');
  eq(report.success, true, `import failed: ${report.error}`);
  const glossary = String(headword('font')?.term.glossaries[0]?.glossary);
  ok(glossary.includes('"style":{"color":"red","fontSize":"medium"}'), `size="3": ${glossary}`);
  ok(glossary.includes('"style":{"fontSize":"x-large"}'), 'size="+2"');
  ok(glossary.includes('"style":{"fontSize":"20px"}'), 'the inline style wins over size="5"');
});

G('production custom dictionary ZIP');

const customSourceRows = [
  'newline, \u304b\u3044\u304e\u3087\u3046, line one\\nline two',
  'literal, \u308a\u3066\u3089\u308b, line one\\\\nline two',
  'duplicate, \u3061\u3087\u3046\u3075\u304f, first',
  'duplicate, \u3061\u3087\u3046\u3075\u304f, second',
  ...Array.from(
    { length: 996 },
    (_, index) => `custom-${index + 4}, \u304b\u3059\u305f\u3080-${index + 4}, definition ${index + 4}`,
  ),
  'custom-bank-two-terminal, \u3057\u3085\u3046\u305f\u3093, bank two definition',
];
const customParsed = parseCustomDictionary(customSourceRows.join('\r\n'));
const customSemanticRevision = await customDictionarySemanticRevision(customParsed.entries);
const customZip = buildCustomDictionaryZip(customParsed.entries, customSemanticRevision);
M.FS.writeFile('/work/custom-dictionary.zip', customZip);
const customReport = hdwImport('/work/custom-dictionary.zip', '/dicts');

check('production parser retains all 1001 valid rows', () => {
  eq(customParsed.errors.length, 0, 'malformed custom row count');
  eq(customParsed.entries.length, 1_001, 'valid custom row count');
});
check('production ZIP imports through the real WASM importer', () => {
  conforms(customReport, IMPORT_REPORT, 'custom ImportReport');
  eq(customReport.success, true, `custom import failed: ${customReport.error}`);
  eq(customReport.title, CUSTOM_DICTIONARY_TITLE, 'custom dictionary title');
  eq(customReport.termCount, 1_001, 'custom term count');
  for (const key of ['metaCount', 'frequencyCount', 'pitchCount', 'kanjiCount', 'mediaCount', ...MDX_LOSS_COUNTS]) {
    eq(customReport[key], 0, `custom ${key}`);
  }
});
check('imported custom metadata retains the semantic revision', () => {
  const index = JSON.parse(new TextDecoder().decode(
    M.FS.readFile(`${CUSTOM_DICTIONARY_DIR}/index.json`),
  ));
  eq(index.revision, customSemanticRevision, 'custom semantic revision');
});
check('the real importer writes a complete custom dictionary generation', () => {
  const entries = entriesOf(CUSTOM_DICTIONARY_DIR);
  ok(markerOf(entries) !== undefined, `custom marker missing: ${JSON.stringify(entries.sort())}`);
  for (const required of REQUIRED_FILES) {
    ok(entries.includes(required), `${CUSTOM_DICTIONARY_DIR}/${required} missing`);
  }
});

reset();
eq(addDict(CUSTOM_DICTIONARY_DIR, 0), 1, `add custom dictionary: ${lastError()}`);
check('a term in the second 1000-row bank is searchable', () => {
  const result = lookupDictionary(
    'custom-bank-two-terminal',
    CUSTOM_DICTIONARY_DIR,
    32,
    64,
  ).results[0];
  eq(result?.term?.expression, 'custom-bank-two-terminal', 'second-bank expression');
  same(result?.term?.glossaries.map(({ glossary }) => glossary),
    [JSON.stringify(['bank two definition'])], 'second-bank glossary');
});
check('definition newline and literal backslash-n remain distinct', () => {
  const newline = lookupDictionary('newline', CUSTOM_DICTIONARY_DIR).results[0];
  const literal = lookupDictionary('literal', CUSTOM_DICTIONARY_DIR).results[0];
  same(newline.term.glossaries.map(({ glossary }) => glossary),
    [JSON.stringify(['line one\nline two'])], 'decoded newline glossary');
  same(literal.term.glossaries.map(({ glossary }) => glossary),
    [JSON.stringify(['line one\\nline two'])], 'literal backslash-n glossary');
});
check('ordered duplicate custom rows retain both definitions', () => {
  const result = lookupDictionary('duplicate', CUSTOM_DICTIONARY_DIR).results[0];
  same(result.term.glossaries.map(({ glossary }) => glossary),
    [JSON.stringify(['first']), JSON.stringify(['second'])], 'duplicate glossaries');
});

G('bounded lookup responses');

const GLOSSARY_LIMIT = 8 * 1024 * 1024;
const RESPONSE_LIMIT = 32 * 1024 * 1024;
const BOUNDED_TITLE = 'bounded-lookup-fixture';
const BOUNDED_DIR = `/dicts/${BOUNDED_TITLE}`;
const definitionAtLimit = 'x'.repeat(GLOSSARY_LIMIT - 4);
const multibyteAtLimit = 'あ'.repeat(Math.floor((GLOSSARY_LIMIT - 4) / 3))
  + 'x'.repeat((GLOSSARY_LIMIT - 4) % 3);
const escapeExpansion = '\\'.repeat(3 * 1024 * 1024 - 2);
const boundedTerm = (expression, definition) => [expression, '', '', '', 1, [definition], 1, ''];
const controlMetadata = Array.from({ length: 32 }, (_, byte) => ({
  expression: `control-byte-${byte}`,
  // Exercise controls in full eight-byte words and in the scalar tail,
  // surrounded by both ASCII and high UTF-8 bytes.
  displayValue: 'x'.repeat(byte % 17) + String.fromCharCode(byte) + 'あいう尾',
}));
const boundedTerms = [
  boundedTerm('ascii-limit', definitionAtLimit),
  boundedTerm('multibyte-limit', multibyteAtLimit),
  boundedTerm('glossary-over', multibyteAtLimit + 'x'),
  ...Array.from({ length: 4 }, () => boundedTerm('aggregate-over', definitionAtLimit)),
  ...Array.from({ length: 3 }, () => boundedTerm('serialized-over', escapeExpansion)),
  boundedTerm('control', 'control bytes in frequency metadata'),
  ...controlMetadata.map(({ expression }) => boundedTerm(expression, 'individual control byte')),
  boundedTerm('healthy', 'still loaded after a refused reply'),
];
const controlDisplayValue = 'control-\u0000-\u0001-\u001f';
M.FS.writeFile('/work/bounded-lookup.zip', buildTitledZip(BOUNDED_TITLE, {
  terms: boundedTerms,
  termMeta: [
    ['control', 'freq', { value: 1, displayValue: controlDisplayValue }],
    ...controlMetadata.map(({ expression, displayValue }) => [expression, 'freq', { value: 1, displayValue }]),
  ],
}));
const boundedReport = hdwImport('/work/bounded-lookup.zip', '/dicts');
check('lookup response limits do not reject the imported archive', () => {
  eq(boundedReport.success, true, `bounded fixture import: ${boundedReport.error}`);
  eq(boundedReport.termCount, boundedTerms.length, 'all imported rows');
});
reset();
eq(addDict(BOUNDED_DIR, 0), 1, `load bounded fixture: ${lastError()}`);
eq(addDict(BOUNDED_DIR, 1), 1, `load bounded frequency fixture: ${lastError()}`);
const boundedLookups = [
  (query, options = '') => lookup(query, 32, 64, options),
  (query, options = '') => lookupDictionary(query, BOUNDED_DIR, 32, 64, options),
];

check('both lookup endpoints retain exact 8 MiB ASCII and multibyte glossaries', () => {
  for (const query of ['ascii-limit', 'multibyte-limit']) {
    for (const run of boundedLookups) {
      const result = run(query);
      eq(lastError(), '', `${query} error`);
      const glossary = result.results[0]?.term?.glossaries[0]?.glossary;
      ok(typeof glossary === 'string', `${query} has no glossary`);
      eq(Buffer.byteLength(glossary), GLOSSARY_LIMIT, `${query} raw UTF-8 bytes`);
      ok(Buffer.byteLength(JSON.stringify(result)) < RESPONSE_LIMIT, `${query} response exceeds 32 MiB`);
    }
  }
});
check('both lookup endpoints refuse a glossary one UTF-8 byte over 8 MiB', () => {
  for (const run of boundedLookups) {
    const result = run('glossary-over');
    ok(lastError().includes('glossary'), 'oversized glossary did not report its error');
    eq(result.results.length, 0, 'oversized result was not discarded');
  }
});
check('both lookup endpoints refuse the aggregate native copy budget', () => {
  for (const run of boundedLookups) {
    const result = run('aggregate-over');
    ok(lastError().includes('aggregate'), 'aggregate copies did not report their error');
    eq(result.results.length, 0, 'aggregate response was not discarded');
  }
});
check('both lookup endpoints independently bound JSON escape expansion', () => {
  for (const run of boundedLookups) {
    const result = run('serialized-over');
    ok(lastError().includes('serialized'), 'escape expansion did not report its error');
    eq(result.results.length, 0, 'expanded response was not discarded');
  }
});
check('lookup text and option strings use a 4 KiB UTF-8 boundary', () => {
  const boundary = 'あ'.repeat(1365) + 'x';
  eq(Buffer.byteLength(boundary), 4096, 'text boundary fixture');
  for (const run of boundedLookups) {
    run(boundary);
    eq(lastError(), '', 'exact-boundary query');
    run(boundary + 'x');
    ok(lastError().includes('lookup text'), 'oversized query did not report its error');
    for (const field of ['frequencyDictionary', 'primaryReading']) {
      run('healthy', JSON.stringify({ [field]: boundary }));
      eq(lastError(), '', `exact-boundary ${field}`);
      run('healthy', JSON.stringify({ [field]: boundary + 'x' }));
      ok(lastError().includes(field), `oversized ${field} did not report its error`);
    }
  }
  kanji(boundary);
  eq(lastError(), '', 'exact-boundary kanji query');
  kanji(boundary + 'x');
  ok(lastError().includes('kanji text'), 'oversized kanji query did not report its error');
});
check('native lookup JSON escapes control bytes without truncating the C string', () => {
  const result = lookup('control', 32, 64);
  eq(lastError(), '', 'control-byte lookup');
  eq(result.results[0]?.term?.frequencies[0]?.frequencies[0]?.displayValue,
    controlDisplayValue, 'frequency display controls');
  for (const { expression, displayValue } of controlMetadata) {
    const individual = lookup(expression, 1, 64);
    eq(lastError(), '', `control-byte lookup ${expression}`);
    eq(individual.results[0]?.term?.frequencies[0]?.frequencies[0]?.displayValue,
      displayValue, `unaltered ${expression}`);
  }
});
check('refused lookup responses leave the loaded dictionary usable', () => {
  for (const run of boundedLookups) {
    const result = run('healthy');
    eq(lastError(), '', 'healthy follow-up error');
    eq(result.dictionaryCount, 2, 'loaded dictionary count');
    eq(result.results[0]?.term?.expression, 'healthy', 'healthy follow-up result');
  }
});

// ---------------------------------------------------------------------------

G('media request and response bounds');
check('media reference limits count UTF-8 bytes and preserve well-formed misses', () => {
  const dictionary = 'あ'.repeat(341) + 'x';
  const path = 'media/' + 'あ'.repeat(1363) + 'x';
  eq(Buffer.byteLength(dictionary), 1024, 'dictionary boundary fixture');
  eq(Buffer.byteLength(path), 4096, 'path boundary fixture');
  for (const [field, exact, over] of [
    ['dictionary', [dictionary, MEDIA_PATH], [dictionary + 'x', MEDIA_PATH]],
    ['path', [TITLE, path], [TITLE, path + 'x']],
  ]) {
    eq(media(...exact), 0, `absent ${field} at boundary`);
    eq(lastError(), '', `exact ${field} must not fail`);
    eq(media(...over), 0, `oversized ${field}`);
    ok(lastError().includes(field), `${field} overflow must report an error`);
  }
});
check('large media imports and loads but only fetches up to 4 MiB', () => {
  const title = 'bounded-media-fixture';
  const limit = 4 * 1024 * 1024;
  const exact = Buffer.alloc(limit);
  makePng().copy(exact);
  const over = Buffer.concat([exact, Buffer.from([0])]);
  const zipPath = '/work/bounded-media.zip';
  const output = '/work/bounded-media';
  M.FS.mkdir(output);
  M.FS.writeFile(zipPath, buildTitledZip(title, { mediaEntries: [
    ['media/exact.png', exact], ['media/over.png', over], ['media/small.png', makePng()],
  ] }));
  const report = hdwImport(zipPath, output);
  ok(report.success, `large-media archive import failed: ${JSON.stringify(report)}`);
  eq(report.mediaCount, 3, 'all media records imported');
  eq(addDict(`${output}/${title}`, 0), 1, `large-media dictionary load: ${lastError()}`);
  eq(media(title, 'media/exact.png'), limit, 'exact media limit');
  eq(lastError(), '', 'exact media fetch error');
  ok(Buffer.from(mediaBytes(limit)).equals(exact), 'exact media bytes changed');
  eq(media(title, 'media/over.png'), 0, 'oversized media fetch');
  ok(lastError().includes('media'), 'oversized native media error missing');
  eq(media(title, 'media/small.png'), makePng().length, 'healthy media fetch after error');
  eq(lastError(), '', 'healthy media error');
  ok(lookup('食べる').results.length > 0, 'dictionary remains usable');
});

// ---------------------------------------------------------------------------

G('hdw_segment (word segmentation, #520)');

// A fresh engine instance with the reference dictionary and its frequency
// dictionary, so segmentation is scored without the fixture's own entries. The
// reference set and both dictionaries live in segmentation-reference.mjs.
const S = await createHoshidicts();
const scall = (name, ret, types, args) => S.ccall(name, ret, types, args);
S.FS.mkdir('/work');
scall('hdw_init_storage', 'number', ['number'], [0]);
const simport = (bytes, out) => {
  S.FS.writeFile('/work/seg.zip', Buffer.from(bytes));
  const report = JSON.parse(scall('hdw_import', 'string', ['string', 'string', 'number'], ['/work/seg.zip', out, 0]));
  S.FS.unlink('/work/seg.zip');
  return report;
};
const segTermReport = simport(buildSegmentationDictionaryZip(), '/dicts');
const segFreqReport = simport(buildSegmentationFrequencyZip(), '/dicts');
const segAdd = (title, kind) => scall('hdw_add_dict', 'number', ['string', 'number', 'number'], [`/dicts/${title}`, kind, 0]);
const segmentS = (text, scanLength = 16, options = '') =>
  JSON.parse(scall('hdw_segment', 'string', ['string', 'number', 'string'], [text, scanLength, options]));
const lookupS = (text, maxResults, scanLength) =>
  JSON.parse(scall('hdw_lookup', 'string', ['string', 'number', 'number', 'string'], [text, maxResults, scanLength, ''])).results;

check('the reference dictionaries import and load', () => {
  ok(segTermReport.success, `term import failed: ${segTermReport.error}`);
  ok(segFreqReport.success, `frequency import failed: ${segFreqReport.error}`);
  eq(segAdd(SEGMENTATION_DICTIONARY_TITLE, 0), 1, `term add_dict: ${scall('hdw_last_error', 'string', [], [])}`);
  eq(segAdd(SEGMENTATION_FREQUENCY_TITLE, 1), 1, `frequency add_dict: ${scall('hdw_last_error', 'string', [], [])}`);
});

check('segment conforms to the response contract', () => {
  conforms(segmentS('今日は朝からとても寒いです。', 16), SEGMENT_RESPONSE, 'segment response');
});

check('empty text and non-positive scan length are no-ops', () => {
  same(segmentS('', 16).spans, [], 'empty text');
  same(segmentS('食べる', 0).spans, [], 'scan length 0');
  eq(scall('hdw_last_error', 'string', [], []), '', 'a no-op is not an error');
});

check('spans cover the line in order, with UTF-16 offsets inside the text', () => {
  const text = '白い猫がいる。';
  const units = text.length;
  let previous = 0;
  for (const span of segmentS(text, 16).spans) {
    ok(span.start >= previous, 'spans are ordered and non-overlapping');
    ok(span.start + span.length <= units, 'a span stays inside the text');
    const surface = text.slice(span.start, span.start + span.length);
    eq(span.candidates[0]?.expression !== undefined, true, 'a span has at least one candidate');
    ok(surface.length > 0, 'a span is non-empty');
    previous = span.start + span.length;
  }
});

check('punctuation and whitespace produce no spans', () => {
  same(segmentS('。、！？　', 16).spans, [], 'punctuation and spaces');
  eq(scall('hdw_last_error', 'string', [], []), '', 'punctuation is not an error');
});

check('a conjugated word is one span taking its dictionary form', () => {
  // 食べなかった -> 食べる, the status feature's keying rule.
  const spans = segmentS('食べなかった。', 16).spans;
  eq(spans.length, 1, 'one content span');
  eq(spans[0].candidates[0].expression, '食べる', 'headword');
  eq(spans[0].length, '食べなかった'.length, 'the whole surface is covered');
});

check('function words are flagged and left for the page to leave unmarked', () => {
  const spans = segmentS('猫が好きだ。', 16).spans;
  const byHead = new Map(spans.map((s) => [s.candidates[0]?.expression, s]));
  ok(byHead.get('が')?.functionWord === true, 'が is a function word');
  ok(byHead.get('だ')?.functionWord === true, 'だ is a function word');
  ok(byHead.get('猫')?.functionWord === false, '猫 is a content word');
});

check('a phrase of known words carries its alternative split', () => {
  // 今日は matches the greeting entry; its alternative is 今日 + は, so the
  // highlighter can colour it by 今日 when only that has a card.
  const span = segmentS('今日は', 16).spans[0];
  eq(span.candidates[0].expression, '今日は', 'the whole phrase is the primary span');
  same(span.alternative.map((w) => w.candidates[0].expression), ['今日', 'は'], 'alternative split headwords');
  eq(span.alternative[1].functionWord, true, 'the alternative marks は a function word');
});

check('a single word has no alternative split', () => {
  for (const span of segmentS('猫が好きだ。', 16).spans) {
    if (span.length === 1) same(span.alternative, [], `${span.candidates[0]?.expression} has no alternative`);
  }
});

// Score the greedy longest-match parse and the best split against the reference
// set. Greedy is one max-length lookup per uncovered position; best split is
// hdw_segment. The issue ships greedy if the best split scores no better, so
// this records both.
function greedySpans(text) {
  const chars = Array.from(text);
  const spans = [];
  let index = 0;
  while (index < chars.length) {
    const results = lookupS(chars.slice(index).join(''), 1, 16);
    const matched = results[0]?.matched;
    if (matched) {
      const length = Array.from(matched).length;
      spans.push({ start: index, length, headword: results[0].term.expression });
      index += length;
    } else {
      index += 1;
    }
  }
  return spans;
}

// hdw_segment offsets are UTF-16 code units; the reference lines use no
// surrogate pairs, so a code-point index equals its UTF-16 offset here.
function bestContentSpans(text) {
  return segmentS(text, 16).spans.map((span) => ({
    start: span.start, length: span.length, headword: span.candidates[0]?.expression,
  }));
}

const score = { bestWords: 0, greedyWords: 0, totalWords: 0, bestLines: 0, greedyLines: 0, functionCorrect: 0 };
let conjugatedLines = 0;
let conjugatedCovered = 0;
for (const line of REFERENCE_LINES) {
  const expected = expectedSpans(line);
  const expectedKeys = new Set(expected.map((s) => `${s.start}:${s.length}:${s.headword}`));
  const best = bestContentSpans(line.text);
  const greedy = greedySpans(line.text);
  const bestHits = best.filter((s) => expectedKeys.has(`${s.start}:${s.length}:${s.headword}`)).length;
  const greedyHits = greedy.filter((s) => expectedKeys.has(`${s.start}:${s.length}:${s.headword}`)).length;
  score.totalWords += expected.length;
  score.bestWords += bestHits;
  score.greedyWords += greedyHits;
  if (bestHits === expected.length && best.length === expected.length) score.bestLines += 1;
  if (greedyHits === expected.length && greedy.length === expected.length) score.greedyLines += 1;
  const bestByPosition = new Map(segmentS(line.text, 16).spans.map((s) => [`${s.start}:${s.length}`, s]));
  for (const e of expected) {
    const span = bestByPosition.get(`${e.start}:${e.length}`);
    if (span && span.functionWord === e.functionWord) score.functionCorrect += 1;
  }
  if (line.conjugated) {
    conjugatedLines += 1;
    // Every content word whose surface differs from its headword was recovered.
    const recovered = line.words.every(([surface, headword, fn]) => {
      if (fn || surface === headword) return true;
      return best.some((s) => s.headword === headword
        && line.text.slice(s.start, s.start + Array.from(surface).length) === surface);
    });
    if (recovered) conjugatedCovered += 1;
  }
}

const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
console.log(`        reference set: ${REFERENCE_LINES.length} lines, ${score.totalWords} words`);
console.log(`        best split : ${score.bestWords}/${score.totalWords} words (${pct(score.bestWords, score.totalWords)}), `
  + `${score.bestLines}/${REFERENCE_LINES.length} lines exact`);
console.log(`        greedy     : ${score.greedyWords}/${score.totalWords} words (${pct(score.greedyWords, score.totalWords)}), `
  + `${score.greedyLines}/${REFERENCE_LINES.length} lines exact`);
console.log(`        function-word flag: ${score.functionCorrect}/${score.totalWords} correct`);
console.log(`        conjugated lines fully recovered: ${conjugatedCovered}/${conjugatedLines}`);

check('the best split scores at least as well as the greedy parse', () => {
  ok(score.bestWords >= score.greedyWords,
    `best split ${score.bestWords} words < greedy ${score.greedyWords}; the issue ships greedy only if it scores no worse`);
  ok(score.bestLines >= score.greedyLines, `best split ${score.bestLines} lines-exact < greedy ${score.greedyLines}`);
});

check('the best split fixes at least one boundary the greedy parse gets wrong', () => {
  // 白い猫がいる: greedy takes がい (外) and strands る; the best split keeps
  // が + いる. This is the Design-2 case the whole-line split is for.
  const text = '白い猫がいる。';
  const best = bestContentSpans(text).map((s) => `${s.start}:${s.length}:${s.headword}`);
  const greedy = greedySpans(text).map((s) => `${s.start}:${s.length}:${s.headword}`);
  ok(best.includes('3:1:が') && best.includes('4:2:いる'), `best split: ${best.join(' ')}`);
  ok(greedy.includes('3:2:外'), `greedy did not take the がい trap: ${greedy.join(' ')}`);
});

check('most conjugated reference lines recover their dictionary forms', () => {
  // The deinflector is Yomitan-equivalent; a few auxiliary-verb chains it joins
  // (て + しまう, て + くれる) are reported in the score above rather than failed.
  ok(conjugatedCovered >= Math.ceil(conjugatedLines * 0.9),
    `${conjugatedCovered}/${conjugatedLines} conjugated lines recovered; expected at least 90%`);
});

check('segment honours the frequency option', () => {
  // With the frequency dictionary disabled, ties fall back to the greedy
  // longest-first order; the response still conforms and covers the line.
  const disabled = JSON.stringify({ frequencyDictionary: '', frequencyOrder: 'disabled', primaryReading: '' });
  conforms(segmentS('白い猫がいる。', 16, disabled), SEGMENT_RESPONSE, 'segment with frequency disabled');
  eq(scall('hdw_last_error', 'string', [], []), '', 'disabled frequency is not an error');
});

check('segment rejects text above the 4 KiB lookup limit', () => {
  const tooLong = 'あ'.repeat(1500);
  const response = JSON.parse(scall('hdw_segment', 'string', ['string', 'number', 'string'], [tooLong, 16, '']));
  same(response.spans, [], 'oversized text returns no spans');
  ok(scall('hdw_last_error', 'string', [], []).includes('segment text'), 'oversized text reports an error');
  // The engine stays usable.
  ok(segmentS('猫がいる。', 16).spans.length > 0, 'engine usable after a refused segment');
});

// ---------------------------------------------------------------------------

G('low-memory pool (HACHIDORI_PTHREAD_POOL_SIZE = 2)');

// engine-worker-runtime.js sets this before createHoshidicts for the
// low-memory worker: one importer thread plus the OPFS proxy. The built glue
// must read the override, and the low-RAM importer must complete in it. Node
// grows an exhausted pool on demand (PThread.getNewWorker), so the strict pool
// (PTHREAD_POOL_SIZE_STRICT=2) is only exercised by the real-Chrome suite.
if (VARIANT === 'hoshidicts') {
  console.log('  single-thread runtime has no pool; the low-RAM import path is covered above');
} else {
  check('the built glue sizes its pool from the runtime override', () => {
    ok(readFileSync(MODULE_PATH, 'utf8').includes('globalThis.HACHIDORI_PTHREAD_POOL_SIZE??'), 'override expression missing from the glue');
  });
  globalThis.HACHIDORI_PTHREAD_POOL_SIZE = 2;
  const L = await createHoshidicts();
  delete globalThis.HACHIDORI_PTHREAD_POOL_SIZE;
  const lcall = (name, ret, types, args) => L.ccall(name, ret, types, args);
  L.FS.mkdir('/work');
  L.FS.writeFile('/work/fixture.zip', buildFixtureZip());
  L.FS.writeFile('/work/many-banks.zip', buildManyBankZip());
  check('storage initializes in the small pool', () => {
    eq(lcall('hdw_init_storage', 'number', ['number'], [0]), 1, lcall('hdw_last_error', 'string', [], []));
  });
  const lowReport = JSON.parse(lcall('hdw_import', 'string', ['string', 'string', 'number'], ['/work/fixture.zip', '/dicts', 1]));
  check('a low-RAM import completes with two pool threads', () => {
    eq(lowReport.success, true, lowReport.error);
    eq(lowReport.termCount, EXPECTED.termCount, 'termCount');
  });
  const lowManyReport = JSON.parse(lcall('hdw_import', 'string', ['string', 'string', 'number'], ['/work/many-banks.zip', '/dicts', 1]));
  check('twenty term banks import single-threaded in the small pool', () => {
    eq(lowManyReport.success, true, lowManyReport.error);
    eq(lowManyReport.termCount, MANY_BANK_COUNT, 'term count');
  });
  check('the small-pool module loads and answers lookups', () => {
    eq(lcall('hdw_add_dict', 'number', ['string', 'number', 'number'], [DICT_DIR, 0, 0]), 1, lcall('hdw_last_error', 'string', [], []));
    const result = JSON.parse(lcall('hdw_lookup', 'string', ['string', 'number', 'number', 'string'], ['食べたかった', 32, 16, '']));
    eq(result.results[0]?.term.expression, '食べる', 'expression');
  });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const { label, message } of failures) console.log(`  ${label}\n    ${message.replace(/\n/g, '\n    ')}`);
  process.exit(1);
}
console.log('\nfixture counts (use these as the expectation baseline):');
for (const [k, v] of Object.entries(EXPECTED)) console.log(`  ${k}: ${v}`);
