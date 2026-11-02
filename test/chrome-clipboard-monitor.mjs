/*
 * The search page's clipboard monitor (#639) in a real Chrome: text copied in
 * another tab is read through the worker and the offscreen document while the
 * search page has no focus, and searched there with a real dictionary result.
 * What was on the clipboard before, text without Japanese, text copied on the
 * search page itself and a copy made while a Note is being written are not
 * searched, and no other extension page can read the clipboard.
 *
 * Chrome shows its permission prompt in a window, which headless Chrome cannot
 * answer, so this copy of the extension holds clipboardRead from the start, as
 * turning the switch on and accepting the prompt leaves it. The switch itself,
 * its prompt and turning it off run in the Firefox suite, whose optional
 * permissions are granted without a prompt.
 *
 * test/run.mjs chrome-e2e runs it after the main scenario; on its own:
 *   node test/chrome-clipboard-monitor.mjs
 * HACHIDORI_SEARCH_SCREENSHOTS=DIR also saves the search page in the default,
 * a light, the high-contrast and Windows' forced colours.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { popupRoot } from "./chrome-popup-root.mjs";
import { popupReader } from "./chrome-e2e/popup-reader.mjs";
import { buildFixtureZip } from "./make-fixture.mjs";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const { config } = require("./package.json");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_EXTENSION = resolve(ROOT, "extension");
const EXTENSION = resolve(ROOT, "test/tmp/clipboard-extension");
// Named like chrome-e2e's own profile, so CI's failure upload collects it.
const PROFILE = resolve(tmpdir(), `hachidori-e2e-profile-clipboard-${process.pid}`);
const SCREENSHOTS = process.env.HACHIDORI_SEARCH_SCREENSHOTS;

rmSync(EXTENSION, { recursive: true, force: true });
cpSync(SOURCE_EXTENSION, EXTENSION, { recursive: true });
const manifestPath = resolve(EXTENSION, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.deepEqual(manifest.optional_permissions, ["clipboardRead"], "the extension asks for clipboardRead when it is needed");
delete manifest.optional_permissions;
manifest.permissions.push("clipboardRead");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// A page in another tab whose button copies its text, as a user would.
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><body>
    <p id="text"></p><button id="copy">Copy</button>
    <script>
      document.getElementById("copy").addEventListener("click", () => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById("text"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        window.copied = document.execCommand("copy");
      });
    </script>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));

const diagnostics = [];
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME || computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"),
    browser: Browser.CHROME, buildId: config.chrome }),
  enableExtensions: true,
  headless: true,
  userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
let passed = false;
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  (await worker.worker())?.on("console", message => diagnostics.push(`[sw] ${message.text()}`));
  const watch = (page, name) => {
    page.on("console", message => diagnostics.push(`[${name}] ${message.type()}: ${message.text()}`));
    page.on("pageerror", error => diagnostics.push(`[${name}] pageerror: ${error.message}`));
    return page;
  };

  // The fixture dictionary, imported from Settings as the bulk-import suite does.
  const settings = watch(await browser.newPage(), "settings");
  await settings.goto(`chrome-extension://${extensionId}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const imported = await settings.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try {
      return await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: "clipboard-fixture", blobUrl, fileName: "hachidori-fixture.zip" });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, buildFixtureZip().toString("base64"));
  assert.equal(imported?.ok === true && imported.report?.success === true, true, JSON.stringify(imported));

  const web = watch(await browser.newPage(), "web");
  await web.goto(`http://127.0.0.1:${server.address().port}/`);
  async function copyInWeb(text) {
    await web.bringToFront();
    await web.$eval("#text", (element, value) => { element.textContent = value; }, text);
    await web.click("#copy");
    assert.equal(await web.evaluate(() => window.copied), true, `the web page copied ${text}`);
  }
  // On the clipboard before the search page opens.
  await copyInWeb("食べたかった");

  const search = watch(await browser.newPage(), "search");
  await search.setViewport({ width: 960, height: 760 });
  await search.goto(`chrome-extension://${extensionId}/search.html`, { waitUntil: "domcontentloaded" });
  await search.waitForFunction(() => !document.getElementById("search-submit").disabled
    && !document.getElementById("search-clipboard").disabled, { polling: 100, timeout: 30_000 });
  const popup = await popupReader(search);
  const page = () => search.evaluate(() => ({
    switchOn: document.getElementById("search-clipboard").checked,
    value: document.getElementById("search-input").value,
    query: document.getElementById("search-query").hidden ? null : document.getElementById("search-query").textContent,
    focused: document.hasFocus(),
  }));
  // The texts the page's monitor reads, as its own requests return them.
  await search.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    globalThis.clipboardReads = [];
    chrome.runtime.sendMessage = function (message, ...rest) {
      const reply = send.call(this, message, ...rest);
      if (message?.type === "hd_clipboard_read") {
        reply.then(answer => globalThis.clipboardReads.push(answer?.text ?? null), () => {});
      }
      return reply;
    };
  });
  const forget = () => search.evaluate(() => { globalThis.clipboardReads.length = 0; });
  // Once the monitor has read `text` twice, it has acted on the first read.
  const readTwice = text => search.waitForFunction(value => globalThis.clipboardReads
    .filter(read => read === value).length >= 2, { polling: 50, timeout: 15_000 }, text);

  await web.bringToFront();
  await readTwice("食べたかった");
  const opened = await page();
  assert.equal(opened.switchOn, true, "the switch shows the clipboardRead permission Hachidori holds");
  assert.equal(opened.query, null, "text on the clipboard before the page opened is not searched");
  assert.equal(opened.value, "", JSON.stringify(opened));

  await copyInWeb("読む");
  const read = await popup.waitForVisible(15_000, state => state.plain.includes("読む") && state.text.includes("to read"));
  const searched = await page();
  assert.ok(read, "a copy in another tab is searched with its dictionary result");
  assert.equal(searched.query, "読む", JSON.stringify(searched));
  assert.equal(searched.value, "読む");
  assert.equal(searched.focused, false, "the search page read the clipboard without focus");
  if (SCREENSHOTS) {
    mkdirSync(SCREENSHOTS, { recursive: true });
    await search.bringToFront();
    await search.screenshot({ path: resolve(SCREENSHOTS, "search-clipboard-monitor.png") });
    await web.bringToFront();
  }

  await forget();
  await copyInWeb("hello world");
  await readTwice("hello world");
  assert.equal((await page()).query, "読む", "text without Japanese is not searched");

  // Text copied on the search page itself.
  await search.bringToFront();
  await search.focus("#search-input");
  await search.$eval("#search-input", box => { box.value = "漢字"; box.select(); });
  await forget();
  await search.keyboard.down("Control");
  await search.keyboard.press("KeyC", { commands: ["Copy"] });
  await search.keyboard.up("Control");
  await web.bringToFront();
  await readTwice("漢字");
  const ownCopy = await page();
  assert.equal(ownCopy.query, "読む", `text copied on the search page is not searched: ${JSON.stringify(ownCopy)}`);
  assert.equal(ownCopy.value, "漢字");
  assert.ok((await popup.state()).plain.includes("読む"));

  // A Note being written holds the monitor off, and it searches again once the Note is closed.
  await search.bringToFront();
  assert.equal(await popup.click(".gsm-hoshidicts-note-button"), true, "the Note button opens the form");
  const noteFocused = await popupRoot(search).waitFor(shadow => {
    const field = shadow.querySelector('.gsm-hoshidicts-note-form:not([hidden]) [name="definition"]');
    field?.focus();
    return Boolean(field) && shadow.activeElement === field;
  }, { timeout: 10_000 });
  assert.equal(noteFocused, true);
  await search.keyboard.type("ab");
  await forget();
  await copyInWeb("食べる");
  await readTwice("食べる");
  const drafting = await popup.state();
  assert.equal(drafting.noteOpen && drafting.noteDefinition === "ab", true, "the Note draft is kept");
  assert.equal((await page()).query, "読む", "a copy made while a Note is written is not searched");
  await search.bringToFront();
  await search.keyboard.press("Escape");
  assert.equal((await popup.state()).noteOpen, false);
  await copyInWeb("漢字");
  const kanji = await popup.waitForVisible(15_000, state => state.plain.includes("漢字")
    && state.text.includes("Chinese character"));
  assert.ok(kanji, "the monitor searches again once the Note is closed");
  assert.equal((await page()).query, "漢字");

  // Only the search page reads the clipboard: the worker refuses another page,
  // and the offscreen document answers only the worker.
  const others = await settings.evaluate(async () => ({
    worker: await chrome.runtime.sendMessage({ target: "hachidori-clipboard", type: "hd_clipboard_read" }),
    offscreen: await chrome.runtime.sendMessage({ target: "hachidori-clipboard", type: "hd_clipboard_read", relayed: true })
      .then(reply => reply ?? null, error => String(error)),
  }));
  assert.equal(others.worker?.ok, false, JSON.stringify(others));
  assert.equal(others.worker.error, "Unknown clipboard request.");
  assert.equal(typeof others.offscreen?.text, "undefined", `the offscreen document gave Settings no text: ${JSON.stringify(others)}`);

  if (SCREENSHOTS) {
    await search.bringToFront();
    const cdp = await search.createCDPSession();
    const writeTheme = popupTheme => settings.evaluate(async theme => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: { popupTheme: theme } });
      if (!reply.ok) throw new Error(reply.error);
    }, popupTheme);
    for (const theme of ["girlypop", "high-contrast", "default"]) {
      await writeTheme(theme);
      await search.waitForFunction(value => document.documentElement.dataset.hoshidictsTheme === value,
        { polling: 100, timeout: 10_000 }, theme);
      await search.screenshot({ path: resolve(SCREENSHOTS, `search-clipboard-monitor-${theme}.png`) });
    }
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    await search.screenshot({ path: resolve(SCREENSHOTS, "search-clipboard-monitor-forced-colors.png") });
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  }
  passed = true;
  console.log("PASS: the clipboard monitor searches Japanese copied in another tab through the offscreen document without"
    + " focus; it skips what was there before, text without Japanese, copies on the search page and copies during a"
    + " Note, and only the search page can read the clipboard");
} finally {
  if (!passed) for (const line of diagnostics) console.log(line);
  await browser.close();
  server.close();
  if (passed) rmSync(PROFILE, { recursive: true, force: true });
}
