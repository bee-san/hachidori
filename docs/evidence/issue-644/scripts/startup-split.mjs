// Where the search page's startup time goes, for #644: the shell document's
// start, the frame document's start, the frame's connection and the moment
// the box accepts a search, all on one clock (performance.timeOrigin). Not
// part of the repo.
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, EXTENSION, ROUNDS = "8"] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644split-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  await sleep(1500);
  for (const p of await browser.pages()) if (p.url().includes("startup.html")) await p.close();
  const rows = [];
  for (let round = 0; round < Number(ROUNDS); round += 1) {
    const tab = await browser.newPage();
    // Each document records its own milestones on the shared clock.
    await tab.evaluateOnNewDocument(() => {
      const at = () => performance.timeOrigin + performance.now();
      window.__marks = { origin: performance.timeOrigin };
      document.addEventListener("DOMContentLoaded", () => { window.__marks.dcl = at(); });
      new MutationObserver(() => {
        const submit = document.getElementById("search-submit");
        if (submit && !submit.disabled && !window.__marks.ready) window.__marks.ready = at();
        if (document.querySelector("iframe") && !window.__marks.frame) window.__marks.frame = at();
        if (document.querySelector('script[data-search-reader]') && !window.__marks.reader) window.__marks.reader = at();
      }).observe(document, { subtree: true, childList: true, attributes: true });
      window.addEventListener("message", () => { window.__marks.offer ??= at(); }, true);
    });
    await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
    await sleep(800);
    const frame = tab.frames().find(f => f.url().endsWith("/search-frame.html"));
    const shell = await tab.evaluate(() => window.__marks);
    const inner = frame ? await frame.evaluate(() => window.__marks) : null;
    const t0 = shell.origin;
    const rel = value => (value === undefined ? null : Math.round(value - t0));
    rows.push(inner ? { shellDcl: rel(shell.dcl), frameCreated: rel(shell.frame), offer: rel(shell.offer), frameStart: rel(inner.origin),
      frameDcl: rel(inner.dcl), readerScripts: rel(inner.reader), ready: rel(inner.ready) }
      : { dcl: rel(shell.dcl), readerScripts: rel(shell.reader), ready: rel(shell.ready) });
    await tab.close();
  }
  const median = key => { const xs = rows.map(r => r[key]).filter(v => v !== null).sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)]; };
  console.log(JSON.stringify(Object.fromEntries(Object.keys(rows[0]).map(key => [key, median(key)]))));
} finally {
  await browser.close();
}
