// Focused MVP check: Store opt-in, real hover, kanji/Back, and Default restore.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
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
  assert.equal(await settings.$eval("#theme-store", node => node.hidden), true);
  await settings.evaluate(() => { location.hash = "advanced"; });
  await settings.waitForSelector("#opt-experimental-themeStore", { visible: true });
  await settings.click("#opt-experimental-themeStore");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options?.experimental?.themeStore === true);
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
  assert.equal(await settings.$$eval(".theme-store-card", cards => cards.length), 5);
  const tab = await browser.newPage();
  tab.on("pageerror", error => { errors.push(error.message); console.log("tab error", error.message); });
  tab.on("console", message => { if (["error", "warn"].includes(message.type())) console.log(message.type(), message.text()); });
  await tab.setViewport({ width: 1100, height: 800 });
  await tab.goto(`http://127.0.0.1:${server.address().port}`);
  const popup = () => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
  const hover = async () => {
    await tab.bringToFront();
    await tab.mouse.move(2, 2);
    const point = await tab.$eval("#word", node => {
      const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 1);
      const box = range.getBoundingClientRect(); return { x: box.x + box.width * .2, y: box.y + box.height / 2 };
    });
    await tab.mouse.move(point.x, point.y);
    await tab.waitForFunction(() => {
      const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
      return popup && !popup.hidden && popup.querySelector(".gsm-hoshidicts-entry");
    });
  };
  const screenshot = async name => {
    const handle = await tab.evaluateHandle(popup);
    await handle.asElement().screenshot({ path: resolve(output, `${name}.png`) });
    await handle.dispose();
  };
  console.log("hover");
  await hover();
  await tab.waitForFunction(() => {
    const button = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-mine-button");
    return button && !button.hidden && !button.disabled;
  });
  await screenshot("default");
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-note-button").click());
  await settings.bringToFront();
  await settings.click(".theme-store-card:nth-child(2) button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "nazeka");
  console.log("hover");
  await hover();
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".nazeka-reading")?.textContent === "たべる");
  const evidence = await tab.evaluate(() => {
    const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
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
  assert.equal(await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup").hidden), true,
    "switching away from Note releases editing so Escape can close Nazeka");
  await hover();
  await tab.waitForFunction(() => {
    const button = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-mine-button");
    return button && !button.hidden && !button.disabled;
  });
  const controls = await tab.evaluate(() => {
    const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
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
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-link").click());
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".nazeka-kanji-info"));
  await screenshot("nazeka-kanji");
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back").click());
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".nazeka-word"));
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
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".plain-scroll"));
  const plain = await tab.evaluate(() => {
    const shadow = document.querySelector("hachidori-host").shadowRoot;
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
  await tab.waitForFunction(() => {
    const buttons = [...document.querySelector("hachidori-host")?.shadowRoot?.querySelectorAll(".jl-entry .gsm-hoshidicts-mine-button") ?? []];
    return buttons.length > 0 && buttons.every(button => !button.hidden && !button.disabled);
  });
  const jl = await tab.evaluate(() => {
    const shadow = document.querySelector("hachidori-host").shadowRoot;
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
  assert.ok((await designShown()).includes("Show pitch in furigana"));
  await tab.evaluate(() => { document.querySelector("hachidori-host").shadowRoot.querySelector(".jl-entry").dataset.pitchProbe = ""; });
  const popupMarks = await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelectorAll(".jl-mora").length);
  const previewMarks = await preview.evaluate(() => document.getElementById("preview-host").shadowRoot.querySelectorAll(".jl-mora").length);
  assert.ok(popupMarks > 0 && previewMarks > 0, "JL marks pitch in the popup and the preview");
  for (const shown of [false, true]) {
    await settings.$eval("#opt-pitch-furigana", input => input.click());
    await tab.waitForFunction(count => {
      const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
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
        { id: "search", type: "link", label: "Search", url: "https://example.test/%w" },
        { id: "template", type: "anki", label: "My card", templateId: "default" },
        { id: "extra", type: "link", label: "Another search", url: "https://example.test/%r" },
      ] } });
    if (!reply.ok) throw new Error(reply.error);
  });
  await settings.click(".theme-store-card:nth-child(5) button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "bee");
  await hover();
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsRenderer === "bee");
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot.querySelector(".bee-more-actions"));
  const bee = await tab.evaluate(() => {
    const shadow = document.querySelector("hachidori-host").shadowRoot;
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
  assert.deepEqual(bee.tabs, ["English", "Study"]);
  assert.ok(bee.rich > 0, "Bee shows formatted definitions immediately");
  assert.equal(bee.plain, 0, "Bee has no plain-text glossary");
  assert.equal(bee.disclosures, 0);
  assert.equal(bee.brackets, false, "Bee shows no JMdict tag brackets");
  assert.ok(bee.notes > 0 && bee.custom > 0 && bee.menus > 0, JSON.stringify(bee));
  assert.equal(bee.defaultStyles, false);
  const icons = await tab.evaluate(() => {
    const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
    const audio = getComputedStyle(popup.querySelector(".gsm-hoshidicts-audio-button"), "::before");
    const describe = style => ({ width: style.width, height: style.height, color: style.backgroundColor, mask: style.maskImage });
    const buttons = [".gsm-hoshidicts-audio-button", ".gsm-hoshidicts-mine-button", ".gsm-hoshidicts-note-button"]
      .map(selector => popup.querySelector(selector));
    const box = button => { const style = getComputedStyle(button), rect = button.getBoundingClientRect();
      return { width: style.width, height: style.height, border: style.borderTopWidth, top: Math.round(rect.top) }; };
    const group = buttons[0].closest(".gsm-hoshidicts-entry-actions");
    const mineButton = popup.querySelector(".gsm-hoshidicts-mine-button"), savedState = mineButton.dataset.state;
    mineButton.dataset.state = "view-existing";
    const viewExistingColor = getComputedStyle(popup.querySelector(".gsm-hoshidicts-mine-icon")).backgroundColor;
    if (savedState === undefined) delete mineButton.dataset.state; else mineButton.dataset.state = savedState;
    return { audio: describe(audio), viewExistingColor,
      mine: describe(getComputedStyle(popup.querySelector(".gsm-hoshidicts-mine-icon"))),
      note: describe(getComputedStyle(popup.querySelector(".gsm-hoshidicts-note-icon"))),
      shared: getComputedStyle(popup.querySelector(".gsm-hoshidicts-mine-icon")).maskImage.includes("width%3D%2220%22"),
      buttons: buttons.map(box), grouped: buttons.every(button => group.contains(button)),
      order: [...group.querySelectorAll("button")].slice(0, 3).map(button => button.className.split(" ")[0]),
      cursors: [...popup.querySelectorAll("button:not(:disabled), summary")]
      .filter(node => node.matches("summary") || !node.closest("details:not([open])")).map(node => {
        // The cursor the user sees comes from the topmost element under the mouse.
        const rect = node.getBoundingClientRect();
        const hit = popup.getRootNode().elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return node.contains(hit) ? getComputedStyle(hit).cursor : `${node.className} covered by ${hit?.className}`;
      }) };
  });
  for (const icon of [icons.mine, icons.note]) {
    assert.deepEqual([icon.width, icon.height, icon.color], [icons.audio.width, icons.audio.height, icons.audio.color], JSON.stringify(icons));
  }
  assert.equal(icons.viewExistingColor, icons.audio.color, "the view-existing Anki book matches the other icons' colour");
  assert.equal(icons.audio.width, "16px");
  assert.ok(icons.shared, "Anki icon comes from Hachidori's shared outline set");
  assert.ok(icons.grouped, "audio, Anki and pencil share one actions group");
  assert.deepEqual(icons.order, ["gsm-hoshidicts-mine-button", "gsm-hoshidicts-audio-button", "gsm-hoshidicts-note-button"], JSON.stringify(icons.order));
  for (const button of icons.buttons.slice(1)) assert.deepEqual(button, icons.buttons[0], JSON.stringify(icons.buttons));
  assert.ok(icons.cursors.every(cursor => cursor === "pointer"), `every enabled control shows a pointer: ${JSON.stringify(icons.cursors)}`);
  const tabGeometry = await tab.evaluate(() => [...document.querySelector("hachidori-host").shadowRoot.querySelectorAll(".jl-tab")]
    .map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height }; }));
  assert.ok(Math.abs(tabGeometry[0].width - tabGeometry[1].width) < 1, "group tabs have equal widths despite different label lengths");
  assert.equal(tabGeometry[0].height, tabGeometry[1].height);
  assert.equal(tabGeometry[0].top, tabGeometry[1].top);
  assert.ok(Math.abs(tabGeometry[0].right - tabGeometry[1].left) < 1, "group tabs share an edge without gaps");
  const contrast = [];
  const checkBeeContrast = async () => {
    const checks = await tab.evaluate(() => {
      const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
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
      for (const selector of [".jl-spelling", ".jl-reading", ".jl-deconj", ".jl-frequency", ".jl-dictionary",
        ".jl-tab", ".gsm-hoshidicts-glossary-content",
        ".gsm-hoshidicts-text-action-button", ".gsm-hoshidicts-note-field", "input", "textarea", ".gsm-hoshidicts-note-actions button"]) {
        for (const node of popup.querySelectorAll(selector)) if (node.getClientRects().length) check(node, "color", 4.5);
      }
      for (const node of popup.querySelectorAll(".jl-tabs, .gsm-hoshidicts-text-action-button, input, textarea")) {
        if (node.getClientRects().length) check(node, "borderTopColor", 3, node.parentElement);
      }
      const mine = popup.querySelector(".gsm-hoshidicts-mine-button");
      const state = mine.dataset.state; mine.dataset.state = "duplicate";
      check(mine, "color", 3); mine.dataset.state = state;
      const selected = popup.querySelector('.jl-tab[aria-pressed="true"]');
      if (selected && !getComputedStyle(selected).textDecorationLine.includes("underline")) throw new Error("Selected group needs a non-colour indicator");
      const focused = popup.getRootNode().activeElement;
      if (focused?.matches(":focus-visible")) {
        if (parseFloat(getComputedStyle(focused).outlineWidth) < 2) throw new Error("Keyboard focus needs a visible outline");
        check(focused, "outlineColor", 3, focused.parentElement);
      }
      return results;
    });
    for (const check of checks) assert.ok(check.ratio >= check.minimum, JSON.stringify(check));
    contrast.push(...checks);
  };
  await tab.keyboard.press("Tab");
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".jl-tab").focus());
  await checkBeeContrast();
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.activeElement?.blur());
  await screenshot("bee");
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot.querySelector(".bee-rich-content .gloss-list"));
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-note-button").click());
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot.querySelector("form:not([hidden])"));
  await checkBeeContrast();
  await screenshot("bee-note");
  await tab.keyboard.press("Escape");
  assert.equal(await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup").hidden), false,
    "Escape closes Bee's Note editor before closing its popup");
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-link").click());
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot.querySelector(".jl-kanji .bee-rich-content .gloss-list"));
  await screenshot("bee-kanji-rich");
  const back = await tab.evaluate(() => {
    const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
    const rect = element => { const { left, top, bottom, width } = element.getBoundingClientRect(); return { left, top, bottom, width }; };
    return { back: rect(popup.querySelector(".gsm-hoshidicts-kanji-back")), popup: rect(popup), tabs: rect(popup.querySelector(".jl-tabs")) };
  });
  assert.ok(back.back.left - back.popup.left < back.popup.width / 4, `kanji Back sits top left in Bee ${JSON.stringify(back)}`);
  assert.ok(Math.abs(back.back.left - back.tabs.left) < 2, "kanji Back aligns with the tab row's left edge");
  assert.ok(back.back.bottom <= back.tabs.top, "kanji Back sits above the tab row");
  await tab.evaluate(() => document.getElementById("word").textContent = "漢字");
  await tab.keyboard.press("Escape");
  await hover();
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot.querySelector(".jl-spelling")?.textContent === "漢字");
  await tab.waitForFunction(() => [...document.querySelector("hachidori-host")?.shadowRoot.querySelectorAll(".bee-rich-content img") ?? []]
    .some(image => image.complete && image.naturalWidth > 0));
  assert.ok(await tab.evaluate(() => !!document.querySelector("hachidori-host").shadowRoot.querySelector(".bee-rich-content table")));
  const imageBox = await tab.evaluate(() => {
    const { left, top, width, height } = document.querySelector("hachidori-host").shadowRoot.querySelector(".bee-rich-content img").getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  });
  await tab.mouse.move(imageBox.x, imageBox.y);
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot.querySelector(".gsm-hoshidicts-image-hover-preview img"));
  const enlarged = await tab.evaluate(() => {
    const shadow = document.querySelector("hachidori-host").shadowRoot;
    const preview = shadow.querySelector(".gsm-hoshidicts-image-hover-preview");
    const source = shadow.querySelector(".bee-rich-content img");
    return { sibling: preview.parentNode === shadow.querySelector(".gsm-hoshidicts-popup").parentNode,
      larger: preview.getBoundingClientRect().width > source.getBoundingClientRect().width * 2,
      sameSource: preview.querySelector("img").src === source.src, visible: getComputedStyle(preview).visibility === "visible" };
  });
  assert.deepEqual(enlarged, { sibling: true, larger: true, sameSource: true, visible: true }, JSON.stringify(enlarged));
  await screenshot("bee-image-preview");
  await tab.mouse.move(0, 0);
  await tab.waitForFunction(() => !document.querySelector("hachidori-host")?.shadowRoot.querySelector(".gsm-hoshidicts-image-hover-preview"));
  await hover();
  await checkBeeContrast();
  await screenshot("bee-structured-rich");
  const media = await tab.createCDPSession();
  for (const scheme of ["dark", "light"]) {
    await media.send("Emulation.setEmulatedMedia", { features: [
      { name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: scheme }] });
    await checkBeeContrast();
    await screenshot(`bee-forced-${scheme}`);
  }
  await media.send("Emulation.setEmulatedMedia", { features: [] });
  await settings.bringToFront();
  await settings.screenshot({ path: resolve(output, "store-bee.png") });
  await settings.click(".theme-store-card:first-child button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "default");
  assert.equal(await settings.$$eval("#design :is([data-design-setting], [data-design-group], #popup-theme-hint):not([hidden])",
    nodes => nodes.length), await settings.$$eval("#design :is([data-design-setting], [data-design-group])", nodes => nodes.length),
  "Default shows every Design control and no theme hint");
  console.log("hover");
  await hover();
  await tab.waitForFunction(() => {
    const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
    return popup && !popup.querySelector(".nazeka-word") && !popup.querySelector(".gsm-hoshidicts-result-chrome")?.hidden;
  });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ chrome: await browser.version(), ...evidence, contrast,
    checks: ["Store hidden by default", "experimental opt-in", "five bundled themes", "Next and Previous themes buttons", "Plain definitions only", "Design shows each theme's declared settings and choosing a theme writes only popupTheme", "JL blocks and actions", "JL pitch switch repaints the open popup and the preview", "Bee group-only tabs, formatted-only definitions, uniform action icons, Note, custom actions and kanji images", "Bee WCAG AA text and control/focus contrast over white and black pages", "Nazeka hover", "kanji and Back", "Default restore"], errors }, null, 2));
  console.log(`PASS: Store opt-in, carousel buttons, Nazeka actions, kanji/Back, Plain definitions, JL and Bee actions, Bee rich content and Default restore. Evidence: ${output}`);
} catch (error) { console.error(error); throw error; } finally {
  await browser?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
