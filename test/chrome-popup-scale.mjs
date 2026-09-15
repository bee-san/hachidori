import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const { config } = require("./package.json");
const root = resolve("extension");
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${request.url}`);
    const mime = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css"
      : path.endsWith(".svg") ? "image/svg+xml" : "text/html";
    response.setHeader("Content-Type", mime);
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await puppeteer.launch({ headless: true,
  executablePath: process.env.HACHIDORI_CHROME || computeExecutablePath({ cacheDir: resolve("test/tmp/browsers"),
    browser: Browser.CHROME, buildId: config.chrome }), args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(`http://127.0.0.1:${server.address().port}/design-preview.html`);
  await page.waitForFunction(() => !!window.HDDesignPreview);
  const update = scale => page.evaluate(scale => {
    HDDesignPreview.update({ ...HDReaderOptions.DEFAULT_OPTIONS, popupScalePercent: scale },
      { revision: 0, dictionaries: [], groups: [] });
  }, scale);
  const measure = () => page.evaluate(() => {
    const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
    const button = popup.querySelector(".gsm-hoshidicts-note-button");
    return { rect: popup.getBoundingClientRect().toJSON(), button: button.getBoundingClientRect().toJSON(),
      retained: !window.scaleCard || window.scaleCard === popup.querySelector(".gsm-hoshidicts-glossary-card") };
  });
  await update(100);
  await page.waitForFunction(() => document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-note-button"));
  await mkdir("test/tmp/popup-scale", { recursive: true });
  const baseline = await measure();
  await page.screenshot({ path: "test/tmp/popup-scale/before.png" });
  await page.evaluate(() => { window.scaleCard = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-glossary-card"); });
  for (const scale of [67, 75, 125, 100]) {
    await update(scale);
    const actual = await measure();
    assert.ok(Math.abs(actual.rect.width - 560 * scale / 100) < 1, JSON.stringify({ scale, actual }));
    assert.ok(Math.abs(actual.rect.height - 420 * scale / 100) < 1);
    assert.ok(Math.abs(actual.button.width - baseline.button.width * scale / 100) < 1);
    assert.ok(actual.retained);
    await page.mouse.click(actual.button.x + actual.button.width / 2, actual.button.y + actual.button.height / 2);
    assert.equal(await page.evaluate(() => document.getElementById("preview-host").shadowRoot.querySelector("form").hidden), false);
    await page.keyboard.press("Escape");
    if (scale === 75) await page.screenshot({ path: "test/tmp/popup-scale/after.png" });
    console.log(JSON.stringify({ scale, actual }));
  }
  await page.setViewport({ width: 320, height: 300 });
  await update(125);
  const narrow = await measure();
  assert.ok(narrow.rect.left >= 0 && narrow.rect.top >= 0 && narrow.rect.right <= 320 && narrow.rect.bottom <= 300);
  await page.setViewport({ width: 1000, height: 900 });
  for (const scale of [75, 100, 125, 200]) {
    await page.reload();
    await page.waitForFunction(() => !!window.HDDesignPreview);
    await update(scale);
    await page.waitForFunction(() => [...document.getElementById("preview-host").shadowRoot.querySelectorAll(".gloss-image-link img")]
      .some(image => image.complete && image.naturalWidth > 0));
    await page.evaluate(() => [...document.getElementById("preview-host").shadowRoot.querySelectorAll(".gloss-image-link")]
      .find(link => link.getBoundingClientRect().width > 0 && link.querySelector("img")?.complete)
      .dispatchEvent(new MouseEvent("mouseenter")));
    await page.waitForFunction(() => document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-image-hover-preview"));
    const preview = await page.evaluate(() => document.getElementById("preview-host").shadowRoot
      .querySelector(".gsm-hoshidicts-image-hover-preview").getBoundingClientRect().toJSON());
    assert.ok(preview.left >= 0 && preview.top >= 0 && preview.right <= 1000 && preview.bottom <= 900,
      JSON.stringify({ scale, preview }));
  }
  console.log("PASS: fractional popup scale, real pointer hit testing, retained cards, viewport containment");
} finally {
  await browser.close();
  server.close();
}
