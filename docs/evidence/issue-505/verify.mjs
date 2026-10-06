// One-off evidence for #505, not committed. Imports a term dictionary for 答案,
// twelve frequency dictionaries and then the unchanged monogatari archive from
// #427 through the committed threaded WASM bundle, looks 答案 up, and renders
// that exact reply through the production Default renderer and stylesheet of
// two checkouts in real Chrome.
// Usage: node verify.mjs <after repo> <before repo> <output dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [afterRepo, beforeRepo, output] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const { buildTitledZip } = await import(pathToFileURL(resolve(afterRepo, "test/make-fixture.mjs")));
const { default: createHoshidicts } = await import(pathToFileURL(resolve(afterRepo, "extension/vendor/hoshidicts-threaded.mjs")));
const M = await createHoshidicts();
const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
const lastError = () => call("hdw_last_error", "string", [], []);
if (call("hdw_init_storage", "number", ["number"], [0]) !== 1) throw new Error(lastError());
M.FS.mkdir("/work");
const install = (name, bytes, kind) => {
  M.FS.writeFile(`/work/${name}.zip`, bytes);
  const report = JSON.parse(call("hdw_import", "string", ["string", "string", "number"], [`/work/${name}.zip`, "/dicts", 0]));
  if (!report.success) throw new Error(`${name}: ${report.error}`);
  if (call("hdw_add_dict", "number", ["string", "number", "number"], [`/dicts/${report.title}`, kind, 0]) !== 1) {
    throw new Error(`${name}: ${lastError()}`);
  }
  return report.title;
};
install("terms", buildTitledZip("答案-terms", { terms: [
  ["答案", "とうあん", "n", "", 0, ["answer (to an examination question)", "examination paper"], 1, ""],
] }), 0);
const titles = [];
for (let index = 1; index <= 12; index += 1) {
  titles.push(install(`frequency-${index}`, buildTitledZip(`Frequency ${String(index).padStart(2, "0")}`, {
    banks: false, termMeta: [["答案", "freq", 1000 * index + 7]],
  }), 1));
}
titles.push(install("monogatari", new Uint8Array(readFileSync(resolve(output, "..", "monogatari.zip"))), 1));
const reply = JSON.parse(call("hdw_lookup", "string", ["string", "number", "number", "string"], ["答案", 8, 16, ""]));
const groups = reply.results[0].term.frequencies;
console.log("engine groups:", groups.length, JSON.stringify(groups.at(-1)));
writeFileSync(resolve(output, "hd_lookup-答案.json"), JSON.stringify(reply, null, 2));

const require = createRequire(resolve(afterRepo, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, args: ["--no-sandbox"] });
const summary = {};
for (const [label, repo] of [["before", beforeRepo], ["after", afterRepo]]) {
  for (const averageFrequency of [false, true]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 520, height: 420, deviceScaleFactor: 2 });
    await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#888}</style><p hidden>答案</p><div id="host"></div>');
    for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: resolve(repo, "extension", file) });
    }
    const state = await page.evaluate((css, results, presentation, average) => {
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:10px;top:10px;width:480px;max-height:380px";
      shadow.append(popup);
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {} });
      view.renderResults(results, { anchor: document.querySelector("p"), query: "答案" },
        { showFrequencyDictionaryNames: true, averageFrequency: average, dictionaryPresentation: presentation });
      const tags = [...popup.querySelectorAll(".gsm-hoshidicts-primary-frequencies .gsm-hoshidicts-tag-frequency:not([data-frequency-average])")];
      return { tags: tags.length, monogatari: tags.find(tag => tag.dataset.dictionary === "monogatari")?.textContent ?? null,
        average: popup.querySelector("[data-frequency-average]")?.textContent ?? null };
    }, readFileSync(resolve(repo, "extension/render/reader.css"), "utf8"), reply.results,
    titles.map(title => ({ title, frequencyMode: "rank-based" })), averageFrequency);
    const name = `${label}${averageFrequency ? "-average" : ""}`;
    summary[name] = state;
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    await page.close();
  }
}
console.log(JSON.stringify(summary, null, 2));
await browser.close();
