// SPDX-License-Identifier: GPL-3.0-or-later
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const base = '11343b4f02270d44271674f53f8331018de3e03e';
const current = readFileSync('extension/word-status-overrides.js', 'utf8');
const before = execFileSync('git', ['show', `${base}:extension/word-status-overrides.js`], { encoding: 'utf8' });
const load = source => { const context = createContext({}); runInContext(source, context); return context.HDWordStatusOverrides; };
const oldApi = load(before), newApi = load(current);
const initial = { revision: 0, known: Array.from({ length: 10000 }, (_, i) => `語${i}`), ignored: ['人名'] };
const words = Array.from({ length: 1000 }, (_, i) => `単語${i}`);
const text = words.join('\n');
const samples = { perWordMs: [], batchMs: [] };
const measure = callback => { const start = performance.now(); callback(); return performance.now() - start; };
for (let i = 0; i < 7; i++) {
  const jobs = {
    perWordMs: () => { let record = initial; for (const word of words) record = oldApi.withLanguageWordStatusOverride(record, 'ja', word, 'known'); },
    batchMs: () => newApi.withKnownWords(initial, 'ja', text),
  };
  for (const key of i % 2 ? ['batchMs', 'perWordMs'] : ['perWordMs', 'batchMs']) samples[key].push(measure(jobs[key]));
}
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const result = { base, node: process.version, cpu: cpus()[0].model, existingWords: 10000, pastedWords: 1000, samples,
  medians: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, median(values)])),
  limitation: 'Pure production merge functions. Per-word baseline excludes messaging and storage; this is not end-to-end latency.' };
writeFileSync('test/tmp/known-words-benchmark.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));

// Run the real highlighter with the existing jsdom layout/status fixture.
const fixtureSource = readFileSync('test/word-highlights.test.mjs', 'utf8').split('const VERBS =')[0]
  .replace('import test from "node:test";', '')
  .replace('import assert from "node:assert/strict";', '')
  .replace('"../extension/reader-options.js"', '"../../extension/reader-options.js"')
  .replace('new URL("../extension/word-highlights.js", import.meta.url)', 'process.env.KNOWN_WORDS_HIGHLIGHT_SOURCE')
  + '\nexport { fixture, settle };\n';
writeFileSync('test/tmp/known-words-fixture.mjs', fixtureSource);
writeFileSync('test/tmp/word-highlights-before.js', execFileSync('git', ['show', `${base}:extension/word-highlights.js`]));
const runtimes = {};
for (const version of ['before', 'after']) {
  process.env.KNOWN_WORDS_HIGHLIGHT_SOURCE = resolve(version === 'before' ? 'test/tmp/word-highlights-before.js' : 'extension/word-highlights.js');
  runtimes[version] = await import(`${pathToFileURL(resolve('test/tmp/known-words-fixture.mjs')).href}?${version}`);
}
const repaint = { before: [], after: [] };
for (let i = 0; i < 7; i++) for (const version of i % 2 ? ['after', 'before'] : ['before', 'after']) {
  let cleanup;
  const { fixture, settle } = runtimes[version];
  const page = fixture({ after: callback => { cleanup = callback; } },
    Array.from({ length: 100 }, (_, j) => `<p id="line${j}">猫 犬 鳥 魚 馬 猫 犬 鳥 魚 馬</p>`).join(''),
    { lexicon: { 猫: {}, 犬: {}, 鳥: {}, 魚: {}, 馬: {} }, options: { wordHighlightKnown: true } });
  page.start(); page.show(...page.document.querySelectorAll('p')); await settle();
  const start = performance.now();
  for (let j = 0; j < 20; j++) { page.highlighter.setOverrides(new Map([[j % 2 ? '猫' : '犬', 'known']])); await settle(); }
  repaint[version].push((performance.now() - start) / 20);
  page.highlighter.stop(); cleanup();
}
result.repaint = { spans: 1000, repaintsPerSample: 20, samplesMs: repaint,
  mediansMs: Object.fromEntries(Object.entries(repaint).map(([key, values]) => [key, median(values)])),
  limitation: 'Production highlighter, jsdom fake layout/index. Includes the event-loop settle. Browser paint and dictionary segmentation are not timed.' };
writeFileSync('test/tmp/known-words-benchmark.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.repaint));
