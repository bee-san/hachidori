// Ad-hoc measurement for #639 (not committed): how often the Clipboard monitor
// reads in a visible tab, a background tab, and a popup window that is not the
// focused window, over 10 s each.
// node /tmp/hachi-639/bench-rate.mjs <repo>
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repo = resolve(process.argv[2]);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { config } = JSON.parse(readFileSync(resolve(repo, "test/tooling/package.json"), "utf8"));
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(repo, `test/tmp/browsers/chrome/linux-${config.chrome}/chrome-linux64/chrome`);
const EXTENSION = "/tmp/hachi-639/bench-rate-ext";
const PROFILE = `/tmp/hachi-639/bench-rate-profile-${process.pid}`;
rmSync(EXTENSION, { recursive: true, force: true });
cpSync(resolve(repo, "extension"), EXTENSION, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"));
delete manifest.optional_permissions;
manifest.permissions.push("clipboardRead");
writeFileSync(resolve(EXTENSION, "manifest.json"), JSON.stringify(manifest, null, 2));
mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: PROFILE, enableExtensions: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const count = (page, ms) => page.evaluate(duration => new Promise(done => {
  const start = globalThis.reads;
  setTimeout(() => done(globalThis.reads - start), duration);
}), ms);
// Counts the page's reads from inside it; the count is read once the phase ends.
const instrument = page => page.evaluate(() => {
  globalThis.reads = 0;
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function (message, ...rest) {
    if (message?.type === "hd_clipboard_read") globalThis.reads += 1;
    return send.call(this, message, ...rest);
  };
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  // The first-run tab opens after install; wait for it and close it so it cannot come to the front later.
  const startup = await browser.waitForTarget(t => t.url().endsWith("/startup.html"), { timeout: 30_000 }).catch(() => null);
  await (await startup?.page())?.close();
  const url = `chrome-extension://${id}/search.html`;
  const result = {};
  const tab = await browser.newPage();
  await tab.goto(url, { waitUntil: "domcontentloaded" });
  await tab.waitForFunction(() => document.getElementById("search-clipboard").checked
    && !document.getElementById("search-clipboard").disabled, { polling: 100, timeout: 30_000 });
  await instrument(tab);
  await tab.waitForFunction(() => globalThis.reads > 0, { polling: 100, timeout: 10_000 });
  await tab.bringToFront();
  const startedVisible = await tab.evaluate(() => globalThis.reads);
  await new Promise(done => { setTimeout(done, 10_000); });
  result.visibleTab = await tab.evaluate(() => globalThis.reads) - startedVisible;
  const other = await browser.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  const hiddenStart = await tab.evaluate(() => ({ reads: globalThis.reads, hidden: document.hidden }));
  await new Promise(done => { setTimeout(done, 10_000); });
  const hiddenEnd = await tab.evaluate(() => ({ reads: globalThis.reads, hidden: document.hidden }));
  result.backgroundTab = { reads: hiddenEnd.reads - hiddenStart.reads, hidden: hiddenStart.hidden && hiddenEnd.hidden };
  await tab.close();
  // A popup window, with a normal window's tab in front of the browser.
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  const popupTarget = browser.waitForTarget(target => target.url() === url);
  await settings.evaluate(async address => { await chrome.windows.create({ url: address, type: "popup", width: 600, height: 640 }); }, url);
  const popup = await (await popupTarget).page();
  await popup.waitForFunction(() => document.getElementById("search-clipboard").checked
    && !document.getElementById("search-clipboard").disabled, { polling: 100, timeout: 30_000 });
  await popup.evaluate(() => {
    globalThis.reads = 0;
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function (message, ...rest) {
      if (message?.type === "hd_clipboard_read") globalThis.reads += 1;
      return send.call(this, message, ...rest);
    };
  });
  await settings.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.windows.update(tab.windowId, { focused: true }); });
  const popupStart = await popup.evaluate(() => ({ reads: globalThis.reads, hidden: document.hidden, focus: document.hasFocus() }));
  await new Promise(done => { setTimeout(done, 10_000); });
  const popupEnd = await popup.evaluate(() => ({ reads: globalThis.reads, hidden: document.hidden, focus: document.hasFocus() }));
  result.unfocusedPopupWindow = { reads: popupEnd.reads - popupStart.reads, hidden: popupEnd.hidden, focused: popupEnd.focus };
  void count;
  console.log(JSON.stringify({ chrome: await browser.version(), readsIn10s: result }, null, 1));
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
