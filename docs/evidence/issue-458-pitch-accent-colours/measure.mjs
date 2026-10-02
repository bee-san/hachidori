// Scratch evidence script for #458 (run from the repository root). Renders the
// production popup view (HDPopup.createPopupView + reader.css in a shadow root,
// as content.js does) in headless Chrome for Testing, measures Chrome's
// computed colours in every palette, and writes palette screenshots.
// Usage: node measure.mjs <repo> <chrome> <outdir>
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const [repo, chrome, out] = process.argv.slice(2);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
mkdirSync(out, { recursive: true });

const page = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;font:16px sans-serif;background:var(--page,#fff)} .host{display:block}
 p.source{position:absolute;left:-999px}</style>
<p class="source" id="source">道具</p><div id="host" class="host"></div>
<script src="/extension/reader-options.js"></script>
<script src="/extension/external-links.js"></script>
<script src="/extension/render/glossary.js"></script>
<script src="/extension/render/popup.js"></script>
<script>
const host = document.getElementById("host");
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("link");
style.rel = "stylesheet"; style.href = "/extension/render/reader.css";
const icons = document.createElement("link");
icons.rel = "stylesheet"; icons.href = "/extension/icons.css";
shadow.append(style, icons);
const popup = document.createElement("div");
popup.className = "gsm-hoshidicts-popup";
popup.style.cssText = "position:relative;left:0;top:0;width:560px;height:860px";
shadow.append(popup);
const appearance = HDPopup.createPopupAppearance(host);
const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
  appendExpressionRuby: HDGlossary.appendExpressionRuby, appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
  createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent, parseTagList: HDGlossary.parseTagList,
  onKanjiClick() {} });
const entry = (position, pattern = "") => ({ position, pattern, nasal: [], devoice: [] });
const term = (expression, reading, position, rules = "") => ({ matched: expression, deinflected: expression, trace: [],
  term: { expression, reading, rules, frequencies: [], score: 0,
    pitches: [{ dictionary: "NHK", pitches: [typeof position === "object" ? position : entry(position)], transcriptions: [] }],
    glossaries: [{ dictionary: "Jitendex", glossary: JSON.stringify(["gloss"]), definitionTags: "", termTags: "" }] } });
window.SAMPLES = [term("自然", "しぜん", 0), term("人生", "じんせい", 1), term("弱点", "じゃくてん", 3),
  term("道具", "どうぐ", 3), term("驚く", "おどろく", 3, "v5")];
window.render = (options) => {
  const merged = { ...HDReaderOptions.normaliseOptions({}), showPitchAccentGraph: true, ...options };
  appearance.update(merged);
  view.renderResults(window.SAMPLES, { anchor: document.getElementById("source"), query: "道具",
    sentence: "道具", sourceElements: [document.getElementById("source")], matchOffset: 0 },
    { ...merged, initialResultCount: 5, expandAll: true, definitionBlurState: options.definitionBlurState });
};
</script>`;

const types = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://x");
  if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page); return; }
  try {
    const body = readFileSync(resolve(repo, `.${url.pathname}`));
    response.writeHead(200, { "content-type": types[extname(url.pathname)] ?? "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const results = { chrome: await browser.version(), palettes: {} };
try {
  const tab = await browser.newPage();
  await tab.setViewport({ width: 600, height: 900, deviceScaleFactor: 2 });
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  await tab.waitForFunction(() => window.render && getComputedStyle(document.getElementById("host").shadowRoot
    .querySelector(".gsm-hoshidicts-popup")).position === "relative");
  const themes = await tab.evaluate(() => HDReaderOptions.POPUP_THEME_GROUPS.flatMap(g => g.themes.map(t => t.id))
    .filter(id => id !== "auto"));
  const measure = () => tab.evaluate(() => {
    const root = document.getElementById("host").shadowRoot;
    const canvas = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    const rgb = value => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(v => v.toString(16).padStart(2, "0")).join(""); };
    return [...root.querySelectorAll(".gsm-hoshidicts-entry")].map((entry, index) => {
      const header = index === 0 ? root.querySelector(".gsm-hoshidicts-primary-header") : entry.querySelector(".gsm-hoshidicts-entry-header");
      const expression = header.querySelector(".gsm-hoshidicts-expression");
      const kanji = expression.querySelector(".gsm-hoshidicts-kanji-link");
      const high = expression.querySelector('.gsm-hoshidicts-pitch-mora[data-pitch-level="high"]');
      const contour = expression.querySelector(".gsm-hoshidicts-pitch-contour");
      const badge = entry.querySelector(".pronunciation");
      const line = badge?.querySelector(".pronunciation-mora-line");
      const tag = entry.querySelector(".gsm-hoshidicts-pitch-source");
      const overline = expression.querySelector('.pronunciation-mora[data-pitch="high"] > .pronunciation-mora-line');
      const graph = badge?.querySelector(".pronunciation-graph-line");
      return { category: expression.dataset.pitchCategory, badgeCategory: badge?.dataset.pitchCategory,
        headword: rgb(getComputedStyle(expression).color), kanji: rgb(getComputedStyle(kanji).color),
        kanjiUnderline: rgb(getComputedStyle(kanji).borderBottomColor),
        contourLine: high ? rgb(getComputedStyle(high).borderTopColor) : null,
        reading: contour ? rgb(getComputedStyle(contour).color) : null,
        badgeLine: line ? rgb(getComputedStyle(line).borderTopColor) : null,
        badgeText: badge ? rgb(getComputedStyle(badge).color) : null,
        tagText: tag ? rgb(getComputedStyle(tag).color) : null,
        overlineLine: overline ? rgb(getComputedStyle(overline).borderTopColor) : null,
        graphStroke: graph ? rgb(getComputedStyle(graph).stroke) : null };
    });
  });
  const setTheme = theme => tab.evaluate(theme => { document.getElementById("host").dataset.hoshidictsTheme = theme; }, theme);
  for (const theme of themes) {
    await tab.evaluate(() => window.render({ showPitchAccentColors: true, popupTheme: "default" }));
    await setTheme(theme);
    const on = await measure();
    await tab.evaluate(() => window.render({ showPitchAccentColors: false, popupTheme: "default" }));
    await setTheme(theme);
    const off = await measure();
    await tab.evaluate(() => window.render({ showPitchAccentColors: true, popupTheme: "default", definitionBlurState: "blurred" }));
    await setTheme(theme);
    const blurred = await measure();
    await tab.evaluate(() => window.render({ showPitchAccentColors: true, popupTheme: "default", pitchAccentFuriganaStyle: "overline" }));
    await setTheme(theme);
    const overlineOn = await measure();
    await tab.evaluate(() => window.render({ showPitchAccentColors: false, popupTheme: "default", pitchAccentFuriganaStyle: "overline" }));
    await setTheme(theme);
    const overlineOff = await measure();
    results.palettes[theme] = { on, off, blurred, overlineOn, overlineOff };
  }
  // Keyboard focus on a coloured kanji: outline style and width.
  await tab.evaluate(() => window.render({ showPitchAccentColors: true, popupTheme: "default" }));
  await setTheme("default");
  const focusTarget = await tab.evaluateHandle(() => document.getElementById("host").shadowRoot
    .querySelector(".gsm-hoshidicts-kanji-link"));
  await tab.keyboard.press("Tab");
  await focusTarget.focus();
  results.focusOn = await tab.evaluate(element => { const s = getComputedStyle(element);
    return { focusVisible: element.matches(":focus-visible"), outline: `${s.outlineStyle} ${s.outlineWidth}` }; }, focusTarget);
  await tab.evaluate(() => window.render({ showPitchAccentColors: false, popupTheme: "default" }));
  await setTheme("default");
  const focusOff = await tab.evaluateHandle(() => document.getElementById("host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-link"));
  await focusOff.focus();
  results.focusOff = await tab.evaluate(element => { const s = getComputedStyle(element);
    return { focusVisible: element.matches(":focus-visible"), outline: `${s.outlineStyle} ${s.outlineWidth}` }; }, focusOff);
  await tab.evaluate(() => document.activeElement?.blur());
  // Forced colours: coloured and uncoloured headwords compute the same system colour.
  const cdp = await tab.createCDPSession();
  results.forced = {};
  for (const scheme of ["dark", "light"]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" },
      { name: "prefers-color-scheme", value: scheme }] });
    await tab.evaluate(() => window.render({ showPitchAccentColors: true, popupTheme: "default" }));
    await setTheme("default");
    const on = await measure();
    await tab.evaluate(() => window.render({ showPitchAccentColors: false, popupTheme: "default" }));
    await setTheme("default");
    const off = await measure();
    results.forced[scheme] = { on, off };
  }
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  // Screenshots: the popup only, each palette's switch off beside on.
  const capture = async (options, theme, page) => {
    await tab.evaluate(page => document.body.style.setProperty("--page", page), page);
    await tab.evaluate(options => window.render(options), { popupTheme: "default", showPitchAccentGraph: true, ...options });
    await setTheme(theme);
    await new Promise(done => setTimeout(done, 200));
    const box = await tab.evaluate(() => { const r = document.getElementById("host").shadowRoot
      .querySelector(".gsm-hoshidicts-popup").getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; });
    return tab.screenshot({ clip: box, encoding: "base64" });
  };
  const compose = async (name, tiles) => {
    const png = await tab.evaluate(async tiles => {
      const images = await Promise.all(tiles.map(async tile => { const image = new Image();
        image.src = `data:image/png;base64,${tile.png}`; await image.decode(); return image; }));
      const gap = 24, label = 44;
      const canvas = document.createElement("canvas");
      canvas.width = images.reduce((sum, image) => sum + image.naturalWidth, 0) + gap * (images.length + 1);
      canvas.height = Math.max(...images.map(image => image.naturalHeight)) + label + gap;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#111111"; context.font = "28px sans-serif";
      let x = gap;
      images.forEach((image, index) => { context.fillText(tiles[index].label, x, 32); context.drawImage(image, x, label); x += image.naturalWidth + gap; });
      return canvas.toDataURL("image/png").split(",")[1];
    }, tiles);
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(png, "base64"));
  };
  for (const [theme, page] of [["default", "#1b1b1f"], ["light", "#ffffff"], ["dracula", "#111111"], ["retro", "#ffffff"], ["aqua", "#000000"]]) {
    await compose(`${theme}-off-on`, [
      { label: `${theme}: switch off (today)`, png: await capture({ showPitchAccentColors: false }, theme, page) },
      { label: `${theme}: Show pitch accent colours on`, png: await capture({ showPitchAccentColors: true }, theme, page) }]);
  }
  await compose("overline-on", [
    { label: "default: Overline style, colours on", png: await capture({ showPitchAccentColors: true, pitchAccentFuriganaStyle: "overline" }, "default", "#1b1b1f") },
    { label: "light: Overline style, colours on", png: await capture({ showPitchAccentColors: true, pitchAccentFuriganaStyle: "overline" }, "light", "#ffffff") }]);
  await compose("blur-and-no-contour", [
    { label: "colours on, definitions blurred", png: await capture({ showPitchAccentColors: true, definitionBlurState: "blurred" }, "default", "#1b1b1f") },
    { label: "colours on, Show pitch in furigana off", png: await capture({ showPitchAccentColors: true, showPitchAccentFurigana: false }, "default", "#1b1b1f") }]);
  const forcedTiles = [];
  for (const scheme of ["dark", "light"]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" },
      { name: "prefers-color-scheme", value: scheme }] });
    forcedTiles.push({ label: `forced colours ${scheme}: off`, png: await capture({ showPitchAccentColors: false }, "default", "#ffffff") });
    forcedTiles.push({ label: `forced colours ${scheme}: on`, png: await capture({ showPitchAccentColors: true }, "default", "#ffffff") });
  }
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await compose("forced-colors-off-on", forcedTiles);
} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(out, "measurements.json"), JSON.stringify(results, null, 1));
console.log("chrome", results.chrome);
