// Where a Settings batch spends its time between imports (#578 perf check). Temporary.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildTitledZip } from "../../make-fixture.mjs";

const ROOT = process.cwd();
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const COUNT = Number(process.env.PROBE_COUNT ?? 45);
const OUT = resolve(tmpdir(), `probe-578-${process.pid}`);
const PROFILE = resolve(OUT, "profile");
mkdirSync(PROFILE, { recursive: true });
const paths = Array.from({ length: COUNT }, (_, index) => {
  const title = `${String(index + 1).padStart(3, "0")}-Probe`;
  const path = resolve(OUT, `${title}.zip`);
  writeFileSync(path, buildTitledZip(title, { revision: `r${index}`,
    terms: [[`語${index}`, "ご", "n", "", 1, [`probe ${index}`], index + 1, ""]] }));
  return path;
});
const browser = await puppeteer.launch({
  executablePath: resolve(process.env.CHROME_ROOT ?? ROOT, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"),
  enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${process.env.PROBE_EXTENSION ?? resolve(ROOT, "extension")}`,
    `--load-extension=${process.env.PROBE_EXTENSION ?? resolve(ROOT, "extension")}`],
});
try {
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const log = [];
    globalThis.__probe = log;
    const install = () => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message, ...rest) => {
        const entry = { type: message?.type, start: performance.now() };
        log.push(entry);
        try { return await original(message, ...rest); } finally { entry.end = performance.now(); }
      };
    };
    if (globalThis.chrome?.runtime?.sendMessage) install();
  });
  await page.goto(`chrome-extension://${id}/settings.html#add-dictionaries`, { waitUntil: "domcontentloaded" });
  for (const other of await browser.pages()) if (other.url().endsWith("/startup.html")) await other.close();
  await page.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status", requestId: "p" });
    return status?.ready === true && status.loading !== true;
  }, { polling: 250 });
  await new Promise((done) => { setTimeout(done, 1500); });
  await page.evaluate(() => { globalThis.__probe.length = 0; globalThis.__probeStart = performance.now(); });
  await (await page.$("#import-file")).uploadFile(...paths);
  await page.waitForFunction((count) => document.getElementById("import-state").textContent.startsWith(`Finished ${count} of ${count}`),
    { polling: 50, timeout: 600_000 }, COUNT);
  const { log, finishedAt, startAt } = await page.evaluate(() => ({ log: globalThis.__probe, finishedAt: performance.now(),
    startAt: globalThis.__probeStart }));
  const imports = log.filter((entry) => entry.type === "hd_import");
  const between = [];
  for (let index = 1; index < imports.length; index += 1) {
    const gapStart = imports[index - 1].end;
    const gapEnd = imports[index].start;
    const inGap = log.filter((entry) => entry.start >= gapStart && entry.start < gapEnd && entry.type !== "hd_import");
    between.push({ gap: gapEnd - gapStart, calls: inGap.map((entry) => `${entry.type}:${(entry.end - entry.start).toFixed(1)}`) });
  }
  const median = (values) => { const s = [...values].sort((a, b) => a - b); return s[s.length >> 1]; };
  const byType = {};
  for (const entry of log) (byType[entry.type] ??= []).push(entry.end - entry.start);
  console.log(JSON.stringify({
    total: (finishedAt - startAt).toFixed(0),
    importMedian: median(imports.map((entry) => entry.end - entry.start)).toFixed(1),
    gapMedian: median(between.map((entry) => entry.gap)).toFixed(1),
    gapMax: Math.max(...between.map((entry) => entry.gap)).toFixed(1),
    calls: Object.fromEntries(Object.entries(byType).map(([type, values]) => [type, `${values.length}× median ${median(values).toFixed(1)} max ${Math.max(...values).toFixed(1)}`])),
    sampleGaps: between.slice(0, 3).concat(between.filter((entry) => entry.gap > 100)).slice(0, 8),
  }, null, 1));
} finally {
  await browser.close();
  rmSync(OUT, { recursive: true, force: true });
}
