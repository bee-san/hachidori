/*
 * Activation keys, selections and the source-highlight fallback.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./layout.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe } from "node:test";
import { buildTitledZip } from "../make-fixture.mjs";
import { check, HIGHLIGHT_NAME, step } from "./harness.mjs";
import { forceSourceFallback, hoverForPopup, popupReader } from "./popup-reader.mjs";
import { popup, tab } from "./reader.mjs";
import {
  activeExtensionWorker,
  browser,
  editSettingsControls,
  installMediaArchive,
  installMediaReplyProbe,
  page,
  readSettingsControls,
  restoreMediaReplyProbe,
} from "./session.mjs";

async function checkReaderActivation(settings, tab, popup) {
  const original = await readSettingsControls(settings, [
    "opt-hover-enabled", "opt-activation-key", "opt-lookup-sticky", "opt-hide-delay", "opt-hide-on-cursor-exit",
    "opt-definition-lookup-mode",
  ]);
  const edit = (values) => editSettingsControls(settings, values);
  const pause = (ms) => tab.evaluate((delay) => new Promise((resolveWait) => setTimeout(resolveWait, delay)), ms);
  const position = await (await tab.$("#verb")).boundingBox();
  const moveToWord = async () => {
    await tab.mouse.move(2, 2);
    await tab.mouse.move(position.x + position.width * 0.15, position.y + position.height / 2);
  };
  const generation = async () => settings.evaluate(async () =>
    (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" })).generation);
  const beforeGeneration = await generation();
  try {
    const opened = await hoverForPopup(tab, popup, "#verb");
    await edit({ "opt-hover-enabled": false });
    const closed = await popup.waitForHidden();
    await moveToWord();
    await pause(250);
    const disabled = !popup.visible(await popup.state());
    await edit({ "opt-hover-enabled": true });
    const reopened = await hoverForPopup(tab, popup, "#verb");
    check("hover enablement closes active popups and changes already-open tabs without reloading the engine",
      opened !== null && closed && disabled && reopened !== null && await generation() === beforeGeneration,
      JSON.stringify({ closed, disabled, reopened: reopened !== null }));

    await edit({ "opt-activation-key": "K", "opt-lookup-sticky": false, "opt-hide-delay": "400",
      "opt-definition-lookup-mode": "click" });
    await popup.waitForHidden();
    await moveToWord();
    await pause(250);
    const gated = !popup.visible(await popup.state());
    await tab.keyboard.down("k");
    await pause(30);
    const activated = await popup.waitForVisible();
    await tab.keyboard.up("k");
    const retained = popup.visible(await popup.state());
    const released = await popup.waitForHidden();
    await tab.keyboard.down("k");
    await tab.keyboard.up("k");
    await pause(300);
    const cancelled = !popup.visible(await popup.state());
    const activationControls = () => settings.evaluate(async () => {
      const { lookupMode, activationKey, definitionLookupMode } =
        HDReaderOptions.normaliseOptions((await chrome.storage.local.get("options")).options);
      return {
        key: document.getElementById("opt-activation-key").value,
        disabled: document.getElementById("opt-activation-key").disabled,
        sticky: document.getElementById("opt-lookup-sticky").checked,
        stickyHidden: document.getElementById("opt-lookup-sticky-row").hidden,
        stored: [lookupMode, activationKey],
        childPopups: document.getElementById("opt-definition-lookup-mode").value,
        keyChoice: document.querySelector('#opt-definition-lookup-mode option[value="activation"]').textContent,
        storedChildPopups: definitionLookupMode,
      };
    });
    const controls = await activationControls();
    check("configured activation keys open stationary lookups and release them using the saved delays",
      gated && activated !== null && retained && released && cancelled
        && JSON.stringify(controls.stored) === JSON.stringify(["activation", "K"])
        && controls.key === "K" && !controls.sticky && !controls.stickyHidden && !controls.disabled
        && controls.childPopups === "click" && controls.storedChildPopups === "click" && controls.keyChoice === "Hold K",
      JSON.stringify({ gated, activated: activated !== null, retained, released, cancelled, controls }));

    await edit({ "opt-activation-key": "" });
    const noKey = await activationControls();
    const hovered = await hoverForPopup(tab, popup, "#verb");
    await edit({ "opt-activation-key": "K" });
    const keyAgain = await activationControls();
    await edit({ "opt-lookup-sticky": false });
    const closing = await activationControls();
    // Arrowing through No key back to the key, before either save lands, still
    // returns the key with the popup staying open.
    await settings.evaluate(() => {
      const picker = document.getElementById("opt-activation-key");
      for (const value of ["", "K"]) {
        picker.value = value;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await settings.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
      { polling: 100, timeout: 10_000 });
    const arrowed = await activationControls();
    check("No key looks up on hover and keeps the remembered key, which returns with the popup staying open",
      JSON.stringify([noKey.stored, keyAgain.stored, closing.stored, arrowed.stored]) === JSON.stringify(
        [["hover", "K"], ["activationSticky", "K"], ["activation", "K"], ["activationSticky", "K"]])
        && noKey.key === "" && noKey.stickyHidden && hovered !== null
        && keyAgain.key === "K" && keyAgain.sticky && !keyAgain.stickyHidden && !closing.sticky
        && arrowed.key === "K" && arrowed.sticky && !arrowed.stickyHidden,
      JSON.stringify({ noKey, hovered: hovered !== null, keyAgain, closing, arrowed }));

    // Issue #502: the same quick pass across the word, counted at the worker's
    // engine relay, looks its glyphs up with No key alone and nothing once a
    // hover scan delay is set; resting on the word then looks it up once.
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    const relay = await activeExtensionWorker(tab.browser(), settings, "hover scan delay relay");
    await relay.evaluate(() => {
      const probe = { original: chrome.runtime.sendMessage, lookups: 0 };
      globalThis.__hoverScanDelayRelay = probe;
      chrome.runtime.sendMessage = function (message, ...args) {
        if (message?.relayed && message.type === "hd_lookup") probe.lookups += 1;
        return probe.original.call(this, message, ...args);
      };
    });
    const relayed = () => relay.evaluate(() => globalThis.__hoverScanDelayRelay.lookups);
    const pass = async () => {
      const before = await relayed();
      // Glyph centres, from the blank before the word to the blank after it.
      for (let step = 0; step <= 8; step += 1) {
        await tab.mouse.move(position.x + position.width * (2 * step - 1) / 12, position.y + position.height / 2);
        await pause(40);
      }
      await pause(900);
      return (await relayed()) - before;
    };
    try {
      await edit({ "opt-activation-key": "" });
      const immediatePass = await pass();
      await edit({ "opt-scan-delay": "700" });
      const delayedPass = await pass();
      const quiet = !popup.visible(await popup.state());
      const before = await relayed();
      await moveToWord();
      await pause(250);
      const waiting = !popup.visible(await popup.state()) && await relayed() === before;
      const rested = await popup.waitForVisible();
      await pause(300);
      const lookedUp = (await relayed()) - before;
      check("a hover scan delay keeps a quick pass across a word from looking anything up and looks up the word the pointer rests on once",
        immediatePass > 1 && delayedPass === 0 && quiet && waiting && rested?.plain.includes("食べる") === true
          && lookedUp === 1,
        JSON.stringify({ immediatePass, delayedPass, quiet, waiting, rested: rested !== null, lookedUp }));
    } finally {
      await relay.evaluate(() => {
        chrome.runtime.sendMessage = globalThis.__hoverScanDelayRelay.original;
        delete globalThis.__hoverScanDelayRelay;
      });
      await relay.detach?.();
      await edit({ "opt-scan-delay": "0", "opt-activation-key": "K" });
      await tab.keyboard.press("Escape");
    }

    // Issue #363: Hide popup on cursor exit keeps a sticky popup through key
    // release until the pointer has been inside it and left. The focus a mouse
    // click leaves on a popup button does not keep it; keyboard focus does.
    await edit({ "opt-activation-key": "Shift", "opt-lookup-sticky": true,
      "opt-hide-on-cursor-exit": true, "opt-hide-on-cursor-exit-delay": "300" });
    const openSticky = async () => {
      await moveToWord();
      await tab.keyboard.down("Shift");
      const shown = await popup.waitForVisible();
      await tab.keyboard.up("Shift");
      return shown;
    };
    const clickAudio = async () => {
      const box = (await popup.audio())?.buttonRect;
      if (box) await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return (await popup.state()).focusedClass;
    };
    const stickyOpened = await openSticky();
    await tab.mouse.move(2, 2);
    await pause(600);
    const neverEntered = popup.visible(await popup.state());
    const clickFocus = await clickAudio();
    await tab.mouse.move(2, 2);
    const clickedHidden = await popup.waitForHidden(3000);
    await openSticky();
    await clickAudio();
    await tab.keyboard.press("Tab");
    const keyboardFocus = (await popup.state()).focusedClass;
    await tab.mouse.move(2, 2);
    await pause(600);
    const keyboardKept = popup.visible(await popup.state());
    await tab.keyboard.press("Escape");
    check("hide popup on cursor exit hides a sticky popup the pointer left despite mouse focus, but not keyboard focus",
      stickyOpened !== null && neverEntered && clickFocus.includes("gsm-hoshidicts-audio-button") && clickedHidden
        && keyboardFocus !== "" && !keyboardFocus.includes("gsm-hoshidicts-audio-button") && keyboardKept,
      JSON.stringify({ stickyOpened: stickyOpened !== null, neverEntered, clickFocus, clickedHidden, keyboardFocus, keyboardKept }));

    // The scan buttons below close on release, as the K key did above, and
    // cursor exit stays off so only activation release hides their popups.
    await edit({ "opt-lookup-sticky": false, "opt-hide-on-cursor-exit": false });
    // Issue #357: set the middle button by pressing it, then scan by holding it.
    await settings.bringToFront();
    await settings.click("#opt-activation-record");
    await settings.mouse.down({ button: "middle" });
    await settings.mouse.up({ button: "middle" });
    await settings.waitForFunction(() => document.getElementById("opt-activation-key").value === "MouseMiddle"
      && document.getElementById("options-status").textContent === "Saved.", { polling: 100, timeout: 10_000 });
    const recorded = await settings.evaluate(async () => ({
      label: document.getElementById("opt-activation-record").textContent,
      stored: (await chrome.storage.local.get("options")).options.activationKey,
    }));
    await tab.bringToFront();
    await moveToWord();
    await pause(250);
    const buttonGated = !popup.visible(await popup.state());
    await tab.mouse.down({ button: "middle" });
    const buttonActivated = await popup.waitForVisible();
    await tab.mouse.up({ button: "middle" });
    const buttonReleased = await popup.waitForHidden();
    check("Press to set records the middle button, which opens a stationary lookup and releases it like a key",
      recorded.stored === "MouseMiddle" && recorded.label === "Press to set" && buttonGated
        && buttonActivated?.plain.includes("食べる") === true && buttonReleased,
      JSON.stringify({ recorded, buttonGated, buttonActivated: buttonActivated !== null, buttonReleased }));

    await tab.evaluate(() => {
      const links = document.createElement("div");
      links.id = "scan-button-links";
      for (const [id, text] of [["scan-button-ascii", "dictionary"], ["scan-button-japanese", "食べた"]]) {
        const paragraph = document.createElement("p");
        const link = document.createElement("a");
        link.id = id;
        link.href = `/${id}`;
        link.textContent = text;
        paragraph.append(link);
        // The scan reads across elements, so blocks keep their whitespace.
        links.append(paragraph, "\n");
      }
      document.body.prepend(links);
    });
    const middleClick = async (selector, whileHeld = async () => null) => {
      const box = await (await tab.$(selector)).boundingBox();
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await tab.mouse.down({ button: "middle" });
      const held = await whileHeld();
      await tab.mouse.up({ button: "middle" });
      return held;
    };
    const openedTabs = [];
    const onTarget = target => { if (target.type() === "page") openedTabs.push(target); };
    tab.browser().on("targetcreated", onTarget);
    try {
      await Promise.all([
        tab.browser().waitForTarget(target => target.url().endsWith("/scan-button-ascii"), { timeout: 10_000 }),
        middleClick("#scan-button-ascii"),
      ]);
      // Activation mode drops a lookup released before it answers, as for a key.
      const linkLookup = await middleClick("#scan-button-japanese", () => popup.waitForVisible());
      await popup.waitForHidden();
      await pause(500);
      const urls = openedTabs.map(target => target.url());
      check("a middle scan press on a Japanese link looks it up without a new tab while other links still open",
        linkLookup !== null && urls.length === 1 && urls[0].endsWith("/scan-button-ascii"),
        JSON.stringify({ linkLookup: linkLookup !== null, urls }));
    } finally {
      tab.browser().off("targetcreated", onTarget);
      for (const target of openedTabs) {
        const page = await target.page();
        if (page && !page.isClosed()) await page.close();
      }
      await tab.evaluate(() => document.getElementById("scan-button-links").remove());
    }

    await edit({ "opt-activation-key": "MouseBack" });
    await tab.evaluate(() => {
      window.__scanButtonPops = 0;
      window.addEventListener("popstate", () => { window.__scanButtonPops += 1; });
      history.pushState({ scanButton: true }, "", location.href);
    });
    await moveToWord();
    await tab.mouse.down({ button: "back" });
    const backActivated = await popup.waitForVisible();
    await tab.mouse.up({ button: "back" });
    await popup.waitForHidden();
    await pause(300);
    const onWord = await tab.evaluate(() => ({ pops: window.__scanButtonPops, state: history.state }));
    // A word in a text field is looked up the same way (#425).
    await tab.evaluate(() => {
      const field = document.createElement("input");
      field.id = "scan-button-word";
      field.value = "食べたかった";
      field.style.cssText = "font: 20px/1 serif; padding: 4px; border: 1px solid";
      document.body.prepend(field);
    });
    const wordField = await (await tab.$("#scan-button-word")).boundingBox();
    await tab.mouse.move(2, 2);
    await tab.mouse.move(wordField.x + 15, wordField.y + 15);
    await tab.mouse.down({ button: "back" });
    const fieldActivated = await popup.waitForVisible();
    await tab.mouse.up({ button: "back" });
    await popup.waitForHidden();
    await pause(300);
    const onFieldWord = await tab.evaluate(() => {
      document.getElementById("scan-button-word").remove();
      return { pops: window.__scanButtonPops, state: history.state };
    });
    // Over an empty field the same press is not cancelled, so Chrome still
    // goes back, which also drops the entry pushed above.
    await tab.evaluate(() => {
      const field = document.createElement("input");
      field.id = "scan-button-field";
      document.body.prepend(field);
    });
    const field = await (await tab.$("#scan-button-field")).boundingBox();
    await tab.mouse.move(field.x + 5, field.y + field.height / 2);
    await tab.mouse.down({ button: "back" });
    await tab.mouse.up({ button: "back" });
    const deadline = Date.now() + 5000;
    let offText = await tab.evaluate(() => ({ pops: window.__scanButtonPops, state: history.state }));
    while (offText.pops === 0 && Date.now() < deadline) {
      await pause(100);
      offText = await tab.evaluate(() => ({ pops: window.__scanButtonPops, state: history.state }));
    }
    await tab.evaluate(() => document.getElementById("scan-button-field").remove());
    check("a Back scan press on a word, in page text or a text field, looks it up without going back, while one on an empty field still does",
      backActivated !== null && onWord.pops === 0 && onWord.state?.scanButton === true
        && fieldActivated?.plain.includes("食べる") === true && onFieldWord.pops === 0
        && onFieldWord.state?.scanButton === true
        && offText.pops === 1 && offText.state?.scanButton !== true,
      JSON.stringify({ backActivated: backActivated !== null, onWord, fieldActivated: fieldActivated !== null,
        onFieldWord, offText }));
  } finally {
    await tab.keyboard.up("k");
    for (const button of ["middle", "back"]) await tab.mouse.up({ button }).catch(() => {});
    // Keep a non-default key behind No key to prove that choosing No key
    // preserves it and that the exact setting survives the full browser restart.
    // The cursor-exit delay likewise stays at 300 ms with its switch off, and
    // child popups keep a non-default Click trigger through the restart.
    await edit({ "opt-activation-key": "K" });
    await edit({ ...original, "opt-definition-lookup-mode": "click" });
    await tab.keyboard.press("Escape");
  }
}

async function checkReaderSelection(browser, settings, tab, popup) {
  const original = await readSettingsControls(settings, [
    "opt-activation-key", "opt-lookup-sticky", "opt-scan-length", "opt-japanese-only", "opt-personal-dictionary",
    "opt-no-result-notice",
  ]);
  // No key does not show the key it remembers, so the restore chooses it first.
  const rememberedKey = await settings.evaluate(async () =>
    HDReaderOptions.normaliseOptions((await chrome.storage.local.get("options")).options).activationKey);
  const originalVerb = await tab.$eval("#verb", (element) => element.innerHTML);
  const worker = await installMediaReplyProbe(browser, settings);
  await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
  const lookups = () => worker.evaluate(() => globalThis.__ownedMediaProbe.lookups);
  const pause = () => tab.evaluate(() => new Promise((done) => setTimeout(done, 200)));
  const dismiss = async () => {
    await tab.keyboard.press("Escape");
    await tab.evaluate(() => {
      document.activeElement?.blur();
      window.getSelection().removeAllRanges();
    });
    await tab.mouse.move(2, 2);
    await pause();
  };
  const selectVerb = async (html, heldKeys = []) => {
    await dismiss();
    for (const key of heldKeys) await tab.keyboard.down(key);
    try {
      const selection = await tab.$eval("#verb", (element, contents) => {
        element.innerHTML = contents;
        const selection = window.getSelection();
        selection.selectAllChildren(element);
        return { visible: selection.toString(), raw: selection.getRangeAt(0).toString() };
      }, html);
      if (heldKeys.length > 0) await popup.waitForVisible();
      return selection;
    } finally {
      for (const key of heldKeys.toReversed()) await tab.keyboard.up(key);
    }
  };
  const moveTo = async (selector) => {
    const box = await (await tab.$(selector)).boundingBox();
    await tab.mouse.move(2, 2);
    await tab.mouse.move(box.x + 4, box.y + box.height / 2);
    await pause();
  };
  try {
    await editSettingsControls(settings, {
      "opt-activation-key": "", "opt-japanese-only": true, "opt-no-result-notice": true,
    });
    // A fresh page has no reader host until its first lookup, so an English
    // selection there proves the gate by leaving the DOM alone; a Japanese
    // selection on the same page then proves the reader was live all along.
    const fresh = await browser.newPage();
    let englishIgnored, freshHit;
    try {
      await fresh.goto(tab.url(), { waitUntil: "load" });
      await fresh.bringToFront();
      const cdp = await fresh.createCDPSession();
      const contexts = new Set();
      cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.add(context.id));
      cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => contexts.delete(executionContextId));
      await cdp.send("Runtime.enable");
      const extensionId = new URL(settings.url()).host;
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        for (const contextId of contexts) {
          const { result } = await cdp.send("Runtime.evaluate", { contextId, awaitPromise: true,
            expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}
              && globalThis.HDReaderReady?.then(() => true)` });
          ready ||= result.value === true;
        }
        if (!ready) await new Promise(done => setTimeout(done, 100));
      }
      await cdp.detach();
      if (!ready) throw new Error("the fresh page's reader did not become ready");
      const selectFresh = (text) => fresh.$eval("#verb", (element, contents) => {
        element.textContent = contents;
        window.getSelection().selectAllChildren(element);
      }, text);
      const before = (await lookups()).length;
      await selectFresh("hello world");
      await fresh.evaluate(() => new Promise(done => setTimeout(done, 250)));
      englishIgnored = (await lookups()).length === before && await fresh.$("hachidori-host") === null;
      await selectFresh("食べる");
      freshHit = (await (await popupReader(fresh)).waitForVisible())?.plain;
    } finally { await fresh.close(); }
    await tab.bringToFront();
    await selectVerb("ぬるぽがっ");
    const defaultNotice = (await popup.waitForVisible())?.plain;
    await editSettingsControls(settings, { "opt-no-result-notice": false });
    await tab.bringToFront();
    const hiddenStart = (await lookups()).length;
    await selectVerb("ぬるぽがっ");
    for (let attempt = 0; attempt < 50 && (await lookups()).length === hiddenStart; attempt++) await pause();
    await pause();
    const hiddenMiss = !popup.visible(await popup.state()) && (await lookups()).at(-1)?.text === "ぬるぽがっ";
    await selectVerb("食べる");
    const hit = (await popup.waitForVisible())?.plain;
    await editSettingsControls(settings, { "opt-no-result-notice": true });
    if (process.env.HACHIDORI_SELECTION_SETTINGS_SCREENSHOT) {
      await settings.bringToFront();
      await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      const controls = await settings.$("#selection-notice-settings");
      await controls.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await settings.evaluate(() => new Promise(requestAnimationFrame));
      await controls.screenshot({ path: process.env.HACHIDORI_SELECTION_SETTINGS_SCREENSHOT });
    }
    await tab.bringToFront();
    await selectVerb("ぬるぽがっ");
    const restoredNotice = (await popup.waitForVisible())?.plain;
    check("Japanese-only selections leave English text alone and the notice setting propagates to open readers",
      englishIgnored && freshHit?.includes("食べる") && defaultNotice?.includes("No definition found.")
        && hiddenMiss && hit?.includes("食べる") && restoredNotice?.includes("No definition found."),
      JSON.stringify({ englishIgnored, freshHit, defaultNotice, hiddenMiss, hit, restoredNotice }));

    // Issue #358: with the personal dictionary off a highlight is just a
    // highlight, while hovering still looks up with the configured scan length.
    // The personal entry saved in Settings (気になる) is left out until it is on.
    const scanLength = Number((await readSettingsControls(settings, ["opt-scan-length"]))["opt-scan-length"]);
    const stateRevision = () => settings.evaluate(async () =>
      (await chrome.storage.local.get("dictionaryState")).dictionaryState?.revision);
    const hoverPersonal = async (expectPopup) => {
      await dismiss();
      await tab.$eval("#verb", (element) => { element.textContent = "気になる"; });
      const before = (await lookups()).length;
      await moveTo("#verb");
      if (expectPopup) return (await popup.waitForVisible())?.plain ?? "";
      for (let attempt = 0; attempt < 50 && (await lookups()).length === before; attempt++) await pause();
      await pause();
      await pause();
      const state = await popup.state();
      return popup.visible(state) ? state.plain : "";
    };
    const revisionBefore = await stateRevision();
    const personalOn = await hoverPersonal(true);
    await editSettingsControls(settings, { "opt-personal-dictionary": false });
    await tab.bringToFront();
    const offStart = (await lookups()).length;
    await selectVerb("ぬるぽがっ");
    await pause();
    await selectVerb("食べる");
    await pause();
    const offSelections = (await lookups()).slice(offStart).map(({ text }) => text);
    const offSelectionHidden = !popup.visible(await popup.state());
    await moveTo("#verb");
    const offHover = await popup.waitForVisible();
    const offHoverRequest = (await lookups()).slice(offStart)[0];
    const offSelected = await tab.evaluate(() => window.getSelection().toString());
    const personalOff = await hoverPersonal(false);
    await editSettingsControls(settings, { "opt-personal-dictionary": true });
    await tab.bringToFront();
    const personalRestored = await hoverPersonal(true);
    await selectVerb("ぬるぽがっ");
    const noticeRestored = await popup.waitForVisible();
    const revisionAfter = await stateRevision();
    check("turning off the personal dictionary stops highlight lookups, the pencil and personal entries until it is on",
      personalOn.includes("to catch one's attention") && offSelections.length === 0 && offSelectionHidden
        && offHover?.plain.includes("食べる") && offHover.noteButtonDisplay === "none" && offSelected === "食べる"
        && offHoverRequest?.text === "食べる" && offHoverRequest.scanLength === scanLength && scanLength !== 3
        && offHoverRequest.options?.personalDictionary === false
        && !personalOff.includes("to catch one's attention")
        && personalRestored.includes("to catch one's attention")
        && noticeRestored?.plain.includes("No definition found.")
        && ![null, "none"].includes(noticeRestored.noteButtonDisplay)
        && Number.isInteger(revisionBefore) && revisionAfter === revisionBefore,
      JSON.stringify({ personalOn, offSelections, offSelectionHidden, offHover, offHoverRequest, offSelected,
        scanLength, personalOff, personalRestored, noticeRestored, revisionBefore, revisionAfter }));
    await editSettingsControls(settings, {
      "opt-activation-key": "Shift", "opt-lookup-sticky": false,
      "opt-scan-length": "1", "opt-japanese-only": true,
    });
    await tab.bringToFront();
    await dismiss();
    await tab.$eval("#verb", (element) => { element.innerHTML = "<b>食べ</b><i>たかった</i>"; });
    const box = await (await tab.$("#verb")).boundingBox();
    const plainStart = (await lookups()).length;
    await tab.mouse.move(box.x + 1, box.y + box.height / 2);
    await tab.mouse.down();
    try {
      await tab.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
    } finally {
      await tab.mouse.up();
    }
    await pause();
    const plainSelected = await tab.evaluate(() => window.getSelection().toString());
    const plainRequests = (await lookups()).slice(plainStart);
    const plainHighlight = await tab.evaluate((name) =>
      Array.from(CSS.highlights.get(name) ?? [], (range) => range.toString()), HIGHLIGHT_NAME);
    const plainPopup = await popup.state();
    const plainPencil = await popup.click(".gsm-hoshidicts-note-button");
    if (process.env.HACHIDORI_SELECTION_BLOCKED_SCREENSHOT) {
      mkdirSync(dirname(process.env.HACHIDORI_SELECTION_BLOCKED_SCREENSHOT), { recursive: true });
      await tab.screenshot({ path: process.env.HACHIDORI_SELECTION_BLOCKED_SCREENSHOT });
    }
    check("plain selections cannot lookup, highlight or open personal definitions when Shift is required",
      plainSelected === "食べたかった" && plainRequests.length === 0
        && plainHighlight.length === 0 && !popup.visible(plainPopup) && !plainPencil,
      JSON.stringify({ plainSelected, plainRequests, plainHighlight,
        popupVisible: popup.visible(plainPopup), plainPencil }));

    const probeSelection = async (heldKeys, expectedAllowed, allowPointerPrefix = false) => {
      await dismiss();
      await tab.$eval("#verb", (element) => { element.textContent = "食べたかった"; });
      const probeBox = await (await tab.$("#verb")).boundingBox();
      const before = (await lookups()).length;
      await tab.mouse.move(probeBox.x + 1, probeBox.y + probeBox.height / 2);
      await tab.mouse.down();
      let mouseDown = true;
      let selection;
      try {
        for (const key of heldKeys) await tab.keyboard.down(key);
        await tab.mouse.move(probeBox.x + probeBox.width - 1, probeBox.y + probeBox.height / 2, { steps: 8 });
        await tab.mouse.up();
        mouseDown = false;
        selection = await tab.evaluate(() => {
          const selection = window.getSelection();
          return {
            visible: selection.toString(),
            raw: selection.rangeCount > 0 ? selection.getRangeAt(0).toString() : "",
          };
        });
      } finally {
        if (mouseDown) await tab.mouse.up().catch(() => {});
        for (const key of heldKeys.toReversed()) await tab.keyboard.up(key);
      }
      const view = expectedAllowed ? await popup.waitForVisible() : (await pause(), await popup.state());
      const requests = (await lookups()).slice(before);
      const highlights = await tab.evaluate((name) =>
        Array.from(CSS.highlights.get(name) ?? [], (range) => range.toString()), HIGHLIGHT_NAME);
      const intended = requests.filter(({ text }) => text === selection.visible);
      return {
        allowed: selection.visible === "食べたかった" && intended.length === 1
          && requests.at(-1) === intended[0] && (allowPointerPrefix || requests.length === 1)
          && popup.visible(view)
          && highlights.includes(selection.raw),
        blocked: selection.visible === "食べたかった" && requests.length === 0
          && !popup.visible(view) && highlights.length === 0,
        highlights,
        popupVisible: popup.visible(view),
        requests: requests.map(({ text }) => text),
      };
    };
    await editSettingsControls(settings, { "opt-activation-key": "" });
    const hoverSelection = await probeSelection([], true, true);
    const modifiers = ["Shift", "Control", "Alt", "Meta"];
    const modifierResults = [];
    for (const lookupMode of ["activation", "activationSticky"]) {
      for (let index = 0; index < modifiers.length; index += 1) {
        const activationKey = modifiers[index];
        const mismatch = modifiers[(index + 1) % modifiers.length];
        const extra = modifiers[(index + 2) % modifiers.length];
        await editSettingsControls(settings, {
          "opt-activation-key": activationKey,
          "opt-lookup-sticky": lookupMode === "activationSticky",
        });
        const plain = await probeSelection([], false);
        const mismatched = await probeSelection([mismatch], false);
        const matching = await probeSelection([activationKey], true);
        const combined = await probeSelection([activationKey, extra], true);
        modifierResults.push({
          activationKey,
          combined: combined.allowed,
          lookupMode,
          matching: matching.allowed,
          mismatch: mismatched.blocked,
          plain: plain.blocked,
        });
      }
    }
    check("ordinary selections follow hover and both activation modes for all four modifiers",
      hoverSelection.allowed && modifierResults.every(({ combined, matching, mismatch, plain }) =>
        combined && matching && mismatch && plain),
      JSON.stringify({ hover: hoverSelection, modifiers: modifierResults }));

    await editSettingsControls(settings, {
      "opt-activation-key": "Shift", "opt-lookup-sticky": false, "opt-scan-length": "1",
    });
    await dismiss();
    await tab.$eval("#verb", (element) => { element.innerHTML = "<b>食べ</b><i>たかった</i>"; });
    const startCount = (await lookups()).length;
    let duringDrag;
    await tab.mouse.move(box.x + 1, box.y + box.height / 2);
    await tab.mouse.down();
    try {
      await tab.keyboard.down("Shift");
      try {
        await tab.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
        duringDrag = (await lookups()).length === startCount;
      } finally {
        await tab.mouse.up();
        await tab.keyboard.up("Shift");
      }
    } catch (error) {
      await tab.mouse.up().catch(() => {});
      await tab.keyboard.up("Shift").catch(() => {});
      throw error;
    }
    const selected = await tab.evaluate(() => window.getSelection().toString());
    const exactPopup = await popup.waitForVisible();
    const exactRequests = (await lookups()).slice(startCount);
    const highlighted = await tab.evaluate((name) => Array.from(CSS.highlights.get(name) ?? [], (range) => ({
      text: range.toString(), startTag: range.startContainer.parentElement.localName,
      endTag: range.endContainer.parentElement.localName,
    })), HIGHLIGHT_NAME);
    if (process.env.HACHIDORI_SELECTION_ALLOWED_SCREENSHOT) {
      mkdirSync(dirname(process.env.HACHIDORI_SELECTION_ALLOWED_SCREENSHOT), { recursive: true });
      await tab.screenshot({ path: process.env.HACHIDORI_SELECTION_ALLOWED_SCREENSHOT });
    }
    const glossarySelection = await popup.selectGlossaryText();
    await pause();
    const glossaryRetained = glossarySelection.includes("to eat") && popup.visible(await popup.state())
      && (await lookups()).length === startCount + 1;
    const mutationHighlight = await tab.evaluate(async name => {
      const element = document.getElementById("verb");
      const first = [...CSS.highlights.get(name)][0];
      const selected = window.getSelection().toString();
      const unrelated = new Highlight();
      CSS.highlights.set("e17-page-owned", unrelated);
      try {
        element.innerHTML = element.innerHTML;
        await new Promise(done => requestAnimationFrame(done));
        const replacement = [...(CSS.highlights.get(name) || [])][0];
        const valid = replacement !== first && replacement?.toString() === "食べたかった";
        element.querySelector("b").firstChild.insertData(1, "別");
        await new Promise(done => requestAnimationFrame(done));
        return { valid, cleared: !CSS.highlights.has(name), selection: window.getSelection().toString() === selected,
          unrelated: CSS.highlights.get("e17-page-owned") === unrelated };
      } finally { CSS.highlights.delete("e17-page-owned"); }
    }, HIGHLIGHT_NAME);
    check("source highlights reconcile selected text mutations without changing selection",
      Object.values(mutationHighlight).every(Boolean), JSON.stringify(mutationHighlight));
    const hiddenText = await selectVerb('食べ<span style="display:none">隠し</span>たかった', ["Shift"]);
    const hiddenPopup = await popup.waitForVisible();
    const hiddenHighlight = await tab.evaluate((name) =>
      Array.from(CSS.highlights.get(name) ?? [], (range) => range.toString()), HIGHLIGHT_NAME);
    const hiddenQuery = (await lookups()).at(-1)?.text;
    await editSettingsControls(settings, { "opt-japanese-only": false });
    await tab.bringToFront();
    const blockText = await selectVerb("<div>hello</div><div>world</div>", ["Shift"]);
    await pause();
    const blockQuery = (await lookups()).at(-1)?.text;
    await editSettingsControls(settings, { "opt-japanese-only": true });
    await tab.bringToFront();
    const customText = await selectVerb("未登録語", ["Shift"]);
    const customPopup = await popup.state();
    const selectedEditorOpened = await popup.click(".gsm-hoshidicts-note-button");
    const selectedEditor = await popup.state();
    await popup.click(".gsm-hoshidicts-note-cancel");
    await selectVerb("食べたかったXYZ", ["Shift"]);
    await pause();
    const missingWord = await popup.state();
    const prefixRejected = popup.visible(missingWord)
      && missingWord.plain.includes("No definition found.") && !missingWord.plain.includes("to eat");
    const prefixQuery = (await lookups()).at(-1)?.text;
    check("matching activation preserves exact selections, cross-inline highlights and personal definitions",
      duringDrag && selected === "食べたかった" && exactPopup?.plain.includes("食べる")
        && exactRequests.length === 1 && exactRequests[0].text === selected && exactRequests[0].scanLength === 6
        && highlighted.some((range) => range.text === selected && range.startTag === "b" && range.endTag === "i")
        && glossaryRetained && hiddenText.visible === "食べたかった" && hiddenQuery === hiddenText.visible
        && hiddenPopup?.plain.includes("食べる") && hiddenHighlight.includes(hiddenText.raw)
        && blockText.visible === "hello\nworld" && blockQuery === blockText.visible
        && prefixRejected && prefixQuery === "食べたかったXYZ"
        && customText.visible === "未登録語" && customPopup.plain.includes("No definition found.")
        && selectedEditorOpened && selectedEditor.noteOpen
        && selectedEditor.noteTerm === customText.visible && selectedEditor.noteReading === "",
      JSON.stringify({ duringDrag, selected, exactRequests, highlighted, glossaryRetained,
        hiddenText, hiddenQuery, hiddenHighlight, blockText, blockQuery, customText,
        prefixRejected, prefixQuery, selectedEditorOpened, selectedEditor }));
    if (process.env.HACHIDORI_SELECTION_EVIDENCE) {
      mkdirSync(dirname(process.env.HACHIDORI_SELECTION_EVIDENCE), { recursive: true });
      writeFileSync(process.env.HACHIDORI_SELECTION_EVIDENCE, `${JSON.stringify({
        matching: {
          duringDrag,
          highlighted,
          pencilOpened: selectedEditorOpened && selectedEditor.noteOpen,
          requestCount: exactRequests.length,
          selected,
        },
        modifiers: modifierResults,
        noModifier: {
          highlighted: plainHighlight,
          pencilOpened: plainPencil,
          popupVisible: popup.visible(plainPopup),
          requestCount: plainRequests.length,
          selected: plainSelected,
        },
      }, null, 2)}\n`);
    }

    await popup.click(".gsm-hoshidicts-note-cancel");
    await dismiss();
    await editSettingsControls(settings, { "opt-activation-key": "", "opt-scan-length": "16" });
    // An overlay host turns click-through when the popup hides, so pressing on
    // text must keep it open until release decides between a drag and a click.
    await tab.$eval("#verb", (element) => { element.innerHTML = "<b>食べ</b><i>たかった</i>"; });
    await moveTo("#verb");
    const hoverPopup = await popup.waitForVisible();
    await tab.evaluate(() => {
      globalThis.__hiddenEvents = 0;
      globalThis.__countHidden ??= () => { globalThis.__hiddenEvents += 1; };
      window.addEventListener("hachidori-popup-hidden", globalThis.__countHidden);
    });
    const hoverBox = await (await tab.$("#verb")).boundingBox();
    await tab.mouse.move(hoverBox.x + 1, hoverBox.y + hoverBox.height / 2);
    await tab.mouse.down();
    let hoverDrag;
    try {
      await tab.mouse.move(hoverBox.x + hoverBox.width - 1, hoverBox.y + hoverBox.height / 2, { steps: 8 });
      hoverDrag = await tab.evaluate(() => ({ hidden: globalThis.__hiddenEvents,
        selected: window.getSelection().toString() }));
      hoverDrag.visible = popup.visible(await popup.state());
    } finally {
      await tab.mouse.up();
      await tab.evaluate(() => window.removeEventListener("hachidori-popup-hidden", globalThis.__countHidden));
    }
    await pause();
    const hoverSelected = await popup.waitForVisible();
    const hoverEditorOpened = await popup.click(".gsm-hoshidicts-note-button");
    const hoverEditor = await popup.state();
    await popup.click(".gsm-hoshidicts-note-cancel");
    await dismiss();
    await moveTo("#verb");
    const clickPopup = await popup.waitForVisible();
    await tab.mouse.down();
    await tab.mouse.up();
    await pause();
    const clickDismissed = !popup.visible(await popup.state());
    check("hover popups stay open while a drag selects text, prefill the highlight and close on a plain click",
      hoverPopup?.plain.includes("食べる") && hoverDrag.hidden === 0 && hoverDrag.visible
        && hoverDrag.selected === "食べたかった" && hoverSelected?.plain.includes("食べる")
        && hoverEditorOpened && hoverEditor.noteTerm === "食べたかった" && hoverEditor.noteReading === ""
        && Boolean(clickPopup) && clickDismissed,
      JSON.stringify({ hoverPopup: Boolean(hoverPopup), hoverDrag, hoverSelected: Boolean(hoverSelected),
        hoverEditorOpened, hoverEditor, clickPopup: Boolean(clickPopup), clickDismissed }));
    await dismiss();
    // A text field's words are looked up through an imposter (#425) while its
    // focus, selection, value and scroll stay the field's own; the input is
    // scrolled to 食べたかった and the textarea down to its third line.
    await tab.$eval("#verb", (element) => {
      const style = "font: 20px/1 serif; padding: 4px; border: 1px solid; width: 160px";
      element.innerHTML = `<input style="${style}" value="あいうえおかきくけこ食べたかったさしすせそ">`
        + `<textarea style="${style}; height: 40px">一行目\n二行目\n食べたかった</textarea>`
        + `<input type="password" style="${style}" value="食べたかった">`
        + `<input style="${style}; -webkit-text-security: disc" value="食べたかった">`
        + '<b contenteditable="true"><i>食べたかった</i></b><button class="vn-next" type="button">→</button>';
    });
    const fieldState = (selector) => tab.$eval(selector, (element) => ({
      focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd,
      value: element.value, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop,
    }));
    const imposters = () => tab.evaluate(() => [...document.body.children]
      .filter((child) => child.getAttribute("aria-hidden") === "true").length);
    const fields = [];
    for (const selector of ["#verb input", "#verb textarea"]) {
      await tab.focus(selector);
      await tab.$eval(selector, (element) => {
        element.setSelectionRange(1, 3);
        element.scrollLeft = 200;
        element.scrollTop = 20;
      });
      const before = await fieldState(selector);
      const box = await (await tab.$(selector)).boundingBox();
      // 食 is the first visible glyph, on the input's line and the textarea's second visible one.
      const shown = await hoverForPopup(tab, popup, selector,
        { point: { x: box.x + 15, y: box.y + (selector.endsWith("input") ? 15 : 35) } });
      const during = await fieldState(selector);
      const selectStart = (await lookups()).length;
      await tab.$eval(selector, (element) => element.select());
      await pause();
      const selectQuiet = (await lookups()).length === selectStart;
      await tab.keyboard.press("End");
      await tab.keyboard.type("k");
      const typed = (await fieldState(selector)).value.endsWith("k");
      await dismiss();
      fields.push({ selector, looked: shown?.plain.includes("食べる") === true, before, during,
        undisturbed: before.focused && JSON.stringify(before) === JSON.stringify(during),
        selectQuiet, typed, removed: await imposters() === 0 });
    }
    const editingStart = (await lookups()).length;
    // A password and a masked field are never read.
    for (const selector of ['#verb input[type="password"]', "#verb input[style*=security]"]) {
      const box = await (await tab.$(selector)).boundingBox();
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + 15, box.y + 15);
      await pause();
    }
    await tab.focus("#verb [contenteditable]");
    await moveTo("#verb [contenteditable]");
    await tab.keyboard.press("End");
    await tab.keyboard.type("k");
    const edits = [await tab.$eval("#verb [contenteditable]", (element) => element.textContent.endsWith("k"))];
    await tab.$eval("#verb [contenteditable]", (element) => window.getSelection().selectAllChildren(element));
    await pause();
    await dismiss();
    // A webpage cannot use the startup arrow's class to scan a button's text.
    await tab.focus("#verb .vn-next");
    await moveTo("#verb .vn-next");
    await dismiss();
    for (const tag of ["input", "div"]) {
      await editSettingsControls(settings, { "opt-activation-key": "K", "opt-lookup-sticky": false });
      await tab.evaluate((name) => {
        const host = document.createElement("div");
        host.id = "shadow-editor";
        document.body.append(host);
        const innerHost = document.createElement("div");
        host.attachShadow({ mode: "open" }).append(innerHost);
        const editor = document.createElement(name);
        if (name === "div") editor.contentEditable = "true";
        innerHost.attachShadow({ mode: "open" }).append(editor);
        editor.focus();
      }, tag);
      await moveTo("#duplicate");
      await tab.keyboard.down("k");
      await pause();
      await tab.keyboard.up("k");
      edits.push(await tab.evaluate(() => {
        const host = document.getElementById("shadow-editor");
        const editor = host.shadowRoot.firstChild.shadowRoot.firstChild;
        const typed = (editor.value ?? editor.textContent) === "k";
        editor.blur();
        host.remove();
        return typed;
      }));
      await dismiss();
    }
    await editSettingsControls(settings, { "opt-activation-key": "" });
    // Neither range endpoint is editable: the interior control still excludes it.
    for (const editor of [
      '<button>べ</button>',
      '<b contenteditable="true" style="display:contents">べ</b>',
      '<span style="visibility:hidden"><b contenteditable="true" style="visibility:visible">べ</b></span>',
      '<b contenteditable="true" style="visibility:hidden">隠し<i style="visibility:visible">べ</i></b>',
    ]) {
      await selectVerb(`食${editor}たかった`);
      await moveTo("#verb");
    }
    const editingQuiet = (await lookups()).length === editingStart && !popup.visible(await popup.state());
    await dismiss();
    await tab.$eval("#verb", (element) => {
      element.innerHTML = '<b id="selection-boundary-start">食</b>'
        + '<div style="visibility:hidden"><b style="visibility:visible">べ</b></div>た';
    });
    await moveTo("#selection-boundary-start");
    // Layout-unaware like Yomitan: a block wrapper does not end the scan.
    const blockBoundary = (await lookups()).at(-1)?.text === "食べた";
    await dismiss();
    await tab.$eval("#verb", (element) => { element.innerHTML = '食<input type="hidden">べたかった'; });
    const hiddenPointerAccepted = await hoverForPopup(tab, popup, "#verb");
    await selectVerb('食べ<span style="display:none"><button>隠し</button></span>たかった');
    const hiddenControlAccepted = await popup.waitForVisible();
    check("text fields look up their words without disturbing editing, while other editors suppress pointer and selection lookups",
      fields.every((field) => field.looked && field.undisturbed && field.selectQuiet && field.typed && field.removed)
        && edits.every(Boolean) && editingQuiet && blockBoundary && hiddenControlAccepted?.plain.includes("食べる")
        && hiddenPointerAccepted?.plain.includes("食べる"),
      JSON.stringify({ fields, edits, editingQuiet, blockBoundary, hiddenControlAccepted: hiddenControlAccepted !== null,
        hiddenPointerAccepted: hiddenPointerAccepted !== null }));

    await dismiss();
    await editSettingsControls(settings, { "opt-activation-key": "" });
    await tab.$eval("#verb", (element) => {
      element.innerHTML = '<input id="jisho-search" autofocus aria-label="Search Japanese" value="食べました"'
        + ' style="font: 20px/1 serif; padding: 4px; border: 1px solid">'
        + '<span>Text reading assistance: <a href="/search/example">昨日すき焼きを'
        + '<span id="jisho-example-word">食べました</span></a></span>';
    });
    const search = await (await tab.$("#jisho-search")).boundingBox();
    // The pointer rests on 食, the field's first glyph.
    const toField = async (dx = 0) => {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(search.x + 15 + dx, search.y + 15);
      await pause();
    };
    const searchFocused = () => tab.$eval("#jisho-search", element => document.activeElement === element);
    await tab.focus("#jisho-search");
    await moveTo("#jisho-example-word");
    const hoveredLink = await popup.waitForVisible();
    const hoverKeepsSearch = await searchFocused();
    await dismiss();
    await tab.focus("#jisho-search");
    await toField();
    const hoveredField = await popup.waitForVisible();
    const fieldHoverKeepsSearch = await searchFocused();
    await dismiss();
    await editSettingsControls(settings, { "opt-activation-key": "Shift", "opt-lookup-sticky": false });
    await tab.focus("#jisho-search");
    const beforeModifier = (await lookups()).length;
    await moveTo("#jisho-example-word");
    const modifierGated = (await lookups()).length === beforeModifier;
    const holdShift = async (whileHeld) => {
      try {
        await tab.keyboard.down("Shift");
        return await whileHeld();
      } finally { await tab.keyboard.up("Shift"); }
    };
    const activatedLink = await holdShift(() => popup.waitForVisible());
    const modifierKeepsSearch = await searchFocused();
    await popup.waitForHidden();
    await toField();
    const activatedField = await holdShift(() => popup.waitForVisible());
    const fieldText = (await lookups()).at(-1)?.text;
    await popup.waitForHidden();
    // After a click into the field and typing, the Shift of a capital letter
    // does not cover it; moving with Shift held looks up again.
    await tab.mouse.down();
    await tab.mouse.up();
    await tab.keyboard.press("End");
    await tab.keyboard.type("x");
    const beforeTyping = (await lookups()).length;
    const typing = await holdShift(async () => {
      await pause();
      const quiet = (await lookups()).length === beforeTyping && !popup.visible(await popup.state());
      await tab.mouse.move(search.x + 16, search.y + 15);
      return { quiet, moved: await popup.waitForVisible() };
    });
    const typedText = (await lookups()).at(-1)?.text;
    const typedKeepsSearch = await searchFocused();
    check("autofocused search fields allow hover and stationary Shift lookup of their own words and Japanese example links",
      hoveredLink?.plain.includes("食べる") && activatedLink?.plain.includes("食べる")
        && hoveredField?.plain.includes("食べる") && activatedField?.plain.includes("食べる") && fieldText === "食べました"
        && typing.quiet && typing.moved?.plain.includes("食べる") && typedText === "食べましたx"
        && modifierGated && hoverKeepsSearch && fieldHoverKeepsSearch && modifierKeepsSearch && typedKeepsSearch,
      JSON.stringify({ hoveredLink: Boolean(hoveredLink), activatedLink: Boolean(activatedLink),
        hoveredField: Boolean(hoveredField), activatedField: Boolean(activatedField), fieldText,
        typingQuiet: typing.quiet, typingMoved: Boolean(typing.moved), typedText,
        modifierGated, hoverKeepsSearch, fieldHoverKeepsSearch, modifierKeepsSearch, typedKeepsSearch }));

    await dismiss();
    await editSettingsControls(settings, { "opt-activation-key": "" });
    const latinStart = (await lookups()).length;
    await moveTo("#latin");
    const japaneseOnly = (await lookups()).length === latinStart;
    await editSettingsControls(settings, { "opt-japanese-only": false });
    await pause();
    const latinRequests = (await lookups()).slice(latinStart);
    await editSettingsControls(settings, { "opt-japanese-only": true });
    const reenabledStart = (await lookups()).length;
    await moveTo("#latin");
    const gatedAgain = (await lookups()).length === reenabledStart;
    check("Japanese-only preferences change automatic scanning in an already-open tab",
      japaneseOnly && latinRequests.length === 1 && latinRequests[0].text === "hello world" && gatedAgain,
      JSON.stringify({ japaneseOnly, latinRequests, gatedAgain }));
    const title = "mixed-numeral-fixture";
    const terms = ["第1", "第１", "第一", "1扉", "１扉", "3月", "３月"];
    await installMediaArchive(settings, buildTitledZip(title, {
      terms: terms.map((term, index) => [term, "だいいち", "", "", 100, ["mixed numeral match"], index + 1, ""]),
    }));
    const mixed = [];
    try {
      for (const [text, offset, match] of [
        ["第1。", 0, "第1"], ["第１。", 0, "第１"], ["第一。", 0, "第一"],
        ["第1扉。", 1, "1扉"], ["第１扉。", 1, "１扉"], ["3月。", 0, "3月"], ["３月。", 0, "３月"],
      ]) {
        await dismiss();
        await tab.$eval("#verb", (element, value) => { element.textContent = value; }, text);
        const point = await tab.$eval("#verb", (element, start) => {
          const range = document.createRange();
          range.setStart(element.firstChild, start);
          range.setEnd(element.firstChild, start + 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.x + rect.width / 4, y: rect.y + rect.height / 2 };
        }, offset);
        await tab.mouse.move(point.x, point.y);
        await pause();
        const state = await popup.state();
        const highlighted = await tab.evaluate(name =>
          [...(CSS.highlights.get(name) ?? [])].map(range => range.toString()).join(""), HIGHLIGHT_NAME);
        const lookup = await settings.evaluate(text => chrome.runtime.sendMessage({
          target: "hoshidicts-offscreen", type: "hd_lookup", text, maxResults: 32, scanLength: 16,
        }), text.slice(offset));
        mixed.push({ text, offset, highlighted, visible: popup.visible(state),
          matched: lookup.results?.some(result => result.term?.expression === match && result.matched === match),
          correct: highlighted === match && state?.plain.includes("mixed numeral match") });
        if (text === "第1。" && process.env.HACHIDORI_MIXED_NUMERAL_SCREENSHOT) {
          await tab.screenshot({ path: process.env.HACHIDORI_MIXED_NUMERAL_SCREENSHOT });
        }
      }
    } finally {
      await dismiss();
      const removed = await settings.evaluate(title => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_remove", title,
      }), title);
      if (!removed.ok) throw new Error(removed.error);
    }
    check("Japanese-only mixed numeral lookups retain native matches and exact source highlights",
      mixed.length === 7 && mixed.every(value => value.visible && value.matched && value.correct), JSON.stringify(mixed));
  } finally {
    await dismiss();
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
    await editSettingsControls(settings, { "opt-activation-key": rememberedKey });
    await editSettingsControls(settings, original);
    await restoreMediaReplyProbe(worker);
  }
}

async function checkSourceFallback(settings, tab, popup) {
  const original = await readSettingsControls(settings, ["opt-activation-key", "opt-lookup-sticky", "opt-scan-length"]);
  const sourceBefore = await tab.$eval("#verb", element => ({ html: element.innerHTML,
    style: element.getAttribute("style"), className: element.className }));
  const frame = () => tab.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const snapshot = async () => {
    await frame();
    const paint = await popup.sourcePaint("read", "#verb");
    const { source } = paint;
    const exact = paint.groups === 1 && paint.rects.length === source.expected.length && paint.rects.length > 0
      && paint.rects.every((rect, index) => rect.pointerEvents === "none"
        && ["left", "top", "right", "bottom"].every(key => Math.abs(rect[key] - source.expected[index][key]) < 1));
    return { paint, source, exact };
  };
  let restore;
  let evidence;
  try {
    await tab.keyboard.press("Escape");
    await editSettingsControls(settings, { "opt-activation-key": "", "opt-scan-length": "16" });
    await tab.$eval("#verb", element => {
      getSelection().removeAllRanges();
      element.innerHTML = '前<b id="e17-source" style="padding:0 4px">食べ</b><i>たかった</i>後';
      element.classList.add("gsm-hoshidicts-source-match");
      element.style.cssText = "width:180px;overflow:hidden;white-space:nowrap;border:3px solid #888;padding:0 8px";
      const paragraph = element.parentElement;
      const box = document.createElement("div");
      box.id = "e17-source-box";
      box.style.cssText = "height:300px;display:flow-root";
      const sibling = document.createElement("div");
      sibling.id = "e17-source-sibling";
      sibling.style.height = "96px";
      sibling.textContent = "spacer";
      paragraph.replaceWith(box);
      box.append(sibling, paragraph);
    });
    await tab.bringToFront();
    const opened = await hoverForPopup(tab, popup, "#e17-source");
    restore = await forceSourceFallback(tab, settings);
    const initial = await snapshot();
    if (process.env.HACHIDORI_HIGHLIGHT_SCREENSHOT) await tab.screenshot({ path: process.env.HACHIDORI_HIGHLIGHT_SCREENSHOT });
    await tab.$eval("#verb", element => { element.scrollLeft = 45; });
    const scrolled = await snapshot();
    await tab.$eval("#verb", element => { element.style.width = "110px"; });
    const resized = await snapshot();
    await tab.$eval("#verb", element => { element.style.visibility = "hidden"; });
    await frame();
    const hidden = await popup.sourcePaint();
    await tab.$eval("#verb", element => { element.style.visibility = "visible"; element.style.opacity = "0"; });
    await frame();
    const transparent = await popup.sourcePaint();
    await tab.$eval("#verb", element => { element.style.opacity = "1"; });
    const visible = await snapshot();
    const motion = [];
    for (const kind of ["transition", "animation", "resume", "finish", "cancel", "waapi", "waapi-finish", "waapi-cancel"]) {
      if (kind.startsWith("waapi")) await new Promise(done => setTimeout(done, 350));
      await tab.$eval("#verb", (element, mode) => {
        if (mode.startsWith("waapi")) {
          const target = mode === "waapi" ? element.parentElement : element;
          const animation = target.animate([{ transform: "translateX(0)" }, { transform: "translateX(90px)" }],
            { duration: 1200, fill: "forwards" });
          if (mode !== "waapi") { animation.pause(); animation.currentTime = 500; }
          return;
        }
        if (mode === "transition") {
          element.style.transition = "transform 1s linear";
          element.getBoundingClientRect();
          element.style.transform = "translateX(90px)";
        } else {
          const style = document.createElement("style");
          style.id = "e17-animation";
          style.textContent = "@keyframes e17-move { to { transform: translateX(90px); } }"
            + "#verb:focus { animation-play-state: running !important; }";
          document.head.append(style);
          if (mode === "animation") element.parentElement.style.animation = "e17-move 1s linear";
          else {
            element.tabIndex = 0;
            element.style.animation = "e17-move 1s linear forwards paused";
            if (mode === "finish" || mode === "cancel") element.getAnimations()[0].currentTime = 500;
          }
        }
      }, kind);
      if (kind === "resume") {
        await frame();
        await tab.$eval("#verb", element => element.focus({ preventScroll: true }));
      }
      if (kind.startsWith("waapi")) await new Promise(done => setTimeout(done, 350));
      await tab.waitForFunction(mode => {
        const source = document.getElementById("verb");
        return (mode === "animation" || mode === "waapi" ? source.parentElement : source).getAnimations()
          .some(animation => animation.currentTime >= 150 && animation.currentTime < 800);
      }, {}, kind);
      motion.push(await snapshot());
      if (["finish", "cancel", "waapi-finish", "waapi-cancel"].includes(kind)) {
        await tab.$eval("#verb", (element, operation) => element.getAnimations().forEach(animation => animation[operation]()),
          kind.replace("waapi-", ""));
        motion.push(await snapshot());
      }
      await tab.$eval("#verb", async element => {
        await Promise.all([...element.getAnimations(), ...element.parentElement.getAnimations()].map(animation => animation.finished));
        [...element.getAnimations(), ...element.parentElement.getAnimations()].forEach(animation => animation.cancel());
        element.style.transition = "none";
        element.style.transform = "none";
        element.style.removeProperty("animation");
        element.blur();
        element.removeAttribute("tabindex");
        element.parentElement.style.removeProperty("animation");
        document.getElementById("e17-animation")?.remove();
      });
      await frame();
    }
    check("fallback source paint tracks CSS transitions and animated ancestors",
      motion.every(value => value.exact), JSON.stringify(motion));
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "Keep the source layout test open" });
    // Keep the pointer away: a stationary pointer over moving source text can
    // synthesize pointerout and accidentally hide missing layout observation.
    await tab.mouse.move(2, 2);
    await frame();
    const fixedBefore = await tab.$eval("#e17-source-box", box => box.getBoundingClientRect().toJSON());
    await tab.$eval("#e17-source-sibling", sibling => { sibling.style.height = "20px"; });
    const siblingStyle = await snapshot();
    await tab.$eval("#e17-source-sibling", sibling => { sibling.style.height = "auto"; });
    await frame();
    await tab.$eval("#e17-source-sibling", sibling => { sibling.firstChild.data = ""; });
    const siblingText = await snapshot();
    const fixedAfter = await tab.$eval("#e17-source-box", box => box.getBoundingClientRect().toJSON());
    check("fallback source paint follows sibling layout changes inside fixed-size ancestors",
      siblingStyle.exact && siblingText.exact && JSON.stringify(fixedBefore) === JSON.stringify(fixedAfter)
        && siblingStyle.source.expected[0].top !== siblingText.source.expected[0].top,
      JSON.stringify({ fixedBefore, fixedAfter, siblingStyle, siblingText }));
    const area = rect => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
    const overlap = (a, b) => area({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right),
      top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });
    const uncovered = await snapshot();
    const sourceRect = uncovered.source.expected[0];
    const covers = [];
    for (const kind of ["partial", "pointer-none", "modal", "sticky", "border", "fixed-escape", "motion",
      "membership", "membership-paused", "membership-late", "membership-overlap", "membership-waapi", "behind"]) {
      if (kind === "membership-late") await editSettingsControls(settings, { "opt-source-highlight": false });
      await tab.evaluate(({ source, kind }) => {
        const element = document.createElement("div");
        element.id = "e17-page-cover";
        const small = kind === "modal";
        const left = source.left + (small ? 20 : -10), top = source.top + (small ? 8 : -8);
        const width = small ? 12 : 220, height = small ? 12 : kind === "partial" ? 18 : 48;
        element.style.cssText = `position:${kind === "sticky" ? "absolute" : "fixed"};left:${left}px;top:${top}px;`
          + `width:${width}px;height:${height}px;background:white;z-index:${kind === "behind" ? -1 : 100};`
          + (kind === "pointer-none" ? "pointer-events:none;" : "");
        let painted = element;
        if (kind === "sticky") {
          element.style.background = "transparent";
          element.style.overflow = "auto";
          painted = document.createElement("div");
          painted.style.cssText = `position:sticky;top:0;height:${height}px;background:white`;
          element.append(painted);
        }
        if (kind === "border") {
          element.style.height = "8px";
          element.style.borderBottom = "18px solid white";
          element.style.overflow = "hidden";
        }
        if (kind === "fixed-escape") {
          painted = element.cloneNode();
          painted.removeAttribute("id");
          element.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden";
          element.append(painted);
        }
        document.body.append(element);
        painted.dataset.e17PaintedCover = "";
        if (kind === "motion") {
          element.style.transition = "transform 1s linear";
          element.getBoundingClientRect();
          element.style.transform = "translateX(160px)";
        }
        if (kind.startsWith("membership")) {
          const style = document.createElement("style");
          style.textContent = "@keyframes e17-cover { from { position:static; } to { position:fixed; } }"
            + "@keyframes e17-other { from { opacity:1; } to { opacity:1; } }";
          element.append(style);
          element.style.position = "static";
          if (kind !== "membership-waapi") element.style.animation = "e17-cover 1s linear forwards";
          if (kind === "membership-overlap") element.style.animation += ", e17-other 0.2s linear";
        }
      }, { source: sourceRect, kind });
      let initiallyUncovered = true;
      if (kind.startsWith("membership")) {
        if (kind === "membership-late") {
          await tab.waitForFunction(() => document.getElementById("e17-page-cover").getAnimations()
            .some(animation => animation.currentTime > 0 && animation.currentTime < 400));
          await tab.$eval("#e17-page-cover", element => element.getAnimations().forEach(animation => animation.pause()));
          await editSettingsControls(settings, { "opt-source-highlight": true });
        }
        initiallyUncovered = (await snapshot()).exact;
        if (kind === "membership-waapi") {
          await new Promise(done => setTimeout(done, 350));
          await tab.$eval("#e17-page-cover", element => {
            element.animate([{ position: "static" }, { position: "fixed" }], { duration: 1200, fill: "forwards" });
          });
        }
        if (kind === "membership-late") await tab.$eval("#e17-page-cover", element => element.getAnimations().forEach(animation => animation.play()));
        if (kind !== "membership") {
          await tab.waitForFunction(() => document.getElementById("e17-page-cover").getAnimations()
            .some(animation => animation.currentTime >= 650 && animation.currentTime < 950));
          await tab.$eval("#e17-page-cover", element => element.getAnimations().forEach(animation => animation.pause()));
        } else await tab.$eval("#e17-page-cover", element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      }
      if (kind === "motion") await tab.waitForFunction(() => document.querySelector("[data-e17-painted-cover]").getAnimations()
        .some(animation => animation.currentTime >= 300 && animation.currentTime < 800));
      const current = await snapshot();
      const cover = current.source.cover;
      const expectedArea = uncovered.source.expected.reduce((total, rect) => total + area(rect)
        - (kind === "behind" ? 0 : overlap(rect, cover)), 0);
      const actualArea = current.paint.rects.reduce((total, rect) => total + area(rect), 0);
      const bounded = current.paint.rects.every(rect => uncovered.source.expected.some(source =>
        overlap(rect, source) >= area(rect) - 1) && (kind === "behind" || overlap(rect, cover) < 1));
      await tab.$eval("#e17-page-cover", element => element.remove());
      const restored = await snapshot();
      covers.push({ kind, expectedArea, actualArea, bounded, initiallyUncovered, restored: restored.exact });
    }
    check("fallback source paint stays beneath page headers and overlays",
      covers.every(value => value.bounded && value.initiallyUncovered && value.restored && Math.abs(value.expectedArea - value.actualArea) < 2),
      JSON.stringify(covers));
    const stylesheetSource = await tab.$eval("#verb", element => element.getBoundingClientRect().toJSON());
    const styleChanges = [];
    for (const kind of ["insert", "declaration", "adopted", "load", "media-nested", "media-sheet"]) {
      let stylesSession;
      let pendingStyle;
      try {
        if (kind.startsWith("media-")) await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        if (kind === "load") {
          stylesSession = await tab.createCDPSession();
          pendingStyle = new Promise(done => stylesSession.once("Fetch.requestPaused", done));
          await stylesSession.send("Fetch.enable", { patterns: [{ urlPattern: "*/e17-late.css" }] });
        }
        const css = await tab.evaluate(({ source, kind }) => {
          const element = document.createElement("div");
          element.id = "e17-page-cover";
          element.dataset.e17PaintedCover = "";
          // Cover the measured source rather than assuming a font's glyph
          // height: Japanese serif fallback can exceed the old 40px interior.
          element.style.cssText = `width:${source.width + 20}px;height:${source.height + 16}px;background:white;z-index:100`;
          document.body.append(element);
          const initial = "#e17-page-cover { position:absolute;left:-1000px;top:0; }";
          const css = `#e17-page-cover { position:fixed;left:${source.left - 10}px;top:${source.top - 8}px; }`;
          if (kind === "adopted") {
            window.e17TestSheet = new CSSStyleSheet();
            window.e17TestSheet.replaceSync(initial);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, window.e17TestSheet];
          } else {
            const style = document.createElement("style");
            style.id = "e17-page-style";
            style.textContent = initial;
            if (kind === "media-nested") style.textContent += `@supports (display:block) { @media (prefers-color-scheme:dark) { ${css} } }`;
            document.head.append(style);
            window.e17TestSheet = style.sheet;
          }
          if (kind === "media-sheet") {
            const style = document.createElement("style");
            style.id = "e17-media-style";
            style.media = "(prefers-color-scheme:dark)";
            style.textContent = css;
            document.head.append(style);
          }
          if (kind === "load") {
            const link = document.createElement("link");
            link.id = "e17-late-style";
            link.rel = "stylesheet";
            link.href = "/e17-late.css";
            document.head.append(link);
          }
          return css;
        }, { source: stylesheetSource, kind });
        const before = await snapshot();
        if (stylesSession) {
          const request = await pendingStyle;
          await stylesSession.send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/css" }], body: Buffer.from(css).toString("base64") });
        } else if (kind.startsWith("media-")) await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
        else await tab.evaluate(({ css, kind }) => {
          const sheet = window.e17TestSheet;
          if (kind === "insert") sheet.insertRule(css, sheet.cssRules.length);
          else if (kind === "adopted") sheet.replaceSync(css);
          else sheet.cssRules[0].style.cssText = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
        }, { css, kind });
        await new Promise(done => setTimeout(done, 350));
        const changed = await snapshot();
        const fullyCovered = changed.source.expected.every(rect =>
          overlap(rect, changed.source.cover) >= area(rect) - 1);
        styleChanges.push({ kind, before: before.exact, fullyCovered,
          covered: changed.paint.groups === 1 && changed.paint.rects.length === 0 });
      } finally {
        await stylesSession?.detach();
        await tab.evaluate(() => {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== window.e17TestSheet);
          delete window.e17TestSheet;
          for (const id of ["e17-page-cover", "e17-page-style", "e17-late-style", "e17-media-style"]) document.getElementById(id)?.remove();
        });
        if (kind.startsWith("media-")) await tab.emulateMediaFeatures([]);
      }
      styleChanges.at(-1).restored = (await snapshot()).exact;
    }
    check("fallback source paint refreshes after stylesheet loading and CSSOM edits",
      styleChanges.every(value => value.before && value.fullyCovered && value.covered && value.restored), JSON.stringify(styleChanges));
    await tab.keyboard.press("Escape"); // Close the unsaved Note draft first.
    await tab.keyboard.press("Escape");
    await frame();
    const closed = await popup.sourcePaint();
    const snapshots = [initial, scrolled, resized, visible];
    evidence = { opened: !!opened, initial, scrolled, resized, hidden, transparent, visible, closed };
    check("fallback source paint stays exact through clipping, scrolling, visibility and cleanup",
      !!opened && snapshots.every(value => value.exact && value.source.html === initial.source.html
        && value.source.className === initial.source.className && value.source.selection === initial.source.selection)
        && initial.paint.rects[0].left !== scrolled.paint.rects[0].left
        && hidden.rects.length === 0 && transparent.rects.length === 0 && closed.groups === 0,
      JSON.stringify(evidence));
  } finally {
    if (restore) await restore();
    await tab.$eval("#verb", (element, value) => {
      element.innerHTML = value.html;
      element.className = value.className;
      document.getElementById("e17-source-box")?.replaceWith(element.parentElement);
      document.getElementById("e17-page-cover")?.remove();
      if (value.style === null) element.removeAttribute("style"); else element.setAttribute("style", value.style);
    }, sourceBefore);
    await editSettingsControls(settings, original);
  }
}

describe("activation and selection", () => {
  step("reader activation", async () => {
    await checkReaderActivation(page, tab, popup);
  });

  step("reader selection", async () => {
    await checkReaderSelection(browser, page, tab, popup);
  });

  step("source fallback paint", async () => {
    await checkSourceFallback(page, tab, popup);
  });
});
