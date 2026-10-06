// One-off #501 evidence, not committed. Renders the production Default
// renderer, reader.css and icons.css with the real audio controller, plays
// the first result by hand and answers no-result, then a provider failure,
// and captures the headword in light, dark and emulated forced colours.
// Usage: node shots.mjs <repo> <label> <output dir>
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [repo, label, output] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const extension = resolve(repo, "extension");
const require = createRequire(resolve(process.env.HACHIDORI_TOOLING, "package.json"));
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, args: ["--no-sandbox"] });
// crypto.randomUUID needs a secure context, which about:blank is not.
const { createServer } = await import("node:http");
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#888}</style><p hidden>聞く</p><div id="host"></div>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const css = ["render/reader.css", "icons.css"].map(file => readFileSync(resolve(extension, file), "utf8")).join("\n");
const report = {};
for (const [palette, forced] of [["light", false], ["dark", false], ["dark", true]]) {
  for (const reply of ["no-result", "failure"]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 460, height: 260, deviceScaleFactor: 2 });
    if (forced) {
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" },
        { name: "forced-colors", value: "active" }] });
    }
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } }; });
    for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js", "audio-content.js"]) {
      await page.addScriptTag({ path: resolve(extension, file) });
    }
    report[`${palette}${forced ? "-forced" : ""}-${reply}`] = await page.evaluate(async (css, palette, reply) => {
      const host = document.querySelector("#host");
      const shadow = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      host.dataset.hoshidictsTheme = palette;
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:10px;top:10px;width:420px;max-height:220px";
      shadow.append(popup);
      let rendered;
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {},
        onResultsRendered: value => { rendered = value; } });
      view.renderResults([{ matched: "聞く", deinflected: "聞く", trace: [], preprocessorSteps: 0, term: {
        expression: "聞く", reading: "きく", rules: "v5", score: 0, frequencies: [], pitches: [],
        glossaries: [{ dictionary: "JMdict", definitionTags: "v5k", glossary: JSON.stringify(["to hear", "to listen"]) }],
      } }], { anchor: document.querySelector("p"), query: "聞く" }, {});
      const audio = HDAudio.createAudioController({ window, onMenuChange() {},
        send: async type => type === "hd_audio_play" ? (reply === "no-result" ? { ok: true, status: "no-result" }
          : { ok: false, error: "The recording returned HTTP 404." }) : { ok: true } });
      audio.update(HDReaderOptions.DEFAULT_OPTIONS);
      audio.bind(rendered.audioButtons, { owner: {}, popup, request: {}, isCurrent: () => true });
      const button = popup.querySelector(".gsm-hoshidicts-audio-button");
      button.click();
      await new Promise(done => setTimeout(done, 50));
      button.blur();
      return { state: button.dataset.state ?? null, label: button.getAttribute("aria-label"),
        status: [...popup.querySelectorAll(".gsm-hoshidicts-audio-status")].map(node => node.textContent) };
    }, css, palette, reply);
    await page.screenshot({ path: resolve(output, `${label}-${palette}${forced ? "-forced" : ""}-${reply}.png`) });
    await page.close();
  }
}
console.log(JSON.stringify({ label, report }, null, 2));
await browser.close();
server.close();
