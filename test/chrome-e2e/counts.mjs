/*
 * Lookup counts, definition blur and word highlighting.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./reader.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { answerAnkiConnect } from "../anki-connect-fake.mjs";
import { check, diagnostics, EXTENSION, step, WORD_HIGHLIGHT_CHECKS } from "./harness.mjs";
import { hoverForPopup, popupReader } from "./popup-reader.mjs";
import { popup, tab } from "./reader.mjs";
import {
  browser,
  extensionId,
  interceptFetches,
  page,
  pageUrl,
  readLookupStatistics,
  readSettingsControls,
  setWordHighlightAnki,
  showSettingsSection,
  updateSettingsControls,
  waitForCdpTargetGone,
  waitForRunningServiceWorker,
  watchedServiceWorkers,
  WORD_HIGHLIGHT_ANKI_PATH,
} from "./session.mjs";

// The highlight names come from the source, so a rename cannot leave the
// checks reading a registry key nothing sets.
const WORD_HIGHLIGHT_NAME = (() => {
  const source = readFileSync(resolve(EXTENSION, "word-highlights.js"), "utf8");
  const match = /`(hd-word-)\$\{status\}`/u.exec(source);
  if (!match) throw new Error("word-highlights.js no longer names its highlights hd-word-${status}");
  return status => `${match[1]}${status}`;
})();

async function waitForLookupStatistics(popup, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < deadline) {
    current = await popup.lookupStatistics();
    if (predicate(current)) return current;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  return current;
}

async function checkLookupStatistics({ settings, tab, popup }) {
  const original = await readSettingsControls(settings, [
    "opt-lookup-counts",
  ]);
  const freshLookup = async () => {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    return hoverForPopup(tab, popup, "#verb");
  };
  try {
    await updateSettingsControls(settings, {
      "opt-lookup-counts": true,
    });
    const initialDefinition = await popup.state();
    const initialLine = await waitForLookupStatistics(
      popup,
      value => value !== null && !value.hidden && value.text.includes("Looked up"),
    );
    const before = await readLookupStatistics(settings);
    const secondDefinition = await freshLookup();
    const secondLine = await waitForLookupStatistics(
      popup,
      value => value !== null && !value.hidden && value.text.includes("Looked up"),
    );
    const after = await readLookupStatistics(settings);
    check(
      "accepted reader lookups persist canonical counts without delaying definitions",
      initialDefinition?.plain.includes("食べる")
        && secondDefinition?.plain.includes("食べる")
        && initialLine?.text.includes(`Looked up ${before.statistics?.lookupCount}`)
        && secondLine?.text.includes(`Looked up ${after.statistics?.lookupCount}`)
        && before.ok === true
        && before.statistics?.term === "食べる"
        && before.statistics?.reading === "たべる"
        && Number.isFinite(before.statistics?.firstLookedUpAt)
        && after.statistics?.lookupCount === before.statistics.lookupCount + 1
        && after.statistics.firstLookedUpAt === before.statistics.firstLookedUpAt
        && after.statistics.lastLookedUpAt >= before.statistics.lastLookedUpAt,
      JSON.stringify({ initialDefinition, initialLine, before, secondDefinition, secondLine, after }),
    );

    await popup.lookupStatistics("remember");
    await updateSettingsControls(settings, { "opt-lookup-counts": false });
    const hidden = await waitForLookupStatistics(
      popup,
      value => value?.hidden === true && value.popupHidden === false,
    );
    const retainedDefinition = await popup.state();
    const disabledDefinition = await freshLookup();
    await popup.lookupStatistics("remember");
    await updateSettingsControls(settings, { "opt-lookup-counts": true });
    // Re-enabling paints the popup that rendered while counts were off, with
    // one read: the same popup and panel, and no new hover or increment.
    const reenabled = await waitForLookupStatistics(
      popup,
      value => value !== null && !value.hidden && value.text.includes("Looked up"),
    );
    const afterPause = await readLookupStatistics(settings);
    const resumedDefinition = await freshLookup();
    const incrementedLine = await waitForLookupStatistics(
      popup,
      value => value !== null && !value.hidden && value.text.includes("Looked up"),
    );
    const afterResume = await readLookupStatistics(settings);
    check(
      "live lookup-count Settings pause recording and preserve the displayed reader view",
      hidden?.samePopup === true
        && hidden.sameLine === true
        && hidden.samePanel === true
        && retainedDefinition?.plain.includes("食べる")
        && disabledDefinition?.plain.includes("食べる")
        && reenabled?.samePopup === true
        && reenabled.sameLine === true
        && reenabled.samePanel === true
        && reenabled.text.includes(`Looked up ${afterPause.statistics?.lookupCount}`)
        && resumedDefinition?.plain.includes("食べる")
        && incrementedLine?.text.includes(`Looked up ${afterResume.statistics?.lookupCount}`)
        && afterPause.statistics?.lookupCount === after.statistics.lookupCount
        && afterResume.statistics?.lookupCount === afterPause.statistics.lookupCount + 1,
      JSON.stringify({
        hidden, retainedDefinition, disabledDefinition, reenabled, afterPause,
        resumedDefinition, incrementedLine, afterResume,
      }),
    );

    const localControls = await settings.evaluate(() => ({
      counts: document.getElementById("opt-lookup-counts").closest("section").id,
      blur: document.getElementById("opt-blur-frequency").closest("section").id,
      external: document.querySelectorAll("#opt-corpus-url, #opt-corpus-seen").length,
    }));
    check("local count and blur settings belong to Reading without external corpus controls",
      localControls.counts === "lookup" && localControls.blur === "lookup" && localControls.external === 0,
      JSON.stringify(localControls));

    // Settings → Reading → Reset lookup counts while the counted popup stays open.
    const storedState = () => settings.evaluate(async () => {
      const stored = await chrome.storage.local.get(null);
      return { dictionaries: stored.dictionaryState?.revision, options: stored.options?.revision,
        rows: Object.keys(stored).filter(key => key.startsWith("lookupStats:")) };
    });
    const beforeReset = await readLookupStatistics(settings);
    const storedBeforeReset = await storedState();
    await popup.lookupStatistics("remember");
    await settings.bringToFront();
    await showSettingsSection(settings, "lookup");
    let resetDialog = null;
    const acceptReset = async (dialog) => { resetDialog = dialog.message(); await dialog.accept(); };
    settings.on("dialog", acceptReset);
    await settings.click("#lookup-counts-reset");
    const resetStatus = await settings.waitForFunction(() => {
      const status = document.getElementById("lookup-counts-reset-status");
      return status.classList.contains("is-ready") || status.classList.contains("is-error") ? status.textContent : false;
    }, { polling: 100, timeout: 10_000 }).then((handle) => handle.jsonValue()).catch(error => `no outcome: ${error.message}`);
    settings.off("dialog", acceptReset);
    const zeroed = await waitForLookupStatistics(popup, value => value?.text.includes("Looked up 0 times"));
    const afterReset = await readLookupStatistics(settings);
    const storedAfterReset = await storedState();
    const nextDefinition = await freshLookup();
    const counted = await waitForLookupStatistics(popup, value => value?.text.includes("Looked up 1 time"));
    const afterNext = await readLookupStatistics(settings);
    check(
      "Reset lookup counts refreshes the open popup to zero without recording and the next lookup counts 1",
      resetDialog?.startsWith("Reset lookup counts for every word?")
        && resetStatus === "Lookup counts reset."
        && beforeReset.statistics?.lookupCount > 0 && storedBeforeReset.rows.length > 0
        && zeroed?.samePopup === true && zeroed.sameLine === true && zeroed.hidden === false
        && afterReset.statistics?.lookupCount === 0
        && afterReset.descriptor?.generation !== beforeReset.descriptor?.generation
        && afterReset.descriptor?.revision === beforeReset.descriptor.revision + 1
        && storedAfterReset.rows.length === 0
        && storedAfterReset.dictionaries === storedBeforeReset.dictionaries
        && storedAfterReset.options === storedBeforeReset.options
        && nextDefinition?.plain.includes("食べる") && counted?.hidden === false
        && afterNext.statistics?.lookupCount === 1
        && afterNext.descriptor?.generation === afterReset.descriptor.generation,
      JSON.stringify({ resetDialog, resetStatus, beforeReset, storedBeforeReset, zeroed, afterReset,
        storedAfterReset, counted, afterNext }),
    );
    if (process.env.HACHIDORI_LOOKUP_STATS_SCREENSHOT) {
      await settings.bringToFront();
      await showSettingsSection(settings, "lookup");
      await settings.$eval("#lookup-history-settings", node => node.scrollIntoView({ block: "center" }));
      await settings.screenshot({ path: process.env.HACHIDORI_LOOKUP_STATS_SCREENSHOT });
    }
  } finally {
    await updateSettingsControls(settings, original).catch(error => {
      diagnostics.push(`[lookup statistics restore] ${error?.stack ?? error}`);
    });
    await popup.lookupStatistics("cleanup").catch(() => {});
    await tab.bringToFront();
    if (!popup.visible(await popup.state())) await hoverForPopup(tab, popup, "#verb");
  }
}

async function waitForDefinitionBlur(popup, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < deadline) {
    current = await popup.definitionBlur();
    if (predicate(current)) return current;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  return current;
}

async function checkDefinitionBlur({ settings, tab, popup }) {
  const controls = ["opt-lookup-counts", "opt-blur-count", "opt-blur-anki", "opt-blur-frequency",
    "opt-blur-frequency-dictionary", "opt-blur-frequency-order", "opt-blur-frequency-threshold",
    "opt-blur-direction", "opt-blur-threshold", "opt-blur-reveal", "opt-blur-delay", "opt-audio-autoplay"];
  const original = await readSettingsControls(settings, controls);
  const freshLookup = async () => {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    return hoverForPopup(tab, popup, "#verb");
  };
  // The decision is made once the count line is painted from the same reply.
  const decided = () => waitForDefinitionBlur(popup, value => value?.countText.includes("Looked up"));
  try {
    const before = await readLookupStatistics(settings);
    const threshold = before.statistics.lookupCount + 1;
    await updateSettingsControls(settings, {
      "opt-lookup-counts": true, "opt-audio-autoplay": true, "opt-blur-count": true,
      "opt-blur-anki": false, "opt-blur-frequency": false,
      "opt-blur-direction": "atLeast", "opt-blur-threshold": String(threshold), "opt-blur-reveal": "hover",
    });
    const qualifyingDefinition = await freshLookup();
    const qualifying = await decided();
    const pendingOrBlurred = await popup.definitionBlur();
    await tab.mouse.move(qualifying.definitionsPoint.x, qualifying.definitionsPoint.y);
    const hovered = await waitForDefinitionBlur(popup, value => value?.state === "revealed" && value.audioAttempted, 5_000);
    await updateSettingsControls(settings, { "opt-blur-direction": "below" });
    const revealedDefinition = await freshLookup();
    const notQualifying = await decided();
    const autoplayed = await waitForDefinitionBlur(popup, value => value?.audioAttempted, 5_000);
    check("definition blur follows real lookup counts and settings and holds autoplay until blurred results are revealed",
      qualifyingDefinition?.plain.includes("食べる")
        && qualifying?.state === "blurred" && qualifying.definitionsState === "blurred"
        && qualifying.countText.includes(`Looked up ${threshold}`)
        && !pendingOrBlurred.audioAttempted
        && hovered?.state === "revealed" && hovered.audioAttempted
        && revealedDefinition?.plain.includes("食べる")
        && notQualifying?.state === "revealed" && notQualifying.countText.includes(`Looked up ${threshold + 1}`)
        && autoplayed?.audioAttempted,
      JSON.stringify({ threshold, qualifying, pendingOrBlurred, hovered, notQualifying, autoplayed }));

    const beforeFrequency = await readLookupStatistics(settings);
    await updateSettingsControls(settings, {
      "opt-lookup-counts": false, "opt-audio-autoplay": false, "opt-blur-count": false,
      "opt-blur-anki": false, "opt-blur-frequency": true,
      "opt-blur-frequency-dictionary": "hachidori-fixture", "opt-blur-frequency-order": "auto",
      "opt-blur-frequency-threshold": "100", "opt-blur-reveal": "hover",
    });
    const frequencyDefinition = await freshLookup();
    const frequencyBlurred = await waitForDefinitionBlur(popup, value => value?.state === "blurred");
    await updateSettingsControls(settings, { "opt-blur-frequency-threshold": "143" });
    const outsideDefinition = await freshLookup();
    const frequencyOpen = await waitForDefinitionBlur(popup, value => value?.state === "revealed");
    const afterFrequency = await readLookupStatistics(settings);
    check("frequency blur uses native fixture values without recording counts or waiting for another signal",
      frequencyDefinition?.plain.includes("食べる") && frequencyBlurred?.state === "blurred"
        && frequencyBlurred.definitionsState === "blurred" && frequencyBlurred.countText === ""
        && outsideDefinition?.plain.includes("食べる") && frequencyOpen?.state === "revealed"
        && beforeFrequency.ok && afterFrequency.ok
        && beforeFrequency.descriptor.generation === afterFrequency.descriptor.generation
        && beforeFrequency.descriptor.revision === afterFrequency.descriptor.revision,
      JSON.stringify({ frequencyBlurred, frequencyOpen, beforeFrequency, afterFrequency }));

    await updateSettingsControls(settings, {
      "opt-lookup-counts": true, "opt-blur-count": true, "opt-blur-frequency": false,
      "opt-audio-autoplay": false, "opt-blur-direction": "atLeast", "opt-blur-threshold": "1",
      "opt-blur-reveal": "timed", "opt-blur-delay": "1",
    });
    const timedStart = Date.now();
    await freshLookup();
    const timedBlurred = await decided();
    const timedRevealed = await waitForDefinitionBlur(popup, value => value?.state === "revealed", 5_000);
    const elapsedMs = Date.now() - timedStart;
    await updateSettingsControls(settings, { "opt-blur-delay": "3600" });
    await freshLookup();
    const longBlurred = await decided();
    await popup.lookupStatistics("remember");
    await updateSettingsControls(settings, { "opt-blur-count": false });
    const disabled = await waitForDefinitionBlur(popup, value => value?.state === "revealed", 5_000);
    const retained = await popup.lookupStatistics();
    check("blurred definitions reveal on hover, at the timed deadline and at once when blur is disabled",
      hovered?.state === "revealed"
        && timedBlurred?.state === "blurred" && timedRevealed?.state === "revealed"
        && elapsedMs >= 1000 && elapsedMs < 4000
        && longBlurred?.state === "blurred" && disabled?.state === "revealed"
        && retained?.samePopup === true && retained.samePanel === true && retained.popupHidden === false,
      JSON.stringify({ hovered, timedBlurred, timedRevealed, elapsedMs, longBlurred, disabled, retained }));
  } finally {
    await popup.lookupStatistics("cleanup").catch(() => {});
    await updateSettingsControls(settings, original).catch(error => {
      diagnostics.push(`[definition blur restore] ${error?.stack ?? error}`);
    });
    await tab.bringToFront();
    if (!popup.visible(await popup.state())) await hoverForPopup(tab, popup, "#verb");
  }
}

async function checkAnkiMatureDefinitionBlur({ browser, settings, tab, popup, watchedServiceWorkers }) {
  const alarmName = "hachidori-anki-index";
  const intervalMs = 30 * 60 * 1000;
  const originalViewport = settings.viewport();
  const original = await readSettingsControls(settings, ["opt-lookup-counts", "opt-blur-count", "opt-blur-anki",
    "opt-blur-frequency", "opt-blur-frequency-dictionary", "opt-blur-frequency-order",
    "opt-blur-frequency-threshold", "opt-blur-direction", "opt-blur-threshold",
    "opt-blur-reveal", "opt-blur-delay", "opt-audio-autoplay"]);
  const originalAnki = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options.anki);
  const calls = [];
  const refreshCandidateQuery = "\"note:Basic\"";
  let mode = "held-mature", releaseIndex = null;
  // Cover the entire endpoint, including mining discovery and preflight, so
  // fixtures never depend on the user's Anki notes or scheduling data.
  const route = { requests: 0, async respond(request) {
    if (mode === "offline") {
      calls.push(JSON.parse(request.postData));
      return { body: "Anki unavailable", status: 503, contentType: "text/plain" };
    }
    const reply = await answerAnkiConnect(JSON.parse(request.postData), async (action, params) => {
      calls.push({ action, params });
      if (action === "notesInfo") {
        return mode.endsWith("mature") ? [{ noteId: 70, modelName: "Basic", cards: [70],
          fields: { Front: { value: "食べる", order: 0 }, Back: { value: "to eat", order: 1 } } }] : [];
      }
      if (action === "findNotes") {
        if (params.query === refreshCandidateQuery && mode.startsWith("held-")) {
          await new Promise(resolve => { releaseIndex = resolve; });
        }
        return mode.endsWith("mature") && (params.query === refreshCandidateQuery
          || params.query === `${refreshCandidateQuery} is:review -is:learn prop:ivl>=21`) ? [70] : [];
      }
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelFieldNames") return ["Front", "Back"];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      throw new Error(`Unexpected Anki index action ${action}`);
    });
    return { body: JSON.stringify(reply), status: 200, contentType: "application/json" };
  } };
  const routes = new Map([["http://127.0.0.1:8765/", route]]);
  let worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  let session = await interceptFetches(worker, routes, "anki-index");
  const offscreen = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
  // The offscreen Fetch domain also covers its dedicated refresh worker.
  const refreshSession = await interceptFetches(offscreen, routes, "anki-index-refresh");
  const refreshCalls = () => calls.filter(call => call.action === "findNotes"
    && call.params.query === refreshCandidateQuery).length;
  const readIndex = () => settings.evaluate(async () => (await chrome.storage.local.get("ankiDuplicateIndex")).ankiDuplicateIndex);
  const waitForSnapshot = (mature, previousRefresh = null) => settings.waitForFunction(async ({ mature, previousRefresh }) => {
    const { ankiDuplicateIndex: index } = await chrome.storage.local.get("ankiDuplicateIndex");
    const row = index?.snapshot?.rows.find(([word]) => word === "食べる");
    return index?.snapshot && index.snapshot.refreshedAt !== previousRefresh
      && (row?.[1] === true) === mature ? index : false;
  }, { timeout: 10_000, polling: 50 }, { mature, previousRefresh }).then(handle => handle.jsonValue());
  const releaseRefresh = () => { releaseIndex?.(); releaseIndex = null; };
  const triggerRefresh = () => settings.evaluate(async ({ alarmName, intervalMs }) => {
    const { ankiDuplicateIndex } = await chrome.storage.local.get("ankiDuplicateIndex");
    // Advance only the stored attempt deadline; Chrome still delivers a real
    // alarm through the production worker's onAlarm listener.
    await chrome.storage.local.set({ ankiDuplicateIndex: { ...ankiDuplicateIndex,
      attempt: { ...ankiDuplicateIndex.attempt, startedAt: Date.now() - intervalMs } } });
    await chrome.alarms.create(alarmName, { when: Date.now() + 100 });
  }, { alarmName, intervalMs });
  const freshLookup = async () => {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    return hoverForPopup(tab, popup, "#verb");
  };
  try {
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await updateSettingsControls(settings, {
      "opt-lookup-counts": false, "opt-blur-count": false, "opt-blur-anki": false,
      "opt-blur-frequency": false, "opt-audio-autoplay": true, "opt-blur-reveal": "hover",
    });
    await settings.evaluate(async () => {
      const { options } = await chrome.storage.local.get("options");
      const defaults = HDReaderOptions.normaliseOptions({}).anki;
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
        options: { anki: { ...defaults, model: "Basic", fields: { ...defaults.fields, expression: "Front" } } } });
      if (!reply.ok) throw new Error(reply.error);
    });
    await updateSettingsControls(settings, { "opt-blur-anki": true });
    // Keep the main Settings page's custom source draft alive for later tests.
    const reloadedSettings = await browser.newPage();
    let persisted;
    try {
      await reloadedSettings.goto(settings.url(), { waitUntil: "domcontentloaded" });
      await reloadedSettings.reload({ waitUntil: "domcontentloaded" });
      await reloadedSettings.waitForFunction(() => document.getElementById("opt-blur-anki").checked);
      persisted = await reloadedSettings.evaluate(async () => {
        const { options } = await chrome.storage.local.get("options");
        return { enabled: options.definitionBlurAnkiMature, counts: options.showLookupCounts, countBlur: options.definitionBlurCountEnabled,
          checked: document.getElementById("opt-blur-anki").checked,
          revealDisabled: document.getElementById("opt-blur-reveal").disabled };
      });
    } finally { await reloadedSettings.close(); }
    check("the Anki maturity blur condition persists independently of lookup counts",
      original["opt-blur-anki"] === false && persisted.enabled && persisted.checked
        && !persisted.counts && !persisted.countBlur && !persisted.revealDisabled,
      JSON.stringify({ original, persisted }));

    const before = await readLookupStatistics(settings);
    const coldDefinition = await freshLookup();
    const cold = await waitForDefinitionBlur(popup, value => releaseIndex !== null
      && value?.state === "revealed" && value.audioAttempted, 5_000);
    const coldIndex = await readIndex();
    check("a cold Anki duplicate index leaves the popup responsive while its first refresh is held",
      coldDefinition?.plain.includes("食べる") && popup.visible(coldDefinition)
        && releaseIndex !== null && cold?.state === "revealed" && cold.audioAttempted
        // A snapshot for a previous Anki configuration is not a warm cache
        // for this source; its refresh is still the first one for this key.
        && (!coldIndex?.snapshot || coldIndex.snapshot.sourceKey !== coldIndex.attempt?.sourceKey)
        && refreshCalls() === 1,
      JSON.stringify({ cold, coldIndex, calls }));
    releaseRefresh();
    const initialIndex = await waitForSnapshot(true);
    const matureDefinition = await freshLookup();
    const mature = await waitForDefinitionBlur(popup, value => value?.state === "blurred");
    await tab.mouse.move(mature.definitionsPoint.x, mature.definitionsPoint.y);
    const hovered = await waitForDefinitionBlur(popup, value => value?.state === "revealed" && value.audioAttempted, 5_000);
    await freshLookup();
    const repeated = await waitForDefinitionBlur(popup, value => value?.state === "blurred");
    const after = await readLookupStatistics(settings);
    const noteQuery = calls.find(call => call.action === "findNotes"
      && call.params.query === refreshCandidateQuery)?.params.query ?? "";
    const matureQuery = calls.find(call => call.action === "findNotes"
      && call.params.query.includes("is:review"))?.params.query ?? "";
    check("cached mature definitions hold pronunciation until revealed and repeated lookups make no Anki requests",
      matureDefinition?.plain.includes("食べる") && mature?.state === "blurred" && mature.definitionsState === "blurred"
        && !mature.audioAttempted && hovered?.state === "revealed" && hovered.audioAttempted
        && repeated?.state === "blurred" && refreshCalls() === 1 && !calls.some(call => call.action === "findCards")
        && before.ok && after.ok && before.statistics === null && after.statistics === null
        && before.descriptor.generation === after.descriptor.generation && before.descriptor.revision === after.descriptor.revision
        && matureQuery.includes("is:review") && matureQuery.includes("-is:learn") && matureQuery.includes("prop:ivl>=21")
        && noteQuery.includes("note:Basic") && matureQuery.includes("note:Basic")
        && !noteQuery.includes("Front:") && !noteQuery.includes("deck:"),
      JSON.stringify({ mature, hovered, repeated, before, after, noteQuery, matureQuery, calls }));

    mode = "held-empty";
    await triggerRefresh();
    await freshLookup();
    const refreshing = await waitForDefinitionBlur(popup, value => releaseIndex !== null && value?.state === "blurred");
    await popup.lookupStatistics("remember");
    releaseRefresh();
    const emptyIndex = await waitForSnapshot(false, initialIndex.snapshot.refreshedAt);
    const retained = await popup.lookupStatistics();
    const afterRefresh = await popup.definitionBlur();
    const nonmatureDefinition = await freshLookup();
    const nonmature = await waitForDefinitionBlur(popup, value => value?.state === "revealed" && value.audioAttempted, 5_000);
    check("a scheduled index refresh preserves the current popup and updates only new lookups",
      refreshing?.state === "blurred" && !refreshing.audioAttempted
        && retained?.samePopup && retained.samePanel && afterRefresh?.state === "blurred"
        && emptyIndex.snapshot.rows.length === 0 && nonmatureDefinition?.plain.includes("食べる")
        && nonmature?.state === "revealed" && nonmature.audioAttempted && refreshCalls() === 2,
      JSON.stringify({ refreshing, retained, afterRefresh, emptyIndex, nonmature }));

    mode = "held-mature";
    await triggerRefresh();
    await waitForDefinitionBlur(popup, () => releaseIndex !== null);
    const heldOnDisable = releaseIndex !== null;
    await updateSettingsControls(settings, { "opt-blur-anki": false });
    releaseRefresh();
    const refreshedWhileDisabled = await waitForSnapshot(true, emptyIndex.snapshot.refreshedAt);
    const disabledAlarm = await settings.evaluate(name => chrome.alarms.get(name), alarmName);
    const callsBeforeReenable = refreshCalls();
    await updateSettingsControls(settings, { "opt-blur-anki": true });
    await freshLookup();
    const reenabled = await waitForDefinitionBlur(popup, value => value?.state === "blurred");
    const reenabledIndex = await readIndex();
    check("the duplicate index keeps refreshing while maturity blur is disabled and re-enabling uses it without Anki",
      heldOnDisable && disabledAlarm?.scheduledTime === refreshedWhileDisabled.attempt.startedAt + intervalMs
        && refreshedWhileDisabled.snapshot.rows.some(([word, mature]) => word === "食べる" && mature)
        && reenabled?.state === "blurred" && refreshCalls() === callsBeforeReenable
        && JSON.stringify(reenabledIndex) === JSON.stringify(refreshedWhileDisabled),
      JSON.stringify({ heldOnDisable, disabledAlarm, refreshedWhileDisabled, reenabled, reenabledIndex, calls }));

    mode = "offline";
    await triggerRefresh();
    await freshLookup();
    const offline = await waitForDefinitionBlur(popup, value => refreshCalls() === 4 && value?.state === "blurred");
    const retry = await settings.waitForFunction(async ({ alarmName, intervalMs, previousAttempt }) => {
      const { ankiDuplicateIndex: index } = await chrome.storage.local.get("ankiDuplicateIndex");
      const alarm = await chrome.alarms.get(alarmName);
      return index.attempt.startedAt > previousAttempt && alarm?.scheduledTime === index.attempt.startedAt + intervalMs
        ? { index, alarm } : false;
    }, { timeout: 10_000, polling: 50 }, { alarmName, intervalMs, previousAttempt: reenabledIndex.attempt.startedAt })
      .then(handle => handle.jsonValue());
    // Leave a mature snapshot and a failed-attempt deadline on disk, then stop
    // the actual worker. Its replacement must serve the cache and recover the
    // missing alarm without pulling Anki again or retrying the recent failure.
    const restartState = retry;
    const callsBeforeRestart = refreshCalls();
    await settings.evaluate(name => chrome.alarms.clear(name), alarmName);
    await session.send("Fetch.disable");
    await session.detach();
    session = null;
    const watchedWorker = watchedServiceWorkers.get(worker);
    if (watchedWorker) {
      await watchedWorker.client.detach();
      watchedServiceWorkers.delete(worker);
    }
    const browserCdp = await browser.target().createCDPSession();
    const serviceWorkerCdp = await settings.createCDPSession();
    const runningPromise = waitForRunningServiceWorker(serviceWorkerCdp, worker.url());
    await serviceWorkerCdp.send("ServiceWorker.enable");
    const running = await runningPromise;
    if (!running) throw new Error("Anki index worker was not running before restart");
    await serviceWorkerCdp.send("ServiceWorker.stopWorker", { versionId: running.versionId });
    const stopped = await waitForCdpTargetGone(browserCdp, running.targetId);
    const replacementPromise = browser.waitForTarget(target => target.type() === "service_worker"
      && target.url() === worker.url() && target !== worker).then(async target => {
      session = await interceptFetches(target, routes, "anki-index-restarted");
      return target;
    });
    const cachedReply = await settings.evaluate(() => chrome.runtime.sendMessage({
      target: "hachidori-anki", type: "hd_anki_maturity", request: { term: { expression: "食べる" } } }));
    worker = await replacementPromise;
    const restored = await settings.waitForFunction(async ({ alarmName, expectedTime }) => {
      const alarm = await chrome.alarms.get(alarmName);
      return alarm?.scheduledTime === expectedTime ? alarm : false;
    }, { timeout: 10_000, polling: 50 }, { alarmName, expectedTime: restartState.alarm.scheduledTime })
      .then(handle => handle.jsonValue());
    const restoredIndex = await readIndex();
    await serviceWorkerCdp.send("ServiceWorker.disable");
    await serviceWorkerCdp.detach();
    await browserCdp.detach();
    check("worker restart restores indexed maturity and the missing thirty-minute alarm without fetching",
      stopped && cachedReply.mature === true && restored.scheduledTime === restartState.alarm.scheduledTime
        && JSON.stringify(restoredIndex) === JSON.stringify(restartState.index) && refreshCalls() === callsBeforeRestart,
      JSON.stringify({ stopped, cachedReply, restored, restoredIndex, restartState, callsBeforeRestart, calls }));

    await updateSettingsControls(settings, { "opt-lookup-counts": true, "opt-blur-count": true,
      "opt-blur-direction": "atLeast", "opt-blur-threshold": "1" });
    const cachedMiss = await settings.evaluate(() => chrome.runtime.sendMessage({
      target: "hachidori-anki", type: "hd_anki_maturity", request: { term: { expression: "not in the fixture" } } }));
    // An empty new snapshot lets this visit prove the independent count branch.
    mode = "empty";
    await triggerRefresh();
    await waitForSnapshot(false, reenabledIndex.snapshot.refreshedAt);
    await freshLookup();
    const countQualified = await waitForDefinitionBlur(popup, value => value?.state === "blurred" && value.countText.includes("Looked up"));
    check("an unavailable Anki refresh retains cached maturity and independent count blur",
      offline?.state === "blurred" && !offline.audioAttempted
        && JSON.stringify(retry.index.snapshot) === JSON.stringify(reenabledIndex.snapshot)
        && cachedMiss.mature === false && countQualified?.state === "blurred" && !countQualified.audioAttempted
        && calls.every(call => ["notesInfo", "findNotes", "deckNames", "modelNames", "modelFieldNames",
          "canAddNotesWithErrorDetail"].includes(call.action)),
      JSON.stringify({ offline, retry, cachedMiss, countQualified, calls }));

    if (process.env.HACHIDORI_DEFINITION_BLUR_SCREENSHOT
        || process.env.HACHIDORI_DEFINITION_BLUR_NARROW_SCREENSHOT) {
      await updateSettingsControls(settings, {
        "opt-lookup-counts": true, "opt-blur-count": true, "opt-blur-anki": true,
        "opt-blur-frequency": true, "opt-blur-frequency-dictionary": "hachidori-fixture",
        "opt-blur-frequency-order": "auto", "opt-blur-frequency-threshold": "10000",
        "opt-blur-threshold": "5", "opt-blur-reveal": "timed", "opt-blur-delay": "5",
      });
      await settings.bringToFront();
      await showSettingsSection(settings, "lookup");
      const card = await settings.$("#definition-blur-settings");
      if (process.env.HACHIDORI_DEFINITION_BLUR_SCREENSHOT) {
        await settings.setViewport({ width: 960, height: 1100 });
        await card.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
        await settings.evaluate(() => new Promise(requestAnimationFrame));
        await card.screenshot({ path: process.env.HACHIDORI_DEFINITION_BLUR_SCREENSHOT });
      }
      if (process.env.HACHIDORI_DEFINITION_BLUR_NARROW_SCREENSHOT) {
        await settings.setViewport({ width: 420, height: 1600 });
        await card.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
        await settings.evaluate(() => new Promise(requestAnimationFrame));
        await card.screenshot({ path: process.env.HACHIDORI_DEFINITION_BLUR_NARROW_SCREENSHOT });
      }
    }
  } finally {
    releaseRefresh();
    await popup.lookupStatistics("cleanup").catch(() => {});
    await updateSettingsControls(settings, original);
    await settings.evaluate(async anki => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision, options: { anki } });
      if (!reply.ok) throw new Error(reply.error);
    }, originalAnki);
    // The restarted service worker can retire again before fixture cleanup.
    await session?.detach().catch(() => {});
    await refreshSession.detach().catch(() => {});
    await settings.setViewport(originalViewport);
    await tab.bringToFront();
    if (!popup.visible(await popup.state())) await hoverForPopup(tab, popup, "#verb");
  }
}

async function checkWordHighlighting({ browser, settings, pageUrl }) {
  const controls = ["opt-experimental-wordHighlighting", "opt-word-highlight", "opt-word-highlight-unknown",
    "opt-word-highlight-learning", "opt-word-highlight-known", "opt-word-highlight-style"];
  const original = await readSettingsControls(settings, controls);
  const originalAnki = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options.anki);
  const originalKeybinds = await settings.evaluate(async () =>
    HDReaderOptions.normaliseOptions((await chrome.storage.local.get("options")).options).keybinds);
  // A collection with no notes until the popup adds one; nothing is mature.
  const notes = new Map();
  const actions = [];
  const fronts = query => [...query.matchAll(/"front:((?:\\.|[^"])*)"/giu)].map(match => match[1].replace(/\\(.)/gu, "$1"));
  setWordHighlightAnki(async (action, params) => {
    actions.push(action);
    if (action === "deckNames") return ["Default"];
    if (action === "modelNames") return ["Basic"];
    if (action === "modelNamesAndIds") return { Basic: 1 };
    if (action === "modelFieldNames") return ["Front", "Back"];
    if (action === "canAddNotesWithErrorDetail") {
      return params.notes.map(note => ({ canAdd: ![...notes.values()].some(fields => fields.Front === note.fields.Front), error: null }));
    }
    if (action === "addNote") {
      notes.set(notes.size + 1, params.note.fields);
      return notes.size;
    }
    if (action === "findNotes") {
      if (params.query.endsWith(" is:review -is:learn prop:ivl>=21")) return [];
      const wanted = fronts(params.query);
      return [...notes].filter(([, fields]) => wanted.length === 0 || wanted.includes(fields.Front)).map(([noteId]) => noteId);
    }
    if (action === "notesInfo") {
      return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [noteId],
        fields: Object.fromEntries(Object.entries(notes.get(noteId)).map(([field, value], order) => [field, { value, order }])) }));
    }
    if (action === "getMediaFilesNames") return [];
    throw new Error(`Unexpected word highlighting Anki action ${action}`);
  });
  const tab = await browser.newPage();
  const popup = await popupReader(tab);
  const marks = () => tab.evaluate(names => Object.fromEntries(Object.entries(names).flatMap(([status, name]) => {
    const highlight = CSS.highlights.get(name);
    return highlight ? [[status, [...highlight].map(range => range.startContainer.data.slice(range.startOffset, range.endOffset))]] : [];
  })), Object.fromEntries(["unknown", "learning", "known"].map(status => [status, WORD_HIGHLIGHT_NAME(status)])));
  const waitFor = async (read, predicate, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    let current = await read();
    while (!predicate(current) && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      current = await read();
    }
    return current;
  };
  const waitForMarks = (predicate, timeout) => waitFor(marks, predicate, timeout);
  // The page's markup without Hachidori's own popup host.
  const markup = () => tab.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    for (const host of clone.querySelectorAll("hachidori-host")) host.remove();
    return clone.outerHTML;
  });
  // The distinct colours drawn just below a word, where its underline is.
  const underline = selector => tab.evaluate(async query => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(query));
    const rect = range.getBoundingClientRect();
    await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    return { left: rect.left, right: rect.right, top: rect.bottom - 12, bottom: rect.bottom + 14 };
  }, selector).then(async strip => {
    const png = await tab.screenshot({ encoding: "base64" });
    return tab.evaluate(async ({ png, strip }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / innerWidth;
      const colours = new Set();
      for (let y = Math.round(strip.top * scale); y < strip.bottom * scale; y += 1) {
        for (let x = Math.round(strip.left * scale); x < strip.right * scale; x += 2) {
          colours.add([...context.getImageData(x, y, 1, 1).data.slice(0, 3)].join(","));
        }
      }
      // The status colours word-highlights.js wrote for this page.
      const rules = [...document.adoptedStyleSheets].flatMap(sheet => [...sheet.cssRules])
        .flatMap(rule => rule.cssRules ? [...rule.cssRules] : [rule])
        .filter(rule => rule.selectorText?.startsWith("::highlight(hd-word-"));
      const colour = value => { const probe = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true }); probe.fillStyle = value;
        probe.fillRect(0, 0, 1, 1); return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
      return { colours: [...colours].map(value => value.split(",").map(Number)),
        statuses: Object.fromEntries(rules.map(rule => [/hd-word-(\w+)/u.exec(rule.selectorText)[1],
          colour(rule.style.textDecorationColor)])) };
    }, { png, strip });
  });
  const draws = (sample, status) => sample.statuses[status] !== undefined
    && sample.colours.some(pixel => pixel.every((value, index) => Math.abs(value - sample.statuses[status][index]) <= 3));
  try {
    await tab.setViewport({ width: 1100, height: 700 });
    await tab.goto(new URL("words", pageUrl).href, { waitUntil: "load" });
    const before = await markup();
    await tab.evaluate(() => {
      window.__wordHighlightMutations = [];
      new MutationObserver(records => {
        for (const record of records) {
          const ours = record.target.closest?.("hachidori-host")
            || (record.type === "childList" && [...record.addedNodes, ...record.removedNodes]
              .every(node => node.localName === "hachidori-host"));
          if (!ours) window.__wordHighlightMutations.push(`${record.type} ${record.target.nodeName}`);
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await settings.evaluate(async url => {
      const { options } = await chrome.storage.local.get("options");
      const defaults = HDReaderOptions.normaliseOptions({}).anki;
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
        options: { anki: { ...defaults, url, model: "Basic", fields: { ...defaults.fields, expression: "Front" } } } });
      if (!reply.ok) throw new Error(reply.error);
    }, new URL(WORD_HIGHLIGHT_ANKI_PATH, pageUrl).href);
    // A gated section opens only once its experimental switch is on.
    await updateSettingsControls(settings, { "opt-experimental-wordHighlighting": true });
    await updateSettingsControls(settings, { "opt-word-highlight": true, "opt-word-highlight-unknown": true,
      "opt-word-highlight-learning": true, "opt-word-highlight-known": false, "opt-word-highlight-style": "underline" });
    await tab.bringToFront();
    const shown = await waitForMarks(current => ["食", "べたかった", "漢字", "読む"]
      .every(text => current.unknown?.includes(text)));
    const after = await markup();
    const mutations = await tab.evaluate(() => window.__wordHighlightMutations.slice());
    await tab.evaluate(() => document.getElementById("far").scrollIntoView({ block: "center" }));
    const scrolled = await waitForMarks(current => current.unknown?.includes("ありがとう"));
    await tab.evaluate(() => {
      const line = document.createElement("p");
      line.id = "arrived";
      line.textContent = "読んだ";
      document.getElementById("far").after(line);
    });
    const arrived = await waitForMarks(current => current.unknown?.includes("読んだ"));
    check(WORD_HIGHLIGHT_CHECKS[0],
      JSON.stringify(shown.unknown) === JSON.stringify(["食", "べたかった", "漢字", "読む"])
        && Object.keys(shown).join() === "unknown,learning"
        // The far line is marked once it scrolls into view, and the first
        // line, now a long way above, keeps no ranges.
        && JSON.stringify(scrolled.unknown) === JSON.stringify(["ありがとう"])
        && JSON.stringify(arrived.unknown) === JSON.stringify(["ありがとう", "読んだ"])
        && before === after && mutations.length === 0,
      JSON.stringify({ shown, scrolled, arrived, mutations, sameMarkup: before === after }));

    await tab.evaluate(() => window.scrollTo(0, 0));
    const red = await underline("#line > span:last-child");
    const verb = await hoverForPopup(tab, popup, "#words-verb");
    const ready = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await popup.anki();
        if (state?.controls?.[0]?.action === "add" && !state.controls[0].disabled) return state;
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      return popup.anki();
    })();
    await popup.click(".gsm-hoshidicts-mine-button");
    const added = await waitForMarks(current => current.learning?.includes("べたかった"));
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    const orange = await underline("#words-verb");
    const unchanged = await underline("#line > span:last-child");
    if (process.env.HACHIDORI_WORD_HIGHLIGHT_SCREENSHOT) {
      await tab.screenshot({ path: process.env.HACHIDORI_WORD_HIGHLIGHT_SCREENSHOT, clip: { x: 0, y: 0, width: 1100, height: 180 } });
    }
    check(WORD_HIGHLIGHT_CHECKS[1],
      verb?.plain.includes("食べる") && ready?.controls?.[0]?.action === "add"
        && notes.size === 1 && [...notes.values()][0].Front === "食べる"
        && JSON.stringify(added.learning) === JSON.stringify(["食", "べたかった"])
        && !added.unknown.includes("べたかった") && added.unknown.includes("漢字")
        && draws(red, "unknown") && !draws(red, "learning")
        && draws(orange, "learning") && !draws(orange, "unknown") && draws(unchanged, "unknown")
        && !actions.includes("findCards"),
      JSON.stringify({ verb: verb?.plain, ready: ready?.controls?.[0], notes: [...notes.values()], added, actions,
        red: red.statuses, orange: orange.statuses }));

    // Ignore and Mark as known (#520 phase 4) write the worker's overrides,
    // whose storage event re-marks the page; known and ignored words are left
    // unmarked by default. Alt+K is bound to Mark word as known for the check.
    const overrides = () => settings.evaluate(async () => (await chrome.storage.local.get("wordStatusOverrides")).wordStatusOverrides);
    const pressedState = async () => Object.fromEntries(((await popup.wordStatus())?.buttons ?? [])
      .map(button => [button.status, button.pressed]));
    await settings.evaluate(async () => {
      const { options } = await chrome.storage.local.get("options");
      const keybinds = [...HDReaderOptions.normaliseOptions(options).keybinds, { action: "markWordKnown", argument: "",
        key: "KeyK", modifiers: ["alt"], scopes: ["popup"], enabled: true }];
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options.revision, options: { keybinds } });
      if (!reply.ok) throw new Error(reply.error);
    });
    await tab.bringToFront();
    const kanji = await hoverForPopup(tab, popup, "#line > span:last-child", { accept: state => state.plain.includes("漢字") });
    const row = await waitFor(() => popup.wordStatus(), current => current?.buttons.length === 2);
    await popup.click('.gsm-hoshidicts-primary-header [data-word-status="ignored"]');
    const ignoredMarks = await waitForMarks(current => !current.unknown?.includes("漢字"));
    const ignoredStored = await overrides();
    const ignoredPressed = await waitFor(pressedState, current => current.ignored === "true");
    await tab.keyboard.down("Alt");
    await tab.keyboard.press("KeyK");
    await tab.keyboard.up("Alt");
    const knownStored = await waitFor(overrides, current => current?.known?.includes("漢字"));
    const knownPressed = await waitFor(pressedState, current => current.known === "true");
    const knownMarks = await marks();
    await popup.click('.gsm-hoshidicts-primary-header [data-word-status="known"]');
    const clearedMarks = await waitForMarks(current => current.unknown?.includes("漢字"));
    const clearedStored = await overrides();
    const clearedPressed = await waitFor(pressedState, current => current.known === "false");
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    check(WORD_HIGHLIGHT_CHECKS[2],
      kanji?.plain.includes("漢字")
        // After Anki and pronunciation, before the pencil and any custom buttons.
        && JSON.stringify(row?.order.filter(kind => ["add", "audio", "known", "ignored", "note"].includes(kind)))
          === JSON.stringify(["add", "audio", "known", "ignored", "note"])
        && JSON.stringify(row?.buttons.map(button => [button.status, button.label, button.pressed]))
          === JSON.stringify([["known", "Mark 漢字 as known", "false"], ["ignored", "Ignore 漢字", "false"]])
        && !ignoredMarks.unknown?.includes("漢字") && ignoredMarks.unknown?.includes("読む")
        && JSON.stringify([ignoredStored?.known, ignoredStored?.ignored]) === JSON.stringify([[], ["漢字"]])
        && JSON.stringify(ignoredPressed) === JSON.stringify({ known: "false", ignored: "true" })
        && JSON.stringify([knownStored?.known, knownStored?.ignored]) === JSON.stringify([["漢字"], []])
        && JSON.stringify(knownPressed) === JSON.stringify({ known: "true", ignored: "false" })
        && !knownMarks.unknown?.includes("漢字") && !knownMarks.known
        && clearedMarks.unknown?.includes("漢字")
        && JSON.stringify([clearedStored?.known, clearedStored?.ignored]) === JSON.stringify([[], []])
        && clearedStored.revision === knownStored.revision + 1
        && JSON.stringify(clearedPressed) === JSON.stringify({ known: "false", ignored: "false" }),
      JSON.stringify({ kanji: kanji?.plain, row, ignoredMarks, ignoredStored, ignoredPressed, knownStored, knownPressed,
        knownMarks, clearedMarks, clearedStored, clearedPressed }));

    await updateSettingsControls(settings, { "opt-word-highlight": false });
    const cleared = await waitForMarks(current => Object.keys(current).length === 0, 5_000);
    const kept = await settings.evaluate(async () => {
      const { options } = await chrome.storage.local.get("options");
      return { enabled: options.wordHighlightEnabled, unknown: options.wordHighlightUnknown,
        learning: options.wordHighlightLearning, known: options.wordHighlightKnown, style: options.wordHighlightStyle,
        flag: options.experimental.wordHighlighting };
    });
    check(WORD_HIGHLIGHT_CHECKS[3],
      Object.keys(cleared).length === 0
        && JSON.stringify(kept) === JSON.stringify({ enabled: false, unknown: true, learning: true, known: false,
          style: "underline", flag: true }),
      JSON.stringify({ cleared, kept }));
  } finally {
    await updateSettingsControls(settings, original);
    await settings.evaluate(async ({ anki, keybinds }) => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
        options: { anki, keybinds } });
      if (!reply.ok) throw new Error(reply.error);
      await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_word_status_override", headword: "漢字", status: null });
    }, { anki: originalAnki, keybinds: originalKeybinds });
    setWordHighlightAnki(null);
    await tab.close();
  }
}

describe("lookup counts, blur and word highlights", () => {
  step("lookup statistics", async () => {
    await checkLookupStatistics({
      browser,
      settings: page,
      tab,
      popup,
      extensionId,
    });
  });

  step("definition blur", async () => {
    await checkDefinitionBlur({ settings: page, tab, popup });
  });

  step("Anki maturity blur", async () => {
    await checkAnkiMatureDefinitionBlur({ browser, settings: page, tab, popup, watchedServiceWorkers });
  });

  step("word highlighting", async () => {
    await checkWordHighlighting({ browser, settings: page, pageUrl });
  });
});
