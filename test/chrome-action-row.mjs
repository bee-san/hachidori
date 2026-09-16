// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ACTION_ROW_CHECK = "Popup action icons stay together across headwords, compact summaries and narrow views";

export async function checkActionRow(browser, { screenshotDirectory } = {}) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1100, height: 850 });
    await page.setContent('<p>響く が</p><div id="host"></div>');
    for (const file of ["external-links.js", "render/glossary.js", "render/popup.js", "anki-content.js"]) {
      await page.addScriptTag({ path: fileURLToPath(new URL(`../extension/${file}`, import.meta.url)) });
    }
    await page.evaluate(css => {
      const root = document.querySelector("#host").attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = css;
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:60px";
      root.append(style, popup);
      const anki = HDAnki.createAnkiController({ onChange() {}, async send(type) {
        if (type === "hd_anki_status") return { available: true, configKey: "row" };
        if (type === "hd_anki_preflight") return { state: "addable", canAdd: true };
        return {};
      } });
      anki.update({ anki: { model: "row" } });
      let request;
      const view = HDPopup.createPopupView({ document, window, popup,
        appendExpressionRuby: HDGlossary.appendExpressionRuby,
        appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
        parseTagList: HDGlossary.parseTagList, positionPopup() {},
        onResultsRendered({ miningActions }) {
          anki.bind(miningActions, { owner: popup, popup, request, isCurrent: () => true, getRequest: () => ({}) });
        },
      });
      window.rowFixture = { root, popup, view, anki, render({ expression, reading, definitions, compact, nested, links }) {
        request = {};
        view.setCustomLinks(links ? [
          { label: "A longer custom dictionary link", url: "https://example.test/%w" },
          { label: "📚", url: "https://example.test/second/%w" },
        ] : []);
        view.renderResults([{ matched: expression, term: {
          expression, reading, frequencies: [], pitches: [],
          glossaries: [{ dictionary: "row-layout", glossary: JSON.stringify(definitions) }],
        } }], { anchor: document.querySelector("p"), query: expression }, {
          showCompactDefinitionSummary: compact, compactDefinitionSummaryCount: 2,
          ...(nested ? { onBack() {} } : {}),
        });
      } };
    }, readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"));
    const cases = [
      { name: "resound", expression: "響く", reading: "ひびく", definitions: ["to resound", "to be heard far away"] },
      { name: "particle", expression: "が", reading: "", definitions: ['partial equivalent of the "no" particle in standard Japanese', "indicates the subject of a sentence"] },
      { name: "long", expression: "国際連合教育科学文化機関", reading: "こくさいれんごうきょういくかがくぶんかきかん", definitions: ["United Nations Educational, Scientific and Cultural Organization", "UNESCO"] },
    ];
    const evidence = [];
    for (const width of [560, 320, 200]) {
      for (const scenario of cases) {
        for (const variant of ["normal", "large-nested", "plain", "links"]) {
          await page.evaluate(({ width, scenario, variant }) => {
            const { root, popup, render } = window.rowFixture;
            render({ ...scenario, compact: variant !== "plain", nested: variant === "large-nested", links: variant === "links" });
            popup.style.width = `${width}px`;
            popup.style.setProperty("--gsm-hoshidicts-popup-scale", variant === "large-nested" ? "150%" : "100%");
            document.querySelector("#host").dataset.hoshidictsTheme = variant === "large-nested" ? "solarized-light" : "dark";
            root.querySelector(".gsm-hoshidicts-expression").style.fontSize = variant === "large-nested" ? "48px" : "32px";
          }, { width, scenario, variant });
          await page.waitForFunction(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-mine-button")?.dataset.state === "ready");
          const geometry = await page.evaluate(() => {
            const { root, popup } = window.rowFixture;
            const buttons = ["mine", "audio", "note"].map(name => root.querySelector(`.gsm-hoshidicts-${name}-button`));
            const rect = node => node.getBoundingClientRect().toJSON();
            const header = root.querySelector(".gsm-hoshidicts-primary-header");
            const extras = [...root.querySelectorAll(".gsm-hoshidicts-external-link-button, .gsm-hoshidicts-kanji-back")];
            return { buttons: buttons.map(rect), popup: rect(popup), header: rect(header),
              headword: rect(root.querySelector(".gsm-hoshidicts-headword")),
              hit: buttons.every(button => { const r = rect(button); return button.contains(root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }),
              overflow: header.scrollWidth > header.clientWidth + 1,
              extras: extras.map(node => { const r = rect(node); return { ...r, hit: node.contains(root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; }),
              summary: root.querySelector(".gsm-hoshidicts-compact-definition-items")?.textContent,
            };
          });
          evidence.push({ width, name: scenario.name, variant, ...geometry });
          if (screenshotDirectory && width === 560 && variant === "normal") {
            await page.screenshot({ path: `${screenshotDirectory}/${scenario.name}.png` });
          }
          const detail = JSON.stringify(evidence.at(-1));
          const [mine, audio, note] = geometry.buttons;
          assert.ok(Math.abs(mine.top - audio.top) < 1 && Math.abs(audio.top - note.top) < 1, `icons split into rows: ${detail}`);
          assert.ok(mine.right <= audio.left && audio.right <= note.left, `icon order/overlap: ${detail}`);
          assert.ok(geometry.hit && !geometry.overflow && note.right <= geometry.popup.right, `inaccessible toolbar: ${detail}`);
          assert.ok(geometry.headword.right <= mine.left + 1 || geometry.headword.top >= mine.bottom - 1, `heading overlaps icons: ${detail}`);
          assert.equal(geometry.extras.length, variant === "large-nested" ? 1 : variant === "links" ? 2 : 0);
          assert.ok(geometry.extras.every(r => r.hit && r.right <= geometry.popup.right), `custom link or Back inaccessible: ${detail}`);
          const reference = evidence.find(row => row.width === width && row.variant === variant);
          assert.equal(mine.top - geometry.header.top, reference.buttons[0].top - reference.header.top, `toolbar moves with heading height: ${detail}`);
          if (variant !== "plain") assert.equal(geometry.summary, scenario.definitions.join(""));
        }
      }
    }
    await page.evaluate(() => {
      const { root, popup, render } = window.rowFixture;
      render({ expression: "が", reading: "", definitions: ["subject particle"], compact: true });
      popup.style.width = "320px";
      popup.style.setProperty("--gsm-hoshidicts-popup-scale", "100%");
      root.querySelector(".gsm-hoshidicts-audio-button").dataset.state = "loading";
    });
    await page.waitForFunction(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-mine-button")?.dataset.state === "ready");
    const states = await page.evaluate(() => {
      const { root } = window.rowFixture;
      const audio = root.querySelector(".gsm-hoshidicts-audio-button");
      const note = root.querySelector(".gsm-hoshidicts-note-button");
      return ["loading", "error", "idle"].map(state => {
        audio.dataset.state = state;
        audio.disabled = state === "loading";
        return { audio: audio.getBoundingClientRect().toJSON(), note: note.getBoundingClientRect().toJSON() };
      });
    });
    for (const state of states) {
      assert.equal(state.audio.top, state.note.top, "loading/disabled actions retain row");
      assert.equal(state.note.top, states[0].note.top, "state updates retain toolbar height");
    }
    const note = await page.evaluate(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-note-button").getBoundingClientRect().toJSON());
    await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2);
    assert.ok(await page.evaluate(() => !window.rowFixture.root.querySelector(".gsm-hoshidicts-note-form").hidden), "pointer opens Note");
    await page.evaluate(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-note-button").focus());
    await page.keyboard.press("Enter");
    assert.ok(await page.evaluate(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-note-form").hidden), "keyboard closes Note");
    const absent = await page.evaluate(() => {
      const { root, popup, anki, render } = window.rowFixture;
      anki.update({ anki: { model: "" } });
      render({ expression: "響く", reading: "ひびく", definitions: ["to resound"], compact: true, nested: true, links: true });
      popup.style.width = "200px";
      const buttons = [...root.querySelectorAll(".gsm-hoshidicts-audio-button, .gsm-hoshidicts-note-button, .gsm-hoshidicts-external-link-button, .gsm-hoshidicts-kanji-back")];
      return { mine: Boolean(root.querySelector(".gsm-hoshidicts-mine-button")), buttons: buttons.map(button => {
        const r = button.getBoundingClientRect();
        return { top: r.top, hit: button.contains(root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      }) };
    });
    assert.equal(absent.mine, false, "disabled Anki omits mining control");
    assert.equal(absent.buttons.length, 5);
    assert.ok(absent.buttons.every(button => button.hit), "remaining controls stay reachable without Anki");
    assert.equal(absent.buttons[1].top, absent.buttons[2].top, "audio and Note stay aligned without Anki");
    console.log("PASS action row geometry", JSON.stringify(evidence));
  } finally {
    await page.close();
  }
}
