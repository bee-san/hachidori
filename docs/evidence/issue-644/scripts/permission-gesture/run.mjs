// Does a click in a sandboxed frame let its parent extension page call
// permissions.request? Prints the parent's result. Not part of the repo.
//   HACHIDORI_CHROME=… or HACHIDORI_FIREFOX=… node run.mjs <checkout> chrome|firefox
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, BROWSER] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXTENSION = new URL(`./${BROWSER}`, import.meta.url).pathname;
let browser, page, frameEval;
if (BROWSER === "chrome") {
  browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), "hd644pp-")),
    args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/shell.html`, { waitUntil: "load" });
} else {
  const UUID = "22222222-3333-4444-8555-666666666666";
  browser = await puppeteer.launch({ browser: "firefox", executablePath: process.env.HACHIDORI_FIREFOX, headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), "hd644ppf-")), env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({ "protop@test": UUID }),
      "extensions.webextOptionalPermissionPrompts": false } });
  await browser.installExtension(EXTENSION);
  page = await browser.newPage();
  const session = page.mainFrame().browsingContext.userContext.browser.session;
  await session.send("browsingContext.navigate", { context: page.mainFrame().browsingContext.id, url: `moz-extension://${UUID}/shell.html`, wait: "none" });
}
try {
  await sleep(1500);
  // The switch sits at the frame's top-left; the frame at the page's top-left.
  await page.mouse.click(30, 30);
  await sleep(2500);
  console.log(BROWSER, JSON.stringify(await page.evaluate(() => window.results)));
} finally {
  await browser.close();
}
