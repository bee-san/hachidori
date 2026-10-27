// Interleaved Default-renderer microbenchmark for #604, after the #458
// render-bench: two pages, one per extension root, render the same lookup
// reply with the production view and reader.css. A sample is renderResults
// plus the style and layout it forces. Usage:
// node render-bench.mjs <mainExtension> <branchExtension> <iterations> [label]
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const REPO = "/local/home/skerraut/herd-synth3/clones/hachi-604";
const require = createRequire(resolve(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const CHROME = resolve(REPO, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const [mainRoot, branchRoot, iterationsArg = "300", label = "run"] = process.argv.slice(2);
const iterations = Number(iterationsArg);

// Ten results shaped like a Jitendex + JMdict + monolingual library: per result
// one structured Jitendex row with three tag-bank tags, five JMdict rows with
// two part-of-speech tags each, and two untagged monolingual rows.
const NBSP = "\u00a0";
const tag = (name, category, order, notes) => ({ name, category, order, score: 0, notes });
const jitendexTags = [tag(`priority${NBSP}form`, "frequent", 1, "high priority spelling"),
  tag(`special${NBSP}reading`, "expression", 1, "jukujikun"), tag("★", "popular", 2, "high priority entry")];
const posTags = [tag("n", "partOfSpeech", 0, "noun"), tag("adv", "partOfSpeech", 0, "adverb")];
const structured = index => [{ type: "structured-content", content: [{ tag: "ul", data: { content: "sense-groups" }, content: [
  { tag: "li", data: { content: "sense-group" }, content: [
    { tag: "span", data: { class: "tag" }, content: "noun" },
    { tag: "ol", content: [1, 2, 3].map(sense => ({ tag: "li", data: { content: "sense" }, content: [
      { tag: "ul", data: { content: "glossary" }, content: [{ tag: "li", content: `sense ${sense} of word ${index}` }] },
      { tag: "div", data: { content: "example-sentence" }, content: "例文です。" }] })) }] }] }] }];
const glossary = (dictionary, items, tags) => ({ dictionary, glossary: JSON.stringify(items),
  definitionTags: tags.map(entry => entry.name).join(" "), termTags: "", tags });
const results = Array.from({ length: 10 }, (_, index) => ({ matched: "今日", deinflected: "今日", trace: [],
  preprocessorSteps: 0, term: { expression: index ? `今日${index}` : "今日", reading: "きょう", rules: "", score: 10 - index,
    frequencies: [], pitches: [], glossaries: [
      glossary("Jitendex.org [2026-10-03]", structured(index), jitendexTags),
      ...[1, 2, 3, 4, 5].map(row => glossary("JMdict (English)", [`meaning ${row}`, `another ${row}`], posTags)),
      ...[1, 2].map(row => glossary("大辞林 第四版", [`語義${row}の説明。`], [])),
    ] } }));

const page = `<!doctype html><meta charset="utf-8"><p id="source">今日</p><div id="host"></div>
<script src="/reader-options.js"></script><script src="/external-links.js"></script>
<script src="/render/glossary.js"></script><script src="/render/popup.js"></script>
<script>
const host = document.getElementById("host");
const shadow = host.attachShadow({ mode: "open" });
const popup = document.createElement("div");
popup.className = "gsm-hoshidicts-popup";
popup.style.cssText = "position:relative;width:560px;height:600px";
window.ready = fetch("/render/reader.css").then(r => r.text()).then(css => {
  const sheet = new CSSStyleSheet(); sheet.replaceSync(css); shadow.adoptedStyleSheets = [sheet]; shadow.append(popup);
});
const appearance = HDPopup.createPopupAppearance(host);
const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
  appendExpressionRuby: HDGlossary.appendExpressionRuby, appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
  createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent, parseTagList: HDGlossary.parseTagList,
  onKanjiClick() {} });
window.sample = (results, theme) => {
  const options = { ...HDReaderOptions.normaliseOptions({}), popupTheme: theme };
  appearance.update(options);
  const source = document.getElementById("source");
  const start = performance.now();
  view.renderResults(results, { anchor: source, query: "今日", sentence: "今日", sourceElements: [source], matchOffset: 0 }, options);
  const rendered = performance.now();
  popup.getBoundingClientRect(); popup.offsetHeight;
  return [rendered - start, performance.now() - start,
    shadow.querySelectorAll(".gsm-hoshidicts-tag-definition").length, shadow.querySelectorAll("*").length];
};
</script>`;
const types = { ".js": "text/javascript", ".css": "text/css" };
const servers = [];
async function serve(root) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page); return; }
    try {
      const body = readFileSync(resolve(root, `.${url.pathname}`));
      response.writeHead(200, { "content-type": types[extname(url.pathname)] ?? "application/octet-stream" });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}
const quantile = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  env: { ...process.env, FONTCONFIG_FILE: "/tmp/hachi-604/fonts.conf" },
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
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
  const counts = {};
  for (const theme of ["default", "light"]) {
    for (const name of Object.keys(sides)) samples[`${name}/${theme}`] = { render: [], total: [] };
    for (let index = -20; index < iterations; index++) {
      for (const name of index % 2 ? ["main", "branch"] : ["branch", "main"]) {
        const [render, total, tags, nodes] = await sides[name].evaluate((results, theme) => window.sample(results, theme), results, theme);
        counts[name] = { tags, nodes };
        if (index >= 0) { samples[`${name}/${theme}`].render.push(render); samples[`${name}/${theme}`].total.push(total); }
      }
    }
  }
  console.log(`${label}: chrome ${await browser.version()}, ${iterations} samples per cell after 20 warmups, alternating sides`);
  console.log(`DOM after a render: ${JSON.stringify(counts)}`);
  console.log("| Side / palette | renderResults median (p90) / mean ms | + style and layout median (p90) / mean ms |");
  console.log("|---|---:|---:|");
  for (const [key, { render, total }] of Object.entries(samples)) {
    console.log(`| ${key} | ${median(render).toFixed(2)} (${quantile(render, 0.9).toFixed(2)}) / ${mean(render).toFixed(2)} | ${median(total).toFixed(2)} (${quantile(total, 0.9).toFixed(2)}) / ${mean(total).toFixed(2)} |`);
  }
  writeFileSync(`/tmp/hachi-604/render-bench-${label}.json`, JSON.stringify({ counts, samples }));
} finally {
  await browser.close();
  for (const server of servers) server.close();
}
