// Can Custom JavaScript, as a user script on a web page, read the clipboard
// once Hachidori holds clipboardRead? Copies text in one tab, then a user
// script on another page tries execCommand("paste") and navigator.clipboard.
// Not part of the repo.
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, SOURCE] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXTENSION = mkdtempSync(join(tmpdir(), "hd644clip-ext-"));
cpSync(SOURCE, EXTENSION, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8"));
// control: keep clipboardRead optional and ungranted

writeFileSync(join(EXTENSION, "manifest.json"), JSON.stringify(manifest, null, 2));
const server = createServer((q, r) => {
  r.setHeader("Content-Type", "text/html; charset=utf-8");
  r.end(`<!doctype html><body><p id="text">copied secret 12345</p><button id="copy">Copy</button>
<script>document.getElementById("copy").onclick = () => { const range = document.createRange();
range.selectNodeContents(document.getElementById("text")); getSelection().removeAllRanges(); getSelection().addRange(range);
window.copied = document.execCommand("copy"); };</script></body>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644clip-")),
  args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const extensions = await browser.newPage();
  await extensions.goto(`chrome://extensions/?id=${id}`);
  await extensions.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }), id);
  await extensions.close();
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  const code = `(async () => {
    const out = {};
    const area = document.body.appendChild(document.createElement("textarea"));
    let pasted = null;
    area.addEventListener("paste", event => { pasted = event.clipboardData.getData("text/plain"); });
    area.focus();
    try { out.execCommand = document.execCommand("paste"); } catch (error) { out.execCommand = String(error); }
    out.pasted = pasted;
    try { out.readText = await navigator.clipboard.readText(); } catch (error) { out.readText = "ERR " + error.name; }
    document.documentElement.dataset.clip = JSON.stringify(out);
  })();`;
  await settings.evaluate(async code => {
    const { options } = await chrome.storage.local.get("options");
    await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options?.revision ?? 0,
      options: { customPopupJavascript: code } });
  }, code);
  await sleep(1500);
  const copier = await browser.newPage();
  await copier.goto(`${base}/`, { waitUntil: "load" });
  await copier.click("#copy");
  console.log("copied:", await copier.evaluate(() => window.copied));
  const reader = await browser.newPage();
  await reader.goto(`${base}/?reader`, { waitUntil: "load" });
  await sleep(1500);
  console.log("user script on a web page:", await reader.evaluate(() => document.documentElement.dataset.clip ?? "did not run"));
  console.log("the extension's own read:", JSON.stringify(await settings.evaluate(() =>
    chrome.runtime.sendMessage({ target: "hachidori-clipboard", type: "hd_clipboard_read" }).catch(e => String(e)))));
} finally {
  await browser.close();
  server.close();
}
