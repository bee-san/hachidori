import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function checkCompactSummaryLayout(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 700 });
    await page.setContent('<p>漢字表記</p><div id="host"></div>');
    for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: fileURLToPath(new URL(`../extension/${file}`, import.meta.url)) });
    }
    await page.evaluate(css => {
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = css;
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:60px";
      shadow.append(style, popup);
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {},
      });
      view.renderResults([{ matched: "漢字表記", term: {
        expression: "漢字表記", reading: "かんじひょうき", frequencies: [], pitches: [],
        glossaries: [{ dictionary: "summary-layout", glossary: JSON.stringify([
          "kanji representation", "representation in Chinese characters",
        ]) }],
      } }], { anchor: document.querySelector("p"), query: "漢字表記" }, {
        showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 2,
      });
    }, readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"));
    const evidence = [];
    for (const width of [560, 440, 320]) {
      for (const fontSize of [32, 48]) {
        const geometry = await page.evaluate(({ width, fontSize }) => {
          const root = document.querySelector("#host").shadowRoot;
          const popup = root.querySelector(".gsm-hoshidicts-popup");
          popup.style.width = `${width}px`;
          root.querySelector(".gsm-hoshidicts-expression").style.fontSize = `${fontSize}px`;
          const list = root.querySelector(".gsm-hoshidicts-compact-definition-items");
          const summary = list.parentElement;
          const button = root.querySelector(".gsm-hoshidicts-note-button");
          const bounds = button.getBoundingClientRect();
          return { width, fontSize, height: list.clientHeight, contentHeight: list.scrollHeight,
            summaryHeight: summary.clientHeight, summaryContentHeight: summary.scrollHeight,
            popup: popup.getBoundingClientRect().toJSON(), button: bounds.toJSON(),
            hit: button.contains(root.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
            text: list.textContent,
          };
        }, { width, fontSize });
        evidence.push(geometry);
        assert.ok(geometry.contentHeight <= geometry.height, `summary text clipped: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.summaryContentHeight <= geometry.summaryHeight, `summary wrapper clipped: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.hit && geometry.button.right <= geometry.popup.right
          && geometry.button.bottom <= geometry.popup.bottom, `Note button inaccessible: ${JSON.stringify(geometry)}`);
        assert.equal(geometry.text, "kanji representationrepresentation in Chinese characters");
      }
    }
    const { button } = evidence.at(-1);
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    assert.ok(await page.evaluate(() => Boolean(document.querySelector("#host").shadowRoot
      .querySelector(".gsm-hoshidicts-note-form"))), "real pointer opens Note after narrow reflow");
    console.log("PASS compact summary wrapping and toolbar access", JSON.stringify(evidence));
  } finally {
    await page.close();
  }
}
