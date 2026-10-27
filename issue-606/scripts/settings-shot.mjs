// Scratch (not committed): Design → Pitch accent in the real Settings page.
// node settings-shot.mjs <extension> <out.png>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [extension, out] = process.argv.slice(2).map(path => resolve(path));
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const profile = mkdtempSync(resolve(tmpdir(), "hachi-606-settings-"));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  enableExtensions: true, userDataDir: profile, protocolTimeout: 120_000,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage"] });
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.goto(`chrome-extension://${id}/settings.html#design`, { waitUntil: "load" });
  await page.bringToFront();
  await page.waitForFunction(() => {
    const legend = [...document.querySelectorAll("#design legend")].find(node => node.textContent === "Pitch accent");
    return legend && legend.closest("fieldset").getClientRects().length > 0 && document.getElementById("opt-pitch-furigana");
  }, { timeout: 60_000, polling: 200 });
  await new Promise(resolveWait => setTimeout(resolveWait, 1500));
  const fieldset = await page.evaluateHandle(() => [...document.querySelectorAll("#design legend")]
    .find(node => node.textContent === "Pitch accent").closest("fieldset"));
  await fieldset.evaluate(node => node.scrollIntoView({ block: "center" }));
  await fieldset.screenshot({ path: out });
  console.log(out, await fieldset.evaluate(node => [...node.querySelectorAll("label > span:first-child, .field-label")]
    .map(label => label.textContent).join(" | ")));
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
