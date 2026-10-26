// Throwaway evidence script (not committed): the Design preview with definitions
// blurred until clicked, keyboard focus on the first Reveal definitions button,
// for each renderer and a few palettes. Usage: node shots.mjs <repo> <outdir>
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, out] = process.argv.slice(2).map(value => resolve(value));
mkdirSync(out, { recursive: true });
const root = join(repo, "extension");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const path = join(root, decodeURIComponent(new URL(request.url, "http://x").pathname));
  if (!path.startsWith(root) || !existsSync(path) || statSync(path).isDirectory()) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(response);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const { port } = server.address();
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox", "--force-device-scale-factor=1"] });
const cases = (process.env.CASES ?? "default,dark,light,high-contrast,girlypop,jl,bee,nazeka,plain").split(",");
const forced = process.env.FORCED === "1";
const results = [];
try {
  for (const theme of cases) {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 640 });
    if (forced) await page.emulateMediaFeatures([{ name: "forced-colors", value: "active" }]);
    await page.goto(`http://127.0.0.1:${port}/design-preview.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.HDDesignPreview && window.HDReaderOptions);
    await page.evaluate(theme => {
      const options = { ...HDReaderOptions.DEFAULT_OPTIONS, popupTheme: theme, showLookupCounts: true,
        definitionBlurCountEnabled: true, definitionBlurDirection: "below", definitionBlurThreshold: 5,
        definitionBlurReveal: "click", showCompactDefinitionSummary: true };
      HDDesignPreview.update(options, { revision: 1, dictionaries: [], groups: [] });
    }, theme);
    const host = await page.$("#preview-host");
    await page.waitForFunction(() => document.getElementById("preview-host").shadowRoot
      .querySelector("[data-definition-reveal]"), { timeout: 10_000 });
    // Keyboard modality, then Tab to the first reveal control.
    let focused = null;
    for (let step = 0; step < 40 && !focused?.reveal; step += 1) {
      await page.keyboard.press("Tab");
      focused = await page.evaluate(() => {
        const element = document.getElementById("preview-host").shadowRoot.activeElement;
        return element && { reveal: element.hasAttribute("data-definition-reveal"), tag: element.localName,
          className: element.className, label: element.getAttribute("aria-label"), role: element.getAttribute("role"),
          visible: element.matches(":focus-visible"), outline: getComputedStyle(element).outlineStyle };
      });
    }
    const rect = await page.evaluate(() => {
      const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      const box = popup.getBoundingClientRect();
      return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
    });
    const file = join(out, `${theme}${forced ? "-forced" : ""}.png`);
    await page.screenshot({ path: file, clip: rect });
    results.push({ theme, focused, file });
    void host;
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(results, null, 1));
