import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM || resolve("test/tooling")] }));

function fixture(t, timePerEntry = 8) {
  const dom = new JSDOM('<p>嬉しそう</p><div id="popup"></div>', { pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const frames = [], tasks = [], expanded = [];
  window.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  window.cancelAnimationFrame = () => {};
  window.setTimeout = fn => { tasks.push(fn); return tasks.length; };
  let time = 0;
  window.performance.now = () => (time += timePerEntry);
  const popup = window.document.getElementById("popup");
  const view = window.HDPopup.createPopupView({ window, document: window.document, popup,
    ...window.HDGlossary, positionPopup() {}, onResultsExpanded: value => expanded.push(value.audioButtons.length) });
  const results = ["嬉しそう", "嬉しい", "嬉し"].map(expression => ({ matched: "嬉しそう", term: {
    expression, reading: "うれしい", rules: "", frequencies: [], pitches: [],
    glossaries: [{ dictionary: "Test", glossary: JSON.stringify([expression + " definition"]) }],
  } }));
  const render = (context = {}, values = results) => view.renderResults(values,
    { anchor: window.document.querySelector("p"), query: "嬉しそう" }, context);
  const step = () => { for (const fn of frames.splice(0)) fn(); for (const fn of tasks.splice(0)) fn(); };
  const drain = () => { for (let i = 0; i < 20 && (frames.length || tasks.length); i++) step(); };
  const entries = () => [...popup.querySelectorAll("article")].map(node => node.dataset.expression);
  t.after(() => { view.destroy(); window.close(); });
  return { view, popup, render, step, drain, entries, expanded, results };
}

test("later lookup entries become available in order without an expansion click", t => {
  const f = fixture(t);
  f.render();
  assert.deepEqual(f.entries(), ["嬉しそう"]);
  f.step();
  assert.ok(f.entries().length < 3, "do not build every later entry in one turn");
  f.drain();
  assert.deepEqual(f.entries(), ["嬉しそう", "嬉しい", "嬉し"]);
  assert.match(f.popup.textContent, /嬉しい definition/u);
  assert.equal(f.popup.querySelector(".gsm-hoshidicts-show-more"), null);
  assert.deepEqual(f.expanded, [2, 3]);
});

test("superseded or closed requests cannot append scheduled results", t => {
  const f = fixture(t);
  let current = true;
  f.render({ isCurrentRequest: () => current });
  current = false;
  const before = f.popup.innerHTML;
  f.drain();
  assert.equal(f.popup.innerHTML, before);
  f.render({}, [f.results[1]]);
  f.drain();
  assert.deepEqual(f.entries(), ["嬉しい"]);
  f.render();
  f.view.clear();
  f.drain();
  assert.deepEqual(f.entries(), []);
});

test("cheap entries share a batch and manual expansion cannot duplicate pending entries", t => {
  const f = fixture(t, 0);
  f.render();
  f.step();
  assert.deepEqual(f.entries(), ["嬉しそう", "嬉しい", "嬉し"]);
  assert.deepEqual(f.expanded, [3]);
  f.render();
  f.popup.querySelector(".gsm-hoshidicts-show-more").click();
  f.drain();
  assert.deepEqual(f.entries(), ["嬉しそう", "嬉しい", "嬉し"]);
});
