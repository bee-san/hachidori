import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nestedLinksFixture } from "./make-fixture.mjs";

export async function checkPopupResize(settings, tab) {
  const selector = 'hachidori-host';
  const read = () => tab.evaluate(selector => {
    const popup = document.querySelector(selector)?.shadowRoot?.querySelector('.gsm-hoshidicts-popup');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const handle = popup.querySelector('.gsm-hoshidicts-resize-handle');
    return { width: rect.width, height: rect.height, left: rect.left, top: rect.top,
      right: rect.right, bottom: rect.bottom, handle: Boolean(handle), text: popup.textContent };
  }, selector);
  const open = async () => {
    await tab.evaluate(() => getSelection().selectAllChildren(document.getElementById('verb')));
    await tab.waitForFunction(selector => {
      const popup = document.querySelector(selector)?.shadowRoot?.querySelector('.gsm-hoshidicts-popup');
      return popup && !popup.hidden && popup.textContent.includes('食');
    }, {}, selector);
    await new Promise(done => setTimeout(done, 200));
  };
  const drag = async (dx, dy) => {
    const before = await read();
    const scale = await tab.evaluate(() => devicePixelRatio);
    await tab.mouse.move(before.right - 6 / scale, before.bottom - 6 / scale);
    await tab.mouse.down();
    await tab.mouse.move(before.right - 6 / scale + dx, before.bottom - 6 / scale + dy, { steps: 12 });
    await tab.mouse.up();
    await new Promise(done => setTimeout(done, 200));
    return read();
  };
  const stored = await settings.evaluate(() => chrome.storage.local.get('options'));
  await tab.bringToFront();
  await open();
  const before = await read();
  if (process.env.HACHIDORI_RESIZE_SCREENSHOTS) {
    mkdirSync(process.env.HACHIDORI_RESIZE_SCREENSHOTS, { recursive: true });
    await tab.screenshot({ path: resolve(process.env.HACHIDORI_RESIZE_SCREENSHOTS, 'before.png') });
  }
  assert.ok(before.handle, 'lookup popup exposes a mouse resize handle');
  const after = await drag(-90, -65);
  assert.ok(after && Math.abs(after.width - before.width + 90) < 3
    && Math.abs(after.height - before.height + 65) < 3, JSON.stringify({ before, after }));
  assert.equal(after.text, before.text, 'drag does not scan or change the lookup');
  assert.equal(await tab.evaluate(() => getSelection().toString()), '食べたかった');
  if (process.env.HACHIDORI_RESIZE_SCREENSHOTS) {
    await tab.screenshot({ path: resolve(process.env.HACHIDORI_RESIZE_SCREENSHOTS, 'after.png') });
  }
  await tab.keyboard.press('Escape');
  await tab.evaluate(() => getSelection().removeAllRanges());
  await open();
  const reopened = await read();
  assert.ok(Math.abs(reopened.width - after.width) < 3 && Math.abs(reopened.height - after.height) < 3,
    'close/reopen retains session size');
  await settings.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.tabs.setZoom(tab.id, 2);
  }, tab.url());
  await tab.waitForFunction(() => devicePixelRatio === 2);
  await new Promise(done => setTimeout(done, 300));
  const zoomed = await read();
  const zoomDrag = await drag(-25, -20);
  assert.ok(Math.abs(zoomDrag.width - zoomed.width + 25) < 3
    && Math.abs(zoomDrag.height - zoomed.height + 20) < 3,
  JSON.stringify({ zoomed, zoomDrag }));
  await settings.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.tabs.setZoom(tab.id, 1);
  }, tab.url());
  await tab.waitForFunction(() => devicePixelRatio === 1);
  await new Promise(done => setTimeout(done, 300));
  const expanded = await drag(2000, 2000);
  const viewport = await tab.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(expanded.right <= viewport.width && expanded.bottom <= viewport.height
    && expanded.left >= 0 && expanded.top >= 0, JSON.stringify({ expanded, viewport }));
  assert.deepEqual(await settings.evaluate(() => chrome.storage.local.get('options')), stored,
    'resizing never writes persistent design options');
  await tab.reload({ waitUntil: 'load' });
  await open();
  const reset = await read();
  assert.ok(Math.abs(reset.width - before.width) < 3 && Math.abs(reset.height - before.height) < 3,
    'page reload starts a fresh reading session');
  const fixture = nestedLinksFixture();
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    try {
      const reply = await chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_import',
        requestId: 'resize-nested-fixture', blobUrl, fileName: 'nested.zip' });
      if (!reply.ok) throw new Error(reply.error);
    } finally { URL.revokeObjectURL(blobUrl); }
  }, fixture.archive.toString('base64'));
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get('options');
    const reply = await chrome.runtime.sendMessage({ target: 'hoshidicts-worker', type: 'hd_options_write',
      baseRevision: options.revision, options: { popupNestingMaxDepth: 2 } });
    if (!reply.ok) throw new Error(reply.error);
  });
  await tab.keyboard.press('Escape');
  await tab.evaluate(query => {
    getSelection().removeAllRanges();
    const word = document.getElementById('verb');
    word.textContent = query;
    getSelection().selectAllChildren(word);
  }, fixture.query);
  await tab.waitForFunction(() => document.querySelector('hachidori-host').shadowRoot
    .querySelector('a[data-hoshidicts-query]'));
  await drag(-90, -65);
  const link = await tab.evaluate(() => {
    const rect = document.querySelector('hachidori-host').shadowRoot
      .querySelector('a[data-hoshidicts-query]').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await tab.mouse.click(link.x, link.y);
  await tab.waitForFunction(() => document.querySelector('hachidori-host').shadowRoot
    .querySelector('[data-hoshidicts-depth="1"]:not([hidden])'));
  const childRect = () => tab.evaluate(() => document.querySelector('hachidori-host').shadowRoot
    .querySelector('[data-hoshidicts-depth="1"]').getBoundingClientRect().toJSON());
  const child = await childRect();
  assert.ok(Math.abs(child.width - after.width) < 3 && Math.abs(child.height - after.height) < 3,
    'nested lookup inherits session size');
  await tab.mouse.move(child.right - 6, child.bottom - 6);
  await tab.mouse.down();
  await tab.mouse.move(child.right - 46, child.bottom - 36, { steps: 8 });
  await tab.mouse.up();
  const resizedChild = await childRect();
  assert.ok(Math.abs(resizedChild.width - child.width + 40) < 3
    && Math.abs(resizedChild.height - child.height + 30) < 3, 'nested popup resizes with physical input');
  await settings.evaluate(async value => {
    const { options } = await chrome.storage.local.get('options');
    await chrome.runtime.sendMessage({ target: 'hoshidicts-worker', type: 'hd_options_write',
      baseRevision: options.revision, options: { popupNestingMaxDepth: value ?? 3 } });
  }, stored.options?.popupNestingMaxDepth);
  await settings.evaluate(title => chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_remove', title }), fixture.title);
  await tab.reload({ waitUntil: 'load' });
  await tab.keyboard.press('Escape');
  await tab.evaluate(() => getSelection().removeAllRanges());
  console.log('popup resize: physical drag, selection isolation, containment, reopen, storage, reload passed');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(import.meta.dirname, '..');
  const require = createRequire(resolve(root, 'test/tooling/package.json'));
  const puppeteer = await import(pathToFileURL(require.resolve('puppeteer-core')));
  const { computeExecutablePath, Browser } = await import(pathToFileURL(require.resolve('@puppeteer/browsers')));
  const { config } = JSON.parse(readFileSync(resolve(root, 'test/tooling/package.json')));
  const executablePath = process.env.HACHIDORI_CHROME || computeExecutablePath({
    cacheDir: resolve(root, 'test/tmp/browsers'), browser: Browser.CHROME, buildId: config.chrome,
  });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><meta charset="utf-8"><body style="margin:30px;font-size:28px"><span id="verb">食べたかった</span></body>');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const extension = resolve(root, 'extension');
  const browser = await puppeteer.launch({ executablePath, headless: true, enableExtensions: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-dev-shm-usage',
      ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
  try {
    console.log(await browser.version());
    const worker = await browser.waitForTarget(target => target.type() === 'service_worker');
    const settings = await browser.newPage();
    await settings.goto(`chrome-extension://${new URL(worker.url()).host}/settings.html`);
    for (let attempt = 0; ; attempt += 1) {
      const status = await settings.evaluate(() => chrome.runtime.sendMessage({
        target: 'hoshidicts-offscreen', type: 'hd_status' }));
      if (status.ok && status.ready && !status.loading) break;
      assert.ok(attempt < 60, JSON.stringify(status));
      await new Promise(done => setTimeout(done, 500));
    }
    const reply = await settings.evaluate(async base64 => {
      const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
      try {
        return await chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_import',
          requestId: 'resize-fixture', blobUrl, fileName: 'fixture.zip' });
      } finally { URL.revokeObjectURL(blobUrl); }
    }, readFileSync(resolve(root, 'test/fixtures/hachidori-fixture.zip')).toString('base64'));
    assert.ok(reply.ok, JSON.stringify(reply));
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1280, height: 900 });
    await tab.goto(`http://127.0.0.1:${server.address().port}`);
    await checkPopupResize(settings, tab);
  } finally {
    await browser.close();
    await new Promise(done => server.close(done));
  }
}
