// The lookup count (#486) arrives after the definitions and frequency tags
// have painted. Its slot keeps the count's place while it is on its way, so
// its arrival moves nothing: the production renderer and stylesheet in Chrome.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LOOKUP_COUNT_LAYOUT_CHECK = "A late lookup count arrives in its kept place after the frequency tags without moving them or the definitions";

// Every popup width from the minimum to just past the default, so a count that
// would change how the tags or the count's own line wrap cannot slip through.
const WIDTHS = Array.from({ length: 161 }, (_, index) => 280 + index * 2);
// A count up to two digits fits the kept place; a longer one never moves the tags.
const KEPT = [0, 1, 9, 12, 99];
const LONGER = [100, 12345];

export async function checkLookupCountLayout(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 900 });
    await page.setContent('<!doctype html><meta charset="utf-8"><p>食べる</p><div id="host"></div>');
    for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: fileURLToPath(new URL(`../extension/${file}`, import.meta.url)) });
    }
    await page.evaluate(css => {
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      // As theme-host.js installs the Default renderer's stylesheet.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:20px;height:640px";
      shadow.append(popup);
      let slot = null;
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {},
        onResultsRendered: rendered => { slot = rendered.lookupStats; },
      });
      const frequencies = [["JMdict", "142位"], ["JPDB", "1234"], ["BCCWJ", "5678"], ["Innocent Ranked", "910"]]
        .map(([dictionary, displayValue]) => ({ dictionary, frequencies: [{ value: Number.parseInt(displayValue, 10), displayValue }] }));
      const cases = [["no frequency", [], false], ["four frequencies", frequencies, false], ["four named frequencies", frequencies, true]];
      const candidate = { anchor: document.querySelector("p"), query: "食べる" };
      const render = ([, values, names], width) => {
        popup.style.width = `${width}px`;
        view.renderResults([{ matched: "食べる", deinflected: "食べる", trace: [], preprocessorSteps: 0, term: {
          expression: "食べる", reading: "たべる", rules: "v1", score: 0, frequencies: values, pitches: [],
          glossaries: [{ dictionary: "JMdict", definitionTags: "v1", glossary: JSON.stringify(["to eat", "to live on (e.g. a salary)"]) }],
        } }], candidate, { showFrequencyDictionaryNames: names });
        return slot;
      };
      const box = node => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return [x, y, width, height];
      };
      const geometry = () => {
        const capsule = popup.querySelector(".gsm-hoshidicts-primary-metadata-capsule:not([hidden])");
        return {
          tags: [...popup.querySelectorAll(".gsm-hoshidicts-primary-frequencies > .gsm-hoshidicts-tag-frequency")].map(box),
          capsule: capsule ? box(capsule) : null,
          card: box(popup.querySelector(".gsm-hoshidicts-glossary-card")),
          slot: slot.getClientRects().length > 0 ? box(slot) : null,
        };
      };
      const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      const label = count => `Looked up ${count} ${count === 1 ? "time" : "times"}`;

      window.countLayout = {
        render: (index, width) => render(cases[index], width),
        setLookupStats: (...args) => view.setLookupStats(slot, ...args),
        sweep({ widths, kept, longer }) {
          const failures = [];
          let comparisons = 0;
          for (const entry of cases) {
            for (const width of widths) {
              const fail = (what, detail = {}) => failures.push({ case: entry[0], width, what, ...detail });
              render(entry, width);
              view.setLookupStats(slot, null, true);
              const pending = geometry();
              if (!pending.slot || slot.hidden) fail("a count on its way keeps no place");
              if (slot.textContent !== "" || getComputedStyle(slot).visibility !== "hidden") fail("a count on its way paints");
              const { capsule } = pending;
              if (capsule && pending.slot) {
                const [left, top, , height] = pending.slot;
                const [capsuleLeft, capsuleTop, capsuleWidth, capsuleHeight] = capsule;
                const sameLine = top < capsuleTop + capsuleHeight && top + height > capsuleTop;
                if (sameLine ? left < capsuleLeft + capsuleWidth : top < capsuleTop + capsuleHeight) {
                  fail("the count does not follow the tags", { capsule, slot: pending.slot });
                }
              }
              for (const count of [...kept, ...longer]) {
                view.setLookupStats(slot, { lookupCount: count });
                const painted = geometry();
                comparisons += 1;
                if (slot.textContent !== label(count) || getComputedStyle(slot).visibility !== "visible") {
                  fail("the count does not paint", { count, text: slot.textContent });
                }
                if (!same(painted.tags, pending.tags)) fail("the frequency tags moved", { count, before: pending.tags, after: painted.tags });
                if (kept.includes(count)) {
                  if (!same(painted.card, pending.card)) fail("the definitions moved", { count, before: pending.card, after: painted.card });
                  if (!same(painted.slot, pending.slot)) fail("the count left its kept place", { count, before: pending.slot, after: painted.slot });
                }
              }
              // A refresh on its way keeps the same place again.
              view.setLookupStats(slot, null, true);
              const refreshing = geometry();
              if (!same(refreshing, pending)) fail("a refresh on its way changed the layout", { before: pending, after: refreshing });
              // Nothing will arrive: the slot hides and keeps no place.
              view.setLookupStats(slot, null);
              if (!slot.hidden || slot.getClientRects().length > 0) fail("an unavailable count keeps its place");
            }
          }
          return { comparisons, failures: failures.slice(0, 12), failureCount: failures.length };
        },
        shadowQuery: selector => shadow.querySelector(selector),
      };
    }, readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"));

    const sweep = await page.evaluate(options => window.countLayout.sweep(options), { widths: WIDTHS, kept: KEPT, longer: LONGER });
    assert.equal(sweep.failureCount, 0, `lookup count layout: ${JSON.stringify(sweep.failures)}`);
    assert.equal(sweep.comparisons, 3 * WIDTHS.length * (KEPT.length + LONGER.length));

    // Screen readers meet the count where they always did, before the tags:
    // only its position on screen changes. A count on its way is not exposed,
    // and the kept place's text never is.
    const names = async () => {
      const root = await page.evaluateHandle(() => window.countLayout.shadowQuery(".gsm-hoshidicts-entry"));
      const tree = await page.accessibility.snapshot({ root, interestingOnly: false });
      await root.dispose();
      const found = [];
      const walk = node => { if (node.name) found.push(node.name); node.children?.forEach(walk); };
      walk(tree);
      return found;
    };
    const counts = found => [...new Set(found.filter(name => name.includes("Looked up")))];
    await page.evaluate(() => { window.countLayout.render(1, 560); window.countLayout.setLookupStats(null, true); });
    const pending = await names();
    await page.evaluate(() => window.countLayout.setLookupStats({ lookupCount: 12 }));
    const painted = await names();
    assert.deepEqual(counts(pending), [], `a count on its way is exposed: ${JSON.stringify(pending)}`);
    assert.deepEqual(counts(painted), ["Looked up 12 times"], `the painted count is not exposed as itself: ${JSON.stringify(painted)}`);
    const count = painted.indexOf("Looked up 12 times");
    const firstTag = painted.findIndex(name => name.includes("142位"));
    assert.ok(firstTag > count, `the count no longer precedes the frequency tags for screen readers: ${JSON.stringify(painted)}`);
    console.log("PASS lookup count layout", JSON.stringify({ widths: WIDTHS.length, comparisons: sweep.comparisons, painted }));
  } finally {
    await page.close();
  }
}
