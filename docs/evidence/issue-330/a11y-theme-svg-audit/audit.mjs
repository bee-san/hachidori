// Audit: how dictionary images render in every Hachidori palette, in the
// enlarged hover preview, and under forced-colors / prefers-contrast emulation.
//
// Real extension, real Chrome for Testing, real dictionaries imported through
// Settings → Add dictionaries. Each (theme × term) cell hovers the term on a
// white page, waits for every structured-content image to load, and samples
// the rendered pixels: the card background around each image (mode of a ring
// outside the image box) and the "ink" (median of the 10% of pixels inside the
// box farthest in luminance from that background). WCAG 2.1 contrast ratio is
// computed between the two. A cell whose ink covers < 1% of the box is treated
// as invisible.
//
// Usage: node audit.mjs [--themes default,high-contrast,...] [--out DIR]
// Environment: HACHIDORI_CHROME, HACHIDORI_PUPPETEER, HACHIDORI_REPO, HACHIDORI_DICTS
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map(process.argv.slice(2).map((arg, index, all) => arg.startsWith("--") ? [arg.slice(2), all[index + 1]] : []).filter(pair => pair.length));
const REPO = process.env.HACHIDORI_REPO || resolve(process.cwd());
const EXTENSION = resolve(REPO, "extension");
const DICTS = process.env.HACHIDORI_DICTS || "/tmp/hachidori-a11y-dicts";
const OUT = resolve(args.get("out") || "/tmp/hachidori-a11y-audit/out");
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(homedir(), ".cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const PROFILE = `/tmp/hachidori-a11y-profile-${process.pid}`;

const { buildTitledZip } = await import(pathToFileURL(resolve(REPO, "test/make-fixture.mjs")).href);
const readerOptionsSource = readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8");
// The palette catalogue, read from the production registry rather than copied.
const themeGroups = [...readerOptionsSource.matchAll(/\{ label: "([^"]+)", ids: \[([^\]]+)\] \}/gu)]
  .map(([, label, ids]) => ({ label, ids: [...ids.matchAll(/"([^"]+)"/gu)].map(m => m[1]) }));
const ALL_THEMES = themeGroups.flatMap(group => group.ids.flatMap(id => id === "auto"
  ? [{ theme: "auto", scheme: "light", key: "auto (light OS)" }, { theme: "auto", scheme: "dark", key: "auto (dark OS)" }]
  : [{ theme: id, scheme: null, key: id }]));
const selectedThemes = args.has("themes")
  ? ALL_THEMES.filter(entry => args.get("themes").split(",").includes(entry.key) || args.get("themes").split(",").includes(entry.theme))
  : ALL_THEMES;

// ---------------------------------------------------------------- fixtures
// A kanji-dictionary-shaped fixture: the KanjiVG strokes of 格 (CC BY-SA 3.0,
// taken from Bee's Ultimate Kanji Dictionary's kanjivg/0683c.svg) drawn as a
// plain black-on-transparent stroke diagram the way 漢検漢字辞典 ships its 筆順
// strips, once tagged appearance:"monochrome" (the #322/#329 path), once
// untagged, once tagged but on an opaque white background (an opaque scan), and
// once drawn with stroke="currentColor" (an SVG that expects to inherit colour).
function kankenStyleFixture() {
  const bees = readFileSync(resolve(DICTS, "samples/bees-ultimate-kanji-dictionary/0683c.svg"), "utf8");
  const paths = [...bees.matchAll(/<path class="bee-stroke-ink"[^>]*? d="([^"]+)"\/>/gu)].map(m => m[1]);
  if (paths.length === 0) throw new Error("no KanjiVG strokes found in the Bee's 格 SVG sample");
  const strokes = colour => paths.map(d => `<path fill="none" stroke="${colour}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`).join("");
  const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 109 109" width="109" height="109">${body}</svg>`);
  const images = [
    { path: "media/kaku-mono.svg", bytes: svg(strokes("#000000")), appearance: "monochrome", label: "black-on-transparent, monochrome" },
    { path: "media/kaku-untagged.svg", bytes: svg(strokes("#000000")), appearance: undefined, label: "black-on-transparent, untagged" },
    { path: "media/kaku-opaque-mono.svg", bytes: svg(`<rect width="109" height="109" fill="#ffffff"/>${strokes("#000000")}`), appearance: "monochrome", label: "black-on-white, monochrome" },
    { path: "media/kaku-currentcolor.svg", bytes: svg(strokes("currentColor")), appearance: undefined, label: "currentColor strokes, untagged" },
  ];
  const title = "a11y-audit-kanken-style";
  const query = "筆順見本";
  const archive = buildTitledZip(title, { terms: [[query, "ひつじゅんみほん", "", "", 0, [
    { type: "structured-content", content: images.map(({ path, appearance, label }) => ({
      tag: "img", path, width: 96, height: 96, sizeUnits: "px", background: false, alt: label,
      ...(appearance ? { appearance } : {}),
    })) },
  ], 1, ""]], mediaEntries: images.map(({ path, bytes }) => [path, bytes]) });
  return { archive, images, query, title };
}

// The dictionaries under test: real archives plus the repo's own monochrome
// regression fixture (test/make-fixture.mjs monochromeImageFixture) and the
// kanji-style fixture above. `terms` are hovered on the page; each hover's
// popup may contain cards from several dictionaries.
const REAL = [
  { file: "bees-ultimate-kanji-dictionary.zip", title: "Bee's Ultimate Kanji Dictionary" },
  { file: "japanese-kanji-phonetic-families-yomitan.zip", title: "Japanese Kanji Phonetic Families" },
  { file: "japanese-kamon-yomitan.zip", title: "Japanese Kamon Encyclopedia (426 Illustrated Crests)" },
  { file: "japanese-yokai-encyclopedia-yomitan.zip", title: "Japanese Yōkai Encyclopedia (387, Illustrated)" },
  { file: "japanese-traditional-colors-yomitan.zip", title: "Japanese Traditional Colours (227 Exact Swatches)" },
];
const TERMS = [
  { id: "kaku", text: "格", note: "Bee's Ultimate Kanji Dictionary: KanjiVG stroke SVG (blue ink, white halo, transparent) + reading-chart PNG" },
  { id: "ken", text: "権", note: "Bee's + Kanji Phonetic Families (black-on-transparent PNG, untagged)" },
  { id: "tomoe", text: "三つ巴", note: "Kamon: black crest on opaque white WebP" },
  { id: "tengu", text: "天狗", note: "Yōkai: colour JPEG photo/illustration" },
  { id: "momoiro", text: "桃色", note: "Traditional colours: opaque colour swatch" },
  { id: "tanshoku", text: "単色画像", note: "repo fixture monochromeImageFixture(): black square tagged monochrome and auto" },
  { id: "hitsujun", text: "筆順見本", note: "kanji-style fixture: 格 strokes mono / untagged / opaque-mono / currentColor" },
];

// ------------------------------------------------------------------ colour
const srgbToLinear = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
const contrast = (a, b) => { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
const hex = rgb => `#${rgb.map(c => c.toString(16).padStart(2, "0")).join("")}`;

// In-page pixel analysis of a viewport screenshot. Each request names the
// image box, the card box it sits in and every other image box in that card:
// the background is the mode of the card's pixels outside all image boxes; the
// ink is the median of the box's pixels whose luminance distance from that
// background is at least 60% of the largest distance found (pure strokes, not
// their anti-aliased fringe). An image whose most common inner colour differs
// from the card and covers >= 40% of the box is treated as opaque: its own
// canvas is then the background its ink is measured against.
async function analyse(tab, png, requests) {
  return tab.evaluate(async ({ png, requests }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / window.innerWidth;
    const lin = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a, b) => { const [h, l] = a > b ? [a, b] : [b, a]; return (h + 0.05) / (l + 0.05); };
    const clampBox = box => ({ left: Math.max(0, box.left), top: Math.max(0, box.top), right: Math.min(window.innerWidth, box.right), bottom: Math.min(window.innerHeight, box.bottom) });
    const inside = (x, y, box) => x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    const pixelsIn = (box, stride = 1, exclude = []) => {
      const b = clampBox(box);
      const x0 = Math.round(b.left * scale), y0 = Math.round(b.top * scale), w = Math.round(b.right * scale) - x0, h = Math.round(b.bottom * scale) - y0;
      if (w <= 0 || h <= 0) return [];
      const data = context.getImageData(x0, y0, w, h).data;
      const out = [];
      for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) {
        const cssX = (x0 + x) / scale, cssY = (y0 + y) / scale;
        if (exclude.some(e => inside(cssX, cssY, e))) continue;
        const i = (y * w + x) * 4; out.push([data[i], data[i + 1], data[i + 2]]);
      }
      return out;
    };
    const mode = pixels => {
      const counts = new Map();
      for (const p of pixels) { const k = (p[0] << 16) | (p[1] << 8) | p[2]; counts.set(k, (counts.get(k) || 0) + 1); }
      let best = null, bestCount = -1;
      for (const [k, c] of counts) if (c > bestCount) { best = k; bestCount = c; }
      return best === null ? null : { rgb: [(best >> 16) & 255, (best >> 8) & 255, best & 255], share: bestCount / pixels.length };
    };
    return requests.map(({ box, card, others }) => {
      const inset = 1;
      const inner = pixelsIn({ left: box.left + inset, top: box.top + inset, right: box.right - inset, bottom: box.bottom - inset });
      const grow = b => ({ left: b.left - 2, top: b.top - 2, right: b.right + 2, bottom: b.bottom + 2 });
      const cardPixels = pixelsIn(card, 3, [grow(box), ...others.map(grow)]);
      const cardBackground = mode(cardPixels);
      if (!cardBackground || inner.length === 0) return { background: cardBackground?.rgb ?? null, ink: null, visible: 0, opaque: false };
      const innerMode = mode(inner);
      const opaque = innerMode.share >= 0.4 && ratio(lum(...innerMode.rgb), lum(...cardBackground.rgb)) >= 1.3;
      const base = opaque ? innerMode.rgb : cardBackground.rgb;
      const bl = lum(...base);
      const scored = inner.map(p => ({ p, d: Math.abs(lum(...p) - bl) }));
      let max = 0; for (const s of scored) if (s.d > max) max = s.d;
      const cluster = scored.filter(s => s.d >= 0.6 * max).map(s => s.p).sort((a, b) => lum(...a) - lum(...b));
      const ink = cluster[Math.floor(cluster.length / 2)];
      const visible = inner.filter(p => ratio(lum(...p), bl) >= 1.3).length / inner.length;
      return { background: base, cardBackground: cardBackground.rgb, cardBackgroundShare: cardBackground.share, opaque, innerMode: innerMode.rgb, innerModeShare: innerMode.share, ink, visible };
    });
  }, { png, requests });
}

// -------------------------------------------------------------------- page
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>a11y audit</title>
<style>body{margin:0;background:#ffffff;color:#111;font:20px/2.4 "Noto Sans CJK JP","Noto Serif CJK JP",sans-serif}
main{padding:24px 24px 0 24px}.row{display:block;height:44px}.probe{position:fixed;right:8px;bottom:8px;width:120px;height:60px}
#probe-canvas{background:Canvas;color:CanvasText;display:grid;place-items:center}
#probe-forced{forced-color-adjust:none;background:#123456}
</style></head><body><main>
${TERMS.map(term => `<div class="row"><span id="${term.id}" lang="ja">${term.text}</span>　テスト</div>`).join("\n")}
</main>
<div class="probe"><div id="probe-canvas">Aa</div><div id="probe-forced"></div></div>
</body></html>`;

// --------------------------------------------------------------------- run
function optionsWrite(settings, patch) {
  return settings.evaluate(async (patch) => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker", type: "hd_options_write", requestId: `a11y-${Date.now()}`,
      baseRevision: options?.revision ?? 0, options: patch,
    });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

// The reader host is an open shadow root on <hachidori-host>.
const popupState = () => {
  const host = document.querySelector("hachidori-host");
  const root = host?.shadowRoot;
  const popup = root?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]') ?? root?.querySelector(".gsm-hoshidicts-popup");
  if (!popup) return null;
  const rect = popup.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0 || popup.hidden) return null;
  const links = [...popup.querySelectorAll(".gloss-image-link")];
  const cardOf = link => link.closest("[data-hoshidicts-dictionary]")?.getAttribute("data-hoshidicts-dictionary")
    ?? (link.closest(".gsm-hoshidicts-compact-definition-image") ? "(compact summary)" : "?");
  return {
    theme: host.dataset.hoshidictsTheme ?? null,
    textColor: getComputedStyle(popup).getPropertyValue("--text-color").trim(),
    baseContent: getComputedStyle(host).getPropertyValue("--hoshidicts-palette-base-content").trim(),
    colorScheme: getComputedStyle(host).getPropertyValue("--hoshidicts-palette-color-scheme").trim(),
    popupColor: getComputedStyle(popup).color,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    headword: popup.querySelector(".gsm-hoshidicts-expression")?.textContent?.trim() ?? "",
    images: links.map(link => {
      const container = link.querySelector(".gloss-image-container");
      const img = link.querySelector("img.gloss-image");
      const background = link.querySelector(".gloss-image-background");
      const r = container?.getBoundingClientRect();
      const cardElement = link.closest("[data-hoshidicts-dictionary]") ?? link.closest(".gsm-hoshidicts-compact-definition-summary") ?? popup;
      const cr = cardElement.getBoundingClientRect();
      const sr = (link.closest(".gsm-hoshidicts-content-scroll") ?? popup).getBoundingClientRect();
      return {
        card: { left: Math.max(cr.left, sr.left, rect.left), top: Math.max(cr.top, sr.top, rect.top), right: Math.min(cr.right, sr.right, rect.right), bottom: Math.min(cr.bottom, sr.bottom, rect.bottom) },
        dictionary: cardOf(link), compact: !!link.closest(".gsm-hoshidicts-compact-definition-image"),
        alt: img?.alt ?? "", path: link.dataset.path, appearance: link.dataset.appearance, backgroundFlag: link.dataset.background,
        loadState: link.dataset.imageLoadState, collapsed: link.dataset.collapsed,
        natural: img ? [img.naturalWidth, img.naturalHeight] : null,
        imgVisibility: img ? getComputedStyle(img).visibility : null,
        maskLayerDisplay: background ? getComputedStyle(background).display : null,
        maskLayerBackground: background ? getComputedStyle(background).backgroundColor : null,
        maskImage: background ? getComputedStyle(background).maskImage.slice(0, 40) : null,
        rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null,
      };
    }),
  };
};

async function main() {
  for (const [name, path] of [["Chrome", CHROME], ["puppeteer-core", PUPPETEER], ["extension", EXTENSION], ["dictionaries", DICTS]]) {
    if (!existsSync(path)) throw new Error(`${name} not found at ${path}`);
  }
  mkdirSync(OUT, { recursive: true });
  mkdirSync(resolve(OUT, "fixtures"), { recursive: true });
  mkdirSync(resolve(OUT, "cells"), { recursive: true });
  const puppeteerModule = await import(pathToFileURL(PUPPETEER).href);
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const { monochromeImageFixture } = await import(pathToFileURL(resolve(REPO, "test/make-fixture.mjs")).href);
  const mono = monochromeImageFixture();
  const kanken = kankenStyleFixture();
  const fixtureFiles = [["dictionary-monochrome-image-fixture.zip", mono.archive], ["a11y-audit-kanken-style.zip", kanken.archive]]
    .map(([name, bytes]) => { const path = resolve(OUT, "fixtures", name); writeFileSync(path, bytes); return path; });

  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(PAGE_HTML); });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE,
    defaultViewport: { width: 1400, height: 1100, deviceScaleFactor: 1 },
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output", "--hide-scrollbars",
      "--lang=ja-JP", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const results = { chrome: await browser.version(), startedAt: new Date().toISOString(), themes: [], forced: [], previews: [], probes: {}, imports: null };
  try {
    const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30_000 });
    const id = new URL(worker.url()).host;
    // The first-run installer waits for "Start setup"; nothing is clicked, so no
    // catalogue archive is downloaded. Close the startup tab it opened.
    await sleep(1500);
    for (const page of await browser.pages()) if (page.url().includes("startup.html")) await page.close().catch(() => {});

    const settings = await browser.newPage();
    await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
    await settings.bringToFront();
    await settings.waitForFunction(() => /ready|no dictionaries|error/iu.test(document.querySelector("#engine-status")?.textContent || ""), { timeout: 90_000 });

    // Import through the production file input.
    await settings.evaluate(() => { document.querySelector('.settings-nav a[href="#dictionaries"]')?.click(); });
    await settings.evaluate(() => { document.querySelector('#library-navigation a[href="#add-dictionaries"]')?.click(); });
    await settings.waitForSelector("#import-file");
    const input = await settings.$("#import-file");
    const archives = [...REAL.map(entry => resolve(DICTS, entry.file)), ...fixtureFiles];
    await input.uploadFile(...archives);
    const importState = await settings.waitForFunction(count => {
      const text = (document.getElementById("import-state")?.textContent || "").trim();
      return text.startsWith(`Finished ${count} of ${count} archive`) ? text : false;
    }, { timeout: 600_000, polling: 500 }, archives.length).then(h => h.jsonValue());
    const importRows = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
      .map(row => ({ name: row.querySelector(".setup-dictionary-name")?.textContent, status: row.querySelector(".setup-dictionary-status")?.textContent })));
    results.imports = { importState, importRows };
    console.log(importState); for (const row of importRows) console.log(`  ${row.name}: ${row.status}`);
    await settings.waitForFunction(() => (document.querySelector("#engine-status")?.textContent || "").startsWith("Ready"), { timeout: 120_000 });

    // Large popup so images are inside the visible card; the popup is opaque at
    // 85% over a white page, as in the default configuration.
    await optionsWrite(settings, { lookupMode: "hover", popupWidthPx: 720, popupHeightPx: 900, showCompactDefinitionSummary: true, compactDefinitionSummaryDictionary: kanken.title, popupTheme: "default" });

    const tab = await browser.newPage();
    await tab.goto(pageUrl, { waitUntil: "load" });
    await tab.bringToFront();
    const cdp = await tab.createCDPSession();

    async function hideAll() {
      await tab.keyboard.press("Escape");
      await tab.mouse.move(1390, 1090);
      await tab.waitForFunction(() => !document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup")?.getBoundingClientRect().width, { timeout: 5000 }).catch(() => {});
    }

    async function hover(termId, expectTheme) {
      const box = await (await tab.$(`#${termId}`)).boundingBox();
      const x = box.x + Math.min(box.width * 0.2, 10), y = box.y + box.height / 2;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await tab.mouse.move(2, 2);
        await tab.mouse.move(x, y);
        const state = await tab.waitForFunction(({ expectTheme, popupState }) => {
          const read = new Function(`return (${popupState})()`);
          const state = read();
          if (!state) return false;
          if (expectTheme && state.theme !== expectTheme) return false;
          if (state.images.length === 0) return false;
          if (!state.images.every(image => image.loadState === "loaded" || image.loadState === "load-error")) return false;
          if (!state.images.every(image => image.loadState !== "loaded" || (image.natural && image.natural[0] > 0))) return false;
          return state;
        }, { timeout: 2500, polling: 50 }, { expectTheme, popupState: popupState.toString() }).then(h => h.jsonValue()).catch(() => null);
        if (state) return { state, point: { x, y } };
      }
      return null;
    }

    async function measure(termId, label, { theme, scheme, forced, contrastPref, savePng, previewFor }) {
      const cell = { term: termId, theme: theme ?? "auto", scheme, forced: forced ?? null, contrastPref: contrastPref ?? null, key: label, images: [] };
      await hideAll();
      const expectTheme = theme === "auto" ? (scheme === "dark" ? "dark" : "light") : theme;
      const hovered = await hover(termId, expectTheme);
      if (!hovered) { cell.error = "no popup with loaded images"; return cell; }
      const readState = () => tab.evaluate((popupState) => new Function(`return (${popupState})()`)(), popupState.toString());
      const scrollImageIntoView = index => tab.evaluate(({ popupState, index }) => {
        const root = document.querySelector("hachidori-host").shadowRoot;
        const links = [...root.querySelectorAll(".gsm-hoshidicts-popup .gloss-image-link")];
        // Bee's Ultimate Kanji Dictionary keeps its stroke-order diagram inside a
        // closed <details> ("Learning aids"); open every disclosure so each image
        // has a box to sample.
        for (const details of root.querySelectorAll(".gsm-hoshidicts-popup details")) details.open = true;
        links[index]?.querySelector(".gloss-image-container")?.scrollIntoView({ block: "center", inline: "nearest" });
        return new Function(`return (${popupState})()`)();
      }, { popupState: popupState.toString(), index }).then(state => state ?? fresh);
      let fresh = hovered.state;
      cell.popup = { theme: fresh.theme, textColor: fresh.textColor, baseContent: fresh.baseContent, colorScheme: fresh.colorScheme, popupColor: fresh.popupColor, headword: fresh.headword, rect: fresh.rect };
      const previewTargets = [];
      for (let index = 0; index < fresh.images.length; index += 1) {
        if (fresh.images[index].loadState !== "loaded") { cell.images.push({ ...fresh.images[index], verdict: "NOT-LOADED" }); continue; }
        fresh = await scrollImageIntoView(index);
        await sleep(160);
        fresh = (await readState()) ?? fresh;
        const image = fresh.images[index];
        if (!image?.rect || image.rect.width < 4 || image.rect.height < 4) { cell.images.push({ ...image, verdict: "NO-BOX" }); continue; }
        const visibleBox = { left: Math.max(image.rect.left, image.card.left), top: Math.max(image.rect.top, image.card.top), right: Math.min(image.rect.right, image.card.right), bottom: Math.min(image.rect.bottom, image.card.bottom) };
        if (visibleBox.right - visibleBox.left < 4 || visibleBox.bottom - visibleBox.top < 4) { cell.images.push({ ...image, verdict: "CLIPPED" }); continue; }
        const png = await tab.screenshot({ encoding: "base64" });
        const others = fresh.images.filter((other, j) => j !== index && other.rect).map(other => other.rect);
        const [a] = await analyse(tab, png, [{ box: visibleBox, card: image.card, others }]);
        const ratio = a.background && a.ink ? contrast(a.background, a.ink) : null;
        cell.images.push({ ...image, sample: a, contrast: ratio ? Number(ratio.toFixed(2)) : null,
          verdict: !a.ink || a.visible < 0.01 ? "INVISIBLE" : ratio >= 3 ? "PASS" : "FAIL" });
        if (previewFor && previewFor(image) && previewTargets.length === 0) previewTargets.push(index);
      }
      // Leave the stroke-order diagram (or else the first image) in view for the popup screenshot.
      const featured = fresh.images.findIndex(image => /stroke order|monochrome/u.test(image.alt || ""));
      await scrollImageIntoView(featured >= 0 ? featured : 0);
      await sleep(160);
      fresh = (await readState()) ?? fresh;
      if (savePng) {
        const clip = { x: Math.max(0, fresh.rect.left - 2), y: Math.max(0, fresh.rect.top - 2), width: Math.min(fresh.rect.width + 4, 1400 - fresh.rect.left), height: Math.min(fresh.rect.height + 4, 1100 - fresh.rect.top) };
        const file = resolve(OUT, "cells", `${label.replace(/[^a-z0-9-]+/giu, "_")}--${termId}.png`);
        await tab.screenshot({ path: file, clip });
        cell.screenshot = file;
      }
      if (previewFor && previewTargets.length) {
        // The popup occasionally closes while the tall images above are being
        // scrolled and captured; hover the term again so the preview has an owner.
        if (!(await readState())) { const again = await hover(termId, expectTheme); if (again) fresh = again.state; }
        await scrollImageIntoView(previewTargets[0]);
        await sleep(250);
        fresh = (await readState()) ?? fresh;
        const target = fresh.images[previewTargets[0]];
        if (target?.rect) {
          const box = { left: Math.max(target.rect.left, target.card.left), top: Math.max(target.rect.top, target.card.top), right: Math.min(target.rect.right, target.card.right), bottom: Math.min(target.rect.bottom, target.card.bottom) };
          const waitPreview = () => tab.waitForFunction(() => {
            const root = document.querySelector("hachidori-host")?.shadowRoot;
            const preview = root?.querySelector(".gsm-hoshidicts-image-hover-preview");
            const img = preview?.querySelector("img");
            if (!preview || !img || !img.complete || img.naturalWidth === 0) return false;
            const r = preview.getBoundingClientRect();
            const ir = img.getBoundingClientRect();
            const after = getComputedStyle(preview, "::after");
            return { appearance: preview.dataset.appearance, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
              imgRect: { left: ir.left, top: ir.top, right: ir.right, bottom: ir.bottom, width: ir.width, height: ir.height },
              imgVisibility: getComputedStyle(img).visibility, afterBackground: after.backgroundColor, afterMask: after.maskImage.slice(0, 30),
              frameBackground: getComputedStyle(preview).backgroundColor };
          }, { timeout: 3000, polling: 50 }).then(h => h.jsonValue()).catch(() => null);
          let preview = null;
          for (let attempt = 0; attempt < 3 && !preview; attempt += 1) {
            await tab.mouse.move((box.left + box.right) / 2 - 3 - attempt, (box.top + box.bottom) / 2 - 3);
            await sleep(120);
            await tab.mouse.move((box.left + box.right) / 2 + attempt, (box.top + box.bottom) / 2);
            preview = await waitPreview();
          }
          if (preview) {
            await sleep(300); // emerge animation
            const png2 = await tab.screenshot({ encoding: "base64" });
            // The image is object-fit: contain inside a large box; sample the central square where the glyph is drawn.
            const side = Math.min(preview.imgRect.width, preview.imgRect.height) * 0.9;
            const cx = (preview.imgRect.left + preview.imgRect.right) / 2, cy = (preview.imgRect.top + preview.imgRect.bottom) / 2;
            const box = { left: cx - side / 2, top: cy - side / 2, right: cx + side / 2, bottom: cy + side / 2, width: side, height: side };
            const [a] = await analyse(tab, png2, [{ box, card: preview.rect, others: [] }]);
            const ratio = a.background && a.ink ? contrast(a.background, a.ink) : null;
            cell.preview = { ...preview, target: { alt: target.alt, appearance: target.appearance, dictionary: target.dictionary }, sample: a, contrast: ratio ? Number(ratio.toFixed(2)) : null,
              verdict: !a.ink || a.visible < 0.01 ? "INVISIBLE" : ratio >= 3 ? "PASS" : "FAIL" };
            if (savePng) {
              // Full-viewport capture (a clipped capture resizes the viewport and
              // can disturb the preview); cropped to preview.rect afterwards.
              const file = resolve(OUT, "cells", `${label.replace(/[^a-z0-9-]+/giu, "_")}--${termId}--preview.png`);
              const timeline = [];
              for (const wait of [0, 400, 800]) {
                await sleep(wait);
                const shot = await tab.screenshot({ encoding: "base64", captureBeyondViewport: false });
                const [probe] = await analyse(tab, shot, [{ box, card: preview.rect, others: [] }]);
                timeline.push({ afterMs: wait, ink: probe.ink, visible: Number(probe.visible.toFixed(3)) });
                if (wait === 800) writeFileSync(file, Buffer.from(shot, "base64"));
              }
              cell.preview.screenshot = file;
              cell.preview.screenshotCrop = preview.rect;
              cell.preview.timeline = timeline;
            }
          } else {
            cell.preview = { error: "no preview appeared", diagnostics: await tab.evaluate(({ x, y }) => {
              const root = document.querySelector("hachidori-host")?.shadowRoot;
              const under = root?.elementFromPoint(x, y);
              return { children: [...(root?.children ?? [])].map(c => `${c.tagName}.${c.className}`), under: under ? `${under.tagName}.${under.className}` : null,
                popupRect: root?.querySelector(".gsm-hoshidicts-popup")?.getBoundingClientRect().toJSON() ?? null };
            }, { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }) };
          }
        }
      }
      return cell;
    }

    const PREVIEWS_ONLY = args.has("previews-only");
    const activeTerms = args.has("terms") ? TERMS.filter(term => args.get("terms").split(",").includes(term.id))
      : PREVIEWS_ONLY ? TERMS.filter(term => ["hitsujun", "tanshoku"].includes(term.id)) : TERMS;
    const SAVE_ALL = args.has("save-all");
    const SCREENSHOT_THEMES = new Set(["default", "dark", "light", "high-contrast", "solarized-light", "black", "synthwave", "auto (light OS)", "auto (dark OS)", "catppuccin-mocha", "cupcake", "wireframe"]);
    const PREVIEW_TERMS = new Set(["hitsujun", "ken", "tanshoku"]);

    // 1. Every palette (AUTO resolved both ways) × every term.
    for (const entry of selectedThemes) {
      const started = Date.now();
      await tab.emulateMediaFeatures(entry.scheme ? [{ name: "prefers-color-scheme", value: entry.scheme }] : []);
      await optionsWrite(settings, { popupTheme: entry.theme });
      await tab.bringToFront();
      const cells = [];
      for (const term of activeTerms) {
        const cell = await measure(term.id, entry.key, { theme: entry.theme, scheme: entry.scheme, savePng: SAVE_ALL || PREVIEWS_ONLY || SCREENSHOT_THEMES.has(entry.key),
          previewFor: !SAVE_ALL && PREVIEW_TERMS.has(term.id) ? image => image.appearance === "monochrome" || image.dictionary.includes("Phonetic") : null });
        cells.push(cell);
      }
      results.themes.push({ ...entry, cells });
      const summary = cells.flatMap(c => c.images.map(i => i.verdict));
      console.log(`${entry.key.padEnd(18)} ${((Date.now() - started) / 1000).toFixed(1)}s  ${summary.filter(v => v === "PASS").length} PASS / ${summary.filter(v => v === "FAIL").length} FAIL / ${summary.filter(v => v === "INVISIBLE").length} INVISIBLE`);
    }

    // 2. Forced colors and prefers-contrast emulation (Windows High Contrast /
    // "Increase contrast"), on the palettes a user in that situation would have.
    await tab.emulateMediaFeatures([]);
    const forcedRuns = [
      { forced: "active", scheme: "dark", theme: "default" }, { forced: "active", scheme: "dark", theme: "high-contrast" },
      { forced: "active", scheme: "light", theme: "light" }, { forced: "active", scheme: "dark", theme: "auto" },
      { forced: "none", contrastPref: "more", theme: "default" }, { forced: "none", contrastPref: "more", theme: "high-contrast" },
      // Modelled on the #319 report (card sampled #0c0c0c, Yomitan dark text #d4d4d4).
      // Custom CSS is an adopted sheet in the shadow root; :host([data-hoshidicts-theme])
      // matches the palette rules' specificity and wins by order.
      { forced: "none", theme: "default", customCss: ":host([data-hoshidicts-theme]) { --hoshidicts-palette-base-100: #0c0c0c; --hoshidicts-palette-base-200: #0c0c0c; --hoshidicts-palette-base-300: #1a1a1a; --hoshidicts-palette-base-content: #d4d4d4; }" },
    ].filter(run => !args.has("forced") || args.get("forced").split(",").some(part => (run.customCss ? "custom" : `${run.forced}${run.contrastPref ?? ""}${run.theme}`).includes(part)));
    for (const run of forcedRuns) {
      const features = [{ name: "forced-colors", value: run.forced }];
      if (run.scheme) features.push({ name: "prefers-color-scheme", value: run.scheme });
      if (run.contrastPref) features.push({ name: "prefers-contrast", value: run.contrastPref });
      await cdp.send("Emulation.setEmulatedMedia", { features });
      await optionsWrite(settings, { popupTheme: run.theme, customPopupCss: run.customCss ?? "" });
      await tab.bringToFront();
      const key = run.customCss ? `custom-css (#0c0c0c card, #d4d4d4 text) theme:${run.theme}`
        : `forced-colors:${run.forced}${run.contrastPref ? ` prefers-contrast:${run.contrastPref}` : ""} theme:${run.theme}${run.scheme ? ` os:${run.scheme}` : ""}`;
      const probe = await tab.evaluate(() => {
        const canvas = document.getElementById("probe-canvas"), forced = document.getElementById("probe-forced");
        return { canvas: getComputedStyle(canvas).backgroundColor, canvasText: getComputedStyle(canvas).color, forcedNone: getComputedStyle(forced).backgroundColor,
          forcedColorsActive: matchMedia("(forced-colors: active)").matches, prefersContrastMore: matchMedia("(prefers-contrast: more)").matches };
      });
      const cells = [];
      for (const term of activeTerms) {
        cells.push(await measure(term.id, key, { theme: run.theme, scheme: run.scheme, forced: run.forced, contrastPref: run.contrastPref, savePng: true,
          previewFor: PREVIEW_TERMS.has(term.id) ? image => image.appearance === "monochrome" || image.dictionary.includes("Phonetic") : null }));
      }
      results.forced.push({ ...run, key, probe, cells });
      const summary = cells.flatMap(c => c.images.map(i => i.verdict));
      console.log(`${key}  probe=${JSON.stringify(probe)}  ${summary.filter(v => v === "PASS").length} PASS / ${summary.filter(v => v === "FAIL").length} FAIL / ${summary.filter(v => v === "INVISIBLE").length} INVISIBLE`);
    }
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await optionsWrite(settings, { customPopupCss: "" });
  } finally {
    results.finishedAt = new Date().toISOString();
    writeFileSync(resolve(OUT, "results.json"), JSON.stringify(results, null, 2));
    await browser.close().catch(() => {});
    server.close();
    rmSync(PROFILE, { recursive: true, force: true });
  }
  console.log(`results: ${resolve(OUT, "results.json")}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
