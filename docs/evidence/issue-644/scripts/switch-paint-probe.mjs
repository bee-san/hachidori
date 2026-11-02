// Does search.html's switch paint before the frame's header and box? Saves every screencast frame from navigation.
//   HACHIDORI_CHROME=… node stage-probe.mjs <checkout> <extension> <out dir> [theme]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO, EXTENSION, OUT, THEME = "dark"] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644stage-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
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
  }, THEME);
  await sleep(500);
  for (let run = 0; run < 4; run += 1) {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 900, height: 700 });
    await tab.goto("data:text/html,<body style='margin:0;background:rgb(0,160,0)'></body>");
    await tab.bringToFront();
    const cdp = await tab.createCDPSession();
    const frames = [];
    cdp.on("Page.screencastFrame", (event) => {
      frames.push([event.metadata.timestamp, event.data]);
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
    frames.forEach(([at, data], index) => writeFileSync(join(OUT, `run${run}-${String(index).padStart(3, "0")}-${Math.round(at * 1000)}.png`), Buffer.from(data, "base64")));
    await tab.close();
  }
} finally {
  await browser.close();
}
