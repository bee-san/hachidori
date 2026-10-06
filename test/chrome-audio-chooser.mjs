// The pronunciation chooser hangs beside its own audio button (#504), in real
// layout with the production renderer, reader stylesheet and audio controller.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AUDIO_CHOOSER_CHECK = "the pronunciation chooser opens beside its audio button from every gesture, "
  + "stays inside the popup at every scale and edge, follows or closes with its scrolled button and moves no definition";

const SCRIPTS = ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js", "audio-content.js"];
const senses = gloss => JSON.stringify(Array.from({ length: 7 }, (_, index) => `${gloss}, sense ${index + 1}`));
const RESULTS = [["聞く", "to hear"], ["効く", "to be effective"], ["利く", "to work"]].map(([expression, gloss]) => ({
  matched: "きく", deinflected: "きく", trace: [], preprocessorSteps: 0, term: {
    expression, reading: "きく", rules: "v5", score: 0, frequencies: [], pitches: [],
    glossaries: [{ dictionary: "Jisho", definitionTags: "v5k", glossary: senses(gloss) }],
  } }));

// Runs in the page: the reader's popup, its renderer and the audio controller,
// with the reader's own popup-pixel conversion (content.js popupRect()).
function install({ css, results }) {
  // A web page has no extension runtime; the controller only listens on it.
  window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
  const host = document.querySelector("#host");
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  shadow.adoptedStyleSheets = [sheet];
  const appearance = HDPopup.createPopupAppearance(host);
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  shadow.append(popup);
  let settings = { scale: 100, zoom: 1, count: 3 };
  const sent = [];
  // Settings → Audio's order: a recording, a failing site, then a JSON list.
  const groups = count => [
    { sourceId: "pod", sourceKey: "pod-key", type: "custom", candidates: [{ url: "https://audio.test/pod.mp3", name: "" }] },
    { sourceId: "site", sourceKey: "site-key", type: "custom", error: "The site answered HTTP 503.", candidates: [] },
    { sourceId: "json", sourceKey: "json-key", type: "custom-json", candidates: Array.from({ length: count },
      (_, index) => ({ url: `https://audio.test/${index}.mp3`, name: `Speaker ${index + 1}` })) },
  ];
  const owner = {};
  const audio = HDAudio.createAudioController({ window, onMenuChange() {},
    popupRect: rect => HDPopup.scaleRect(rect, HDPopup.popupCoordinateScale(settings.zoom, settings.scale)),
    async send(type, fields) {
      sent.push({ type, ...fields });
      return type === "hd_audio_candidates" ? { ok: true, groups: groups(settings.count) } : { ok: true, status: "success" };
    } });
  audio.update(HDReaderOptions.DEFAULT_OPTIONS);
  let buttons = [];
  const bind = ({ audioButtons }) => {
    buttons = audioButtons.map(item => item.button);
    audio.bind(audioButtons, { owner, popup, request: {}, isCurrent: () => true });
  };
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, parseTagList: HDGlossary.parseTagList,
    // content.js re-places an open chooser whenever it places its popup.
    positionPopup: () => audio.positionMenu(owner),
    getPageZoom: () => settings.zoom, getPopupScalePercent: () => settings.scale,
    onResultsRendered: bind, onResultsExpanded: bind });
  const scroller = view.scrollElement;
  const menu = () => shadow.querySelector(".gsm-hoshidicts-audio-choices");
  const items = () => [...(menu()?.querySelectorAll(".gsm-hoshidicts-audio-menu-item") ?? [])];
  const box = node => node?.getBoundingClientRect().toJSON() ?? null;
  const center = node => {
    const { left, top, width, height } = node.getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  };
  window.chooserFixture = {
    sent,
    render({ toolbar = "top", scale = 100, zoom = 1, width = 560, height = 420, theme = "dark", count = 3 } = {}) {
      audio.retire(owner);
      settings = { scale, zoom, count };
      appearance.update({ ...HDReaderOptions.DEFAULT_OPTIONS, popupTheme: theme, popupScalePercent: scale,
        popupWidthPx: width, popupHeightPx: height });
      host.style.setProperty("--gsm-hoshidicts-page-zoom", String(1 / zoom));
      popup.style.cssText = `left: 24px; top: 24px; width: ${width}px; height: ${height}px`;
      view.setToolbarPosition(toolbar);
      view.renderResults(results, { anchor: document.querySelector("#source"), query: "きく" }, { expandAll: true });
      scroller.scrollTop = 0;
    },
    filled: () => [...scroller.querySelectorAll(".gsm-hoshidicts-glossary-content")].every(node => node.textContent),
    state(index = 0) {
      const button = buttons[index], open = menu(), active = shadow.activeElement;
      return {
        popup: box(popup), menu: box(open), button: box(button), expanded: button.getAttribute("aria-expanded"),
        scroller: box(scroller), scrollTop: scroller.scrollTop, card: box(scroller.querySelector(".gsm-hoshidicts-glossary-card")),
        focused: active === button ? "audio" : active?.textContent ?? null,
        names: items().map(item => item.textContent),
        overflow: open ? open.scrollHeight - open.clientHeight : null,
        viewport: { width: innerWidth, height: innerHeight },
      };
    },
    buttonPoint: index => center(buttons[index]),
    itemPoint: name => center(items().find(item => item.textContent === name)),
    focusButton(index) { buttons[index].focus(); },
    scrollMenuToEnd() { menu().scrollTop = menu().scrollHeight; },
    scrollDefinitions(by) { scroller.scrollTop += by; },
    // Scroll a later result's own header just above the definitions' top edge.
    scrollPast(index) {
      const header = scroller.querySelectorAll(".gsm-hoshidicts-entry")[index]
        .querySelector(":scope > .gsm-hoshidicts-entry-header");
      const factor = HDPopup.popupCoordinateScale(settings.zoom, settings.scale);
      scroller.scrollTop += (header.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top) * factor + 2;
    },
    // Scroll the result's button just inside the definitions' bottom edge.
    bringToBottom(index) {
      const factor = HDPopup.popupCoordinateScale(settings.zoom, settings.scale);
      scroller.scrollTop += (buttons[index].getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom) * factor + 6;
    },
    focusStyle() {
      const style = getComputedStyle(shadow.activeElement);
      return { name: shadow.activeElement.textContent, focusVisible: shadow.activeElement.matches(":focus-visible"),
        outline: [style.outlineStyle, style.outlineColor, style.outlineWidth], background: getComputedStyle(menu()).backgroundColor };
    },
  };
}

export async function checkAudioChooser(browser, { screenshotDirectory } = {}) {
  const page = await browser.newPage();
  const evidence = [];
  try {
    await page.setViewport({ width: 900, height: 700 });
    // The controller names its requests with crypto.randomUUID(), which only a
    // secure context has; an intercepted localhost page is one.
    await page.setRequestInterception(true);
    page.on("request", request => request.respond({ contentType: "text/html; charset=utf-8",
      body: '<!doctype html><meta charset="utf-8"><p id="source">きく</p><div id="host"></div>' }));
    await page.goto("http://localhost/audio-chooser.html");
    for (const file of SCRIPTS) await page.addScriptTag({ path: fileURLToPath(new URL(`../extension/${file}`, import.meta.url)) });
    await page.evaluate(install, { css: ["render/reader.css", "icons.css"]
      .map(file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8")).join("\n"), results: RESULTS });
    const fixture = (method, ...args) => page.evaluate((name, values) => window.chooserFixture[name](...values), method, args);
    const frames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const render = async options => {
      await fixture("render", options);
      await page.waitForFunction(() => window.chooserFixture.filled(), { timeout: 3000 });
    };
    const choices = (index, count) => page.waitForFunction((value, expected) => {
      const state = window.chooserFixture.state(value);
      return state.names.length === expected + 2 ? state : false;
    }, { timeout: 3000 }, index, count).then(handle => handle.jsonValue(), async error => {
      throw new Error(`${count} choices never appeared: ${JSON.stringify(await fixture("state", index))}`, { cause: error });
    });
    const shoot = async name => {
      if (!screenshotDirectory) return;
      const { popup } = await fixture("state");
      await page.screenshot({ path: `${screenshotDirectory}/${name}.png`,
        clip: { x: popup.left - 12, y: popup.top - 12, width: popup.width + 24, height: popup.height + 24 } });
    };
    const open = async (gesture, index) => {
      if (gesture === "keyboard") {
        await fixture("focusButton", index);
        await page.keyboard.press("ArrowDown");
        return;
      }
      const { x, y } = await fixture("buttonPoint", index);
      if (gesture === "right-click") {
        await page.mouse.click(x, y, { button: "right" });
        return;
      }
      await page.keyboard.down("Shift");
      await page.mouse.click(x, y);
      await page.keyboard.up("Shift");
    };
    const closeWithMouse = async index => {
      const { x, y } = await fixture("itemPoint", "Close");
      await page.mouse.click(x, y);
      const state = await fixture("state", index);
      assert.ok(!state.menu && state.expanded === "false" && state.focused === "audio",
        `Close did not return focus to Audio: ${JSON.stringify(state)}`);
    };
    // Beside its button: 4 popup pixels below or above it, overlapping it
    // horizontally, and at least 6 popup pixels inside every popup edge.
    const assertBeside = (state, zoom, side, label) => {
      const { menu, button, popup } = state;
      const below = menu.top >= button.bottom;
      const gap = below ? menu.top - button.bottom : button.top - menu.bottom;
      const edge = 6 * zoom - 1;
      const detail = `${label}: ${JSON.stringify(state)}`;
      if (side) assert.equal(below ? "below" : "above", side, detail);
      assert.ok(Math.abs(gap - 4 * zoom) <= 1.5 && menu.left <= button.right && menu.right >= button.left, detail);
      assert.ok(menu.left - popup.left >= edge && popup.right - menu.right >= edge
        && menu.top - popup.top >= edge && popup.bottom - menu.bottom >= edge, `outside the popup: ${detail}`);
    };
    const assertUnmoved = (before, after, label) => {
      const same = (left, right) => ["left", "top", "width", "height"].every(key => Math.abs(left[key] - right[key]) < 0.5);
      assert.ok(after.scrollTop === before.scrollTop && same(before.scroller, after.scroller) && same(before.card, after.card),
        `${label}: the definitions moved: ${JSON.stringify({ before, after })}`);
    };

    // Each gesture, at both toolbar edges, a custom popup scale and browser zoom.
    for (const [label, options, gesture, side] of [
      ["1-dark-right-click", { theme: "dark" }, "right-click", "below"],
      ["2-light-bottom-toolbar-shift-click", { theme: "light", toolbar: "bottom" }, "shift-click", "above"],
      ["3-high-contrast-scale-125-keyboard", { theme: "high-contrast", scale: 125 }, "keyboard", "below"],
      ["4-dark-browser-zoom-125-scale-80", { theme: "dark", scale: 80, zoom: 1.25 }, "right-click", "below"],
    ]) {
      const zoom = (options.scale ?? 100) / 100 / (options.zoom ?? 1);
      await render(options);
      const before = await fixture("state");
      await open(gesture, 0);
      const after = await choices(0, 3);
      assertBeside(after, zoom, side, label);
      assertUnmoved(before, after, label);
      assert.ok(after.expanded === "true" && after.focused === "Close", `${label}: ${JSON.stringify(after)}`);
      evidence.push({ label, menu: after.menu, button: after.button });
      await shoot(label);
      await closeWithMouse(0);
    }

    // A long list in a narrow, short popup scrolls inside the chooser, whose
    // last choice is reachable and plays with its exact identity.
    await render({ width: 280, height: 200, scale: 125, count: 24 });
    const narrowBefore = await fixture("state");
    await open("right-click", 0);
    const long = await choices(0, 24);
    assertBeside(long, 1.25, null, "long list");
    assertUnmoved(narrowBefore, long, "long list");
    assert.ok(long.overflow > 0, `the long list does not scroll inside the chooser: ${JSON.stringify(long)}`);
    await shoot("5-dark-long-list-narrow");
    await fixture("scrollMenuToEnd");
    const last = await fixture("itemPoint", "Speaker 24");
    const scrolled = await fixture("state");
    assert.ok(last.y > scrolled.menu.top && last.y < scrolled.menu.bottom && last.y < scrolled.viewport.height,
      `the last choice is out of reach: ${JSON.stringify({ last, scrolled })}`);
    await shoot("6-dark-long-list-scrolled");
    await page.mouse.click(last.x, last.y);
    const played = await page.evaluate(() => window.chooserFixture.sent.at(-1));
    const chosen = await fixture("state");
    assert.deepEqual([played.type, played.selection?.sourceId, played.selection?.index, played.selection?.name],
      ["hd_audio_play", "json", 23, "Speaker 24"]);
    assert.ok(!chosen.menu && chosen.focused === "audio", JSON.stringify(chosen));
    evidence.push({ label: "long list", menu: long.menu, overflow: long.overflow });

    // A later result's button scrolls with the definitions: the chooser follows
    // it, into the pinned header too, and closes once the button is hidden.
    await render({ theme: "dark" });
    await open("keyboard", 1);
    const start = await choices(1, 3);
    assertBeside(start, 1, null, "later result");
    await fixture("scrollDefinitions", 24);
    await frames();
    const followed = await fixture("state", 1);
    // Re-anchored to the moved button; above it, the room shrinks with it.
    assert.ok(followed.button.top < start.button.top - 20, JSON.stringify({ start, followed }));
    assertBeside(followed, 1, null, "scrolled later result");
    await fixture("scrollPast", 1);
    await frames();
    const pinned = await fixture("state", 1);
    assertBeside(pinned, 1, null, "button moved into the pinned header");
    assert.ok(pinned.button.bottom <= pinned.scroller.top + 1, `the button did not move into the header: ${JSON.stringify(pinned)}`);
    await shoot("7-dark-follows-pinned-header");
    await closeWithMouse(1);
    // The first result's own button is hidden while a later one is shown.
    await render({ theme: "dark" });
    await open("right-click", 0);
    await choices(0, 3);
    await fixture("scrollPast", 1);
    await frames();
    const hidden = await fixture("state", 0);
    assert.ok(!hidden.menu && hidden.expanded === "false", `a hidden button kept its chooser: ${JSON.stringify(hidden)}`);
    // A button scrolled out of the definitions closes its chooser.
    await render({ theme: "dark" });
    await fixture("bringToBottom", 2);
    await open("keyboard", 2);
    await choices(2, 3);
    await fixture("scrollDefinitions", -40);
    await frames();
    const away = await fixture("state", 2);
    assert.ok(!away.menu && away.expanded === "false", `a scrolled-away button kept its chooser: ${JSON.stringify(away)}`);

    // Forced colours replace the hover background, so keyboard focus is the
    // outline, drawn in a system colour; ordinary palettes keep it transparent.
    // Puppeteer's own emulation refuses forced-colors, so CDP sets it.
    const media = await page.createCDPSession();
    const focused = [];
    for (const [scheme, forced] of [["dark", false], ["dark", true], ["light", true]]) {
      await media.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme },
        ...(forced ? [{ name: "forced-colors", value: "active" }] : [])] });
      await render({ theme: scheme });
      await open("keyboard", 0);
      await choices(0, 3);
      await page.keyboard.press("Tab");
      const style = await fixture("focusStyle");
      focused.push({ scheme, forced, ...style });
      const transparent = style.outline[1] === "rgba(0, 0, 0, 0)";
      // Opaque in every mode, so the definitions never show through the choices.
      const translucent = /^rgba\(|\/\s*[\d.]+\)$/u.test(style.background);
      assert.ok(style.focusVisible && style.name === "Pronunciation 1" && style.outline[0] === "solid"
        && transparent !== forced && !translucent, JSON.stringify(focused));
      if (forced) await shoot(`8-forced-colors-${scheme}`);
      await closeWithMouse(0);
    }
    await media.send("Emulation.setEmulatedMedia", { features: [] });
    await media.detach();
    console.log("PASS audio chooser", JSON.stringify({ evidence, focused }));
  } finally {
    await page.close();
  }
}
