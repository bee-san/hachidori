/*
 * The reader on a web page: hovering, placement, zoom, glyph boxes and wheels.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./custom-dictionary.mjs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { checkPopupResize } from "../chrome-popup-resize.mjs";
import { check, diagnostics, HIGHLIGHT_NAME, step } from "./harness.mjs";
import { replacedPackage } from "./import.mjs";
import { hoverForPopup, popupReader } from "./popup-reader.mjs";
import { browser, FIXTURE_ALIAS, page, pageUrl } from "./session.mjs";

async function checkHoverHitTesting(tab, popup) {
  const outcomes = [];
  await tab.evaluate(() => {
    const fixture = document.createElement("section");
    fixture.id = "hover-hit-fixture";
    fixture.style.cssText = "position:fixed;inset:0;background:#fff;color:#222;z-index:1000;font:28px sans-serif";
    fixture.innerHTML = '<h2 style="font:22px sans-serif;margin:24px">Hover glyph hit testing</h2>'
      + '<a id="hover-hit-label" style="position:absolute;left:64px;top:100px;width:200px;height:96px;padding:12px 24px;background:#edf2f7">食べたかった</a>'
      + '<a id="hover-hit-vertical" style="position:absolute;left:400px;top:100px;width:96px;height:260px;padding:24px 12px;background:#edf2f7;writing-mode:vertical-rl">食べたかった</a>'
      + '<div id="hover-hit-cover" hidden style="position:absolute;left:64px;top:100px;width:248px;height:120px"></div>'
      + '<div id="hover-hit-pointer" style="position:fixed;width:10px;height:10px;border:2px solid #dc2626;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none"></div>';
    document.body.append(fixture);
  });
  try {
    const points = await tab.evaluate(() => {
      const point = (id, vertical) => {
        const node = document.getElementById(id).firstChild;
        const range = document.createRange();
        range.setStart(node, 0); range.setEnd(node, 1);
        const rect = range.getBoundingClientRect();
        return { glyph: { x: rect.left + rect.width * .7, y: rect.top + rect.height * .7 },
          padding: { x: rect.left - 20, y: rect.top + rect.height / 2 },
          below: { x: rect.left + rect.width / 2, y: rect.bottom + (vertical ? 220 : 20) } };
      };
      return { horizontal: point("hover-hit-label", false), vertical: point("hover-hit-vertical", true) };
    });
    async function move(name, point, expected) {
      await tab.keyboard.press("Escape");
      await popup.waitForHidden();
      await tab.mouse.move(2, 2);
      await tab.evaluate(({ x, y }) => {
        const marker = document.getElementById("hover-hit-pointer");
        marker.style.left = `${x}px`; marker.style.top = `${y}px`;
      }, point);
      await tab.mouse.move(point.x, point.y);
      // The negative assertion waits through the same real hover scheduling as a hit.
      const visible = await popup.waitForVisible(expected ? 3000 : 350);
      outcomes.push({ name, expected, visible: visible !== null,
        correct: expected ? visible?.plain.includes("食べる") === true : visible === null });
      if (process.env.HACHIDORI_HOVER_SCREENSHOTS) {
        mkdirSync(process.env.HACHIDORI_HOVER_SCREENSHOTS, { recursive: true });
        await tab.screenshot({ path: resolve(process.env.HACHIDORI_HOVER_SCREENSHOTS, `${name}.png`) });
      }
    }
    await move("glyph", points.horizontal.glyph, true);
    await move("padding", points.horizontal.padding, false);
    await move("below-label", points.horizontal.below, false);
    await tab.$eval("#hover-hit-cover", cover => { cover.hidden = false; });
    await move("covered", points.horizontal.glyph, false);
    await tab.$eval("#hover-hit-cover", cover => { cover.hidden = true; });
    check("hover hits glyphs and rejects padded tiles and transparent covering elements",
      outcomes.every(row => row.correct), JSON.stringify(outcomes));
    outcomes.length = 0;
    await move("vertical-glyph", points.vertical.glyph, true);
    await move("vertical-padding", points.vertical.padding, false);
    await move("vertical-below", points.vertical.below, false);
    check("vertical hover hits glyphs and rejects the surrounding padding",
      outcomes.every(row => row.correct), JSON.stringify(outcomes));
  } finally {
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await tab.evaluate(() => document.getElementById("hover-hit-fixture").remove());
  }
}

// Values that more than one step uses; the step that creates each one assigns it.
let tab, popup, hover, highlightSize, verb;

describe("reader", () => {
  step("the reading tab and popup resizing", async () => {
    // ------------------------------------------------------------------- hover
    tab = await browser.newPage();
    tab.on("console", m => diagnostics.push(`[page] ${m.type()}: ${m.text()}`));
    tab.on("pageerror", e => diagnostics.push(`[page] pageerror: ${e.message}`));
    await tab.setViewport({ width: 1280, height: 900 });
    await tab.goto(pageUrl, { waitUntil: "load" });

    popup = await popupReader(tab);

    hover = (selector, options) => hoverForPopup(tab, popup, selector, options);
    await checkPopupResize(page, tab);
    check("mouse resizing retains session dimensions without changing Design settings", true);
  });

  step("hover hit testing", async () => {
    await checkHoverHitTesting(tab, popup);
  });

  step("a multiline match", async () => {
    // CSS.highlights is a per-document registry, so the extension's entry is
    // readable from the page's own world even though the content script that set
    // it runs in an isolated one. -1 means the API itself is missing, which would
    // make the assertions below meaningless rather than failed.
    highlightSize = () => tab.evaluate(name => {
      if (typeof CSS === "undefined" || !CSS.highlights) return -1;
      const highlight = CSS.highlights.get(name);
      return highlight ? highlight.size : 0;
    }, HIGHLIGHT_NAME);

    const originalVerb = await tab.$eval("#verb", element => ({
      html: element.innerHTML,
      style: element.getAttribute("style"),
    }));
    await tab.$eval("#verb", element => {
      element.innerHTML = '\u524d\u524d\u524d\u524d\u524d\u524d\u524d\u524d<b id="placement-start">\u98df</b>\u3079\u305f\u304b\u3063\u305f';
      element.style.cssText = [
        "position: fixed",
        "top: 10px",
        "left: 600px",
        "width: 11em",
        "word-break: break-all",
      ].join(";");
    });
    const wrappedPopup = await hover("#placement-start");
    const wrappedPopupState = wrappedPopup === null ? null : await popup.dictionaryTabs();
    const wrappedSource = await tab.evaluate(name => {
      const highlight = CSS.highlights.get(name);
      const ranges = highlight ? [...highlight] : [];
      const rects = ranges.flatMap(range => [...range.getClientRects()]);
      if (rects.length === 0) return null;
      const start = document.createRange();
      const startNode = document.getElementById("placement-start").firstChild;
      start.setStart(startNode, 0);
      start.setEnd(startNode, 1);
      const active = start.getBoundingClientRect();
      return {
        active: { bottom: active.bottom, left: active.left, top: active.top },
        bottom: Math.max(...rects.map(rect => rect.bottom)),
        left: Math.min(...rects.map(rect => rect.left)),
        rectCount: rects.length,
        text: ranges.map(range => range.toString()).join(""),
        top: Math.min(...rects.map(rect => rect.top)),
        viewportWidth: innerWidth,
      };
    }, HIGHLIGHT_NAME);
    if (process.env.HACHIDORI_MULTILINE_POPUP_SCREENSHOT) {
      await tab.screenshot({ path: process.env.HACHIDORI_MULTILINE_POPUP_SCREENSHOT });
    }
    const wrappedExpectedLeft = wrappedPopupState && wrappedSource
      ? Math.max(6, Math.min(Math.round(wrappedSource.active.left),
        wrappedSource.viewportWidth - wrappedPopupState.rect.width - 6))
      : null;
    check(
      "a multiline match anchors the popup to the scanned line fragment",
      wrappedPopupState !== null
        && wrappedSource?.text === "\u98df\u3079\u305f\u304b\u3063\u305f"
        && wrappedSource.rectCount > 1
        && wrappedSource.active.left > wrappedSource.left + 50
        && Math.abs(wrappedPopupState.rect.left - wrappedExpectedLeft) <= 1
        && Math.abs(wrappedPopupState.rect.top - (wrappedSource.active.bottom + 4)) <= 1,
      JSON.stringify({ expectedLeft: wrappedExpectedLeft, popup: wrappedPopupState?.rect, source: wrappedSource }),
    );
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await tab.$eval("#verb", (element, original) => {
      element.innerHTML = original.html;
      if (original.style === null) element.removeAttribute("style");
      else element.setAttribute("style", original.style);
    }, originalVerb);
  });

  step("browser zoom", async () => {
    // Page zoom scales the page's CSS pixels; the popup cancels it.
    const setPageZoom = zoomFactor => page.evaluate(async (url, factor) => {
      const [target] = await chrome.tabs.query({ url });
      await chrome.tabs.setZoom(target.id, factor);
    }, pageUrl, zoomFactor);
    await setPageZoom(2);
    await page.evaluate(async () => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options.revision, options: { popupScalePercent: 75 } });
      if (!reply.ok) throw new Error(reply.error);
    });
    await tab.waitForFunction(() => window.devicePixelRatio === 2, { timeout: 5000 });
    // Selecting the word avoids depending on how synthetic pointer input maps
    // coordinates under browser zoom.
    await tab.evaluate(() => getSelection().selectAllChildren(document.getElementById("verb")));
    const zoomedPopup = await popup.waitForVisible();
    let zoomed = null;
    if (zoomedPopup !== null) {
      const widthPx = await page.evaluate(async () => ((await chrome.storage.local.get("options")).options?.popupWidthPx ?? 560) * 0.75);
      // The zoom factor arrives from the service worker alongside the lookup.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        zoomed = { widthPx, rect: (await popup.dictionaryTabs()).rect,
          viewport: await tab.evaluate(() => ({ width: innerWidth, height: innerHeight })) };
        if (Math.abs(zoomed.rect.width * 2 - widthPx) <= 2) break;
        await new Promise(done => setTimeout(done, 100));
      }
    }
    await tab.evaluate(() => getSelection().removeAllRanges());
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await setPageZoom(1);
    await page.evaluate(async () => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options.revision, options: { popupScalePercent: 100 } });
      if (!reply.ok) throw new Error(reply.error);
    });
    await tab.waitForFunction(() => window.devicePixelRatio === 1, { timeout: 5000 });
    check(
      "browser zoom keeps the popup at its configured on-screen size inside the viewport",
      zoomed !== null && Math.abs(zoomed.rect.width * 2 - zoomed.widthPx) <= 2
        && zoomed.rect.left >= 0 && zoomed.rect.top >= 0
        && zoomed.rect.right <= zoomed.viewport.width && zoomed.rect.bottom <= zoomed.viewport.height,
      JSON.stringify(zoomed),
    );
  });

  step("per-glyph boxes", async () => {
    // An OCR overlay such as GameSentenceMiner's boxes every glyph in its own
    // absolutely positioned span, which CSS blockifies, and separates blocks with
    // a "\n" span. Like Yomitan's layout-unaware scan, the word and its highlight
    // must still cross the boxes while the sentence stops at the separator.
    await tab.evaluate(() => {
      const boxed = document.createElement("div");
      boxed.id = "boxed";
      boxed.style.cssText = "position: fixed; top: 10px; left: 400px; width: 300px; height: 60px";
      const block = (text, top) => {
        const container = document.createElement("p");
        container.style.cssText = "position: absolute; margin: 0";
        Array.from(text).forEach((glyph, index) => {
          const box = document.createElement("span");
          box.textContent = glyph;
          box.style.cssText = `position: absolute; display: flex; left: ${index * 36}px; top: ${top}px; width: 34px; height: 40px`;
          container.append(box);
        });
        return container;
      };
      const separator = document.createElement("span");
      separator.style.position = "absolute";
      separator.textContent = "\n";
      const first = block("食べたかった", 0);
      first.firstChild.id = "boxed-start";
      boxed.append(first, separator, block("漢字", 44));
      document.body.append(boxed);
    });
    const boxedPopup = await hover("#boxed-start");
    const boxedPopupState = boxedPopup === null ? null : await popup.dictionaryTabs();
    const boxedSource = await tab.evaluate(name => {
      const highlight = CSS.highlights.get(name);
      const ranges = highlight ? [...highlight] : [];
      return {
        rectCount: ranges.flatMap(range => [...range.getClientRects()]).length,
        text: ranges.map(range => range.toString()).join(""),
        inBoxes: ranges.every(range => range.startContainer.parentElement?.closest("#boxed p") === document.querySelector("#boxed p")),
      };
    }, HIGHLIGHT_NAME);
    check(
      "hovering positioned per-glyph boxes looks up and highlights the whole word",
      boxedPopupState !== null
        && boxedSource.text === "食べたかった"
        && boxedSource.rectCount >= 6
        && boxedSource.inBoxes,
      JSON.stringify({ popup: boxedPopupState?.rect, source: boxedSource }),
    );
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await tab.evaluate(() => document.getElementById("boxed").remove());
  });

  step("wheel over the popup", async () => {
    // Readers such as ttu turn pages from body wheel listeners; the popup's own
    // scrolling, including past its end, must reach neither them nor the page.
    await tab.evaluate(() => {
      document.body.style.minHeight = "400vh";
      window.__pageWheels = 0;
      document.body.addEventListener("wheel", window.__countPageWheel = () => { window.__pageWheels += 1; });
    });
    const wheelPopup = await hover("#verb");
    const wheelRect = wheelPopup === null ? null : (await popup.dictionaryTabs()).rect;
    let wheeled = null;
    if (wheelRect) {
      const before = await tab.evaluate(() => window.scrollY);
      await tab.mouse.move(wheelRect.left + wheelRect.width / 2, wheelRect.top + wheelRect.height / 2);
      for (let step = 0; step < 12; step += 1) await tab.mouse.wheel({ deltaY: 400 });
      await new Promise(done => setTimeout(done, 300));
      wheeled = { before, ...await tab.evaluate(() => ({ after: window.scrollY, pageWheels: window.__pageWheels })),
        visible: await popup.waitForVisible(1000) !== null };
    }
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await tab.evaluate(() => {
      document.body.removeEventListener("wheel", window.__countPageWheel);
      document.body.style.minHeight = "";
      window.scrollTo(0, 0);
    });
    check("wheel over the popup scrolls neither the page nor its body wheel listeners",
      wheeled !== null && wheeled.visible && wheeled.pageWheels === 0 && wheeled.after === wheeled.before,
      JSON.stringify({ wheelRect, wheeled }));
  });

  step("Alt+wheel", async () => {
    // Yomitan's Alt+wheel moves one entry per wheel step. The default
    // Alt+WheelDown/WheelUp keybinds do the same, for a touchpad-sized step
    // too, where a plain wheel would scroll the pane 30 px. The second entry
    // needs two results; the checks below read one.
    const writeMaxResults = maxResults => page.evaluate(async value => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: { maxResults: value } });
      if (!reply.ok) throw new Error(reply.error);
      return options?.maxResults ?? 32;
    }, maxResults);
    const readerMaxResults = await writeMaxResults(2);
    await tab.evaluate(() => {
      document.body.style.minHeight = "400vh";
      window.__pageWheels = 0;
      document.body.addEventListener("wheel", window.__countPageWheel = () => { window.__pageWheels += 1; });
      // Read once dispatch has finished, so this sees what the popup decided.
      window.__altWheelsCancelled = [];
      window.addEventListener("wheel", window.__recordAltWheel = event => {
        if (event.altKey) setTimeout(() => window.__altWheelsCancelled.push(event.defaultPrevented));
      }, true);
    });
    const readAltWheelPane = () => tab.evaluate(() => {
      const scroll = document.querySelector("hachidori-host")?.shadowRoot
        ?.querySelector(".gsm-hoshidicts-popup:not([hidden]) .gsm-hoshidicts-content-scroll");
      if (!scroll) return null;
      const origin = scroll.getBoundingClientRect().top - scroll.scrollTop;
      // Where entry navigation lands: a later entry's own header slides under
      // the pinned one (#488).
      return { scrollTop: scroll.scrollTop, maxScroll: scroll.scrollHeight - scroll.clientHeight,
        offsets: [...scroll.querySelectorAll(":scope > .gsm-hoshidicts-tab-panel > .gsm-hoshidicts-entry")]
          .map((entry, index) => (index === 0 ? entry.getBoundingClientRect().top
            : entry.querySelector(":scope > .gsm-hoshidicts-entry-header").getBoundingClientRect().bottom) - origin),
        rect: scroll.getBoundingClientRect().toJSON(), pageY: window.scrollY, pageWheels: window.__pageWheels,
        cancelled: [...window.__altWheelsCancelled] };
    });
    const altWheelScrolledTo = top => tab.waitForFunction(value => {
      const scroll = document.querySelector("hachidori-host")?.shadowRoot
        ?.querySelector(".gsm-hoshidicts-popup:not([hidden]) .gsm-hoshidicts-content-scroll");
      return scroll && Math.abs(scroll.scrollTop - value) <= 1;
    }, { timeout: 2000 }, top).catch(() => null);
    const altWheelPopup = await hover("#verb", { accept: state => state.text.includes("unrelated term-dictionary definition") });
    const altWheelStart = altWheelPopup === null ? null : await readAltWheelPane();
    let altWheeled = null;
    if (altWheelStart) {
      await popup.dictionaryTabs("scroll", 0);
      // The pane's left padding: a scrollable target with no glyph to scan.
      await tab.mouse.move(altWheelStart.rect.left + 3, altWheelStart.rect.top + altWheelStart.rect.height / 2);
      const second = Math.min(altWheelStart.offsets[1] ?? 0, altWheelStart.maxScroll);
      await tab.keyboard.down("Alt");
      await tab.mouse.wheel({ deltaY: 30 });
      await altWheelScrolledTo(second);
      const down = await readAltWheelPane();
      await tab.mouse.wheel({ deltaY: -30 });
      await altWheelScrolledTo(0);
      await new Promise(done => setTimeout(done, 300));
      const up = await readAltWheelPane();
      await tab.keyboard.up("Alt");
      altWheeled = { start: altWheelStart, second, down, up, visible: await popup.waitForVisible(1000) !== null };
    }
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await tab.evaluate(() => {
      document.body.removeEventListener("wheel", window.__countPageWheel);
      window.removeEventListener("wheel", window.__recordAltWheel, true);
      document.body.style.minHeight = "";
      window.scrollTo(0, 0);
    });
    await writeMaxResults(readerMaxResults);
    check("Alt+wheel over the popup moves one entry per step without scrolling the pane or the page",
      altWheeled !== null && altWheeled.visible && altWheeled.start.offsets.length >= 2 && altWheeled.second > 31
        && Math.abs(altWheeled.down?.scrollTop - altWheeled.second) <= 1 && altWheeled.up?.scrollTop <= 1
        && altWheeled.up.cancelled.length === 2 && altWheeled.up.cancelled.every(Boolean)
        && altWheeled.up.pageY === altWheeled.start.pageY && altWheeled.up.pageWheels === altWheeled.start.pageWheels,
      JSON.stringify(altWheeled));
  });

  step("hovering an inflected verb", async () => {
    verb = await hover("#verb");
    check("hovering an inflected verb shows a popup", verb !== null,
      "no .gsm-hoshidicts-popup appeared within 12 hover attempts");
    const hostPresent = verb === null ? false : await tab.evaluate(() => {
      const host = document.querySelector("hachidori-host");
      return !!host && host.isConnected && host.shadowRoot instanceof ShadowRoot;
    });
    check("the content script attached its open-shadow host to the page", hostPresent,
      "no connected <hachidori-host> with an open shadow root");

    // Read through a default rather than under an `if`: a popup that never appeared
    // must fail these three as well, not quietly remove them from the total.
    const verbState = verb ?? { plain: "", text: "" };
    check("the popup deinflects 食べたかった to 食べる", verbState.plain.includes("食べる"),
      `popup text: ${verbState.text.slice(0, 400)}`);
    check("the popup renders the glossary", verbState.text.includes("to eat"),
      `popup text: ${verbState.text.slice(0, 400)}`);
    check("the popup renders the frequency tag from term_meta_bank",
      verbState.text.includes("142"), `popup text: ${verbState.text.slice(0, 400)}`);
    check(
      "a grouped favourite uses only its group tab",
      JSON.stringify(verbState.tabs) === JSON.stringify(["All", "Externally focused reading"])
        && !verbState.tabs.includes(FIXTURE_ALIAS)
        && !verbState.tabs.includes("hachidori-fixture")
        && replacedPackage?.title === "hachidori-fixture",
      `popup tabs: ${JSON.stringify(verbState.tabs)}`,
    );
  });
});

export { highlightSize, hover, popup, tab, verb };
