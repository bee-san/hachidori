// "Before" screenshot for the #578 PR: a fresh profile's Settings imports a batch
// at once, as in the report. BEFORE_EXTENSION selects the extension to load.
// Temporary; under ignored test/tmp.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTitledZip } from "../../make-fixture.mjs";

const require = createRequire(new URL("../../tooling/package.json", import.meta.url));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EXTENSION = process.env.BEFORE_EXTENSION ?? resolve(ROOT, "extension");
const NAME = process.env.BEFORE_NAME ?? "before";
const OUT = resolve(ROOT, "test/tmp/screens-578");
const PROFILE = resolve(tmpdir(), `hachidori-before-578-${process.pid}`);
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });
const paths = ["031-Synthetic", "032-Synthetic", "033-Synthetic", "034-BCCWJ-LUW", "035-CC100", "036-JLPT", "037-Novels",
  "038-Wikipedia"].map((title, index) => {
  const path = resolve(OUT, `${title}.zip`);
  writeFileSync(path, buildTitledZip(title, { revision: `r${index}`,
    terms: [[`語${index}`, "ご", "n", "", 1, [`definition ${index}`], index + 1, ""]] }));
  return path;
});
const browser = await puppeteer.launch({
  executablePath: resolve(ROOT, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"),
  enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 1400, deviceScaleFactor: 1 });
  await page.goto(`chrome-extension://${id}/settings.html#add-dictionaries`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#import-file");
  for (const other of await browser.pages()) if (other.url().endsWith("/startup.html")) await other.close();
  await (await page.$("#import-file")).uploadFile(...paths);
  await page.waitForFunction((count) => document.getElementById("import-state").textContent.startsWith(`Finished ${count} of ${count}`),
    { polling: 50, timeout: 120_000 }, paths.length);
  const box = await (await page.$("#add-dictionaries")).boundingBox();
  await page.screenshot({ path: resolve(OUT, `${NAME}.png`), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 980) } });
  console.log(await page.$eval("#import-state", (node) => node.textContent));
  console.log(JSON.stringify(await page.$$eval("#import-progress .setup-dictionary-status", (rows) => rows.map((row) => row.textContent))));
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
