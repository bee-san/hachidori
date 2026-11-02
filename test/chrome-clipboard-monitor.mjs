/*
 * The search page's clipboard monitor (#639) in a real Chrome: text copied in
 * another tab is read through the worker and the offscreen document while the
 * search page has no focus, and searched there with a real dictionary result.
 * What was on the clipboard before, text without Japanese, text copied or cut
 * on the search page itself and a copy made while a Note is being written are
 * not searched, a long copy is searched from its first 1,000 characters, which
 * are all the offscreen document sends, without holding the page, and no other
 * extension page can read the clipboard.
 *
 * Chrome shows its permission prompt in a window, which headless Chrome cannot
 * answer, so this copy of the extension holds clipboardRead from the start, as
 * turning the switch on and accepting the prompt leaves it. The switch's
 * request for the permission and turning it off run in the Firefox suite,
 * whose profile grants optional permissions without showing a prompt; no suite
 * shows the prompt itself.
 *
 * The switch and the monitor are search.html's; the box, the query and the
 * reader are in the frame it holds, search-frame.html (#644).
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
  const frameUrl = `chrome-extension://${extensionId}/search-frame.html`;
  await search.waitForFrame(frameUrl, { timeout: 30_000 });
  const frame = search.frames().find(candidate => candidate.url() === frameUrl);
  await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 30_000 });
  await search.waitForFunction(() => !document.getElementById("search-clipboard").disabled, { polling: 100, timeout: 30_000 });
  const popup = await popupReader(search, 0, frameUrl);
  const page = async () => ({
    ...await frame.evaluate(() => ({
      value: document.getElementById("search-input").value,
      query: document.getElementById("search-query").hidden ? null : document.getElementById("search-query").textContent,
    })),
    ...await search.evaluate(() => ({ switchOn: document.getElementById("search-clipboard").checked, focused: document.hasFocus() })),
  });
  // The texts the page's monitor reads, as its own requests return them.
  await search.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    globalThis.clipboardReads = [];
    chrome.runtime.sendMessage = function (message, ...rest) {
      const reply = send.call(this, message, ...rest);
      if (message?.type === "hd_clipboard_read") {
        reply.then(answer => globalThis.clipboardReads.push(answer?.text ?? null), () => {});
      }
      if (message?.type === "hd_audio_play") globalThis.audioPlays = (globalThis.audioPlays ?? 0) + 1;
      return reply;
    };
  });
  const forget = () => search.evaluate(() => { globalThis.clipboardReads.length = 0; });
  // Once the monitor has read `text` twice, it has acted on the first read.
  const readTwice = text => search.waitForFunction(value => globalThis.clipboardReads
    .filter(read => read === value).length >= 2, { polling: 50, timeout: 15_000 }, text);

  // What reaches the frame, where Custom JavaScript runs (#644): only text the
  // reader would search, never other text the monitor reads.
  await frame.evaluate(() => {
    globalThis.monitorTexts = [];
    globalThis.HDSearchBridge.onClipboard(text => globalThis.monitorTexts.push(text));
  });

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
  const reached = await frame.evaluate(() => globalThis.monitorTexts);
  assert.deepEqual(reached, ["読む"], `only text the reader searches reaches the frame: ${JSON.stringify(reached)}`);

  // Text copied on the search page itself.
  await search.bringToFront();
  await frame.focus("#search-input");
  await frame.$eval("#search-input", box => { box.value = "漢字"; box.select(); });
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
  // And text cut there, which the clipboard did not hold before.
  await search.bringToFront();
  await frame.focus("#search-input");
  await frame.$eval("#search-input", box => { box.value = "聞く"; box.select(); });
  await forget();
  await search.keyboard.down("Control");
  await search.keyboard.press("KeyX", { commands: ["Cut"] });
  await search.keyboard.up("Control");
  await web.bringToFront();
  await readTwice("聞く");
  const ownCut = await page();
  assert.equal(ownCut.query, "読む", `text cut on the search page is not searched: ${JSON.stringify(ownCut)}`);
  assert.equal(ownCut.value, "", "the cut took the text out of the box");

  // A Note being written holds the monitor off, and it searches again once the Note is closed.
  await search.bringToFront();
  assert.equal(await popup.click(".gsm-hoshidicts-note-button"), true, "the Note button opens the form");
  const noteFocused = await popupRoot(search, frameUrl).waitFor(shadow => {
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

  // A long copy is searched from its start, and reading it does not lay it out:
  // pasting 300,000 characters into a text area took 16-34 seconds. Only the
  // first 1,000 characters cross runtime messaging, which carries lookups too.
  const long = "昨日は友達と一緒に駅前の喫茶店へ行った。".repeat(15_000);
  assert.equal(long.length, 300_000);
  await copyInWeb(long);
  await frame.waitForFunction(start => document.getElementById("search-query").textContent === start,
    { polling: 100, timeout: 15_000 }, long.slice(0, 1000));
  const longRead = await search.evaluate(async () => {
    const start = performance.now();
    const reply = await chrome.runtime.sendMessage({ target: "hachidori-clipboard", type: "hd_clipboard_read" });
    return { ms: performance.now() - start, text: reply?.text };
  });
  assert.equal(longRead.text, long.slice(0, 1000), "a read of a 300,000-character clipboard returns its first 1,000 characters");
  assert.ok(longRead.ms < 2000, `one read of a 300,000-character clipboard took ${longRead.ms} ms`);
  assert.equal((await page()).value.length, 1000, "the box holds the first 1,000 characters");
  // A short copy again, for the screenshots.
  await copyInWeb("漢字");
  await frame.waitForFunction(() => document.getElementById("search-query").textContent === "漢字",
    { polling: 100, timeout: 15_000 });

  if (SCREENSHOTS) {
    await search.bringToFront();
    const cdp = await search.createCDPSession();
    const writeTheme = popupTheme => settings.evaluate(async theme => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: { popupTheme: theme } });
      if (!reply.ok) throw new Error(reply.error);
    }, popupTheme);
    // The switch eases its colours for 120 ms after a theme change (settings.css): shoot once it has.
    const switchSettled = () => search.evaluate(() => Promise.all(document.getElementById("search-clipboard")
      .getAnimations().map(animation => animation.finished.catch(() => {}))));
    for (const theme of ["girlypop", "high-contrast", "default"]) {
      await writeTheme(theme);
      for (const target of [search, frame]) {
        await target.waitForFunction(value => document.documentElement.dataset.hoshidictsTheme === value,
          { polling: 100, timeout: 10_000 }, theme);
      }
      await switchSettled();
      await search.screenshot({ path: resolve(SCREENSHOTS, `search-clipboard-monitor-${theme}.png`) });
    }
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    await switchSettled();
    await search.screenshot({ path: resolve(SCREENSHOTS, "search-clipboard-monitor-forced-colors.png") });
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  }
  // A click on the switch hands focus back to the page, where the reader's
  // keybinds work, as beside the switch on one page (#644): Alt+P plays the
  // result's pronunciation. This copy holds clipboardRead as a required
  // permission, so the click cannot give it back and the switch stays on.
  await search.bringToFront();
  await search.evaluate(() => { globalThis.audioPlays = 0; });
  await search.click("#search-clipboard");
  await frame.waitForFunction(() => document.hasFocus(), { polling: 50, timeout: 5_000 });
  await search.keyboard.down("Alt");
  await search.keyboard.press("KeyP");
  await search.keyboard.up("Alt");
  await search.waitForFunction(() => globalThis.audioPlays > 0, { polling: 50, timeout: 10_000 });
  // A switch that already has focus keeps it, as after Space: Chrome focuses
  // the switch before the pointer events of a screen reader's or voice
  // control's click, which must not move focus off what the user toggled.
  await search.focus("#search-clipboard");
  await search.click("#search-clipboard");
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  assert.equal(await search.evaluate(() => document.activeElement?.id), "search-clipboard",
    "a click on the focused switch leaves focus on it");
  // A finger's tap hands focus back too, though Chrome focuses the switch only
  // after the tap's pointerup: a press held as long as a finger rests.
  await frame.focus("#search-input");
  await search.evaluate(() => {
    globalThis.switchClicks = 0;
    document.getElementById("search-clipboard").addEventListener("click", () => { globalThis.switchClicks += 1; });
  });
  const touch = await search.createCDPSession();
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const [x, y] = await search.$eval("#search-clipboard", (element) => {
    const box = element.getBoundingClientRect();
    return [box.x + box.width / 2, box.y + box.height / 2];
  });
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await new Promise(resolveWait => setTimeout(resolveWait, 120));
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await search.waitForFunction(() => globalThis.switchClicks > 0, { polling: 50, timeout: 5_000 });
  await new Promise(resolveWait => setTimeout(resolveWait, 300));
  const tapped = { shell: await search.evaluate(() => document.activeElement?.localName),
    frame: await frame.evaluate(() => document.hasFocus()) };
  assert.deepEqual(tapped, { shell: "iframe", frame: true }, `a tap on the switch hands focus back: ${JSON.stringify(tapped)}`);
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  passed = true;
  console.log("PASS: the clipboard monitor searches Japanese copied in another tab through the offscreen document without"
    + " focus; it skips what was there before, text without Japanese, copies on the search page and copies during a"
    + " Note, searches a long copy's first 1,000 characters, and only the search page can read the clipboard; only"
    + " text it searches reaches the frame, and a click or tap on its switch leaves the reader's keybinds working"
    + " unless the switch had focus");
} finally {
  if (!passed) for (const line of diagnostics) console.log(line);
  await browser.close();
  server.close();
  if (passed) rmSync(PROFILE, { recursive: true, force: true });
}
