// SPDX-License-Identifier: GPL-3.0-or-later
// Per-frame cost of the manifest content scripts before any hover, and what
// loading the popup renderer on demand would cost instead (#533 item 7).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeValues } from './lib.mjs';
import { chromeProcesses, cpuDelta, directoryContentSha256, hostSnapshot, pageRendererMemory,
  sha256File } from './system.mjs';

const root = resolve(process.env.HACHIDORI_BENCH_REPO ?? import.meta.dirname, process.env.HACHIDORI_BENCH_REPO ? '.' : '..');
const output = process.argv[2] && resolve(process.argv[2]);
assert.ok(output, 'usage: node benchmark/content-injection.mjs <fresh-output-directory>');
assert.ok(!existsSync(output) || readdirSync(output).length === 0, 'the output directory must be fresh');
mkdirSync(output, { recursive: true });
const samples = Number(process.env.HACHIDORI_INJECTION_SAMPLES ?? 5);
const frameCount = Number(process.env.HACHIDORI_INJECTION_FRAMES ?? 20);
const settleMs = Number(process.env.HACHIDORI_INJECTION_SETTLE_MS ?? 3000);
for (const value of [samples, frameCount, settleMs]) assert.ok(Number.isSafeInteger(value) && value > 0);
const puppeteer = await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href);
const manifest = JSON.parse(readFileSync(resolve(root, 'extension/manifest.json'), 'utf8'));
assert.equal(manifest.content_scripts.length, 1);
const [entry] = manifest.content_scripts;
const RENDERER = ['render/glossary.js', 'render/popup.js'];
assert.ok(RENDERER.every(file => entry.js.includes(file)));
// `none` drops the content scripts (the control) and `production` keeps the
// manifest's list. `no-renderer` drops the two renderer files and stubs the two
// HDPopup members content.js reads before a popup exists: it estimates what
// deferring the renderer saves before the first hover, and cannot show a popup.
// Timing marks run before, between and after the files of both lists.
const VARIANTS = ['none', 'production', 'no-renderer'];
const PAGES = ['plain', 'same-site', 'cross-site'];
const STUB = 'globalThis.HDPopup = { normaliseDictionaryTab: () => null, metadataOptions: () => ({}) };\n';
const mark = last => `(globalThis.__hdInjectionMarks ??= []).push(performance.now());\n${last
  ? 'document.documentElement.setAttribute("data-hd-injection", JSON.stringify({ timeOrigin: performance.timeOrigin, marks: globalThis.__hdInjectionMarks }));\n' : ''}`;
// On a main-world event, load the renderer into this frame's content-script
// world through the worker (`scripting`) or a dynamic import (`import`).
const LAZY = `document.addEventListener("hd-bench-lazy", async () => {
  const mode = document.documentElement.dataset.hdLazyMode;
  const started = performance.now();
  let error = null;
  try {
    if (mode === "import") await Promise.all(${JSON.stringify(RENDERER)}.map(file => import(chrome.runtime.getURL(file))));
    else {
      const reply = await chrome.runtime.sendMessage({ target: "hachidori-benchmark", type: "inject-renderer" });
      if (!reply?.ok) throw new Error(reply?.error ?? "no reply");
    }
  } catch (caught) { error = String(caught?.message ?? caught); }
  const ms = performance.now() - started;
  document.documentElement.dataset.hdLazy = JSON.stringify({ mode, ms, error,
    loaded: typeof globalThis.HDPopup?.createPopupView === "function" && typeof globalThis.HDGlossary?.glossaryToPlainText === "function" });
});
`;
const settings = { hoverEnabled: true, lookupMode: 'hover', definitionBlurCountEnabled: false };
const text = '<p style="font:24px sans-serif">日本語の文章を読みながら、知らない言葉を調べます。</p>';
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
// The distribution without its samples, which raw.jsonl keeps.
const summarize = values => {
  if (!values.length) return null;
  const { samples: _, ...distribution } = summarizeValues(values);
  return distribution;
};

function prepare(directory, variant) {
  const extension = resolve(directory, 'extension');
  cpSync(resolve(root, 'extension'), extension, { recursive: true });
  const copy = structuredClone(manifest);
  delete copy.content_scripts;
  if (variant !== 'none') {
    let files = entry.js;
    if (variant === 'no-renderer') {
      const at = files.indexOf(RENDERER[0]);
      files = files.filter(file => !RENDERER.includes(file));
      files.splice(at, 0, 'bench-renderer-stub.js');
      writeFileSync(resolve(extension, 'bench-renderer-stub.js'), STUB);
      writeFileSync(resolve(extension, 'bench-lazy.js'), LAZY);
      copy.web_accessible_resources.push({ resources: RENDERER, matches: ['<all_urls>'] });
    }
    const js = files.flatMap((file, index) => [`bench-mark-${index}.js`, file]);
    js.push(`bench-mark-${files.length}.js`);
    for (let index = 0; index <= files.length; index++) {
      writeFileSync(resolve(extension, `bench-mark-${index}.js`), mark(index === files.length));
    }
    if (variant === 'no-renderer') js.push('bench-lazy.js');
    copy.content_scripts = [{ ...entry, js }];
  }
  writeFileSync(resolve(extension, 'manifest.json'), JSON.stringify(copy, null, 2));
  return extension;
}

// A plain page, then 20 same-site iframes (one renderer process) or 20
// cross-site iframes (one process each), every frame holding the same text.
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const port = server.address().port;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/frame') return response.end(`<!doctype html><meta charset="utf-8">${text}`);
  const kind = url.pathname.slice(1);
  if (!PAGES.includes(kind)) {
    response.statusCode = 404;
    return response.end();
  }
  const frames = kind === 'plain' ? [] : Array.from({ length: frameCount }, (_, index) => kind === 'same-site'
    ? `http://127.0.0.1:${port}/frame?i=${index}` : `http://f${index}.test:${port}/frame?i=${index}`);
  response.end(`<!doctype html><meta charset="utf-8"><title>${kind}</title>${text}${frames
    .map(src => `<iframe src="${src}" width="280" height="80"></iframe>`).join('')}`);
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));

// Each cross-site frame is a fresh renderer process that has never compiled the
// renderer: even frames load it through the worker twice (cold, then warm), odd
// frames once through a dynamic import.
async function measureLazyLoads(frames) {
  const lazy = [];
  for (const [index, frame] of frames.entries()) {
    for (const [attempt, mode] of (index % 2 ? ['import'] : ['scripting', 'scripting']).entries()) {
      await frame.evaluate(mode => {
        delete document.documentElement.dataset.hdLazy;
        document.documentElement.dataset.hdLazyMode = mode;
        document.dispatchEvent(new Event('hd-bench-lazy'));
      }, mode);
      const result = JSON.parse(await (await frame.waitForFunction(() => document.documentElement.dataset.hdLazy,
        { timeout: 60000, polling: 10 })).jsonValue());
      assert.equal(result.error, null, `lazy ${mode} failed`);
      assert.equal(result.loaded, true, `lazy ${mode} did not populate the content-script globals`);
      lazy.push({ ...result, frame: index, warm: attempt > 0 });
    }
  }
  return lazy;
}

async function measurePage(browser, kind, variant) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const browserPid = browser.process().pid;
  const before = chromeProcesses(browserPid);
  const started = performance.now();
  await page.goto(`http://127.0.0.1:${server.address().port}/${kind}`, { waitUntil: 'load' });
  const loadMs = performance.now() - started;
  const frames = page.frames();
  assert.equal(frames.length, kind === 'plain' ? 1 : frameCount + 1);
  // The control waits as well: Puppeteer's wait puts its utility script and
  // poller in every frame's main world, so all three copies carry them.
  const ready = variant === 'none' ? () => true : () => document.documentElement.hasAttribute('data-hd-injection');
  await Promise.all(frames.map(frame => frame.waitForFunction(ready, { timeout: 60000 })));
  await sleep(settleMs);
  const cpu = cpuDelta(before, chromeProcesses(browserPid));
  const injection = variant === 'none' ? [] : await Promise.all(frames.map(async frame => {
    const { timeOrigin, marks } = JSON.parse(await frame.evaluate(
      () => document.documentElement.getAttribute('data-hd-injection')));
    return { top: frame === page.mainFrame(), start: timeOrigin + marks[0],
      totalMs: marks.at(-1) - marks[0], fileMs: marks.slice(1).map((value, index) => value - marks[index]) };
  }));
  // One CDP session per renderer process: the page's and each cross-site frame's.
  let heapUsedBytes = 0;
  for (const client of new Map(frames.map(frame => [frame.client.id(), frame.client])).values()) {
    await client.send('HeapProfiler.collectGarbage');
    await client.send('HeapProfiler.collectGarbage');
    heapUsedBytes += (await client.send('Runtime.getHeapUsage')).usedSize;
  }
  await sleep(250);
  const memory = pageRendererMemory(chromeProcesses(browserPid));
  const lazy = variant === 'no-renderer' && kind === 'cross-site'
    ? await measureLazyLoads(frames.filter(frame => frame !== page.mainFrame())) : [];
  return { kind, variant, frames: frames.length, loadMs, cpu, injection, heapUsedBytes, memory, lazy };
}

// One fresh profile and browser per page load, so no earlier tab's processes
// remain in the sums.
async function session(round, kind, variant) {
  const directory = mkdtempSync(resolve(tmpdir(), 'hachidori-injection-'));
  let browser;
  try {
    const extension = prepare(directory, variant);
    browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
      enableExtensions: true, userDataDir: resolve(directory, 'profile'), protocolTimeout: 600000,
      // Network monitoring makes Chrome capture every request's initiator
      // stack, which re-parses a fetching content script for source positions.
      networkEnabled: false, issuesEnabled: false,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-gpu',
        '--disable-dev-shm-usage', '--host-resolver-rules=MAP *.test 127.0.0.1',
        ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
    const workerTarget = await browser.waitForTarget(target => target.type() === 'service_worker'
      && target.url().startsWith('chrome-extension://'));
    const id = new URL(workerTarget.url()).host;
    // First-run setup opens its startup tab; close it so it cannot run alongside.
    const startup = await browser.waitForTarget(target => target.url().startsWith(`chrome-extension://${id}/startup.html`),
      { timeout: 30000 });
    await (await startup.page())?.close();
    const settingsPage = await browser.newPage();
    await settingsPage.goto(`chrome-extension://${id}/settings.html`);
    await settingsPage.waitForFunction(async () => {
      const status = await chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_status' });
      return status.ok && status.ready && !status.loading;
    }, { timeout: 120000 });
    await settingsPage.evaluate(async options => {
      const current = (await chrome.storage.local.get('options')).options;
      const reply = await chrome.runtime.sendMessage({ target: 'hoshidicts-worker', type: 'hd_options_write',
        baseRevision: current.revision, options });
      if (!reply.ok) throw new Error(JSON.stringify(reply));
    }, settings);
    await settingsPage.close();
    if (variant === 'no-renderer') {
      await (await workerTarget.worker()).evaluate(files => {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (message?.target !== 'hachidori-benchmark') return false;
          chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId] }, files,
            injectImmediately: true }).then(() => sendResponse({ ok: true }),
            error => sendResponse({ ok: false, error: String(error?.message ?? error) }));
          return true;
        });
      }, RENDERER);
    }
    await sleep(2000);
    const row = { round, chrome: await browser.version(), host: hostSnapshot(),
      ...(await measurePage(browser, kind, variant)) };
    appendFileSync(resolve(output, 'raw.jsonl'), `${JSON.stringify(row)}\n`);
    console.log(JSON.stringify({ round, variant, kind, loadMs: Math.round(row.loadMs),
      pageMainMs: Math.round(row.cpu.page?.mainMs ?? 0), heapMiB: +(row.heapUsedBytes / 2 ** 20).toFixed(2),
      ussMiB: +(row.memory.ussKiB / 1024).toFixed(1),
      injectionMs: row.injection.map(frame => +frame.totalMs.toFixed(1)).slice(0, 4) }));
  } finally {
    await browser?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}

writeFileSync(resolve(output, 'definition.json'), JSON.stringify({
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  extensionSha256: directoryContentSha256(resolve(root, 'extension')),
  harnessSha256: sha256File(import.meta.filename),
  node: process.version, host: hostSnapshot(), samples, frameCount, settleMs, variants: VARIANTS, pages: PAGES,
  contentScripts: entry.js, options: settings,
  fileSizes: Object.fromEntries(entry.js.map(file => [file, readFileSync(resolve(root, 'extension', file)).length])),
}, null, 2));
try {
  for (let round = 0; round < samples; round++) {
    for (const kind of PAGES) {
      // Rotate the variant order so drift on a shared machine spreads evenly.
      for (let index = 0; index < VARIANTS.length; index++) {
        await session(round, kind, VARIANTS[(index + round) % VARIANTS.length]);
      }
    }
  }
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
}

// Distributions across rounds. A per-frame delta pairs a page with the same
// round's page under another variant and divides by the page's frame count.
const rows = readFileSync(resolve(output, 'raw.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const find = (variant, kind, round) => rows.find(row => row.variant === variant && row.kind === kind && row.round === round);
const metrics = {
  pageMainCpuMs: row => row.cpu.page?.mainMs ?? 0,
  chromeCpuMs: row => Object.values(row.cpu).reduce((sum, value) => sum + value.allMs, 0),
  heapKiB: row => row.heapUsedBytes / 1024,
  ussKiB: row => row.memory.ussKiB,
  pssKiB: row => row.memory.pssKiB,
  loadMs: row => row.loadMs,
};
const rounds = [...new Set(rows.map(row => row.round))];
// With `less`, the per-frame delta beyond that page's delta (same-site frames
// after the first, measured against the plain page's single frame).
function delta(kind, variant, base, divisor, less = null) {
  const pair = (page, round, read) => read(find(variant, page, round)) - read(find(base, page, round));
  return Object.fromEntries(Object.entries(metrics).map(([name, read]) => [name, summarize(rounds.map(round =>
    (pair(kind, round, read) - (less ? pair(less, round, read) : 0)) / divisor))]));
}
const renderer = entry.js.map(file => RENDERER.includes(file));
const rendererMs = frame => frame.fileMs.reduce((sum, ms, index) => sum + (renderer[index] ? ms : 0), 0);
const summary = { pages: {}, lazy: {} };
for (const kind of PAGES) {
  const frames = kind === 'plain' ? 1 : frameCount + 1;
  const result = summary.pages[kind] = { frames, absolute: {}, injection: {} };
  for (const variant of VARIANTS) {
    const list = rows.filter(row => row.variant === variant && row.kind === kind);
    result.absolute[variant] = Object.fromEntries(Object.entries(metrics).map(([name, read]) =>
      [name, summarize(list.map(read))]));
    if (variant === 'none') continue;
    // A cross-site frame has its own process; same-site frames after the first
    // reuse the first one's compiled scripts.
    const injected = list.flatMap(row => [...row.injection].sort((a, b) => a.start - b.start)
      .map((frame, index) => ({ ...frame, cold: kind !== 'same-site' || index === 0 })));
    const stats = (cold, value) => summarize(injected.filter(frame => frame.cold === cold).map(value));
    result.injection[variant] = { cold: stats(true, frame => frame.totalMs), warm: stats(false, frame => frame.totalMs) };
    if (variant === 'production') {
      Object.assign(result.injection[variant], { coldRenderer: stats(true, rendererMs), warmRenderer: stats(false, rendererMs),
        coldFileMedianMs: Object.fromEntries(entry.js.map((file, index) => [file,
          stats(true, frame => frame.fileMs[index])?.median ?? null])) });
    }
  }
  result.perFrame = { contentScripts: delta(kind, 'production', 'none', frames),
    renderer: delta(kind, 'production', 'no-renderer', frames) };
  if (kind === 'same-site') {
    result.perAdditionalFrame = { contentScripts: delta(kind, 'production', 'none', frameCount, 'plain'),
      renderer: delta(kind, 'production', 'no-renderer', frameCount, 'plain') };
  }
}
const lazy = rows.flatMap(row => row.lazy);
for (const [name, list] of Object.entries({
  scriptingCold: lazy.filter(row => row.mode === 'scripting' && !row.warm),
  scriptingWarm: lazy.filter(row => row.mode === 'scripting' && row.warm),
  importCold: lazy.filter(row => row.mode === 'import'),
})) {
  summary.lazy[name] = summarize(list.map(row => row.ms));
}
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
