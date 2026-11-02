// The first audit's probes/flash.mjs (reports/audit-hachi-issue-644-evidence), copied unchanged below.
// Does a dark-themed search page flash the browser's light canvas before its
// frame paints? Records every painted frame (CDP screencast) from navigation,
// for the build as is and for a copy whose search.html lacks reader-options.js,
// settings-theme.js and settings.css. The tab first shows a green page, so a
// frame is green (the previous page), white (the browser's canvas: a flash) or
// dark (the saved theme).
//   HACHIDORI_CHROME=… node flash.mjs <checkout> <out dir>
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stripped = mkdtempSync(join(tmpdir(), "audit644-flash-"));
const SOURCE = process.env.FLASH_EXTENSION ?? join(REPO, "extension");
cpSync(SOURCE, stripped, { recursive: true });
const shell = readFileSync(join(stripped, "search.html"), "utf8");
const without = shell.replace(/\s*<script src="reader-options.js"><\/script>/u, "")
  .replace(/\s*<script src="settings-theme.js"><\/script>/u, "")
  .replace(/\s*<link rel="stylesheet" href="settings.css" \/>/u, "");
if (without === shell) throw new Error("search.html did not change");
writeFileSync(join(stripped, "search.html"), without);
const result = {};
for (const [theme, scheme] of [["dark", "light"], ["light", "dark"]])
for (const [variant, extension] of [["as-is", SOURCE], ["without-theme-files", stripped]]) {
  const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), "audit644-flashp-")),
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
    const id = new URL(sw.url()).host;
    const settings = await browser.newPage();
    await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
    for (const page of await browser.pages()) if (page.url().includes("startup.html")) await page.close();
    await settings.evaluate(async (theme) => {
      const { options } = await chrome.storage.local.get("options");
      await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: { popupTheme: theme } });
    }, theme);
    await sleep(500);
    const runs = [];
    for (let run = 0; run < 4; run += 1) {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 600, height: 640 });
      await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await tab.goto("data:text/html,<body style='margin:0;background:rgb(0,160,0)'></body>");
      await tab.bringToFront();
      const cdp = await tab.createCDPSession();
      const frames = [];
      const stamps = [];
      cdp.on("Page.screencastFrame", (event) => {
        frames.push(event.data);
        stamps.push(event.metadata.timestamp);
        cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      });
      await cdp.send("Page.enable");
      await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
      const doc = await (async () => {
        for (let i = 0; i < 200; i += 1) {
          const frame = tab.frames().find(f => f.url().endsWith("/search-frame.html"));
          if (frame) return frame;
          await sleep(25);
        }
        return tab.mainFrame();
      })();
      await doc.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
      await sleep(400);
      await cdp.send("Page.stopScreencast");
      // Sample two points the page leaves empty, through the settings page's canvas.
      const samples = await settings.evaluate(async (encoded) => {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const out = [];
        for (const data of encoded) {
          const image = new Image();
          await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = `data:image/png;base64,${data}`; });
          canvas.width = image.width; canvas.height = image.height;
          context.drawImage(image, 0, 0);
          const pick = (x, y) => [...context.getImageData(Math.round(x * image.width), Math.round(y * image.height), 1, 1).data.slice(0, 3)];
          out.push([pick(0.5, 0.95), pick(0.97, 0.5)]);
        }
        return out;
      }, frames);
      const label = ([r, g, b]) => (g > 120 && r < 60 && b < 60 ? "green" : r > 225 && g > 225 && b > 225 ? "WHITE" : r < 90 && g < 90 && b < 110 ? "dark" : `rgb(${r},${g},${b})`);
      const sequence = samples.map(points => points.map(label).join("/"));
      // Each distinct state with how long it stayed on screen (ms).
      const states = [];
      sequence.forEach((value, index) => {
        if (index === 0 || value !== sequence[index - 1]) states.push([value, stamps[index]]);
      });
      const timed = states.map(([value, at], index) => `${value} ${index + 1 < states.length ? Math.round((states[index + 1][1] - at) * 1000) + "ms" : "(end)"}`);
      runs.push({ frames: frames.length, timed });
      if (run === 0) writeFileSync(join(OUT, `${variant}-frames.json`), JSON.stringify(samples));
      await tab.close();
    }
    result[`${theme} theme, ${scheme} preference, ${variant}`] = runs;
  } finally {
    await browser.close();
  }
}
console.log(JSON.stringify(result, null, 1));
