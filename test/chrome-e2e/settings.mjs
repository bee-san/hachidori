/*
 * Settings: Anki detection, autosave, transport, Design, audio, Anki and dictionary CSS.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./first-run.mjs";
import { describe } from "node:test";
import { CUSTOM_DICTIONARY_SOURCE_KEY } from "../../extension/custom-dictionary.js";
import { AnkiConnectError, answerAnkiConnect } from "../anki-connect-fake.mjs";
import { checkSettingsFeedback } from "../chrome-settings-feedback-scenarios.mjs";
import { startupUrl } from "./first-run.mjs";
import { check, diagnostics, step } from "./harness.mjs";
import {
  browser,
  cycleVisualNovelScene,
  editSettingsControls,
  interceptFetches,
  makeAudioWav,
  page,
  readSettingsControls,
  readVisualNovelScene,
  settingsUrl,
  showSettingsSection,
} from "./session.mjs";

async function checkDictionaryStyles(page) {
  await page.addScriptTag({ url: new URL("external-links.js", page.url()).href });
  await page.addScriptTag({ url: new URL("render/glossary.js", page.url()).href });
  const requests = [];
  const intercept = (request) => {
    if (request.url().startsWith("https://dictionary-style.invalid/")) {
      requests.push(request.url());
      void request.abort();
    } else {
      void request.continue();
    }
  };
  await page.setRequestInterception(true);
  page.on("request", intercept);
  let evidence;
  try {
    evidence = await page.evaluate(async () => {
      const host = document.createElement("div");
      host.style.cssText = [
        "all:initial!important",
        "position:fixed!important",
        "top:0!important",
        "left:0!important",
        "width:440px!important",
        "height:340px!important",
        "pointer-events:auto!important",
        "z-index:2147483647!important",
      ].join(";");
      host.style.setProperty("--external", 'url("https://dictionary-style.invalid/inherited.png")');
      host.style.setProperty("--local-inherited", 'url("https://dictionary-style.invalid/local-inherited.png")');
      host.style.setProperty("--bugd-well", "rgb(200, 0, 0)");
      host.style.setProperty("--light-border-color", "rgb(200, 0, 0)");
      for (const suffix of [" evil", ")evil", ",evil"]) {
        host.style.setProperty(`--fg${suffix}`, 'url("https://dictionary-style.invalid/escaped-var.png")');
      }
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      const readerStyles = new CSSStyleSheet();
      readerStyles.replaceSync(await (await fetch(chrome.runtime.getURL("render/reader.css"))).text());
      shadow.adoptedStyleSheets = [readerStyles];
      const pageFont = document.createElement("style");
      pageFont.textContent = '@font-face { font-family:page-resource-test; src:url("https://dictionary-style.invalid/page-font.woff2"); } @function --external-image() { result:url("https://dictionary-style.invalid/function.png"); } @property --text-color { syntax:"<image>"; inherits:true; initial-value:url("https://dictionary-style.invalid/registered.png"); } @property --font-size-no-units { syntax:"<image>"; inherits:true; initial-value:url("https://dictionary-style.invalid/registered-number.png"); } @property --local-registered { syntax:"<image>"; inherits:true; initial-value:url("https://dictionary-style.invalid/local-registered.png"); }';
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:20px;width:400px;height:300px";
      popup.innerHTML = '<button class="outside" style="color:rgb(9, 9, 9)">Reader control</button>';
      shadow.appendChild(popup);
      const addGlossary = (dictionary) => {
        const card = document.createElement("div");
        card.className = "gsm-hoshidicts-glossary-card";
        card.style.cssText = "width:200px;height:100px;box-sizing:border-box";
        const glossary = document.createElement("div");
        glossary.className = "gsm-hoshidicts-glossary-content";
        glossary.dataset.hoshidictsDictionary = dictionary;
        card.appendChild(glossary);
        popup.appendChild(card);
        return glossary;
      };
      const escapedTitle = '辞書 "\\\n] title';
      const inside = addGlossary("scope-test");
      inside.innerHTML = '<span class="inside">Definition <b class="nested">nested</b></span>';
      const escaped = addGlossary(escapedTitle);
      escaped.textContent = "Escaped title";
      const variables = addGlossary("variable-test");
      variables.innerHTML = '<div data-sc-grammar-card><details><summary>Source</summary><div>Body</div></details><div class="row">Row</div></div>';
      const apply = (generation, entries) => HDGlossary.applyDictionaryStyles(document, shadow, generation, entries);
      const styles = apply(1, [
        { dictionary: "scope-test", styles: '.inside { color:rgb(1, 2, 3); background:radial-gradient(var(--text-color, var(--fg, #333)), transparent); font-size:calc(var(--font-size-no-units) * 1px); & .nested { font-weight:900; } } } .outside { color:rgb(200, 0, 0) !important; } :host { --escaped:yes; } @scope (.unused) {' },
        { dictionary: escapedTitle, styles: ':scope { color:rgb(4, 5, 6); }' },
        // The shape Bee's Ultimate Grammar Dictionary draws its disclosures with.
        { dictionary: "variable-test", styles: [
          "[data-sc-grammar-card] { --bugd-gap:7px; --bugd-well:rgb(1, 2, 3); --bugd-edge:var(--light-border-color, rgb(4, 5, 6)); }",
          "[data-sc-grammar-card] .row { margin-top:var(--bugd-gap); background:var(--bugd-well); border-top:1px solid var(--bugd-edge); }",
          "[data-sc-grammar-card] summary { display:flex; align-items:center; list-style:none; }",
          "[data-sc-grammar-card] summary::marker { content:''; }",
          "[data-sc-grammar-card] summary::before { content:''; width:0.62em; height:0.62em; border-right:2px solid currentColor; border-bottom:2px solid currentColor; transform:rotate(-45deg); }",
        ].join("\n") },
        { dictionary: "scope-test", styles: '.inside { color:red; }' },
      ]);
      const scope = {
        count: styles.length,
        inside: getComputedStyle(inside.querySelector(".inside")).color,
        nested: getComputedStyle(inside.querySelector(".nested")).fontWeight,
        gradient: getComputedStyle(inside.querySelector(".inside")).backgroundImage,
        fontSize: getComputedStyle(inside.querySelector(".inside")).fontSize,
        escapedTitle: getComputedStyle(escaped).color,
        outside: getComputedStyle(popup.querySelector(".outside")).color,
        escapedHost: getComputedStyle(host).getPropertyValue("--escaped"),
        rowGap: getComputedStyle(variables.querySelector(".row")).marginTop,
        rowWell: getComputedStyle(variables.querySelector(".row")).backgroundColor,
        rowEdge: getComputedStyle(variables.querySelector(".row")).borderTopColor,
        summaryDisplay: getComputedStyle(variables.querySelector("summary")).display,
        summaryListStyle: getComputedStyle(variables.querySelector("summary")).listStyleType,
        chevronDisplay: getComputedStyle(variables.querySelector("summary"), "::before").display,
        chevronTransform: getComputedStyle(variables.querySelector("summary"), "::before").transform,
      };
      document.head.appendChild(pageFont);
      host.style.setProperty("--hoshidicts-palette-base-content", 'url("https://dictionary-style.invalid/palette.png")', "important");
      const network = addGlossary("network-test");
      const resourceCases = [
        'background-image:url("https://dictionary-style.invalid/direct.png")',
        'background-image:u\\72l("https://dictionary-style.invalid/escaped.png")',
        'background-image:image-set("https://dictionary-style.invalid/set.png" 1x)',
        '--image:u\\72l("https://dictionary-style.invalid/custom.png");background-image:var(--image)',
        'background-image:var(--external)',
        'background-image:var(--text-color)',
        'background-image:var(--font-size-no-units)',
        'background-image:var(--fg, var(--external))',
        'font-family:page-resource-test',
        'font:16px page-resource-test',
        'background:var(--external)',
        'background-image:var(--fg\\ evil)',
        'background-image:var(--fg\\)evil)',
        'background-image:var(--fg\\,evil)',
        'background-image:v\\61\r\nr(--external)',
        'background-image:--external-image()',
        'background-image:\\2d\\2d external-image()',
        'background-image:var(--local-inherited)',
        '--local-registered:4px;background:var(--local-registered)',
        '--local-url:url("https://dictionary-style.invalid/local-url.png");background-image:var(--local-url)',
        '--local-font:page-resource-test;font-family:var(--local-font)',
      ];
      network.innerHTML = resourceCases.map((_, index) => `<div class="resource-${index}">Resource test</div>`).join("");
      apply(2, [{ dictionary: "network-test", styles: [
        '@import url("https://dictionary-style.invalid/import.css");',
        '@font-face { font-family:remote-test; src:url("https://dictionary-style.invalid/font.woff2"); }',
        ...resourceCases.map((value, index) => `.resource-${index} { ${value}; color:rgb(7, 8, 9); }`),
        '.resource-0 { font-family:remote-test; }',
        '.resource-0::before { content:"/*" url("https://dictionary-style.invalid/comment-mask.png") "*/"; }',
      ].join("\n") }]);
      const resources = [...network.children].map((element) => getComputedStyle(element).backgroundImage);
      const fonts = [...network.children].map((element) => getComputedStyle(element).fontFamily);
      const pseudoContent = getComputedStyle(network.firstElementChild, "::before").content;
      const replacement = shadow.querySelectorAll("style[data-hoshidicts-dictionary-style]").length === 1
        && shadow.querySelector("style[data-hoshidicts-dictionary-style]").dataset.hoshidictsGeneration === "2"
        && getComputedStyle(inside.querySelector(".nested")).fontWeight !== "900";
      const globalRules = [...shadow.querySelector("style[data-hoshidicts-dictionary-style]").sheet.cssRules]
        .map((rule) => rule.constructor.name);
      // Flush style-driven requests before removing the test DOM/interceptor.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      network.remove();
      escaped.remove();
      variables.remove();
      inside.innerHTML = '<div class="overlay">Dictionary overlay</div>';
      apply(3, [{ dictionary: "scope-test", styles: '.overlay { position:fixed; inset:0; z-index:2147483647; background:red; box-shadow:0 0 0 10000px red; }' }]);
      const overlay = inside.querySelector(".overlay");
      const card = inside.parentElement;
      const overlayRect = overlay.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const controlRect = popup.querySelector(".outside").getBoundingClientRect();
      const containment = {
        paint: getComputedStyle(card).contain,
        withinCard: overlayRect.left >= cardRect.left && overlayRect.top >= cardRect.top
          && overlayRect.right <= cardRect.right && overlayRect.bottom <= cardRect.bottom,
        controlClear: overlayRect.right <= controlRect.left || overlayRect.left >= controlRect.right
          || overlayRect.bottom <= controlRect.top || overlayRect.top >= controlRect.bottom,
        control: shadow.elementFromPoint(controlRect.left + 2, controlRect.top + 2)?.className,
        farPoint: shadow.elementFromPoint(700, 500)?.className ?? "",
      };
      host.remove();
      pageFont.remove();
      return { scope, resources, fonts, pseudoContent, replacement, globalRules, containment };
    });
  } finally {
    await page.setRequestInterception(false);
    page.off("request", intercept);
  }
  check("dictionary CSS stays scoped with malformed braces, escaped titles, and nested rules",
    evidence.scope.count === 3 && evidence.scope.inside === "rgb(1, 2, 3)"
      && evidence.scope.nested === "900" && evidence.scope.escapedTitle === "rgb(4, 5, 6)"
      && evidence.scope.gradient.startsWith("radial-gradient(") && evidence.scope.fontSize === "14px"
      && evidence.scope.outside === "rgb(9, 9, 9)" && evidence.scope.escapedHost === ""
      && evidence.replacement, JSON.stringify(evidence));
  check("dictionary CSS keeps its own custom properties, so grammar card disclosures draw their chevron",
    evidence.scope.rowGap === "7px" && evidence.scope.rowWell === "rgb(1, 2, 3)"
      && evidence.scope.rowEdge === "rgb(4, 5, 6)" && evidence.scope.summaryDisplay === "flex"
      && evidence.scope.summaryListStyle === "none" && evidence.scope.chevronDisplay === "block"
      && evidence.scope.chevronTransform !== "none", JSON.stringify(evidence.scope));
  check("dictionary CSS cannot load remote resources or inherit resource-valued variables",
    requests.length === 0 && evidence.resources.every((value) => value === "none")
      && evidence.fonts.every((value) => !value.includes("page-resource-test"))
      && evidence.pseudoContent === "none"
      && evidence.globalRules.every((name) => name === "CSSScopeRule"), JSON.stringify({ evidence, requests }));
  check("dictionary CSS cannot paint or intercept input outside its glossary card",
    evidence.containment.paint === "paint" && evidence.containment.withinCard
      && evidence.containment.controlClear
      && evidence.containment.control !== "overlay" && evidence.containment.farPoint !== "overlay",
    JSON.stringify(evidence.containment));
}

async function checkSettingsAutosave(page, browser, settingsUrl) {
  const mirror = await browser.newPage();
  const edit = (target, changes) => target.evaluate((values) => {
    for (const [id, value] of Object.entries(values)) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, changes);
  const saved = (target) => target.waitForFunction(() =>
    document.getElementById("options-status").textContent === "Saved.", { timeout: 10_000, polling: 100 });
  let evidence;
  try {
    await mirror.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    for (const target of [page, mirror]) {
      await target.waitForFunction(() => document.getElementById("engine-status").textContent.startsWith("Ready"),
        { timeout: 90_000, polling: 100 });
      await showSettingsSection(target, "lookup");
    }
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const probe = { calls: [], hold: true, release: null, restore: () => { chrome.runtime.sendMessage = original; } };
      window.__optionsSaveProbe = probe;
      chrome.runtime.sendMessage = async (message) => {
        if (message.type !== "hd_options_write") return original(message);
        probe.calls.push(message);
        const reply = await original(message);
        if (probe.hold) {
          probe.hold = false;
          await new Promise((resolveReply) => { probe.release = resolveReply; });
        }
        return reply;
      };
    });
    await edit(page, { "opt-scan-length": "25", "opt-max-results": "64" });
    await page.waitForFunction(() => typeof window.__optionsSaveProbe.release === "function", { polling: 100 });
    await edit(page, { "opt-max-results": "96" });
    await mirror.waitForFunction(() => document.getElementById("opt-max-results").value === "64", { polling: 100 });
    await edit(mirror, { "opt-frequency-order": "descending" });
    await saved(mirror);
    const writesWhileHeld = await page.evaluate(() => window.__optionsSaveProbe.calls.length);
    await page.evaluate(() => window.__optionsSaveProbe.release());
    await page.waitForFunction(() => !document.getElementById("options-conflict-actions").hidden, { polling: 100 });
    evidence = await page.evaluate(async () => ({
      calls: window.__optionsSaveProbe.calls,
      draft: document.getElementById("opt-max-results").value,
      order: document.getElementById("opt-frequency-order").value,
      status: document.getElementById("options-status").textContent,
      stored: (await chrome.storage.local.get("options")).options,
    }));
    evidence.writesWhileHeld = writesWhileHeld;
    await page.bringToFront();
    await page.click("#options-use-saved");
    evidence.discardedValue = await page.$eval("#opt-max-results", (input) => input.value);
    await edit(page, { "opt-scan-length": "16", "opt-max-results": "32", "opt-frequency-order": "auto" });
    await saved(page);
    await mirror.waitForFunction(() => document.getElementById("opt-max-results").value === "32", { polling: 100 });
    check(
      "Settings autosaves one revisioned patch and surfaces cross-page conflicts without losing drafts",
      evidence.writesWhileHeld === 1 && evidence.calls.length === 2
        && evidence.calls[1].baseRevision === evidence.calls[0].baseRevision + 1
        && evidence.calls[0].options.scanLength === 25 && evidence.calls[0].options.maxResults === 64
        && evidence.draft === "96" && evidence.order === "descending"
        && evidence.status.includes("changed in another page")
        && evidence.stored.maxResults === 64 && evidence.discardedValue === "64",
      JSON.stringify(evidence),
    );
    if (process.env.HACHIDORI_OPTIONS_SCREENSHOT) {
      await page.bringToFront();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await (await page.$("#lookup")).screenshot({ path: process.env.HACHIDORI_OPTIONS_SCREENSHOT });
    }
  } finally {
    await page.evaluate(() => {
      window.__optionsSaveProbe?.release?.();
      window.__optionsSaveProbe?.restore();
      delete window.__optionsSaveProbe;
    });
    await mirror.close();
  }
}

async function checkSettingsTransport(page) {
  await showSettingsSection(page, "lookup");
  const evidence = await page.evaluate(async () => {
    const read = () => chrome.storage.local.get(["options", "dictionaryState"]);
    const status = () => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    const before = await read();
    const generation = (await status()).generation;
    const request = {
      target: "hoshidicts-worker", type: "hd_options_write", requestId: "browser-options-frame",
      baseRevision: before.options?.revision ?? 0, options: { maxResults: "invalid" },
    };
    const malformed = await chrome.runtime.sendMessage(request);
    const oversized = await chrome.runtime.sendMessage({ ...request, options: { maxResults: 48 }, padding: "x".repeat(1024 * 1024) });
    const after = await read();
    return { rejected: malformed.ok === false && oversized.ok === false,
      unchanged: JSON.stringify(before) === JSON.stringify(after), generation,
      revision: before.options?.revision ?? 0, originalMaxResults: before.options?.maxResults ?? 32 };
  });
  const edit = async (value) => {
    await page.$eval("#opt-max-results", (input, next) => {
      input.value = String(next);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    await page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
      { timeout: 10_000, polling: 100 });
  };
  const nextMaxResults = evidence.originalMaxResults === 48 ? 32 : 48;
  await edit(nextMaxResults);
  const saved = await page.evaluate(async () => ({
    options: (await chrome.storage.local.get("options")).options,
    status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
  }));
  await edit(evidence.originalMaxResults);
  check("Settings rejects malformed and oversized option frames before commit and still autosaves without reload",
    evidence.rejected && evidence.unchanged && saved.options.revision === evidence.revision + 1
      && saved.options.maxResults === nextMaxResults && saved.status.generation === evidence.generation,
    JSON.stringify({ evidence, saved }));
}

async function checkAudioSettings(page, browser) {
  await showSettingsSection(page, "audio");
  const original = await page.evaluate(async () => ({
    options: (await chrome.storage.local.get("options")).options,
    status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
    context: (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))[0].documentId,
  }));
  const saved = () => page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
  const input = async (selector, value, event = "input") => {
    await page.$eval(selector, (field, next, kind) => {
      field.focus();
      if (field.type === "checkbox") field.checked = next;
      else field.value = next;
      field.dispatchEvent(new Event(kind, { bubbles: true }));
      field.blur();
    }, value, event);
    await saved();
  };
  const customRow = ".audio-source-row:first-child";
  const click = async selector => { await page.$eval(selector, button => button.click()); await saved(); };
  const routes = new Map();
  const route = (path, body, contentType = "application/json", status = 200) => {
    routes.set(`https://audio.example.test/${path}`, { body, contentType, status, requests: 0 });
  };
  route("valid.wav", makeAudioWav(), "audio/wav");
  route("invalid.wav", "not audio", "audio/wav");
  route("list?term=%E8%81%9E%E3%81%8F&reading=%E3%81%8D%E3%81%8F&lang=ja", JSON.stringify({
    type: "audioSourceList", audioSources: [
      { url: "https://audio.example.test/invalid.wav", name: "Unplayable" },
      { url: "https://audio.example.test/valid.wav", name: "Playable" },
    ],
  }));
  route("empty", JSON.stringify({ type: "audioSourceList", audioSources: [] }));
  route("failure", "Unavailable", "text/plain", 503);
  const target = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
  const session = await interceptFetches(target, routes, "audio");
  try {
    const defaults = await page.$eval(".audio-source-row", row =>
      row.querySelector(".audio-type").value === "text-to-speech-reading" && row.querySelector(".audio-enabled").checked);
    await click("#audio-source-add");
    await click(".audio-source-row:last-child .audio-up");
    await input(`${customRow} .audio-type`, "custom-json", "change");
    const template = "https://audio.example.test/list?term={term}&reading={reading}&lang={language}";
    await input(`${customRow} .audio-url`, template);
    await input(`${customRow} .audio-enabled`, false, "change");
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".audio-source-row").length === 2);
    const retained = await page.evaluate(() => [...document.querySelectorAll(".audio-source-row")].map(row => ({
      type: row.querySelector(".audio-type").value, enabled: row.querySelector(".audio-enabled").checked,
      url: row.querySelector(".audio-url").value,
    })));
    check("Audio Settings preserve ordered source edits and disabled rows through revisioned save and reload",
      defaults && retained[0].url === template && !retained[0].enabled && retained[1].enabled
        && retained[1].type === "text-to-speech-reading", JSON.stringify(retained));
    async function testRow() {
      await page.$eval(`${customRow} .audio-test`, button => button.click());
      await page.waitForFunction(() => document.querySelector(".audio-test").textContent === "Test", { timeout: 20_000 });
      return page.$eval(`${customRow} .audio-test-status`, output => output.textContent);
    }
    const success = await testRow();
    await input(`${customRow} .audio-url`, "https://audio.example.test/empty");
    const obsoleteCleared = await page.$eval(`${customRow} .audio-test-status`, output => output.textContent === "");
    const empty = await testRow();
    await input(`${customRow} .audio-url`, "https://audio.example.test/failure");
    const failure = await testRow();
    // #499: a Yomitan list URL saved under Add source's default Audio URL
    // type. Chrome fails to decode the JSON, and Test says which type to choose.
    await input(`${customRow} .audio-type`, "custom", "change");
    await input(`${customRow} .audio-url`, template);
    const listAsRecording = await testRow();
    await input(`${customRow} .audio-type`, "custom-json", "change");
    const list = "https://audio.example.test/list?term=%E8%81%9E%E3%81%8F&reading=%E3%81%8D%E3%81%8F&lang=ja";
    check("Audio source Tests use encoded URLs and ordered JSON candidates with quiet success and visible errors",
      obsoleteCleared && success === "" && empty === "No pronunciation was returned."
        && failure === "Could not play: The pronunciation list returned HTTP 503."
        && listAsRecording === "Could not play: The URL returned a Yomitan audio list, not a recording. "
          + "If it is a list link, set this source's type to Yomitan JSON in Audio Settings."
        && [...routes].every(([url, route]) => route.requests === (url === list ? 2 : 1)),
      JSON.stringify({ success, empty, failure, listAsRecording,
        requests: [...routes].map(([url, route]) => [url, route.requests]) }));
    await input(`${customRow} .audio-url`, template);
    if (process.env.HACHIDORI_AUDIO_SCREENSHOT) {
      await page.setViewport({ width: 1200, height: 1100 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: process.env.HACHIDORI_AUDIO_SCREENSHOT, fullPage: true });
    }
    // Hold a real request at the offscreen target, then stop and release it.
    let held;
    const hold = await target.createCDPSession();
    hold.on("Fetch.requestPaused", event => { held = event.requestId; });
    await hold.send("Fetch.enable", { patterns: [{ urlPattern: "https://audio.example.test/pending", requestStage: "Request" }] });
    await input(`${customRow} .audio-url`, "https://audio.example.test/pending");
    await page.$eval(`${customRow} .audio-test`, button => button.click());
    const deadline = Date.now() + 5000;
    while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!held) throw new Error("Audio Test did not reach the offscreen fetch");
    await page.$eval(`${customRow} .audio-test`, button => button.click());
    await hold.send("Fetch.failRequest", { requestId: held, errorReason: "Aborted" }).catch(() => {});
    await hold.detach();
    const stopped = await page.$eval(`${customRow} .audio-test-status`, output => output.textContent);
    const idleSince = Date.now();
    await page.waitForFunction(start => Date.now() - start > 31_000, { polling: 1000, timeout: 35_000 }, idleSince);
    const after = await page.evaluate(async () => ({
      status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
      context: (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))[0].documentId,
      feedback: document.querySelector(".audio-test-status").textContent,
    }));
    check("Audio Tests cancel stale playback and preserve the dictionary engine after audio becomes idle",
      stopped === "" && after.feedback === stopped && after.status.ready
        && after.status.generation === original.status.generation && after.context === original.context, JSON.stringify(after));
  } finally {
    await session.detach();
    await page.evaluate(async sources => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        requestId: "restore-audio", baseRevision: options.revision, options: { audioSources: sources } });
      if (!reply.ok) throw new Error(reply.error);
    }, original.options?.audioSources ?? [{ id: "default-tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" }]);
  }
}

async function checkAnkiGlossaryExport(page) {
  const imageRequests = [];
  const observe = request => { if (/hd-anki-(?:inert|hidden)-image\.png/u.test(request.url())) imageRequests.push(request.url()); };
  page.on("request", observe);
  try {
    const result = await page.evaluate(async () => {
      const { createAnkiDefinitionRenderer } = await import("./anki-glossary.js");
      const dictionary = "Anki <Dictionary>";
      const source = { term: { rules: "", glossaries: [{ dictionary, glossary: JSON.stringify([
        { type: "structured-content", content: [
          { tag: "strong", content: "Scoped definition" },
          { tag: "img", path: "image.png", width: 200, height: 100, preferredWidth: 400 },
          { tag: "img", path: "image.png", width: 200, height: 100, preferredHeight: 200 },
          // sankoku8's pitch-accent mark (#325): an em-sized image must measure in
          // em on the note, not as a 0.5px × 1px presentational width/height.
          { tag: "img", path: "image.png", width: 0.5, height: 1, sizeUnits: "em" },
        ] },
      ]) }] }, trace: [], dictionaryAliases: {}, generation: 1,
      dictionaryMedia: [{ dictionary, path: "image.png", filename: "hd-anki-inert-image.png" }],
      dictionaryStyles: [{ dictionary, styles: '.gloss-sc-strong { color: rgb(17, 34, 51) } .gloss-sc-strong::before { content: "</style><img src=x onerror=alert(1)>" }' }] };
      const html = await createAnkiDefinitionRenderer(document, source)({});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const inert = document.implementation.createHTMLDocument("");
      inert.body.innerHTML = html;
      const images = [...inert.querySelectorAll("img")];
      const safe = images.length === 3 && !inert.querySelector("[onerror], script")
        && images.every(image => image.getAttribute("src") === "hd-anki-inert-image.png");
      if (!safe) return { safe, html };
      // Only now mount a copy, replacing planned Anki filenames with a local
      // image so layout is measured without fetching the exported media.
      for (const image of images) image.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>');
      // Settings' own stylesheet sets the glossary text size; fix the em base
      // where the accent mark sits so its measurement is 0.5em × 1em of 20px.
      images[2].parentElement.style.fontSize = "20px";
      const holder = document.createElement("div");
      holder.style.cssText = "width: 1000px; color: rgb(0, 0, 0);";
      holder.append(...inert.body.childNodes);
      const outside = document.createElement("strong");
      outside.className = "gloss-sc-strong";
      outside.textContent = "Outside glossary";
      holder.append(outside);
      document.body.append(holder);
      try {
        await Promise.all(images.map(image => image.decode()));
        const color = getComputedStyle(holder.querySelector(".gsm-hoshidicts-glossary-content strong")).color;
        const outsideColor = getComputedStyle(outside).color;
        const sizes = images.map(image => { const rect = image.getBoundingClientRect(); return [rect.width, rect.height]; });
        return { safe, color, outsideColor, sizes, style: holder.querySelector("style").textContent };
      } finally { holder.remove(); }
    });
    check("Anki glossary export preserves native scoped styles and image proportions without loading media or allowing CSS markup escape",
      result.safe && result.color === "rgb(17, 34, 51)" && result.outsideColor === "rgb(0, 0, 0)"
        && result.sizes.length === 3
        && result.sizes.slice(0, 2).every(([width, height]) => width === 400 && height === 200)
        && result.sizes[2][0] === 10 && result.sizes[2][1] === 20
        && imageRequests.length === 0, JSON.stringify({ ...result, imageRequests }));

    // Smaller Anki cards (#354): the exporter reads the scoped cascade of the
    // live document and writes only what it means for the content.
    const compact = await page.evaluate(async () => {
      const { createAnkiDefinitionRenderer } = await import("./anki-glossary.js");
      const dictionary = "Compact <Dictionary>";
      const tag = content => ({ tag: "span", title: "Part of speech", data: { class: "tag", content: "part-of-speech-info" }, content });
      const source = { term: { rules: "v1", glossaries: [{ dictionary, definitionTags: "", termTags: "★", glossary: JSON.stringify([
        { type: "structured-content", content: [
          { tag: "ul", lang: "ja", data: { content: "sense-groups" }, content: { tag: "li", content: [tag("1-dan"), tag("transitive"),
            { tag: "ol", content: { tag: "li", style: { listStyleType: "\"①\"" }, content: [
              { tag: "ul", data: { content: "glossary" }, content: { tag: "li", content: "to eat" } },
              { tag: "div", data: { content: "hidden-note" }, content: ["never shown", { tag: "img", path: "hidden.png" }] },
            ] } }] } },
          { tag: "table", content: { tag: "tr", content: { tag: "td", data: { class: "form-pri" }, content: { tag: "span" } } } },
          { tag: "div", content: [{ tag: "span", style: { fontWeight: "bold" }, content: "bold" }, " and ",
            { tag: "span", style: { textDecorationLine: "underline" }, content: "underlined" }, " ",
            { tag: "a", href: "https://example.com/", content: "link text" }] },
          { tag: "strong", content: "Scoped" },
          { tag: "img", path: "image.png", width: 0.5, height: 1, sizeUnits: "em", title: "Accent" },
        ] },
        "line one\nline two",
      ]) }] }, trace: [{ name: "polite" }], dictionaryAliases: {}, generation: 1,
      dictionaryMedia: [{ dictionary, path: "image.png", filename: "hd-anki-inert-image.png" },
        { dictionary, path: "hidden.png", filename: "hd-anki-hidden-image.png" }],
      dictionaryStyles: [{ dictionary, styles: [
        'ul[data-sc-content="sense-groups"] { list-style-type: "＊"; }',
        'span[data-sc-class="tag"] { margin-right: 0.5em; }',
        'li ul[data-sc-content="glossary"] { list-style-type: none; }',
        'div[data-sc-content="hidden-note"] { display: none; }',
        'td[data-sc-class="form-pri"] > span { display: block; &::before { content: "△"; } }',
        '.gloss-sc-strong::before { content: "</style><img src=x onerror=alert(1)>" }',
      ].join("\n") }] };
      const children = document.body.children.length;
      const render = () => createAnkiDefinitionRenderer(document, source, undefined, { compact: true })({});
      const html = await render();
      const again = await render();
      const inert = document.implementation.createHTMLDocument("");
      inert.body.innerHTML = html;
      const $ = selector => inert.querySelector(selector);
      const groups = $('div[class="yomitan-glossary"] > ol > li[data-dictionary="Compact <Dictionary>"] ul[data-sc-content="sense-groups"]');
      return {
        html, same: html === again, mounted: document.body.children.length - children,
        internal: /<style|@scope|gloss-sc-|gsm-hoshidicts|data-hoshidicts|structured-content|title=|href=|object-fit/u.test(html),
        root: $('div[class="yomitan-glossary"]').getAttribute("style"),
        meta: $('div[class="yomitan-glossary"] > ol > li > div > i.yomitan-glossary-meta')?.textContent,
        details: $("small.yomitan-glossary-details")?.innerHTML,
        groups: [groups?.getAttribute("lang"), groups?.style.listStyleType],
        lists: groups ? [...groups.querySelectorAll("li, ol, ul")].map(node => `${node.localName}:${node.getAttribute("style")}`) : [],
        line: groups?.firstElementChild.textContent,
        marker: $("td")?.textContent,
        senses: [...inert.querySelectorAll("ul:not([data-sc-content]) > li")].map(node => node.innerHTML.slice(0, 32)),
        emphasis: html.includes("<b>bold</b> and <u>underlined</u> link text"),
        escaped: [...inert.querySelectorAll("b")].some(node => node.textContent === "</style><img src=x onerror=alert(1)>Scoped")
          && !inert.querySelector("[onerror], script"),
        images: [...inert.querySelectorAll("img")].map(node => [node.getAttribute("src"), node.alt, node.style.cssText]),
        hidden: html.includes("never shown") || html.includes("hd-anki-hidden-image.png"),
      };
    });
    check("Smaller Anki cards export resolves scoped CSS into compact glossary HTML without styles, internal markup or media loads",
      compact.same && compact.mounted === 0 && !compact.internal && !compact.hidden
        && compact.root === "text-align: left;" && compact.meta === "(★, Compact <Dictionary>)"
        && compact.details === undefined && compact.html.endsWith("</ol></div>")
        && compact.groups[0] === "ja" && compact.groups[1] === '"＊"'
        && JSON.stringify(compact.lists) === JSON.stringify(["li:null", "ol:null", 'li:list-style-type: "①";', "ul:list-style-type: none;", "li:null"])
        && compact.line === "1-dan transitive to eat" && compact.marker === "△"
        && compact.senses.length === 2 && compact.senses[1] === "line one<br>line two"
        && compact.emphasis && compact.escaped
        && JSON.stringify(compact.images) === JSON.stringify([["hd-anki-inert-image.png", "Accent", "width: 0.5em; height: 1em; max-width: 100%;"]])
        && imageRequests.length === 0, JSON.stringify({ ...compact, imageRequests }));
  } finally { page.off("request", observe); }
}

// First-run Anki detection against a mocked AnkiConnect on the real service
// worker: the startup page asks once, the ranked note type and deck are saved
// with the preset, and nothing in the collection is modified. Setup state and
// options are restored afterwards so the later Anki checks start as they did.
async function checkFirstRunAnkiDetection(page, browser, startupUrl) {
  const localAudioUrl = "http://127.0.0.1:5050/?term={term}&reading={reading}";
  // AnkiWeb's Local Audio Server 1.7.0 raises on a path without a term, which
  // closes the connection and makes Anki show an add-on error: setup never asks.
  const localAudioInfo = { requests: 0, fail: "ConnectionClosed" };
  const localAudioSample = { requests: 0, status: 200, contentType: "application/json",
    body: JSON.stringify({ type: "audioSourceList", audioSources: [] }) };
  const KIKU_FIELDS = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "SelectionText", "MainDefinition",
    "Glossary", "Sentence", "SentenceFurigana", "SentenceAudio", "PitchPosition", "PitchCategories", "Frequency", "FreqSort", "MiscInfo", "Picture"];
  const calls = [];
  const route = { requests: 0, async respond(request) {
    const reply = await answerAnkiConnect(JSON.parse(request.postData), (action, params, { version }) => {
      calls.push({ action, params, version });
      // Two notes live in Mining and one in the child deck, so Mining wins.
      const result = action === "modelNamesAndIds" ? { Basic: 1, "Kiku v2": 2, "My Kiku": 3 }
        : action === "modelNames" ? ["Basic", "Kiku v2", "My Kiku"]
          : action === "deckNames" ? ["Default", "Mining", "Mining::Old"]
        : action === "modelFieldNames" ? (params.modelName === "Kiku v2" ? KIKU_FIELDS : ["Front", "Back"])
          : action === "findNotes" ? [21, 22, 23]
            : action === "findCards" ? [211, 212, 221, 231]
              : action === "getDecks" ? { Mining: [211, 212, 221], "Mining::Old": [231] }
                : action === "cardsToNotes" ? (params.cards.includes(231) ? [23] : [21, 22]) : null;
      if (result === null) throw new AnkiConnectError(`unexpected ${action}`);
      return result;
    });
    return { body: JSON.stringify(reply), status: 200, contentType: "application/json" };
  } };
  const worker = await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const session = await interceptFetches(worker, new Map([
    ["http://127.0.0.1:8765/", route],
    ["http://127.0.0.1:5050/v1/info", localAudioInfo],
    ["http://127.0.0.1:5050/?term=%E7%8C%AB&reading=%E3%81%AD%E3%81%93", localAudioSample],
  ]), "anki setup");
  const saved = await page.evaluate(async () => (await chrome.storage.local.get(["setupState", "options"])));
  let startup = null;
  let settingsRecovery = null;
  try {
    // Setup returns to the Anki stage with no outcome yet; the dictionary stage
    // is already behind it, so the page checks Anki as soon as it opens.
    await page.evaluate(async (previous) => {
      await chrome.storage.local.set({ setupState: { ...previous, revision: previous.revision + 1, stage: "anki", completedAt: null, anki: null } });
    }, saved.setupState);
    startup = await browser.newPage();
    startup.on("console", (message) => diagnostics.push(`[startup anki] ${message.type()}: ${message.text()}`));
    startup.on("pageerror", (error) => diagnostics.push(`[startup anki] pageerror: ${error.message}`));
    await startup.setViewport({ width: 900, height: 820 });
    await startup.goto(startupUrl, { waitUntil: "domcontentloaded" });
    await startup.evaluate(() => {
      window.__headingLog = [];
      const record = () => {
        const text = document.getElementById("setup-heading")?.textContent ?? "";
        const progress = [...document.querySelectorAll(".setup-anki-progress-step")].map(row => ({
          step: row.dataset.step,
          title: row.querySelector("strong")?.textContent ?? "",
          detail: row.querySelector("small")?.textContent ?? "",
          current: row.getAttribute("aria-current") === "step",
          done: row.classList.contains("is-done"),
        }));
        const signature = JSON.stringify([text, progress]);
        if (window.__headingLog.at(-1)?.signature === signature) return;
        window.__headingLog.push({ signature, text, progress, at: Date.now() });
      };
      record();
      new MutationObserver(record).observe(document.getElementById("setup-card"), { childList: true, subtree: true, characterData: true });
    });
    if (process.env.HACHIDORI_STARTUP_ANKI_SCREENSHOT || process.env.HACHIDORI_STARTUP_ANKI_DARK_SCREENSHOT) {
      await startup.waitForFunction(() => {
        const current = document.querySelector('.setup-anki-progress-step[aria-current="step"]');
        return current?.dataset.step === "2" && current.querySelector("small")?.textContent === "Selected Mining";
      }, { timeout: 30_000, polling: 25 });
      for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_ANKI_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_ANKI_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await startup.screenshot({ path, fullPage: true });
      }
      await startup.emulateMediaFeatures([]);
    }
    const configured = await startup.waitForFunction(() => document.getElementById("setup-heading")?.textContent === "Anki is set up"
      ? {
          at: Date.now(),
          outcome: document.querySelector(".setup-anki-outcome")?.dataset.status ?? null,
          outcomeText: document.querySelector(".setup-anki-outcome")?.textContent ?? "",
          outcomeLink: document.querySelector('.setup-anki-outcome a[href="settings.html#anki"]') !== null,
          localAudio: document.querySelector(".setup-local-audio-outcome")?.textContent ?? "",
          progress: [...document.querySelectorAll(".setup-anki-progress-step")].map(row => ({
            title: row.querySelector("strong")?.textContent ?? "",
            detail: row.querySelector("small")?.textContent ?? "",
            done: row.classList.contains("is-done"),
          })),
          countdown: document.getElementById("setup-countdown-label")?.textContent ?? null,
          actions: [...document.querySelectorAll("#setup-actions button")].map(control => control.id),
        } : false,
    { timeout: 30_000, polling: 50 }).then((handle) => handle.jsonValue()).catch(() => null);
    const ready = await startup.waitForFunction(() => document.getElementById("setup-heading")?.textContent === "Add a dictionary to try Hachidori"
      ? { at: Date.now(), outcome: document.querySelector(".setup-anki-outcome")?.dataset.status ?? null,
        outcomeText: document.querySelector(".setup-anki-outcome")?.textContent ?? "",
        outcomeLink: document.querySelector('.setup-anki-outcome a[href="settings.html#anki"]') !== null,
        done: document.querySelectorAll(".setup-step.is-done").length,
        status: document.getElementById("setup-status")?.textContent ?? "" } : false,
    { timeout: 30_000, polling: 50 }).then((handle) => handle.jsonValue()).catch(() => null);
    const headingLog = await startup.evaluate(() => window.__headingLog ?? []);
    const detected = await page.evaluate(async () => (await chrome.storage.local.get(["setupState", "options"])));
    const anki = detected.options?.anki ?? {};
    const audioSources = detected.options?.audioSources ?? [];
    const templates = anki.fieldTemplates ?? {};
    const recovery = await startup.evaluate(() => ({
      link: document.querySelector("#setup-practice-recovery a")?.getAttribute("href"),
      visible: document.getElementById("setup-practice-recovery")?.checkVisibility() === true,
      exercise: document.getElementById("setup-practice-lookup")?.checkVisibility() === true,
      finish: document.getElementById("setup-finish")?.disabled === false,
      settings: document.querySelector('a[href="settings.html"]')?.checkVisibility() === true,
    }));
    check("startup practice without a usable dictionary retains recovery and completion controls",
      recovery.link === "settings.html#add-dictionaries" && recovery.visible && recovery.exercise === false
        && recovery.finish && recovery.settings,
      JSON.stringify(recovery));
    const headingSequence = [...new Set(headingLog.map(entry => entry.text))];
    // Older Chrome can still be painting the static placeholder when the observer attaches.
    if (headingSequence[0] === "Loading setup…") headingSequence.shift();
    const pendingSteps = headingLog.filter(entry => entry.text === "Finding your Anki setup…")
      .flatMap(entry => entry.progress.filter(step => step.current).map(step => step.step));
    const progressStarted = new Map();
    const progressChoices = new Map();
    const expectedChoices = new Map([
      ["1", "Selected Kiku v2"],
      ["2", "Selected Mining"],
      ["3", "Ready for future mining"],
    ]);
    for (const entry of headingLog.filter(candidate => candidate.text === "Finding your Anki setup…")) {
      const current = entry.progress.find(step => step.current);
      if (current && current.detail === expectedChoices.get(current.step) && !progressStarted.has(current.step)) {
        progressStarted.set(current.step, entry.at);
        progressChoices.set(current.step, current.detail);
      }
    }
    const configuredPaintedAt = headingLog.find(entry => entry.text === "Anki is set up")?.at ?? 0;
    const progressDwell = [
      (progressStarted.get("2") ?? 0) - (progressStarted.get("1") ?? 0),
      (progressStarted.get("3") ?? 0) - (progressStarted.get("2") ?? 0),
      configuredPaintedAt - (progressStarted.get("3") ?? 0),
    ];
    check(
      "first-run detection configures an existing Kiku mining setup read-only from the startup page",
      JSON.stringify(headingSequence.slice(0, 3)) === JSON.stringify(["Finding your Anki setup…", "Anki is set up", "Add a dictionary to try Hachidori"])
        && JSON.stringify([...new Set(pendingSteps)]) === JSON.stringify(["1", "2", "3"])
        && JSON.stringify([...progressChoices]) === JSON.stringify([...expectedChoices])
        && progressDwell.every(duration => duration >= 1900)
        && configured?.outcome === "configured" && configured.outcomeLink
        && configured.outcomeText === "Automatically set up Kiku v2 for deck ‘Mining’. Change in Settings."
        && JSON.stringify(configured.progress) === JSON.stringify([
          { title: "Looking for the most popular mining card", detail: "Selected Kiku v2", done: true },
          { title: "Looking for the most popular deck", detail: "Selected Mining", done: true },
          { title: "Setting Hachidori to use them", detail: "Ready for future mining", done: true },
        ])
        && configured.countdown === "Continuing to practice in 3 seconds"
        && JSON.stringify(configured.actions) === JSON.stringify(["setup-continue", "setup-pause"])
        && ready?.outcome === "configured" && ready.outcomeLink && ready.status === "Add a dictionary to try Hachidori"
        && ready.outcomeText === "Automatically set up Kiku v2 for deck ‘Mining’. Change in Settings."
        && ready.done === 2 && ready.at - configured.at >= 2800
        // The durable outcome and the saved mapping name the same note type and deck.
        && detected.setupState?.anki?.status === "configured" && detected.setupState.anki.detail === null
        && detected.setupState.anki.model === "Kiku v2" && detected.setupState.anki.deck === "Mining"
        && anki.model === "Kiku v2" && anki.deck === "Mining"
        && detected.options.revision === saved.options.revision + 1
        && Object.keys(templates).length === KIKU_FIELDS.length
        && templates.Expression?.value === "{expression}"
        && templates.SentenceAudio?.value === ""
        && templates.Picture?.value === "{screenshot}"
        && anki.captureScreenshot === true
        // Only the fixed read-only actions ran, in ranking order, at protocol version 6.
        && JSON.stringify(calls.map(({ action }) => action)) === JSON.stringify(
          ["modelNamesAndIds", "modelFieldNames", "findNotes", "findCards", "getDecks", "cardsToNotes", "cardsToNotes"])
        && calls.every(({ version }) => version === 6)
        && calls.find(({ action }) => action === "findNotes").params.query === "mid:2"
        && calls.find(({ action }) => action === "findCards").params.query === "mid:2 -deck:filtered",
      JSON.stringify({ headingLog, progressChoices: [...progressChoices], progressDwell, configured, ready, detected, calls }),
    );
    check("first-run setup automatically prepends detected local audio as source 1",
      configured?.localAudio === "Local audio is configured."
        && audioSources[0]?.type === "custom-json" && audioSources[0]?.enabled === true
        && audioSources[0]?.url === localAudioUrl
        && audioSources[1]?.id === "default-tts"
        && localAudioInfo.requests === 0 && localAudioSample.requests === 1,
      JSON.stringify({ configured, audioSources, localAudioInfo, localAudioSample }));

    await startup.close();
    startup = null;
    await page.evaluate(async previous => {
      const { options } = await chrome.storage.local.get("options");
      await chrome.storage.local.set({ setupState: previous.setupState,
        options: { ...previous.options, revision: options.revision + 1 } });
    }, saved);
    const beforeRecovery = await page.evaluate(() => chrome.storage.local.get(["setupState", "options"]));
    route.fail = "ConnectionRefused";
    settingsRecovery = await browser.newPage();
    await settingsRecovery.goto(new URL("settings.html#anki", startupUrl).href, { waitUntil: "domcontentloaded" });
    await settingsRecovery.bringToFront();
    await settingsRecovery.waitForSelector("#anki-find-setup");
    await settingsRecovery.click("#anki-find-setup");
    await settingsRecovery.waitForFunction(() => document.getElementById("anki-setup-status").textContent.includes("Open Anki")
      && !document.getElementById("anki-find-setup").disabled);
    delete route.fail;
    await settingsRecovery.click("#anki-find-setup");
    await settingsRecovery.waitForFunction(async () => {
      const { options } = await chrome.storage.local.get("options");
      return options.anki?.model === "Kiku v2" && document.getElementById("options-status").textContent === "Saved.";
    });
    const recovered = await settingsRecovery.evaluate(() => chrome.storage.local.get(["setupState", "options"]));
    await settingsRecovery.click("#anki-find-setup");
    await settingsRecovery.waitForFunction(() => document.getElementById("anki-setup-status").textContent.includes("Your saved Kiku v2 setup")
      && !document.getElementById("anki-find-setup").disabled);
    const checked = await settingsRecovery.evaluate(() => chrome.storage.local.get(["setupState", "options"]));
    check("Settings recovers Anki setup after onboarding and preserves a verified saved mapping",
      recovered.options.revision === beforeRecovery.options.revision + 1
        && recovered.options.anki.deck === "Mining"
        && recovered.options.anki.fieldTemplates.Expression.value === "{expression}"
        && JSON.stringify(recovered.setupState) === JSON.stringify(beforeRecovery.setupState)
        && JSON.stringify(checked) === JSON.stringify(recovered), JSON.stringify({ beforeRecovery, recovered, checked }));
    if (process.env.HACHIDORI_ANKI_SETUP_SCREENSHOT) {
      await settingsRecovery.setViewport({ width: 1280, height: 1000 });
      await settingsRecovery.screenshot({ path: process.env.HACHIDORI_ANKI_SETUP_SCREENSHOT });
    }
  } finally {
    await settingsRecovery?.close().catch(() => {});
    if (startup !== null) await startup.close().catch(() => {});
    await session.detach().catch(() => {});
    // The remaining Anki checks expect the unconfigured mapping and a completed setup.
    await page.evaluate(async (previous) => {
      const { options } = await chrome.storage.local.get("options");
      await chrome.storage.local.set({ setupState: previous.setupState, options: { ...previous.options, revision: options.revision + 1 } });
    }, saved);
    await page.waitForFunction(async (expected) => {
      const stored = await chrome.storage.local.get(["setupState", "options"]);
      return stored.setupState?.stage === "complete"
        && JSON.stringify(stored.options.anki ?? null) === JSON.stringify(expected ?? null);
    }, { timeout: 10_000, polling: 100 }, saved.options.anki ?? null);
  }
}

async function checkAnkiSettings(page, browser) {
  const original = await page.evaluate(async () => ({
    options: (await chrome.storage.local.get("options")).options,
    status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
  }));
  let offline = true, holdA = false, missingField = false;
  let releaseA;
  const calls = [];
  const route = { requests: 0, async respond(request) {
    if (offline) {
      calls.push(JSON.parse(request.postData));
      return { body: "Unavailable", status: 503, contentType: "text/plain" };
    }
    const reply = await answerAnkiConnect(JSON.parse(request.postData), async (action, params) => {
      calls.push({ action, params });
      if (action === "modelFieldNames" && params.modelName === "Japanese" && holdA) {
        holdA = false;
        await new Promise(resolve => { releaseA = resolve; });
      }
      const fields = params.modelName === "Basic" ? ["Front", "Back"]
        : missingField ? ["Changed"] : ["Expression", "Reading", "Meaning", "Sentence", "Frequency", "Pitch", "Audio"];
      return action === "deckNames" ? ["Default", "Japanese"]
        : action === "modelNames" ? ["Japanese", "Basic"] : fields;
    });
    return { body: JSON.stringify(reply), status: 200, contentType: "application/json" };
  } };
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const session = await interceptFetches(worker, new Map([["http://127.0.0.1:8765/", route]]), "anki");
  const status = () => page.$eval("#anki-status", node => node.textContent);
  const settled = () => page.waitForFunction(() => !document.getElementById("anki-refresh").disabled);
  const saved = () => page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
  const choose = async (id, value) => { await page.select(`#opt-anki-${id}`, value); await saved(); };
  const fieldSelector = field => `#anki-templates [data-anki-field="${field}"] [role="combobox"]`;
  const editField = async (field, value, inputType = "insertText") => {
    await page.$eval(fieldSelector(field), (node, [text, type]) => {
      node.focus();
      node.value = text;
      node.setSelectionRange(text.length, text.length);
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type, data: text }));
    }, [value, inputType]);
    await saved();
  };
  const insertText = async value => {
    const session = await page.createCDPSession();
    try {
      await session.send("Input.insertText", { text: value });
    } finally {
      await session.detach();
    }
  };
  try {
    const lazy = route.requests === 0;
    await showSettingsSection(page, "anki");
    await page.waitForFunction(() => document.getElementById("anki-status").textContent.includes("HTTP 503"));
    const failed = await status();
    offline = false;
    // The Audio view before this leaves the page scrolled, clipping the button
    // at the top edge where a click misses it; bring it fully into view first.
    await page.$eval("#anki-refresh", node => node.scrollIntoView({ block: "center" }));
    await page.click("#anki-refresh");
    await settled();
    check("Anki discovery is lazy and refresh recovers an offline connection through the real service worker",
      lazy && failed.includes("Not connected") && (await status()).includes("Connected")
        && await page.$eval("#opt-anki-model", node => [...node.options].some(option => option.value === "Japanese")),
      JSON.stringify({ failed, current: await status(), calls }));

    holdA = true;
    await page.select("#opt-anki-model", "Japanese");
    const deadline = Date.now() + 1000;
    while (!releaseA && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (!releaseA) throw new Error("Anki model A did not reach its deferred field response");
    await page.select("#opt-anki-model", "Basic");
    await settled();
    releaseA();
    await saved();
    const newest = await page.$$eval("#anki-templates [data-anki-field]",
      nodes => nodes.map(node => node.dataset.ankiField));
    await editField("Front", "{expression}");
    await choose("model", "Japanese");
    await settled();
    await editField("Expression", "{expression}");
    const revision = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    missingField = true;
    await page.click("#anki-refresh");
    await settled();
    const unavailable = await page.$eval('#anki-templates [data-anki-field="Expression"]', node => ({
      value: node.querySelector('[role="combobox"]').value,
      removable: !node.querySelector("button.ghost").hidden,
      label: node.querySelector(".field-label").textContent,
    }));
    const afterRefresh = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    check("Anki Settings reject stale model replies and preserve unavailable mappings without discovery writes",
      newest.includes("Front") && !newest.includes("Expression") && unavailable.value === "{expression}"
        && unavailable.removable && unavailable.label === "Expression" && (await status()).includes("unavailable")
        && revision === afterRefresh, JSON.stringify({ newest, unavailable, revision, afterRefresh }));

    missingField = false;
    await page.click("#anki-refresh");
    await settled();
    for (const [field, value] of [["Reading", "{reading}"], ["Meaning", "{definition}"], ["Sentence", "{sentence}"],
      ["Frequency", "{frequency}"], ["Pitch", "{pitch}"], ["Audio", "{audio}"]]) await editField(field, value);
    await choose("deck", "Japanese");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("anki-status").textContent.includes("configuration ready"));
    await saved();
    const persisted = await page.evaluate(async () => ({
      anki: (await chrome.storage.local.get("options")).options.anki,
      status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
      statusCard: (() => {
        const node = document.getElementById("anki-status");
        const style = getComputedStyle(node);
        const marker = getComputedStyle(node, "::before");
        return {
          display: style.display,
          fontSize: Number.parseFloat(style.fontSize),
          markerMask: marker.maskImage,
          markerWidth: Number.parseFloat(marker.width),
          state: node.dataset.state,
          ready: node.classList.contains("is-ready"),
          height: node.getBoundingClientRect().height,
        };
      })(),
    }));
    check("Anki configuration persists through reload without reloading the dictionary engine",
      persisted.anki.deck === "Japanese" && persisted.anki.model === "Japanese"
        && persisted.anki.fieldTemplates.Expression.value === "{expression}"
        && persisted.anki.fieldTemplates.Audio.value === "{audio}"
        && persisted.status.generation === original.status.generation
        && persisted.statusCard.display === "flex" && persisted.statusCard.fontSize <= 13
        && persisted.statusCard.markerMask === "none" && persisted.statusCard.markerWidth === 7
        && persisted.statusCard.state === "connected" && persisted.statusCard.ready
        && persisted.statusCard.height < 56, JSON.stringify(persisted));

    const comboboxContract = await page.evaluate(async () => {
      const { ANKI_TEMPLATE_MARKER_OPTIONS, ANKI_TEMPLATE_MARKERS } = await import("./anki-templates.js");
      const rows = [...document.querySelectorAll("#anki-templates [data-anki-field]")];
      const control = rows[0].querySelector('[role="combobox"]');
      const listbox = document.getElementById(control.getAttribute("aria-controls"));
      const options = [...listbox.querySelectorAll('[role="option"]')];
      return {
        fields: rows.map(row => row.dataset.ankiField),
        everyCombobox: rows.every(row => row.querySelector('[role="combobox"]')),
        optionValues: options.map(option => option.dataset.marker),
        expectedOptions: ANKI_TEMPLATE_MARKER_OPTIONS.map(option => option.value),
        coreMarkers: ANKI_TEMPLATE_MARKERS.map(marker => `{${marker}}`),
        described: options.every(option => option.getAttribute("aria-label")?.includes(": ")),
        label: document.querySelector(`label[for="${control.id}"]`)?.textContent,
        attributes: Object.fromEntries(["aria-expanded", "aria-controls", "aria-autocomplete", "aria-haspopup"]
          .map(name => [name, control.getAttribute(name)])),
        listboxRole: listbox.getAttribute("role"),
        statusRole: document.getElementById(control.getAttribute("aria-describedby").split(" ")[0])
          ?.getAttribute("role"),
      };
    });

    const expressionSelector = fieldSelector("Expression");
    await page.focus(expressionSelector);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    await page.keyboard.press("KeyA");
    await page.keyboard.up(modifier);
    await page.keyboard.type("{expr");
    await page.waitForFunction(selector => document.querySelector(selector).getAttribute("aria-expanded") === "true",
      {}, expressionSelector);
    const filtered = await page.$eval('#anki-templates [data-anki-field="Expression"]', node => {
      const control = node.querySelector('[role="combobox"]');
      const listbox = document.getElementById(control.getAttribute("aria-controls"));
      const visible = [...listbox.querySelectorAll('[role="option"]')].filter(option => !option.hidden);
      return {
        value: control.value,
        markers: visible.map(option => option.dataset.marker),
        active: control.getAttribute("aria-activedescendant"),
        selected: visible.filter(option => option.getAttribute("aria-selected") === "true").map(option => option.id),
        status: node.querySelector('[role="status"]').textContent,
      };
    });
    await page.keyboard.press("Escape");
    await saved();
    const escaped = await page.$eval(expressionSelector, node => ({
      value: node.value,
      expanded: node.getAttribute("aria-expanded"),
    }));

    const freeForm = "literal {expression} + suffix  ";
    await page.focus(expressionSelector);
    await page.keyboard.down(modifier);
    await page.keyboard.press("KeyA");
    await page.keyboard.up(modifier);
    await insertText(freeForm);
    await saved();
    const highlightedBeforeTab = await page.$eval(expressionSelector, node => node.getAttribute("aria-activedescendant"));
    await page.keyboard.press("Tab");
    await saved();
    const tabExit = await page.evaluate(async selector => {
      const control = document.querySelector(selector);
      const options = (await chrome.storage.local.get("options")).options.anki.fieldTemplates;
      return {
        value: control.value,
        stored: options.Expression.value,
        expanded: control.getAttribute("aria-expanded"),
        focusedId: document.activeElement?.id ?? "",
        leftControl: document.activeElement !== control,
      };
    }, expressionSelector);

    await editField("Expression", "before  after");
    await page.$eval(expressionSelector, node => node.setSelectionRange(7, 7));
    await page.click('#anki-templates [data-anki-field="Expression"] [role="option"][data-marker="{glossary}"]');
    await saved();
    const pointerValue = await page.$eval(expressionSelector, node => node.value);

    await editField("Expression", "{expression}{expression}");
    await page.$eval(expressionSelector, node => {
      const boundary = "{expression}".length;
      node.setSelectionRange(boundary, boundary);
    });
    await page.click('#anki-templates [data-anki-field="Expression"] [role="option"][data-marker="{reading}"]');
    await saved();
    const adjacentMarkerValue = await page.$eval(expressionSelector, node => node.value);

    await editField("Expression", "{expression}");
    await page.$eval(expressionSelector, node => {
      node.setSelectionRange(node.value.length, node.value.length);
    });
    await page.click('#anki-templates [data-anki-field="Expression"] [role="option"][data-marker="{reading}"]');
    await saved();
    const closingBoundaryValue = await page.$eval(expressionSelector, node => node.value);

    await editField("Expression", "");
    await page.keyboard.press("Escape");
    await page.focus(expressionSelector);
    await page.keyboard.press("ArrowDown");
    const keyboardFirst = await page.$eval(expressionSelector, node => node.getAttribute("aria-activedescendant"));
    await page.keyboard.press("ArrowDown");
    const keyboardSecond = await page.$eval(expressionSelector, node => node.getAttribute("aria-activedescendant"));
    await page.keyboard.press("Enter");
    await saved();
    const keyboardValue = await page.$eval(expressionSelector, node => node.value);

    await editField("Expression", "{definitely-no-marker");
    const emptyState = await page.$eval('#anki-templates [data-anki-field="Expression"]', node => ({
      emptyVisible: !node.querySelector(".anki-marker-empty").hidden,
      active: node.querySelector('[role="combobox"]').getAttribute("aria-activedescendant"),
      status: node.querySelector('[role="status"]').textContent,
    }));
    await page.keyboard.press("Escape");

    const copiedValue = " \tcopy {unknown}{unknown}\n literal  ";
    const readingSelector = fieldSelector("Reading");
    await page.focus(readingSelector);
    await page.keyboard.down(modifier);
    await page.keyboard.press("KeyA");
    await page.keyboard.up(modifier);
    await insertText(copiedValue);
    await saved();
    await page.keyboard.down(modifier);
    await page.keyboard.press("KeyA");
    await page.keyboard.press("KeyC");
    await page.keyboard.up(modifier);
    await page.focus(expressionSelector);
    await page.keyboard.down(modifier);
    await page.keyboard.press("KeyA");
    await page.keyboard.press("KeyV");
    await page.keyboard.up(modifier);
    await saved();
    const clipboard = await page.evaluate(async selector => {
      const control = document.querySelector(selector);
      const mappings = (await chrome.storage.local.get("options")).options.anki.fieldTemplates;
      return {
        control: control.value,
        expression: mappings.Expression.value,
        reading: mappings.Reading.value,
        invalid: control.getAttribute("aria-invalid"),
        error: control.closest(".anki-template-row").querySelector(".anki-template-error").textContent,
      };
    }, expressionSelector);

    await editField("Frequency", "composition: ");
    const frequencySelector = fieldSelector("Frequency");
    await page.$eval(frequencySelector, node => {
      node.focus();
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      node.value = "composition: 日本";
      node.setSelectionRange(node.value.length, node.value.length);
      node.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "日本",
        isComposing: true,
      }));
    });
    const compositionDuring = await page.evaluate(async () =>
      (await chrome.storage.local.get("options")).options.anki.fieldTemplates.Frequency.value);
    await page.$eval(frequencySelector, node => {
      node.value = "composition: 日本語\t";
      node.setSelectionRange(node.value.length, node.value.length);
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }));
    });
    await saved();
    const compositionAfter = await page.evaluate(async () =>
      (await chrome.storage.local.get("options")).options.anki.fieldTemplates.Frequency.value);

    await page.click('#anki-templates [data-anki-field="Expression"] .anki-marker-combobox-toggle');
    const cdp = await page.createCDPSession();
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: expressionSelector });
    const { node } = await cdp.send("DOM.describeNode", { nodeId });
    const { nodes: axNodes } = await cdp.send("Accessibility.getPartialAXTree", {
      backendNodeId: node.backendNodeId,
      fetchRelatives: false,
    });
    await cdp.detach();
    const ax = axNodes.find(candidate => !candidate.ignored) ?? axNodes[0];
    const axProperty = name => ax?.properties?.find(property => property.name === name)?.value?.value ?? null;
    const accessibility = {
      role: ax?.role?.value ?? null,
      name: ax?.name?.value ?? null,
      expanded: axProperty("expanded"),
      focusable: axProperty("focusable"),
    };
    const opened = await page.$eval(expressionSelector, node => ({
      expanded: node.getAttribute("aria-expanded"),
      listboxHidden: document.getElementById(node.getAttribute("aria-controls")).hidden,
    }));
    await page.keyboard.press("Escape");

    check("Anki field mappings expose accessible editable combobox behavior without replacing free-form text",
      comboboxContract.everyCombobox
        && JSON.stringify(comboboxContract.optionValues) === JSON.stringify(comboboxContract.expectedOptions)
        && comboboxContract.coreMarkers.every(marker => comboboxContract.optionValues.includes(marker))
        && comboboxContract.described && comboboxContract.label === "Expression"
        && comboboxContract.attributes["aria-expanded"] === "false"
        && comboboxContract.attributes["aria-autocomplete"] === "list"
        && comboboxContract.attributes["aria-haspopup"] === "listbox"
        && comboboxContract.listboxRole === "listbox" && comboboxContract.statusRole === "status"
        && JSON.stringify(filtered.markers) === JSON.stringify(["{expression}"])
        && filtered.active === filtered.selected[0] && filtered.status.includes("1 marker suggestion")
        && escaped.value === "{expr" && escaped.expanded === "false"
        && highlightedBeforeTab !== null && tabExit.value === freeForm && tabExit.stored === freeForm
        && tabExit.expanded === "false" && tabExit.leftControl
        && pointerValue === "before {glossary} after"
        && adjacentMarkerValue === "{expression}{reading}{expression}"
        && closingBoundaryValue === "{expression}{reading}"
        && keyboardFirst !== null && keyboardSecond !== keyboardFirst && keyboardValue !== ""
        && emptyState.emptyVisible && emptyState.active === null && emptyState.status.includes("No marker suggestions")
        && clipboard.control === copiedValue && clipboard.expression === copiedValue
        && clipboard.reading === copiedValue && clipboard.invalid === "true"
        && clipboard.error.includes("Unknown marker: {unknown}")
        && compositionDuring === "composition: " && compositionAfter === "composition: 日本語\t"
        && opened.expanded === "true" && opened.listboxHidden === false
        && accessibility.role === "combobox" && accessibility.name === "Expression"
        && accessibility.expanded === true && accessibility.focusable === true,
      JSON.stringify({
        comboboxContract,
        filtered,
        escaped,
        highlightedBeforeTab,
        tabExit,
        pointerValue,
        adjacentMarkerValue,
        closingBoundaryValue,
        keyboardFirst,
        keyboardSecond,
        keyboardValue,
        emptyState,
        clipboard,
        compositionDuring,
        compositionAfter,
        opened,
        accessibility,
      }));

    await page.select("#anki-preset", "kiku");
    await page.click("#anki-apply-preset");
    await saved();
    const templateEditor = await page.$("#anki-templates textarea");
    const templateId = await templateEditor.evaluate(node => node.id);
    await templateEditor.dispose();
    const editTemplate = async value => {
      await page.$eval(`#${templateId}`, (node, text) => {
        node.focus(); node.value = text; node.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await saved();
    };
    await editTemplate("<b>{expression}</b> {unknown}");
    const invalidMarker = await status();
    await editTemplate("<b>{expression}</b>");
    await choose("duplicate-behavior", "overwrite");
    await page.select(`#${templateId}-mode`, "coalesce-new");
    await saved();
    const templateState = await page.evaluate(async () => ({
      config: (await chrome.storage.local.get("options")).options.anki,
      editors: [...document.querySelectorAll("#anki-templates textarea")].map(node => ({ value: node.value, readOnly: node.readOnly })),
    }));
    check("Anki presets expose editable field templates and persist overwrite modes with visible marker errors",
      invalidMarker.includes("Unknown marker: {unknown}") && templateState.config.fieldTemplates.Expression.value === "<b>{expression}</b>"
        && templateState.config.fieldTemplates.Expression.overwriteMode === "coalesce-new"
        && templateState.editors.every(row => !row.readOnly), JSON.stringify({ invalidMarker, templateState }));
    // Kiku does not map this model's generic Reading field; a blank template
    // remains intentional through discovery and restart, not an auto-fill hint.
    const beforeTemplateRefresh = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    await page.click("#anki-refresh");
    await settled();
    const afterTemplateRefresh = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("anki-status").textContent.includes("configuration ready"));
    await saved();
    const templateReload = await page.evaluate(async () => ({
      config: (await chrome.storage.local.get("options")).options.anki,
      status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
      editor: document.querySelector("#anki-templates textarea").value,
    }));
    check("Anki templates survive refresh and reload while disabled values stay disabled and lookup generation stays unchanged",
      beforeTemplateRefresh === afterTemplateRefresh && templateReload.config.fieldTemplates.Reading.value === ""
        && templateReload.config.fieldTemplates.Expression.overwriteMode === "coalesce-new"
        && templateReload.editor === "<b>{expression}</b>" && templateReload.status.generation === original.status.generation,
      JSON.stringify({ beforeTemplateRefresh, afterTemplateRefresh, templateReload }));
    if (process.env.HACHIDORI_ANKI_SETTINGS_SCREENSHOT) {
      const section = await page.$("#anki");
      await section.screenshot({ path: process.env.HACHIDORI_ANKI_SETTINGS_SCREENSHOT });
    }
    if (process.env.HACHIDORI_ANKI_DUPLICATE_SETTINGS_SCREENSHOT) {
      const duplicateRow = await page.$(".anki-duplicate-row");
      await duplicateRow.screenshot({ path: process.env.HACHIDORI_ANKI_DUPLICATE_SETTINGS_SCREENSHOT });
    }
    await checkAnkiGlossaryExport(page);
    if (process.env.HACHIDORI_ANKI_SCREENSHOT) await page.screenshot({ path: process.env.HACHIDORI_ANKI_SCREENSHOT, fullPage: true });
  } finally {
    releaseA?.();
    await showSettingsSection(page, "lookup");
    await page.evaluate(async anki => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        requestId: "restore-anki", baseRevision: options.revision,
        options: { anki: anki ?? HDReaderOptions.normaliseOptions({}).anki } });
      if (!reply.ok) throw new Error(reply.error);
    }, original.options?.anki);
    // Later layout checks also visit Anki. Their caller releases this mock
    // before worker-restart checks; tests must never contact the user's Anki.
    offline = true;
  }
  return session;
}

async function checkToolbarPreview(page, frame) {
  const original = await readSettingsControls(page, ["opt-popup-toolbar", "opt-popup-opacity", "opt-popup-height"]);
  await frame.evaluate(() => {
    const root = document.getElementById("preview-host").shadowRoot;
    const popup = root.querySelector(".gsm-hoshidicts-popup");
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const form = popup.querySelector("form");
    const input = form.elements.definition;
    input.value = "A toolbar draft";
    input.focus();
    input.setSelectionRange(2, 7);
    const actions = form.querySelector(".gsm-hoshidicts-note-actions");
    const formRect = form.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const proof = { form, input, cards: [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")],
      formFits: form.scrollHeight <= form.clientHeight + 1
        && actionsRect.top >= formRect.top - 1 && actionsRect.bottom <= formRect.bottom + 1,
      removed: false, blurs: 0 };
    input.addEventListener("blur", () => { proof.blurs += 1; });
    proof.observer = new MutationObserver(records => {
      proof.removed ||= records.some(record => [...record.removedNodes].some(node => node.contains(input)));
    });
    proof.observer.observe(popup, { childList: true });
    window.toolbarProof = proof;
  });
  try {
    const cases = [];
    for (const edge of ["bottom", "top", "auto"]) {
      await editSettingsControls(page, { "opt-popup-toolbar": edge });
      const saved = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.popupToolbarPosition);
      cases.push(saved === edge && await frame.evaluate(edge => {
        const proof = window.toolbarProof;
        const root = document.getElementById("preview-host").shadowRoot;
        const popup = root.querySelector(".gsm-hoshidicts-popup");
        const cards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
        // The scene's dialogue is below the popup, so Automatic keeps its
        // toolbar at the bottom, nearest the hovered game text.
        return popup.dataset.toolbarPosition === (edge === "auto" ? "bottom" : edge)
          && root.activeElement === proof.input && proof.input.value === "A toolbar draft"
          && proof.input.selectionStart === 2 && proof.input.selectionEnd === 7 && !proof.removed && proof.blurs === 0
          && proof.formFits
          && proof.form === popup.querySelector("form") && cards.length === proof.cards.length
          && cards.every((card, index) => card === proof.cards[index]);
      }, edge));
    }
    check("toolbar preferences persist and move the preview without detaching focused Notes or rebuilding cards",
      cases.every(Boolean), JSON.stringify(cases));
    await frame.evaluate(() => window.toolbarProof.form.querySelector(".gsm-hoshidicts-note-cancel").click());
    const clipping = [];
    for (const edge of ["top", "bottom"]) {
      await editSettingsControls(page, { "opt-popup-toolbar": edge, "opt-popup-opacity": "10", "opt-popup-height": "200" });
      await frame.waitForFunction(edge => {
        const host = document.getElementById("preview-host");
        const popup = host.shadowRoot.querySelector(".gsm-hoshidicts-popup");
        return popup.dataset.toolbarPosition === edge
          && host.style.getPropertyValue("--gsm-hoshidicts-popup-opacity") === "10%"
          && popup.getBoundingClientRect().height === 200;
      }, {}, edge);
      clipping.push(await frame.evaluate(async edge => {
        const host = document.getElementById("preview-host");
        const popup = host.shadowRoot.querySelector(".gsm-hoshidicts-popup");
        const scroll = popup.querySelector(".gsm-hoshidicts-content-scroll");
        const toolbar = popup.querySelector(".gsm-hoshidicts-result-chrome");
        const before = toolbar.getBoundingClientRect();
        scroll.scrollTop = Math.min(80, scroll.scrollHeight - scroll.clientHeight);
        for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame);
        const contentRect = scroll.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        return {
          edge: popup.dataset.toolbarPosition,
          opacity: host.style.getPropertyValue("--gsm-hoshidicts-popup-opacity"),
          scrollTop: scroll.scrollTop, outerScrollTop: popup.scrollTop,
          contentOverflow: getComputedStyle(scroll).overflowY,
          outerOverflow: getComputedStyle(popup).overflowY,
          siblings: scroll.parentElement === popup && toolbar.parentElement === popup,
          separate: contentRect.height > 0 && toolbarRect.height > 0
            && (edge === "top" ? toolbarRect.bottom <= contentRect.top + 1 : contentRect.bottom <= toolbarRect.top + 1),
          stationary: Math.abs(before.top - toolbarRect.top) <= 1 && Math.abs(before.bottom - toolbarRect.bottom) <= 1,
          bounded: contentRect.top >= popupRect.top && contentRect.bottom <= popupRect.bottom
            && toolbarRect.top >= popupRect.top && toolbarRect.bottom <= popupRect.bottom,
          contentRect: contentRect.toJSON(), toolbarRect: toolbarRect.toJSON(), popupRect: popupRect.toJSON(),
        };
      }, edge));
    }
    check("low-opacity popup content scrolls in a clipped viewport without overlapping either toolbar position",
      clipping.every((value, index) => value.edge === ["top", "bottom"][index]
        && value.opacity === "10%" && value.scrollTop > 0 && value.outerScrollTop === 0
        && value.contentOverflow === "auto" && value.outerOverflow === "hidden"
        && value.siblings && value.separate && value.stationary && value.bounded), JSON.stringify(clipping));
  } finally {
    await frame.evaluate(() => {
      window.toolbarProof.observer.disconnect();
      if (!window.toolbarProof.form.hidden) window.toolbarProof.form.querySelector(".gsm-hoshidicts-note-cancel").click();
      delete window.toolbarProof;
    });
    await editSettingsControls(page, original);
  }
}

async function checkDesignAppearance(page, frame) {
  const saved = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const drain = () => frame.evaluate(async () => {
    for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame);
  });
  try {
    const catalogue = await page.$eval("#opt-popup-theme", select => ({ count: select.options.length,
      groups: [...select.children].map(group => group.children.length) }));
    await frame.evaluate(() => {
      const host = document.getElementById("preview-host");
      window.appearanceProof = { card: host.shadowRoot.querySelector(".gsm-hoshidicts-glossary-card"),
        stylesheet: host.shadowRoot.adoptedStyleSheets[0], highlightSheet: document.adoptedStyleSheets[0] };
    });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await editSettingsControls(page, { "opt-popup-theme": "auto" });
    const automatic = [];
    for (const scheme of ["light", "dark"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await frame.waitForFunction(expected =>
        document.getElementById("preview-host").dataset.hoshidictsTheme === expected, {}, scheme);
      automatic.push(await frame.evaluate(() => {
        const host = document.getElementById("preview-host");
        const popup = host.shadowRoot.querySelector(".gsm-hoshidicts-popup");
        return { theme: host.dataset.hoshidictsTheme,
          retained: window.appearanceProof.card === popup.querySelector(".gsm-hoshidicts-glossary-card")
            && window.appearanceProof.stylesheet === host.shadowRoot.adoptedStyleSheets[0]
            && window.appearanceProof.highlightSheet === document.adoptedStyleSheets[0],
          pageUntouched: !document.documentElement.hasAttribute("data-hoshidicts-theme") };
      }));
    }
    await page.emulateMediaFeatures([]);
    const palettes = [];
    for (const theme of ["miku", "girlypop", "light", "high-contrast"]) {
      await editSettingsControls(page, { "opt-popup-theme": theme });
      palettes.push(await frame.evaluate(() => {
        const host = document.getElementById("preview-host");
        const popup = host.shadowRoot.querySelector(".gsm-hoshidicts-popup");
        return { primary: getComputedStyle(host).getPropertyValue("--hoshidicts-palette-primary").trim(),
          backdrop: getComputedStyle(popup).backdropFilter,
          retained: window.appearanceProof.card === popup.querySelector(".gsm-hoshidicts-glossary-card")
            && window.appearanceProof.stylesheet === host.shadowRoot.adoptedStyleSheets[0]
            && window.appearanceProof.highlightSheet === document.adoptedStyleSheets[0],
          pageUntouched: !document.documentElement.hasAttribute("data-hoshidicts-theme") };
      }));
      if (theme === "miku" || theme === "girlypop") {
        const stops = async opacity => {
          await editSettingsControls(page, { "opt-popup-opacity": String(opacity) });
          return frame.evaluate(() => {
            const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
            return [...getComputedStyle(popup).backgroundImage.matchAll(/color\(srgb[^)]* \/ ([\d.]+)\)/g)]
              .map(match => Number(match[1]));
          });
        };
        palettes.at(-1).zeroStops = await stops(0);
        palettes.at(-1).fullStops = await stops(100);
      }
    }
    check("Design exposes AUTO plus 42 grouped palettes and applies live browser preference changes",
      catalogue.count === 43 && JSON.stringify(catalogue.groups) === "[1,18,23,1]"
        && JSON.stringify(automatic.map(value => value.theme)) === '["light","dark"]'
        && automatic.every(value => value.retained && value.pageUntouched)
        && palettes.every(value => value.retained && value.pageUntouched)
        && palettes[0].primary === "#39c5bb" && palettes[2].primary === "oklch(45% 0.24 277.023)"
        && palettes[3].primary === "#ffe000" && palettes[3].backdrop === "none"
        && palettes.slice(0, 2).every(value => JSON.stringify(value.zeroStops) === "[0,0]")
        && JSON.stringify(palettes[0].fullStops) === "[0.18,0.12]"
        && JSON.stringify(palettes[1].fullStops) === "[0.22,0.12]",
      JSON.stringify({ catalogue, automatic, palettes }));
    await editSettingsControls(page, { "opt-popup-theme": "default" });
    const immediate = await page.evaluate(async () => {
      const revision = (await chrome.storage.local.get("options")).options.revision;
      for (const [id, value] of [["opt-popup-width", "720"], ["opt-popup-height", "500"], ["opt-popup-opacity", "0"]]) {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const host = document.getElementById("design-preview").contentDocument.getElementById("preview-host");
      return host.style.getPropertyValue("--gsm-hoshidicts-popup-width") === "720px"
        && host.style.getPropertyValue("--gsm-hoshidicts-popup-height") === "500px"
        && host.style.getPropertyValue("--gsm-hoshidicts-popup-opacity") === "0%"
        && (await chrome.storage.local.get("options")).options.revision === revision;
    });
    await page.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupWidthPx === 720);
    await drain();
    const geometry = await frame.evaluate(() => {
      const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      return { width: popup.getBoundingClientRect().width, height: popup.getBoundingClientRect().height,
        background: getComputedStyle(popup).backgroundColor, opacity: getComputedStyle(popup).opacity };
    });
    await editSettingsControls(page, { "opt-popup-opacity": "100" });
    const opaque = await frame.evaluate(() => getComputedStyle(document.getElementById("preview-host")
      .shadowRoot.querySelector(".gsm-hoshidicts-popup")).backgroundColor);
    await frame.evaluate(() => document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-link").click());
    await editSettingsControls(page, { "opt-source-highlight": false });
    const disabled = await frame.evaluate(() => !CSS.highlights.has("gsm-hoshidicts-match"));
    await editSettingsControls(page, { "opt-source-highlight": true });
    const restored = await frame.evaluate(() => [...CSS.highlights.get("gsm-hoshidicts-match")].map(range => range.toString()).join(""));
    await frame.evaluate(() => document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back").click());
    const beforeReset = await page.evaluate(() => chrome.storage.local.get(["options", "dictionaryState", "dictionaryUpdates"]));
    await editSettingsControls(page, { "opt-popup-scale": "75" });
    await page.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupScalePercent === 75);
    await drain();
    const scaled = await frame.evaluate(() => document.getElementById("preview-host").shadowRoot
      .querySelector(".gsm-hoshidicts-popup").getBoundingClientRect().width);
    if (scaled !== 540) throw new Error(`75% preview width: ${scaled}`);
    await page.$eval("#reset-design", button => button.click());
    await page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
    const reset = await page.evaluate(async before => {
      const after = await chrome.storage.local.get(["options", "dictionaryState", "dictionaryUpdates"]);
      const { DEFAULT_OPTIONS, DESIGN_OPTION_KEYS, normaliseOptions } = HDReaderOptions;
      const options = normaliseOptions(after.options);
      return DESIGN_OPTION_KEYS.every(key => JSON.stringify(options[key]) === JSON.stringify(DEFAULT_OPTIONS[key]))
        && Object.keys(before.options).filter(key => key !== "revision" && !DESIGN_OPTION_KEYS.includes(key))
          .every(key => JSON.stringify(after.options[key]) === JSON.stringify(before.options[key]))
        && JSON.stringify(before.dictionaryState) === JSON.stringify(after.dictionaryState)
        && JSON.stringify(before.dictionaryUpdates) === JSON.stringify(after.dictionaryUpdates);
    }, beforeReset);
    check("Design previews opacity and dimensions immediately and resets only Design settings", immediate && reset
      && geometry.width === 720 && geometry.height === 500 && geometry.opacity === "1"
      && geometry.background.endsWith(" / 0)") && !opaque.includes(" / ") && disabled && restored === "食べる",
    JSON.stringify({ immediate, geometry, opaque, disabled, restored, reset }));
  } finally {
    await page.emulateMediaFeatures([]);
    await page.evaluate(async saved => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options.revision, options: HDReaderOptions.normaliseOptions(saved) });
      if (!reply.ok) throw new Error(reply.error);
    }, saved);
  }
}

async function checkCustomCssPreview(page, frame) {
  await page.$eval("#opt-custom-popup-css", editor => { editor.closest("details").open = true; });
  const saved = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const css = "/* My popup */\n.gsm-hoshidicts-popup {\n  outline-color: rgb(12, 34, 56);\n  font-size: 17px;\n}\nbody { background: red; }\n.bad { color: ???; }";
  const savedStatus = () => page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
  const input = text => page.evaluate(text => {
    const editor = document.getElementById("opt-custom-popup-css");
    editor.value = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    const root = document.getElementById("design-preview").contentDocument.getElementById("preview-host").shadowRoot;
    return { color: getComputedStyle(root.querySelector(".gsm-hoshidicts-popup")).outlineColor,
      status: document.getElementById("options-status").textContent,
      count: document.getElementById("custom-css-count").textContent };
  }, text);
  await frame.evaluate(() => {
    const root = document.getElementById("preview-host").shadowRoot;
    const popup = root.querySelector(".gsm-hoshidicts-popup");
    const base = new CSSStyleSheet();
    base.replaceSync(".gsm-hoshidicts-popup { outline-color: rgb(1, 2, 3); }");
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, base];
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const form = popup.querySelector("form");
    form.elements.definition.value = "Keep my draft";
    window.cssProof = { base, baseSheets: [...root.adoptedStyleSheets], form, card: popup.querySelector(".gsm-hoshidicts-glossary-card"),
      pageBackground: getComputedStyle(document.body).backgroundColor };
  });
  try {
    const immediate = await input(css);
    await savedStatus();
    const persisted = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.customPopupCss);
    const cascade = await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      const popup = root.querySelector(".gsm-hoshidicts-popup");
      const late = document.createElement("style");
      late.textContent = ".gsm-hoshidicts-popup { outline-color: rgb(7, 8, 9); }";
      root.append(late);
      window.cssProof.late = late;
      const style = getComputedStyle(popup);
      return style.outlineColor === "rgb(12, 34, 56)" && style.fontSize === "17px"
        && getComputedStyle(document.body).backgroundColor === window.cssProof.pageBackground
        && root.adoptedStyleSheets.length === window.cssProof.baseSheets.length + 1
        && window.cssProof.baseSheets.every((sheet, index) => root.adoptedStyleSheets[index] === sheet)
        && root.querySelector("form") === window.cssProof.form && window.cssProof.form.elements.definition.value === "Keep my draft"
        && root.querySelector(".gsm-hoshidicts-glossary-card") === window.cssProof.card;
    });
    if (process.env.HACHIDORI_CUSTOM_CSS_SCREENSHOT) {
      await input("/* A little more breathing room */\n.gsm-hoshidicts-popup {\n  font-size: 17px;\n}\n\n.gsm-hoshidicts-glossary-card {\n  border-radius: 10px;\n}");
      await savedStatus();
      await frame.evaluate(() => window.cssProof.form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await page.setViewport({ width: 1440, height: 1000 });
      await page.$eval("#opt-custom-popup-css", editor => editor.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: process.env.HACHIDORI_CUSTOM_CSS_SCREENSHOT });
      await frame.evaluate(() => {
        const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
        popup.querySelector(".gsm-hoshidicts-note-button").click();
        window.cssProof.form = popup.querySelector("form");
      });
    }
    const beforeReset = await page.evaluate(() => chrome.storage.local.get(["options", "dictionaryState"]));
    await page.$eval("#reset-custom-css", button => button.click());
    await savedStatus();
    const reset = await page.evaluate(async before => {
      const after = await chrome.storage.local.get(["options", "dictionaryState"]);
      return after.options.customPopupCss === "" && document.getElementById("opt-custom-popup-css").value === ""
        && document.getElementById("custom-css-count").textContent === "0 characters"
        && Object.keys(before.options).filter(key => !["revision", "customPopupCss"].includes(key))
          .every(key => JSON.stringify(before.options[key]) === JSON.stringify(after.options[key]))
        && JSON.stringify(before.dictionaryState) === JSON.stringify(after.dictionaryState);
    }, beforeReset);
    const detached = await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      return root.adoptedStyleSheets.length === window.cssProof.baseSheets.length
        && window.cssProof.baseSheets.every((sheet, index) => root.adoptedStyleSheets[index] === sheet)
        && getComputedStyle(root.querySelector(".gsm-hoshidicts-popup")).outlineColor === "rgb(1, 2, 3)"
        && root.querySelector("form") === window.cssProof.form;
    });
    check("custom CSS editor previews unsaved text, persists its count and resets only its stylesheet",
      immediate.color === "rgb(12, 34, 56)" && immediate.status === "Unsaved changes…"
        && immediate.count === `${css.length} characters` && persisted === css && reset && detached,
      JSON.stringify({ immediate, reset, detached }));
    check("custom CSS overrides built-in and late dictionary styles only inside the popup shadow tree and tolerates invalid CSS", cascade);
  } finally {
    await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter(sheet => sheet !== window.cssProof.base);
      window.cssProof.late?.remove();
      window.cssProof.form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      delete window.cssProof;
    });
    await input(saved.customPopupCss || "");
    await savedStatus();
  }
}

async function checkDesignPreview(page) {
  const original = await readSettingsControls(page, ["opt-popup-columns", "opt-compact-summary", "opt-frequency-names"]);
  const originalViewport = page.viewport();
  const before = await page.evaluate(async (sourceKey) => ({
    lazy: document.getElementById("design-preview") === null,
    stored: await chrome.storage.local.get(["dictionaryState", sourceKey]),
  }), CUSTOM_DICTIONARY_SOURCE_KEY);
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await showSettingsSection(page, "design");
    const frame = await (await page.$("#design-preview")).contentFrame();
    await frame.waitForFunction(() => document.getElementById("preview-host")?.shadowRoot
      ?.querySelector('.gloss-image-link[data-image-load-state="loaded"] img')?.naturalWidth > 0,
    { timeout: 10_000 });
    const scene = await readVisualNovelScene(frame, "#preview-source");
    const popupRect = await frame.evaluate(() => document.getElementById("preview-host").shadowRoot
      .querySelector(".gsm-hoshidicts-popup").getBoundingClientRect().toJSON());
    const sample = await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      const popup = root.querySelector(".gsm-hoshidicts-popup");
      window.previewCard = popup.querySelector(".gsm-hoshidicts-glossary-card");
      const initial = popup.textContent.includes("食べる") && !!popup.querySelector(".gsm-hoshidicts-tag-frequency")
        && !!popup.querySelector(".gsm-hoshidicts-tag-pitch") && CSS.highlights.has("gsm-hoshidicts-match");
      popup.querySelector(".gsm-hoshidicts-kanji-link").focus();
      return initial && popup.querySelectorAll(".gsm-hoshidicts-glossary-card").length === 4
        && root.host.dataset.hoshidictsRenderer === "default" && root.adoptedStyleSheets.length > 0;
    });
    await page.keyboard.press("Enter");
    const kanji = await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      return root.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent === "食"
        && root.activeElement?.classList.contains("gsm-hoshidicts-kanji-back")
        && [...CSS.highlights.get("gsm-hoshidicts-match")].map(range => range.toString()).join("") === "食べる";
    });
    await page.keyboard.press("Enter");
    const back = await frame.evaluate(() => document.getElementById("preview-host").shadowRoot
      .activeElement?.classList.contains("gsm-hoshidicts-kanji-link"));
    check("Design lazily renders local sample terms, kanji and images over a visual novel scene through the production popup",
      before.lazy && sample && kanji && back && scene?.backgroundLoaded && scene.nextVisible && scene.dialogueVisible && scene.sourceAccessible
        && scene.highlighted === "食べる" && popupRect.bottom <= scene.sourceTop && popupRect.top < scene.dialogueTop,
      JSON.stringify({ lazy: before.lazy, sample, kanji, back, scene, popupRect }));
    await frame.evaluate(() => {
      const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      window.previewCard = popup.querySelector(".gsm-hoshidicts-glossary-card");
      popup.querySelector(".gsm-hoshidicts-note-button").click();
      window.previewForm = popup.querySelector("form");
      window.previewForm.elements.definition.value = "Preview only";
    });
    const cycled = await cycleVisualNovelScene(frame, "#preview-source");
    await editSettingsControls(page, { "opt-popup-columns": "2", "opt-compact-summary": true, "opt-frequency-names": false });
    const live = await frame.evaluate(async () => {
      const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      const retained = popup.querySelector(".gsm-hoshidicts-glossary-card") === window.previewCard
        && popup.querySelector("form") === window.previewForm && !!popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
      window.previewForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      return retained && popup.textContent.includes("This is a preview. Notes are not saved.")
        && window.previewForm.elements.definition.value === "Preview only";
    });
    const after = await page.evaluate(sourceKey => chrome.storage.local.get(["dictionaryState", sourceKey]), CUSTOM_DICTIONARY_SOURCE_KEY);
    check("Design live edits preserve popup cards and Notes while sample appends cannot mutate dictionaries",
      cycled && live && JSON.stringify(before.stored) === JSON.stringify(after));
    await frame.evaluate(() => window.previewForm.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const geometry = () => page.evaluate(() => {
      const frame = document.getElementById("design-preview");
      const viewport = document.getElementById("preview-viewport");
      const popup = frame.contentDocument.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      return { scale: new DOMMatrix(getComputedStyle(frame).transform).a, frameWidth: frame.getBoundingClientRect().width,
        available: viewport.clientWidth, width: popup.getBoundingClientRect().width, height: popup.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        localOverflow: viewport.scrollWidth > viewport.clientWidth,
        retained: popup.querySelector(".gsm-hoshidicts-glossary-card") === frame.contentWindow.previewCard };
    });
    const fit = await geometry();
    await page.select("#preview-size", "actual");
    const actual = await geometry();
    await page.setViewport({ width: 320, height: 900 });
    await page.select("#preview-size", "fit");
    await page.waitForFunction(() => document.getElementById("design-preview").getBoundingClientRect().width
      <= document.getElementById("preview-viewport").clientWidth + 1);
    const narrow = await geometry();
    check("Design fits the popup without changing its actual dimensions and keeps narrow Settings scrollable",
      [fit, actual, narrow].every(value => value.width === 560 && value.height === 420 && !value.overflow && value.retained)
        && fit.scale < 1 && fit.frameWidth <= fit.available + 1 && actual.scale === 1 && actual.localOverflow
        && narrow.scale < fit.scale, JSON.stringify({ fit, actual, narrow }));
    await page.setViewport({ width: 1280, height: 900 });
    await checkDesignAppearance(page, frame);
    await checkToolbarPreview(page, frame);
    await checkCustomCssPreview(page, frame);
    if (process.env.HACHIDORI_DESIGN_SCREENSHOT) {
      await page.setViewport({ width: 1440, height: 1000 });
      await frame.evaluate(async () => {
        const root = document.getElementById("preview-host").shadowRoot;
        root.activeElement?.blur();
        root.querySelector(".gsm-hoshidicts-content-scroll").scrollTop = 0;
        for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame);
      });
      await page.screenshot({ path: process.env.HACHIDORI_DESIGN_SCREENSHOT });
    }
  } finally {
    await page.setViewport(originalViewport);
    await editSettingsControls(page, original);
    await showSettingsSection(page, "lookup");
  }
}

// Values that more than one step uses; the step that creates each one assigns it.
let ankiSession;

describe("Settings", () => {
  step("first-run Anki detection", async () => {
    await checkFirstRunAnkiDetection(page, browser, startupUrl);
  });

  step("Settings autosave", async () => {
    await checkSettingsAutosave(page, browser, settingsUrl);
  });

  step("Settings save feedback", async () => {
    await checkSettingsFeedback(browser, settingsUrl, check);
  });

  step("Settings option transport", async () => {
    await checkSettingsTransport(page);
  });

  step("the Design preview", async () => {
    await checkDesignPreview(page);
  });

  step("Audio Settings", async () => {
    await checkAudioSettings(page, browser);
  });

  step("Anki Settings", async () => {
    ankiSession = await checkAnkiSettings(page, browser);
  });

  step("dictionary CSS", async () => {
    await checkDictionaryStyles(page);
  });
});

export { ankiSession };
