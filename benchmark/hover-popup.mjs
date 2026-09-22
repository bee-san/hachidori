// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, loadavg, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { directoryContentSha256 } from './system.mjs';

const root = resolve(process.env.HACHIDORI_BENCH_REPO ?? import.meta.dirname, process.env.HACHIDORI_BENCH_REPO ? '.' : '..');
const output = resolve(process.argv[2]);
const archives = process.argv.slice(3).map(path => resolve(path));
assert.ok(archives.length);
mkdirSync(output, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const probe = readFileSync(new URL('./hover-popup-probe.js', import.meta.url), 'utf8');
const samples = Number(process.env.HACHIDORI_HOVER_SAMPLES ?? 3);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const settings = { hoverEnabled: true, lookupMode: 'hover', hoverDelayMs: 0, popupNestingMaxDepth: 2,
  popupWidthPx: 520, popupHeightPx: 500, popupColumns: 1, maxResults: 32,
  definitionBlurEnabled: false, showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3 };
const words = ['食べる', '漢字', '深層'];
const manifest = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, load: loadavg(), settings, words,
  extensionSha256: directoryContentSha256(resolve(root, 'extension')),
  samples, warmups: 'one alternating pair per fresh session, excluded; cold first-open separate',
  threshold: 'retain candidate only if warm blank duration improves by >= 5 ms and >= 25%; first/complete regression > 5 ms and 10% requires investigation',
  probeSha256: sha256(probe), harnessSha256: sha256(readFileSync(new URL(import.meta.url))),
  archives: archives.map(path => ({ path, bytes: readFileSync(path).length, sha256: sha256(readFileSync(path)) })) };
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const puppeteer = await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href);
// A 5,000-character paragraph in one text node with the word 600 characters in
// and no sentence terminator: the sentence walk has its whole extent to cover
// both ways, and everything beyond the extent is there to be left unread.
const longParagraph = `${'あ'.repeat(600)}食べる${'い'.repeat(4397)}`;
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><meta charset="utf-8"><style>body{font:32px sans-serif;margin:60px}span{display:inline-block;margin-right:100px}#hit-tile{position:absolute;left:60px;top:650px;width:200px;height:96px;padding:12px 24px}#long{position:absolute;left:60px;top:780px;width:1300px;height:200px;margin:0;overflow:hidden;font:14px/1.2 sans-serif;word-break:break-all}</style><span id="w2">深層</span><span id="w0">食べる</span><span id="w1">漢字</span><br><a id="hit-tile">食べる</a>'
    + `<p id="long">${longParagraph}</p>`);
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const rows = [];
const signatures = new Map();
try {
  for (let session = 0; session < samples; session++) {
    const directory = mkdtempSync(resolve(tmpdir(), 'hachidori-hover-'));
    const extension = resolve(directory, 'extension');
    cpSync(resolve(root, 'extension'), extension, { recursive: true });
    const contentPath = resolve(extension, 'content.js');
    const original = readFileSync(contentPath, 'utf8');
    const marker = '  start();\n}());';
    assert.equal(original.split(marker).length, 2);
    writeFileSync(contentPath, original.replace(marker, `${probe}\n${marker}`));
    let browser;
    try {
      browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME,
        headless: true, enableExtensions: true, userDataDir: resolve(directory, 'profile'),
        protocolTimeout: 600000, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
          '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'] });
      const worker = await browser.waitForTarget(target => target.type() === 'service_worker'
        && target.url().startsWith('chrome-extension://'));
      const id = new URL(worker.url()).host;
      const page = await browser.newPage();
      page.setDefaultTimeout(600000);
      await page.goto(`chrome-extension://${id}/settings.html#add-dictionaries`);
      await page.bringToFront();
      await page.waitForFunction(async () => {
        const status = await chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_status' });
        return status.ok && status.ready && !status.loading;
      });
      await (await page.$('#import-file')).uploadFile(...archives);
      await page.waitForFunction(count => document.getElementById('import-state').textContent
        === `Finished ${count} of ${count} archives — ${count} imported, 0 failed.`
        || (count === 1 && document.getElementById('import-state').textContent
          === 'Finished 1 of 1 archive — 1 imported, 0 failed.'), {}, archives.length);
      const installed = await page.evaluate(async options => {
        const current = (await chrome.storage.local.get('options')).options;
        const reply = await chrome.runtime.sendMessage({ target: 'hoshidicts-worker', type: 'hd_options_write',
          baseRevision: current.revision, options });
        if (!reply.ok) throw new Error(JSON.stringify(reply));
        return { options: reply.options, storage: await chrome.storage.local.get('dictionaryState'),
          status: await chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_status' }) };
      }, settings);
      writeFileSync(resolve(output, `session-${session}-installed.json`), JSON.stringify(installed, null, 2));
      assert.equal(installed.storage.dictionaryState.dictionaries.length, archives.length);
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1440, height: 1000 });
      const cdp = await tab.createCDPSession();
      const contexts = [];
      cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
      await cdp.send('Runtime.enable');
      await cdp.send('Performance.enable');
      await tab.goto(`http://127.0.0.1:${server.address().port}`);
      await tab.bringToFront();
      let contextId;
      for (let retry = 0; retry < 100 && !contextId; retry++) {
        for (const context of contexts) {
          const value = await cdp.send('Runtime.evaluate', { contextId: context.id,
            expression: 'typeof __hoverProbe', returnByValue: true }).catch(() => null);
          if (value?.result.value === 'object') contextId = context.id;
        }
        if (!contextId) await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      assert.ok(contextId, 'production content-script probe ready');
      async function evaluate(expression) {
        const result = await cdp.send('Runtime.evaluate', { contextId, expression, returnByValue: true, awaitPromise: true });
        assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }
      async function move(index) {
        const point = await tab.$eval(`#w${index}`, node => {
          const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 1);
          const box = range.getBoundingClientRect(); return { x: box.x + box.width * .2, y: box.y + box.height / 2 };
        });
        await tab.mouse.move(point.x, point.y);
      }
      async function finish(label, beforeMetrics) {
        let row;
        for (let retry = 0; retry < 600; retry++) {
          row = await evaluate('__hoverProbe.read()');
          if (row.complete !== null) break;
          await new Promise(resolveWait => setTimeout(resolveWait, 10));
        }
        writeFileSync(resolve(output, `session-${session}-${label}.json`), JSON.stringify(row, null, 2));
        assert.ok(row.complete !== null, `${label} complete result barrier`);
        assert.ok(row.replies.length && row.replies.at(-1).count > 0);
        row.session = session; row.label = label; row.chrome = await browser.version();
        row.firstMs = row.first - row.start; row.completeMs = row.complete - row.start;
        row.resultSignature = sha256(JSON.stringify(row.replies.at(-1).results));
        if (signatures.has(row.expected)) assert.equal(row.resultSignature, signatures.get(row.expected));
        else signatures.set(row.expected, row.resultSignature);
        row.blankMs = 0;
        for (let i = 0; i < row.states.length; i++) {
          const snapshot = row.states[i];
          const current = snapshot.levels[row.depth];
          if (!current || current.hidden || !current.connected || !current.expressions.length) {
            row.blankMs += Math.max(0, Math.min(row.first, row.states[i + 1]?.at ?? row.first) - snapshot.at);
          }
        }
        row.metricsBefore = beforeMetrics;
        row.metricsAfter = (await cdp.send('Performance.getMetrics')).metrics;
        rows.push(row);
        writeFileSync(resolve(output, 'raw.json'), JSON.stringify(rows, null, 2));
        console.log(JSON.stringify({ session, label, firstMs: row.firstMs, completeMs: row.completeMs,
          blankMs: row.blankMs, count: row.replies.at(-1).count, resultSignature: row.resultSignature }));
        return row;
      }
      async function scan(index, label, depth = 0, point = null) {
        const metrics = (await cdp.send('Performance.getMetrics')).metrics;
        await evaluate(`__hoverProbe.arm(${JSON.stringify(words[index])}, ${depth})`);
        if (point) await tab.mouse.move(point.x, point.y); else await move(index);
        return finish(label, metrics);
      }
      await scan(0, 'cold');
      await tab.screenshot({ path: resolve(output, `session-${session}-cold.png`) });
      for (let i = 0; i < 2; i++) await scan((i + 1) % 2, `warmup-${i}`);
      for (let i = 0; i < 8; i++) await scan((i + 1) % 2, `root-${i}`);
      // The depth-40 entry alternates with a flat one so each hover replaces a popup.
      for (let i = 0; i < 8; i++) {
        await scan(2, `deep-nesting-${i}`);
        await scan((i + 1) % 2, `deep-nesting-flat-${i}`);
      }
      await tab.tracing.start({ path: resolve(output, `session-${session}-trace.json`), screenshots: false });
      await scan(1, 'trace-0');
      await scan(0, 'trace-1');
      await tab.tracing.stop();
      const metrics = (await cdp.send('Performance.getMetrics')).metrics;
      await evaluate('__hoverProbe.arm("漢字", 0, 150)');
      await move(1);
      for (let retry = 0; retry < 100; retry++) {
        if ((await evaluate('__hoverProbe.read()')).start !== null) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 5));
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
      const superseded = await evaluate('__hoverProbe.read()');
      assert.ok(superseded.start !== null, 'superseded scan started');
      await scan(0, 'rapid-final');
      let delivered;
      for (let retry = 0; retry < 600; retry++) {
        delivered = (await evaluate('__hoverProbe.events()')).filter(event => event.kind === 'reply'
          && event.sent >= superseded.start);
        if (delivered.some(event => event.query === words[1])) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
      }
      const late = delivered.find(event => event.query === words[1]);
      const latest = delivered.find(event => event.query.startsWith(words[0]));
      assert.ok(late && latest && late.delivered > latest.delivered, 'genuine earlier lookup delivered out of order');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const final = await evaluate('__hoverProbe.state()');
      assert.equal(final[0].expressions[0], words[0], 'delayed genuine reply cannot repaint newer result');
      writeFileSync(resolve(output, `session-${session}-rapid.json`), JSON.stringify({ superseded, delivered, final, metrics }, null, 2));
      // Only the two flat entries name each other in their definitions.
      const points = await evaluate(`JSON.stringify(${JSON.stringify(words.slice(0, 2))}.map(word => __hoverProbe.point(word)))`);
      const nested = JSON.parse(points);
      if (nested.every(Boolean)) {
        await scan(1, 'child-first', 1, nested[1]);
        await scan(0, 'child-replace', 1, nested[0]);
        await tab.screenshot({ path: resolve(output, `session-${session}-child.png`) });
      } else console.log(JSON.stringify({ session, nested: 'not supported by visible first definition', points: nested }));
      const hitPoints = await tab.$eval('#hit-tile', node => {
        const range = document.createRange();
        range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 1);
        const rect = range.getBoundingClientRect();
        return { glyph: { x: rect.left + rect.width * .2, y: rect.top + rect.height / 2 },
          padding: { x: rect.left - 20, y: rect.top + rect.height / 2 } };
      });
      hitPoints.long = await tab.$eval('#long', node => {
        const offset = node.firstChild.nodeValue.indexOf('食べる');
        const range = document.createRange();
        range.setStart(node.firstChild, offset); range.setEnd(node.firstChild, offset + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width * .3, y: rect.top + rect.height / 2 };
      });
      const hitTesting = await evaluate(`__hoverProbe.hitTesting(${JSON.stringify(hitPoints)})`);
      const sentenceCost = await evaluate(`__hoverProbe.sentenceCost(${JSON.stringify(hitPoints.long)})`);
      writeFileSync(resolve(output, `session-${session}-hit-testing.json`), JSON.stringify({
        points: hitPoints, samples: hitTesting, sentenceCost,
        boundary: 'synchronous production resolveCandidate; 100 warmups per point excluded; excludes event scheduling, messaging, lookup and rendering',
        longParagraph: { characters: longParagraph.length, matchOffset: longParagraph.indexOf('食べる') },
      }, null, 2));
      console.log(JSON.stringify({ session, hitTesting, sentenceCost }));
    } finally {
      await browser?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally { await new Promise(resolveClose => server.close(resolveClose)); }
if (process.env.HACHIDORI_HOVER_CONTRACT === '1') {
  for (const row of rows.filter(row => row.label.startsWith('root-'))) {
    const last = row.states.at(-1).levels[0];
    assert.equal(last.popup, row.before[0].popup, 'root popup identity is retained');
    assert.equal(last.view, row.before[0].view, 'root view identity is retained');
    assert.ok(!row.states.some(snapshot => snapshot.levels[0]?.hidden),
      'an open root popup must not be hidden while replacing a valid hover lookup');
  }
}
