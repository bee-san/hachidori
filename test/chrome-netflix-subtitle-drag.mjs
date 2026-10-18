// SPDX-License-Identifier: GPL-3.0-or-later
// Native subtitle geometry and real mouse gestures, with no Netflix requests.
// HACHIDORI_CHROME=/path/to/chrome node test/chrome-netflix-subtitle-drag.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require(process.env.HACHIDORI_PUPPETEER || "puppeteer-core");
const chrome = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${require("./package.json").config.chrome}/chrome-linux64/chrome`);
const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700 });
  await page.setRequestInterception(true);
  page.on("request", request => request.respond({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8">
    <style>body{margin:0;background:#102030;color:white;font:24px sans-serif}
    h1{margin:32px;font-size:24px}p{margin:32px;color:#aabbcc}
    .watch-video{position:absolute;inset:0;overflow:hidden}
    .player-timedtext{position:absolute;inset:0;pointer-events:none;transform:translateZ(0)}
    .player-timedtext-text-container{position:absolute;bottom:70px;width:100%;text-align:center;font-size:32px}
    span{background:#000b;padding:4px}</style>
    <h1>Netflix subtitle positioning</h1><p>Hachidori · synthetic player fixture</p>
    <div class="watch-video"><video></video><div class="player-timedtext">
    <div class="player-timedtext-text-container"><span>朝ごはんを</span><br><span id="word">食べたかった</span></div>
    </div></div><script>window.playerClicks=0;document.addEventListener("click",()=>window.playerClicks++);</script>` }));
  await page.goto("https://www.netflix.com/watch/81000001");
  for (const file of ["netflix-subtitles.js", "netflix-content.js"]) {
    await page.addScriptTag({ content: readFileSync(resolve(root, "extension", file), "utf8") });
  }
  await page.evaluate(() => HDNetflix.setSubtitleDragging(true));
  const box = () => page.$eval("#word", element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x, y, width, height };
  });
  const drag = async (from, dx, dy) => {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + dx, from.y + from.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
  };
  const initial = await box();
  await drag(initial, -180, -260);
  const moved = await box();
  assert.equal(moved.x, initial.x - 180, "the native subtitle moves horizontally");
  assert.equal(moved.y, initial.y - 260, "the native subtitle moves vertically");
  assert.equal(await page.evaluate(() => window.playerClicks), 0, "dropping the subtitle does not click the player");
  assert.equal(await page.evaluate(({ x, y, width, height }) => {
    const range = document.caretRangeFromPoint(x + width / 2, y + height / 2);
    return HDNetflix.observe(range.startContainer.parentElement)?.hoveredText;
  }, moved), "食べたかった", "moved text still provides the reader's real caret and mining observation");
  const output = resolve(root, "test/tmp/ci");
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: resolve(output, "netflix-subtitle-drag.png") });
  await page.evaluate(() => {
    const layer = document.querySelector(".player-timedtext");
    layer.outerHTML = layer.outerHTML;
    document.getElementById("word").textContent = "読み続ける";
  });
  assert.equal((await box()).y, moved.y, "replacement subtitle layers keep the offset");
  await drag(await box(), -1500, -1500);
  const clamped = await box();
  assert.ok(clamped.x >= 0 && clamped.y >= 0, "dragging keeps the subtitle text in the viewport");
  await page.evaluate(() => HDNetflix.setSubtitleDragging(false));
  const restored = await box();
  assert.equal(restored.y, initial.y, "switching mining off restores native positioning");
  await drag(restored, 100, -100);
  assert.deepEqual(await box(), restored, "dragging is inactive while the switch is off");
  await page.evaluate(() => HDNetflix.setSubtitleDragging(true));
  assert.equal((await box()).y, clamped.y, "switching back on remembers the session offset");
  await page.reload();
  assert.deepEqual(await box(), initial, "reloading starts with Netflix's own position");
  console.log("PASS: native drag, player click, caret lookup, replacement layers, bounds, switch and reload");
} finally {
  await browser.close();
}
