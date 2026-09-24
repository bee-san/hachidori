// Controlled reproduction of the forced-colors behaviour of the #329 mask layer,
// and of candidate fixes, on a plain page (no extension) in Chrome for Testing.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const PUPPETEER = resolve(homedir(), ".cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const puppeteer = (await import(pathToFileURL(PUPPETEER).href)).default;
const OUT = "/tmp/hachidori-a11y-audit/controlled"; mkdirSync(OUT, { recursive: true });
const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80"/></svg>');
const image = `url("data:image/svg+xml,${svg}")`;
// Each case: the card (#272630 default palette, --text-color #e8e5eb) with a 64px
// box drawn by the given CSS. The centre pixel is sampled.
const cases = {
  "A current #329 rule: background var(--text-color) + mask": `.layer{background:var(--text-color);mask:var(--image) center/contain no-repeat}`,
  "B + forced-color-adjust:none": `.layer{background:var(--text-color);mask:var(--image) center/contain no-repeat;forced-color-adjust:none}`,
  "C forced-color-adjust:none + @media(forced-colors:active){background:CanvasText}": `.layer{background:var(--text-color);mask:var(--image) center/contain no-repeat;forced-color-adjust:none}@media (forced-colors:active){.layer{background:CanvasText}}`,
  "D background:currentColor + forced-color-adjust:none": `.layer{background:currentColor;mask:var(--image) center/contain no-repeat;forced-color-adjust:none}`,
  "E raw <img> black-on-transparent (untagged)": `IMG`,
  "F raw <img> with filter: invert(1) (a filter-based approach)": `IMG_FILTER:filter:invert(1)`,
  "G Yomitan filter chain on <img>": `IMG_FILTER:--shadow-settings:0 0 0.01px var(--text-color);filter:grayscale(1) opacity(0.5) drop-shadow(var(--shadow-settings)) drop-shadow(var(--shadow-settings)) saturate(1000%) brightness(1000%)`,
};
const html = (css, mode) => {
  const isImg = css.startsWith("IMG");
  const imgFilter = css.startsWith("IMG_FILTER:") ? css.slice("IMG_FILTER:".length) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#fff}
  .card{position:absolute;left:20px;top:20px;width:200px;height:200px;background:#272630;color:#e8e5eb;--text-color:#e8e5eb;--image:${image}}
  .box{position:absolute;left:68px;top:68px;width:64px;height:64px}
  .layer{position:absolute;inset:0}
  img{position:absolute;inset:0;width:100%;height:100%;${imgFilter}}
  ${isImg ? "" : css}
  </style></head><body><div class="card"><div class="box">${isImg ? `<img src='data:image/svg+xml,${svg}'>` : `<span class="layer"></span>`}</div></div></body></html>`;
};
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"], defaultViewport: { width: 300, height: 300 } });
try {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  const lin = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contrast = (a, b) => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return ((h + 0.05) / (l + 0.05)).toFixed(2); };
  const modes = [
    { name: "normal", features: [] },
    { name: "forced-colors:active (dark: Canvas #000 / CanvasText #fff)", features: [{ name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: "dark" }] },
    { name: "forced-colors:active (light: Canvas #fff / CanvasText #000)", features: [{ name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: "light" }] },
  ];
  const rows = [];
  for (const mode of modes) {
    for (const [name, css] of Object.entries(cases)) {
      await page.setContent(html(css, mode.name), { waitUntil: "load" });
      await cdp.send("Emulation.setEmulatedMedia", { features: mode.features });
      await new Promise(d => setTimeout(d, 120));
      const computed = await page.evaluate(() => {
        const layer = document.querySelector(".layer") || document.querySelector("img");
        const s = getComputedStyle(layer);
        return { background: s.backgroundColor, color: getComputedStyle(document.querySelector(".card")).color, cardBackground: getComputedStyle(document.querySelector(".card")).backgroundColor, adjust: s.forcedColorAdjust, filter: s.filter.slice(0, 40) };
      });
      const png = await page.screenshot({ encoding: "base64" });
      const [centre, cardPixel] = await page.evaluate(async png => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height); const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
        const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
        return [at(120, 120), at(40, 40)];
      }, png);
      const file = `${OUT}/${mode.name.replace(/[^a-z0-9]+/giu, "_")}--${name.slice(0, 1)}.png`;
      await page.screenshot({ path: file, clip: { x: 20, y: 20, width: 200, height: 200 } });
      rows.push({ mode: mode.name, case: name, centre, cardPixel, contrast: contrast(centre, cardPixel), computed });
      console.log(`${mode.name.padEnd(62)} ${name.padEnd(75)} glyph=${JSON.stringify(centre)} card=${JSON.stringify(cardPixel)} ratio=${contrast(centre, cardPixel)} layerBg=${computed.background} adjust=${computed.adjust}`);
    }
  }
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${OUT}/results.json`, JSON.stringify(rows, null, 2));
} finally { await browser.close(); }
