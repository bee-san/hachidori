// Evidence capture: Settings → Design for each theme, and JL's preview before/after
// turning off Show pitch in furigana. Usage: node design-shots.mjs <repo> <output dir>
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [repo, output] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const tooling = "/home/skerraut/herd-hachidori/i421/clones/fix-422";
const puppeteer = (await import(pathToFileURL(`${tooling}/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`).href)).default;
const extension = resolve(repo, "extension");
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-design-shots-"));
const browser = await puppeteer.launch({
  executablePath: `${tooling}/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome`,
  headless: true, enableExtensions: true, userDataDir: profile,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
});
const errors = [];
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const settings = await browser.newPage();
  settings.setDefaultTimeout(60000);
  settings.on("pageerror", error => errors.push(error.message));
  await settings.setViewport({ width: 1400, height: 1000 });
  await settings.goto(`${origin}/settings.html#advanced`);
  await settings.bringToFront();
  await settings.waitForSelector("#opt-experimental-themeStore", { visible: true });
  await settings.click("#opt-experimental-themeStore");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options?.experimental?.themeStore === true);
  await settings.evaluate(() => { location.hash = "design"; });
  await settings.waitForSelector(".theme-store-card button", { visible: true });
  const preview = () => settings.frames().find(frame => frame.url().includes("design-preview.html"));
  const select = async (index, slug) => {
    await settings.click(`.theme-store-card:nth-child(${index}) button`);
    await settings.waitForFunction(async value => (await chrome.storage.local.get("options")).options.popupTheme === value, {}, slug);
    await preview().waitForFunction(value => document.getElementById("preview-host")?.dataset.hoshidictsRenderer === value, {}, slug);
    await new Promise(done => setTimeout(done, 600));
  };
  const shoot = async name => {
    await settings.evaluate(() => document.getElementById("design").scrollIntoView());
    const design = await settings.$("#design .design-controls");
    await design.screenshot({ path: resolve(output, `${name}.png`), captureBeyondViewport: true });
  };
  for (const [index, slug] of [[1, "default"], [2, "nazeka"], [3, "plain"], [4, "jl"], [5, "bee"]]) {
    await select(index, slug);
    await shoot(`design-${slug}`);
  }
  await select(4, "jl");
  const sample = async name => {
    await settings.evaluate(() => document.querySelector(".design-sample").scrollIntoView());
    await new Promise(done => setTimeout(done, 400));
    await (await settings.$("#preview-viewport")).screenshot({ path: resolve(output, `${name}.png`) });
  };
  await sample("jl-preview-pitch-on");
  await settings.$eval("#opt-pitch-furigana", input => input.click());
  await new Promise(done => setTimeout(done, 1200));
  await sample("jl-preview-pitch-off");
  console.log(JSON.stringify({ morae: await preview().evaluate(() => document.getElementById("preview-host").shadowRoot.querySelectorAll(".jl-mora").length), errors }));
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
