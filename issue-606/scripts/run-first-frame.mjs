// Scratch runner (not committed): test/chrome-settings-first-frame.mjs alone,
// in a fresh profile with the given extension directory loaded.
// node run-first-frame.mjs <repo-with-test-dir> <extension-dir> <rounds>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, extension] = process.argv.slice(2, 4).map(path => resolve(path));
const rounds = Number(process.argv[4] ?? 1);
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const { checkSettingsFirstFrameTheme } = await import(pathToFileURL(`${repo}/test/chrome-settings-first-frame.mjs`).href);
const outcomes = [];
for (let round = 0; round < rounds; round += 1) {
  const profile = mkdtempSync(resolve(tmpdir(), "hachi-606-first-frame-"));
  const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
    enableExtensions: true, userDataDir: profile, protocolTimeout: 180_000,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox",
      "--disable-gpu", "--disable-dev-shm-usage"] });
  try {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker"
      && target.url().startsWith("chrome-extension://"));
    const id = new URL(worker.url()).host;
    const results = [];
    await checkSettingsFirstFrameTheme(browser, `chrome-extension://${id}/settings.html`,
      (name, ok, detail) => results.push({ name, ok, detail }), null);
    outcomes.push(results.every(result => result.ok) ? "PASS" : `FAIL ${results.find(result => !result.ok)?.detail?.slice(0, 300)}`);
  } catch (error) {
    outcomes.push(`THROW ${error.message}`);
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
console.log(outcomes.join("\n"));
