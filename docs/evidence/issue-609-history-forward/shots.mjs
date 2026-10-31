// Evidence for hachidori #609: the popup through a kanji click, Alt+B and
// Alt+F in two palettes, and Settings → Keybinds, in Chrome for Testing 152
// with the repository's test fixtures. Run from a checkout after
// `npm ci --prefix test/tooling`, `node test/make-fixture.mjs` and
// `npm --prefix test/tooling run install:chrome`:
//   node shots.mjs <extension dir> <out dir> <label>
// The label "main" waits 1.5 s after Alt+F instead of requiring a kanji view.
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const CLONE = process.env.HACHIDORI_CHECKOUT ?? process.cwd();
const require = createRequire(resolve(CLONE, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const { popupReader, hoverForPopup } = await import(resolve(CLONE, "test/chrome-e2e/popup-reader.mjs"));
const [extension, out, label] = process.argv.slice(2);
const CHROME = process.env.HACHIDORI_CHROME
  ?? resolve(CLONE, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const FIXTURES = ["hachidori-fixture.zip", "hachidori-generic-kanji-fixture.zip"].map(name => resolve(CLONE, "test/fixtures", name));
mkdirSync(out, { recursive: true });
const profile = `/tmp/hf609-shots-profile-${process.pid}`;
rmSync(profile, { recursive: true, force: true });

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>History</title>
<body style="font: 32px serif; padding: 40px 40px 520px; background: #fff; color: #111">
<p><span id="verb">食べたかった</span></p></body></html>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: profile,
  defaultViewport: { width: 900, height: 760, deviceScaleFactor: 1 },
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html#dictionaries`, { waitUntil: "load" });
  const input = await settings.waitForSelector("#import-file");
  await input.uploadFile(...FIXTURES);
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) >= 2;
  }, { timeout: 120_000, polling: 250 });
  log("imported", await settings.evaluate(async () =>
    (await chrome.storage.local.get("dictionaryState")).dictionaryState.dictionaries.map(entry => entry.title)));

  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);

  const tab = await browser.newPage();
  await tab.goto(pageUrl, { waitUntil: "load" });
  const popup = await popupReader(tab);
  const frames = [];
  async function shot(name) {
    await new Promise(done => setTimeout(done, 400));
    const rect = await popup.rect();
    const clip = { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8),
      width: Math.min(900, rect.width + 16), height: Math.min(760, rect.height + 16) };
    const path = resolve(out, `${label}-${name}.png`);
    await tab.screenshot({ path, clip });
    frames.push(path);
    const state = await popup.state();
    log(name, JSON.stringify({ hasBack: state?.hasBack, focused: state?.focusedClass, text: state?.plain.slice(0, 80) }));
    return state;
  }
  const alt = async code => {
    await tab.keyboard.down("Alt");
    await tab.keyboard.press(code);
    await tab.keyboard.up("Alt");
  };
  const waitState = async accept => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await popup.state();
      if (accept(state)) return state;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`popup never reached the expected state: ${JSON.stringify(await popup.state())}`);
  };
  const onKanji = state => state?.plain.includes("Meanings");
  const onTerm = state => state?.plain.includes("to eat") && !state.plain.includes("Meanings");

  for (const theme of ["default", "light"]) {
    await writeOptions({ popupTheme: theme, lookupMode: "hover" });
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await new Promise(done => setTimeout(done, 300));
    const hovered = await hoverForPopup(tab, popup, "#verb", { accept: onTerm });
    if (!hovered) throw new Error("no term popup");
    await shot(`${theme}-1-term`);
    await popup.click(".gsm-hoshidicts-kanji-link");
    await waitState(onKanji);
    await shot(`${theme}-2-kanji`);
    await alt("KeyB");
    await waitState(onTerm);
    await shot(`${theme}-3-alt-b`);
    await alt("KeyF");
    if (label === "main") await new Promise(done => setTimeout(done, 1500));
    else await waitState(state => onKanji(state) && state.focusedClass.includes("gsm-hoshidicts-kanji-back"));
    await shot(`${theme}-4-alt-f`);
  }
  writeFileSync(resolve(out, `${label}-frames.json`), JSON.stringify(frames, null, 2));

  // Settings → Keybinds: the new default row and the browser shortcut.
  await settings.bringToFront();
  await settings.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
  await settings.goto(`chrome-extension://${id}/settings.html#keybinds`, { waitUntil: "load" });
  await settings.waitForFunction(() => document.querySelectorAll("#keybind-list > .keybind-row").length >= 9);
  const rowClip = async (first, last) => settings.evaluate((first, last) => {
    const rows = [...document.querySelectorAll("#keybind-list > .keybind-row")];
    rows[first].scrollIntoView({ block: "start" });
    const top = rows[first].getBoundingClientRect();
    const bottom = rows[last].getBoundingClientRect();
    return { x: top.left + window.scrollX - 8, y: top.top + window.scrollY - 8,
      width: top.width + 16, height: bottom.bottom - top.top + 16 };
  }, first, last);
  await new Promise(done => setTimeout(done, 300));
  await settings.screenshot({ path: resolve(out, `${label}-settings-keybinds.png`), clip: await rowClip(7, 8) });
  const rows = await settings.evaluate(() => [...document.querySelectorAll("#keybind-list > .keybind-row")].map(row =>
    `${row.querySelector(".keybind-input").value} → ${row.querySelector(".keybind-action").selectedOptions[0]?.textContent}`));
  log("keybind rows", JSON.stringify(rows));
  const shortcuts = await settings.evaluate(async () => {
    for (let attempt = 0; attempt < 50 && document.querySelectorAll("#browser-shortcut-list li").length === 0; attempt += 1) {
      await new Promise(done => setTimeout(done, 50));
    }
    const list = document.getElementById("browser-shortcut-list");
    const item = [...list.querySelectorAll("li")].find(entry => entry.textContent.includes("forward"));
    if (!item) return { items: [...list.querySelectorAll("li")].map(entry => entry.textContent), clip: null };
    item.previousElementSibling?.scrollIntoView({ block: "center" });
    const first = (item?.previousElementSibling ?? item).getBoundingClientRect();
    const last = item.getBoundingClientRect();
    return { items: [...list.querySelectorAll("li")].map(entry => entry.textContent),
      clip: { x: first.left + window.scrollX - 8, y: first.top + window.scrollY - 8,
        width: first.width + 16, height: last.bottom - first.top + 16 } };
  });
  log("browser shortcuts", JSON.stringify(shortcuts.items));
  if (shortcuts.clip) await settings.screenshot({ path: resolve(out, `${label}-settings-browser-shortcuts.png`), clip: shortcuts.clip });
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
