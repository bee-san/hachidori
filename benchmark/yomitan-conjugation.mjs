// SPDX-License-Identifier: GPL-3.0-or-later
// Targeted C ABI lookup timings; excludes imports, browser routing and rendering.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { buildHistoricalKanaZip, HISTORICAL_KANA_TITLE, HISTORICAL_KANA_CASES } from '../test/historical-kana-fixture.mjs';

const modern = ['思います', '思いたくなかった', '食べたかった', '食べさせられたくなかった',
  '買わない', '読んでいる', '來ました', '行こう', '飲まない', '愛しそう'];
const historical = HISTORICAL_KANA_CASES.map(([source]) => source);
const runtimes = [];
for (const [label, directory] of [['base', resolve(process.env.HACHIDORI_BASE_RUNTIME || 'test/tmp/yomitan-base/extension/vendor')], ['head', resolve('extension/vendor')]]) {
  const { default: create } = await import(pathToFileURL(resolve(directory, 'hoshidicts-threaded.mjs')));
  const runtime = await create();
  runtime.ccall('hdw_init_storage', 'number', ['number'], [0]);
  runtime.FS.writeFile('/fixture.zip', buildHistoricalKanaZip());
  const report = JSON.parse(runtime.ccall('hdw_import', 'string', ['string', 'string', 'number'], ['/fixture.zip', '/dicts', 0]));
  if (!report.success) throw Error(JSON.stringify(report));
  runtime.ccall('hdw_add_dict', 'number', ['string', 'number', 'number', 'number'], [`/dicts/${HISTORICAL_KANA_TITLE}`, 0, 0, 0]);
  runtimes.push({ label, runtime });
}
function batch(runtime, queries, repeats) {
  let totalResults = 0;
  const start = performance.now();
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const text of queries) totalResults += JSON.parse(runtime.ccall('hdw_lookup', 'string',
      ['string', 'number', 'number', 'string'], [text, 32, 32, ''])).results.length;
  }
  return { usPerLookup: (performance.now() - start) * 1000 / (queries.length * repeats), totalResults };
}
try {
  for (const { runtime } of runtimes) { batch(runtime, modern, 200); batch(runtime, historical, 20); }
  const results = { modern: { base: [], head: [] }, historical: { base: [], head: [] } };
  for (let round = 0; round < 7; round++) {
    for (const { label, runtime } of round % 2 ? [...runtimes].reverse() : runtimes) {
      results.modern[label].push(batch(runtime, modern, 1000));
      results.historical[label].push(batch(runtime, historical, 100));
    }
  }
  console.log(JSON.stringify({ node: process.version, modern, historicalCount: historical.length, results }, null, 2));
} finally {
  for (const { runtime } of runtimes) runtime.PThread?.terminateAllThreads();
}
