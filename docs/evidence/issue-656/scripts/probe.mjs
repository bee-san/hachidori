import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const ROOT = "/home/skerraut/herd-synth3/clones/hachi-issue-656";
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const puppeteer = (await import(require.resolve("puppeteer-core"))).default;
const { Browser, computeExecutablePath } = await import(require.resolve("@puppeteer/browsers"));
const EXTENSION = resolve(ROOT, "extension");
const browser = await puppeteer.launch({
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: process.argv[2] || "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/toolbar.html`, { waitUntil: "load" });
  const sizes = [[0, 0], [50, 50], [100, 100], [200, 150], [300, 200], [600, 640], [1600, 1200], [5000, 5000], [100000, 100000]];
  const results = await page.evaluate(async (sizes) => {
    const screenInfo = { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight };
    const out = [screenInfo];
    for (const [width, height] of sizes) {
      try {
        const created = await chrome.windows.create({ url: "about:blank", type: "popup", width, height });
        const got = await chrome.windows.get(created.id);
        out.push({ asked: [width, height], created: [created.width, created.height], got: [got.width, got.height] });
        await chrome.windows.remove(created.id);
      } catch (error) { out.push({ asked: [width, height], error: String(error) }); }
    }
    return out;
  }, sizes);
  console.log(JSON.stringify(results, null, 1));
} finally { await browser.close(); }
