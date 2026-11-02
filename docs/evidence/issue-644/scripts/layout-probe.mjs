// Header, switch, form and results geometry of the search page, main against the branch. Not part of the repo.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO, EXTENSION] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644layout-")),
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
  const doc = () => tab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? tab.mainFrame();
  await doc().waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  const rect = (frame, selector) => frame.evaluate(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(v => Math.round(v * 64) / 64) : null; }, selector);
  const shell = tab.mainFrame();
  const framed = doc() !== shell;
  const offset = framed ? await rect(shell, "iframe.search-frame") : [0, 0, 0, 0];
  const shift = r => r && [r[0] + offset[0], r[1] + offset[1], r[2], r[3]];
  console.log(JSON.stringify({
    framed, frame: framed ? offset : null,
    header: await rect(shell, ".search-header") ?? shift(await rect(doc(), ".search-header")),
    h1: await rect(shell, ".search-header h1") ?? shift(await rect(doc(), ".search-header h1")),
    switch: await rect(shell, "#search-clipboard") ?? shift(await rect(doc(), "#search-clipboard")),
    form: shift(await rect(doc(), "#search-form")),
    results: shift(await rect(doc(), "#search-results")),
  }));
} finally {
  await browser.close();
}
