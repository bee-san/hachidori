// Scratch (not committed): interleaved Default-renderer microbenchmark.
// Two pages, one per repository root, render the engine's real replies from
// benchmark/hover-popup.mjs with the production view and reader.css; each
// sample is renderResults plus the forced style and layout it causes.
// Usage: node render-bench.mjs <mainRoot> <branchRoot> <chrome> <puppeteer> <raw.json> <iterations>
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [mainRoot, branchRoot, chrome, puppeteerPath, rawPath, iterationsArg] = process.argv.slice(2);
const iterations = Number(iterationsArg ?? 300);
const puppeteer = await import(pathToFileURL(puppeteerPath).href);
// One reply per hovered word, as the engine sent it.
const replies = new Map();
for (const row of JSON.parse(readFileSync(rawPath, "utf8"))) {
  const results = row.replies?.at(-1)?.results;
  if (results?.length && !replies.has(row.expected)) replies.set(row.expected, results);
}
const words = [...replies.keys()];
const page = `<!doctype html><meta charset="utf-8"><p id="source">食べる</p><div id="host"></div>
<script src="/extension/reader-options.js"></script><script src="/extension/external-links.js"></script>
<script src="/extension/render/glossary.js"></script><script src="/extension/render/popup.js"></script>
<script>
const host = document.getElementById("host");
const shadow = host.attachShadow({ mode: "open" });
const popup = document.createElement("div");
popup.className = "gsm-hoshidicts-popup";
popup.style.cssText = "position:relative;width:520px;height:500px";
window.ready = fetch("/extension/render/reader.css").then(r => r.text()).then(css => {
  const sheet = new CSSStyleSheet(); sheet.replaceSync(css); shadow.adoptedStyleSheets = [sheet]; shadow.append(popup);
});
const appearance = HDPopup.createPopupAppearance(host);
const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
  appendExpressionRuby: HDGlossary.appendExpressionRuby, appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
  appendStructuredImage: HDGlossary.appendStructuredImage,
  createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent, parseTagList: HDGlossary.parseTagList,
  onKanjiClick() {} });
window.sample = (results, colours) => {
  const options = { ...HDReaderOptions.normaliseOptions({}), showCompactDefinitionSummary: true,
    compactDefinitionSummaryCount: 3, showPitchAccentColors: colours };
  appearance.update(options);
  const source = document.getElementById("source");
  const start = performance.now();
  view.renderResults(results, { anchor: source, query: results[0].matched, sentence: source.textContent,
    sourceElements: [source], matchOffset: 0 }, options);
  const rendered = performance.now();
  popup.getBoundingClientRect(); popup.offsetHeight; // force style and layout
  return [rendered - start, performance.now() - start];
};
</script>`;
const types = { ".js": "text/javascript", ".css": "text/css" };
const servers = [];
async function serve(root) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page); return; }
    try { const body = readFileSync(resolve(root, `.${url.pathname}`));
      response.writeHead(200, { "content-type": types[extname(url.pathname)] ?? "application/octet-stream" }); response.end(body); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const median = values => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
try {
  const sides = {};
  for (const [name, root] of [["main", mainRoot], ["branch", branchRoot]]) {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 900, height: 900 });
    await tab.goto(await serve(root));
    await tab.evaluate(() => window.ready);
    sides[name] = tab;
  }
  const samples = {};
  for (const colours of [false, true]) {
    for (const name of Object.keys(sides)) samples[`${name}/${colours ? "on" : "off"}`] = { render: [], total: [] };
    // 20 excluded warmups per side, then alternate sides sample by sample.
    for (let index = -20; index < iterations; index++) {
      for (const name of index % 2 ? ["main", "branch"] : ["branch", "main"]) {
        const results = replies.get(words[(index + 20) % words.length]);
        const [render, total] = await sides[name].evaluate((results, colours) => window.sample(results, colours), results, colours);
        if (index >= 0) { samples[`${name}/${colours ? "on" : "off"}`].render.push(render); samples[`${name}/${colours ? "on" : "off"}`].total.push(total); }
      }
    }
  }
  console.log(`chrome ${await browser.version()}, ${iterations} samples per cell, words ${words.join(" ")}`);
  console.log("| Side / colours | renderResults median ms | + style and layout median ms |");
  console.log("|---|---:|---:|");
  for (const [key, { render, total }] of Object.entries(samples)) {
    console.log(`| ${key} | ${median(render).toFixed(3)} | ${median(total).toFixed(3)} |`);
  }
} finally {
  await browser.close();
  for (const server of servers) server.close();
}
