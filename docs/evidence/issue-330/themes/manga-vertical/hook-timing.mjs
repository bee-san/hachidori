// Evidence for issue #334 (manga-vertical theme): how long the theme's
// synchronous onRender hook takes, measured by the prototype host around the
// hook call (performance.now() before/after, content.js runThemeHook) and read
// back from the console. Reuses the profile the capture script imported into.
//
//   HACHIDORI_ROOT=<worktree> node hook-timing.mjs [rounds]
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HACHIDORI_ROOT;
const EXTENSION = resolve(ROOT, "extension");
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const ROUNDS = Number(process.argv[2] || 10);
const PAGE_HTML = readFileSync(resolve(HERE, "mokuro-page.html"), "utf8");
const server = createServer((q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(PAGE_HTML); });
await new Promise(d => server.listen(0, "127.0.0.1", d));
const browser = await puppeteer.launch({ executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: "/tmp/manga-vertical-profile", protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const timings = [];
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`, { waitUntil: "load" });
  await settings.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }))?.ready, { timeout: 120_000 });
  await settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, { popupTheme: "manga-vertical", lookupMode: "hover", hoverDelayMs: 0, popupWidthPx: 320, popupHeightPx: 560, popupOpacityPercent: 100,
    popupToolbarPosition: "top", showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3, showPitchAccentBadge: false, showLookupCounts: true });
  const tab = await browser.newPage();
  tab.on("console", m => {
    const match = /^HDTIMING kind=(\w+) nodes=(\d+) ms=([\d.]+)$/u.exec(m.text());
    if (match) timings.push({ kind: match[1], nodes: Number(match[2]), ms: Number(match[3]) });
  });
  await tab.setViewport({ width: 1180, height: 920, deviceScaleFactor: 1 });
  await tab.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1200));
  const point = (boxId, word) => tab.evaluate((boxId, word) => {
    for (const p of document.getElementById(boxId).querySelectorAll("p")) {
      const i = p.firstChild.nodeValue.indexOf(word); if (i < 0) continue;
      const range = document.createRange(); range.setStart(p.firstChild, i); range.setEnd(p.firstChild, i + 1);
      const r = range.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
  }, boxId, word);
  const popupOpen = () => tab.evaluate(() => { const p = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup"); return !!p && !p.hidden && !!p.querySelector(".mv-toolbar"); });
  const words = [["box1", "食"], ["box2", "掛"], ["box3", "逃"], ["box4", "読"], ["box3", "笑"]];
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const [box, word] of words) {
      const p = await point(box, word);
      await tab.mouse.move(4, 4);
      await new Promise(r => setTimeout(r, 150));
      await tab.mouse.move(p.x, p.y);
      const deadline = Date.now() + 5000;
      while (!(await popupOpen()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 250));
      if (word === "食") {   // kanji view + Back: two more renders
        const link = await tab.evaluate(() => { const b = [...document.querySelector("hachidori-host").shadowRoot.querySelectorAll(".gsm-hoshidicts-primary-header .gsm-hoshidicts-kanji-link")].find(x => x.textContent === "食"); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await tab.mouse.click(link.x, link.y);
        await new Promise(r => setTimeout(r, 400));
        const back = await tab.evaluate(() => { const b = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back"); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await tab.mouse.click(back.x, back.y);
        await new Promise(r => setTimeout(r, 400));
      }
      await tab.keyboard.press("Escape");
      await new Promise(r => setTimeout(r, 150));
    }
  }
} finally { await browser.close(); server.close(); }
const stats = kind => {
  const values = timings.filter(t => t.kind === kind).map(t => t.ms).sort((a, b) => a - b);
  const q = p => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  return values.length ? { n: values.length, min: values[0], median: q(0.5), p95: q(0.95), max: values.at(-1), nodesMax: Math.max(...timings.filter(t => t.kind === kind).map(t => t.nodes)) } : null;
};
const report = { rounds: ROUNDS, words: ["食べたかった", "掛けてみる", "逃げる", "読んで", "笑わせる", "食 (kanji) + Back"], term: stats("term"), kanji: stats("kanji"), samples: timings,
  boundary: "performance.now() around hook(view, api) in the prototype host (content.js runThemeHook); excludes building view/api and the anchor rect" };
writeFileSync(resolve(process.env.EVIDENCE_OUT ?? HERE, "hook-timing.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ term: report.term, kanji: report.kanji }, null, 2));
