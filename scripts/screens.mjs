// Screenshots of Settings → Add dictionaries for the #578 PR. Temporary; under ignored test/tmp.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTitledZip } from "../../make-fixture.mjs";

const require = createRequire(new URL("../../tooling/package.json", import.meta.url));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUT = resolve(ROOT, "test/tmp/screens-578");
const PROFILE = resolve(tmpdir(), `hachidori-screens-578-${process.pid}`);
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const names = ["034-BCCWJ-LUW", "035-CC100", "036-JLPT", "037-Novels", "038-Wikipedia"];
const paths = names.map((title, index) => {
  const path = resolve(OUT, `${title}.zip`);
  writeFileSync(path, buildTitledZip(title, { banks: false, revision: `r${index}`,
    termMeta: Array.from({ length: 50_000 }, (_, row) => [`語${row}`, "freq", { value: row + 1 }]) }));
  return path;
});
const holder = buildTitledZip("Held import", { revision: "1",
  termMeta: Array.from({ length: 400_000 }, (_, row) => [`語${row}`, "freq", { value: row + 1 }]) }).toString("base64");

const browser = await puppeteer.launch({
  executablePath: resolve(ROOT, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"),
  enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${resolve(ROOT, "extension")}`,
    `--load-extension=${resolve(ROOT, "extension")}`],
});
try {
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 900, deviceScaleFactor: 1 });
  await page.goto(`chrome-extension://${id}/settings.html#add-dictionaries`, { waitUntil: "domcontentloaded" });
  for (const other of await browser.pages()) if (other.url().endsWith("/startup.html")) await other.close();
  await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
    type: "hd_status", requestId: "s" }))?.ready === true, { polling: 200 });
  const section = await page.$("#add-dictionaries");
  const shoot = async (name) => {
    const box = await section.boundingBox();
    await page.screenshot({ path: resolve(OUT, name), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 560) } });
  };
  // Hold the engine with a long import from another context, then pick the batch.
  const other = await browser.newPage();
  await other.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  // Keep the engine busy: repeated slow cleanups and reloads queued from the other page.
  void other.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes]));
    for (let round = 0; round < 6; round += 1) {
      await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: `held-${round}`,
        blobUrl, fileName: "Held import.zip" });
    }
  }, holder);
  await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
    type: "hd_status", requestId: "m" }))?.mutating === true, { polling: 20 });
  await (await page.$("#import-file")).uploadFile(...paths);
  await page.waitForFunction(() => document.querySelector("#import-progress .setup-dictionary-status")
    ?.textContent.startsWith("Waiting for the previous import to finish"), { polling: 20, timeout: 60_000 });
  await page.bringToFront();
  await shoot("waiting.png");
  await page.waitForFunction(() => document.getElementById("import-state").textContent.startsWith("Finished 5 of 5"),
    { polling: 100, timeout: 300_000 });
  await shoot("finished.png");
  console.log(await page.$eval("#import-state", (node) => node.textContent));
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
