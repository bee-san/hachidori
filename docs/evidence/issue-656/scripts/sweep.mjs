// Probe for #656 (not committed to main): sweeps the search page header's
// width and reports, per width, the menu's width, the title's and label's
// lines, the rows, whether anything overflows, whether the switch is wholly
// in the window, and how far search.html's controls are from the frame's.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = "/home/skerraut/herd-synth3/clones/hachi-issue-656";
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const EXTENSION = process.env.EXT || resolve(ROOT, "extension");
const NAMES = (process.env.NAMES || "Sentences with audio and a picture|Words").split("|");
const browser = await puppeteer.launch({
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: process.env.BUILD || "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: process.env.PROFILE_DIR || mkdtempSync(resolve(tmpdir(), "hachi656-sweep-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  await settings.evaluate(async (names) => {
    const { options } = await chrome.storage.local.get("options");
    const anki = globalThis.HDReaderOptions.normaliseOptions(options).anki;
    const next = globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
      templates: names.map((name, index) => ({ ...anki.templates[0], id: index === 0 ? anki.templates[0].id : `t${index}`, name })) });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { anki: next } });
    if (!reply.ok) throw new Error(reply.error);
  }, NAMES);
  const search = await browser.newPage();
  await search.setViewport({ width: 640, height: 500 });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  const frameUrl = `chrome-extension://${id}/search-frame.html`;
  await search.waitForFrame(frameUrl, { timeout: 30000 });
  const frame = search.frames().find(f => f.url() === frameUrl);
  await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 30000 });
  if (NAMES.length > 1) await search.waitForFunction(() => !document.getElementById("search-template").hidden, { polling: 100, timeout: 10000 });
  const widths = (process.env.WIDTHS || "640,600,560,520,500,480,470,466,460,440,420,400,380,360,352,340,320,300,280,260,240,220,200").split(",").map(Number);
  const measure = () => {
    const header = document.querySelector(".search-header");
    const lines = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
    };
    const items = [...header.children].filter(element => element.getClientRects().length);
    const box = element => { const r = element.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    const select = header.querySelector(".search-template");
    const sw = header.querySelector(".lookup-enable input");
    return { menu: select.hidden ? null : Math.round(select.getBoundingClientRect().width * 10) / 10,
      lines: [lines(header.querySelector("h1")), lines(header.querySelector(".lookup-enable span"))],
      rows: new Set(items.map(element => Math.round(element.getBoundingClientRect().top / 10))).size,
      height: Math.round(header.getBoundingClientRect().height),
      overflow: header.scrollWidth > header.clientWidth + 0.5,
      switchInside: sw.getBoundingClientRect().right <= innerWidth + 0.5,
      boxes: [box(header.querySelector("h1")), select.hidden ? null : box(select), box(header.querySelector(".lookup-enable"))] };
  };
  for (const width of widths) {
    await search.setViewport({ width, height: 500 });
    await new Promise(r => setTimeout(r, 150));
    const shell = await search.evaluate(measure);
    const copy = await frame.evaluate(measure);
    const apart = Math.max(...shell.boxes.flatMap((b, i) => (b && copy.boxes[i] ? b.map((v, k) => Math.abs(v - copy.boxes[i][k])) : [0])));
    const { boxes, ...rest } = shell;
    console.log(width, JSON.stringify({ ...rest, frameOverflow: copy.overflow, apart: Math.round(apart * 1000) / 1000 }));
    if (process.env.SHOTS) await search.screenshot({ path: `${process.env.SHOTS}/header-${width}.png`, clip: { x: 0, y: 0, width, height: 110 } });
  }
} finally {
  await browser.close();
}
