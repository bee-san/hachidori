/*
 * Popup layout: compact summaries and glossaries, tables, the action row and headers.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./tabs.mjs";
import { describe } from "node:test";
import { ACTION_ROW_CHECK, checkActionRow } from "../chrome-action-row.mjs";
import { AUDIO_CHOOSER_CHECK, checkAudioChooser } from "../chrome-audio-chooser.mjs";
import { checkCompactSummaryLayout } from "../chrome-compact-summary.mjs";
import { checkDynamicHeadword, DYNAMIC_HEADWORD_CHECK } from "../chrome-dynamic-headword.mjs";
import { checkCompactGlossaries, COMPACT_GLOSSARIES_CHECK } from "../chrome-glossary-layout.mjs";
import {
  checkLookupCountLayout,
  LOOKUP_COUNT_LAYOUT_CHECK,
} from "../chrome-lookup-count-layout.mjs";
import { checkStructuredTable, STRUCTURED_TABLE_CHECK } from "../chrome-structured-table.mjs";
import { compactSummaryFixture, makePng } from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import { hoverForPopup, popupReader } from "./popup-reader.mjs";
import { popup, tab } from "./reader.mjs";
import {
  browser,
  editSettingsControls,
  installMediaArchive,
  installMediaReplyProbe,
  page,
  restoreMediaReplyProbe,
  showSettingsSection,
} from "./session.mjs";

async function checkCompactSummaries(settings, tab, popup, browser) {
  const fixture = compactSummaryFixture();
  const original = await settings.evaluate(() => chrome.storage.local.get("options"));
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  const child = await popupReader(tab, 1);
  const installed = [], evidence = {};
  let worker, failure;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function until(read, predicate, label) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const write = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const summaries = () => popup.compactSummaries();
  const show = async query => {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await tab.$eval("#verb", (element, text) => { element.textContent = text; }, query);
    await hoverForPopup(tab, popup, "#verb");
  };
  try {
    for (const dictionary of fixture.dictionaries) {
      await installMediaArchive(settings, dictionary.archive);
      installed.push(dictionary.title);
    }
    evidence.native = await settings.evaluate(async text => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_lookup", text, maxResults: 32, scanLength: 16,
    }), fixture.query);
    require(evidence.native.ok && evidence.native.results.length === 1
      && evidence.native.results[0].term.glossaries[0].glossary === JSON.stringify(fixture.leading), "E10 real native leading glossary");
    await settings.evaluate(async ({ names, favourite }) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: dictionaryState.revision,
        dictionaries: dictionaryState.dictionaries.map(dictionary => ({ ...dictionary,
          displayName: names[dictionary.title] ?? dictionary.displayName,
          favorite: dictionary.title === favourite ? true : dictionary.favorite })),
        groups: dictionaryState.groups });
      if (!reply.ok) throw new Error(reply.error);
    }, {
      names: { [fixture.illustrated]: "Illustrated definitions", [fixture.plain]: "Brief meanings" },
      favourite: fixture.plain,
    });
    await settings.bringToFront();
    await editSettingsControls(settings, { "opt-compact-summary": true, "opt-summary-count": "2",
      "opt-summary-dictionary": fixture.illustrated, "opt-max-results": "32" });
    for (const [id, value] of [["opt-summary-dictionary", ""], ["opt-summary-count", "4"]]) {
      // Hold the established input-before-change draft seam. The input seed is
      // synthetic; external CAS and Chrome's disable/blur behavior are native.
      await settings.$eval(`#${id}`, (control, value) => {
        control.focus(); control.value = value; control.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await write({ showCompactDefinitionSummary: false });
      await settings.waitForFunction(() => !document.getElementById("opt-compact-summary").checked);
      require(await settings.$eval(`#${id}`, (control, value) => document.activeElement === control
        && !control.disabled && control.value === value, value), `E10 external off discarded ${id} draft`);
      await settings.$eval(`#${id}`, control => control.dispatchEvent(new Event("change", { bubbles: true })));
      await settings.waitForFunction(() => document.getElementById("options-status").textContent.includes("Could not save"));
      await settings.$eval(`#${id}`, control => control.blur());
      await settings.click("#options-use-saved");
      require(await settings.$eval(`#${id}`, control => control.disabled), `E10 ${id} did not disable after blur`);
      await editSettingsControls(settings, { "opt-compact-summary": true });
    }
    worker = await installMediaReplyProbe(browser, settings);
    await show(fixture.query);
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.held.length), count => count === 1, "E10 shared held image");
    const initial = await summaries();
    require(equal(initial[0]?.items, ["短い説明", "使い方"]) && initial[0].image.length === 1
      && !initial[0].image[0].src, "E10 text is usable while leading image waits");
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "E10 keeps this exact draft" });
    const draft = await popup.retainedControls("remember");
    await popup.dictionaryTabs("remember");
    await write({ compactDefinitionSummaryDictionary: fixture.plain });
    await until(summaries, value => value[0]?.items[0] === "Alternative first", "E10 live source");
    const controls = await popup.retainedControls(), cards = await popup.dictionaryTabs();
    require(controls.sameForm && controls.mounted && controls.inputFocused && controls.draft === draft.draft
      && equal(controls.selection, [2, 7]) && cards.sameCards && cards.samePanel && cards.sameAnchor, "E10 live source preserves owners");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.held.splice(0)) release(); });
    const loadedCards = await until(() => popup.dictionaryTabs(), value => value.images.length === 1
      && value.images[0].complete && value.images[0].width === 16, "E10 remaining full-card media consumer");
    await write({ compactDefinitionSummaryDictionary: fixture.illustrated, compactDefinitionSummaryCount: 3 });
    const loaded = await until(summaries, value => value[0]?.items.length === 3 && value[0].image[0]?.complete
      && value[0].image[0].width === 16, "E10 cached compact image");
    require(equal(loaded[0].items, ["短い説明", "使い方", "別の意味"])
      && loaded[0].image[0].rect.width === 36 && loaded[0].image[0].rect.height === 36
      && await popup.dictionaryTabs("matches", loadedCards.entries), "E10 compact geometry and unchanged complete definitions");
    const media = await worker.evaluate(() => globalThis.__ownedMediaProbe.requests.filter(request => request.type === "hd_media"));
    const encoded = loaded[0].image[0].src.split(",")[1];
    require(media.length === 1 && media[0].dictionary === fixture.illustrated
      && Buffer.from(encoded, "base64").equals(makePng()), "E10 one shared native media request and exact PNG bytes");
    evidence.sharedMedia = media.length;
    await tab.keyboard.press("Escape");
    await popup.nested("blur");
    const summarySource = await popup.compactSummaryTextRect(fixture.summaryLookup);
    if (summarySource?.rect) {
      await tab.mouse.move(summarySource.rect.x + summarySource.rect.width / 2,
        summarySource.rect.y + summarySource.rect.height / 2);
    }
    const summaryDeadline = Date.now() + 1_000;
    let summaryChild = null;
    while (Date.now() < summaryDeadline) {
      const state = await child.state();
      if (child.visible(state) && state.plain.includes(fixture.summaryLookup)) {
        summaryChild = state;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const summaryDismissed = summaryChild
      ? await child.click(".gsm-hoshidicts-popup-close") && await child.waitForHidden()
      : false;
    evidence.compactLookup = { summarySource, summaryChild, summaryDismissed };
    if (summaryChild && !summaryDismissed) {
      await tab.keyboard.press("Escape");
      await child.waitForHidden();
    }
    if (process.env.HACHIDORI_SUMMARY_POPUP_SCREENSHOT) {
      const { x, y, width, height } = (await popup.dictionaryTabs()).rect;
      await tab.screenshot({ path: process.env.HACHIDORI_SUMMARY_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    await popup.dictionaryTabs("select", `dictionary:${fixture.plain}`);
    await until(summaries, value => equal(value[0]?.items, ["Alternative first", "Alternative second"])
      && value[0].image.length === 0, "E10 tab-local soft fallback");
    await popup.dictionaryTabs("select", "all");
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    // The primary header travels with the toolbar edge, which now follows the
    // child's placement, so summaries are matched by content rather than order.
    const linkedSummary = await until(() => child.compactSummaries(), value => value.length === 1
      && equal(value[0].items, ["Text before the image."])
      && value[0].image.length === 0, "E10 exact child late-image negative");
    const linkedEntries = (await child.dictionaryTabs()).entries;
    require(linkedEntries.length === 1 && linkedEntries[0].expression === fixture.child
      && linkedEntries[0].aria === `${fixture.child}, ようやくご`, "E10 internal link excludes the shorter prefix");
    require(await child.click(".gsm-hoshidicts-popup-close") && await child.waitForHidden(), "E10 child close");

    // Ordinary hover retains the native 要約 prefix. Its second header is
    // appended after the initial result and must use the current source/count.
    await show(fixture.child);
    const deferredSummaries = await until(summaries, value => value.length === 2
      && value.some(summary => equal(summary.items, ["Text before the image."]) && summary.image.length === 0)
      && value.some(summary => summary.dictionary === fixture.illustrated
        && equal(summary.items, ["短い説明", "使い方", "別の意味"])), "E10 deferred hover headers use current preferences");
    const deferredEntries = (await popup.dictionaryTabs()).entries;
    require(equal(deferredEntries.map(entry => [entry.expression, entry.aria]), [
      [fixture.child, `${fixture.child}, ようやくご`], [fixture.query, `${fixture.query}, ようやく`],
    ]), "E10 ordinary hover keeps the genuine prefix result for deferred rendering");
    evidence.deferredHeaders = { linkedSummary, deferredSummaries };

    await show(fixture.broken);
    await until(summaries, value => equal(value[0]?.items, ["The text remains available."])
      && value[0].image.length === 0 && value[0].thumbnailCount === 0, "E10 failed leading image text-only fallback");
    const failedCard = await popup.state();
    require(failedCard.imageStates.length === 1 && failedCard.imageStates[0].state === "load-error"
      && failedCard.imageStates[0].errorVisible && failedCard.plain.includes("The text remains available."),
      "E10 missing thumbnail retains the full-card image error and definition");

    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "Keep the image-source draft" });
    await popup.retainedControls("remember");
    await popup.dictionaryTabs("remember");
    const beforeImageRoute = await worker.evaluate(() => globalThis.__ownedMediaProbe.requests.length);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = true; });
    // Exercise the native chooser without blurring the reader: foregrounding
    // Settings intentionally dismisses the popup via the production blur rule.
    await editSettingsControls(settings, { "opt-image-source": JSON.stringify({ kind: "dictionary", title: fixture.plain }) });
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.held.length), count => count === 1, "E11 shared alternate image");
    require((await summaries())[0]?.thumbnailCount === 1, "E11 failed compact thumbnail did not remount");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.held.splice(0)) release(); });
    const alternate = await until(() => popup.dictionaryTabs(), value => value.images.length === 2
      && value.images.every(image => image.complete && image.width === 16), "E11 alternate bytes decoded");
    const alternateBytes = Buffer.concat([makePng(), Buffer.from([1])]);
    const sourceLabels = (value, title, name) => value.imageSources.length === 2 && value.imageSources.every(label =>
      label.dictionary === title && label.title === title && label.text === `Image: ${name}` && label.outsideThumbnail);
    const routedControls = await popup.retainedControls();
    require(alternate.sameCards && alternate.samePanel && alternate.images[1].same
      && alternate.entries[0].cards.length === 1 && alternate.entries[0].cards[0].dictionary === fixture.illustrated
      && alternate.entries[0].cards[0].text.some(text => text.includes("The text remains available."))
      && equal((await summaries())[0]?.items, ["The text remains available."])
      && alternate.images.every(image => Buffer.from(image.src.split(",")[1], "base64").equals(alternateBytes))
      && sourceLabels(alternate, fixture.plain, "Brief meanings")
      && routedControls.sameForm && routedControls.mounted && routedControls.inputFocused
      && routedControls.draft === "Keep the image-source draft" && equal(routedControls.selection, [2, 7]),
      "E11 alternate provenance/bytes changed the text or mounted Note/image owners");
    const imageRouteRequests = await worker.evaluate(start => globalThis.__ownedMediaProbe.requests.slice(start), beforeImageRoute);
    require(imageRouteRequests.length === 1 && imageRouteRequests[0].type === "hd_media"
      && imageRouteRequests[0].dictionary === fixture.plain && imageRouteRequests[0].path === "media/missing.png",
      "E11 alternate thumbnail/full-card request was not shared");
    await settings.evaluate(async ({ illustrated, plain }) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: dictionaryState.revision,
        dictionaries: dictionaryState.dictionaries.map(dictionary => dictionary.title === plain
          ? { ...dictionary, displayName: "Alternate illustrations" } : dictionary),
        groups: [...dictionaryState.groups, { id: "e11-images", name: "Illustrations",
          dictionaryIds: [illustrated, plain].map(title => dictionaryState.dictionaries.find(dictionary => dictionary.title === title).id) }],
      });
      if (!reply.ok) throw new Error(reply.error);
    }, fixture);
    const aliased = await until(() => popup.dictionaryTabs(), value => sourceLabels(value, fixture.plain, "Alternate illustrations"), "E11 live supplier alias");
    require(aliased.sameCards && aliased.entries[0].cards[0].text.some(text => text.includes("The text remains available."))
      && equal((await summaries())[0]?.items, ["The text remains available."]), "E11 alias discarded definition text");
    require(await worker.evaluate(() => globalThis.__ownedMediaProbe.requests.length) === beforeImageRoute + 1,
      "E11 alias/group-name presentation refetched content");
    const beforeGroupRoute = await worker.evaluate(() => globalThis.__ownedMediaProbe.requests.length);
    await write({ popupImageSource: { kind: "tabGroup", id: "e11-images" } });
    await until(() => worker.evaluate(start => globalThis.__ownedMediaProbe.requests.slice(start), beforeGroupRoute),
      requests => requests.some(request => request.type === "hd_media" && request.dictionary === fixture.illustrated
        && request.path === "media/missing.png"), "E11 group route adopted before output comparison");
    await until(() => popup.dictionaryTabs(), value => !value.hidden && value.images.length === 2
      && value.images.every(image => image.complete && image.width === 16)
      && sourceLabels(value, fixture.plain, "Alternate illustrations"), "E11 group fallback to alternate");
    const groupRequests = await worker.evaluate(start => globalThis.__ownedMediaProbe.requests.slice(start), beforeGroupRoute);
    require(groupRequests.length === 1 && groupRequests[0].type === "hd_media"
      && groupRequests[0].dictionary === fixture.illustrated && groupRequests[0].path === "media/missing.png",
      "E11 ordered group did not reuse its successful alternate cache entry");
    if (process.env.HACHIDORI_IMAGE_SOURCE_POPUP_SCREENSHOT) {
      await tab.keyboard.press("Escape");
      const { x, y, width, height } = (await popup.dictionaryTabs()).rect;
      await tab.screenshot({ path: process.env.HACHIDORI_IMAGE_SOURCE_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    if (process.env.HACHIDORI_IMAGE_SOURCE_SETTINGS_SCREENSHOT || process.env.HACHIDORI_IMAGE_SOURCE_SETTINGS_DARK_SCREENSHOT) {
      await settings.bringToFront();
      await showSettingsSection(settings, "lookup");
      for (const [scheme, path] of [["light", process.env.HACHIDORI_IMAGE_SOURCE_SETTINGS_SCREENSHOT],
        ["dark", process.env.HACHIDORI_IMAGE_SOURCE_SETTINGS_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await (await settings.$("#lookup")).screenshot({ path });
      }
    }
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await show(fixture.query);
    const groupOriginal = await until(() => popup.dictionaryTabs(), value => value.images.length === 2
      && value.images.every(image => image.complete && image.width === 16), "E11 group first supplier for another path");
    require(groupOriginal.imageSources.length === 0
      && groupOriginal.images.every(image => Buffer.from(image.src.split(",")[1], "base64").equals(makePng())),
      "E11 group incorrectly retained one global supplier across paths");
    await popup.dictionaryTabs("remember");
    // These 16px fixture images are inline glyphs to the default "large"
    // preview mode; preview every image while checking preview refresh.
    await write({ imageHoverPreview: "all" });
    await until(async () => {
      await popup.imagePreview(1, "blur");
      return popup.imagePreview(1, "focus");
    }, value => value.focusedImage === 1 && value.preview !== null, "E11 the reader adopted the all-images preview mode");
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = true; });
    await write({ popupImageSource: { kind: "dictionary", title: fixture.plain } });
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.held.length), count => count === 1, "E11 focused alternate image");
    const focusedPending = await until(() => popup.imagePreview(1),
      value => value.focusedImage === 1 && value.preview === null,
      "E11 changing the image URL preserves focus and clears stale preview bytes");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.held.splice(0)) release(); });
    const focusedLoaded = await until(() => popup.imagePreview(1), value => value.focusedImage === 1
      && value.preview?.width === 16, "E11 focused alternate preview resumes");
    require(Buffer.from(focusedLoaded.preview.source.split(",")[1], "base64").equals(alternateBytes)
      && (await popup.dictionaryTabs()).images.every(image => image.same), "E11 focused source refresh replaced its image owners");
    await write({ popupImageSource: { kind: "dictionary", title: "Unavailable E11 image source" } });
    const focusedFailure = await until(() => popup.imagePreview(0), value => value.images.length === 1
      && value.images[0].href === null && value.preview === null, "E11 focused source failure");
    require(focusedFailure.focusedImage === 0 && focusedFailure.images[0].tabStop === "0",
      "E11 pending/failing route discarded deliberate keyboard focus");
    const blurredFailure = await popup.imagePreview(0, "blur");
    require(blurredFailure.images[0].tabStop === null, "E11 failed image retained a noninteractive tab stop after blur");
    await write({ popupImageSource: null });
    await write({ imageHoverPreview: "large" });
    await until(() => popup.dictionaryTabs(), value => !value.hidden && value.images.length === 2 && value.imageSources.length === 0
      && value.images[1].same
      && value.images.every(image => image.complete && Buffer.from(image.src.split(",")[1], "base64").equals(makePng())),
      "E11 Automatic restores original images without alternate provenance");
    evidence.imageSources = { shared: imageRouteRequests, groupFallback: groupRequests, focused: focusedPending.focusedImage };
    await tab.keyboard.press("Escape");
    await tab.$eval("#verb", (element, text) => { element.textContent = text; }, fixture.query);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
    const pendingHover = hoverForPopup(tab, popup, "#verb");
    try {
      await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.heldLookups.length), count => count === 1, "E10 held valid lookup");
      await write({ compactDefinitionSummaryDictionary: fixture.plain, compactDefinitionSummaryCount: 1 });
    } finally {
      await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.heldLookups.splice(0)) release(); });
      await pendingHover;
    }
    await until(summaries, value => equal(value[0]?.items, ["Alternative first"]), "E10 pending lookup adopts latest summary options");
    const status = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
    require(status.generation === evidence.native.generation, "E10 presentation reloaded the engine");
    if (process.env.HACHIDORI_SUMMARY_SETTINGS_SCREENSHOT || process.env.HACHIDORI_SUMMARY_SETTINGS_DARK_SCREENSHOT) {
      await settings.bringToFront();
      await showSettingsSection(settings, "lookup");
      await editSettingsControls(settings, { "opt-summary-count": "3", "opt-summary-dictionary": fixture.illustrated });
      for (const [scheme, path] of [["light", process.env.HACHIDORI_SUMMARY_SETTINGS_SCREENSHOT],
        ["dark", process.env.HACHIDORI_SUMMARY_SETTINGS_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await (await settings.$("#lookup")).screenshot({ path });
      }
    }
    evidence.passed = true;
  } catch (error) {
    failure = error;
  } finally {
    const errors = [];
    const clean = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    if (worker) await clean(() => restoreMediaReplyProbe(worker));
    await clean(() => popup.dictionaryTabs("cleanup"));
    await clean(() => child.dictionaryTabs("cleanup"));
    await clean(() => write({ maxResults: original.options.maxResults,
      popupImageSource: original.options.popupImageSource ?? null,
      showCompactDefinitionSummary: original.options.showCompactDefinitionSummary ?? false,
      compactDefinitionSummaryCount: original.options.compactDefinitionSummaryCount ?? 2,
      compactDefinitionSummaryDictionary: original.options.compactDefinitionSummaryDictionary ?? "" }));
    await clean(() => settings.evaluate(async () => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: dictionaryState.revision, dictionaries: dictionaryState.dictionaries,
        groups: dictionaryState.groups.filter(group => group.id !== "e11-images") });
      if (!reply.ok) throw new Error(reply.error);
    }));
    for (const title of installed) await clean(async () => {
      const reply = await settings.evaluate(title => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_remove", title }), title);
      if (!reply.ok) throw new Error(reply.error);
    });
    await clean(() => tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb));
    await clean(() => settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]));
    await clean(async () => {
      await tab.bringToFront();
      for (let index = 0; index < 4 && !(await popup.waitForHidden(1)); index++) await tab.keyboard.press("Escape");
      require(await popup.waitForHidden(), "E10 cleanup retained a popup");
    });
    if (errors.length) failure = new AggregateError(failure ? [failure, ...errors] : errors, "E10 scenario/cleanup failure");
  }
  if (failure) throw failure;
  check("Compact summaries persist Settings, share leading media and update live without replacing definitions or Note drafts",
    evidence.passed && evidence.sharedMedia === 1, JSON.stringify(evidence));
  check("compact definition text opens a nested lookup with the same close contract",
    evidence.compactLookup.summarySource?.text === fixture.summaryLookup[0]
      && evidence.compactLookup.summaryChild?.closeControl?.label === "Close lookup"
      && evidence.compactLookup.summaryChild.closeControl.text === ""
      && evidence.compactLookup.summaryDismissed, JSON.stringify(evidence.compactLookup));
  check("Live image sources recover missing thumbnails, preserve owners and resolve groups per path with accurate aliases",
    evidence.passed && evidence.imageSources?.focused === 1, JSON.stringify(evidence.imageSources));
}

describe("popup layout", () => {
  step("compact summary layout", async () => {
    await checkCompactSummaryLayout(browser);
    check("Compact summaries wrap without clipping and retain narrow toolbar access", true);
  });

  step("compact glossaries", async () => {
    await checkCompactGlossaries(browser);
    check(COMPACT_GLOSSARIES_CHECK, true);
  });

  step("structured tables", async () => {
    await checkStructuredTable(browser);
    check(STRUCTURED_TABLE_CHECK, true);
  });

  step("the action row", async () => {
    await checkActionRow(browser);
    check(ACTION_ROW_CHECK, true);
  });

  step("the dynamic headword", async () => {
    await checkDynamicHeadword(browser, { screenshotDirectory: process.env.HACHIDORI_DYNAMIC_HEADWORD_SCREENSHOTS });
    check(DYNAMIC_HEADWORD_CHECK, true);
  });

  step("the lookup count layout", async () => {
    await checkLookupCountLayout(browser);
    check(LOOKUP_COUNT_LAYOUT_CHECK, true);
  });

  step("the audio chooser", async () => {
    await checkAudioChooser(browser, { screenshotDirectory: process.env.HACHIDORI_AUDIO_CHOOSER_SCREENSHOTS });
    check(AUDIO_CHOOSER_CHECK, true);
  });

  step("compact summaries", async () => {
    await checkCompactSummaries(page, tab, popup, browser);
  });
});
