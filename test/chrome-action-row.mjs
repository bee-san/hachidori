// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ACTION_ROW_CHECK = "Popup toolbar actions stay in one ordered row with deliberate narrow overflow";

export async function checkActionRow(browser, { screenshotDirectory } = {}) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 3440, height: 1440 });
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
      window.rowFixture = { root, popup, view, anki,
        render({ expression, reading, definitions, compact, navigation, links, overlay }) {
          request = {};
          view.setCustomLinks(links && !overlay ? [
            { label: "JMirror dictionary", url: "https://example.test/%w" },
            { label: "Jisho search", url: "https://example.test/second/%w" },
          ] : []);
          view.renderResults([{ matched: expression, term: {
            expression, reading, frequencies: [], pitches: [],
            glossaries: [{ dictionary: "row-layout", glossary: JSON.stringify(definitions) }],
          } }], { anchor: document.querySelector("p"), query: expression }, {
            showCompactDefinitionSummary: compact, compactDefinitionSummaryCount: 2,
            ...(navigation === "back" ? { onBack() {} } : {}),
            ...(navigation === "close" ? { onClose() {} } : {}),
          });
        },
        renderKanji({ links, overlay, navigation }) {
          view.setCustomLinks(links && !overlay ? [
            { label: "JMirror dictionary", url: "https://example.test/%w" },
            { label: "Jisho search", url: "https://example.test/second/%w" },
          ] : []);
          view.renderKanji({ character: "響", entries: [] },
            { anchor: document.querySelector("p"), query: "響" },
            navigation === "back" ? { onBack() {} } : {});
        },
      };
    }, [
      readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"),
      readFileSync(new URL("../extension/icons.css", import.meta.url), "utf8"),
    ].join("\n"));
    const cases = [
      { name: "resound", expression: "響く", reading: "ひびく", definitions: ["to resound", "to be heard far away"] },
      { name: "particle", expression: "が", reading: "", definitions: ['partial equivalent of the "no" particle in standard Japanese', "indicates the subject of a sentence"] },
      { name: "long", expression: "国際連合教育科学文化機関", reading: "こくさいれんごうきょういくかがくぶんかきかん", definitions: ["United Nations Educational, Scientific and Cultural Organization", "UNESCO"] },
    ];
    const variants = [
      { name: "browser-parent", compact: true, links: true,
        expected: ["anki", "audio", "note", "external", "external"] },
      { name: "browser-nested-close", compact: true, links: true, navigation: "close",
        expected: ["close", "anki", "audio", "note", "external", "external"] },
      { name: "browser-nested-back-large", compact: true, links: true, navigation: "back", large: true,
        expected: ["back", "anki", "audio", "note", "external", "external"] },
      { name: "overlay-parent", compact: true, overlay: true,
        expected: ["anki", "audio", "note"] },
      { name: "overlay-nested-close", compact: true, overlay: true, navigation: "close",
        expected: ["close", "anki", "audio", "note"] },
      { name: "kanji-nested-back", compact: false, links: true, navigation: "back", kanji: true,
        expected: ["back", "note", "external", "external"] },
      { name: "plain-parent", compact: false,
        expected: ["anki", "audio", "note"] },
    ];
    const evidence = [];
    for (const width of [560, 320, 200]) {
      for (const scenario of cases) {
        for (const variant of variants) {
          if (variant.kanji && scenario !== cases[0]) continue;
          await page.evaluate(({ width, scenario, variant }) => {
            const { root, popup, render, renderKanji } = window.rowFixture;
            if (variant.kanji) renderKanji(variant);
            else render({ ...scenario, ...variant });
            popup.style.width = `${width}px`;
            popup.style.setProperty("--gsm-hoshidicts-popup-scale", variant.large ? "150%" : "100%");
            document.querySelector("#host").dataset.hoshidictsTheme = variant.large ? "solarized-light" : "dark";
            const expression = root.querySelector(".gsm-hoshidicts-expression");
            if (expression) expression.style.fontSize = variant.large ? "48px" : "32px";
          }, { width, scenario, variant });
          await page.waitForFunction(expectMine => !expectMine
            || window.rowFixture.root.querySelector(".gsm-hoshidicts-mine-button")?.dataset.state === "ready",
          {}, variant.expected.includes("anki"));
          const geometry = await page.evaluate(() => {
            const { root, popup } = window.rowFixture;
            const rect = node => node.getBoundingClientRect().toJSON();
            const header = root.querySelector(".gsm-hoshidicts-primary-header");
            const actions = header.querySelector(":scope > .gsm-hoshidicts-entry-actions");
            const actionKind = node => {
              if (node.classList.contains("gsm-hoshidicts-popup-close")) return "close";
              if (node.classList.contains("gsm-hoshidicts-kanji-back")) return "back";
              if (node.classList.contains("gsm-hoshidicts-mine-button")) return "anki";
              if (node.classList.contains("gsm-hoshidicts-audio-control")) return "audio";
              if (node.classList.contains("gsm-hoshidicts-note-button")) return "note";
              if (node.classList.contains("gsm-hoshidicts-external-link-button")) return "external";
              return node.className;
            };
            const controls = [...actions.children].map(node => {
              const bounds = rect(node);
              const accessible = node.classList.contains("gsm-hoshidicts-audio-control")
                ? node.querySelector("button")
                : node;
              const label = node.querySelector(".gsm-hoshidicts-text-action-label");
              const labelStyle = label ? getComputedStyle(label) : null;
              return { bounds, kind: actionKind(node),
                name: accessible.getAttribute("aria-label") || accessible.title || accessible.textContent.trim(),
                label: label ? {
                  clientWidth: label.clientWidth,
                  scrollWidth: label.scrollWidth,
                  overflow: labelStyle.overflow,
                  textOverflow: labelStyle.textOverflow,
                } : null,
                hit: node.contains(root.elementFromPoint(
                  Math.max(bounds.left, actions.getBoundingClientRect().left) + 1,
                  bounds.top + bounds.height / 2,
                )) };
            });
            const actionsStyle = getComputedStyle(actions);
            const heading = root.querySelector(".gsm-hoshidicts-headword, .gsm-hoshidicts-kanji-navigation");
            return { actions: rect(actions), controls, popup: rect(popup), header: rect(header),
              heading: rect(heading),
              overflow: header.scrollWidth > header.clientWidth + 1,
              actionOverflow: actions.scrollWidth > actions.clientWidth + 1,
              actionScrollWidth: actions.scrollWidth,
              actionClientWidth: actions.clientWidth,
              actionOverflowX: actionsStyle.overflowX,
              actionRole: actions.getAttribute("role"),
              actionLabel: actions.getAttribute("aria-label"),
              summary: root.querySelector(".gsm-hoshidicts-compact-definition-items")?.textContent,
            };
          });
          evidence.push({ width, name: scenario.name, variant: variant.name, ...geometry });
          if (screenshotDirectory && width === 560 && scenario.name === "resound") {
            await page.screenshot({
              path: `${screenshotDirectory}/${variant.name}.png`,
              clip: {
                x: Math.floor(geometry.popup.x),
                y: Math.floor(geometry.popup.y),
                width: Math.ceil(geometry.popup.width),
                height: Math.ceil(geometry.popup.height),
              },
            });
          }
          const detail = JSON.stringify(evidence.at(-1));
          const expectedHeight = variant.large ? 54 : 36;
          assert.deepEqual(geometry.controls.map(({ kind }) => kind), variant.expected, `action order changed: ${detail}`);
          assert.equal(new Set(geometry.controls.map(({ bounds }) => Math.round(bounds.top))).size, 1,
            `actions split into rows: ${detail}`);
          assert.ok(geometry.controls.every(({ bounds, name }) => Math.abs(bounds.height - expectedHeight) < 1 && name),
            `action sizing or accessible name changed: ${detail}`);
          assert.ok(geometry.controls.filter(({ kind }) => kind === "external")
            .every(({ label }) => label?.overflow === "hidden" && label.textOverflow === "ellipsis"),
          `custom-link truncation is not explicit: ${detail}`);
          assert.ok(geometry.controls
            .filter(({ kind }) => kind === "close")
            .every(({ bounds }) => Math.abs(bounds.width - expectedHeight) < 1),
          `Close action is not square: ${detail}`);
          assert.ok(geometry.controls
            .filter(({ kind }) => kind === "back")
            .every(({ bounds }) => bounds.width >= expectedHeight),
          `Back action is narrower than the icon actions: ${detail}`);
          assert.ok(geometry.controls.every((control, index) =>
            index === 0 || geometry.controls[index - 1].bounds.right <= control.bounds.left),
          `action overlap: ${detail}`);
          assert.equal(geometry.actionOverflowX, "auto", `toolbar lacks deliberate horizontal overflow: ${detail}`);
          assert.equal(geometry.actionRole, "group", `toolbar accessibility role changed: ${detail}`);
          assert.equal(geometry.actionLabel, "Lookup actions", `toolbar accessible label changed: ${detail}`);
          assert.ok(geometry.actions.left >= geometry.popup.left
            && geometry.actions.right <= geometry.popup.right,
            `toolbar escapes popup: ${detail}`);
          assert.ok(geometry.heading.right <= geometry.actions.left + 1
            || geometry.heading.top >= geometry.actions.bottom - 1
            || geometry.actions.top >= geometry.heading.bottom - 1,
          `heading overlaps actions: ${detail}`);
          if (width === 200 && variant.links && !variant.overlay && !variant.kanji) {
            assert.ok(geometry.actionOverflow, `narrow browser actions do not expose overflow: ${detail}`);
          }
          if (!variant.links || variant.overlay) {
            assert.equal(geometry.actionOverflow, false, `short action row overflows: ${detail}`);
          }
          if (width === 560) {
            assert.equal(geometry.actionOverflow, false, `desktop toolbar unexpectedly overflows: ${detail}`);
            const contentBottom = geometry.heading.bottom;
            const controlBottom = Math.max(...geometry.controls.map(({ bounds }) => bounds.bottom));
            assert.ok(Math.abs(controlBottom - contentBottom) < 2.1,
              `desktop toolbar actions do not share the content row: ${detail}`);
          }
          if (variant.compact && !variant.kanji) assert.equal(geometry.summary, scenario.definitions.join(""));
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
    await page.evaluate(() => {
      const { root, popup, render } = window.rowFixture;
      render({ expression: "響く", reading: "ひびく", definitions: ["to resound"],
        compact: true, navigation: "close", links: true });
      popup.style.width = "200px";
      const actions = root.querySelector(".gsm-hoshidicts-primary-header > .gsm-hoshidicts-entry-actions");
      actions.scrollLeft = 0;
      actions.querySelector(".gsm-hoshidicts-popup-close").focus();
    });
    await page.waitForFunction(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-mine-button")?.dataset.state === "ready");
    const focusTrace = [];
    for (let index = 0; index < 6; index += 1) {
      focusTrace.push(await page.evaluate(() => {
        const { root } = window.rowFixture;
        const focused = root.activeElement;
        const actions = root.querySelector(".gsm-hoshidicts-primary-header > .gsm-hoshidicts-entry-actions");
        const bounds = focused.getBoundingClientRect();
        const viewport = actions.getBoundingClientRect();
        let kind = focused.className;
        if (focused.classList.contains("gsm-hoshidicts-popup-close")) kind = "close";
        else if (focused.classList.contains("gsm-hoshidicts-mine-button")) kind = "anki";
        else if (focused.classList.contains("gsm-hoshidicts-audio-button")) kind = "audio";
        else if (focused.classList.contains("gsm-hoshidicts-note-button")) kind = "note";
        else if (focused.classList.contains("gsm-hoshidicts-external-link-button")) kind = "external";
        const style = getComputedStyle(focused);
        const inToolbar = actions.contains(focused);
        return { inToolbar, kind, visible: focused === root.activeElement
          && (!inToolbar || (bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1)),
        outline: [style.outlineStyle, style.outlineWidth], scrollLeft: actions.scrollLeft };
      }));
      if (index < 5) await page.keyboard.press("Tab");
    }
    assert.deepEqual(focusTrace.map(({ kind }) => kind),
      ["close", "anki", "audio", "note", "external", "external"],
    `narrow keyboard order: ${JSON.stringify(focusTrace)}`);
    assert.ok(focusTrace.every(({ inToolbar, visible, outline }) =>
      inToolbar && visible && outline[0] !== "none" && outline[1] !== "0px"),
    `narrow focus visibility: ${JSON.stringify(focusTrace)}`);
    assert.ok(focusTrace.at(-1).scrollLeft > focusTrace[0].scrollLeft,
      `narrow toolbar did not scroll focused actions into view: ${JSON.stringify(focusTrace)}`);
    const note = await page.evaluate(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-note-button").getBoundingClientRect().toJSON());
    await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2);
    assert.ok(await page.evaluate(() => !window.rowFixture.root.querySelector(".gsm-hoshidicts-note-form").hidden), "pointer opens Note");
    await page.evaluate(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-note-button").focus());
    await page.keyboard.press("Enter");
    assert.ok(await page.evaluate(() => window.rowFixture.root.querySelector(".gsm-hoshidicts-note-form").hidden), "keyboard closes Note");
    const absent = await page.evaluate(() => {
      const { root, popup, anki, render } = window.rowFixture;
      anki.update({ anki: { model: "" } });
      render({ expression: "響く", reading: "ひびく", definitions: ["to resound"],
        compact: true, navigation: "back", links: true });
      popup.style.width = "200px";
      const buttons = [...root.querySelectorAll(".gsm-hoshidicts-audio-button, .gsm-hoshidicts-note-button, .gsm-hoshidicts-external-link-button, .gsm-hoshidicts-kanji-back")];
      return { mine: Boolean(root.querySelector(".gsm-hoshidicts-mine-button")), buttons: buttons.map(button => {
        const r = button.getBoundingClientRect();
        return { height: r.height, top: r.top };
      }) };
    });
    assert.equal(absent.mine, false, "disabled Anki omits mining control");
    assert.equal(absent.buttons.length, 5);
    assert.ok(absent.buttons.every(button => Math.abs(button.height - 36) < 1),
      "remaining controls keep their size without Anki");
    assert.equal(new Set(absent.buttons.map(({ top }) => Math.round(top))).size, 1,
      "Back, audio, Note and links stay aligned without Anki");
    console.log("PASS action row geometry", JSON.stringify(evidence));
  } finally {
    await page.close();
  }
}
