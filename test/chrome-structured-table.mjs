// NHK-pitch's disclosure tables extend into their indentation (#469).
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STRUCTURED_TABLE_CHECK = "Indented dictionary tables show their complete first column and retain horizontal scrolling";
// The relevant layout declarations from the issue's attached NHK-pitch archive.
const STYLES = `table { border-collapse: collapse; table-layout: fixed; width: 100%; }
th, td { padding: 0.15em 0.45em; overflow-wrap: anywhere; }
th { text-align: left; }
th:first-child, td:first-child { width: 5.5em; }
th:nth-child(2), td:nth-child(2) { width: 10em; }
details table { margin-left: -1.35em; width: calc(100% + 1.35em); }
table[data-sc-wide="true"] { width: 1000px; min-width: 1000px; }`;
const row = (tag, cells) => ({ tag: "tr", content: cells.map(content => ({ tag, content })) });
const table = data => ({ tag: "table", data, content: [
  row("th", ["type", "example", "accent"]), row("td", ["前部末", "機内食", "キナ＼イショク"]),
] });

export async function checkStructuredTable(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 800 });
    await page.setContent('<!doctype html><meta charset="utf-8"><p>食</p><div id="host"></div>');
    for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: fileURLToPath(new URL(`../extension/${file}`, import.meta.url)) });
    }
    await page.evaluate(({ css, styles, content }) => {
      const host = document.querySelector("#host");
      const shadow = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:55px";
      shadow.append(popup);
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {},
      });
      view.renderResults([{ matched: "食", trace: [], term: {
        expression: "食", reading: "しょく", rules: "", frequencies: [], pitches: [],
        glossaries: [{ dictionary: "NHK layout", glossary: JSON.stringify([{ type: "structured-content", content }]) }],
      } }], { anchor: document.querySelector("p"), query: "食" }, {});
      HDGlossary.applyDictionaryStyles(document, shadow, 1, [{ dictionary: "NHK layout", styles }]);
      shadow.querySelector("details").open = true;
      window.tableAppearance = HDPopup.createPopupAppearance(host);
    }, { css: readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"), styles: STYLES,
      content: [{ tag: "details", content: [{ tag: "summary", content: "show examples" }, table()] }, table({ wide: "true" })] });
    for (const width of [320, 560]) {
      await page.evaluate(popupWidthPx => tableAppearance.update({ popupTheme: "default", popupWidthPx,
        popupHeightPx: 600, popupScalePercent: 100, popupOpacityPercent: 100 }), width);
      const state = await page.evaluate(() => {
        const shadow = document.querySelector("#host").shadowRoot;
        const table = shadow.querySelector("details table");
        const container = table.parentElement;
        const header = table.querySelector("th");
        const range = document.createRange();
        range.selectNodeContents(header);
        const glyph = range.getClientRects()[0];
        const clip = container.getBoundingClientRect();
        const wide = shadow.querySelector('[data-sc-wide="true"]').parentElement;
        wide.scrollLeft = wide.scrollWidth;
        const last = wide.querySelector("th:last-child").getBoundingClientRect();
        return { firstGlyphVisible: glyph.left >= clip.left && header.contains(shadow.elementFromPoint(glyph.left + 1, glyph.top + 1)),
          rightContained: table.getBoundingClientRect().right <= clip.right + 1,
          margin: getComputedStyle(table).marginLeft,
          scrolls: wide.scrollWidth > wide.clientWidth && wide.scrollLeft > 0,
          lastColumnVisible: last.right <= wide.getBoundingClientRect().right + 1 };
      });
      assert.ok(state.firstGlyphVisible, `${width}px: the first column is clipped: ${JSON.stringify(state)}`);
      assert.ok(state.rightContained, `${width}px: the dictionary table extends past its scroller`);
      assert.ok(Number.parseFloat(state.margin) < 0, "the dictionary's negative margin remains applied");
      assert.ok(state.scrolls && state.lastColumnVisible, `${width}px: a wide table cannot scroll to its final column`);
      await page.evaluate(() => {
        const table = document.querySelector("#host").shadowRoot.querySelector("details table");
        table.style.width = "1000px";
        table.style.minWidth = "1000px";
        const container = table.parentElement;
        container.scrollLeft = container.scrollWidth;
        if (!(container.scrollWidth > container.clientWidth && container.scrollLeft > 0
          && table.getBoundingClientRect().right <= container.getBoundingClientRect().right + 1)) {
          throw new Error("A wide disclosure table must still scroll to its right edge");
        }
        container.scrollLeft = 0;
        table.style.removeProperty("width");
        table.style.removeProperty("min-width");
      });
    }
  } finally {
    await page.close();
  }
}
