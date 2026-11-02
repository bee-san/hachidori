// The reporter's own Custom JavaScript and CSS (#644, from their debug log) on
// the search page, with several pitch dictionaries that agree, as in their
// screenshot. Prints how many pitch groups show, and saves a screenshot.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, OUT] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const { buildTitledZip } = await import(join(REPO, "test/make-fixture.mjs"));
const EXTENSION = process.env.PROBE_EXTENSION ?? join(REPO, "extension");
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The reporter's customPopupJavascript and customPopupCss, saved from the
// debug log attached to #644 into these two files.
const script = readFileSync(process.env.REPORTER_JS, "utf8");
const css = readFileSync(process.env.REPORTER_CSS, "utf8");
const perExtensionToggle = process.env.HACHIDORI_CHROME.includes("152");
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644r-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const extensions = await browser.newPage();
  await extensions.goto(`chrome://extensions/?id=${id}`);
  await extensions.evaluate((id, perExtension) => (perExtension
    ? chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true })
    : chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })), id, perExtensionToggle);
  await extensions.close();
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  for (const p of await browser.pages()) if (p.url().includes("startup.html")) await p.close();
  // A term dictionary and four pitch dictionaries that all give 嵐 あらし [0].
  const archives = [
    ["terms.zip", buildTitledZip("嵐 terms", { terms: [["嵐", "あらし", "n", "", 10, ["storm"], 1, ""]] })],
    ...["NHK", "大辞泉", "大辞林", "新明解"].map(title => [`${title}.zip`, buildTitledZip(title, { banks: false,
      termMeta: [["嵐", "pitch", { reading: "あらし", pitches: [{ position: 0 }] }]] })]),
  ];
  for (const [fileName, archive] of archives) {
    const ok = await settings.evaluate(async (base64, fileName) => {
      const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
          requestId: `${fileName}-${attempt}`, blobUrl, fileName }).catch(() => null);
        if (reply?.ok) return true;
        await new Promise(r => setTimeout(r, 1000));
      }
      return false;
    }, Buffer.from(archive).toString("base64"), fileName);
    if (!ok) throw new Error(`could not import ${fileName}`);
  }
  await settings.evaluate(async ({ script, css }) => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { customPopupJavascript: script, customPopupCss: css, popupTheme: "dark" } });
    if (!reply.ok) throw new Error(reply.error);
  }, { script, css });
  await sleep(1000);
  const tab = await browser.newPage();
  await tab.setViewport({ width: 600, height: 640 });
  await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await sleep(500);
  const frame = tab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? tab.mainFrame();
  await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  await frame.focus("#search-input");
  await frame.$eval("#search-input", box => { box.value = "嵐"; });
  await tab.keyboard.press("Enter");
  await frame.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot
    ?.querySelector(".pronunciation-group"), { timeout: 15000 }).catch(() => {});
  await sleep(800);
  const shown = await frame.evaluate(() => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    const all = [...(root?.querySelectorAll(".pronunciation-group") ?? [])];
    return { groups: all.length, visible: all.filter(group => group.getClientRects().length > 0).length };
  }).catch(error => ({ error: error.message }));
  console.log(JSON.stringify({ frame: frame.url(), ...shown }));
  await tab.screenshot({ path: OUT });
} finally {
  await browser.close();
}
