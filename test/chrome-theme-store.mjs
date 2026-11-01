// Focused check: Store availability, real hover, kanji/Back, and Default restore.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
import { popupRoot } from "./chrome-popup-root.mjs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const output = resolve(process.env.HACHIDORI_THEME_OUTPUT || resolve(root, "test/tmp/theme-store"));
const extension = resolve(root, "extension");
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-theme-smoke-"));
mkdirSync(output, { recursive: true });
const server = createServer(async (request, response) => {
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = await answerAnkiConnect(JSON.parse(body), (action, params) => {
      if (action === "version") return 6;
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "modelFieldNames") return ["Front", "Back"];
      if (["findNotes", "findCards", "notesInfo"].includes(action)) return [];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      throw new Error(`Unexpected Anki action: ${action}`);
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reply));
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><meta charset="utf-8"><style>body{font:32px sans-serif;padding:80px}</style><p>朝ごはんを<span id="word">食べたかった</span>。</p>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.HACHIDORI_CHROME || resolve(root, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"),
    headless: true, enableExtensions: true, userDataDir: profile,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
  });
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120000);
  const errors = [];
  settings.on("pageerror", error => { errors.push(error.message); console.log("page error", error.message); });
  await settings.setViewport({ width: 1400, height: 1000 });
  await settings.goto(`${origin}/settings.html#add-dictionaries`);
  await settings.bringToFront();
  console.log("settings loaded");
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  console.log("engine ready");
  await (await settings.$("#import-file")).uploadFile(resolve(root, "test/fixtures/hachidori-fixture.zip"));
  await settings.waitForFunction(() => document.getElementById("import-state").textContent.includes("1 imported, 0 failed"));
  console.log("fixture imported");
  assert.equal(await settings.$eval("#theme-store", node => node.hidden), false);
  await settings.evaluate(() => { location.hash = "advanced"; });
  assert.equal(await settings.$("#opt-experimental-themeStore"), null);
  assert.equal(await settings.$("#opt-experimental-smallerAnkiCards"), null);
  assert.equal(await settings.$("#opt-experimental-wordHighlighting"), null);
  for (const palette of ["light", "dark"]) {
    await settings.evaluate(async popupTheme => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options.revision, options: { popupTheme } });
      if (!reply.ok) throw new Error(reply.error);
    }, palette);
    await settings.waitForFunction(palette => document.documentElement.dataset.hoshidictsTheme === palette, {}, palette);
    for (const [section, selector] of [["design", "#theme-store"], ["anki", "#anki-card-format"],
      ["word-highlighting", "#word-highlighting"]]) {
      await settings.evaluate(section => { location.hash = section; }, section);
      await settings.waitForSelector(selector, { visible: true });
      if (section === "design") await settings.waitForSelector(".theme-store-card button", { visible: true });
      await (await settings.$(selector)).screenshot({ path: resolve(output, `settings-${section}-${palette}.png`) });
    }
  }
  assert.equal(await settings.$eval("#opt-word-highlight", input => input.checked), false);
  await settings.evaluate(() => { location.hash = "anki"; });
  await settings.waitForSelector("#opt-smaller-anki-cards", { visible: true });
  assert.equal(await settings.$eval("#opt-smaller-anki-cards", input => input.checked), false);
  for (const enabled of [true, false]) {
    await settings.click("#opt-smaller-anki-cards");
    await settings.waitForFunction(async enabled =>
      (await chrome.storage.local.get("options")).options.smallerAnkiCards === enabled, {}, enabled);
    await settings.reload();
    await settings.waitForSelector("#opt-smaller-anki-cards", { visible: true });
    assert.equal(await settings.$eval("#opt-smaller-anki-cards", input => input.checked), enabled);
  }
  await settings.evaluate(async ankiUrl => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { hoverEnabled: true, lookupMode: "hover", popupTheme: "default", showLookupCounts: true,
        anki: { ...HDReaderOptions.DEFAULT_OPTIONS.anki, url: ankiUrl, model: "Basic",
          fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
            Back: { value: "{glossary}", overwriteMode: "overwrite" } } } } });
    if (!reply.ok) throw new Error(reply.error);
    location.hash = "design";
  }, `http://127.0.0.1:${server.address().port}`);
  await settings.waitForSelector(".theme-store-card button", { visible: true });
  assert.equal(await settings.$$eval(".theme-store-card", cards => cards.length), 6);
  const tab = await browser.newPage();
  tab.on("pageerror", error => { errors.push(error.message); console.log("tab error", error.message); });
  tab.on("console", message => { if (["error", "warn"].includes(message.type())) console.log(message.type(), message.text()); });
  await tab.setViewport({ width: 1100, height: 800 });
  await tab.goto(`http://127.0.0.1:${server.address().port}`);
  const hover = async () => {
    await tab.bringToFront();
    await tab.mouse.move(2, 2);
    const point = await tab.$eval("#word", node => {
      const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 1);
      const box = range.getBoundingClientRect(); return { x: box.x + box.width * .2, y: box.y + box.height / 2 };
    });
    await tab.mouse.move(point.x, point.y);
    await popupRoot(tab).waitFor(popupShadow => {
      const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
      return popup && !popup.hidden && popup.querySelector(".gsm-hoshidicts-entry");
    });
  };
  const screenshot = async name => {
    const clip = await popupRoot(tab).evaluate(root => {
      const rect = root.querySelector(".gsm-hoshidicts-popup").getBoundingClientRect();
      return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
    });
    await tab.screenshot({ path: resolve(output, `${name}.png`), clip });
  };
  console.log("hover");
  await hover();
  await popupRoot(tab).waitFor(popupShadow => {
    const button = popupShadow.querySelector(".gsm-hoshidicts-mine-button");
    return button && !button.hidden && button.dataset.state !== "checking" && !button.disabled;
  });
  await screenshot("default");
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-note-button").click());
  await settings.bringToFront();
  await settings.click(".theme-store-card:nth-child(2) button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "nazeka");
  console.log("hover");
  await hover();
  await popupRoot(tab).waitFor(popupShadow => popupShadow.querySelector(".nazeka-reading")?.textContent === "たべる");
  const evidence = await popupRoot(tab).evaluate(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    const shadow = popup.getRootNode();
    return { defaultStyles: shadow.adoptedStyleSheets.some(sheet => [...sheet.cssRules].some(rule => rule.cssText.includes(".gsm-hoshidicts-glossary-card"))),
      dictionaryStyles: shadow.querySelectorAll("[data-hoshidicts-dictionary-style]").length,
      richNodes: popup.querySelectorAll(".gsm-hoshidicts-glossary-card,img,.gloss-link").length,
      hiddenToolbar: !popup.querySelector(".gsm-hoshidicts-result-chrome"),
      background: getComputedStyle(popup).backgroundColor,
      reading: popup.querySelector(".nazeka-reading").textContent,
      word: popup.querySelector(".gsm-hoshidicts-expression").getAttribute("aria-label") };
  });
  assert.equal(evidence.hiddenToolbar, true);
  assert.equal(evidence.defaultStyles, false);
  assert.equal(evidence.dictionaryStyles, 0);
  assert.equal(evidence.richNodes, 0);
  assert.equal(evidence.background, "rgb(17, 17, 17)");
  await tab.keyboard.press("Escape");
  assert.equal(await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-popup").hidden), true,
    "switching away from Note releases editing so Escape can close Nazeka");
  await hover();
  await popupRoot(tab).waitFor(popupShadow => {
    const button = popupShadow.querySelector(".gsm-hoshidicts-mine-button");
    return button && !button.hidden && button.dataset.state !== "checking" && !button.disabled;
  });
  const controls = await popupRoot(tab).evaluate(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    const audio = popup.querySelector(".gsm-hoshidicts-audio-button");
    const reading = popup.querySelector(".nazeka-reading").getBoundingClientRect();
    const audioBox = audio.getBoundingClientRect();
    const mine = popup.querySelector(".gsm-hoshidicts-mine-button");
    return { count: popup.querySelectorAll(".nazeka-count").length, text: popup.textContent,
      audioAfterReading: audioBox.left >= reading.right && audioBox.left - reading.right < 24,
      border: getComputedStyle(audio).borderWidth, mining: mine.dataset.state,
      mineAfterAudio: mine.getBoundingClientRect().left > audioBox.left };
  });
  assert.equal(controls.count, 0);
  assert.doesNotMatch(controls.text, /Looked up/);
  assert.equal(controls.audioAfterReading, true);
  assert.equal(controls.border, "0px");
  assert.equal(controls.mining, "ready");
  assert.equal(controls.mineAfterAudio, true);
  await screenshot("nazeka");
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-kanji-link").click());
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector(".nazeka-kanji-info"));
  await screenshot("nazeka-kanji");
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-kanji-back").click());
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector(".nazeka-word"));
  await settings.bringToFront();
  await settings.waitForFunction(() => [...document.querySelectorAll(".theme-store-preview")].every(image => image.complete && image.naturalWidth > 0));
  const carousel = await settings.$eval(".theme-store-grid", node => ({ width: node.clientWidth, scroll: node.scrollWidth, flow: getComputedStyle(node).gridAutoFlow }));
  assert.equal(carousel.flow, "column");
  assert.ok(carousel.scroll > carousel.width, "cards scroll horizontally");
  const preview = settings.frames().find(frame => frame.url().includes("design-preview.html"));
  assert.equal(await preview.evaluate(() => document.getElementById("preview-host").dataset.hoshidictsRenderer), "nazeka");
  assert.equal(await preview.evaluate(() => !!document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-mine-button")), true);
  await settings.screenshot({ path: resolve(output, "store.png") });
  const scrollButtons = () => settings.$$eval(".theme-store-scroll", buttons => buttons.map(button => [button.getAttribute("aria-label"), button.disabled]));
  assert.deepEqual(await scrollButtons(), [["Previous themes", true], ["Next themes", false]]);
  while (!(await settings.$eval('.theme-store-scroll[aria-label="Next themes"]', button => button.disabled))) {
    const scrollSettled = settings.evaluate(() => new Promise(resolve => {
      document.querySelector(".theme-store-grid").addEventListener("scrollend", resolve, { once: true });
    }));
    await settings.click('.theme-store-scroll[aria-label="Next themes"]');
    await scrollSettled;
  }
  assert.deepEqual(await scrollButtons(), [["Previous themes", false], ["Next themes", true]]);
  assert.ok(await settings.$eval(".theme-store-grid", grid => grid.scrollLeft > 0), "Next themes scrolls the cards");
  assert.equal(await settings.evaluate(() => document.activeElement.id), "theme-store-previous", "focus moves off the disabled Next themes");
  // Stored options apart from the theme, and Design's shown legends ("# …") and control labels.
  const storedOptions = () => settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    return Object.fromEntries(Object.entries(options).filter(([key]) => key !== "popupTheme" && key !== "revision"));
  });
  const designShown = () => settings.$$eval("#design .design-controls :is(legend, label.field, label.lookup-enable)", nodes => nodes
    .filter(node => node.checkVisibility() && !node.closest("#custom-button-form"))
    .map(node => node.matches("legend") ? `# ${node.textContent}` : (node.querySelector(".field-label") ?? node.querySelector("span")).textContent));
  const beforePlain = await storedOptions();
  await settings.click(".theme-store-card:nth-child(3) button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "plain");
  assert.deepEqual(await storedOptions(), beforePlain, "choosing a theme writes only popupTheme");
  assert.deepEqual(await designShown(), ["# Theme Store", "# Appearance", "Theme", "Width", "Height", "Scale",
    "Highlight the word on the page"], "Plain shows only the core Design controls");
  assert.equal(await settings.$eval("#popup-theme-hint", node => node.checkVisibility() && node.textContent),
    "Plain uses only the settings shown here. Your other Design settings are kept for Default.");
  await hover();
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector(".plain-scroll"));
  const plain = await popupRoot(tab).evaluate(shadow => {
    const popup = shadow.querySelector(".gsm-hoshidicts-popup");
    return { text: popup.textContent, controls: popup.querySelectorAll("button,img,a,.gsm-hoshidicts-expression,.nazeka-count").length,
      children: popup.querySelectorAll("*").length, entries: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      extraStyles: shadow.adoptedStyleSheets.some(sheet => [...sheet.cssRules].some(rule => /glossary-card|hd-icon/.test(rule.cssText))) };
  });
  assert.match(plain.text, /to eat/);
  assert.doesNotMatch(plain.text, /Looked up|たべる|hachidori-fixture/);
  assert.equal(plain.controls, 0);
  assert.equal(plain.children, plain.entries);
  assert.equal(plain.extraStyles, false);
  await screenshot("plain");
  await settings.bringToFront();
  assert.equal(await preview.evaluate(() => document.getElementById("preview-host").dataset.hoshidictsRenderer), "plain");
  await settings.screenshot({ path: resolve(output, "store-plain.png") });
  await settings.click(".theme-store-card:nth-child(4) button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "jl");
  await hover();
  await popupRoot(tab).waitFor(popupShadow => {
    const buttons = [...popupShadow.querySelectorAll(".jl-entry .gsm-hoshidicts-mine-button")];
    return buttons.length > 0 && buttons.every(button => !button.hidden && !button.disabled && button.dataset.state === "ready");
  });
  const jl = await popupRoot(tab).evaluate(shadow => {
    const popup = shadow.querySelector(".gsm-hoshidicts-popup");
    const blocks = [...popup.querySelectorAll(".jl-entry")];
    return { blocks: blocks.length, tabs: [...popup.querySelectorAll(".jl-tab")].map(tab => tab.textContent),
      controls: blocks.map(block => [block.querySelectorAll(".gsm-hoshidicts-audio-button").length,
        block.querySelector(".gsm-hoshidicts-mine-button").dataset.state]),
      defaultStyles: shadow.adoptedStyleSheets.some(sheet => [...sheet.cssRules].some(rule => rule.cssText.includes(".gsm-hoshidicts-glossary-card"))) };
  });
  assert.ok(jl.blocks > 1);
  assert.deepEqual(jl.tabs, ["All", "hachidori-fixture"]);
  assert.deepEqual(jl.controls, Array.from({ length: jl.blocks }, () => [1, "ready"]), "every block has its own audio and Anki button");
  assert.equal(jl.defaultStyles, false);
  await screenshot("jl");
  // Design's pitch switch repaints JL's marker in the open popup and the preview,
  // without another lookup: the probed block survives. It is clicked in place,
  // because bringing Settings to the front would blur the page and close its popup.
  assert.ok((await designShown()).includes("Show pitch on the reading"));
  await popupRoot(tab).evaluate(popupShadow => { popupShadow.querySelector(".jl-entry").dataset.pitchProbe = ""; });
  const popupMarks = await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelectorAll(".jl-mora").length);
  const previewMarks = await preview.evaluate(() => document.getElementById("preview-host").shadowRoot.querySelectorAll(".jl-mora").length);
  assert.ok(popupMarks > 0 && previewMarks > 0, "JL marks pitch in the popup and the preview");
  for (const shown of [false, true]) {
    await settings.$eval("#opt-pitch-furigana", input => input.click());
    await popupRoot(tab).waitFor((popupShadow, count) => {
      const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
      return !popup.hidden && !!popup.querySelector(".jl-entry[data-pitch-probe]") && popup.querySelectorAll(".jl-mora").length === count;
    }, {}, shown ? popupMarks : 0);
    await preview.waitForFunction(count => document.getElementById("preview-host").shadowRoot.querySelectorAll(".jl-mora").length === count,
      {}, shown ? previewMarks : 0);
  }
  await settings.bringToFront();
  assert.equal(await preview.evaluate(() => document.getElementById("preview-host").dataset.hoshidictsRenderer), "jl");
  await settings.screenshot({ path: resolve(output, "store-jl.png") });
  await settings.evaluate(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const groups = ["English", "Study"].map((name, index) => ({ id: `bee-group-${index}`, name,
      dictionaryIds: dictionaryState.dictionaries.map(dictionary => dictionary.id) }));
    const grouped = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: dictionaryState.revision, dictionaries: dictionaryState.dictionaries, groups });
    if (!grouped.ok) throw new Error(grouped.error);
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { imageHoverPreview: "all", customButtons: [
        { id: "search", type: "link", label: "Custom button", url: "https://example.test/%w" },
        { id: "template", type: "anki", label: "Custom button", templateId: "default" },
        { id: "extra", type: "link", label: "Custom button", url: "https://example.test/%r" },
      ] } });
    if (!reply.ok) throw new Error(reply.error);
  });
  await settings.click(".theme-store-card:nth-child(5) button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "bee");
  await hover();
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsRenderer === "bee");
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector(".bee-more-actions"));
  const bee = await popupRoot(tab).evaluate(shadow => {
    const popup = shadow.querySelector(".gsm-hoshidicts-popup");
    return { tabs: [...popup.querySelectorAll(".jl-tab")].map(node => node.textContent),
      rich: popup.querySelectorAll(".bee-rich-content > *").length,
      plain: [...popup.querySelectorAll(".gsm-hoshidicts-glossary-content")].filter(node => !node.classList.contains("bee-rich-content")).length,
      disclosures: popup.querySelectorAll(".bee-rich-definition, .bee-rich-tags").length,
      brackets: /\[/.test(popup.querySelector(".gsm-hoshidicts-definitions").textContent),
      notes: popup.querySelectorAll(".gsm-hoshidicts-note-button").length,
      custom: popup.querySelectorAll(".gsm-hoshidicts-custom-anki-button").length,
      menus: popup.querySelectorAll(".bee-more-actions").length,
      defaultStyles: shadow.adoptedStyleSheets.some(sheet => [...sheet.cssRules].some(rule => rule.cssText.includes(".gsm-hoshidicts-glossary-card"))) };
  });
  assert.deepEqual(bee.tabs, ["All", "English", "Study"]);
  assert.ok(bee.rich > 0, "Bee shows formatted definitions immediately");
  assert.equal(bee.plain, 0, "Bee has no plain-text glossary");
  assert.equal(bee.disclosures, 0);
  assert.equal(bee.brackets, false, "Bee shows no JMdict tag brackets");
  assert.ok(bee.notes > 0 && bee.custom > 0 && bee.menus > 0, JSON.stringify(bee));
  assert.equal(bee.defaultStyles, false);
  const icons = await popupRoot(tab).evaluate(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    const audio = getComputedStyle(popup.querySelector(".gsm-hoshidicts-audio-button"), "::before");
    const describe = style => ({ width: style.width, height: style.height, color: style.backgroundColor, mask: style.maskImage });
    const buttons = [".gsm-hoshidicts-audio-button", ".gsm-hoshidicts-mine-button", ".gsm-hoshidicts-note-button",
      '[data-custom-button-id="search"]', '[data-custom-button-id="template"]']
      .map(selector => popup.querySelector(selector));
    const box = button => { const style = getComputedStyle(button), rect = button.getBoundingClientRect();
      return { width: style.width, height: style.height, border: style.borderTopWidth, top: Math.round(rect.top) }; };
    const group = buttons[0].closest(".gsm-hoshidicts-entry-actions");
    const iconRects = buttons.map(button => button.getBoundingClientRect()).sort((left, right) => left.left - right.left);
    const gaps = iconRects.slice(1).map((rect, index) => rect.left - iconRects[index].right);
    const mineButton = popup.querySelector(".gsm-hoshidicts-mine-button"), savedState = mineButton.dataset.state;
    mineButton.dataset.state = "view-existing";
    const viewExistingColor = getComputedStyle(popup.querySelector(".gsm-hoshidicts-mine-icon")).backgroundColor;
    if (savedState === undefined) delete mineButton.dataset.state; else mineButton.dataset.state = savedState;
    const more = popup.querySelector(".bee-more-actions"); more.open = true;
    const overflow = more.querySelector("button"), overflowLabel = overflow.querySelector(".gsm-hoshidicts-text-action-label");
    const menu = { label: overflowLabel.textContent, visible: overflowLabel.checkVisibility(),
      icon: describe(getComputedStyle(overflow.querySelector(".bee-custom-action-icon"))),
      border: getComputedStyle(overflow).borderTopWidth };
    more.open = false;
    return { audio: describe(audio), viewExistingColor,
      mine: describe(getComputedStyle(popup.querySelector(".gsm-hoshidicts-mine-icon"))),
      note: describe(getComputedStyle(popup.querySelector(".gsm-hoshidicts-note-icon"))),
      custom: buttons.slice(3).map(button => ({ ...describe(getComputedStyle(button.querySelector(".bee-custom-action-icon"))),
        labelFontSize: getComputedStyle(button.querySelector(".gsm-hoshidicts-text-action-label")).fontSize,
        labelAriaHidden: button.querySelector(".gsm-hoshidicts-text-action-label").getAttribute("aria-hidden"),
        title: button.title, accessible: button.getAttribute("aria-label"),
        iconName: button.querySelector(".bee-custom-action-icon").dataset.icon })), menu,
      shared: getComputedStyle(popup.querySelector(".gsm-hoshidicts-mine-icon")).maskImage.includes("width%3D%2220%22"),
      buttons: buttons.map(box), gaps, grouped: buttons.every(button => group.contains(button)),
      order: [...group.querySelectorAll("button")].slice(0, 3).map(button => button.className.split(" ")[0]),
      cursors: [...popup.querySelectorAll("button:not(:disabled), summary")]
      .filter(node => node.matches("summary") || !node.closest("details:not([open])")).map(node => {
        // The cursor the user sees comes from the topmost element under the mouse.
        const rect = node.getBoundingClientRect();
        const hit = popup.getRootNode().elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return node.contains(hit) ? getComputedStyle(hit).cursor : `${node.className} covered by ${hit?.className}`;
      }) };
  });
  for (const icon of [icons.mine, icons.note, ...icons.custom, icons.menu.icon]) {
    assert.deepEqual([icon.width, icon.height, icon.color], [icons.audio.width, icons.audio.height, icons.audio.color], JSON.stringify(icons));
  }
  assert.equal(icons.viewExistingColor, icons.audio.color, "the view-existing Anki book matches the other icons' colour");
  assert.equal(icons.audio.width, "16px");
  assert.ok(icons.shared, "Anki icon comes from Hachidori's shared outline set");
  assert.deepEqual(icons.custom.map(icon => [icon.iconName, icon.labelFontSize, icon.labelAriaHidden, icon.title, icon.accessible]), [
    ["open", "0px", "true", "Open Custom button", "Open Custom button"],
    ["document-add", "0px", "true", "Send to Anki with Custom button", "Send to Anki with Custom button"],
  ], "inline custom icons keep meaningful tooltip and accessible action names");
  assert.ok(icons.custom.every(icon => icon.mask !== "none"), "custom actions use the existing shared icons");
  assert.deepEqual([icons.menu.label, icons.menu.visible, icons.menu.border], ["Custom button", true, "0px"],
    "More actions retains a readable icon and label row");
  assert.ok(icons.grouped, "audio, Anki, pencil and custom icons share one actions group");
  assert.ok(icons.gaps.every(gap => Math.abs(gap - 4) < 1), "all inline actions share a four-pixel gap");
  assert.deepEqual(icons.order, ["gsm-hoshidicts-mine-button", "gsm-hoshidicts-audio-button", "gsm-hoshidicts-note-button"], JSON.stringify(icons.order));
  for (const button of icons.buttons.slice(1)) assert.deepEqual(button, icons.buttons[0], JSON.stringify(icons.buttons));
  assert.ok(icons.cursors.every(cursor => cursor === "pointer"), `every enabled control shows a pointer: ${JSON.stringify(icons.cursors)}`);
  const tabGeometry = await popupRoot(tab).evaluate(popupShadow => [...popupShadow.querySelectorAll(".jl-tab")]
    .map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height }; }));
  assert.ok(tabGeometry.every(rect => rect.width > 0), "group tabs size to their labels like JL");
  assert.equal(tabGeometry[0].height, tabGeometry[1].height);
  assert.equal(tabGeometry[0].top, tabGeometry[1].top);
  assert.ok(Math.abs(tabGeometry[1].left - tabGeometry[0].right - 2) < 1, "group tabs use JL's two-pixel spacing");
  await settings.bringToFront();
  const previewStored = await preview.evaluate(async () => {
    const stored = await chrome.storage.local.get(["options", "dictionaryState"]);
    return { ...stored, options: HDReaderOptions.normaliseOptions(stored.options) };
  });
  for (const width of [560, 300]) {
    await preview.evaluate(({ width, stored }) => HDDesignPreview.update({ ...stored.options,
      popupWidthPx: width, showFrequencyDictionaryNames: true }, { revision: stored.dictionaryState.revision + 1,
      groups: [], dictionaries: [
        { id: "preview-definition", title: "JMdict", enabled: true, termCount: 1 },
        { id: "preview-frequency", title: "Anime frequency", enabled: true, frequencyCount: 1, frequencyMode: "rank-based" },
      ] }), { width, stored: previewStored });
    await preview.waitForFunction(() => document.getElementById("preview-host").shadowRoot
      .querySelector(".jl-dictionary")?.textContent === "JMdict");
    await preview.evaluate(() => document.getElementById("preview-host").shadowRoot.querySelector(".jl-tab").focus());
    await settings.keyboard.press("Tab");
    const layout = await preview.evaluate(() => {
      const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      const label = popup.querySelector(".jl-dictionary");
      const actions = popup.querySelector(".bee-source-actions > .gsm-hoshidicts-entry-actions");
      const rect = node => node.getBoundingClientRect().toJSON();
      const first = popup.querySelector(".jl-tab"); first.focus();
      const focus = getComputedStyle(first);
      return { popup: rect(popup), dictionary: rect(label), actions: rect(actions),
        labelWidth: label.clientWidth, labelScrollWidth: label.scrollWidth,
        frequencies: [...popup.querySelectorAll(".jl-entry:first-child .gsm-hoshidicts-tag-frequency")].map(rect),
        tabs: [...popup.querySelectorAll(".jl-tab")].map(node => node.textContent),
        focus: { visible: first.matches(":focus-visible"), offset: focus.outlineOffset, width: focus.outlineWidth } };
    });
    assert.deepEqual(layout.tabs, ["All", "Sample definitions", "Sample examples"], "synthetic preview groups identify themselves as samples");
    assert.equal(layout.labelWidth, layout.labelScrollWidth, `JMdict remains fully readable at ${width}px: ${JSON.stringify(layout)}`);
    assert.ok(Math.abs(layout.dictionary.top + layout.dictionary.height / 2 - layout.actions.top - layout.actions.height / 2) < 1,
      `dictionary and actions share a row at ${width}px`);
    assert.ok(layout.dictionary.right <= layout.actions.left && layout.actions.right <= layout.popup.right,
      `source and actions stay inside the popup at ${width}px`);
    assert.equal(layout.frequencies.length, 3, "all three frequency sources remain present");
    assert.ok(layout.frequencies.every(rect => rect.left >= layout.popup.left && rect.right <= layout.popup.right),
      `frequency metadata wraps inside the popup at ${width}px`);
    assert.deepEqual(layout.focus, { visible: true, offset: "-2px", width: "2px" }, "tab focus stays inset at the clipped popup edge");
    // The iframe is scaled to fit; capture its visible stage rather than using
    // an inner element's unscaled screenshot coordinates.
    const previewFrame = await preview.frameElement();
    await previewFrame.screenshot({ path: resolve(output, `bee-preview-layout-${width}.png`) });
    await previewFrame.dispose();
  }
  await preview.evaluate(stored => HDDesignPreview.update(stored.options, stored.dictionaryState), previewStored);
  await hover();
  const contrast = [];
  // A theme's text, bordered controls, custom icons and selected group tab.
  const BEE_CONTRAST = { text: [".jl-spelling", ".jl-reading", ".jl-deconj", ".jl-frequency", ".jl-dictionary",
    ".jl-tab", ".gsm-hoshidicts-glossary-content",
    ".gsm-hoshidicts-text-action-button", ".gsm-hoshidicts-note-field", "input", "textarea", ".gsm-hoshidicts-note-actions button"],
  borders: ".jl-tabs, .gsm-hoshidicts-text-action-button, input, textarea", icons: ".bee-custom-action-icon",
  selected: '.jl-tab[aria-pressed="true"]' };
  const checkContrast = async theme => {
    const checks = await popupRoot(tab).evaluate((popupShadow, theme) => {
      const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
      const canvas = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
      const rgba = value => {
        canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1);
        return [...canvas.getImageData(0, 0, 1, 1).data];
      };
      const blend = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] / 255 + back[index] * (1 - front[3] / 255));
      const luminance = color => color.reduce((sum, value, index) => {
        const channel = value / 255;
        return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
      }, 0);
      const ratio = (front, back) => {
        const values = [luminance(front), luminance(back)].sort((a, b) => a - b);
        return (values[1] + .05) / (values[0] + .05);
      };
      const background = (node, page) => {
        const ancestors = [];
        for (let current = node; current; current = current.parentElement) ancestors.unshift(current);
        return ancestors.reduce((color, ancestor) => blend(rgba(getComputedStyle(ancestor).backgroundColor), color), page);
      };
      const results = [];
      const check = (node, property, minimum, against = node) => {
        const color = rgba(getComputedStyle(node)[property]);
        const ratios = [[255, 255, 255], [0, 0, 0]].map(page => {
          const back = background(against, page);
          return ratio(blend(color, back), back);
        });
        results.push({ selector: node.className || node.tagName, property, minimum, ratio: Math.min(...ratios) });
      };
      for (const selector of theme.text) {
        for (const node of popup.querySelectorAll(selector)) if (node.getClientRects().length) check(node, "color", 4.5);
      }
      for (const node of popup.querySelectorAll(theme.borders)) {
        if (node.getClientRects().length) check(node, "borderTopColor", 3, node.parentElement);
      }
      for (const node of popup.querySelectorAll(theme.icons)) {
        if (node.getClientRects().length) check(node, "backgroundColor", 3, node.parentElement);
      }
      const mine = popup.querySelector(".gsm-hoshidicts-mine-button");
      const state = mine.dataset.state; mine.dataset.state = "duplicate";
      check(mine, "color", 3); mine.dataset.state = state;
      const selected = popup.querySelector(theme.selected);
      if (selected && !getComputedStyle(selected).textDecorationLine.includes("underline")) throw new Error("Selected group needs a non-colour indicator");
      const focused = popup.getRootNode().activeElement;
      if (focused?.matches(":focus-visible")) {
        if (parseFloat(getComputedStyle(focused).outlineWidth) < 2) throw new Error("Keyboard focus needs a visible outline");
        check(focused, "outlineColor", 3, focused.parentElement);
      }
      return results;
    }, theme);
    for (const check of checks) assert.ok(check.ratio >= check.minimum, JSON.stringify(check));
    contrast.push(...checks);
  };
  const checkBeeContrast = () => checkContrast(BEE_CONTRAST);
  await tab.keyboard.press("Tab");
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".jl-tab").focus());
  await checkBeeContrast();
  await popupRoot(tab).evaluate(popupShadow => popupShadow.activeElement?.blur());
  await screenshot("bee");
  const beeDesign = await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const normalised = HDReaderOptions.normaliseOptions(options);
    return { popupWidthPx: normalised.popupWidthPx, glossaryLayoutMode: normalised.glossaryLayoutMode };
  });
  const updateDesign = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  await updateDesign({ popupWidthPx: 300 });
  await hover();
  await popupRoot(tab).waitFor(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    return !popup.hidden && popup.querySelector(".bee-more-actions") && popup.getBoundingClientRect().width <= 300;
  });
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".jl-tab").focus());
  await screenshot("bee-readable-300");
  await popupRoot(tab).evaluate(popupShadow => {
    const more = popupShadow.querySelector(".bee-more-actions");
    more.open = true; more.querySelector("summary").focus();
  });
  await checkBeeContrast();
  await screenshot("bee-readable-300-more");
  await popupRoot(tab).evaluate(popupShadow => { popupShadow.querySelector(".bee-more-actions").open = false; });
  await updateDesign({ popupWidthPx: beeDesign.popupWidthPx, glossaryLayoutMode: "compact" });
  await hover();
  await tab.waitForFunction(() => document.querySelector("hachidori-host").dataset.hoshidictsGlossaryLayout === "compact");
  await screenshot("bee-compact");
  await updateDesign(beeDesign);
  await hover();
  await tab.waitForFunction(() => !document.querySelector("hachidori-host").hasAttribute("data-hoshidicts-glossary-layout"));
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector(".bee-rich-content .gloss-list"));
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-note-button").click());
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector("form:not([hidden])"));
  await checkBeeContrast();
  await screenshot("bee-note");
  await popupRoot(tab).evaluate(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    popup.querySelector("form textarea").value = "Unfinished Bee meaning";
    const more = popup.querySelector(".bee-more-actions");
    more.open = true;
    more.querySelector("summary").focus();
  });
  await tab.keyboard.press("Escape");
  assert.deepEqual(await popupRoot(tab).evaluate(shadow => {
    const popup = shadow.querySelector(".gsm-hoshidicts-popup");
    const more = popup.querySelector(".bee-more-actions");
    return { menu: more.open, popup: popup.hidden, note: popup.querySelector("form").hidden,
      draft: popup.querySelector("form textarea").value, focus: shadow.activeElement === more.querySelector("summary") };
  }), { menu: false, popup: false, note: false, draft: "Unfinished Bee meaning", focus: true },
  "the document-capture Escape handler closes More and restores focus before touching Note or popup");
  await tab.keyboard.press("Escape");
  assert.equal(await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-popup").hidden), false,
    "Escape closes Bee's Note editor before closing its popup");
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-kanji-link").click());
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector(".jl-kanji .bee-rich-content .gloss-list"));
  await screenshot("bee-kanji-rich");
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-kanji-back").focus());
  await screenshot("bee-back-focus");
  const media = await tab.createCDPSession();
  for (const scheme of ["dark", "light"]) {
    await media.send("Emulation.setEmulatedMedia", { features: [
      { name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: scheme }] });
    await screenshot(`bee-back-focus-forced-${scheme}`);
  }
  await media.send("Emulation.setEmulatedMedia", { features: [] });
  const back = await popupRoot(tab).evaluate(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    const rect = element => { const { left, top, bottom, width } = element.getBoundingClientRect(); return { left, top, bottom, width }; };
    return { back: rect(popup.querySelector(".gsm-hoshidicts-kanji-back")), popup: rect(popup), tabs: rect(popup.querySelector(".jl-tabs")) };
  });
  assert.ok(back.back.left - back.popup.left < back.popup.width / 4, `kanji Back sits top left in Bee ${JSON.stringify(back)}`);
  assert.ok(Math.abs(back.back.left - back.popup.left) <= 1, "kanji Back reaches the popup's left edge");
  assert.ok(back.back.bottom <= back.tabs.top, "kanji Back sits above the tab row");
  await tab.evaluate(() => document.getElementById("word").textContent = "漢字");
  await tab.keyboard.press("Escape");
  await hover();
  await popupRoot(tab).waitFor(popupShadow => popupShadow.querySelector(".jl-spelling")?.textContent === "漢字");
  await popupRoot(tab).waitFor(popupShadow => [...popupShadow.querySelectorAll(".bee-rich-content img")]
    .some(image => image.complete && image.naturalWidth > 0));
  assert.ok(await popupRoot(tab).evaluate(popupShadow => !!popupShadow.querySelector(".bee-rich-content table")));
  const imageBox = await popupRoot(tab).evaluate(popupShadow => {
    const { left, top, width, height } = popupShadow.querySelector(".bee-rich-content img").getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  });
  await tab.mouse.move(imageBox.x, imageBox.y);
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector(".gsm-hoshidicts-image-hover-preview img"));
  const enlarged = await popupRoot(tab).evaluate(shadow => {
    const preview = shadow.querySelector(".gsm-hoshidicts-image-hover-preview");
    const source = shadow.querySelector(".bee-rich-content img");
    return { sibling: preview.parentNode === shadow.querySelector(".gsm-hoshidicts-popup").parentNode,
      larger: preview.getBoundingClientRect().width > source.getBoundingClientRect().width * 2,
      sameSource: preview.querySelector("img").src === source.src, visible: getComputedStyle(preview).visibility === "visible" };
  });
  assert.deepEqual(enlarged, { sibling: true, larger: true, sameSource: true, visible: true }, JSON.stringify(enlarged));
  await screenshot("bee-image-preview");
  await tab.mouse.move(0, 0);
  await popupRoot(tab).waitFor(popupShadow => !popupShadow.querySelector(".gsm-hoshidicts-image-hover-preview"));
  await hover();
  await checkBeeContrast();
  await screenshot("bee-structured-rich");
  for (const scheme of ["dark", "light"]) {
    await media.send("Emulation.setEmulatedMedia", { features: [
      { name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: scheme }] });
    await checkBeeContrast();
    await screenshot(`bee-forced-${scheme}`);
  }
  await media.send("Emulation.setEmulatedMedia", { features: [] });
  await settings.bringToFront();
  await settings.screenshot({ path: resolve(output, "store-bee.png") });
  // Crystal: one header per word, then a framed section per dictionary with
  // its own audio, Anki and pencil; the first section's controls end the header.
  const CRYSTAL_CONTRAST = { text: [".crystal-spelling", ".crystal-reading", ".crystal-deconj", ".gsm-hoshidicts-tag-frequency",
    ".crystal-dictionary", ".crystal-tab", ".crystal-tag", ".gsm-hoshidicts-glossary-content", ".gsm-hoshidicts-kanji-back",
    ".gsm-hoshidicts-text-action-button", ".gsm-hoshidicts-note-field", "input", "textarea", ".gsm-hoshidicts-note-actions button"],
  borders: ".crystal-tab, .gsm-hoshidicts-tag-frequency, .gsm-hoshidicts-kanji-back, input, textarea, .gsm-hoshidicts-audio-button, "
    + ".gsm-hoshidicts-mine-button, .gsm-hoshidicts-note-button",
  icons: ".crystal-custom-action-icon, .gsm-hoshidicts-mine-icon, .gsm-hoshidicts-note-icon",
  selected: '.crystal-tab[aria-pressed="true"]' };
  await settings.click(".theme-store-card:nth-child(6) button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "crystal");
  // Three actions, so the third is listed under More actions.
  await updateDesign({ customButtons: [
    { id: "crystal-search", type: "link", label: "Search", url: "https://example.test/%w" },
    { id: "crystal-card", type: "anki", label: "Sentence card", templateId: "default" },
    { id: "crystal-examples", type: "link", label: "Example sentences", url: "https://example.test/%r" }] });
  await tab.evaluate(() => { document.getElementById("word").textContent = "食べたかった"; });
  await tab.keyboard.press("Escape");
  const crystalReady = () => popupRoot(tab).waitFor(popupShadow => {
    const buttons = [...popupShadow.querySelectorAll(".gsm-hoshidicts-mine-button")];
    return popupShadow.host.dataset.hoshidictsRenderer === "crystal" && buttons.length > 0
      && buttons.every(button => !button.hidden && !button.disabled && button.dataset.state === "ready");
  });
  await hover();
  await crystalReady();
  const crystal = await popupRoot(tab).evaluate(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    return { tabs: [...popup.querySelectorAll(".crystal-tab")].map(node => node.textContent),
      results: [...popup.querySelectorAll(".crystal-result")].map(result => ({ heads: result.querySelectorAll(".crystal-head").length,
        sections: result.querySelectorAll(".crystal-block").length,
        controls: [...result.querySelectorAll('.gsm-hoshidicts-entry-actions[aria-label="Entry actions"]')].map(group =>
          [group.querySelectorAll(".gsm-hoshidicts-audio-button").length, group.querySelector(".gsm-hoshidicts-mine-button").dataset.state]) })),
      headControls: !!popup.querySelector(".crystal-head-actions .gsm-hoshidicts-mine-button"),
      defaultStyles: popupShadow.adoptedStyleSheets.some(sheet => [...sheet.cssRules].some(rule => rule.cssText.includes(".gsm-hoshidicts-glossary-card"))) };
  });
  assert.deepEqual(crystal.tabs, ["All", "English", "Study"]);
  assert.ok(crystal.results.length > 1 && crystal.results.every(result => result.heads === 1 && result.sections > 0),
    `one header per result, then its sections: ${JSON.stringify(crystal)}`);
  assert.ok(crystal.results.every(result => result.controls.length === result.sections
    && result.controls.every(([audio, mining]) => audio === 1 && mining === "ready")), `every section has its own audio and Anki button: ${JSON.stringify(crystal)}`);
  assert.equal(crystal.headControls, true, "the first section's controls end the header");
  assert.equal(crystal.defaultStyles, false);
  assert.deepEqual(await settings.$$eval("#opt-popup-theme-variant option", nodes => nodes.map(node => node.textContent)),
    ["Automatic", "Grey", "Beige", "Retro blue"], "Design → Colours lists Crystal's variants after Automatic");
  assert.equal(await settings.$eval("#opt-popup-theme-variant", node => node.checkVisibility()), true);
  await tab.keyboard.press("Tab");
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".crystal-tab").focus());
  await checkContrast(CRYSTAL_CONTRAST);
  await popupRoot(tab).evaluate(popupShadow => popupShadow.activeElement?.blur());
  await screenshot("crystal");
  // Each colour variant chosen in Design → Colours recolours the open popup
  // and the preview through the host attribute, without a new lookup.
  const panels = {};
  const crystalPanel = () => popupRoot(tab).evaluate(popupShadow =>
    getComputedStyle(popupShadow.querySelector(".gsm-hoshidicts-popup")).backgroundColor);
  for (const variant of ["grey", "beige", "blue"]) {
    await settings.bringToFront();
    await settings.select("#opt-popup-theme-variant", variant);
    await settings.waitForFunction(async variant => (await chrome.storage.local.get("options")).options.popupThemeVariant === variant,
      {}, variant);
    await popupRoot(tab).waitFor((popupShadow, variant) => popupShadow.host.dataset.hoshidictsThemeVariant === variant, {}, variant);
    assert.equal(await preview.evaluate(() => document.getElementById("preview-host").dataset.hoshidictsThemeVariant), variant,
      `the Design preview shows ${variant}`);
    await hover();
    await crystalReady();
    await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".crystal-tab").focus());
    await checkContrast(CRYSTAL_CONTRAST);
    await popupRoot(tab).evaluate(popupShadow => popupShadow.activeElement?.blur());
    panels[variant] = await crystalPanel();
    await screenshot(`crystal-${variant}`);
  }
  assert.equal(new Set(Object.values(panels)).size, 3, `three panel colours: ${JSON.stringify(panels)}`);
  // Automatic is Beige in the system's light mode and Grey in its dark mode.
  await settings.bringToFront();
  await settings.select("#opt-popup-theme-variant", "auto");
  await popupRoot(tab).waitFor(popupShadow => !popupShadow.host.hasAttribute("data-hoshidicts-theme-variant"));
  for (const [scheme, variant] of [["light", "beige"], ["dark", "grey"]]) {
    await media.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await hover();
    await crystalReady();
    assert.equal(await crystalPanel(), panels[variant], `Automatic is ${variant} in ${scheme} mode`);
    await checkContrast(CRYSTAL_CONTRAST);
  }
  await media.send("Emulation.setEmulatedMedia", { features: [] });
  await updateDesign({ popupWidthPx: 300 });
  await hover();
  await crystalReady();
  const narrow = await popupRoot(tab).evaluate(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    const box = popup.getBoundingClientRect();
    const more = popup.querySelector(".crystal-more-actions");
    if (!more) return { more: false };
    more.open = true; more.querySelector("summary").focus();
    return { more: true, width: box.width, inside: [...popup.querySelectorAll(".crystal-head > *, .crystal-word > *, .crystal-banner > *, .crystal-action-menu")]
      .filter(node => node.getClientRects().length).every(node => {
        const rect = node.getBoundingClientRect(); return rect.left >= box.left && rect.right <= box.right + 0.5;
      }) };
  });
  assert.ok(narrow.more && narrow.width <= 300 && narrow.inside, `the header, banners and More actions stay inside a 300 px popup: ${JSON.stringify(narrow)}`);
  await checkContrast(CRYSTAL_CONTRAST);
  await screenshot("crystal-300-more");
  await popupRoot(tab).evaluate(popupShadow => { popupShadow.querySelector(".crystal-more-actions").open = false; });
  await updateDesign({ popupWidthPx: beeDesign.popupWidthPx });
  await hover();
  await crystalReady();
  await popupRoot(tab).evaluate(popupShadow => popupShadow.querySelector(".gsm-hoshidicts-note-button").click());
  await popupRoot(tab).waitFor(popupShadow => !!popupShadow.querySelector("form:not([hidden])"));
  await checkContrast(CRYSTAL_CONTRAST);
  await screenshot("crystal-note");
  await tab.keyboard.press("Escape");
  assert.deepEqual(await popupRoot(tab).evaluate(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    return { popup: popup.hidden, note: popup.querySelector("form").hidden };
  }), { popup: false, note: true }, "Escape closes Crystal's Note editor before its popup");
  for (const variant of ["auto", "blue"]) {
    await updateDesign({ popupThemeVariant: variant });
    await popupRoot(tab).waitFor((popupShadow, variant) => (popupShadow.host.dataset.hoshidictsThemeVariant ?? "auto") === variant,
      {}, variant);
    for (const scheme of ["dark", "light"]) {
      await media.send("Emulation.setEmulatedMedia", { features: [
        { name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: scheme }] });
      await checkContrast(CRYSTAL_CONTRAST);
      await screenshot(`crystal-forced-${variant === "auto" ? "" : `${variant}-`}${scheme}`);
    }
  }
  await media.send("Emulation.setEmulatedMedia", { features: [] });
  await updateDesign({ popupThemeVariant: "auto" });
  await settings.bringToFront();
  await settings.screenshot({ path: resolve(output, "store-crystal.png") });
  await settings.click(".theme-store-card:first-child button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "default");
  assert.equal(await settings.$$eval("#design :is([data-design-setting], [data-design-group], #popup-theme-hint):not([hidden])",
    nodes => nodes.length), await settings.$$eval("#design :is([data-design-setting], [data-design-group])", nodes => nodes.length),
  "Default shows every Design control and no theme hint");
  console.log("hover");
  await hover();
  await popupRoot(tab).waitFor(popupShadow => {
    const popup = popupShadow.querySelector(".gsm-hoshidicts-popup");
    return popup && !popup.querySelector(".nazeka-word") && !popup.querySelector(".gsm-hoshidicts-result-chrome")?.hidden;
  });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ chrome: await browser.version(), ...evidence, contrast,
    checks: ["Store available without experimental opt-in", "Smaller Anki cards and Word highlighting start off in normal Settings", "Smaller Anki cards saves and reloads through its Anki control", "six bundled themes", "Next and Previous themes buttons", "Plain definitions only", "Design shows each theme's declared settings and choosing a theme writes only popupTheme", "JL blocks and actions", "JL pitch switch repaints the open popup and the preview", "Bee All and group tabs, formatted-only definitions, uniform action icons, Note, custom actions and kanji images", "Bee custom actions use matching inline icons with accessible names and readable More labels", "Bee source/actions and three frequencies stay readable at 560 and 300px", "Bee preview sample labels and inset keyboard tab focus", "Bee More Escape restores focus and preserves Note before popup dismissal", "Bee WCAG AA text and control/focus contrast over white and black pages", "Crystal header, framed sections and per-section actions", "Crystal stays inside 300px with More actions", "Crystal Escape closes Note before the popup", "Crystal WCAG AA text and control/focus contrast over white and black pages, including forced colours", "Crystal Grey, Beige and Retro blue from Design → Colours, and Automatic following light and dark mode", "Nazeka hover", "kanji and Back", "Default restore"], errors }, null, 2));
  console.log(`PASS: normal Settings, carousel buttons, Nazeka actions, kanji/Back, Plain definitions, JL and Bee actions, Bee rich content, Crystal sections, colours and contrast and Default restore. Evidence: ${output}`);
} catch (error) { console.error(error); throw error; } finally {
  await browser?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
