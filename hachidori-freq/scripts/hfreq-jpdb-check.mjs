import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const root = process.argv[2];
const require = createRequire(resolve(root, "test/tooling/package.json"));
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<div></div>", { runScripts: "outside-only" });
for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) dom.window.eval(readFileSync(resolve(root, "extension", file), "utf8"));
const result = { term: { frequencies: [{ dictionary: "JPDBv2㋕", frequencies: [{ value: 312, displayValue: "312, 19896㋕" }] }] } };
for (const [compact, names] of [[false, false], [true, false], [true, true]]) {
  const tags = dom.window.HDPopup.createFrequencyTags(dom.window.document, result, [{ title: "JPDBv2㋕", frequencyMode: "rank-based" }], 12, false, names, compact);
  console.log({ compact, names }, tags.map(t => [t.textContent, [...t.querySelectorAll(".gsm-hoshidicts-frequency-value")].map(v => v.title)]));
}
