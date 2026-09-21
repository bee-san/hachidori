// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

const pitch = (dictionary, position) => ({ dictionary, pitches: [{ position, pattern: "", nasal: [], devoice: [] }], transcriptions: [] });
const RESULT = { matched: "昭和", deinflected: "昭和", trace: [], term: { expression: "昭和", reading: "しょうわ", rules: "",
  glossaries: [{ dictionary: "Jitendex", glossary: JSON.stringify(["Shōwa era"]), termTags: "" }],
  frequencies: [], pitches: [pitch("NHK", 0), pitch("Daijirin", 1)] } };

function fixture(t) {
  const dom = new JSDOM('<p>昭和の映画</p><div id="popup"></div>',
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test" });
  const { window } = dom;
  const { document } = window;
  for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const { HDReaderOptions, HDGlossary, HDPopup } = window;
  const popup = document.getElementById("popup");
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList,
    buildPitchAccentMorae: HDGlossary.buildPitchAccentMorae,
    positionPopup() {},
  });
  const source = document.querySelector("p");
  const candidate = { anchor: source, query: "昭和", sentence: source.textContent, sourceElements: [source], matchOffset: 0 };
  t.after(() => { view.destroy(); window.close(); });
  return { popup, view, HDGlossary, render: (result = RESULT, options = {}) => {
    view.renderResults([result], candidate, { ...HDReaderOptions.normaliseOptions({}), ...options });
    return [...popup.querySelectorAll(".gsm-hoshidicts-tag-pitch")];
  } };
}

const morae = tag => [...tag.querySelectorAll(".gsm-hoshidicts-pitch-mora")]
  .map(node => ({ text: node.textContent, level: node.dataset.pitchLevel, transition: node.dataset.pitchTransition ?? null }));

test("every pitch badge draws its own mora contour and keeps the reading [n] label", t => {
  const f = fixture(t);
  const tags = f.render();
  assert.equal(tags.length, 2, "one badge per pitch dictionary");
  tags.forEach((tag, index) => {
    const body = tag.querySelector(".gsm-hoshidicts-pitch-body");
    const contour = body.querySelector(".gsm-hoshidicts-pitch-contour");
    assert.ok(contour, "badge body holds a contour");
    assert.deepEqual(morae(contour), f.HDGlossary.buildPitchAccentMorae("しょうわ", index));
    assert.equal(morae(contour).length, 3);
    assert.equal(body.querySelector(".gsm-hoshidicts-pitch-position").textContent, `[${index}]`);
    assert.equal(tag.title, `${["NHK", "Daijirin"][index]}: しょうわ [${index}]`);
    assert.equal(tag.getAttribute("aria-label"), tag.title);
  });
});

test("a pitch position beyond the morae falls back to the text badge and aliases relabel graph badges", t => {
  const f = fixture(t);
  const [text] = f.render({ ...RESULT, term: { ...RESULT.term, pitches: [pitch("NHK", 9)] } });
  assert.equal(text.querySelector(".gsm-hoshidicts-pitch-contour"), null);
  assert.equal(text.querySelector(".gsm-hoshidicts-pitch-body").textContent, "しょうわ [9]");
  assert.equal(text.title, "NHK: しょうわ [9]");
  const [graph] = f.render(RESULT);
  f.view.updateDictionaryPresentation({ dictionaryPresentation: [{ title: "NHK", displayName: "NHK 日本語発音アクセント辞典" }] });
  assert.ok(graph.isConnected);
  assert.equal(graph.title, "NHK 日本語発音アクセント辞典 (NHK): しょうわ [0]");
});
