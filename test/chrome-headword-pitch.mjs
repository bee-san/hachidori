// The headword's pitch accent (#606) in real layout, with the production
// renderer and reader stylesheet: a kanji headword keeps the furigana it has
// with the pitch off and draws the pitch on its reading after it, a kana
// headword draws it on its own kana, blurred definitions hide both, and forced
// colours keep its lines on their sides.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HEADWORD_PITCH_CHECK = "a kanji headword's pitch is on its reading beside unchanged furigana, "
  + "a kana headword carries its own, and blur hides both until the reveal";

const result = (expression, reading, position, furigana) => ({ matched: expression, deinflected: expression, trace: [],
  term: { expression, reading, furigana, rules: "", score: 0, frequencies: [],
    pitches: [{ dictionary: "NHK", pitches: [{ position, pattern: "", nasal: [], devoice: [] }], transcriptions: [] }],
    glossaries: [{ dictionary: "Jitendex", definitionTags: "", termTags: "", glossary: JSON.stringify(["gloss"]) }] } });
// The issue's 好き嫌い [2], with the engine's KANJIDIC split, and its comment's てくてく [1].
const KANJI = result("好き嫌い", "すききらい", 2, [{ text: "好", reading: "す" }, { text: "き", reading: "" },
  { text: "嫌", reading: "きら" }, { text: "い", reading: "" }]);
const KANA = result("てくてく", "てくてく", 1);
const TRANSPARENT = "rgba(0, 0, 0, 0)";

export async function checkHeadwordPitch(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 700, height: 400 });
    await page.setContent('<!doctype html><meta charset="utf-8"><p>好き嫌い</p><div id="host"></div>');
    for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js"]) {
      await page.addScriptTag({ path: fileURLToPath(new URL(`../extension/${file}`, import.meta.url)) });
    }
    await page.evaluate(css => {
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:20px;width:560px;height:300px";
      shadow.append(popup);
      const view = HDPopup.createPopupView({ document, window, popup, positionPopup() {},
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, parseTagList: HDGlossary.parseTagList });
      const anchor = document.querySelector("p");
      const style = node => node ? getComputedStyle(node) : null;
      window.headwordPitch = (value, options, blur = "revealed") => {
        view.renderResults([value], { anchor, query: value.term.expression, sentence: "", sourceElements: [anchor],
          matchOffset: 0 }, { ...HDReaderOptions.normaliseOptions({}), ...options });
        view.setDefinitionBlurState(blur);
        const expression = popup.querySelector(".gsm-hoshidicts-expression");
        const reading = expression.querySelector(".gsm-hoshidicts-pitch-reading");
        const contour = expression.querySelector(".gsm-hoshidicts-pitch-contour");
        const level = name => contour?.querySelector(`[data-pitch-level="${name}"], [data-pitch="${name}"]`);
        const high = level("high"), low = level("low");
        // The text selecting the whole headword gives. (Chrome 128's
        // Selection.toString still includes user-select: none text, which a
        // copy leaves out, so only a kana headword's is compared.)
        const range = document.createRange();
        range.selectNodeContents(expression);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        const copied = getSelection().toString();
        getSelection().removeAllRanges();
        return {
          copied,
          furigana: [...expression.querySelectorAll("ruby")].map(ruby => ruby.textContent),
          rt: style(expression.querySelector("rt")) && { colour: style(expression.querySelector("rt")).color,
            filter: style(expression.querySelector("rt")).filter },
          reading: reading && { text: reading.textContent, fontSize: style(reading).fontSize, colour: style(reading).color,
            filter: style(reading).filter, userSelect: style(reading).userSelect },
          contour: contour && { inHeadword: contour.parentElement === expression, text: contour.textContent,
            fontSize: style(contour).fontSize, colour: style(contour.firstElementChild).color },
          // The contour's lines, or the Overline style's line over high morae (its ::after).
          lines: high?.classList.contains("pronunciation-mora")
            ? [getComputedStyle(high, "::after").borderTopColor]
            : [style(high)?.borderTopColor, style(low)?.borderBottomColor],
          // A contour mora's other side, which only a forced colour would paint.
          unused: high?.classList.contains("pronunciation-mora") ? []
            : [style(high)?.borderBottomColor, style(low)?.borderTopColor],
          headword: { fontSize: style(expression).fontSize, colour: style(expression).color },
        };
      };
    }, readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"));
    const show = (value, options = {}, blur) => page.evaluate((...args) => window.headwordPitch(...args), value, options, blur);

    // 好き嫌い: the furigana with the pitch on is the furigana with it off, and
    // すききらい follows in the furigana's muted colour at three quarters of
    // the headword's size, as Yomitan's reading does.
    const plain = await show(KANJI, { showPitchAccentFurigana: false });
    const kanji = await show(KANJI);
    assert.deepEqual(plain.furigana, ["好す", "嫌きら"]);
    assert.deepEqual(kanji.furigana, plain.furigana);
    assert.equal(plain.reading, null);
    assert.deepEqual(kanji.reading, { text: "すききらい", fontSize: `${Number.parseFloat(kanji.headword.fontSize) * 0.75}px`,
      colour: kanji.rt.colour, filter: "none", userSelect: "none" });
    assert.equal(kanji.contour.inHeadword, true);
    assert.ok(kanji.lines.every(colour => colour && colour !== TRANSPARENT), JSON.stringify(kanji.lines));
    // Blur hides the reading as it hides the furigana.
    const blurredKanji = await show(KANJI, {}, "blurred");
    assert.deepEqual([blurredKanji.rt.filter, blurredKanji.reading.filter], ["blur(5px)", "blur(5px)"]);

    // てくてく: no furigana and no reading; the headword's own kana carry the
    // pitch, in its size and colour, and copying the headword copies the word.
    for (const pitchAccentFuriganaStyle of ["contour", "overline"]) {
      const kana = await show(KANA, { pitchAccentFuriganaStyle });
      assert.deepEqual([kana.furigana, kana.reading], [[], null], pitchAccentFuriganaStyle);
      assert.deepEqual(kana.contour, { inHeadword: true, text: "てくてく", fontSize: kana.headword.fontSize,
        colour: kana.headword.colour }, pitchAccentFuriganaStyle);
      assert.ok(kana.lines.every(colour => colour && colour !== TRANSPARENT), JSON.stringify(kana.lines));
      assert.equal(kana.copied, "てくてく", pitchAccentFuriganaStyle);
      // A double-click on the word selects the whole word, as it does with the
      // pitch off. On the middle of a word's last character Chrome selects the
      // line break after it instead, pitch or not, so that one is left out.
      await show(KANA, { pitchAccentFuriganaStyle });
      const moraCentres = await page.evaluate(() => [...document.querySelector("#host").shadowRoot
        .querySelectorAll(".gsm-hoshidicts-expression .gsm-hoshidicts-pitch-contour > *")].map(mora => {
        const box = mora.getBoundingClientRect();
        return [box.x + box.width / 2, box.y + box.height / 2];
      }).slice(0, -1));
      const doubleClicked = [];
      for (const [x, y] of moraCentres) {
        await page.mouse.click(x, y, { count: 2 });
        doubleClicked.push(await page.evaluate(() => getSelection().toString()));
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.mouse.move(0, 0);
        // Past the double-click interval, so the next press starts a new click.
        await new Promise(resolveWait => setTimeout(resolveWait, 600));
      }
      assert.deepEqual(doubleClicked, Array(3).fill("てくてく"), pitchAccentFuriganaStyle);
      // Blur cannot blur the word itself, so it hides only the pitch until the reveal.
      for (const blur of ["pending", "blurred"]) {
        const blurred = await show(KANA, { pitchAccentFuriganaStyle }, blur);
        assert.deepEqual(blurred.lines, kana.lines.map(() => TRANSPARENT), `${pitchAccentFuriganaStyle} ${blur}`);
        assert.deepEqual([blurred.contour.colour, blurred.headword], [kana.contour.colour, kana.headword]);
      }
      assert.deepEqual((await show(KANA, { pitchAccentFuriganaStyle })).lines, kana.lines);
    }

    // Forced colours (a Windows contrast theme) would paint each contour mora's
    // unused, transparent side too and box it in. The lines keep their sides,
    // in the system text colour, and blur still hides them.
    await page.emulateMediaFeatures([{ name: "forced-colors", value: "active" }]);
    for (const value of [KANJI, KANA]) {
      for (const pitchAccentFuriganaStyle of ["contour", "overline"]) {
        const what = `${value.term.expression} ${pitchAccentFuriganaStyle}`;
        const forced = await show(value, { pitchAccentFuriganaStyle });
        assert.ok(forced.lines.every(colour => colour && colour !== TRANSPARENT), `${what} ${JSON.stringify(forced.lines)}`);
        assert.deepEqual(forced.unused, forced.unused.map(() => TRANSPARENT), what);
        assert.deepEqual((await show(value, { pitchAccentFuriganaStyle }, "blurred")).lines,
          forced.lines.map(() => TRANSPARENT), what);
      }
    }
  } finally {
    await page.close();
  }
}
