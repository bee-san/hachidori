// What a checkbox's click event reports for a mouse click on it, a mouse click on its label text, and Space.
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO, BROWSER] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const html = `<!doctype html><label id="l"><span id="t">Clipboard monitor</span> <input type="checkbox" id="c"></label>
<script>window.log=[];document.getElementById("c").addEventListener("click",e=>log.push(["click",e.detail,e.pointerType??null]));
document.getElementById("c").addEventListener("change",()=>log.push(["change"]));</script>`;
const browser = BROWSER === "firefox"
  ? await puppeteer.launch({ browser: "firefox", executablePath: process.env.HACHIDORI_FIREFOX, headless: true, userDataDir: mkdtempSync(join(tmpdir(), "hdcd-")) })
  : await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, args: ["--no-sandbox"], userDataDir: mkdtempSync(join(tmpdir(), "hdcd-")) });
try {
  const page = await browser.newPage();
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
  const out = {};
  await page.click("#c"); out.mouseOnBox = await page.evaluate(() => log.splice(0));
  await page.click("#t"); out.mouseOnLabel = await page.evaluate(() => log.splice(0));
  await page.focus("#c"); await page.keyboard.press(" "); out.space = await page.evaluate(() => log.splice(0));
  console.log(BROWSER, JSON.stringify(out));
} finally { await browser.close(); }
