// Child popups, query-echo lookups, dictionary media and dictionary styles on
// a web page and on the search page's frame. Not part of the repo.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.argv[2];
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const EXTENSION = join(REPO, "extension");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body style="font-size:24px;padding:40px"><p id="kanji">漢字</p><p id="chain">連鎖語</p></body></html>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644n-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
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
        requestId: `n-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(() => null);
      if (reply?.ok) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }, fixture);
  const { nestedLinksFixture } = await import(join(REPO, "test/make-fixture.mjs"));
  const nested = nestedLinksFixture();
  const nestedImport = await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `nested-${attempt}`, blobUrl, fileName: "nested.zip" }).catch(() => null);
      if (reply?.ok) return true;
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }, Buffer.from(nested.archive).toString("base64"));
  console.log("nested import:", nestedImport);
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { hoverEnabled: true, lookupMode: "hover", customPopupJavascript: "/* open */" } });
  });
  await sleep(600);
  // What the popups show: depths, the image, the fixture table's dictionary style.
  const facts = target => target.evaluate(() => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    const popups = [...(root?.querySelectorAll(".gsm-hoshidicts-popup") ?? [])].filter(p => !p.hidden);
    const root0 = popups.find(p => p.dataset.hoshidictsDepth === "0");
    const image = root0?.querySelector(".gloss-image-link img");
    const th = root0?.querySelector("table th");
    const table = root0?.querySelector("table");
    return {
      depths: popups.map(p => p.dataset.hoshidictsDepth),
      child: popups.find(p => p.dataset.hoshidictsDepth === "1")?.textContent.slice(0, 40) ?? null,
      rootText: root0?.textContent.replace(/\s+/g, " ").slice(0, 50) ?? null,
      image: image ? { src: image.getAttribute("src")?.slice(0, 22), width: image.naturalWidth, complete: image.complete } : null,
      tableStyle: table ? { collapse: getComputedStyle(table).borderCollapse, thAlign: th && getComputedStyle(th).textAlign } : null,
      styleSheets: root ? root.adoptedStyleSheets.length + root.querySelectorAll("style").length : 0,
    };
  });
  // Hover the character at `index` of the first text node matching `text` in the docked/root popup.
  const hoverInPopup = async (target, mouse, offset, text) => {
    const point = await target.evaluate(text => {
      const root = document.querySelector("hachidori-host").shadowRoot;
      const popup = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
      const walker = document.createTreeWalker(popup, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const at = node.nodeValue.indexOf(text);
        if (at < 0 || node.parentElement.closest("rt, button")) continue;
        const range = document.createRange();
        range.setStart(node, at); range.setEnd(node, at + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0) continue;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return null;
    }, text);
    if (!point) return false;
    await mouse.move(offset.x + point.x - 2, offset.y + point.y);
    await mouse.move(offset.x + point.x, offset.y + point.y, { steps: 3 });
    await sleep(1200);
    return true;
  };
  const web = await browser.newPage();
  await web.setViewport({ width: 960, height: 760 });
  await web.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  await sleep(600);
  const p = await web.evaluate(() => { const r = document.createRange(); const n = document.getElementById("kanji").firstChild; r.setStart(n, 0); r.setEnd(n, 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await web.mouse.move(p.x, p.y, { steps: 3 });
  await web.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot?.querySelector("table"), { timeout: 10000 });
  await sleep(800);
  console.log("web:", JSON.stringify(await facts(web)));
  // Child popup: hover カン (the table's on reading) in the definitions.
  console.log("web child hovered:", await hoverInPopup(web, web.mouse, { x: 0, y: 0 }, "カン"));
  console.log("web after child:", JSON.stringify(await facts(web)));

  await web.mouse.move(5, 5); await web.keyboard.press("Escape"); await sleep(400);
  const c = await web.evaluate(() => { const r = document.createRange(); const n = document.getElementById("chain").firstChild; r.setStart(n, 0); r.setEnd(n, 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await web.mouse.move(c.x, c.y, { steps: 3 });
  await web.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup")?.textContent.includes("A linked definition"), { timeout: 10000 });
  console.log("web chain child hovered:", await hoverInPopup(web, web.mouse, { x: 0, y: 0 }, "食用語"));
  console.log("web chain after child:", JSON.stringify(await facts(web)));
  const tab = await browser.newPage();
  await tab.setViewport({ width: 960, height: 760 });
  await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await sleep(500);
  const frame = tab.frames().find(f => f.url().endsWith("/search-frame.html"));
  await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  await frame.focus("#search-input");
  await frame.$eval("#search-input", box => { box.value = "漢字"; });
  await tab.keyboard.press("Enter");
  await frame.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot?.querySelector("table"), { timeout: 10000 });
  await sleep(800);
  console.log("search:", JSON.stringify(await facts(frame)));
  console.log("search child hovered:", await hoverInPopup(frame, tab.mouse, { x: 0, y: 0 }, "カン"));
  console.log("search after child:", JSON.stringify(await facts(frame)));
  await frame.$eval("#search-input", box => { box.value = "連鎖語"; });
  await frame.focus("#search-input");
  await tab.keyboard.press("Enter");
  await frame.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup")?.textContent.includes("A linked definition"), { timeout: 10000 });
  console.log("search chain child hovered:", await hoverInPopup(frame, tab.mouse, { x: 0, y: 0 }, "食用語"));
  console.log("search chain after child:", JSON.stringify(await facts(frame)));
  // An internal link in the definitions opens the linked entry.
  const clicked = await frame.evaluate(() => {
    const popup = document.querySelector("hachidori-host").shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const link = [...popup.querySelectorAll("a")].find(a => a.textContent.includes("Open the referenced entry"));
    link?.click();
    return Boolean(link);
  });
  await sleep(1500);
  console.log("search internal link clicked:", clicked, JSON.stringify(await facts(frame)));
  await frame.$eval("#search-input", box => { box.value = "漢字"; });
  await frame.focus("#search-input");
  await tab.keyboard.press("Enter");
  await sleep(1500);
  // The echoed query above the results: its second character looked up by hover.
  const echo = await frame.evaluate(() => { const r = document.createRange(); const n = document.getElementById("search-query").firstChild; r.setStart(n, 1); r.setEnd(n, 2); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await tab.mouse.move(echo.x - 2, echo.y);
  await tab.mouse.move(echo.x, echo.y, { steps: 3 });
  await sleep(1500);
  console.log("search after echo hover:", JSON.stringify(await facts(frame)));
} finally {
  await browser.close();
  server.close();
}
