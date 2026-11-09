import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { resolve } from 'node:path';
const [before, after] = process.argv.slice(2);
if (!before || !after) throw new Error('Usage: node cache-benchmark.mjs BEFORE_CHECKOUT AFTER_CHECKOUT');
await import(pathToFileURL(resolve(after, 'extension/reader-options.js')));
const base = await import(pathToFileURL(resolve(before, 'extension/anki-index-cache.js')));
const head = await import(pathToFileURL(resolve(after, 'extension/anki-index-cache.js')));
const rows = Array.from({length: 20000}, (_, i) => [`語${i}`, i % 2 === 0, [i + 1]]).sort(([a], [b]) => a.localeCompare(b));
const extra = Array.from({length: 10000}, (_, i) => [`外${i}`, true, [i + 20001]]);
const words = rows.slice(0, 1000).map(row => row[0]);
const copy = structuredClone;
async function sample(module, enabled, scope) {
  const options = HDReaderOptions.normaliseOptions({wordHighlightEnabled: enabled,
    anki: {model: 'Japanese', fields: {expression: 'Expression'}, duplicateScope: scope}});
  let state, calls = 0, writes = 0;
  const alarms = new Map();
  const service = module.createAnkiDuplicateIndex({
    readOptions: async () => copy(options), readState: async () => copy(state),
    updateState: async change => {
      const next = await change({options: copy(options), state: copy(state)});
      if(next !== undefined) { state = copy(next); writes++; }
      return copy(state);
    },
    fetchRows: async source => { calls++; return copy(source.scope === 'all' ? [...rows, ...extra] : rows); },
    lookupLive: async () => {throw new Error('Unexpected live query');},
    alarms: {get: async key => alarms.get(key), clear: async key => alarms.delete(key),
      create: async (key, value) => alarms.set(key, {scheduledTime: value.when})},
    reportError: error => { throw error; }
  });
  const expected = (await module.ankiIndexSources(options)).size;
  const start = performance.now();
  await service.reconcile();
  while((state?.attempts ?? [state?.attempt]).filter(a => a?.finishedAt !== undefined).length < expected)
    await new Promise(resolve => setImmediate(resolve));
  await service.reconcile();
  const refreshMs = performance.now() - start;
  const count = calls;
  const statusStart = performance.now();
  for(let n=0;n<100;n++) await service.statuses(options.anki, words);
  const statusMs = (performance.now()-statusStart)/100;
  if(calls !== count) throw new Error('Status contacted Anki');
  const writeStart = performance.now();
  const priorWrites = writes;
  await service.recordWrite(options.anki, '新語', 50000);
  return {refreshMs,statusMs,writeMs:performance.now()-writeStart,refreshCalls:calls,
    snapshots:expected,bytes:Buffer.byteLength(JSON.stringify(state)),storageWrites:writes-priorWrites};
}
const median = values => values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
const results = [];
for(const [enabled, scope] of [[false,'model'],[true,'model'],[true,'all']]) {
  const samples = {base:[],head:[]};
  for(let n=0;n<7;n++) for(const [name,module] of n%2 ? [['head',head],['base',base]] : [['base',base],['head',head]])
    samples[name].push(await sample(module,enabled,scope));
  results.push({enabled,scope,samples,medians:Object.fromEntries(Object.entries(samples).map(([name,runs])=>[name,
    Object.fromEntries(Object.keys(runs[0]).map(key=>[key,median(runs.map(run=>run[key]))]))]))});
}
console.log(JSON.stringify({node:process.version,cpu:os.cpus()[0].model,runs:7,notes:30000,wordsPerBatch:1000,
  batchesPerSample:100,base:'d1842d10',results},null,2));
