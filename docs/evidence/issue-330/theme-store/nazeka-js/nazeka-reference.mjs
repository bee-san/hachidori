// Evidence for issue #334: a reference render of Nazeka's popup made by Nazeka's
// own code. Extracts build_div / build_div_kanji and their helpers from
// wareya/nazeka texthook.js (8b220fb, Apache-2.0), runs them in a plain page in
// Chrome for Testing with Nazeka's default settings and the same sample data the
// Hachidori fixture holds, and screenshots the result. Nazeka is a Firefox
// extension; Chrome 152 cannot load its MV2 package, so this is the closest
// faithful reference available.
//
//   NAZEKA_SRC=/tmp/hd-refs/nazeka EVIDENCE_OUT=<dir> node nazeka-reference.mjs
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));
const SRC = process.env.NAZEKA_SRC;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
mkdirSync(OUT, { recursive: true });

const texthook = readFileSync(resolve(SRC, "texthook.js"), "utf8").split("\n");
const slice = (from, to) => texthook.slice(from - 1, to).join("\n");   // 1-based inclusive line ranges
const settings = slice(5, 82);                                          // `let settings = { … };`
const builders = slice(431, 1304);                                      // clip … build_div_kanji
const shim = `
let platform = "linux"; const div_class = "nazeka_fg"; let last_displayed = null; // lastMoreText is declared in the extracted slice (texthook.js:1145)
function is_sticky() { return false; }
function mining_ui_exists() { return false; }
// display_div (texthook.js:213-222, 260-285) with corner 0 / no drop shadow / no scale:
function nazekaShow(middle, left, top) {
  middle.style = "background-color: " + settings.bgcolor + "; border-radius: 2.5px; border: 1px solid " + settings.bgcolor + ";";
  middle.firstChild.style = "border: 1px solid " + settings.fgcolor + "; border-radius: 2px; padding: " + settings.padding + "px; background-color: " + settings.bgcolor + "; color: " + settings.fgcolor + "; font-family: Arial, sans-serif; text-align: left; font-size: " + settings.definition_fontsize + "px;";
  const outer = document.createElement("div");
  outer.className = div_class; outer.lang = "ja";
  outer.style = "max-width: " + settings.width + "px; min-width: 150px; position: absolute; top: " + top + "px; left: " + left + "px; border-radius: 3px; background-color: " + settings.bgcolor + "; writing-mode: horizontal-tb; line-height: initial; white-space: initial;";
  outer.appendChild(middle);
  document.body.appendChild(outer);
  return outer;
}`;
// The fixture's 食べる rows as Nazeka's JMdict shape: two senses, the second tagged "col".
const term = {
  seq: 1358280, found: { keb: "食べる" }, k_ele: [{ keb: "食べる" }], r_ele: [{ reb: "たべる" }],
  has_audio: [], json: [],
  deconj: [{ process: ["past", "(ka stem)", "want"] }],           // 食べたかった: want→past after Nazeka's filter
  sense: [
    { pos: ["v1", "vt"], gloss: ["to eat", "to live on (e.g. a salary)"] },
    { pos: ["v1", "vt"], misc: ["(col)"], gloss: ["to make a living"] },
  ],
};
const kanji = { g: "2", s: "9", o: ["ショク", "ジキ"], k: ["く.う", "た.べる"], z: "⿱𠆢良" };

const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<style>body{font:32px/2 "Noto Sans CJK JP",serif;padding:56px 80px;background:#f4efe6;color:#222;margin:0}span{display:inline-block}</style>
<script>${settings}\n${builders}\n${shim}</script></head>
<body><p>朝ごはんを<span id="verb">食べたかった</span>。</p></body></html>`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--lang=en-GB"] });
const report = { chrome: await browser.version(), source: "wareya/nazeka 8b220fb texthook.js:5-82,431-1304", shots: {} };
try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", error => errors.push(error.message));
  await tab.setViewport({ width: 1000, height: 760, deviceScaleFactor: 2 });
  await tab.setContent(page, { waitUntil: "load" });
  if (errors.length) throw new Error(`Nazeka source failed to load: ${errors.join(" | ")}`);
  for (const [name, expression] of [
    ["nazeka-reference-term", `(() => { const anchor = document.getElementById("verb").getBoundingClientRect();
        const middle = build_div("食べたかった", [${JSON.stringify(term)}], "朝ごはんを食べたかった。", 5);
        const outer = nazekaShow(middle, anchor.left + 5, anchor.bottom + 22); return outer.getBoundingClientRect().toJSON(); })()`],
    ["nazeka-reference-kanji", `(() => { document.querySelectorAll(".nazeka_fg").forEach(n => n.remove());
        const anchor = document.getElementById("verb").getBoundingClientRect();
        const middle = build_div_kanji("食", ${JSON.stringify(kanji)}, "朝ごはんを食べたかった。", 5);
        const outer = nazekaShow(middle, anchor.left + 5, anchor.bottom + 22); return outer.getBoundingClientRect().toJSON(); })()`],
  ]) {
    const rect = await tab.evaluate(expression);
    await tab.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const pad = 28;
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip: { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad),
      width: Math.min(1000, rect.width + pad * 2), height: Math.min(760, rect.height + pad * 2) } });
    report.shots[name] = { rect, text: await tab.evaluate(() => document.querySelector(".nazeka_fg").textContent.replace(/\s+/g, " ").trim()),
      styles: await tab.evaluate(() => {
        const pick = (el, props) => el ? Object.fromEntries(props.map(p => [p, getComputedStyle(el)[p]])) : null;
        const outer = document.querySelector(".nazeka_fg");
        return { inner: pick(outer.firstChild.firstChild, ["fontFamily", "fontSize", "color", "backgroundColor", "borderTopColor", "padding"]),
          keb: pick(outer.querySelector(".nazeka_main_keb"), ["fontSize", "color", "fontFamily"]),
          reb: pick(outer.querySelector(".nazeka_sub_reb"), ["fontSize", "color"]),
          original: pick(outer.querySelector(".nazeka_original"), ["opacity", "cssFloat"]) };
      }) };
  }
  report.pageErrors = errors;
} finally {
  await browser.close();
}
writeFileSync(resolve(OUT, "nazeka-reference.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
