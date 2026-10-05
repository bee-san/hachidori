// The pinned header shows the result being read (#488), in real layout with
// the production renderer, reader stylesheet and Anki controller.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DYNAMIC_HEADWORD_CHECK = "the pinned header shows the result being read without moving definitions, and mines and plays that result";

const senses = (gloss, count) => Array.from({ length: count }, (_, index) => `${gloss} (sense ${index + 1})`);
// The last result only gives the third somewhere to scroll to.
const RESULTS = [["明日", "あした", "tomorrow"], ["明日", "あす", "tomorrow, formally"],
  ["明日", "みょうにち", "tomorrow, in business"], ["明後日", "あさって", "the day after tomorrow"]]
  .map(([expression, reading, gloss]) => ({ matched: "明日", deinflected: "明日", trace: [], preprocessorSteps: 0, term: {
    expression, reading, rules: "", score: 0, frequencies: [], pitches: [],
    glossaries: [{ dictionary: "Jisho", definitionTags: "n", glossary: JSON.stringify(senses(gloss, 6)) }],
  } }));

export async function checkDynamicHeadword(browser, { screenshotDirectory } = {}) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 700 });
    await page.setContent('<!doctype html><meta charset="utf-8"><p>明日は晴れる</p><div id="host"></div>');
    for (const file of ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js", "anki-content.js"]) {
      await page.addScriptTag({ path: fileURLToPath(new URL(`../extension/${file}`, import.meta.url)) });
    }
    await page.evaluate(({ css, results }) => {
      const host = document.querySelector("#host");
      const shadow = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:60px;width:560px;height:420px";
      shadow.append(popup);
      const submitted = [];
      const anki = HDAnki.createAnkiController({ onChange() {}, async send(type, fields) {
        if (type === "hd_anki_status") return { available: true, configKey: "headword" };
        if (type === "hd_anki_view") return { state: "unknown", canAdd: false, noteIds: [], configKey: "headword", cached: false };
        if (type === "hd_anki_preflight_batch") return { replies: fields.requests.map(() => ({ state: "addable", canAdd: true })) };
        if (type === "hd_anki_submit") {
          submitted.push([fields.request.templateId, fields.request.term.reading]);
          return { state: "added", noteId: submitted.length, warnings: [] };
        }
        return {};
      } });
      const base = HDReaderOptions.DEFAULT_ANKI_TEMPLATE;
      const customButtons = [{ id: "sentence-card", type: "anki", label: "Sentence card", templateId: "sentence" }];
      anki.update(HDReaderOptions.normaliseOptions({ customButtons, anki: { url: "http://127.0.0.1:8765", templates: [
        { ...base, id: "default", name: "Word", model: "Basic", fields: { ...base.fields, expression: "Front" } },
        { ...base, id: "sentence", name: "Sentence", model: "Sentence", fields: { ...base.fields, sentence: "Front" } },
      ] } }));
      const request = {};
      let scale = 100;
      let audio = [];
      const bind = ({ audioButtons, miningActions }) => {
        audio = audioButtons;
        anki.bind(miningActions, { owner: popup, popup, request, isCurrent: () => true, getRequest: result => ({ term: result.term }) });
      };
      const view = HDPopup.createPopupView({ document, window, popup, customButtons,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {},
        getPopupScalePercent: () => scale, onResultsRendered: bind, onResultsExpanded: bind,
      });
      const scroller = view.scrollElement;
      const header = () => shadow.querySelector(".gsm-hoshidicts-primary-header");
      const articles = () => [...scroller.querySelectorAll(".gsm-hoshidicts-entry")];
      const shown = node => node.getClientRects().length > 0;
      const kind = node => ["mine-button", "audio-control", "note-button", "custom-anki-button"]
        .find(name => node.classList.contains(`gsm-hoshidicts-${name}`)) ?? node.className;
      window.headwordFixture = {
        shadow, view, submitted,
        render(toolbar = "top", percent = 100) {
          scale = percent;
          popup.style.setProperty("--gsm-hoshidicts-popup-scale", `${percent}%`);
          view.setToolbarPosition(toolbar);
          view.renderResults(results, { anchor: document.querySelector("p"), query: "明日" }, { expandAll: true });
          scroller.scrollTop = 0;
        },
        // Later results' bodies fill on the next task.
        filled: () => [...scroller.querySelectorAll(".gsm-hoshidicts-glossary-content")].every(node => node.textContent),
        // Scroll the result's own header just past the definitions' top edge.
        scrollPast(index) {
          const slot = articles()[index].querySelector(":scope > .gsm-hoshidicts-entry-header");
          scroller.scrollTop += (slot.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top)
            * 100 / scale + 2;
          return this.cards();
        },
        // Card tops in the scroller's own coordinates, read before the scroll event.
        cards() {
          const top = scroller.getBoundingClientRect().top;
          return [...scroller.querySelectorAll(".gsm-hoshidicts-glossary-card")]
            .map(card => (card.getBoundingClientRect().top - top) * 100 / scale);
        },
        state() {
          const pinned = header();
          const headwords = [...pinned.querySelectorAll(":scope > .gsm-hoshidicts-headword")].filter(shown);
          const row = pinned.querySelector(":scope > .gsm-hoshidicts-entry-actions");
          const controls = [...row.querySelectorAll(".gsm-hoshidicts-mine-button, .gsm-hoshidicts-audio-control, "
            + ".gsm-hoshidicts-note-button, .gsm-hoshidicts-custom-anki-button")].filter(shown);
          const focused = shadow.activeElement;
          return {
            readings: headwords.map(node => [...node.querySelectorAll("rt")].map(rt => rt.textContent).join("")),
            kinds: controls.map(kind), tops: controls.map(node => Math.round(node.getBoundingClientRect().top)),
            audio: controls.filter(node => kind(node) === "audio-control")
              .map(node => node.querySelector("button").getAttribute("aria-label")),
            states: controls.filter(node => node.dataset.state).map(node => node.dataset.state),
            // Which result's own pronunciation button has focus.
            focusedAudio: audio.findIndex(item => item.button === focused),
            pinnedBelow: pinned.getBoundingClientRect().top >= scroller.getBoundingClientRect().bottom - 1,
          };
        },
        slotBottom(index) {
          return (articles()[index].querySelector(":scope > .gsm-hoshidicts-entry-header").getBoundingClientRect().bottom
            - scroller.getBoundingClientRect().top) * 100 / scale;
        },
        controlCenter(selector) {
          const control = [...header().querySelectorAll(selector)].find(shown);
          const rect = control.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, state: control.dataset.state };
        },
        focus(selector) { [...header().querySelectorAll(selector)].find(shown).focus(); },
      };
    }, { css: [readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"),
      readFileSync(new URL("../extension/icons.css", import.meta.url), "utf8")].join("\n"), results: RESULTS });

    const evaluate = (fn, ...args) => page.evaluate(fn, ...args);
    const render = async (toolbar = "top", percent = 100) => {
      await evaluate((value, scale) => window.headwordFixture.render(value, scale), toolbar, percent);
      await page.waitForFunction(() => window.headwordFixture.filled(), { timeout: 3000 });
    };
    const reading = expected => page.waitForFunction(value => JSON.stringify(window.headwordFixture.state().readings)
      === JSON.stringify([value]), { timeout: 3000 }, expected).then(() => true, () => false);
    const ready = selector => page.waitForFunction(value => window.headwordFixture.controlCenter(value).state === "ready",
      { timeout: 3000 }, selector);
    const shoot = async name => {
      if (!screenshotDirectory) return;
      await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, clip: { x: 10, y: 50, width: 580, height: 440 } });
    };
    const evidence = [];
    // Each scroll compares the cards at one scroll position before and after the swap.
    const scrollPast = async (index, expected, toolbar) => {
      const before = await evaluate(value => window.headwordFixture.scrollPast(value), index);
      const swapped = await reading(expected);
      const after = await evaluate(() => window.headwordFixture.cards());
      const state = await evaluate(() => window.headwordFixture.state());
      evidence.push({ toolbar, index, expected, swapped, before, after, state });
      const detail = JSON.stringify(evidence.at(-1));
      assert.ok(swapped, `the pinned header did not show ${expected}: ${detail}`);
      assert.ok(after.every((top, position) => Math.abs(top - before[position]) < 0.5), `definitions moved: ${detail}`);
      return state;
    };

    for (const [toolbar, percent] of [["top", 100], ["bottom", 100], ["top", 125]]) {
      await render(toolbar, percent);
      assert.ok(await reading("あした"), `${toolbar} ${percent}%: the first result is shown first`);
      if (toolbar === "top" && percent === 100) await shoot("1-first-result");
      const state = await scrollPast(1, "あす", `${toolbar} ${percent}%`);
      const detail = JSON.stringify(state);
      assert.deepEqual(state.kinds, ["mine-button", "audio-control", "note-button", "custom-anki-button"], detail);
      assert.equal(new Set(state.tops).size, 1, `the pinned actions split into rows: ${detail}`);
      assert.deepEqual(state.audio, ["Play pronunciation for 明日"], detail);
      assert.equal(state.pinnedBelow, toolbar === "bottom", `the pinned header left its edge: ${detail}`);
      if (toolbar === "top" && percent === 100) await shoot("2-scrolled-to-asu");
      if (toolbar === "bottom") await shoot("4-bottom-toolbar-asu");
      // Scrolling back restores the first result without moving anything.
      const back = await evaluate(() => {
        const fixture = window.headwordFixture;
        fixture.view.scrollElement.scrollTop = 0;
        return fixture.cards();
      });
      assert.ok(await reading("あした"), `${toolbar} ${percent}%: scrolling back shows the first result`);
      const restored = await evaluate(() => window.headwordFixture.cards());
      assert.ok(restored.every((top, position) => Math.abs(top - back[position]) < 0.5), "scrolling back moved definitions");
    }

    // Anki, custom Anki and pronunciation act on the shown result.
    await render();
    await scrollPast(1, "あす", "mining");
    for (const selector of [".gsm-hoshidicts-mine-button", ".gsm-hoshidicts-custom-anki-button"]) {
      await ready(selector);
      const { x, y } = await evaluate(value => window.headwordFixture.controlCenter(value), selector);
      await page.mouse.click(x, y);
      await page.waitForFunction(value => window.headwordFixture.controlCenter(value).state === "success",
        { timeout: 3000 }, selector);
    }
    assert.deepEqual(await evaluate(() => window.headwordFixture.submitted), [["default", "あす"], ["sentence", "あす"]]);

    // Focus on a leaving control moves to the incoming result's control.
    await render();
    await evaluate(() => window.headwordFixture.focus(".gsm-hoshidicts-audio-button"));
    const focused = await scrollPast(1, "あす", "focus");
    assert.equal(focused.focusedAudio, 1, `focus did not follow the shown result: ${JSON.stringify(focused)}`);

    // A focused custom Anki button holds the header: re-checking it for another
    // result would disable it, and Chrome would then take its focus.
    await render();
    await ready(".gsm-hoshidicts-custom-anki-button");
    await evaluate(() => window.headwordFixture.focus(".gsm-hoshidicts-custom-anki-button"));
    await evaluate(() => window.headwordFixture.scrollPast(1));
    const held = await evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done({
      readings: window.headwordFixture.state().readings,
      custom: window.headwordFixture.shadow.activeElement?.classList.contains("gsm-hoshidicts-custom-anki-button") === true,
    })))));
    assert.deepEqual(held, { readings: ["あした"], custom: true }, "a focused custom Anki button lost focus or its result");
    await evaluate(() => window.headwordFixture.focus(".gsm-hoshidicts-note-button"));
    assert.ok(await reading("あす"), "the header catches up once focus leaves the custom Anki button");

    // Go to next entry leaves its header just under the pinned one.
    await evaluate(() => window.headwordFixture.view.focusEntry({ offset: 1 }));
    assert.ok(await reading("みょうにち"), "navigation shows its target");
    const slot = await evaluate(() => window.headwordFixture.slotBottom(2));
    assert.ok(Math.abs(slot) < 1, `navigation left its target's header at ${slot}`);
    assert.equal(await evaluate(() => window.headwordFixture.view.currentEntryIndex()), 2);
    await shoot("3-next-entry-myounichi");

    // Screen readers hear the shown headword once: the first is hidden.
    const root = await page.evaluateHandle(() => window.headwordFixture.shadow.querySelector(".gsm-hoshidicts-popup"));
    const tree = await page.accessibility.snapshot({ root, interestingOnly: false });
    await root.dispose();
    const names = [];
    const walk = node => { if (node.name) names.push(node.name); node.children?.forEach(walk); };
    walk(tree);
    const spoken = reading => names.filter(name => name === `明日, ${reading}`).length;
    assert.deepEqual([spoken("あした"), spoken("あす"), spoken("みょうにち")], [0, 1, 1], JSON.stringify(names));
    console.log("PASS dynamic headword", JSON.stringify(evidence));
  } finally {
    await page.close();
  }
}
