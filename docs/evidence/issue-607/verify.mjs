// Evidence for #607, kept on its evidence branch rather than in the product.
// Imports a made-up term dictionary for 非常に and 非常, twelve frequency
// dictionaries ranking both and two pitch dictionaries through the committed
// threaded WASM bundle, looks 非常に and 非常 up, and renders those exact
// replies through the production Default renderer and stylesheet of two
// checkouts in real Chrome.
// Usage: HACHIDORI_CHROME=... node verify.mjs <after repo> <before extension dir> <output dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [afterRepo, beforeExtension, output] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const { buildTitledZip } = await import(pathToFileURL(resolve(afterRepo, "test/make-fixture.mjs")));
const { default: createHoshidicts } = await import(pathToFileURL(resolve(afterRepo, "extension/vendor/hoshidicts-threaded.mjs")));
const M = await createHoshidicts();
const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
const lastError = () => call("hdw_last_error", "string", [], []);
if (call("hdw_init_storage", "number", ["number"], [0]) !== 1) throw new Error(lastError());
M.FS.mkdir("/work");
const install = (name, options, kind) => {
  M.FS.writeFile(`/work/${name}.zip`, buildTitledZip(name, options));
  const report = JSON.parse(call("hdw_import", "string", ["string", "string", "number"], [`/work/${name}.zip`, "/dicts", 0]));
  if (!report.success) throw new Error(`${name}: ${report.error}`);
  if (call("hdw_add_dict", "number", ["string", "number", "number"], [`/dicts/${report.title}`, kind, 0]) !== 1) {
    throw new Error(`${name}: ${lastError()}`);
  }
  return report.title;
};
const word = ["非常", "ひじょう"];
const phrase = ["非常に", "ひじょうに"];
install("Sample terms", { terms: [
  [...phrase, "adv", "", 0, ["very; extremely"], 1, ""],
  [...word, "n", "", 0, ["emergency"], 2, ""],
] }, 0);
const frequencyTitles = [];
for (let index = 1; index <= 12; index += 1) {
  frequencyTitles.push(install(`Frequency ${String(index).padStart(2, "0")}`, { banks: false, termMeta: [
    [word[0], "freq", { reading: word[1], frequency: 1000 + 37 * index }],
    [phrase[0], "freq", { reading: phrase[1], frequency: 2000 + 41 * index }],
  ] }, 1));
}
const pitchTitles = [
  install("Pitch sample A", { banks: false, termMeta: [
    [word[0], "pitch", { reading: word[1], pitches: [{ position: 0 }] }],
    [phrase[0], "pitch", { reading: phrase[1], pitches: [{ position: 0 }] }],
  ] }, 2),
  install("Pitch sample B", { banks: false, termMeta: [
    [word[0], "pitch", { reading: word[1], pitches: [{ position: 0 }, { position: 1 }] }],
  ] }, 2),
];
const lookup = text => JSON.parse(call("hdw_lookup", "string", ["string", "number", "number", "string"], [text, 32, 16, ""]));
const replies = { [phrase[0]]: lookup(phrase[0]), [word[0]]: lookup(word[0]) };
for (const [text, reply] of Object.entries(replies)) {
  writeFileSync(resolve(output, `hd_lookup-${text}.json`), JSON.stringify(reply, null, 2));
  console.log(`engine ${text}:`, reply.results.map(({ term }) =>
    `${term.expression} freq ${term.frequencies.length} pitch [${term.pitches.map(group => group.dictionary)}]`).join("; "));
}

const require = createRequire(resolve(afterRepo, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, args: ["--no-sandbox"] });
const summary = {};
for (const [label, extension] of [["before", beforeExtension], ["after", resolve(afterRepo, "extension")]]) {
  for (const text of [phrase[0], word[0]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 500, height: 640, deviceScaleFactor: 2 });
    await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#888}</style>'
      + `<p hidden>${text}</p><div id="host"></div>`);
    for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: resolve(extension, file) });
    }
    const state = await page.evaluate((css, results, query) => {
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      // Tall enough for both entries in full, so nothing is scrolled away.
      popup.style.cssText = "left:10px;top:10px;width:480px;--gsm-hoshidicts-popup-height:620px";
      shadow.append(popup);
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {} });
      // The reader's defaults: pitch badges and names on, averages off. Show
      // more is already pressed, as a reader scrolling down to 非常 has.
      view.renderResults(results, { anchor: document.querySelector("p"), query },
        { showPitchAccentBadge: true, expandAll: true });
      return [...popup.querySelectorAll(".gsm-hoshidicts-entry")].map(entry => ({
        expression: entry.dataset.expression,
        frequencyTags: entry.querySelectorAll(".gsm-hoshidicts-tag-frequency").length,
        pitchGroups: [...entry.querySelectorAll(".pronunciation-group")].map(group =>
          `${group.dataset.dictionary} ${[...group.querySelectorAll(".pronunciation-downstep-notation")]
            .map(node => node.textContent).join(" ")}`),
      }));
    }, ["render/reader.css", "icons.css"].map(file => readFileSync(resolve(extension, file), "utf8")).join("\n"),
    replies[text].results, text);
    summary[`${label} ${text}`] = state;
    await page.screenshot({ path: resolve(output, `${label}-${text === word[0] ? "alone" : "later"}.png`) });
    await page.close();
  }
}
writeFileSync(resolve(output, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close();
