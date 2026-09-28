// Focused renderer boundary and fallback contracts.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import theme from "../extension/vendor/themes/nazeka/theme.js";
const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const extension = resolve(import.meta.dirname, "../extension");
function environment() {
  const dom = new JSDOM("<div id='host'></div>", { runScripts: "outside-only", pretendToBeVisual: true });
  for (const name of ["render/glossary.js", "render/popup.js", "theme-host.js"]) dom.window.eval(readFileSync(resolve(extension, name), "utf8"));
  return dom;
}
const results = [{ matched: "食べる", trace: [], term: { expression: "食べる", reading: "たべる", frequencies: [],
  glossaries: [{ dictionary: "test", glossary: JSON.stringify([{ type: "structured-content", content: [
    { tag: "b", content: "eat " }, { tag: "a", href: "https://example.test", content: "food" },
    { tag: "img", path: "test.png" },
  ] }]) }] } }];
test("Nazeka builds text directly, binds core actions, and never constructs Default or rich DOM", () => {
  const dom = environment(), { window } = dom, { document } = window;
  try {
    const popup = document.createElement("div"); document.body.append(popup);
    let bound;
    const view = theme.createView({ document, window, popup, positionPopup() {},
      components: window.HDPopup && { ...window.HDPopup, glossaryToPlainText: window.HDGlossary.glossaryToPlainText },
      appendTextOnlyGlossary() { throw new Error("rich renderer called"); },
      onResultsRendered(value) { bound = value; },
    });
    view.renderResults(results, { query: "食べる" });
    assert.match(popup.textContent, /eat food/);
    assert.equal(popup.querySelectorAll("img,a,b,.gsm-hoshidicts-result-chrome,.gsm-hoshidicts-glossary-card").length, 0);
    assert.equal(bound.audioButtons[0].result, results[0]);
    assert.equal(bound.miningActions[0].result, results[0]);
    assert.equal(bound.lookupStats.hidden, true);
    const second = { ...results[0], term: { ...results[0].term, glossaries: [
      { dictionary: "second", glossary: "other definition" },
    ] } };
    view.renderResults([results[0], second], { query: "食べる" });
    const entries = popup.querySelectorAll(".gsm-hoshidicts-entry");
    entries[1].querySelector(".gsm-hoshidicts-glossary-content").click();
    assert.equal(view.currentEntryIndex(), 1, "clicking text selects its entry for keyboard actions");
    let scrolled;
    view.scrollElement.scrollTo = value => { scrolled = value; };
    view.scrollElement.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
    entries.forEach((entry, index) => {
      entry.querySelector(".nazeka-sense").getBoundingClientRect = () => ({ top: index * 100, bottom: index * 100 + 50 });
    });
    entries[0].click();
    assert.equal(view.focusEntry({ dictionary: 1 }), true);
    assert.equal(view.currentEntryIndex(), 1);
    assert.equal(scrolled.top, 100);
    assert.equal(view.focusEntry({ dictionary: 1 }), false);
    view.destroy(); assert.equal(popup.children.length, 0);
  } finally { dom.window.close(); }
});
test("text traversal retains deeply nested content without building DOM", () => {
  const dom = environment();
  try {
    let data = "deep";
    for (let i = 0; i < 1000; i++) data = { tag: "div", content: data };
    assert.equal(dom.window.HDGlossary.glossaryToPlainText(data), "deep");
    assert.equal(dom.window.HDGlossary.glossaryToPlainText([{ content: ["食", { tag: "b", content: "べる" }] }, "eat"]), "食べる\neat");
  } finally { dom.window.close(); }
});
test("renderer failure replays the current model with Default CSS and keeps the preference", async () => {
  const dom = environment(), { window } = dom, { document } = window;
  const original = theme.createView;
  try {
    const options = { popupTheme: "nazeka" }, fetched = [], rendered = [];
    window.chrome = { runtime: { getURL: path => pathToFileURL(resolve(extension, path)).href } };
    window.fetch = async url => { fetched.push(url); return { ok: true, text: async () => url.includes("nazeka") ? ".nazeka-only {}" : ".default-only {}" }; };
    window.HDPopup.createPopupView = () => ({ renderResults: value => rendered.push(value), destroy() {} });
    const host = window.HDThemeHost.createThemeHost({ getOptions: () => options });
    const shadow = document.getElementById("host").attachShadow({ mode: "open" });
    host.attach(shadow);
    theme.createView = () => ({ renderResults() { throw new Error("injected failure"); }, destroy() {}, captureTermView() {} });
    await host.sync();
    assert.equal(fetched.some(url => url.includes("reader.css")), false);
    const popup = document.createElement("div"); shadow.append(popup);
    const view = host.createView({ document, window, popup });
    view.renderResults(results, {});
    await host.sync();
    assert.equal(rendered[0], results);
    assert.equal(options.popupTheme, "nazeka");
    assert.equal(shadow.host.dataset.hoshidictsRenderer, "default");
    const css = [...shadow.querySelectorAll("style")].map(node => node.textContent).join("")
      + [...(shadow.adoptedStyleSheets || [])].flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText)).join("");
    assert.match(css, /default-only/);
    assert.doesNotMatch(css, /nazeka-only/);
    view.destroy();
  } finally { theme.createView = original; dom.window.close(); }
});
