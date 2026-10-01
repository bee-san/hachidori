// Design → Definitions → Compact glossaries (#429): Yomitan's compact rules
// over the production glossary markup, with the real reader stylesheet.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../extension/reader-options.js";

export const COMPACT_GLOSSARIES_CHECK = "Compact glossaries share a sense's glosses on one barred line that screen readers skip and Default restores exactly";
const PALETTES = globalThis.HDReaderOptions.POPUP_THEME_GROUPS
  .flatMap(group => group.themes.map(theme => theme.id)).filter(theme => theme !== "auto");
const SEPARATOR = '" | " / ""';
// Jitendex's own list rules: markers are dropped inside a sense, and the
// nested rule outranks a plain list selector (0,2,2).
const JITENDEX_STYLES = `ul[data-sc-content="sense-groups"] { list-style-type: "＊"; }
li[data-sc-content="sense"] { padding-left: 0.25em; & ul[data-sc-content="glossary"] { list-style-type: none; padding-left: 0.25em; } }
ul[data-sc-content="glossary"] { list-style-type: disc; }`;
const marked = (tag, content, data) => ({ tag, data: { content: data }, content });
const sense = (mark, glosses, example) => ({ tag: "li", data: { content: "sense" }, style: { listStyleType: `"${mark}"` },
  content: [marked("ul", glosses.map(gloss => ({ tag: "li", content: gloss })), "glossary"),
    marked("div", { tag: "div", data: { content: "example-sentence" }, content: example }, "extra-info")] });
const JITENDEX = [{ type: "structured-content", content: [
  marked("ul", marked("li", [
    { tag: "span", data: { class: "tag", content: "part-of-speech-info" }, content: "1-dan" },
    { tag: "ol", content: [sense("①", ["to eat"], "もっと果物を食べるべきです。"),
      sense("②", ["to live on (e.g. a salary)", "to live off", "to subsist on"], "脚本家で食べていく。")] },
  ], "sense-group"), "sense-groups"),
  marked("div", "JMdict | Tatoeba", "attribution"),
] }];

export async function checkCompactGlossaries(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 900 });
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    // Standards mode, as in the Design preview and most pages: quirks mode
    // drops a line box holding only preserved white space.
    await page.setContent('<!doctype html><meta charset="utf-8"><p>食べる</p><div id="host"></div>');
    for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: fileURLToPath(new URL(`../extension/${file}`, import.meta.url)) });
    }
    await page.evaluate(({ css, styles, structured }) => {
      const host = document.querySelector("#host");
      const shadow = host.attachShadow({ mode: "open" });
      // As theme-host.js installs the Default renderer's stylesheet.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:20px";
      shadow.append(popup);
      window.layoutView = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {},
      });
      layoutView.renderResults([{ matched: "食べる", deinflected: "食べる", trace: [], preprocessorSteps: 0, term: {
        expression: "食べる", reading: "たべる", rules: "v1", score: 0, frequencies: [], pitches: [], glossaries: [
          { dictionary: "Plain", definitionTags: "v1 vt",
            glossary: JSON.stringify(["to eat", "to live on (e.g. a salary)", "to have a meal"]) },
          { dictionary: "Jitendex", definitionTags: "★", glossary: JSON.stringify(structured) },
        ],
      } }], { anchor: document.querySelector("p"), query: "食べる" }, {});
      HDGlossary.applyDictionaryStyles(document, shadow, 1, [{ dictionary: "Jitendex", styles }]);
      const appearance = HDPopup.createPopupAppearance(host);
      window.setLayout = (glossaryLayoutMode, popupTheme = "default") => appearance.update({ popupTheme,
        popupWidthPx: 560, popupHeightPx: 860, popupScalePercent: 100, popupOpacityPercent: 85,
        showPopupAudioButton: true, glossaryLayoutMode });
      window.shadowQuery = (selector, all = false) => all ? [...shadow.querySelectorAll(selector)] : shadow.querySelector(selector);
      setLayout("default");
    }, { css: readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"),
      styles: JITENDEX_STYLES, structured: JITENDEX });
    const heights = () => page.evaluate(() => shadowQuery(".gsm-hoshidicts-glossary-card", true)
      .map(card => card.getBoundingClientRect().height));
    // Where Jitendex's sense groups start inside their card: no empty line above.
    const structuredStart = () => page.evaluate(() => shadowQuery('ul[data-sc-content="sense-groups"]').getBoundingClientRect().top
      - shadowQuery(".gsm-hoshidicts-glossary-card:last-child").getBoundingClientRect().top);
    const before = await heights();
    const start = await structuredStart();
    await page.evaluate(() => setLayout("compact"));
    const compact = await heights();
    assert.equal(await structuredStart(), start, "structured content starts on the same line in both layouts");
    const layout = await page.evaluate(SEPARATOR => {
      const [plain, jitendex] = shadowQuery(".gsm-hoshidicts-glossary-card", true);
      const lines = nodes => nodes.map(node => [...node.getClientRects()]);
      // Chrome may split an inline into fragments; they must share one line.
      const oneLine = rects => rects.every(list => list.length > 0) && Math.max(...rects.flat().map(rect => rect.top))
        < Math.min(...rects.flat().map(rect => rect.bottom));
      const separated = items => items.every((item, index) =>
        getComputedStyle(item, "::before").content === (index === 0 ? "none" : SEPARATOR));
      const style = selector => getComputedStyle(jitendex.querySelector(selector));
      const items = [...plain.querySelectorAll(".gloss-item")];
      const senses = [...jitendex.querySelectorAll('ul[data-sc-content="glossary"]')];
      return {
        plainLine: oneLine(lines([plain.querySelector(".definition-tag-list"), ...items])),
        plainSeparated: separated(items),
        // Yomitan's zero-size space: copied and scanned glosses stay apart.
        separatorWidths: [...plain.querySelectorAll(".gloss-separator")].map(node => node.getBoundingClientRect().width),
        copied: plain.querySelector(".gloss-list").innerText.trim(),
        senseLine: oneLine(lines([...senses[1].children])),
        senseSeparated: separated([...senses[1].children]),
        senseList: senses.map(list => [getComputedStyle(list).display, getComputedStyle(list).paddingLeft]),
        blocks: [style('ul[data-sc-content="sense-groups"]').display, style('div[data-sc-content="example-sentence"]').display,
          style(".definition-tag-list").display],
      };
    }, SEPARATOR);
    assert.ok(compact.every((height, index) => height < before[index]), `compact cards are not shorter: ${before} → ${compact}`);
    assert.ok(layout.plainLine && layout.plainSeparated, `plain glosses and tags do not share one separated line: ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.separatorWidths, [0, 0, 0]);
    assert.equal(layout.copied, "to eat to live on (e.g. a salary) to have a meal");
    assert.ok(layout.senseLine && layout.senseSeparated, `structured glosses do not share one separated line: ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.senseList, [["inline", "0px"], ["inline", "0px"]], "compact rules outrank Jitendex's list rules");
    assert.deepEqual(layout.blocks, ["block", "block", "flex"], "sense groups, examples and the structured tag row keep their lines");

    // Screen readers read the list items only, not the generated bars.
    for (const selector of ['.gsm-hoshidicts-glossary-card:first-child .gloss-list', 'ul[data-sc-content="glossary"]:has(> li + li)']) {
      const root = await page.evaluateHandle(value => shadowQuery(value), selector);
      const tree = await page.accessibility.snapshot({ root, interestingOnly: false });
      const names = [];
      const walk = node => { names.push(node.name ?? ""); node.children?.forEach(walk); };
      walk(tree);
      assert.equal(tree.role, "list", selector);
      assert.deepEqual(tree.children.map(child => child.role), ["listitem", "listitem", "listitem"], selector);
      assert.ok(names.every(name => !name.includes("|")), `${selector} reads a bar: ${JSON.stringify(names)}`);
      await root.dispose();
    }

    // The inline wrapper still blurs, including structured blocks inside it.
    const clips = await page.evaluate(() => [".gsm-hoshidicts-glossary-card:first-child .gloss-list",
      'div[data-sc-content="example-sentence"]'].map(selector => {
      const rect = shadowQuery(selector).getBoundingClientRect();
      return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
    }));
    const shots = () => Promise.all(clips.map(clip => page.screenshot({ clip, encoding: "base64" })));
    const sharp = await shots();
    await page.evaluate(() => layoutView.setDefinitionBlurState("blurred"));
    await page.waitForFunction(() => shadowQuery(".gsm-hoshidicts-glossary-content", true)
      .every(node => getComputedStyle(node).filter === "blur(5px)"));
    const blurred = await shots();
    assert.ok(blurred.every((shot, index) => shot !== sharp[index]), "compact definitions do not render blurred");
    await page.evaluate(() => layoutView.setDefinitionBlurState("revealed"));
    await page.waitForFunction(() => shadowQuery(".gsm-hoshidicts-glossary-content", true)
      .every(node => getComputedStyle(node).filter === "none"));

    // The bar is the only boundary between glosses (WCAG 1.4.11).
    const contrasts = {};
    for (const palette of PALETTES) {
      const probe = await page.evaluate(palette => {
        setLayout("compact", palette);
        const item = shadowQuery(".gsm-hoshidicts-glossary-card:first-child .gloss-item:last-child");
        // The item's first fragment starts with the bar's leading space, so
        // its background is the one the bar is drawn on.
        const [lead] = item.getClientRects();
        const context = new OffscreenCanvas(1, 1).getContext("2d");
        context.fillStyle = getComputedStyle(item, "::before").color;
        context.fillRect(0, 0, 1, 1);
        return { bar: [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)],
          x: lead.left + 2, y: lead.top + lead.height / 2 };
      }, palette);
      const png = await page.screenshot({ clip: { x: probe.x, y: probe.y, width: 1, height: 1 }, encoding: "base64" });
      const card = await page.evaluate(async png => {
        const context = new OffscreenCanvas(1, 1).getContext("2d");
        context.drawImage(await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob()), 0, 0);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      }, png);
      contrasts[palette] = contrast(probe.bar, card);
    }
    // Unrounded: 2.996 must not pass as "3.00".
    const low = Object.entries(contrasts).filter(([, ratio]) => ratio < 3);
    assert.deepEqual(low, [], "the compact bar reaches 3:1 against the card in every palette");
    for (const palette of PALETTES) contrasts[palette] = Number(contrasts[palette].toFixed(2));

    await page.evaluate(() => setLayout("default"));
    const restored = await heights();
    assert.deepEqual(restored, before, "Default returns the exact card heights");
    assert.equal(await page.$eval("#host", host => host.hasAttribute("data-hoshidicts-glossary-layout")), false);
    console.log("PASS compact glossaries", JSON.stringify({ before, compact, contrasts }));
  } finally {
    await page.close();
  }
}

function contrast(first, second) {
  const luminance = pixel => pixel.map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
