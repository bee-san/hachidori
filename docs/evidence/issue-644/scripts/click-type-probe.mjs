// What a label's click listener sees (pointerType, detail, target) for a mouse click on the checkbox, a mouse click
// on the label text, Space on the focused checkbox, and a touch tap on each. Not part of the repo.
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO, BROWSER] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const html = `<!doctype html><body style="margin:40px"><label id="l" style="font-size:20px"><span id="t">Clipboard monitor</span> <input type="checkbox" id="c"></label>
<script>window.log=[];const l=document.getElementById("l");
for (const t of ["pointerdown","pointerup","click"]) l.addEventListener(t,e=>log.push([t,e.pointerType??null,e.detail,e.target.id]));</script>`;
const browser = BROWSER === "firefox"
  ? await puppeteer.launch({ browser: "firefox", executablePath: process.env.HACHIDORI_FIREFOX, headless: true, userDataDir: mkdtempSync(join(tmpdir(), "hdct-")) })
  : await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, args: ["--no-sandbox"], userDataDir: mkdtempSync(join(tmpdir(), "hdct-")) });
try {
  const page = await browser.newPage();
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
  const out = {};
  const take = () => page.evaluate(() => log.splice(0).map(e => e.join("/")).join(" "));
  await page.click("#c"); out.mouseOnBox = await take();
  await page.click("#t"); out.mouseOnLabel = await take();
  await page.focus("#c"); await page.keyboard.press(" "); out.space = await take();
  if (BROWSER !== "firefox") await page.setViewport({ width: 800, height: 600, hasTouch: true });
  const at = sel => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  try { const [x, y] = await at("#c"); await page.touchscreen.tap(x, y); await new Promise(r => setTimeout(r, 300)); out.touchOnBox = await take(); } catch (e) { out.touchOnBox = `error ${e.message}`; }
  try { const [x, y] = await at("#t"); await page.touchscreen.tap(x, y); await new Promise(r => setTimeout(r, 300)); out.touchOnLabel = await take(); } catch (e) { out.touchOnLabel = `error ${e.message}`; }
  console.log(BROWSER, process.env.HACHIDORI_CHROME?.match(/linux-(\d+)/)?.[1] ?? process.env.HACHIDORI_FIREFOX?.match(/stable_(\d+)/)?.[1], JSON.stringify(out));
} finally { await browser.close(); }
