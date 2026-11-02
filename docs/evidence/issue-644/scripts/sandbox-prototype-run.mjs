import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.argv[2];
const EXTENSION = process.argv[3];
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644p-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const page = await browser.newPage();
  const errors = [];
  page.on("console", m => errors.push(`console ${m.type()}: ${m.text()}`));
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  await page.goto(`chrome-extension://${id}/shell.html`, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 2500));
  console.log(JSON.stringify(await page.evaluate(() => window.results), null, 1));
  console.log(errors.join("\n"));
  console.log("frames:", page.frames().map(f => f.url()));
} finally {
  await browser.close();
}
