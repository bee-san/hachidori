// Evidence for issue #334 ("Kanji Atlas" theme proposal): screenshots of the REAL
// popup (content script + real dictionaries) in the pinned Chrome for Testing,
// default theme vs vendor/themes/kanji-atlas (theme.css + theme.js through the
// worktree-only host from host-prototype.patch). Not part of the suite.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> ATLAS_DICTS=<dir with the three zips> \
//     node capture-kanji-atlas.mjs
//
// Dictionaries (downloaded separately, never committed): KANJIDIC_english.zip and
// JMdict_english.zip from yomidevs/jmdict-yomitan, bees-ultimate-kanji-dictionary.zip
// from bee-san/bees-ultimate-kanji-dictionary.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const DICTS = process.env.ATLAS_DICTS;
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const ARCHIVES = ["KANJIDIC_english.zip", "JMdict_english.zip", "bees-ultimate-kanji-dictionary.zip"].map(name => resolve(DICTS, name));
const BEES = "Bee's Ultimate Kanji Dictionary";
const PROFILE = "/tmp/kanji-atlas-profile";
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

// A visual-novel-like page: dark scene, one line of dialogue in a text box.
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>kanji-atlas evidence</title>
<style>
  html, body { margin: 0; min-height: 100%; background: radial-gradient(ellipse at 30% 20%, #35405a 0, #171a24 60%, #0d0f16 100%); }
  .box { position: absolute; left: 40px; right: 40px; top: 470px; padding: 26px 40px; border: 1px solid rgba(255,255,255,.18);
         border-radius: 10px; background: rgba(8, 10, 18, .78); color: #f2efe6; font: 30px/1.9 "Noto Sans CJK JP", sans-serif; }
  .name { color: #e8c76a; font-size: 20px; margin-bottom: 4px; }
  span { display: inline-block; }
</style></head><body>
<div class="box"><div class="name">ミナ</div>
<p style="margin:0">朝ごはんを<span id="w-taberu">食べたかった</span>けど、<span id="w-toshokan">図書館</span>で<span id="w-benkyou">勉強</span>する時間だった。壁に絵を<span id="w-kakeru">掛ける</span>。</p>
</div></body></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const report = {
  chrome: null,
  extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  archives: ARCHIVES.map(path => ({ path, bytes: readFileSync(path).length })),
  shots: {}, console: [], contrast: null, reducedMotion: null, forcedColors: null,
};
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE, timeout: 180_000, protocolTimeout: 300_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;

  // ---- import the three dictionaries through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  settings.setDefaultNavigationTimeout(180_000); // a loaded CI box can take a while to start the engine
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  const importStarted = Date.now();
  await (await settings.$("#import-file")).uploadFile(...ARCHIVES);
  report.importState = await settings.waitForFunction(() => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith("Finished 3 of 3 archives") ? text : false;
  }, { timeout: 600_000, polling: 500 }).then(h => h.jsonValue());
  report.importMs = Date.now() - importStarted;
  report.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
  console.error(`[import] ${report.importState} in ${report.importMs} ms ${JSON.stringify(report.importDetail)}`);
  if (!report.importState.includes("3 imported")) throw new Error(`import failed: ${report.importState}`);

  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  // Plain hover opens the popup; the parchment is opaque, as the theme suggests.
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100 });

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.setDefaultNavigationTimeout(180_000);
  tab.on("console", message => {
    const line = `[${message.type()}] ${message.text()}`;
    if (/hachidori/iu.test(line)) report.console.push(line);
    console.error(`[tab console] ${line}`);
  });
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  await tab.setViewport({ width: 1000, height: 760, deviceScaleFactor: 2 });
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));
  const cdp = await tab.createCDPSession();

  const popupState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const style = node => node ? getComputedStyle(node) : null;
    const tiles = [...popup.querySelectorAll(".atlas-tile")].map(tile => ({
      char: tile.dataset.atlasChar, reading: tile.dataset.atlasReading ?? null, kind: tile.dataset.atlasKind,
      known: tile.dataset.atlasKnown, inferred: tile.dataset.atlasInferred ?? null,
      strokes: tile.querySelector(".atlas-ring")?.dataset.strokes ?? null,
      meta: tile.querySelector(".atlas-meta")?.textContent, gloss: tile.querySelector(".atlas-gloss")?.textContent,
    }));
    const card = popup.querySelector(".atlas-card");
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      showMore: !!popup.querySelector(".gsm-hoshidicts-show-more"),
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      chromeHidden: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      background: style(popup).backgroundColor,
      fontSize: style(popup).fontSize,
      title: popup.querySelector(".atlas-word")?.textContent ?? null,
      titleReading: popup.querySelector(".atlas-word-reading")?.textContent ?? null,
      titleFont: style(popup.querySelector(".atlas-word"))?.fontFamily ?? null,
      tiles,
      drawers: [...popup.querySelectorAll(".atlas-drawer-summary")].map(s => s.textContent.replace(/\s+/g, " ").trim()),
      card: card ? {
        char: card.dataset.atlasChar, strokes: card.querySelector(".atlas-ring")?.dataset.strokes ?? null,
        keyword: card.querySelector(".atlas-keyword")?.textContent ?? null,
        meanings: card.querySelector(".atlas-meanings")?.textContent ?? null,
        on: [...card.querySelectorAll('.atlas-yomi[data-kind="on"] .atlas-chip')].map(c => c.textContent),
        kun: [...card.querySelectorAll('.atlas-yomi[data-kind="kun"] .atlas-chip')].map(c => c.textContent),
        here: [...card.querySelectorAll('.atlas-chip[data-atlas-here="true"]')].map(c => c.textContent),
        badges: [...card.querySelectorAll(".atlas-badge")].map(b => b.textContent),
        met: [...card.querySelectorAll(".atlas-met-item")].map(i => i.textContent.replace(/\s+/g, " ").trim()),
        diagram: !!card.querySelector(".atlas-diagram img"),
        diagramLoaded: card.querySelector(".atlas-diagram .gloss-image-link")?.dataset.imageLoadState ?? null,
        source: card.querySelector(".atlas-source")?.textContent ?? null,
      } : null,
      glossSize: style(popup.querySelector(".gsm-hoshidicts-glossary-content"))?.fontSize ?? null,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  });
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popupState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)}`);
      await new Promise(r => setTimeout(r, 150));
    }
  };
  const settle = () => tab.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 450)))));

  async function hover(id, expect) {
    const box = await (await tab.$(`#${id}`)).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.12, box.y + box.height / 2);
      try { return await waitFor(expect, 2500); } catch (error) { console.error(`[hover ${id} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering #${id}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 700));
  }
  // Centre of a popup element after scrolling it into view; null unless the
  // point actually hits it (a scrolled-out element has a rect but no hit).
  const pointOf = selector => tab.evaluate(selector => {
    const host = document.querySelector("hachidori-host");
    const node = host.shadowRoot.querySelector(selector);
    if (!node) return null;
    node.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) return null;
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = host.shadowRoot.elementFromPoint(x, y);
    return hit && (hit === node || node.contains(hit)) ? { x, y } : null;
  }, selector);
  async function clickKanji(character, expect) {
    // Prefer the primary headword's link (top bar / atlas rail); a link in a
    // scrolled-out secondary entry has a rect but cannot be clicked.
    const point = await tab.waitForFunction(character => {
      const host = document.querySelector("hachidori-host");
      const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
      if (!popup || popup.hidden) return false;
      const box = popup.getBoundingClientRect();
      const inChrome = node => (node.closest(".gsm-hoshidicts-result-chrome") ? 1 : 0);
      const links = [...popup.querySelectorAll(".gsm-hoshidicts-kanji-link")].filter(b => b.textContent === character)
        .sort((a, b) => inChrome(b) - inChrome(a));
      for (const link of links) {
        const rect = link.getBoundingClientRect();
        if (rect.width === 0) continue;
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
        const hit = host.shadowRoot.elementFromPoint(x, y);
        if (hit && (hit === link || link.contains(hit))) return { x, y };
      }
      return false;
    }, { timeout: 10_000, polling: 100 }, character).then(handle => handle.jsonValue());
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
    return waitFor(expect);
  }
  async function back(expect) {
    await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back").click());
    const state = await waitFor(expect);
    // park the pointer on the title so no tile shows its hover state
    const title = await pointOf(".atlas-word");
    if (title) await tab.mouse.move(title.x, title.y);
    return state;
  }
  async function shot(name, { exact = false } = {}) {
    await settle();
    const fresh = await popupState();
    const pad = exact ? 0 : 28;
    const clip = { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad),
      width: Math.min(1000 - Math.max(0, fresh.rect.x - pad), fresh.rect.width + pad * 2),
      height: Math.min(760 - Math.max(0, fresh.rect.y - pad), fresh.rect.height + pad * 2) };
    // captureBeyondViewport overrides the device metrics, which the content
    // script sees as a resize and closes the popup; keep the viewport as it is.
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip, captureBeyondViewport: false });
    report.shots[name] = fresh;
    console.error(`[shot] ${name} ${JSON.stringify({ rect: fresh.rect, term: fresh.term, kanji: fresh.kanji, tiles: fresh.tiles.map(t => `${t.char}:${t.reading}:${t.kind}:${t.known}`), card: fresh.card?.char ?? null })}`);
    return fresh;
  }
  const allTilesSettled = s => s.term > 0 && s.tiles.length > 0 && !s.showMore;

  // ---- default theme, for comparison ----
  await hover("w-taberu", s => s.term > 0 && !s.showMore);
  await shot("default-term");
  await clickKanji("食", s => s.kanji > 0);
  await shot("default-kanji");
  await closePopup();
  await hover("w-kakeru", s => s.term > 0 && !s.showMore);
  await shot("default-long");
  await closePopup();

  // ---- Kanji Atlas ----
  // The prototype host applies no one-shot options, so the theme.yaml suggestions
  // (opacity 100, one column, toolbar at the top) are written here by hand.
  await writeOptions({ popupTheme: "kanji-atlas", popupToolbarPosition: "top", popupColumns: 1 });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "kanji-atlas", { timeout: 15_000 });
  await hover("w-taberu", allTilesSettled);
  await shot("atlas-term");
  await shot("screenshot", { exact: true }); // 560×420 @2× = the 1120×840 store screenshot
  // hover a tile: the ring turns vermilion and rotates half a segment
  const tilePoint = await pointOf(".atlas-tile .gsm-hoshidicts-kanji-link");
  await tab.mouse.move(tilePoint.x, tilePoint.y);
  await shot("atlas-term-hover");
  await tab.mouse.move(tilePoint.x, tilePoint.y + 200);
  // keyboard: Tab into the popup until the kanji button has focus
  const titlePoint = await pointOf(".atlas-word");
  await tab.mouse.click(titlePoint.x, titlePoint.y);
  let focused = null;
  for (let i = 0; i < 12 && focused !== "kanji-link"; i += 1) {
    await tab.keyboard.press("Tab");
    focused = await tab.evaluate(() => {
      const active = document.querySelector("hachidori-host").shadowRoot.activeElement;
      return active?.classList.contains("gsm-hoshidicts-kanji-link") ? "kanji-link" : (active?.className || active?.tagName || null);
    });
  }
  report.keyboardFocus = focused;
  await shot("atlas-term-focus");
  // the Bee's drawer under the tile it fed
  const drawerPoint = await pointOf(".atlas-drawer-summary");
  report.drawerPoint = drawerPoint;
  if (drawerPoint) {
    await tab.mouse.click(drawerPoint.x, drawerPoint.y);
    await settle();
    await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".atlas-drawer")
      .scrollIntoView({ block: "start" }));
    await shot("atlas-term-drawer");
    await tab.evaluate(() => { const s = document.querySelector("hachidori-host").shadowRoot; s.querySelector(".atlas-drawer").open = false; s.querySelector(".gsm-hoshidicts-content-scroll").scrollTop = 0; });
  }
  // the kanji view: the atlas card from KANJIDIC, arrived from 食べる
  await clickKanji("食", s => s.kanji > 0 && !!s.card);
  await shot("atlas-kanji");
  await back(allTilesSettled);
  report.shots["atlas-term-back"] = await popupState();
  await closePopup();

  // 図書館: 図 is known from Bee's card among the results, 書 and 館 are not
  await hover("w-toshokan", allTilesSettled);
  await shot("atlas-toshokan-before");
  await clickKanji("書", s => s.kanji > 0 && !!s.card);
  await shot("atlas-kanji-sho");
  await back(allTilesSettled);
  await shot("atlas-toshokan-after");
  await closePopup();

  // 勉強: two on-yomi; 強 is inferred from the run reading until its card is seen
  await hover("w-benkyou", allTilesSettled);
  await shot("atlas-benkyou-before");
  await clickKanji("強", s => s.kanji > 0 && !!s.card);
  await back(allTilesSettled);
  await shot("atlas-benkyou-after");
  await closePopup();

  // a long multi-sense entry
  await hover("w-kakeru", allTilesSettled);
  await shot("atlas-long");
  await closePopup();

  // Bee's as the clicked-kanji dictionary: the card gets the real stroke diagram
  await writeOptions({ kanjiClickDictionary: BEES });
  await new Promise(r => setTimeout(r, 800));
  await hover("w-taberu", allTilesSettled);
  await clickKanji("食", s => s.term > 0 && !!s.card && s.card.diagram);
  await tab.waitForFunction(() => document.querySelector("hachidori-host").shadowRoot
    .querySelector(".atlas-diagram .gloss-image-link")?.dataset.imageLoadState === "loaded", { timeout: 15_000 }).catch(() => {});
  await shot("atlas-kanji-bees");
  await closePopup();
  await writeOptions({ kanjiClickDictionary: "" });
  await new Promise(r => setTimeout(r, 800));

  // ---- accessibility probes ----
  // contrast: computed foreground/background pairs of the theme's own parts
  await hover("w-taberu", allTilesSettled);
  const contrastTerm = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host.shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    // Chrome serialises color-mix() results as color(srgb r g b) or rgb() with 0–1 floats.
    const parse = value => { const m = value.match(/[\d.]+/g).map(Number); if (m.length < 3) return null;
      const rgb = m.slice(0, 3); return value.startsWith("color(") || rgb.every(c => c <= 1 && !Number.isInteger(c)) ? rgb.map(c => c * 255) : rgb; };
    const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return Math.round((l1 + 0.05) / (l2 + 0.05) * 100) / 100; };
    const bgOf = node => { for (let n = node; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && getComputedStyle(n).backgroundColor !== "rgba(0, 0, 0, 0)") return c; } return null; };
    const pairs = {
      "title ink / plate": [".atlas-word"], "reading kana / plate": [".atlas-word-reading"],
      "kun reading (indigo) / plate": ['.atlas-tile[data-atlas-kind="kun"] .atlas-used-stem'],
      "on reading (vermilion) / plate": ['.atlas-tile[data-atlas-kind="on"] .atlas-used-stem'],
      "tile meta (gold) / plate": [".atlas-meta"], "tile gloss / plate": [".atlas-gloss"], "glyph / plate": [".atlas-ring > .gsm-hoshidicts-kanji-link"],
      "gloss text / paper": [".gsm-hoshidicts-glossary-content"], "dictionary label (gold) / paper": [".gsm-hoshidicts-glossary-card-title"],
      "definition tag / paper": [".gsm-hoshidicts-tag-definition"], "selected tab (vermilion) / paper": ['.gsm-hoshidicts-tab[aria-selected="true"]'],
      "drawer summary / paper": [".atlas-drawer-summary"], "deinflection / plate": [".gsm-hoshidicts-deinflection > summary"],
    };
    const out = {};
    for (const [label, [selector]] of Object.entries(pairs)) {
      const node = popup.querySelector(selector);
      if (!node) { out[label] = null; continue; }
      const fg = parse(getComputedStyle(node).color), bg = bgOf(node);
      out[label] = fg && bg ? { fg: getComputedStyle(node).color, bg: `rgb(${bg.join(", ")})`, ratio: ratio(fg, bg), fontSize: getComputedStyle(node).fontSize } : null;
    }
    return out;
  });
  await clickKanji("食", s => s.kanji > 0 && !!s.card);
  const contrastKanji = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host.shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    // Chrome serialises color-mix() results as color(srgb r g b) or rgb() with 0–1 floats.
    const parse = value => { const m = value.match(/[\d.]+/g).map(Number); if (m.length < 3) return null;
      const rgb = m.slice(0, 3); return value.startsWith("color(") || rgb.every(c => c <= 1 && !Number.isInteger(c)) ? rgb.map(c => c * 255) : rgb; };
    const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return Math.round((l1 + 0.05) / (l2 + 0.05) * 100) / 100; };
    const bgOf = node => { for (let n = node; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && getComputedStyle(n).backgroundColor !== "rgba(0, 0, 0, 0)") return c; } return null; };
    const pairs = {
      "keyword / paper": ".atlas-keyword", "meanings (faint) / paper": ".atlas-meanings",
      "音 label text / vermilion": '.atlas-yomi[data-kind="on"] .atlas-yomi-label', "訓 label text / indigo": '.atlas-yomi[data-kind="kun"] .atlas-yomi-label',
      "on chip (vermilion) / paper": '.atlas-yomi[data-kind="on"] .atlas-chip:not([data-atlas-here]) .atlas-chip-stem',
      "kun chip (indigo) / paper": '.atlas-yomi[data-kind="kun"] .atlas-chip:not([data-atlas-here]) .atlas-chip-stem',
      "arrived-from chip text / filled chip": '.atlas-chip[data-atlas-here="true"] .atlas-chip-stem',
      "badge (gold) / badge fill": ".atlas-badge", "source (faint) / paper": ".atlas-source",
      "met heading (gold) / paper": ".atlas-heading", "met word / paper": ".atlas-met-word", "met gloss / paper": ".atlas-met-gloss",
      "Back button / plate": ".gsm-hoshidicts-kanji-back", "Details summary (gold) / paper": ".gsm-hoshidicts-kanji-stats > summary",
    };
    const out = {};
    for (const [label, selector] of Object.entries(pairs)) {
      const node = popup.querySelector(selector);
      if (!node) { out[label] = null; continue; }
      const fg = parse(getComputedStyle(node).color), bg = bgOf(node);
      out[label] = fg && bg ? { fg: getComputedStyle(node).color, bg: `rgb(${bg.join(", ")})`, ratio: ratio(fg, bg), fontSize: getComputedStyle(node).fontSize } : null;
    }
    // the ring's tick colour is the ink; the ring sits on the paper
    const ring = popup.querySelector(".atlas-ring-large");
    out["ring ticks (ink) / paper"] = { fg: getComputedStyle(ring, "::before").backgroundImage.slice(0, 60), bg: getComputedStyle(popup).backgroundColor,
      ratio: ratio(parse(getComputedStyle(popup).color), parse(getComputedStyle(popup).backgroundColor)) };
    return out;
  });
  report.contrast = { term: contrastTerm, kanji: contrastKanji };

  // forced colours (Windows contrast themes), dark system palette: the ring and
  // the monochrome mask layer paint CanvasText (#336)
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: "dark" }] });
  await settle();
  report.forcedColors = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host.shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const ring = popup.querySelector(".atlas-ring-large");
    const before = getComputedStyle(ring, "::before");
    return { popupBackground: getComputedStyle(popup).backgroundColor, popupColor: getComputedStyle(popup).color,
      ringBackgroundImage: before.backgroundImage.slice(0, 120), ringForcedColorAdjust: before.forcedColorAdjust,
      glyphColor: getComputedStyle(popup.querySelector(".atlas-ring-large .gsm-hoshidicts-kanji-glyph")).color };
  });
  await shot("atlas-kanji-forced-colors");
  await back(allTilesSettled);
  await shot("atlas-term-forced-colors");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "none" }, { name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await settle();
  report.reducedMotion = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host.shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const tile = popup.querySelector(".atlas-tile");
    return { tileTransition: getComputedStyle(tile).transitionDuration,
      ringTransition: getComputedStyle(popup.querySelector(".atlas-ring"), "::before").transitionDuration };
  });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await closePopup();
} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ shots: Object.keys(report.shots), console: report.console, keyboardFocus: report.keyboardFocus,
  reducedMotion: report.reducedMotion, forcedColors: report.forcedColors }, null, 2));
