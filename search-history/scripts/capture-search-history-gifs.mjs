// Records the search history PR's GIFs in headless Chrome: lines copied and
// typed being kept and Up/Down recalling them in the box; the searched text's
// cursor moving word by word with the popup, and Up/Down to earlier lines; and
// the texthooker user script. Each step is a screenshot held for a set time,
// joined by ffmpeg into a GIF of at most 800 px.
// Usage: node capture-search-history-gifs.mjs <repo> <ffmpeg> <out-dir>
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [REPO, FFMPEG, OUT] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { buildTitledZip } = await import(join(REPO, "test/make-fixture.mjs"));
const settle = ms => new Promise(done => { setTimeout(done, ms); });

// A small dictionary for the demo lines, with glosses written for it.
const term = (expression, reading, tags, rules, glossary) => [expression, reading, tags, rules, 1, glossary, 1, ""];
const TERMS = [
  term("昨日", "きのう", "n", "", ["yesterday"]), term("は", "", "prt", "", ["topic marker"]),
  term("友達", "ともだち", "n", "", ["friend"]), term("と", "", "prt", "", ["with", "and"]),
  term("駅前", "えきまえ", "n", "", ["in front of the station"]), term("の", "", "prt", "", ["of; 's"]),
  term("喫茶店", "きっさてん", "n", "", ["café", "coffee shop"]), term("で", "", "prt", "", ["at; in (where something happens)"]),
  term("本", "ほん", "n", "", ["book"]), term("を", "", "prt", "", ["object marker"]),
  term("読む", "よむ", "v5", "v5", ["to read"]), term("今日", "きょう", "n", "", ["today"]),
  term("雨", "あめ", "n", "", ["rain"]), term("が", "", "prt", "", ["subject marker"]),
  term("降る", "ふる", "v5", "v5", ["to fall (of rain or snow)"]), term("でしょう", "", "exp", "", ["probably; I suppose"]),
  term("夜", "よる", "n", "", ["night"]), term("星", "ほし", "n", "", ["star"]),
  term("きれい", "", "adj-na", "", ["pretty", "clean"]), term("です", "", "cop", "", ["is; am; are (polite)"]),
  term("ね", "", "prt", "", ["isn't it?; you know"]), term("猫", "ねこ", "n", "", ["cat"]),
  term("好き", "すき", "adj-na", "", ["liked; fond of"]), term("明日", "あした", "n", "", ["tomorrow"]),
  term("晴れる", "はれる", "v1", "v1", ["to clear up (of the weather)"]),
];
const LINES = ["昨日は友達と駅前の喫茶店で本を読んだ。", "今日は雨が降るでしょう。", "夜の星がきれいですね。"];

const EXTENSION = join(tmpdir(), `hd-gif-extension-${process.pid}`);
rmSync(EXTENSION, { recursive: true, force: true });
cpSync(join(REPO, "extension"), EXTENSION, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8"));
delete manifest.optional_permissions;
manifest.permissions.push("clipboardRead");
writeFileSync(join(EXTENSION, "manifest.json"), JSON.stringify(manifest, null, 2));

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><meta charset="utf-8"><p id="text"></p><button id="copy">Copy</button><script>
    document.getElementById("copy").addEventListener("click", () => {
      const range = document.createRange(); range.selectNodeContents(document.getElementById("text"));
      getSelection().removeAllRanges(); getSelection().addRange(range); document.execCommand("copy");
    });</script>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: join(tmpdir(), `hd-gif-profile-${process.pid}`),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--font-render-hinting=none",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const frameUrl = `chrome-extension://${id}/search-frame.html`;
  const settings = await browser.newPage();
  settings.on("dialog", dialog => { void dialog.accept(); });
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const imported = await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: "gif", blobUrl,
      fileName: "hachidori-demo.zip" });
  }, buildTitledZip("Hachidori demo", { terms: TERMS }).toString("base64"));
  if (!imported?.ok) throw new Error(JSON.stringify(imported));
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  await writeOptions({ showLookupCounts: false, showPitchAccentBadge: false });

  const web = await browser.newPage();
  await web.goto(`http://127.0.0.1:${server.address().port}/`);
  // Copies in the other tab, as another program would, then comes back.
  let front = null;
  const copy = async (text) => {
    await web.bringToFront();
    await web.$eval("#text", (element, value) => { element.textContent = value; }, text);
    await web.click("#copy");
    await front?.bringToFront();
  };

  async function openSearch() {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 960, height: 600 });
    await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
    front = tab;
    await tab.waitForFrame(frameUrl);
    const frame = tab.frames().find(candidate => candidate.url() === frameUrl);
    await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 30_000 });
    await tab.waitForFunction(() => !document.getElementById("search-clipboard").disabled, { timeout: 30_000 });
    await tab.evaluate(() => {
      const caption = document.createElement("div");
      caption.id = "demo-caption";
      caption.style.cssText = "position:fixed;left:0;right:0;bottom:0;padding:9px 16px;background:rgba(12,12,22,.88);"
        + "color:#fff;font:600 16px system-ui,sans-serif;z-index:2147483647";
      document.body.append(caption);
    });
    return { tab, frame };
  }

  // One GIF: screenshots held for their durations.
  function recorder(name) {
    const dir = join(OUT, `${name}-frames`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const frames = [];
    return {
      async shot(tab, seconds) {
        await tab.bringToFront();
        await settle(120);
        const path = join(dir, `${String(frames.length).padStart(3, "0")}.png`);
        await tab.screenshot({ path });
        frames.push({ path, seconds });
      },
      finish() {
        const list = join(dir, "frames.txt");
        writeFileSync(list, `${frames.map(({ path, seconds }) => `file '${path}'\nduration ${seconds}`).join("\n")}\nfile '${frames.at(-1).path}'\n`);
        const gif = join(OUT, `${name}.gif`);
        execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf",
          "fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
          gif]);
        return { gif, bytes: statSync(gif).size, frames: frames.length };
      },
    };
  }
  const caption = (tab, text) => tab.evaluate((value) => { document.getElementById("demo-caption").textContent = value; }, text);
  const queryIs = (frame, text) => frame.waitForFunction(value => document.getElementById("search-query").textContent === value,
    { timeout: 15_000 }, text);
  const cursorIs = (frame, text) => frame.waitForFunction((value) => {
    const [range] = CSS.highlights.get("hd-search-cursor") ?? [];
    return range?.toString() === value;
  }, { timeout: 15_000 }, text);
  // The cursor covers the whole word once its lookup has answered; the popup paints just after.
  const resultShows = () => settle(350);

  // 1. Lines copied and typed are kept; Up and Down in the box bring them back.
  const recall = recorder("search-history-recall");
  const first = await openSearch();
  await caption(first.tab, "The search page keeps every line it searches (Clipboard monitor on)");
  await recall.shot(first.tab, 1.8);
  for (const line of LINES) {
    await copy(line);
    await queryIs(first.frame, line);
    await caption(first.tab, "A line copied in another program is searched and kept");
    await settle(400);
    await recall.shot(first.tab, 1.3);
  }
  await first.tab.bringToFront();
  await first.frame.focus("#search-input");
  await caption(first.tab, "Typed lines are kept too");
  await first.frame.$eval("#search-input", (box) => { box.value = ""; });
  await first.tab.keyboard.type("猫が好きです。");
  await recall.shot(first.tab, 1);
  await first.tab.keyboard.press("Enter");
  await queryIs(first.frame, "猫が好きです。");
  await settle(400);
  await recall.shot(first.tab, 1.3);
  await first.tab.keyboard.press("Escape");
  await first.tab.keyboard.type("明日は");
  await caption(first.tab, "Up in the box goes back through the kept lines…");
  await recall.shot(first.tab, 1.4);
  for (const expected of ["猫が好きです。", LINES[2], LINES[1], LINES[0]]) {
    await first.tab.keyboard.press("ArrowUp");
    await first.frame.waitForFunction(value => document.getElementById("search-input").value === value, { timeout: 5_000 }, expected);
    await recall.shot(first.tab, 0.9);
  }
  await caption(first.tab, "…and Down comes forward, back to what you were typing");
  for (const expected of [LINES[1], LINES[2], "猫が好きです。", "明日は"]) {
    await first.tab.keyboard.press("ArrowDown");
    await first.frame.waitForFunction(value => document.getElementById("search-input").value === value, { timeout: 5_000 }, expected);
    await recall.shot(first.tab, expected === "明日は" ? 2 : 0.9);
  }
  const recallGif = recall.finish();

  // 2. The searched text's cursor: words with the popup, and earlier lines.
  const words = recorder("search-history-words");
  await first.frame.$eval("#search-input", (box) => { box.value = "明日は晴れるでしょう。"; });
  await first.frame.focus("#search-input");
  await first.tab.keyboard.press("Enter");
  await queryIs(first.frame, "明日は晴れるでしょう。");
  await cursorIs(first.frame, "明日");
  await caption(first.tab, "After a search, the arrow keys move a cursor through the searched text");
  await settle(500);
  await words.shot(first.tab, 2);
  await caption(first.tab, "Right: the next word, looked up at once");
  for (const word of ["は", "晴れる", "でしょう"]) {
    await first.tab.keyboard.press("ArrowRight");
    await cursorIs(first.frame, word);
    await resultShows();
    await words.shot(first.tab, 1.1);
  }
  await caption(first.tab, "Left goes back over the words");
  await first.tab.keyboard.press("ArrowLeft");
  await cursorIs(first.frame, "晴れる");
  await resultShows();
  await words.shot(first.tab, 1.1);
  await caption(first.tab, "Up past the top row: the earlier line, between its neighbours");
  await first.tab.keyboard.press("ArrowUp");
  await queryIs(first.frame, "猫が好きです。");
  await cursorIs(first.frame, "猫");
  await resultShows();
  await words.shot(first.tab, 2);
  await first.tab.keyboard.press("ArrowRight");
  await cursorIs(first.frame, "が");
  await first.tab.keyboard.press("ArrowRight");
  await cursorIs(first.frame, "好き");
  await resultShows();
  await words.shot(first.tab, 1.2);
  await first.tab.keyboard.press("ArrowUp");
  await queryIs(first.frame, LINES[2]);
  await cursorIs(first.frame, "夜");
  await resultShows();
  await caption(first.tab, "Up again goes further back");
  await words.shot(first.tab, 1.6);
  for (const word of ["の", "星"]) {
    await first.tab.keyboard.press("ArrowRight");
    await cursorIs(first.frame, word);
  }
  await resultShows();
  await words.shot(first.tab, 1.2);
  await caption(first.tab, "Down comes back to the searched line, its cursor where it was");
  await first.tab.keyboard.press("ArrowDown");
  await queryIs(first.frame, "猫が好きです。");
  await resultShows();
  await words.shot(first.tab, 0.9);
  await first.tab.keyboard.press("ArrowDown");
  await queryIs(first.frame, "明日は晴れるでしょう。");
  await cursorIs(first.frame, "晴れる");
  await resultShows();
  await words.shot(first.tab, 2.2);
  const wordsGif = words.finish();
  await first.tab.close();

  // 3. The texthooker user script.
  const extensions = await browser.newPage();
  await extensions.goto(`chrome://extensions/?id=${id}`, { waitUntil: "load" });
  await extensions.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }), id);
  await extensions.close();
  await writeOptions({ customPopupJavascript: readFileSync(join(REPO, "userscripts/texthooker.js"), "utf8") });
  await settings.waitForFunction(async () => (await chrome.userScripts.getScripts({ ids: ["hachidori-custom-javascript"] })).length === 1,
    { timeout: 15_000 });
  const hook = recorder("search-history-texthooker");
  const hooked = await openSearch();
  await hooked.frame.waitForSelector("#hd-texthooker li", { timeout: 15_000 });
  await caption(hooked.tab, "userscripts/texthooker.js: the kept lines, newest at the bottom, with their counts");
  await hook.shot(hooked.tab, 2.2);
  for (const line of ["今日は雨が降るでしょう。", "昨日は友達と駅前の喫茶店で本を読んだ。"]) {
    await copy(line);
    await hooked.frame.waitForFunction(value => [...document.querySelectorAll("#hd-texthooker .hd-th-text")].at(-1)?.textContent === value,
      { timeout: 15_000 }, line);
    await caption(hooked.tab, "Each copied line joins the list, which scrolls along");
    await settle(400);
    await hook.shot(hooked.tab, 1.4);
  }
  await hooked.tab.bringToFront();
  const clickWord = async (index, at) => {
    const point = await hooked.frame.evaluate((index, at) => {
      const text = document.querySelectorAll("#hd-texthooker .hd-th-text")[index];
      text.scrollIntoView({ block: "nearest" });
      const range = document.createRange();
      range.setStart(text.firstChild, at);
      range.setEnd(text.firstChild, at + 1);
      const box = range.getBoundingClientRect();
      const dot = document.createElement("div");
      dot.id = "demo-pointer";
      dot.style.cssText = `position:fixed;left:${box.x + box.width / 2 - 9}px;top:${box.y + box.height / 2 - 9}px;width:18px;height:18px;`
        + "border-radius:50%;background:rgba(255,64,96,.55);border:2px solid #fff;pointer-events:none;z-index:2147483647";
      document.getElementById("demo-pointer")?.remove();
      document.body.append(dot);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, index, at);
    await hooked.tab.mouse.click(point.x, point.y);
  };
  const count = await hooked.frame.$$eval("#hd-texthooker .hd-th-text", texts => texts.length);
  await caption(hooked.tab, "Click a word to look it up (hovering with the activation key works too)");
  await clickWord(count - 1, 6);
  await settle(700);
  await hook.shot(hooked.tab, 1.8);
  await clickWord(count - 1, 9);
  await settle(700);
  await hook.shot(hooked.tab, 1.6);
  await hooked.frame.evaluate(() => document.getElementById("demo-pointer")?.remove());
  await caption(hooked.tab, "Times shows when each line came in");
  await hooked.frame.click("#hd-texthooker .hd-th-bar input[type=checkbox]");
  await hook.shot(hooked.tab, 1.6);
  await caption(hooked.tab, "Pause clipboard stops taking copied lines until you resume");
  await hooked.frame.click("#hd-texthooker .hd-th-pause");
  await copy("夜の星がきれいですね。");
  await settle(900);
  await hooked.tab.bringToFront();
  await hook.shot(hooked.tab, 1.8);
  await hooked.frame.click("#hd-texthooker .hd-th-pause");
  await caption(hooked.tab, "Double-click or Edit to fix a line; Delete removes it");
  await hooked.frame.$eval("#hd-texthooker li:last-child .hd-th-text", text => text.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await hooked.tab.keyboard.press("End");
  await hooked.tab.keyboard.press("Backspace");
  await hooked.tab.keyboard.type("ね");
  await hook.shot(hooked.tab, 1.4);
  await hooked.tab.keyboard.press("Enter");
  await settle(500);
  await hook.shot(hooked.tab, 1.2);
  await hooked.frame.$eval("#hd-texthooker li:first-child .hd-th-actions button:last-child", button => button.click());
  await settle(500);
  await hook.shot(hooked.tab, 2);
  const hookGif = hook.finish();
  await writeOptions({ customPopupJavascript: "" });
  console.log(JSON.stringify([recallGif, wordsGif, hookGif]));
} finally {
  await browser.close();
  server.close();
}
