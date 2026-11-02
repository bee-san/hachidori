// Where focus ends after a click on the Clipboard monitor switch or its label text, starting in the box; and
// what Escape and Ctrl+U do while the switch has focus. Works on main's one-document page and on this PR's frame.
// Not part of the repo.  HACHIDORI_CHROME=… node switch-focus-probe.mjs <checkout> <extension>
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO, EXTENSION] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644focus-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  for (const p of await browser.pages()) if (p.url().includes("startup.html")) await p.close();
  const fixture = readFileSync(join(REPO, "test/fixtures/hachidori-fixture.zip")).toString("base64");
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `a-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(() => null);
      if (reply?.ok) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }, fixture);
  const tab = await browser.newPage();
  await tab.setViewport({ width: 900, height: 700 });
  await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await sleep(500);
  const frame = tab.frames().find(c => c.url().endsWith("/search-frame.html")) ?? tab.mainFrame();
  await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  await tab.waitForFunction(() => !document.getElementById("search-clipboard").disabled, { timeout: 20000 });
  const where = async () => ({ shell: await tab.evaluate(() => document.activeElement?.id || document.activeElement?.localName),
    frame: await frame.evaluate(() => (document.hasFocus() ? document.activeElement?.id || document.activeElement?.localName : "no focus")) });
  const out = {};
  for (const [name, selector] of [["switch", "#search-clipboard"], ["label text", ".lookup-enable span"]]) {
    await frame.focus("#search-input");
    await sleep(100);
    const box = await tab.$eval(selector, el => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await tab.mouse.click(box[0], box[1]);
    await sleep(400);
    out[name] = await where();
  }
  const box = () => frame.evaluate(() => {
    const input = document.getElementById("search-input");
    return { value: input.value, focused: document.activeElement === input && document.hasFocus(),
      selected: input.selectionStart === 0 && input.selectionEnd === input.value.length && input.value.length > 0 };
  });
  await frame.$eval("#search-input", input => { input.value = "食べる"; });
  await tab.focus("#search-clipboard");
  await tab.keyboard.press("Escape");
  await sleep(300);
  out.escapeOnSwitch = await box();
  await tab.focus("#search-clipboard");
  await tab.keyboard.down("Control"); await tab.keyboard.press("u"); await tab.keyboard.up("Control");
  await sleep(300);
  out.ctrlUOnSwitch = { ...await box(), pages: (await browser.pages()).map(p => p.url()).filter(u => u.startsWith("view-source")) };
  console.log(JSON.stringify(out));
} finally {
  await browser.close();
}
