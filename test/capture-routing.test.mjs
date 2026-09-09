// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import '../extension/reader-options.js';
import { createCaptureSession } from '../extension/capture-session.js';

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const capture = readFileSync(new URL('../extension/capture-host.js', import.meta.url), 'utf8');
const host = { id: 'extension', url: 'chrome-extension://extension/offscreen.html' };
const hostDocumentId = 'capture-document';
const reader = { id: 'extension', url: 'https://reader.example/',
  documentId: 'reader-document', tab: { id: 2 }, frameId: 0 };
const linkedPage = { tabId: 2, documentId: 'reader-document' };

function freshWorker({ readerDocument = reader.documentId, linked = true, statusWait = async () => {},
  hostStatus = {} } = {}) {
  const messages = [];
  const contentMessages = [];
  let readerLinked = linked;
  let optionsListener;
  const context = vm.createContext({
    capturePage: null, captureRecovery: null, captureContentDocument: null, captureLink: null,
    OPTIONS_KEY: 'options', OFFSCREEN_DOCUMENT: 'offscreen.html',
    ensureOffscreen: async () => {}, HDReaderOptions: { normaliseOptions: value => value,
      activeMediaCapture: globalThis.HDReaderOptions.activeMediaCapture,
      projectContentOptions: globalThis.HDReaderOptions.projectContentOptions },
    CAPTURE_DOCUMENT: 'capture.html', CAPTURE_CONTENT_TARGET: 'hachidori-capture-content',
    CAPTURE_PAGE_TARGET: 'hachidori-capture-page',
    Date, Number, URL, Error, TypeError,
    sameJsonValue: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    responseFits: () => true,
    describe: String,
    chrome: {
      runtime: {
        id: 'extension', getURL: path => `chrome-extension://extension/${path}`,
        getContexts: async () => [{ documentId: hostDocumentId }],
        sendMessage: async message => {
          messages.push(message);
          if (message.type === 'hd_capture_status') {
            await statusWait();
            return { ok: true, linkedPage, ...hostStatus };
          }
          return { ok: true, token: 'same-session-pin' };
        },
      },
      storage: { onChanged: { addListener(value) { optionsListener = value; } },
        local: { get: async () => ({ options: { mediaCapture: {} } }) } },
      tabs: { sendMessage: async (tabId, message, options) => {
        contentMessages.push({ tabId, message, options });
        assert.equal(tabId, reader.tab.id);
        if (readerDocument !== options.documentId) throw new Error('Receiving end does not exist');
        if (message.type === 'hd_capture_unlink') readerLinked = false;
        else assert.equal(message.type, 'hd_capture_recover');
        return { linked: readerLinked, documentId: readerDocument };
      } },
    },
  });
  const helpers = background.slice(background.indexOf('function capturePageSender'),
    background.indexOf('async function captureTabs'));
  const handlers = background.slice(background.indexOf('const CAPTURE_CONTROL_TYPES'),
    background.indexOf('function clearNavigatedCaptureDocument'));
  const contentCommands = background.slice(background.indexOf('async function commandCaptureContent'),
    background.indexOf('async function offscreenExists'));
  vm.runInContext(helpers + contentCommands + handlers, context);
  return { context, messages, contentMessages, optionsListener, readerLinked: () => readerLinked };
}

const pin = { type: 'hd_capture_pin', lookup: {
  lookupText: '猫', lookupTimeMs: Date.now(), occurrenceId: '', occurrenceSourceKind: '',
} };

function routedCaptureSession() {
  const at = Date.now();
  let nextId = 0;
  const session = createCaptureSession({ now: () => at, randomId: () => `capture-${++nextId}`,
    encodeAnimation: async () => new Uint8Array([1, 2, 3]) });
  session.configure({ ...structuredClone(globalThis.HDReaderOptions.DEFAULT_MEDIA_CAPTURE),
    enabled: true, timingMode: 'recent', includeCapturedAudio: false, clipSeconds: 5 });
  session.start();
  for (let offset = 0; offset <= 5000; offset += 1000) {
    session.addFrame({ timestampMs: at - 5000 + offset, width: 2, height: 2, data: new Uint8Array([1]) });
  }
  const hostContext = vm.createContext({ session, captureDocumentId: hostDocumentId,
    selectedTabId: null, linkedDocumentId: '', pageStatus: '', pageVideos: [], btoa,
    captureStatus: () => session.status() });
  vm.runInContext(capture.slice(capture.indexOf('function linked(message)'), capture.indexOf('await register();'))
    .replace('export async function', 'async function'), hostContext);
  const f = freshWorker();
  f.context.capturePage = { documentId: hostDocumentId };
  f.context.chrome.runtime.sendMessage = async message => {
    try { return { ok: true, ...await hostContext.handleCaptureMessage(message) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  const link = async page => {
    await f.context.relayCapture({ type: 'hd_capture_linked', page,
      captureSessionId: session.status().captureSessionId });
    f.context.captureContentDocument = page;
  };
  const fromReader = (message, sender = reader) => f.context.handleCaptureContent(message, sender);
  return { ...f, session, link, fromReader, at };
}

test('a replacement that fails before identification clears the retired reader from the live host', async () => {
  const f = routedCaptureSession();
  const unlinked = [];
  try {
    await f.link(linkedPage);
    const captureSessionId = f.session.status().captureSessionId;
    f.context.chrome.tabs.sendMessage = async (tabId, message) => {
      if (message.type === 'hd_capture_unlink') {
        unlinked.push(tabId);
        return { linked: false };
      }
      assert.equal(message.type, 'hd_capture_link');
      assert.equal(tabId, 3);
      throw new Error('Receiving end does not exist');
    };
    await assert.rejects(f.context.linkCapturePage({ tabId: 3 }), /reading page is unavailable/);
    assert.deepEqual(unlinked, [reader.tab.id]);
    assert.equal(f.context.captureContentDocument, null);
    const status = await f.context.relayCapture({ type: 'hd_capture_status' });
    assert.equal(status.state, 'recording');
    assert.equal(status.captureSessionId, captureSessionId);
    assert.equal(status.linkedPage, null);
    await assert.rejects(f.fromReader(pin), /not linked/);
  } finally { f.session.stop(); }
});

test('a failed replacement cannot clear a newer same-page or different-page link in either session', async () => {
  for (const restart of [false, true]) {
    for (const samePage of [false, true]) {
      const f = routedCaptureSession();
      let entered, fail;
      const waiting = new Promise(resolve => { entered = resolve; });
      const failure = new Promise((_resolve, reject) => { fail = reject; });
      try {
        await f.link(linkedPage);
        f.context.chrome.tabs.get = async () => ({ title: 'Reader', url: reader.url });
        f.context.chrome.tabs.sendMessage = async (tabId, message) => {
          if (message.type === 'hd_capture_unlink') return { linked: false };
          assert.equal(message.type, 'hd_capture_link');
          if (tabId === 3) { entered(); return failure; }
          const sender = { ...reader, tab: { id: tabId }, documentId: `document-${tabId}` };
          if (tabId === reader.tab.id) sender.documentId = reader.documentId;
          await f.context.handleCaptureContent({ type: 'hd_capture_content_identify',
            captureSessionId: message.captureSessionId }, sender);
          return { videos: [] };
        };
        const obsolete = f.context.linkCapturePage({ tabId: 3 });
        await waiting;
        if (restart) { f.session.stop(); f.session.start(); }
        const tabId = samePage ? reader.tab.id : 4;
        await f.context.linkCapturePage({ tabId });
        const retained = f.session.status();
        fail(new Error('Receiving end does not exist'));
        await assert.rejects(obsolete, /reading page is unavailable/);
        const status = await f.context.relayCapture({ type: 'hd_capture_status' });
        assert.equal(status.captureSessionId, retained.captureSessionId);
        assert.deepEqual(status.linkedPage, retained.linkedPage);
        assert.equal(status.linkedPage.tabId, tabId);
        assert.equal(f.context.captureContentDocument.documentId, status.linkedPage.documentId);
      } finally { f.session.stop(); }
    }
  }
});

test('host registration restores only the same surviving linked document after worker restart', async () => {
  const { context } = freshWorker();
  await context.handleCaptureControl({ type: 'hd_capture_register', linkedPage }, host);
  assert.equal((await context.handleCaptureContent(pin, reader)).token, 'same-session-pin');
  await assert.rejects(context.handleCaptureContent(pin, { ...reader, documentId: 'other-document' }), /not linked/);
  await assert.rejects(context.handleCaptureControl({ type: 'hd_capture_register', linkedPage }, reader), /Only the offscreen/);
});

test('the first lookup after worker restart recovers routing without waiting for a host heartbeat', async () => {
  const { context, messages } = freshWorker();
  assert.equal((await context.handleCaptureContent(pin, reader)).token, 'same-session-pin');
  assert.equal(messages[0].type, 'hd_capture_status');
});

test('navigation or lost collector state cannot recover an old reader binding', async () => {
  for (const options of [{ readerDocument: 'new-document' }, { linked: false }]) {
    const { context, messages } = freshWorker(options);
    await context.handleCaptureControl({ type: 'hd_capture_register', linkedPage }, host);
    await assert.rejects(context.handleCaptureContent(pin, reader), /not linked/);
    assert.ok(messages.some(message => message.type === 'hd_capture_unlinked'));
  }
});

test('reader requests wait for the binding while a concurrent status request recovers the worker', async () => {
  let releaseStatus, statusEntered;
  const gate = new Promise(resolve => { releaseStatus = resolve; });
  const entered = new Promise(resolve => { statusEntered = resolve; });
  const { context, messages } = freshWorker({ statusWait: () => { statusEntered(); return gate; } });
  const status = context.handleCaptureControl({ type: 'hd_capture_status' },
    { id: 'extension', url: 'chrome-extension://extension/capture.html', tab: { id: 1 } });
  await entered;
  const lookup = context.handleCaptureContent(pin, reader);
  releaseStatus();
  await status;
  assert.equal((await lookup).token, 'same-session-pin');
  assert.equal(messages.filter(message => message.type === 'hd_capture_pin').length, 1);
});

test('settings changes queued during host recovery apply the latest configuration without rollback', async () => {
  let releaseStatus, statusEntered;
  const gate = new Promise(resolve => { releaseStatus = resolve; });
  const entered = new Promise(resolve => { statusEntered = resolve; });
  const { context, messages, optionsListener } = freshWorker({ statusWait: () => { statusEntered(); return gate; } });
  const change = (previous, enabled) => optionsListener({ options: {
    oldValue: { mediaCapture: { enabled: previous } }, newValue: { mediaCapture: { enabled } },
  } }, 'local');
  change(false, true);
  await entered;
  change(true, false);
  releaseStatus();
  await vm.runInContext('captureConfigTail', context);
  assert.deepEqual(messages.filter(message => message.type === 'hd_capture_configure')
    .map(message => message.mediaCapture.enabled), [false]);
});

test('an admitted export remains accessible only to its original document after relinking', async () => {
  for (const finish of ['complete', 'cancel']) {
    const f = routedCaptureSession();
    try {
      await f.link(linkedPage);
      const rootPin = await f.fromReader({ ...pin, lookup: { ...pin.lookup, lookupTimeMs: f.at } });
      const job = await f.fromReader({ type: 'hd_capture_export', token: rootPin.token,
        requirements: { includeAnimation: true, includeAudio: false } });
      await new Promise(resolve => setImmediate(resolve));
      const replacement = { ...reader, tab: { id: 3 }, documentId: 'replacement-document' };
      await f.link({ tabId: replacement.tab.id, documentId: replacement.documentId });
      const status = await f.fromReader({ type: 'hd_capture_job_status', jobId: job.jobId });
      assert.equal(status.state, 'ready');
      for (const stranger of [replacement, { ...reader, documentId: 'navigated-document' }]) {
        for (const type of ['hd_capture_job_status', 'hd_capture_cancel']) {
          await assert.rejects(f.fromReader({ type, jobId: job.jobId,
            tabId: reader.tab.id, documentId: reader.documentId }, stranger), /does not own/);
        }
      }
      await assert.rejects(f.fromReader({ ...pin, lookup: { ...pin.lookup, lookupTimeMs: f.at } }, replacement),
        /still exporting/);
      if (finish === 'complete') {
        // The existing trusted Anki broker fetches and completes the asset after
        // the originating reader finishes polling and submits its prepared note.
        const asset = await f.context.relayCapture({ type: 'hd_capture_asset', jobId: job.jobId, kind: 'animation' });
        assert.equal(asset.filename, rootPin.animationFilename);
        assert.equal((await f.context.relayCapture({ type: 'hd_capture_complete', jobId: job.jobId })).completed, true);
      } else {
        assert.equal((await f.fromReader({ type: 'hd_capture_cancel', jobId: job.jobId })).cancelled, true);
      }
      assert.ok((await f.fromReader({ ...pin, lookup: { ...pin.lookup, lookupTimeMs: f.at } }, replacement)).token);
    } finally { f.session.stop(); }
  }
});

const stoppedHost = { type: 'hd_capture_host_stopped', captureDocumentId: hostDocumentId,
  captureSessionId: 'retired-session', linkedPage };

test('source loss immediately after worker restart unlinks the exact surviving reader without prior recovery', async () => {
  const f = freshWorker({ hostStatus: { state: 'stopped', captureSessionId: '', linkedPage: null } });
  await f.context.handleCaptureControl(stoppedHost, host);
  assert.equal(f.readerLinked(), false);
  assert.deepEqual(f.contentMessages.map(item => [item.message.type, item.options.documentId]),
    [['hd_capture_unlink', reader.documentId]]);
});

test('retired-host cleanup rejects forged identity, navigation and a newer capture session', async () => {
  const forged = freshWorker();
  await forged.context.handleCaptureControl({ ...stoppedHost, captureDocumentId: 'another-host' }, host);
  assert.equal(forged.contentMessages.length, 0);
  await assert.rejects(forged.context.handleCaptureControl(stoppedHost, reader), /Only the offscreen/);

  const navigated = freshWorker({ readerDocument: 'new-document' });
  await navigated.context.handleCaptureControl(stoppedHost, host);
  assert.equal(navigated.readerLinked(), true);
  assert.equal(navigated.contentMessages[0].options.documentId, reader.documentId);

  const restarted = freshWorker({ hostStatus: { state: 'recording', captureSessionId: 'new-session' } });
  await restarted.context.handleCaptureControl(stoppedHost, host);
  assert.equal(restarted.readerLinked(), true);
  assert.equal(restarted.contentMessages.length, 0);

  const unlinkedRestart = freshWorker({ hostStatus: {
    state: 'recording', captureSessionId: 'new-session', linkedPage: null,
  } });
  await unlinkedRestart.context.handleCaptureControl(stoppedHost, host);
  assert.equal(unlinkedRestart.readerLinked(), false);
});

test('captured source resize letterboxes each frame in the original canvas without upscaling', async () => {
  const draws = [], fills = [], canvases = [], closed = [];
  const worker = readFileSync(new URL('../extension/capture-frame-worker.js', import.meta.url), 'utf8');
  const drawing = { fillRect: (...args) => fills.push(args), drawImage: (...args) => draws.push(args.slice(1)) };
  const context = vm.createContext({
    MAX_FRAME_BYTES: 262144,
    OffscreenCanvas: class {
      constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
      getContext() { return drawing; }
      async convertToBlob() { return { size: 1, arrayBuffer: async () => new ArrayBuffer(1) }; }
    },
  });
  vm.runInContext(worker.slice(worker.indexOf('let canvas ='), worker.indexOf('self.addEventListener(')), context);
  await context.encodeFrame({ frame: { displayWidth: 800, displayHeight: 800,
    close: () => closed.push(1) }, width: 640, height: 360 });
  await context.encodeFrame({ frame: { width: 200, height: 100,
    close: () => closed.push(2) }, width: 640, height: 360 });
  assert.deepEqual(draws, [[140, 0, 360, 360], [220, 130, 200, 100]]);
  assert.deepEqual(fills, [[0, 0, 640, 360], [0, 0, 640, 360]]);
  assert.deepEqual(canvases.map(canvas => [canvas.width, canvas.height]), [[640, 360]]);
  assert.deepEqual(closed, [1, 2]);
});
