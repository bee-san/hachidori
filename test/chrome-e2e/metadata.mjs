/*
 * Frequency direction, popup metadata and popup audio.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./activation.mjs";
import { describe } from "node:test";
import { frequencyRankingFixture, GENERIC_KANJI_GLOSSARY } from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import { hoverForPopup } from "./popup-reader.mjs";
import { popup, tab } from "./reader.mjs";
import {
  browser,
  editSettingsControls,
  installMediaArchive,
  installMediaReplyProbe,
  interceptFetches,
  makeAudioWav,
  page,
  readSettingsControls,
  restoreMediaReplyProbe,
  setDictionaryAliasInSettings,
  showSettingsSection,
} from "./session.mjs";

async function checkPopupAudio(settings, tab, popup, browser) {
  const original = await settings.evaluate(async () => ({
    options: (await chrome.storage.local.get("options")).options,
    status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
  }));
  const write = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const source = (id, type, url, enabled = true) => ({ id, type, url, enabled, voice: "" });
  const base = "https://audio.example.test/popup-";
  const routes = new Map();
  const route = (path, body, contentType = "application/json", status = 200) =>
    routes.set(base + path, { body, contentType, status, requests: 0 });
  route("failure", "Unavailable", "text/plain", 503);
  route("disabled", "Must not request", "text/plain", 503);
  route("bad.wav", "not audio", "audio/wav");
  route("tokyo.wav", makeAudioWav(), "audio/wav");
  route("osaka.wav", makeAudioWav(), "audio/wav");
  route("list", JSON.stringify({ type: "audioSourceList", audioSources: [
    { url: base + "bad.wav", name: "Unplayable" }, { url: base + "tokyo.wav", name: "Tokyo" },
    { url: base + "osaka.wav", name: "Osaka" },
  ] }));
  const sources = [source("disabled", "custom", base + "disabled", false),
    source("failure", "custom", base + "failure"), source("json", "custom-json", base + "list")];
  const target = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
  const session = await interceptFetches(target, routes, "popup-audio");
  const native = await target.createCDPSession();
  const evaluate = async expression => {
    const reply = await native.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  await evaluate(`globalThis.__e20NativeAudio = Audio; globalThis.__e20Audio = [];
    globalThis.Audio = function (...args) { const audio = new __e20NativeAudio(...args); __e20Audio.push(audio); return audio; };`);
  const count = () => [...routes.values()].reduce((sum, route) => sum + route.requests, 0);
  async function until(predicate) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await popup.audio();
      if (predicate(state)) return state;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Popup audio state timed out: ${JSON.stringify(await popup.audio())}`);
  }
  const completed = () => until(state => state?.button === "" && state.audioBusy === "false"
    && !state.audioState && state.feedback.every(text => text === ""));
  const rehover = async () => {
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
  };
  try {
    await write({ audioSources: sources, audioAutoplay: false });
    await rehover();
    const silent = count() === 0;
    await popup.audio("play");
    const played = await completed();
    check("Popup audio is silent by default and manually falls back through enabled sources and playable candidates",
      silent && played.feedback.every(text => text === "") && routes.get(base + "tokyo.wav").requests === 1
        && routes.get(base + "disabled").requests === 0
        && routes.get(base + "failure").requests === 1 && routes.get(base + "bad.wav").requests === 1,
      JSON.stringify({ silent, played, requests: [...routes].map(([url, route]) => [url, route.requests]) }));

    // A real right-click on Audio, then Down from the keyboard, open the chooser beside it.
    const audioButton = played.buttonRect;
    await tab.mouse.click(audioButton.x + audioButton.width / 2, audioButton.y + audioButton.height / 2, { button: "right" });
    const choices = await until(state => state?.choices.length === 4);
    const unmoved = JSON.stringify(choices.definitions) === JSON.stringify(played.definitions);
    if (process.env.HACHIDORI_AUDIO_POPUP_SCREENSHOT) {
      const { x, y, width, height } = choices.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_AUDIO_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    await tab.keyboard.press("Escape");
    const escaped = await popup.audio();
    await tab.keyboard.press("ArrowDown");
    const reopened = await until(state => state?.choices.length === 4);
    const candidate = await popup.audio("candidate", 3);
    await tab.mouse.click(candidate.candidatePoint.x, candidate.candidatePoint.y);
    const chosen = await completed();
    const beforeWarm = count();
    await popup.audio("play");
    const warm = await completed();
    const media = await evaluate("__e20Audio.map(audio => ({ ended: audio.ended, source: audio.getAttribute('src'), paused: audio.paused }))");
    check("Popup pronunciation choices open beside Audio from a right-click and Down, preserve source identity and warm replay reuses native cached media",
      choices.menuBeside && unmoved && reopened.menuBeside
        && choices.choices.join(",") === "Pronunciation 1,Unplayable,Tokyo,Osaka" && !escaped.menu
        && escaped.focused === "gsm-hoshidicts-audio-button" && chosen.feedback.every(text => text === "")
        && routes.get(base + "osaka.wav").requests === 1 && warm.feedback.every(text => text === "")
        && count() === beforeWarm && media.length === 4
        && media.every(item => item.paused && item.source === null),
      JSON.stringify({ played, choices, unmoved, escaped, reopened, chosen, warm, media }));

    await write({ audioSources: [source("auto", "custom", base + "tokyo.wav")], audioAutoplay: true });
    await rehover();
    await completed();
    const beforeEcho = await evaluate("__e20Audio.length");
    await write({ popupTheme: "light" });
    await popup.click(".gsm-hoshidicts-kanji-link");
    await until(state => state?.text.includes(GENERIC_KANJI_GLOSSARY));
    await completed();
    const beforeBack = await evaluate("__e20Audio.length");
    await popup.click(".gsm-hoshidicts-kanji-back");
    await until(state => state?.text.includes("to eat"));
    const afterBack = await evaluate("__e20Audio.length");
    check("Popup autoplay is optional and does not replay after presentation updates or Back",
      beforeBack === beforeEcho + 1 && afterBack === beforeBack, JSON.stringify({ beforeEcho, beforeBack, afterBack }));

    await write({ audioAutoplay: false, audioSources: [source("pending", "custom", base + "pending")] });
    const hold = await target.createCDPSession();
    let held;
    hold.on("Fetch.requestPaused", event => { held = event.requestId; });
    await hold.send("Fetch.enable", { patterns: [{ urlPattern: base + "pending", requestStage: "Request" }] });
    await popup.audio("play");
    const holdDeadline = Date.now() + 5000;
    while (!held && Date.now() < holdDeadline) await new Promise(done => setTimeout(done, 20));
    if (!held) throw new Error("Popup pronunciation did not start its pending fetch");
    await tab.keyboard.press("Escape");
    await hold.send("Fetch.failRequest", { requestId: held, errorReason: "Aborted" }).catch(() => {});
    await hold.detach();
    const dismissed = !await popup.visible();
    await write({ audioSources: [source("current", "custom", base + "tokyo.wav")] });
    await rehover();
    await popup.audio("play");
    await until(state => state?.audioState === "playing");
    await write({ audioSources: [] });
    await until(state => state?.audioHidden && state.audioBusy === "false" && state.feedback.every(text => text === ""));
    const changed = await evaluate("__e20Audio.at(-1).paused && __e20Audio.at(-1).getAttribute('src') === null");
    await write({ audioSources: [source("current", "custom", base + "tokyo.wav")] });
    await popup.audio("play");
    await until(state => state?.audioState === "playing");
    // Loop this clip so natural completion cannot stand in for cancellation.
    await evaluate("__e20Audio.at(-1).loop = true");
    await tab.reload({ waitUntil: "load" });
    const navigated = await evaluate(`(async () => {
      const audio = __e20Audio.at(-1), deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (audio.paused && audio.getAttribute('src') === null) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return false;
    })()`);
    const status = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
    check("Popup audio cancels obsolete discovery and playback on dismissal, source changes and navigation",
      dismissed && changed && navigated && status.generation === original.status.generation,
      JSON.stringify({ dismissed, changed, navigated, status }));
  } finally {
    await evaluate("for (const audio of __e20Audio) audio.pause(); globalThis.Audio = __e20NativeAudio; delete globalThis.__e20NativeAudio; delete globalThis.__e20Audio");
    await native.detach();
    await session.detach();
    await write({ audioSources: original.options.audioSources, audioAutoplay: original.options.audioAutoplay ?? false,
      popupTheme: original.options.popupTheme });
    await tab.keyboard.press("Escape");
  }
}

async function checkFrequencyDirection(browser, settings, tab, popup) {
  const fixture = frequencyRankingFixture();
  const original = await readSettingsControls(settings, ["opt-frequency-dictionary", "opt-frequency-order", "opt-max-results"]);
  const originalVerb = await tab.$eval("#verb", (element) => element.innerHTML);
  const viewport = settings.viewport();
  const status = () => settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
  const before = await status();
  const installed = [];
  let worker;
  const evidence = [];
  let metadata;
  let manualSurvived;
  let cleaned;
  try {
    for (const dictionary of fixture.dictionaries) {
      await installMediaArchive(settings, dictionary.archive);
      installed.push(dictionary.title);
    }
    await settings.waitForFunction((titles) => titles.every((title) =>
      [...document.getElementById("opt-frequency-dictionary").options].some((option) => option.value === title)),
    { timeout: 10_000 }, installed);
    worker = await installMediaReplyProbe(browser, settings);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await editSettingsControls(settings, { "opt-max-results": "1" });
    async function observe(title, direction, reading) {
      await tab.bringToFront();
      await tab.keyboard.press("Escape");
      await tab.evaluate(() => { window.getSelection().removeAllRanges(); document.activeElement?.blur(); });
      await worker.evaluate(() => { globalThis.__ownedMediaProbe.lookups.length = 0; });
      const rendered = await hoverForPopup(tab, popup, "#verb");
      const requests = await worker.evaluate(() => globalThis.__ownedMediaProbe.lookups);
      const options = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options);
      evidence.push(options.frequencyDictionary === title && options.frequencyOrder === direction && options.maxResults === 1
        && rendered?.text.includes(`${fixture.dictionaries[0].title}: ${reading}`)
        && requests.some((request) => request.text === fixture.query && request.maxResults === 1
          && request.options.frequencyDictionary === title && request.options.frequencyOrder === direction));
      return options;
    }
    const [rank, occurrence] = installed;
    await editSettingsControls(settings, { "opt-frequency-dictionary": rank });
    const generation = (await status()).generation;
    await observe(rank, "ascending", "い");
    await editSettingsControls(settings, { "opt-frequency-order": "descending" });
    const manual = await observe(rank, "descending", "う");
    const alias = await setDictionaryAliasInSettings(settings, rank, "Rank alias");
    await showSettingsSection(settings, "lookup");
    await settings.waitForFunction(() => document.getElementById("opt-frequency-order").value === "descending");
    manualSurvived = (await observe(rank, "descending", "う")).revision === manual.revision;
    await settings.bringToFront();
    await settings.click("#opt-frequency-auto");
    await settings.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
    await observe(rank, "ascending", "い");
    await editSettingsControls(settings, { "opt-frequency-dictionary": occurrence });
    await observe(occurrence, "descending", "う");
    const state = await settings.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState);
    metadata = !!alias.settled && state.dictionaries.find((dictionary) => dictionary.title === rank)?.displayName === "Rank alias"
      && fixture.dictionaries.every(({ title, frequencyMode }) =>
        state.dictionaries.find((dictionary) => dictionary.title === title)?.frequencyMode === frequencyMode);
    evidence.push((await status()).generation === generation);
    if (process.env.HACHIDORI_FREQUENCY_SCREENSHOT) {
      await editSettingsControls(settings, { "opt-max-results": original["opt-max-results"] });
      await settings.bringToFront();
      await settings.setViewport({ width: 1280, height: 1000 });
      await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await (await settings.$("#lookup")).screenshot({ path: process.env.HACHIDORI_FREQUENCY_SCREENSHOT });
    }
  } finally {
    if (worker) await restoreMediaReplyProbe(worker);
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
    await editSettingsControls(settings, original);
    for (const title of installed) {
      const removed = await settings.evaluate((title) => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_remove", title,
      }), title);
      if (!removed.ok) throw new Error(removed.error);
    }
    cleaned = (await status()).dictionaryCount === before.dictionaryCount;
    await settings.setViewport(viewport);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
  }
  check("Settings persists frequency directions and applies them to real-WASM lookup results",
    evidence.length === 6 && evidence.every(Boolean) && metadata && manualSurvived && cleaned,
    JSON.stringify({ evidence, metadata, manualSurvived, cleaned }));
}

async function checkPopupMetadata(browser, settings, tab, popup) {
  const controls = ["opt-frequency-names", "opt-frequency-compact", "opt-average-frequency", "opt-pitch-furigana",
    "opt-pitch-dictionary", "opt-pitch-furigana-style", "opt-pitch-badge", "opt-grammar-tags", "opt-popup-width",
    "opt-popup-toolbar"];
  const original = await readSettingsControls(settings, controls);
  const originalAlias = await settings.evaluate(async () => (await chrome.storage.local.get("dictionaryState"))
    .dictionaryState.dictionaries.find(dictionary => dictionary.title === "hachidori-fixture").displayName || "");
  const originalViewport = settings.viewport();
  let worker;
  const evidence = [];
  const counts = () => worker.evaluate(() => ({ lookups: globalThis.__ownedMediaProbe.lookups.length,
    media: globalThis.__ownedMediaProbe.requests.length }));
  const read = () => popup.dictionaryTabs();
  async function expectState(predicate) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await read();
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`metadata did not settle: ${JSON.stringify(await read())}`);
  }
  const expectMetadata = predicate => expectState(value => predicate(value.metadata));
  try {
    await editSettingsControls(settings, { "opt-frequency-names": true, "opt-average-frequency": false,
      "opt-frequency-compact": false,
      "opt-pitch-furigana": true, "opt-pitch-dictionary": "", "opt-pitch-badge": true, "opt-grammar-tags": true,
      "opt-popup-width": "560", "opt-popup-toolbar": "top" });
    await tab.bringToFront();
    await hoverForPopup(tab, popup, "#verb");
    const normal = await expectMetadata(value => value.frequencyNames.length > 0 && value.pitch > 0
      && value.ruby.length > 0 && value.grammar > 0 && value.ipa.includes("tabeɾɯ"));
    evidence.push(normal.rect.width === 560 && !normal.metadata.clippedFrequencies
      && normal.metadata.frequencyTagsUniform && normal.metadata.insidePrimaryEntry && normal.metadata.outsideHeader && normal.metadata.insideResult
      && normal.metadata.plain
      && normal.metadata.separateFromTabStrip && normal.metadata.tabStripOnly);
    await editSettingsControls(settings, { "opt-popup-width": "280", "opt-popup-toolbar": "bottom" });
    const narrow = await expectState(value => value.rect.width === 280 && value.toolbar === "bottom"
      && value.metadata.insideResult);
    evidence.push(!narrow.metadata.clippedFrequencies && narrow.metadata.insidePrimaryEntry
      && narrow.metadata.outsideHeader
      && narrow.metadata.plain && narrow.metadata.separateFromTabStrip && narrow.metadata.tabStripOnly);
    if (process.env.HACHIDORI_METADATA_NARROW_SCREENSHOT) {
      const { x, y, width, height } = narrow.rect;
      await tab.screenshot({
        path: process.env.HACHIDORI_METADATA_NARROW_SCREENSHOT,
        clip: { x, y, width, height },
      });
    }
    await editSettingsControls(settings, { "opt-popup-width": "560", "opt-popup-toolbar": "top" });
    await expectState(value => value.rect.width === 560 && value.toolbar === "top");
    worker = await installMediaReplyProbe(browser, settings);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "Keep the metadata draft" });
    await popup.retainedControls("remember");
    const before = await popup.dictionaryTabs("remember");
    const beforeRequests = await counts();
    // Dispatch native Settings changes without activating its tab: a real
    // tab switch intentionally dismisses a popup through the window blur rule.
    await editSettingsControls(settings, { "opt-frequency-names": false, "opt-pitch-furigana": false,
      "opt-pitch-badge": false, "opt-grammar-tags": false });
    const hidden = await expectMetadata(value => value.frequencyNames.length === 0 && value.pitch === 0
      && value.ruby.length === 0 && value.grammar === 0);
    const plainFurigana = (await popup.state())?.furiganaAlignment;
    await editSettingsControls(settings, { "opt-popup-width": "280", "opt-popup-toolbar": "bottom" });
    const defaultNarrow = await expectState(value => value.rect.width === 280 && value.toolbar === "bottom"
      && value.metadata.frequencyTagsUniform);
    await editSettingsControls(settings, { "opt-popup-width": "560", "opt-popup-toolbar": "top" });
    await expectState(value => value.rect.width === 560 && value.toolbar === "top");
    const retained = await popup.retainedControls();
    evidence.push(hidden.metadata.ipa.includes("tabeɾɯ") && hidden.metadata.definitionTags === before.metadata.definitionTags
      && plainFurigana?.rubyAlign === "center" && plainFurigana.rubies === 1 && plainFurigana.pitchRubies === 0
      && hidden.metadata.frequencyTagsUniform && hidden.metadata.frequencyText.length > 0
      && hidden.metadata.besideLookupCount
      && defaultNarrow.metadata.frequencyTagsUniform && !defaultNarrow.metadata.clippedFrequencies
      && before.metadata.capsuleAria === "Entry metadata"
      && before.metadata.frequencyInsideCapsule && before.metadata.grammarInsideCapsule
      && before.metadata.insidePrimaryEntry && before.metadata.outsideHeader && before.metadata.insideResult
      && before.metadata.plain
      && before.metadata.separateFromTabStrip && before.metadata.tabStripOnly
      && hidden.sameCards && hidden.samePanel && await popup.dictionaryTabs("matches", before.entries)
      && retained.sameForm && retained.mounted && retained.inputFocused && retained.draft === "Keep the metadata draft"
      && JSON.stringify(retained.selection) === "[2,7]");
    // Without names, the fixture's 142位 shows verbatim until abbreviation drops its text.
    await editSettingsControls(settings, { "opt-frequency-compact": true });
    const abbreviated = await expectMetadata(value => value.frequencyText.includes("142")
      && !value.frequencyText.includes("142位"));
    await editSettingsControls(settings, { "opt-frequency-compact": false });
    const unabbreviated = await expectMetadata(value => value.frequencyText.includes("142位"));
    const kept = await popup.retainedControls();
    evidence.push(hidden.metadata.frequencyText.includes("142位") && abbreviated.sameCards && unabbreviated.sameCards
      && kept.sameForm && kept.mounted && kept.draft === "Keep the metadata draft"
      && JSON.stringify(await counts()) === JSON.stringify(beforeRequests));
    await editSettingsControls(settings, { "opt-average-frequency": true });
    const averaged = await expectMetadata(value => value.frequencyNames.includes("Avg frequency"));
    evidence.push(averaged.metadata.frequencies.length > 0 && averaged.metadata.frequencies.every(Number.isFinite)
      && !averaged.metadata.clippedFrequencies && averaged.metadata.frequencyTagsUniform
      && averaged.metadata.hiddenFrequencyDictionaries.includes("hachidori-fixture")
      && normal.metadata.hiddenFrequencyDictionaries.length === 0
      && averaged.sameCards && JSON.stringify(await counts()) === JSON.stringify(beforeRequests));
    await editSettingsControls(settings, { "opt-pitch-furigana": true, "opt-pitch-dictionary": "hachidori-fixture" });
    const contour = await expectMetadata(value => value.ruby.includes("hachidori-fixture") && value.pitch === 0);
    const contourState = await popup.state();
    evidence.push(contour.metadata.grammar === 0 && contour.metadata.ipa.includes("tabeɾɯ")
      && contourState?.furiganaAlignment?.pitchRubies === 2
      && contourState.furiganaAlignment.pitchCentring <= 1 && contourState.furiganaAlignment.contourGap <= 1
      && contourState.furiganaAlignment.contourTopSpread < 0.5 && contourState.furiganaAlignment.baseTextSpread < 0.5
      && contourState.furiganaAlignment.transitions === 2 && contourState.furiganaAlignment.transitionsCoverLines
      && JSON.stringify(await counts()) === JSON.stringify(beforeRequests));
    // 食べる [2] in Overline: one line, over べ, ending in the downstep hook.
    const furiganaStyle = style => expectMetadata(value => value.rubyStyles.length === 2
      && value.rubyStyles.every(current => current === style));
    await editSettingsControls(settings, { "opt-pitch-furigana-style": "overline" });
    const overline = await furiganaStyle("overline");
    const overlineState = (await popup.state())?.furiganaAlignment;
    await editSettingsControls(settings, { "opt-pitch-furigana-style": "contour" });
    const contourAgain = await furiganaStyle("contour");
    const overlineKept = await popup.retainedControls();
    evidence.push(overline.sameCards && contourAgain.sameCards && overline.metadata.ruby.includes("hachidori-fixture")
      && overlineState?.pitchRubies === 2 && overlineState.transitions === 0
      && overlineState.overlines === 1 && overlineState.hooks === 1 && overlineState.overlinesInTextColour
      && overlineState.pitchCentring <= 1 && overlineState.contourGap <= 1
      && overlineState.contourTopSpread < 0.5 && overlineState.baseTextSpread < 0.5
      && overlineKept.sameForm && overlineKept.mounted && overlineKept.draft === "Keep the metadata draft"
      && JSON.stringify(await counts()) === JSON.stringify(beforeRequests));
    if (process.env.HACHIDORI_METADATA_POPUP_SCREENSHOT) {
      await editSettingsControls(settings, { "opt-average-frequency": false });
      await expectMetadata(value => value.frequencyTagsUniform);
      await popup.click(".gsm-hoshidicts-note-cancel");
      const { x, y, width, height } = (await read()).rect;
      await tab.screenshot({ path: process.env.HACHIDORI_METADATA_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    if (process.env.HACHIDORI_METADATA_SETTINGS_SCREENSHOT) {
      await settings.bringToFront();
      await settings.setViewport({ width: 1280, height: 1000 });
      await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await (await settings.$("#lookup")).screenshot({ path: process.env.HACHIDORI_METADATA_SETTINGS_SCREENSHOT });
    }
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await tab.keyboard.press("Escape");
    await setDictionaryAliasInSettings(settings, "hachidori-fixture", "PhoneticsWithoutSpaces".repeat(6));
    await tab.bringToFront();
    await hoverForPopup(tab, popup, "#verb");
    const longSource = await expectMetadata(value => value.ipa.includes("tabeɾɯ") && value.ipaSourceLabels === 0
      && value.ipaTitles.some(title => title.includes("PhoneticsWithoutSpaces".repeat(6))));
    evidence.push(longSource.metadata.ipaFits);
  } finally {
    if (worker) await restoreMediaReplyProbe(worker);
    await editSettingsControls(settings, original);
    await setDictionaryAliasInSettings(settings, "hachidori-fixture", originalAlias);
    await settings.setViewport(originalViewport);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await tab.keyboard.press("Escape");
  }
  check("Live metadata Settings preserve Note and dictionary content while independently controlling frequency pitch grammar and IPA",
    evidence.length === 8 && evidence.every(Boolean), JSON.stringify(evidence));
}

describe("frequency, metadata and audio", () => {
  step("frequency direction", async () => {
    await checkFrequencyDirection(browser, page, tab, popup);
  });

  step("popup metadata", async () => {
    await checkPopupMetadata(browser, page, tab, popup);
  });

  step("popup audio", async () => {
    await checkPopupAudio(page, tab, popup, browser);
    await tab.keyboard.press("Escape");
  });
});
