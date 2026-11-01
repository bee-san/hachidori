/*
 * The reader in web pages: hover lookups and the popup they render, frames,
 * nested lookups, kanji, keybinds, selections, lookup counts, definition blur,
 * popup themes, custom CSS and the toolbar switch.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./import.mjs";
import { describe } from "node:test";
import { check, step } from "./harness.mjs";
import {
  characterPoint, clickInPopup, dismissPopup, highlightSize, hoverForPopup, inPopup, openExtensionPage, openPage, page,
  readPopup, readStorage, sendRuntime, serverUrl, sleep, waitFor, writeOptions,
  activate,
} from "./session.mjs";

let tab = null;

const blurState = target => inPopup(target, `root => {
  const popup = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
  return popup && !popup.hidden ? popup.dataset.definitionBlurState ?? "revealed" : null;
}`);

const rendererName = target => inPopup(target, "root => root.host.dataset.hoshidictsRenderer ?? null");

// The page text a hover just highlighted.
const highlighted = target => target.evaluate(() => [...(CSS.highlights.get("gsm-hoshidicts-match") ?? [])]
  .map(range => range.toString()));

// Waits out a hover that must not open a popup.
async function hoverWithoutPopup(target, selector) {
  const point = await characterPoint(target, selector, 0);
  // Shift scans the word under a resting pointer, so it goes down over this text.
  await target.mouse.move(point.x, point.y);
  await target.keyboard.down("Shift");
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await target.mouse.move(point.x + (attempt % 2), point.y);
      await sleep(150);
    }
  } finally {
    await target.keyboard.up("Shift");
  }
  return readPopup(target);
}

describe("reader", () => {
  step("hovering words", async () => {
    tab = await openPage(`${serverUrl}/`);
    const shown = await hoverForPopup(tab, "#verb");
    check("hovering 食べたかった with Shift shows a popup", shown !== null, JSON.stringify(shown));
    check("the popup shows the deinflected headword 食べる with its furigana",
      shown?.headword === "食べる" && shown.reading.includes("た") && shown.plain.includes("to eat"),
      JSON.stringify(shown));
    const marked = await highlighted(tab);
    check("the extension's highlight marks the source word", marked.includes("食べたかった"), JSON.stringify(marked));
    check("the popup shows the fixture's frequency and pitch accents",
      shown?.frequencies.some(text => text.includes("142位")) && shown.pitches.length === 3
        && shown.pitches.some(text => text.includes("[2]")),
      JSON.stringify({ frequencies: shown?.frequencies, pitches: shown?.pitches }));

    await dismissPopup(tab);
    const kanji = await hoverForPopup(tab, "#kanjiword");
    check("hovering 漢字 shows its structured content: bold span, list and table",
      kanji?.headword === "漢字" && kanji.bold.includes("span:Chinese characters")
        && kanji.lists.some(list => JSON.stringify(list) === JSON.stringify(["kanji", "Han characters"]))
        && kanji.tables.some(table => JSON.stringify(table) === JSON.stringify([["on", "カン"], ["kun", "あざ"]])),
      JSON.stringify(kanji));
    const image = await waitFor(async () => {
      const popup = await readPopup(tab);
      return popup?.images.find(source => source.startsWith("data:image/png;base64,")) ?? false;
    }, { timeout: 10_000 });
    check("a structured-content image resolves through hd_media to a data: URL", image !== null,
      JSON.stringify((await readPopup(tab))?.images));

    // A popup shows just before and just after the Latin hover, so the reader
    // was live while Latin text looked nothing up.
    check("the popup is showing immediately before the non-Japanese hover", (await readPopup(tab)) !== null);
    await dismissPopup(tab);
    const latin = await hoverWithoutPopup(tab, "#latin");
    check("hovering non-Japanese text shows no popup", latin === null && (await highlightSize(tab)) === 0, JSON.stringify(latin));
    const again = await hoverForPopup(tab, "#kanjiword");
    check("the same hover shows a popup again after the non-Japanese one", again?.headword === "漢字", JSON.stringify(again));
    await tab.keyboard.press("Escape");
    const hidden = await waitFor(async () => (await readPopup(tab)) === null && (await highlightSize(tab)) === 0, { timeout: 5_000 });
    check("Escape hides the popup and clears the highlight", hidden === true);
  });

  step("frames, nested lookups, kanji and keybinds", async () => {
    const framed = await openPage(`${serverUrl}/framed`);
    const frame = await waitFor(async () => framed.frames().find(child => child.url().endsWith("/frame")) ?? false);
    const offset = await framed.evaluate(() => {
      const rect = document.getElementById("frame").getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    });
    let inFrame = null;
    if (frame) {
      await waitFor(() => frame.evaluate(() => document.readyState === "complete"));
      const point = await characterPoint(frame, "#frame-verb", 0);
      await framed.keyboard.down("Shift");
      for (let attempt = 0; attempt < 30 && inFrame === null; attempt += 1) {
        await framed.mouse.move(offset.x + point.x + (attempt % 2), offset.y + point.y);
        await sleep(150);
        inFrame = await readPopup(frame).catch(() => null);
      }
      await framed.keyboard.up("Shift");
    }
    const topPopup = await readPopup(framed);
    check("a page loaded in a frame gets its own reader", inFrame?.headword === "食べる" && topPopup === null,
      JSON.stringify({ frame: frame?.url(), inFrame, topPopup }));
    await framed.close();

    await activate(tab);
    const cat = await hoverForPopup(tab, "#cat");
    const target = await inPopup(tab, `root => {
      const popup = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
      const walker = popup.ownerDocument.createTreeWalker(popup, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf("食べる");
        if (at < 0 || node.parentElement.closest(".gsm-hoshidicts-result-chrome")) continue;
        const range = popup.ownerDocument.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return null;
    }`);
    let child = null;
    if (target) {
      await tab.mouse.move(target.x, target.y);
      await tab.keyboard.down("Shift");
      for (let attempt = 0; attempt < 20 && child === null; attempt += 1) {
        await tab.mouse.move(target.x + (attempt % 2), target.y);
        await sleep(150);
        child = await readPopup(tab, 1);
      }
      await tab.keyboard.up("Shift");
    }
    check("hovering a word in the definitions opens a nested popup",
      cat?.plain.includes("likes to 食べる fish") && child?.headword === "食べる", JSON.stringify({ cat: cat?.plain, target, child }));
    await dismissPopup(tab);

    const word = await hoverForPopup(tab, "#verb");
    await clickInPopup(tab, ".gsm-hoshidicts-kanji-link");
    const kanjiView = await waitFor(async () => {
      const shown = await readPopup(tab);
      return shown?.text.includes("ショク") && shown.text.includes("food") ? shown : false;
    }, { timeout: 10_000 });
    await clickInPopup(tab, ".gsm-hoshidicts-kanji-back");
    const back = await waitFor(async () => {
      const shown = await readPopup(tab);
      return shown?.headword === "食べる" ? shown : false;
    }, { timeout: 10_000 });
    check("clicking a headword kanji opens its kanji entry and Back returns to the word",
      word?.headword === "食べる" && kanjiView !== null && back !== null, JSON.stringify({ kanjiView: kanjiView?.text, back: back?.headword }));

    // Next entry scrolls the next result's header to the top of the definitions
    // and Previous entry scrolls back to the first.
    const scrolled = () => inPopup(tab, "root => root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth=\"0\"] .gsm-hoshidicts-content-scroll')?.scrollTop ?? null");
    const press = async key => {
      await tab.keyboard.down("Alt");
      await tab.keyboard.press(key);
      await tab.keyboard.up("Alt");
    };
    const start = await scrolled();
    await press("ArrowDown");
    const down = await waitFor(async () => {
      const top = await scrolled();
      return top > start ? top : false;
    }, { timeout: 5_000 });
    await press("ArrowUp");
    const up = await waitFor(async () => (await scrolled()) === 0 || false, { timeout: 5_000 });
    check("an Alt+ArrowDown keybind moves to the next entry", start === 0 && down > 0 && up === true,
      JSON.stringify({ start, down, up }));
    await dismissPopup(tab);
  });

  step("selections, counts and blur", async () => {
    const box = await tab.evaluate(() => {
      const rect = document.getElementById("select").getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    });
    await tab.mouse.move(box.left + 1, box.y);
    await tab.mouse.down();
    await tab.keyboard.down("Shift");
    await tab.mouse.move(box.right - 1, box.y, { steps: 8 });
    await tab.mouse.up();
    await tab.keyboard.up("Shift");
    const selected = await waitFor(() => readPopup(tab), { timeout: 10_000 });
    const selection = await tab.evaluate(() => getSelection().toString());
    check("selecting text with Shift held looks up exactly the selection",
      selection === "ありがとう" && selected?.headword === "ありがとう" && selected.plain.includes("thank you"),
      JSON.stringify({ selection, selected }));
    await tab.evaluate(() => getSelection().removeAllRanges());
    await dismissPopup(tab);

    await hoverForPopup(tab, "#verb");
    // The count line is painted after the definitions.
    const counted = await waitFor(async () => {
      const shown = await readPopup(tab);
      return /Looked up \d+ times?/u.test(shown?.text ?? "") ? shown : false;
    }, { timeout: 10_000 });
    const stats = await sendRuntime(page, { target: "hoshidicts-worker", type: "hd_lookup_stats_read", requestId: "stats",
      term: "食べる", reading: "たべる" });
    check("lookup counts are recorded and shown in the popup",
      /Looked up \d+ times?/u.test(counted?.text ?? "") && JSON.stringify(stats).includes("lookupCount"),
      JSON.stringify({ text: counted?.text, stats }));
    await dismissPopup(tab);

    await writeOptions(page, { showLookupCounts: true, definitionBlurCountEnabled: true, definitionBlurDirection: "atLeast",
      definitionBlurThreshold: 1, definitionBlurReveal: "click" });
    await hoverForPopup(tab, "#verb");
    const blurred = await waitFor(async () => (await blurState(tab)) === "blurred" || false, { timeout: 10_000 });
    await clickInPopup(tab, ".gsm-hoshidicts-definitions");
    const revealed = await waitFor(async () => (await blurState(tab)) === "revealed" || false, { timeout: 5_000 });
    check("definition blur hides definitions for a word looked up enough times and a click reveals them",
      blurred === true && revealed === true, JSON.stringify({ blurred, revealed, state: await blurState(tab) }));
    await writeOptions(page, { definitionBlurCountEnabled: false });
    await dismissPopup(tab);
  });

  step("themes, custom CSS and the toolbar", async () => {
    const themes = {};
    const renderers = await page.evaluate(() => [...HDReaderOptions.POPUP_RENDERER_IDS]);
    for (const theme of [...renderers, "auto"]) {
      await writeOptions(page, { popupTheme: theme });
      await sleep(200);
      const shown = await hoverForPopup(tab, "#verb");
      themes[theme] = { renderer: await rendererName(tab), text: shown?.plain.includes("to eat") ?? false };
      await dismissPopup(tab);
    }
    check("each bundled popup theme renders the lookup",
      renderers.length > 0 && renderers.every(theme => themes[theme].renderer === theme && themes[theme].text)
        && themes.auto.renderer === "default" && themes.auto.text,
      JSON.stringify(themes));

    await writeOptions(page, { customPopupCss: ".gsm-hoshidicts-popup { outline: 7px solid rgb(1, 2, 3) !important; }" });
    await hoverForPopup(tab, "#verb");
    const outline = await waitFor(() => inPopup(tab, `root => {
      const popup = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
      const style = popup.ownerDocument.defaultView.getComputedStyle(popup);
      return style.outlineColor === "rgb(1, 2, 3)" && style.outlineWidth === "7px" ? style.outlineColor : false;
    }`), { timeout: 5_000 });
    check("custom popup CSS applies to the popup", outline === "rgb(1, 2, 3)", JSON.stringify(outline));
    await writeOptions(page, { customPopupCss: "" });
    await dismissPopup(tab);

    const toolbar = await openExtensionPage("toolbar.html");
    const enabled = async () => (await readStorage(page, ["options"])).options?.hoverEnabled !== false;
    const toggle = async () => {
      const before = await enabled();
      await waitFor(() => toolbar.evaluate(() => document.getElementById("lookup-toggle")?.disabled === false || false));
      await toolbar.evaluate(() => document.getElementById("lookup-toggle").click());
      const changed = await waitFor(async () => ((await enabled()) === !before ? { enabled: !before } : false),
        { timeout: 5_000 });
      return changed?.enabled ?? null;
    };
    const off = await toggle();
    await activate(tab);
    const whileOff = await hoverWithoutPopup(tab, "#verb");
    const on = await toggle();
    await activate(tab);
    const whileOn = await hoverForPopup(tab, "#verb");
    check("the toolbar switch turns lookups off and on", off === false && whileOff === null && on === true && whileOn !== null,
      JSON.stringify({ off, whileOff, on, whileOn: whileOn?.headword }));
    await dismissPopup(tab);
    await toolbar.close();
  });
});

export { tab };
