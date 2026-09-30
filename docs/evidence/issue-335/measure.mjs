// Issue #335 density measurement: real extension, real dictionaries, pinned Chrome.
// usage: node measure.mjs <extensionDir> <label>
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire("/local/home/skerraut/work/hachidori-fix-335/test/tooling/package.json");
const puppeteer = require("puppeteer-core");
const CHROME = "/local/home/skerraut/work/hachidori-fix-335/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome";
const [extension, label] = process.argv.slice(2);
const OUT = `/tmp/335-measure/out/${label}`;
mkdirSync(OUT, { recursive: true });
const DICTS = "/tmp/335-dicts";

const PAGE = `<!doctype html><meta charset="utf-8"><style>
body { font: 28px "Noto Sans CJK JP", sans-serif; margin: 40px; }
span { display: inline-block; } p { margin: 0 0 18px; }
#bottom { position: absolute; top: 840px; left: 40px; }
</style>
<p>毎日<span id="taberu">食べる</span>ことにした。</p>
<p>大きな<span id="hikouki">飛行機</span>が飛んだ。</p>
<p>その<span id="kaku">格</span>。</p>
<p>壁に絵を<span id="kakeru">掛ける</span>。</p>
<p>もっと<span id="tabetakatta">食べたかった</span>のに。</p>
<p>分かる<span id="youni">ように</span>話す。</p>
<p id="bottom">毎日<span id="taberu-bottom">食べる</span>ことにした。</p>`;

const server = createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const profile = mkdtempSync(join(tmpdir(), "hd335-"));
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: profile,
  ignoreDefaultArgs: ["--hide-scrollbars"],
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const results = {};
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html#add-dictionaries`);
  const input = await settings.waitForSelector("#import-file");
  const files = ["jitendex-yomitan.zip", "JMnedict.zip", "bees-ultimate-kanji-dictionary.zip", "jiten.zip",
    "bees-ultimate-grammar-dictionary.zip", "KANJIDIC_english.zip"].map(f => join(DICTS, f));
  let importState = "";
  for (const file of files) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await settings.$eval("#import-state", e => { e.textContent = ""; });
      await (await settings.$("#import-file")).uploadFile(file);
      await settings.waitForFunction(() => /^Finished 1 of 1/.test((document.getElementById("import-state")?.textContent || "").trim()),
        { timeout: 600_000, polling: 250 });
      importState = await settings.$eval("#import-state", e => e.textContent.trim());
      if (importState.includes("1 imported")) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    console.log("import:", file, importState);
  }
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options, dictionaryState } = await chrome.storage.local.get(["options", "dictionaryState"]);
    const titles = dictionaryState.dictionaries.map(d => d.title);
    const jitendex = titles.find(t => t.startsWith("Jitendex"));
    const kanji = titles.find(t => t.startsWith("Bee's Ultimate Kanji"));
    const full = { popupTheme: "default", lookupMode: "hover", showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 2, compactDefinitionSummaryDictionary: jitendex,
      kanjiClickDictionary: { title: kanji, kind: "term" }, ...patch };
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: full });
    if (!reply.ok) throw new Error(`${reply.error} ${JSON.stringify(full)} ${JSON.stringify(titles)}`);
    return titles;
  }, patch);
  results.dictionaries = await writeOptions({});
  results.importState = importState;

  const tab = await browser.newPage();
  await tab.setViewport({ width: 1280, height: 900 });
  await tab.goto(pageUrl);

  const measure = () => tab.evaluate(async () => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    const popup = root?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]') ?? root?.querySelector(".gsm-hoshidicts-popup");
    if (!popup || popup.hidden) return null;
    // stable: text, scrollHeight and images
    let last = "";
    for (let i = 0; i < 60; i += 1) {
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
      const scroll = popup.querySelector(".gsm-hoshidicts-content-scroll");
      const sig = `${popup.textContent.length}|${scroll?.scrollHeight}|${[...popup.querySelectorAll("img")].every(i => i.complete)}`;
      if (sig === last) break;
      last = sig;
    }
    const p = popup.getBoundingClientRect();
    const rel = r => r && ({ top: +(r.top - p.top).toFixed(1), bottom: +(r.bottom - p.top).toFixed(1), height: +r.height.toFixed(1), width: +r.width.toFixed(1), left: +(r.left - p.left).toFixed(1) });
    const q = s => popup.querySelector(s);
    const chrome = q(".gsm-hoshidicts-result-chrome");
    const header = q(".gsm-hoshidicts-primary-header");
    const scroll = q(".gsm-hoshidicts-content-scroll");
    const sr = scroll.getBoundingClientRect();
    const expression = q(".gsm-hoshidicts-expression");
    const summary = q(".gsm-hoshidicts-compact-definition-summary");
    // text line boxes inside glossary content
    const lines = [];
    let firstTop = null;
    for (const content of popup.querySelectorAll(".gsm-hoshidicts-glossary-content")) {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          if (firstTop === null || r.top < firstTop) firstTop = r.top;
          lines.push([r.top, r.bottom, Boolean(node.parentElement.closest("rt"))]);
        }
      }
    }
    lines.sort((a, b) => a[0] - b[0]);
    const distinct = [];
    for (const [t, b] of lines) {
      const prev = distinct.at(-1);
      if (prev && t < prev[1] - 2) { prev[1] = Math.max(prev[1], b); continue; }
      distinct.push([t, b]);
    }
    const baseTops = [];
    for (const [t, b, rt] of lines) if (!rt && t >= sr.top - 0.5 && b <= sr.bottom + 0.5
      && !baseTops.some(x => Math.abs(x - t) < 4)) baseTops.push(t);
    const visibleBaseLines = baseTops.length;
    const visibleLines = distinct.filter(([t, b]) => t >= sr.top - 0.5 && b <= sr.bottom + 0.5).length;
    const targets = [...popup.querySelectorAll("button, [role=tab], summary, a[href]")]
      .filter(e => e.checkVisibility() && !e.closest(".gsm-hoshidicts-glossary-content")).map(e => { const r = e.getBoundingClientRect();
        return { cls: e.className || e.localName, w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })
      .filter(t => t.w > 0 && t.h > 0);
    return {
      popup: { width: p.width, height: p.height },
      toolbar: popup.dataset.hoshidictsToolbarPosition ?? popup.getAttribute("data-toolbar-position"),
      chrome: rel(chrome?.getBoundingClientRect()),
      chromeScroll: chrome ? { scrollHeight: chrome.scrollHeight, clientHeight: chrome.clientHeight, clientWidth: chrome.clientWidth } : null,
      header: rel(header?.getBoundingClientRect()),
      content: rel(sr),
      expression: rel(expression?.getBoundingClientRect()),
      summary: rel(summary?.getBoundingClientRect()),
      summaryBeside: summary && expression ? summary.getBoundingClientRect().top < expression.getBoundingClientRect().bottom : null,
      firstDefinition: firstTop === null ? null : +(firstTop - p.top).toFixed(1),
      visibleLines, visibleBaseLines,
      naturalContentHeight: scroll.scrollHeight,
      entries: [...popup.querySelectorAll(".gsm-hoshidicts-entry-header")].map(h => +h.getBoundingClientRect().height.toFixed(1)),
      minTarget: targets.reduce((m, t) => Math.min(m, t.w, t.h), Infinity),
      smallTargets: targets.filter(t => t.w < 24 || t.h < 24),
      headword: expression?.textContent,
      rect: { x: p.x, y: p.y, width: p.width, height: p.height },
    };
  });

  async function hover(selector, accept) {
    const box = await (await tab.$(selector)).boundingBox();
    for (let i = 0; i < 15; i += 1) {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
      try {
        await tab.waitForFunction(accept => {
          const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
          return popup && !popup.hidden && popup.querySelector(".gsm-hoshidicts-glossary-content")
            && (!accept || (() => { const e = popup.querySelector(".gsm-hoshidicts-expression")?.cloneNode(true); e?.querySelectorAll("rt").forEach(r => r.remove()); return e?.textContent === accept; })());
        }, { timeout: 3000 }, accept);
        return;
      } catch { /* retry */ }
    }
    throw new Error(`no popup for ${selector}`);
  }
  async function shot(name, rect) {
    await tab.screenshot({ path: join(OUT, `${name}.png`), clip: { x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 } });
  }
  async function hide() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(1270, 10);
    await tab.waitForFunction(() => { const p = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup"); return !p || p.hidden; }, { timeout: 5000 }).catch(() => {});
  }
  const cases = [["taberu", "食べる"], ["hikouki", "飛行機"], ["kaku", "格"], ["kakeru", "掛ける"], ["tabetakatta", "食べる"], ["youni", "ように"], ["taberu-bottom", "食べる"]];
  async function runCases(prefix) {
    for (const [id, accept] of cases) {
      await hover(`#${id}`, accept);
      const m = await measure();
      results[`${prefix}${id}`] = m;
      await shot(`${prefix}${id}`, m.rect);
      await hide();
    }
  }
  await runCases("");
  // kanji view: KANJIDIC as the click dictionary, click 食 in 食べる
  await settings.evaluate(async () => {
    const { options, dictionaryState } = await chrome.storage.local.get(["options", "dictionaryState"]);
    const title = dictionaryState.dictionaries.map(d => d.title).find(t => t.startsWith("KANJIDIC"));
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { kanjiClickDictionary: { title, kind: "kanji" } } });
    if (!reply.ok) throw new Error(reply.error);
  });
  await tab.reload();
  await hover("#taberu", "食べる");
  const link = await tab.evaluate(() => {
    const root = document.querySelector("hachidori-host").shadowRoot;
    const r = [...root.querySelectorAll(".gsm-hoshidicts-kanji-link")].find(l => l.textContent.includes("食")).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await tab.mouse.move(link.x, link.y);
  await tab.mouse.click(link.x, link.y);
  await tab.waitForFunction(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-glyph"), { timeout: 10000 });
  const kanji = await tab.evaluate(async () => {
    await new Promise(r => setTimeout(r, 500));
    const root = document.querySelector("hachidori-host").shadowRoot;
    const popups = [...root.querySelectorAll(".gsm-hoshidicts-popup")].filter(p => !p.hidden && p.querySelector(".gsm-hoshidicts-kanji-glyph"));
    const popup = popups.at(-1);
    const p = popup.getBoundingClientRect();
    const chrome = popup.querySelector(".gsm-hoshidicts-result-chrome");
    const header = popup.querySelector(".gsm-hoshidicts-primary-header");
    return { chrome: chrome && { height: chrome.getBoundingClientRect().height, scrollHeight: chrome.scrollHeight, clientHeight: chrome.clientHeight, clientWidth: chrome.clientWidth },
      header: header && { width: header.getBoundingClientRect().width, height: header.getBoundingClientRect().height },
      glyph: getComputedStyle(popup.querySelector(".gsm-hoshidicts-kanji-glyph")).fontSize,
      rect: { x: p.x, y: p.y, width: p.width, height: p.height } };
  });
  results.kanji = kanji;
  await shot("kanji", kanji.rect);
  await hide();

  // 320px wide popup
  await writeOptions({ popupWidthPx: 320 });
  await tab.reload();
  cases.splice(0, cases.length, ["taberu", "食べる"], ["kaku", "格"], ["tabetakatta", "食べる"]);
  await runCases("narrow-");
} finally {
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
