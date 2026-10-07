// SPDX-License-Identifier: GPL-3.0-or-later
// CPU and memory of Netflix mining's line audio (#542): what keeping the last
// 30 seconds of a watch page's 1x sound costs while a video plays. A fixture
// watch page, served at https://www.netflix.com/watch/81000001 by request
// interception, plays a stereo 48 kHz track with Netflix mining on, in the
// extension at a base revision (`before`, without the line audio) and in this
// checkout (`after`). No request leaves the machine: every host resolves to
// nothing, so the fixture is all there is.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeValues } from './lib.mjs';
import { chromeProcesses, cpuDelta, directoryContentSha256, hostSnapshot, pageRendererMemory,
  sha256File } from './system.mjs';

const root = resolve(import.meta.dirname, '..');
const output = process.argv[2] && resolve(process.argv[2]);
const beforeRef = process.argv[3];
assert.ok(output && beforeRef, 'usage: node benchmark/netflix-line-audio.mjs <fresh-output-directory> <before-ref>');
assert.ok(!existsSync(output) || readdirSync(output).length === 0, 'the output directory must be fresh');
mkdirSync(output, { recursive: true });
const samples = Number(process.env.HACHIDORI_LINE_AUDIO_SAMPLES ?? 3);
const warmupMs = Number(process.env.HACHIDORI_LINE_AUDIO_WARMUP_MS ?? 10_000);
const measureMs = Number(process.env.HACHIDORI_LINE_AUDIO_MEASURE_MS ?? 60_000);
for (const value of [samples, warmupMs, measureMs]) assert.ok(Number.isSafeInteger(value) && value > 0);
const puppeteer = await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href);
const beforeRevision = execFileSync('git', ['rev-parse', '--verify', `${beforeRef}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const WATCH = 'https://www.netflix.com/watch/81000001';
const TRACK = 'https://www.netflix.com/fixture/track.wav';
const RATE = 48_000;
const TRACK_SECONDS = Math.ceil((warmupMs + measureMs) / 1000) + 15;
// A 4.5 s line, as cut and encoded for a note.
const LINE_SECONDS = 4.5;
const sleep = ms => new Promise(done => { setTimeout(done, ms); });
const summarize = values => {
  if (!values.length) return null;
  const { samples: _, ...distribution } = summarizeValues(values);
  return distribution;
};

// Two tones and a little noise, a different mix on each channel, so decoding,
// down-mixing and copying all have real samples to work on.
function stereoTrack() {
  const frames = TRACK_SECONDS * RATE;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(frames * 4, 40);
  let seed = 1;
  const noise = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 30 - 1; };
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / RATE;
    const left = 0.2 * Math.sin(2 * Math.PI * 440 * t) + 0.02 * noise();
    const right = 0.2 * Math.sin(2 * Math.PI * 660 * t) + 0.02 * noise();
    wav.writeInt16LE(Math.round(left * 0x7fff), 44 + frame * 4);
    wav.writeInt16LE(Math.round(right * 0x7fff), 46 + frame * 4);
  }
  return wav;
}
const track = stereoTrack();
const page = `<!doctype html><meta charset="utf-8"><title>Netflix fixture</title>
<div class="watch-video"><video preload="auto" loop></video><div class="player-timedtext"></div></div>
<script>
const video = document.querySelector("video");
// A blob is seekable; an intercepted response without range support is not.
fetch(${JSON.stringify(TRACK)}).then(response => response.blob()).then(blob => {
  video.src = URL.createObjectURL(blob);
  return video.play();
}).then(() => { window.__playing = true; }, error => { window.__error = String(error); });
</script>`;

function prepare(directory, variant) {
  const extension = resolve(directory, 'extension');
  mkdirSync(extension);
  // `before` is the base revision's tree; `after` this checkout's.
  const ref = variant === 'before' ? beforeRevision : null;
  if (ref) execFileSync('sh', ['-c', 'git archive "$1" extension | tar -x -C "$2" --strip-components=1', 'sh', ref, extension], { cwd: root });
  else execFileSync('cp', ['-R', `${resolve(root, 'extension')}/.`, extension]);
  return extension;
}

// In `after`, the content script's world times cutting a line from a ring the
// size of the line audio's and encoding it as the base64 WAV the worker gets.
const ENCODE = `(() => {
  const rate = 44_100, frames = Math.round(${LINE_SECONDS} * rate);
  const ring = new Float32Array(30 * rate).map((_, index) => Math.sin(index / 9) * 0.2);
  const times = [];
  let bytes = 0;
  for (let round = 0; round < 20; round++) {
    const started = performance.now();
    const samples = new Float32Array(frames);
    const from = (round * 7919) % (ring.length - frames);
    samples.set(ring.subarray(from, from + frames));
    bytes = HDNetflixAudio.wavBase64({ samples, sampleRate: rate }).length;
    times.push(performance.now() - started);
  }
  return JSON.stringify({ times, bytes });
})()`;

async function session(round, variant) {
  const directory = mkdtempSync(resolve(tmpdir(), 'hachidori-line-audio-'));
  let browser;
  try {
    const extension = prepare(directory, variant);
    browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
      enableExtensions: true, userDataDir: resolve(directory, 'profile'), protocolTimeout: 600_000,
      issuesEnabled: false,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-gpu',
        '--disable-dev-shm-usage', '--disable-audio-output', '--autoplay-policy=no-user-gesture-required',
        // Nothing resolves: the first-run dictionary downloads fail at once, and
        // the intercepted fixture is the only Netflix there is.
        '--host-resolver-rules=MAP * ~NOTFOUND',
        ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
    const workerTarget = await browser.waitForTarget(target => target.type() === 'service_worker'
      && target.url().startsWith('chrome-extension://'));
    const id = new URL(workerTarget.url()).host;
    const startup = await browser.waitForTarget(target => target.url().startsWith(`chrome-extension://${id}/startup.html`),
      { timeout: 30_000 });
    await (await startup.page())?.close();
    const settingsPage = await browser.newPage();
    await settingsPage.goto(`chrome-extension://${id}/settings.html`);
    await settingsPage.evaluate(async () => {
      const { options } = await chrome.storage.local.get('options');
      // A patch carries the complete record of experimental switches.
      const experimental = { ...HDReaderOptions.normaliseOptions(options).experimental, netflixMining: true };
      const reply = await chrome.runtime.sendMessage({ target: 'hoshidicts-worker', type: 'hd_options_write',
        baseRevision: options?.revision ?? 0, options: { experimental } });
      if (!reply.ok) throw new Error(JSON.stringify(reply));
    });
    await settingsPage.waitForFunction(async () => (await chrome.scripting.getRegisteredContentScripts()).length === 2,
      { timeout: 30_000 });
    await settingsPage.close();

    const tab = await browser.newPage();
    for (const other of await browser.pages()) if (other !== tab) await other.close();
    const client = await tab.createCDPSession();
    const contexts = new Map();
    const nodes = [];
    const worlds = [];
    client.on('WebAudio.contextCreated', ({ context }) => contexts.set(context.contextId, context));
    client.on('WebAudio.contextChanged', ({ context }) => contexts.set(context.contextId, context));
    client.on('WebAudio.audioNodeCreated', ({ node }) => nodes.push(node.nodeType));
    client.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
    await client.send('WebAudio.enable');
    await client.send('Runtime.enable');
    await tab.setRequestInterception(true);
    tab.on('request', request => {
      if (request.url() === WATCH) return request.respond({ contentType: 'text/html; charset=utf-8', body: page });
      if (request.url() === TRACK) return request.respond({ contentType: 'audio/wav', body: track });
      return request.respond({ status: 404, body: '' });
    });
    await tab.goto(WATCH);
    await tab.waitForFunction(() => window.__playing === true || window.__error, { timeout: 60_000 });
    assert.equal(await tab.evaluate(() => window.__error ?? null), null);
    // Interception stays on: the track plays from a blob, so the measured
    // interval makes no request, and a late one is still answered.
    await sleep(warmupMs);

    const browserPid = browser.process().pid;
    const before = chromeProcesses(browserPid);
    const mediaStart = await tab.evaluate(() => document.querySelector('video').currentTime);
    const started = performance.now();
    await sleep(measureMs);
    const elapsedMs = performance.now() - started;
    const processes = chromeProcesses(browserPid);
    const cpu = cpuDelta(before, processes);
    const mediaEnd = await tab.evaluate(() => document.querySelector('video').currentTime);
    const realtime = [];
    for (const contextId of contexts.keys()) {
      realtime.push((await client.send('WebAudio.getRealtimeData', { contextId })).realtimeData);
    }
    await client.send('HeapProfiler.collectGarbage');
    await client.send('HeapProfiler.collectGarbage');
    const heap = await client.send('Runtime.getHeapUsage');
    await sleep(250);
    const memory = pageRendererMemory(chromeProcesses(browserPid));
    const reader = worlds.find(world => world.origin === `chrome-extension://${id}` && world.auxData?.type === 'isolated');
    let encode = null;
    if (variant === 'after') {
      assert.ok(reader, 'the content scripts run on the watch page');
      const reply = await client.send('Runtime.evaluate', { expression: ENCODE, contextId: reader.id, returnByValue: true });
      encode = JSON.parse(reply.result.value);
    }
    // The line audio runs in `after` only: a running context with the video's
    // source and its copy, and none at all in `before`.
    const states = [...contexts.values()].map(context => context.contextState);
    if (variant === 'after') {
      assert.deepEqual(states, ['running'], `one running AudioContext: ${JSON.stringify(states)}`);
      assert.ok(nodes.includes('MediaElementAudioSource') && nodes.includes('MediaStreamAudioDestination'),
        `the video's source and its copy: ${JSON.stringify(nodes)}`);
    } else {
      assert.deepEqual(states, [], 'no AudioContext without the line audio');
    }
    const row = { round, variant, chrome: await browser.version(), host: hostSnapshot(), elapsedMs,
      mediaMs: (mediaEnd - mediaStart) * 1000, cpu, memory, nodes,
      heap: { usedBytes: heap.usedSize, totalBytes: heap.totalSize, backingStorageBytes: heap.backingStorageSize },
      realtime, encode };
    appendFileSync(resolve(output, 'raw.jsonl'), `${JSON.stringify(row)}\n`);
    console.log(JSON.stringify({ round, variant, pageMainMs: Math.round(cpu.page?.mainMs ?? 0),
      pageAllMs: Math.round(cpu.page?.allMs ?? 0), heapMiB: +(heap.usedSize / 2 ** 20).toFixed(2),
      backingMiB: +(heap.backingStorageSize / 2 ** 20).toFixed(2), ussMiB: +(memory.ussKiB / 1024).toFixed(1),
      renderCapacity: realtime.map(data => +data.renderCapacity.toFixed(4)) }));
  } finally {
    await browser?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}

const VARIANTS = ['before', 'after'];
writeFileSync(resolve(output, 'definition.json'), JSON.stringify({
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  beforeRevision, extensionSha256: directoryContentSha256(resolve(root, 'extension')),
  harnessSha256: sha256File(import.meta.filename), node: process.version, host: hostSnapshot(),
  samples, warmupMs, measureMs, track: { seconds: TRACK_SECONDS, sampleRate: RATE, channels: 2, bytes: track.length },
  lineSeconds: LINE_SECONDS, variants: VARIANTS,
}, null, 2));
for (let round = 0; round < samples; round++) {
  // Alternate the order so drift on a shared machine spreads evenly.
  for (let index = 0; index < VARIANTS.length; index++) await session(round, VARIANTS[(index + round) % VARIANTS.length]);
}

// Per second of playback, and `after` less the same round's `before`.
const rows = readFileSync(resolve(output, 'raw.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const perSecond = (row, ms) => ms * 1000 / row.elapsedMs;
const metrics = {
  pageMainCpuMsPerS: row => perSecond(row, row.cpu.page?.mainMs ?? 0),
  pageAllCpuMsPerS: row => perSecond(row, row.cpu.page?.allMs ?? 0),
  audioServiceCpuMsPerS: row => perSecond(row, row.cpu['utility:audio.mojom.AudioService']?.allMs ?? 0),
  chromeCpuMsPerS: row => perSecond(row, Object.values(row.cpu).reduce((sum, value) => sum + value.allMs, 0)),
  heapUsedKiB: row => row.heap.usedBytes / 1024,
  backingStorageKiB: row => row.heap.backingStorageBytes / 1024,
  pageUssKiB: row => row.memory.ussKiB,
  pagePssKiB: row => row.memory.pssKiB,
};
const rounds = [...new Set(rows.map(row => row.round))];
const find = (variant, round) => rows.find(row => row.variant === variant && row.round === round);
const summary = { absolute: {}, delta: {}, after: {} };
for (const variant of VARIANTS) {
  summary.absolute[variant] = Object.fromEntries(Object.entries(metrics).map(([name, read]) =>
    [name, summarize(rows.filter(row => row.variant === variant).map(read))]));
}
summary.delta = Object.fromEntries(Object.entries(metrics).map(([name, read]) =>
  [name, summarize(rounds.map(round => read(find('after', round)) - read(find('before', round))))]));
const after = rows.filter(row => row.variant === 'after');
summary.after.renderCapacity = summarize(after.flatMap(row => row.realtime.map(data => data.renderCapacity)));
summary.after.encodeLineMs = summarize(after.flatMap(row => row.encode.times));
summary.after.encodedLineBytes = after[0]?.encode.bytes ?? null;
summary.after.mediaPerWallSecond = summarize(after.map(row => row.mediaMs / row.elapsedMs));
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
