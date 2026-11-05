// Screenshot of Settings → Advanced → Experimental features for the PR (not part of the repo).
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repo = "/home/skerraut/herd-synth3/clones/hachi-youtube";
const require = createRequire(`${repo}/test/tooling/package.json`);
const puppeteer = require("puppeteer-core");
const extension = realpathSync(`${repo}/extension`);
const id = (() => {
  const hex = createHash("sha256").update(extension).digest("hex").slice(0, 32);
  return [...hex].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
})();
const browser = await puppeteer.launch({ executablePath: `${repo}/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome`,
  headless: true, enableExtensions: true, pipe: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachidori-settings-shot-")),
  args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 900, deviceScaleFactor: 1 });
  await page.goto(`chrome-extension://${id}/settings.html#advanced`);
  await page.waitForSelector("#opt-experimental-youtubeMining", { timeout: 60_000 });
  // The switch on, as a user turns it on.
  await page.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options?.revision ?? 0,
      options: { experimental: { ...HDReaderOptions.DEFAULT_OPTIONS.experimental, netflixMining: true, youtubeMining: true } } });
  });
  await page.waitForFunction(() => document.getElementById("opt-experimental-youtubeMining")?.checked === true, { timeout: 30_000 });
  const list = await page.$("#experimental-features");
  await list.evaluate(element => element.scrollIntoView({ block: "center" }));
  await new Promise(done => setTimeout(done, 500));
  const box = await list.boundingBox();
  const { x, y } = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await page.screenshot({ path: "/tmp/hachi-yt/media/settings-experimental.png",
    clip: { x: Math.max(0, box.x - 16) + x, y: Math.max(0, box.y - 56) + y, width: Math.min(1180, box.width + 32), height: box.height + 72 } });
  console.log("saved", JSON.stringify(box));
} finally {
  await browser.close();
}
