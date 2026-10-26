// Throwaway evidence script (not committed): Settings → Reading → Definition blur
// with Reveal set to On click only. Usage: node settings-shot.mjs <repo> <out.png>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, out] = process.argv.slice(2).map(value => resolve(value));
const extension = join(repo, "extension");
const profile = mkdtempSync(join(tmpdir(), "hd598-settings-"));
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true,
  headless: true, userDataDir: profile,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`, "--force-device-scale-factor=1"] });
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 1400 });
  await page.goto(`chrome-extension://${id}/settings.html#lookup`, { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("opt-blur-count") && !document.getElementById("lookup").hidden,
    { timeout: 20_000, polling: 100 });
  const edit = async (id, value) => {
    await page.evaluate((id, value) => {
      const input = document.getElementById(id);
      for (let parent = input.closest("details"); parent; parent = parent.parentElement.closest("details")) parent.open = true;
      if (input.type === "checkbox") input.checked = value; else input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, id, value);
    await page.waitForFunction((id, value) => {
      const input = document.getElementById(id);
      return (input.type === "checkbox" ? input.checked === value : input.value === value)
        && /Saved|^$/u.test(document.getElementById("options-status").textContent);
    }, { timeout: 10_000, polling: 100 }, id, value).catch(async error => {
      console.error("status:", await page.evaluate(id => ({ status: document.getElementById("options-status").textContent,
        value: document.getElementById(id).value, checked: document.getElementById(id).checked,
        options: [...(document.getElementById(id).options ?? [])].map(option => option.value) }), id));
      throw error;
    });
    await new Promise(done => setTimeout(done, 500));
  };
  await edit("opt-blur-count", true);
  await edit("opt-blur-reveal", "click");
  const box = await page.evaluate(() => {
    const element = document.getElementById("definition-blur-settings");
    element.scrollIntoView({ block: "start" });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height,
      reveal: document.getElementById("opt-blur-reveal").value,
      options: [...document.getElementById("opt-blur-reveal").options].map(option => option.textContent),
      help: document.getElementById("definition-blur-help").textContent };
  });
  await page.screenshot({ path: out, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  console.log(JSON.stringify(box));
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
