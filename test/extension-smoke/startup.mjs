/*
 * The startup page: first-run setup, practice and visual novel scenes.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import {
  RECOMMENDED_DICTIONARIES as RECOMMENDED_CATALOGUE,
} from "../../extension/recommended-dictionaries.js";
import {
  EXTENSION,
  EXTENSION_MANIFEST,
  EXTENSION_ORIGIN,
  loadJsdom,
  loadStartupScript,
} from "./fakes.mjs";
import { check, test } from "./harness.mjs";

// The startup page renders the worker-owned setup state, mirrors the offscreen
// installer's run for its own run identity only, keeps focus through updates,
// and advances stages only through revision-checked writes.
async function startupPageStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "startup.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/startup.html`,
  });
  const { window } = dom;
  const { document } = window;
  const requests = [];
  let storageListener = null;
  let eventListener = null;
  let pendingReply = null;
  let installReply = null;
  let ankiReply = null;
  const emptyDictionaries = { outcomes: {}, totalSeconds: null, continued: false, selectionsApplied: [], recordedRuns: [] };
  let setupState = { schemaVersion: 1, revision: 3, startedAt: "2026-09-07T10:00:00.000Z", stage: "dictionaries", completedAt: null, dictionaries: emptyDictionaries, anki: null };
  const catalogue = (sourceId) => RECOMMENDED_CATALOGUE.find((entry) => entry.sourceId === sourceId);
  let dictionaryState = { schemaVersion: 1, revision: 5, groups: [], dictionaries: [
    { id: "bee", title: "Bee's Ultimate Kanji Dictionary", sourceId: "bees-ultimate-kanji-dictionary", enabled: true },
    { id: "grammar", title: "Bee's Ultimate Grammar Dictionary", sourceId: "bees-ultimate-grammar-dictionary", enabled: true },
    { id: "sankoku", title: "sankoku8-gpt-5.6-luna", sourceId: "sankoku8-eng", enabled: true },
    { id: "names", title: "JMnedict [2026-01-01]", indexUrl: catalogue("jmnedict").indexUrl, enabled: true },
    // A display name is not a trusted identity.
    { id: "lookalike", title: "Jitendex", displayName: "Jitendex", enabled: true },
  ] };
  const options = { revision: 2, lookupMode: "activation", activationKey: "Control" };
  const closedTabs = [];
  window.chrome = {
    extension: { async isAllowedFileSchemeAccess() { return false; } },
    runtime: {
      getManifest: () => structuredClone(EXTENSION_MANIFEST),
      async sendMessage(message) {
        requests.push(structuredClone(message));
        if (message.target === "hachidori-setup" && message.type === "hd_setup_install") {
          return { type: "hd_setup_install_result", requestId: message.requestId, ok: true, error: null, ...installReply(message) };
        }
        if (message.type === "hd_setup_anki") return ankiReply(message);
        // The practice step proves the sample is answerable before inviting a hover.
        if (message.type === "hd_lookup") {
          return { type: "hd_lookup_result", requestId: message.requestId, ok: true, error: null, generation: 5, dictionaryCount: 1,
            results: message.text.startsWith("辞書") ? [{ term: "辞書", matched: "辞書" }] : [] };
        }
        if (message.type !== "hd_setup_cas") throw new Error(`Unexpected startup request ${message.type}`);
        return new Promise((resolveReply) => { pendingReply = resolveReply; });
      },
      onMessage: { addListener(value) { eventListener = value; } },
    },
    storage: {
      local: { async get() {
        return { setupState: structuredClone(setupState), dictionaryState: structuredClone(dictionaryState), options: structuredClone(options) };
      } },
      onChanged: { addListener(value) { storageListener = value; } },
    },
    tabs: { async getCurrent() { return { id: 44 }; }, async remove(id) { closedTabs.push(id); } },
  };
  const pause = () => new Promise((done) => setTimeout(done, 10));
  async function until(predicate, what = "its expected state") {
    const deadline = Date.now() + 8000;
    while (!predicate() && Date.now() < deadline) await pause();
    if (!predicate()) throw new Error(`the startup page did not reach ${what}`);
  }
  const heading = () => document.getElementById("setup-heading").textContent;
  const status = () => document.getElementById("setup-status");
  const currentStep = () => document.querySelector('.setup-step[aria-current="step"]')?.dataset.stage ?? null;
  const doneSteps = () => document.querySelectorAll(".setup-step.is-done").length;
  const row = (sourceId) => document.querySelector(`.setup-dictionary[data-source-id="${sourceId}"]`);
  const rows = () => [...document.querySelectorAll(".setup-dictionary")].map((item) =>
    [item.dataset.sourceId, item.querySelector(".setup-dictionary-status").textContent]);
  const bar = (sourceId) => row(sourceId)?.querySelector(".setup-track:not([hidden])");
  const actions = () => [...document.querySelectorAll("#setup-actions button")].map((control) => [control.id, control.textContent, control.className]);
  const installs = () => requests.filter((message) => message.type === "hd_setup_install").map((message) => message.sourceIds);
  const reply = (fields) => {
    const sent = requests.at(-1);
    pendingReply({ type: "hd_setup_cas_result", requestId: sent.requestId, ok: true, error: null, ...fields });
    pendingReply = null;
    return sent;
  };
  const storage = (changes) => storageListener(changes, "local");
  const event = (fields) => eventListener({ target: "hachidori-setup-events", type: "hd_setup_progress", ...fields });
  const runA = (sequence, entries, finished = false) => ({ runId: "run-a", sequence, finished, entries });
  const entry = (sourceId, phase, extra = {}) => ({ sourceId, phase, receivedBytes: 0, totalBytes: null, seconds: null, error: null, ...extra });
  try {
    // The worker does not answer the first automatic request: the page reports it
    // once with Retry and never re-requests on its own.
    installReply = () => { throw new Error("the extension's service worker did not reply"); };
    ankiReply = () => { throw new Error("the extension's service worker did not reply"); };
    await loadStartupScript(window);
    await until(() => heading() === "Some dictionaries could not be installed", "the failed request view");
    const rendersBefore = installs().length;
    dictionaryState = { ...dictionaryState, revision: 6 };
    storageListener({ dictionaryState: { newValue: structuredClone(dictionaryState) } }, "local");
    const requestFailed = rendersBefore === 1 && installs().length === 1
      && status().textContent === "Could not start dictionary installation: the extension's service worker did not reply"
      && status().classList.contains("is-error")
      && JSON.stringify(actions().map(([id]) => id)) === JSON.stringify(["setup-retry", "setup-continue"])
      && JSON.stringify(rows()) === JSON.stringify([["jitendex", "Not installed"], ["jmnedict", "Already installed"],
        ["bees-ultimate-kanji-dictionary", "Already installed"], ["jiten", "Not installed"],
        ["bees-ultimate-grammar-dictionary", "Already installed"]]);

    installReply = () => runA(1, [entry("jitendex", "waiting"), entry("jiten", "waiting")]);
    document.getElementById("setup-retry").focus();
    document.getElementById("setup-retry").click();
    await until(() => heading() === "Installing default dictionaries…", "the installing view");
    // Every source without a recorded outcome is requested; the installer settles installed ones itself.
    const everySource = RECOMMENDED_CATALOGUE.map((entry) => entry.sourceId);
    const attached = requestFailed && JSON.stringify(installs()) === JSON.stringify([everySource, ["jitendex", "jiten"]])
      && document.activeElement === document.getElementById("setup-heading")
      && currentStep() === "dictionaries" && doneSteps() === 0
      && JSON.stringify(rows()) === JSON.stringify([["jitendex", "Waiting"], ["jmnedict", "Already installed"],
        ["bees-ultimate-kanji-dictionary", "Already installed"], ["jiten", "Waiting"],
        ["bees-ultimate-grammar-dictionary", "Already installed"]])
      && document.querySelector('#setup-body a[href="settings.html#add-dictionaries"]') !== null
      && document.querySelectorAll("#setup-actions button").length === 0
      && status().textContent === "Installing default dictionaries…";

    // Live phases follow this run's events in order; older events and other runs cannot move the rows.
    event(runA(2, [entry("jitendex", "downloading", { receivedBytes: 1_048_576, totalBytes: 4_194_304 }), entry("jiten", "waiting")]));
    const determinate = rows()[0][1] === "Downloading… 1.0 MB of 4.0 MB (25%)" && bar("jitendex")?.classList.contains("is-determinate")
      && bar("jitendex").getAttribute("aria-valuenow") === "25" && bar("jitendex").getAttribute("role") === "progressbar"
      && bar("jitendex").getAttribute("aria-labelledby") === "setup-dictionary-jitendex" && bar("jiten") === null;
    event(runA(1, [entry("jitendex", "waiting"), entry("jiten", "waiting")]));
    event({ ...runA(9, [entry("jitendex", "installed", { seconds: 1 }), entry("jiten", "installed", { seconds: 1 })]), runId: "run-b" });
    const ordered = rows()[0][1] === "Downloading… 1.0 MB of 4.0 MB (25%)";
    event(runA(3, [entry("jitendex", "downloading", { receivedBytes: 2_097_152, totalBytes: null }), entry("jiten", "waiting")]));
    const indeterminate = rows()[0][1] === "Downloading… 2.0 MB" && !bar("jitendex").classList.contains("is-determinate")
      && bar("jitendex").getAttribute("aria-valuetext") === "Downloading… 2.0 MB" && bar("jitendex").getAttribute("aria-valuenow") === null;
    event(runA(4, [entry("jitendex", "installing", { receivedBytes: 4_194_304, totalBytes: 4_194_304 }), entry("jiten", "waiting")]));
    const installing = rows()[0][1] === "Installing…" && status().textContent === "Installing default dictionaries…";
    event(runA(5, [entry("jitendex", "installed", { seconds: 3.2 }), entry("jiten", "downloading")]));
    const installed = rows()[0][1] === "Installed in 3.2 seconds" && status().textContent === "Jitendex installed in 3.2 seconds."
      && !status().classList.contains("is-error") && rows()[3][1] === "Downloading… 0 KB";
    event(runA(6, [entry("jitendex", "installed", { seconds: 3.2 }), entry("jiten", "failed", { seconds: 0.4, error: "could not read jiten-frequency.zip: HTTP 503" })]));
    const failedRow = rows()[3][1] === "Failed: could not read jiten-frequency.zip: HTTP 503"
      && status().textContent === "Jiten Frequency Dictionary could not be installed: could not read jiten-frequency.zip: HTTP 503"
      && status().classList.contains("is-error") && heading() === "Installing default dictionaries…";
    // The worker records outcomes before the run finishes; a complete inventory is what decides success.
    dictionaryState = { ...dictionaryState, revision: 7, dictionaries: [...dictionaryState.dictionaries,
      { id: "jitendex", title: "Jitendex.org [2026-08-11]", sourceId: "jitendex", enabled: true, termCount: 1 }] };
    storage({ dictionaryState: { newValue: structuredClone(dictionaryState) } });
    setupState = { ...setupState, revision: 4, dictionaries: { ...emptyDictionaries, totalSeconds: 5,
      outcomes: { jitendex: { status: "installed", seconds: 3.2, error: null }, jiten: { status: "failed", seconds: 0.4, error: "could not read jiten-frequency.zip: HTTP 503" },
        jmnedict: { status: "already-installed", seconds: null, error: null }, "bees-ultimate-kanji-dictionary": { status: "already-installed", seconds: null, error: null },
        "bees-ultimate-grammar-dictionary": { status: "already-installed", seconds: null, error: null },
        "sankoku8-eng": { status: "already-installed", seconds: null, error: null } } } };
    storage({ setupState: { newValue: structuredClone(setupState) } });
    event(runA(7, [entry("jitendex", "installed", { seconds: 3.2 }), entry("jiten", "failed", { seconds: 0.4, error: "could not read jiten-frequency.zip: HTTP 503" })], true));
    const failureView = heading() === "Some dictionaries could not be installed"
      && JSON.stringify(rows()) === JSON.stringify([["jitendex", "Installed in 3.2 seconds"], ["jmnedict", "Already installed"],
        ["bees-ultimate-kanji-dictionary", "Already installed"], ["jiten", "Failed: could not read jiten-frequency.zip: HTTP 503"],
        ["bees-ultimate-grammar-dictionary", "Already installed"]])
      && JSON.stringify(actions()) === JSON.stringify([["setup-retry", "Retry missing dictionaries", "primary-button"], ["setup-continue", "Continue setup", "ghost"]])
      && document.getElementById("setup-countdown-label") === null && installs().length === 2;

    // Continuing with a failure records an incomplete set; a conflict keeps the view and reports it.
    document.getElementById("setup-retry").focus();
    dictionaryState = { ...dictionaryState, revision: 8 };
    storage({ dictionaryState: { newValue: structuredClone(dictionaryState) } });
    const focusKept = document.activeElement?.id === "setup-retry";
    document.getElementById("setup-continue").click();
    await until(() => pendingReply !== null, "the continue write");
    const continueRequest = reply({ ok: false, conflict: true, error: "Setup changed in another tab.", state: structuredClone(setupState) });
    await until(() => status().textContent.startsWith("Could not save"), "the continue conflict");
    const continued = continueRequest.stage === "anki" && continueRequest.continued === true && continueRequest.baseRevision === 4
      && heading() === "Some dictionaries could not be installed" && document.getElementById("setup-retry") !== null;

    // Retry asks for the missing entry only and follows the new run.
    installReply = () => ({ runId: "run-b", sequence: 1, finished: false, entries: [entry("jiten", "downloading")] });
    document.getElementById("setup-retry").click();
    await until(() => heading() === "Installing default dictionaries…", "the retry run");
    const retried = JSON.stringify(installs().at(-1)) === JSON.stringify(["jiten"]) && rows()[3][1] === "Downloading… 0 KB"
      && rows()[0][1] === "Installed in 3.2 seconds";
    event({ runId: "run-a", sequence: 8, finished: false, entries: [entry("jitendex", "installed", { seconds: 3.2 }), entry("jiten", "installing")] });
    const oldRunIgnored = rows()[3][1] === "Downloading… 0 KB";
    event({ runId: "run-b", sequence: 2, finished: false, entries: [entry("jiten", "installed", { seconds: 2.5 })] });
    dictionaryState = { ...dictionaryState, revision: 9, dictionaries: [...dictionaryState.dictionaries,
      { id: "jiten", title: "Jiten", sourceId: "jiten", enabled: true }] };
    storage({ dictionaryState: { newValue: structuredClone(dictionaryState) } });
    setupState = { ...setupState, revision: 5, dictionaries: { ...setupState.dictionaries, totalSeconds: 7.5,
      outcomes: { ...setupState.dictionaries.outcomes, jiten: { status: "installed", seconds: 2.5, error: null } } } };
    storage({ setupState: { newValue: structuredClone(setupState) } });
    event({ runId: "run-b", sequence: 3, finished: true, entries: [entry("jiten", "installed", { seconds: 2.5 })] });
    const successStarted = Date.now();
    const success = heading() === "All dictionaries installed in 7.5 seconds"
      && document.getElementById("setup-countdown-label") === null
      && document.querySelector('#setup-body a[href="settings.html#add-dictionaries"]') !== null
      && actions().length === 0
      && status().textContent === "All dictionaries installed in 7.5 seconds";
    // The successful result queues its write immediately; a conflict (the run
    // total landed) is retried with the newer revision.
    await until(() => pendingReply !== null, "the immediate dictionary advance");
    const elapsed = Date.now() - successStarted;
    const firstAdvance = requests.at(-1);
    setupState = { ...setupState, revision: 6 };
    reply({ ok: false, conflict: true, error: "Setup changed in another tab.", state: structuredClone(setupState) });
    await until(() => pendingReply !== null, "the retried dictionary advance");
    const secondAdvance = requests.at(-1);
    setupState = { ...setupState, revision: 7, stage: "anki" };
    reply({ state: structuredClone(setupState) });
    await until(() => heading() === "Anki could not be checked", "the failed Anki check");
    const ankiRequests = () => requests.filter((message) => message.type === "hd_setup_anki").length;
    // The first check is not answered: shown once with Retry and Continue, never re-asked on its own.
    storage({ dictionaryState: { newValue: structuredClone(dictionaryState) } });
    const advanced = elapsed < 1000 && firstAdvance.stage === "anki" && firstAdvance.baseRevision === 5 && firstAdvance.continued === undefined
      && secondAdvance.stage === "anki" && secondAdvance.baseRevision === 6 && currentStep() === "anki" && doneSteps() === 1
      && document.activeElement === document.getElementById("setup-heading")
      && status().textContent === "Could not check Anki: the extension's service worker did not reply" && ankiRequests() === 1
      && JSON.stringify(actions().map(([id]) => id)) === JSON.stringify(["setup-retry", "setup-continue"])
      && document.querySelector('#setup-body a[href="settings.html#anki"]') !== null;

    // Retry: the recorded outcome arrives with the reply and the page moves to the final step by itself,
    // where the outcome stays readable beside the reading instructions.
    // A reply that carries no newer outcome is a failed check, shown once, not a loop.
    ankiReply = (message) => ({ type: "hd_setup_anki_result", requestId: message.requestId, ok: true, error: null, state: structuredClone(setupState) });
    document.getElementById("setup-retry").click();
    await until(() => ankiRequests() === 2 && status().textContent.includes("no Anki outcome was recorded"), "the empty Anki reply");
    const emptyReplyShown = heading() === "Anki could not be checked" && document.getElementById("setup-retry") !== null;
    const readAnkiProgress = () => [...document.querySelectorAll(".setup-anki-progress-step")].map((row) => ({
      title: row.querySelector("strong")?.textContent,
      detail: row.querySelector("small")?.textContent,
      done: row.classList.contains("is-done"),
      current: row.getAttribute("aria-current") === "step",
    }));
    let releaseConfiguredAnki;
    ankiReply = (message) => new Promise((resolveReply) => {
      releaseConfiguredAnki = () => {
        setupState = { ...setupState, revision: 8, anki: { status: "configured", detail: null, model: "Kiku v2", deck: "Mining::Words" } };
        resolveReply({ type: "hd_setup_anki_result", requestId: message.requestId, ok: true, error: null, state: structuredClone(setupState) });
      };
    });
    document.getElementById("setup-retry").click();
    await until(() => typeof releaseConfiguredAnki === "function", "the held configured Anki reply");
    await new Promise((done) => setTimeout(done, 2100));
    const pendingProgress = readAnkiProgress();
    const pendingStayed = heading() === "Finding your Anki setup…"
      && status().textContent === "Finding your Anki setup…" && !status().classList.contains("is-error")
      && JSON.stringify(pendingProgress) === JSON.stringify([
        { title: "Looking for the most popular mining card", detail: "Checking Anki…", done: false, current: true },
        { title: "Looking for the most popular deck", detail: "Waiting", done: false, current: false },
        { title: "Setting Hachidori to use them", detail: "Waiting", done: false, current: false },
      ]);
    storage({ options: { newValue: { ...options, revision: options.revision + 1, audioSources: [
      { id: "local-audio", type: "custom-json", enabled: true,
        url: "http://127.0.0.1:5050/?term={term}&reading={reading}", voice: "" },
      { id: "default-tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" },
    ] } } });
    releaseConfiguredAnki();
    await until(() => readAnkiProgress()[0]?.detail === "Selected Kiku v2"
      && readAnkiProgress()[0]?.current, "the selected mining-card step");
    const cardShownAt = Date.now();
    const cardProgress = readAnkiProgress();
    await until(() => readAnkiProgress()[1]?.detail === "Selected Mining::Words"
      && readAnkiProgress()[1]?.current, "the selected deck step");
    const deckShownAt = Date.now();
    const deckProgress = readAnkiProgress();
    await until(() => readAnkiProgress()[2]?.detail === "Ready for future mining"
      && readAnkiProgress()[2]?.current, "the saved Anki step");
    const readyShownAt = Date.now();
    const readyProgress = readAnkiProgress();
    await until(() => heading() === "Anki is set up"
      && document.getElementById("setup-countdown-label")?.textContent === "Continuing to practice in 3 seconds",
    "the configured Anki result");
    const configuredAt = Date.now();
    const checkedHeading = heading();
    const automaticProgress = readAnkiProgress();
    const localAudioOutcome = document.querySelector(".setup-local-audio-outcome")?.textContent ?? "";
    await new Promise((done) => setTimeout(done, 1500));
    const ankiHeld = heading() === "Anki is set up" && pendingReply === null
      && /Continuing to practice in [12] seconds?/u.test(document.getElementById("setup-countdown-label")?.textContent ?? "");
    await until(() => pendingReply !== null, "the practice write");
    const progressDwell = [deckShownAt - cardShownAt, readyShownAt - deckShownAt, configuredAt - readyShownAt];
    const ankiElapsed = Date.now() - configuredAt;
    const practiceRequest = requests.at(-1);
    // A second startup tab made the same move first: the conflict it leaves is
    // the move this page asked for, so the final step is not an error screen.
    setupState = { ...setupState, revision: 9, stage: "practice" };
    reply({ ok: false, conflict: true, error: "Setup changed in another tab.", state: structuredClone(setupState) });
    await until(() => document.getElementById("setup-practice-instruction")?.textContent.startsWith("Try looking up a word below."), "the practice stage");
    const outcomeNote = document.querySelector(".setup-anki-outcome");
    const practice = emptyReplyShown && pendingStayed && ankiRequests() === 3
      && practiceRequest.stage === "practice" && practiceRequest.baseRevision === 8
      && checkedHeading === "Anki is set up" && ankiHeld
      && localAudioOutcome === "Local audio is configured."
      && progressDwell.every((duration) => duration >= 1900) && ankiElapsed >= 2900
      && JSON.stringify(cardProgress) === JSON.stringify([
        { title: "Looking for the most popular mining card", detail: "Selected Kiku v2", done: false, current: true },
        { title: "Looking for the most popular deck", detail: "Waiting", done: false, current: false },
        { title: "Setting Hachidori to use them", detail: "Waiting", done: false, current: false },
      ])
      && JSON.stringify(deckProgress) === JSON.stringify([
        { title: "Looking for the most popular mining card", detail: "Selected Kiku v2", done: true, current: false },
        { title: "Looking for the most popular deck", detail: "Selected Mining::Words", done: false, current: true },
        { title: "Setting Hachidori to use them", detail: "Waiting", done: false, current: false },
      ])
      && JSON.stringify(readyProgress) === JSON.stringify([
        { title: "Looking for the most popular mining card", detail: "Selected Kiku v2", done: true, current: false },
        { title: "Looking for the most popular deck", detail: "Selected Mining::Words", done: true, current: false },
        { title: "Setting Hachidori to use them", detail: "Ready for future mining", done: false, current: true },
      ])
      && JSON.stringify(automaticProgress) === JSON.stringify([
        { title: "Looking for the most popular mining card", detail: "Selected Kiku v2", done: true, current: false },
        { title: "Looking for the most popular deck", detail: "Selected Mining::Words", done: true, current: false },
        { title: "Setting Hachidori to use them", detail: "Ready for future mining", done: true, current: false },
      ])
      && outcomeNote?.dataset.status === "configured"
      && outcomeNote.textContent === "Automatically set up Kiku v2 for deck ‘Mining::Words’. Change in Settings."
      && outcomeNote.querySelector('a[href="settings.html#anki"]') !== null
      && document.getElementById("setup-body").textContent.includes("Hold Control and hover")
      && status().textContent === "You’re ready." && !status().classList.contains("is-error")
      && document.getElementById("setup-finish") !== null && doneSteps() === 2;
    const scene = document.getElementById("setup-practice-text");
    const word = document.getElementById("setup-practice-word");
    scene.focus();
    window.getSelection().selectAllChildren(word);
    storage({ options: { newValue: { ...options, revision: options.revision + 2, activationKey: "Shift" } } });
    const practicePreserved = document.getElementById("setup-practice-text") === scene
      && window.getSelection().toString() === "辞書" && document.activeElement === scene
      && document.getElementById("setup-practice-instruction").textContent.includes("Hold Shift");
    document.getElementById("setup-finish").click();
    await until(() => pendingReply !== null, "the finish write");
    const finishRequest = reply({ state: { ...setupState, revision: 10, stage: "complete", completedAt: "2026-09-07T10:05:00.000Z" } });
    await until(() => closedTabs.length === 1, "the closed tab");
    const finished = finishRequest.baseRevision === 9 && finishRequest.stage === "complete" && closedTabs[0] === 44
      && heading() === "Setup is complete." && currentStep() === null && doneSteps() === 3
      && document.getElementById("setup-actions").childElementCount === 0;
    const configuredResume = await startupConfiguredAnkiResume(jsdom);
    const lostAnkiReply = await startupAnkiLostReplyStage(jsdom);
    return { requestFailed, attached, determinate, ordered, indeterminate, installing, installed, failedRow, failureView, focusKept, continued,
      retried, oldRunIgnored, success, advanced, practice, practicePreserved, finished, configuredResume, lostAnkiReply };
  } finally {
    window.close();
  }
}

// One jsdom startup page with only the worker replies and stored values a
// dictionary-stage case needs; the two stages below drive it from there.
function startupCase(jsdom, { sharing = { enabled: true, connected: false, client: { linked: false } }, probe = null, link = null, setup, dictionaries = [], reply, cas = null, options = { revision: 1 }, lookup = null, status = null, anki = null }) {
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "startup.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/startup.html`,
  });
  const { window } = dom;
  const { document } = window;
  const requests = [];
  const stored = { setup, dictionaries, options, dictionaryRevision: 1 };
  let installReply = reply;
  let storageListener = null;
  let eventListener = null;
  window.chrome = {
    runtime: {
      getManifest: () => structuredClone(EXTENSION_MANIFEST),
      async sendMessage(message) {
        requests.push(structuredClone(message));
        if (message.type === "hd_setup_cas" && cas !== null) return cas(message);
        if (message.type === "hd_setup_anki" && anki !== null) return anki(message);
        if (message.type === "hd_lookup") {
          if (lookup === null) throw new Error("the dictionary engine is unavailable");
          return { type: "hd_lookup_result", requestId: message.requestId, ok: true, error: null, ...lookup(message) };
        }
        // A refused lookup waits for the engine to go idle before asking again.
        if (message.type === "hd_status") {
          return { type: "hd_status_result", requestId: message.requestId, ok: true, error: null, ready: true, loading: false,
            ...(status === null ? {} : status(message)) };
        }
        // The welcome page looks around this computer once; nothing answers unless the case says so.
        if (message.type === "hd_sharing_status") return { ok: true, sharing };
        if (message.type === "hd_sharing_client_probe") {
          return probe === null
            ? { type: "hd_sharing_client_probe_result", requestId: message.requestId, ok: false, error: "No shared Hachidori answered at ws://127.0.0.1:8771/link." }
            : { type: "hd_sharing_client_probe_result", requestId: message.requestId, ok: true, error: null, ...probe(message) };
        }
        if (message.type === "hd_sharing_client_link" && link !== null) {
          return { type: "hd_sharing_client_link_result", requestId: message.requestId, ok: true, error: null, ...link(message) };
        }
        if (message.type !== "hd_setup_install") throw new Error(`Unexpected startup request ${message.type}`);
        return { type: "hd_setup_install_result", requestId: message.requestId, ok: true, error: null, ...installReply(message) };
      },
      onMessage: { addListener(value) { eventListener = value; } },
    },
    storage: {
      local: { async get() {
        return { setupState: structuredClone(stored.setup), options: structuredClone(stored.options),
          dictionaryState: { schemaVersion: 1, revision: stored.dictionaryRevision, groups: [], dictionaries: structuredClone(stored.dictionaries) } };
      } },
      onChanged: { addListener(value) { storageListener = value; } },
    },
    tabs: { async getCurrent() { return { id: 7 }; }, async remove() {} },
  };
  return {
    window, document,
    answer(next) { installReply = next; },
    // A worker write the page learns about through a storage event.
    record(setupState) {
      stored.setup = setupState;
      storageListener({ setupState: { newValue: structuredClone(setupState) } }, "local");
    },
    preferences(value) {
      stored.options = value;
      storageListener({ options: { newValue: structuredClone(value) } }, "local");
    },
    // A dictionary-state write the page learns about through a storage event.
    library(next) {
      stored.dictionaries = next;
      stored.dictionaryRevision += 1;
      storageListener({ dictionaryState: { newValue: { schemaVersion: 1, revision: stored.dictionaryRevision,
        groups: [], dictionaries: structuredClone(next) } } }, "local");
    },
    // An installer broadcast for the run the page attached to.
    progress(snapshot) {
      eventListener({ target: "hachidori-setup-events", type: "hd_setup_progress", ...snapshot });
    },
    installs: () => requests.filter((message) => message.type === "hd_setup_install").map((message) => message.sourceIds),
    requestTypes: () => requests.map((message) => message.type),
    lookups: () => requests.filter((message) => message.type === "hd_lookup").map((message) => message.text),
    saves: () => requests.filter((message) => message.type === "hd_setup_cas"),
    heading: () => document.getElementById("setup-heading").textContent,
    rowText: (sourceId) => document.querySelector(`.setup-dictionary[data-source-id="${sourceId}"] .setup-dictionary-status`).textContent,
    actionIds: () => [...document.querySelectorAll("#setup-actions button")].map((control) => control.id),
    async until(predicate, what) {
      const deadline = Date.now() + 15_000;
      while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      if (!predicate()) throw new Error(`the startup page did not reach ${what}`);
    },
    load: () => loadStartupScript(window),
  };
}

const PRACTICE_SENTENCE_TEXT = "踏切の向こうから蝉の声が響く。喧騒を離れて路地に佇むと、古びた辞書で見つけた言葉が、目の前の景色と少しずつ結びついていく。";

// The reader scripts the practice step appends, in order, and the order the
// manifest itself gives them: the page must follow that list, not a copy.
const readerScripts = (document) => [...document.querySelectorAll("script[data-setup-reader]")]
  .map((script) => script.getAttribute("src"));
const MANIFEST_READER_SCRIPTS = EXTENSION_MANIFEST.content_scripts[0].js.filter((src) => src !== "reader-options.js");

const SETUP_AT_DICTIONARIES = Object.freeze({ schemaVersion: 1, revision: 2, startedAt: "2026-09-07T10:00:00.000Z",
  stage: "dictionaries", completedAt: null,
  dictionaries: Object.freeze({ outcomes: {}, totalSeconds: null, continued: false, selectionsApplied: [], recordedRuns: [] }) });

// A persisted configured outcome is already settled. Reloading or resuming the
// page must start its three-second continuation instead of replaying a check
// that this page never made.
async function startupConfiguredAnkiResume(jsdom) {
  const setup = { ...structuredClone(SETUP_AT_DICTIONARIES), revision: 8, stage: "anki",
    anki: { status: "configured", detail: null, model: "Kiku v2", deck: "Mining::Words" } };
  const page = startupCase(jsdom, { setup,
    reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }) });
  try {
    await page.load();
    const progress = [...page.document.querySelectorAll(".setup-anki-progress-step")];
    return page.heading() === "Anki is set up"
      && page.document.getElementById("setup-countdown-label")?.textContent === "Continuing to practice in 3 seconds"
      && progress.length === 3 && progress.every((row) => row.classList.contains("is-done"))
      && progress.every((row) => !row.hasAttribute("aria-current"))
      && !page.requestTypes().includes("hd_setup_anki");
  } finally {
    page.window.close();
  }
}

// The setup record is authoritative even when the request carrying the same
// outcome loses its reply. Either event order must retire only the stale Anki
// request error and leave the settled result readable.
async function startupAnkiLostReplyStage(jsdom) {
  const initial = { ...structuredClone(SETUP_AT_DICTIONARIES), revision: 7, stage: "anki", anki: null };
  async function run(recordFirst) {
    const recorded = { ...initial, revision: 8, anki: recordFirst
      ? { status: "unavailable", detail: "AnkiConnect timed out", model: null, deck: null }
      : { status: "configured", detail: null, model: "Kiku v2", deck: "Mining::Words" } };
    let rejectReply;
    const page = startupCase(jsdom, { setup: initial,
      reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }),
      anki: () => new Promise((_resolve, reject) => { rejectReply = reject; }) });
    try {
      await page.load();
      await page.until(() => typeof rejectReply === "function", "the pending Anki request");
      if (recordFirst) page.record(recorded);
      rejectReply(new Error("the extension's service worker did not reply"));
      await new Promise(setImmediate);
      if (!recordFirst) {
        await page.until(() => page.heading() === "Anki could not be checked", "the lost Anki reply");
        page.record(recorded);
        await new Promise(setImmediate);
      }
      const expectedHeading = recordFirst ? "Could not find Anki" : "Finding your Anki setup…";
      await page.until(() => page.heading() === expectedHeading, "the recorded Anki outcome");
      const status = page.document.getElementById("setup-status");
      const stagedChoice = page.document.querySelector('.setup-anki-progress-step[aria-current="step"] small')?.textContent;
      const settled = page.document.querySelector(".setup-anki-outcome")?.dataset.status === "unavailable"
        && page.document.getElementById("setup-countdown-label") !== null;
      const staged = stagedChoice === "Selected Kiku v2"
        && page.document.getElementById("setup-countdown-label") === null;
      return status.textContent === expectedHeading && !status.classList.contains("is-error")
        && page.document.getElementById("setup-retry") === null
        && (recordFirst ? settled : staged);
    } finally {
      page.window.close();
    }
  }
  return await run(true) && await run(false);
}

async function startupWelcomeStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const setup = { ...structuredClone(SETUP_AT_DICTIONARIES), stage: "welcome", revision: 1, anki: null };
  const accepted = { ...setup, stage: "dictionaries", revision: 2 };
  const reply = () => ({ runId: "accepted-run", sequence: 1, finished: false, entries: [] });
  let saveReply;
  const page = startupCase(jsdom, { setup, reply, options: { revision: 2, popupTheme: "dracula" },
    cas: () => new Promise((done) => { saveReply = done; }) });
  let resumed;
  let manual;
  let offered;
  try {
    await page.load();
    const themeRoot = page.document.documentElement;
    const initialTheme = themeRoot.dataset.hoshidictsTheme === "dracula"
      && page.document.querySelector('link[href="render/reader.css"]') !== null;
    page.document.getElementById("setup-start").focus();
    page.preferences({ revision: 3, popupTheme: "light" });
    page.preferences({ revision: 2, popupTheme: "dark" });
    const themed = initialTheme && themeRoot.dataset.hoshidictsTheme === "light"
      && page.document.activeElement?.id === "setup-start" && page.saves().length === 0;
    const introduction = page.document.getElementById("setup-body").textContent;
    const quiet = page.heading() === "Welcome to Hachidori" && page.requestTypes().join(",") === "hd_sharing_status,hd_sharing_client_probe"
      && page.document.getElementById("setup-steps").hidden
      && readerScripts(page.document).length === 0
      && introduction === "Click Start Setup to automatically set up Hachidori"
        + "Already using Hachidori in another browser, on this computer or another one? Link to it from Settings instead of setting up again."
      && page.document.querySelector('.startup-star-link[href="https://github.com/bee-san/hachidori"]')
        ?.textContent.replace(/\s+/gu, " ").trim() === "Star Hachidori on GitHub"
      && page.document.querySelector('a[href*="privacy"]') === null;
    // A failed save leaves the introduction and no network work; a later click
    // still must wait until the accepted stage is committed.
    page.document.getElementById("setup-start").click();
    await page.until(() => saveReply !== undefined, "the Start setup write");
    saveReply({ ok: false, error: "storage unavailable" });
    await page.until(() => page.document.getElementById("setup-status").textContent.includes("storage unavailable"), "the failed Start save");
    const refused = page.heading() === "Welcome to Hachidori" && page.installs().length === 0;
    saveReply = undefined;
    page.document.getElementById("setup-start").click();
    await page.until(() => saveReply !== undefined, "the retried Start write");
    const held = page.installs().length === 0 && page.document.getElementById("setup-start").disabled;
    saveReply({ ok: true, state: accepted });
    await page.until(() => page.installs().length === 1, "the accepted dictionary run");
    const started = held && page.saves().every((message) => message.stage === "dictionaries" && message.baseRevision === 1)
      && !page.document.getElementById("setup-steps").hidden
      && page.document.querySelector('#setup-steps [aria-current="step"]')?.dataset.stage === "dictionaries"
      && page.heading() === "Installing default dictionaries…";
    page.window.close();
    resumed = startupCase(jsdom, { setup: accepted, reply });
    await resumed.load();
    const resumes = resumed.heading() === "Installing default dictionaries…" && resumed.installs().length === 1
      && resumed.saves().length === 0 && resumed.document.getElementById("setup-start") === null;
    manual = startupCase(jsdom, { setup, reply,
      cas: (message) => ({ ok: true, state: { ...setup, revision: 2, stage: message.stage } }) });
    await manual.load();
    manual.document.getElementById("setup-manual").click();
    await manual.until(() => manual.heading() === "Add a dictionary to try Hachidori", "manual setup");
    const skipped = manual.saves()[0].stage === "practice" && manual.installs().length === 0
      && !manual.requestTypes().includes("hd_setup_anki")
      && manual.document.querySelector('a[href="settings.html#add-dictionaries"]') !== null;
    // A Hachidori sharing itself from another browser on this computer is offered
    // instead; using it links and completes setup with no dictionary run.
    let linkRequest;
    offered = startupCase(jsdom, { setup, reply,
      probe: () => ({ address: "ws://127.0.0.1:8771/link", display: "this computer", host: { version: "0.1.0", name: "Chrome", dictionaryCount: 5 } }),
      link: (message) => { linkRequest = message; return { sharing: {} }; },
      cas: (message) => ({ ok: true, state: { ...setup, revision: 2, stage: message.stage } }) });
    await offered.load();
    const offerShown = offered.heading() === "Welcome to Hachidori"
      && offered.document.getElementById("setup-body").textContent === "Chrome on this computer already has Hachidori set up, with 5 dictionaries."
        + "Use it here instead of setting up again? Words are looked up there, and nothing is downloaded twice."
      && offered.actionIds().join(",") === "setup-use-shared,setup-start,setup-manual"
      && offered.document.getElementById("setup-use-shared").textContent === "Use the Hachidori in Chrome"
      && offered.document.getElementById("setup-start").textContent === "Set up separately";
    offered.document.getElementById("setup-use-shared").click();
    await offered.until(() => offered.heading() === "Setup is complete.", "the linked setup to complete");
    const used = offerShown && linkRequest?.target === "hachidori-sharing" && linkRequest.address === "ws://127.0.0.1:8771/link"
      && offered.saves().length === 1 && offered.saves()[0].stage === "complete" && offered.installs().length === 0;
    const discoverySkipped = [];
    for (const sharing of [{ enabled: true, connected: true, client: { linked: false } },
      { enabled: false, connected: false, client: { linked: true } }]) {
      const existing = startupCase(jsdom, { setup, reply, sharing });
      try {
        await existing.load();
        discoverySkipped.push(existing.requestTypes().join(",") === "hd_sharing_status"
          && !existing.actionIds().includes("setup-use-shared"));
      } finally { existing.window.close(); }
    }
    return { quiet, refused, started, resumes, skipped, offered: used, themed, discoverySkipped: discoverySkipped.every(Boolean) };
  } finally {
    page.window.close();
    resumed?.window.close();
    manual?.window.close();
    offered?.window.close();
  }
}

// A run whose offscreen document disappeared stops reporting with the page
// still holding an unfinished snapshot. After a silence longer than any phase
// change the page observes the installer again: a live run keeps its progress,
// and a replacement installer's empty snapshot restarts the sources that have
// no recorded outcome.
async function startupRunRecoveryStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const everySource = RECOMMENDED_CATALOGUE.map((entry) => entry.sourceId);
  const downloading = (runId) => ({ runId, sequence: 1, finished: false,
    entries: [{ sourceId: "jitendex", phase: "downloading", receivedBytes: 1024, totalBytes: null, seconds: null, error: null }] });
  const page = startupCase(jsdom, { setup: structuredClone(SETUP_AT_DICTIONARIES), reply: () => downloading("run-a") });
  const { installs, heading } = page;
  const jitendexRow = () => page.rowText("jitendex");
  try {
    await page.load();
    await page.until(() => heading() === "Installing default dictionaries…", "the installing view");
    const attached = JSON.stringify(installs()) === JSON.stringify([everySource]) && jitendexRow() === "Downloading… 1 KB";
    // The silent run is still there: the observing request carries no source and changes nothing.
    await page.until(() => installs().length === 2, "the first liveness check");
    const observed = JSON.stringify(installs()[1]) === JSON.stringify([])
      && heading() === "Installing default dictionaries…" && jitendexRow() === "Downloading… 1 KB";
    // Now the offscreen document is gone and a replacement installer holds no run.
    page.answer((message) => (message.sourceIds.length > 0 ? downloading("run-b") : { runId: null, sequence: 0, finished: true, entries: [] }));
    await page.until(() => installs().length >= 4, "the restarted run");
    const recovered = JSON.stringify(installs()[2]) === JSON.stringify([]) && JSON.stringify(installs()[3]) === JSON.stringify(everySource)
      && heading() === "Installing default dictionaries…" && jitendexRow() === "Downloading… 1 KB";
    return { attached, observed, recovered };
  } finally {
    page.window.close();
  }
}

// A source whose automatic attempt failed and which the user then installed
// from Settings is reconciled: it is requested once so the installer can record
// it as already installed, never reimported, and the stale failure disappears
// instead of holding up the complete result. A failed source that is still
// missing keeps waiting for the explicit Retry.
async function startupReconcileStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const outcome = (status, extra = {}) => ({ status, seconds: null, error: null, ...extra });
  const setup = { ...structuredClone(SETUP_AT_DICTIONARIES), revision: 5,
    dictionaries: { outcomes: {
      jitendex: outcome("installed", { seconds: 3.2 }),
      jmnedict: outcome("already-installed"),
      "bees-ultimate-kanji-dictionary": outcome("failed", { error: "could not read bees.zip: HTTP 503" }),
      jiten: outcome("failed", { error: "could not read jiten-frequency.zip: HTTP 503" }),
      "bees-ultimate-grammar-dictionary": outcome("already-installed"),
      "sankoku8-eng": outcome("already-installed"),
    }, totalSeconds: 4, continued: false, selectionsApplied: ["jitendex"], recordedRuns: ["run-a"] } };
  const installed = (sourceId, title) => ({ id: sourceId, title, sourceId, enabled: true });
  // Everything but Jiten is in the library: Bee's arrived from Settings after its failure.
  const dictionaries = [installed("jitendex", "Jitendex.org [2026-08-11]"), installed("jmnedict", "JMnedict [2026-01-01]"),
    installed("bees-ultimate-kanji-dictionary", "Bee's Ultimate Kanji Dictionary"),
    installed("bees-ultimate-grammar-dictionary", "Bee's Ultimate Grammar Dictionary"),
    installed("sankoku8-eng", "sankoku8-gpt-5.6-luna")];
  const page = startupCase(jsdom, { setup, dictionaries,
    reply: () => ({ runId: "run-b", sequence: 1, finished: false,
      entries: [{ sourceId: "bees-ultimate-kanji-dictionary", phase: "waiting", receivedBytes: 0, totalBytes: null, seconds: null, error: null }] }) });
  try {
    await page.load();
    await page.until(() => page.heading() === "Installing default dictionaries…", "the reconciling run");
    // Only the installed-but-failed source is requested; the missing failure waits for Retry.
    const requested = JSON.stringify(page.installs()) === JSON.stringify([["bees-ultimate-kanji-dictionary"]]);
    // The installer records it as already installed without importing anything, then finishes.
    page.record({ ...setup, revision: 6, dictionaries: { ...setup.dictionaries, totalSeconds: 4.1,
      outcomes: { ...setup.dictionaries.outcomes, "bees-ultimate-kanji-dictionary": outcome("already-installed") },
      selectionsApplied: ["jitendex", "bees-ultimate-kanji-dictionary"] } });
    page.progress({ runId: "run-b", sequence: 2, finished: true,
      entries: [{ sourceId: "bees-ultimate-kanji-dictionary", phase: "already-installed", receivedBytes: 0, totalBytes: null, seconds: null, error: null }] });
    await page.until(() => page.heading() === "Some dictionaries could not be installed", "the remaining failure");
    const reconciled = requested && page.rowText("bees-ultimate-kanji-dictionary") === "Already installed"
      && page.rowText("jiten") === "Failed: could not read jiten-frequency.zip: HTTP 503"
      && JSON.stringify(page.actionIds()) === JSON.stringify(["setup-retry", "setup-continue"])
      && page.installs().length === 1;
    return { requested, reconciled };
  } finally {
    page.window.close();
  }
}

// Both immediate advances failing is an action-required state: nothing saves
// again behind the explicit Continue setup.
async function startupAdvanceFailureStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const setup = { ...structuredClone(SETUP_AT_DICTIONARIES), revision: 6,
    dictionaries: { outcomes: Object.fromEntries(RECOMMENDED_CATALOGUE.map((entry) =>
      [entry.sourceId, { status: "installed", seconds: 1, error: null }])),
    totalSeconds: 4, continued: false, selectionsApplied: [], recordedRuns: ["run-a"] } };
  const dictionaries = RECOMMENDED_CATALOGUE.map((entry) => ({ id: entry.sourceId, title: entry.title, sourceId: entry.sourceId, enabled: true }));
  const page = startupCase(jsdom, { setup, dictionaries,
    reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }),
    cas: (message) => ({ type: "hd_setup_cas_result", requestId: message.requestId, ok: false, error: "the setup record could not be written" }) });
  const label = () => page.document.getElementById("setup-countdown-label");
  try {
    await page.load();
    await page.until(() => page.heading() === "All dictionaries installed in 4.0 seconds", "the complete result");
    const immediate = label() === null;
    await page.until(() => page.saves().length === 2 && label() === null, "the failed advance");
    const failed = immediate && page.saves().length === 2 && label() === null
      && page.heading() === "All dictionaries installed in 4.0 seconds";
    await new Promise((done) => setTimeout(done, 100));
    const quiet = page.saves().length === 2 && label() === null && page.actionIds().includes("setup-continue");
    const continuedNow = await startupContinueNowStage(jsdom, setup, dictionaries);
    const completedWhileChecking = await startupContinueNowStage(jsdom, setup, dictionaries, true);
    return { immediate, failed, quiet, continuedNow, completedWhileChecking };
  } finally {
    page.window.close();
  }
}

// The immediate dictionary advance starts the optional Anki check. Continue
// now can leave that check pending, and its late reply preserves the stage the
// user already reached.
async function startupContinueNowStage(jsdom, initialSetup, dictionaries, finishBeforeReply = false) {
  let setup = structuredClone(initialSetup);
  let settleAnki;
  const page = startupCase(jsdom, { setup, dictionaries,
    reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }),
    cas: (message) => {
      setup = { ...setup, revision: setup.revision + 1, stage: message.stage,
        completedAt: message.stage === "complete" ? "2026-09-08T12:00:00Z" : null };
      return { ok: true, state: structuredClone(setup) };
    },
    anki: () => new Promise(resolve => { settleAnki = resolve; }) });
  try {
    await page.load();
    await page.until(() => typeof settleAnki === "function", "the optional Anki check");
    const progress = [...page.document.querySelectorAll(".setup-anki-progress-step")];
    const checking = page.heading() === "Finding your Anki setup…"
      && page.document.querySelector('[data-stage="anki"]')?.textContent.includes("Optional")
      && progress.length === 3
      && progress.map((row) => row.querySelector("strong")?.textContent).join("|")
        === "Looking for the most popular mining card|Looking for the most popular deck|Setting Hachidori to use them"
      && progress[0].classList.contains("is-current")
      && page.document.getElementById("setup-continue")?.disabled === false
      && page.document.getElementById("setup-countdown-label") === null
      && page.saves().length === 1;
    page.document.getElementById("setup-continue").click();
    await page.until(() => page.document.getElementById("setup-finish") !== null, "practice while Anki is pending");
    if (finishBeforeReply) {
      page.document.getElementById("setup-finish").click();
      await page.until(() => page.heading() === "Setup is complete.", "completion while Anki is pending");
    }
    setup = { ...setup, revision: setup.revision + 1,
      anki: { status: "unavailable", detail: "AnkiConnect timed out", model: null, deck: null } };
    settleAnki({ ok: true, state: structuredClone(setup) });
    if (finishBeforeReply) {
      await new Promise(setImmediate);
      return checking && page.saves().length === 3 && page.heading() === "Setup is complete."
        && page.actionIds().length === 0 && setup.completedAt === "2026-09-08T12:00:00Z";
    }
    await page.until(() => page.document.querySelector(".setup-anki-outcome") !== null, "the late Anki outcome");
    return checking && page.saves().length === 2 && setup.stage === "practice"
      && page.document.querySelector(".setup-anki-outcome").textContent === "Could not find Anki. If you want to make flashcards out of words, I suggest Anki!"
      && page.document.querySelector('.setup-anki-outcome a[href="https://apps.ankiweb.net/"]')?.textContent === "Anki"
      && page.document.getElementById("setup-finish")?.disabled === false;
  } finally {
    page.window.close();
  }
}

// The practice step invites a real lookup only when a dictionary can answer
// one, and the reader arrives with that step rather than with the page.
async function startupPracticeStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const setup = { ...structuredClone(SETUP_AT_DICTIONARIES), revision: 8, stage: "practice",
    anki: { status: "unavailable", detail: "Open Anki with the AnkiConnect add-on installed, then retry.", model: null, deck: null } };
  // A frequency-only package cannot answer a term lookup.
  const frequencyOnly = [{ id: "jiten", title: "Jiten", sourceId: "jiten", enabled: true, termCount: 0, frequencyCount: 9 }];
  // The engine answers only from 辞書 onwards, inside the actual scene passage.
  let libraryAnswers = true;
  // A dictionary mutation refuses the first pass, the way Settings publishing a
  // reimport does; the sentence must be asked again rather than written off.
  let busySweeps = 1;
  // The engine reports a failed reload once, which a status poll repairs, then a
  // mutation still holds it, and only then is it idle.
  const recovering = [{ ok: false, error: "the dictionary reload failed" },
    // A recovery that is itself loading may take as long as it needs.
    { ok: false, error: "the dictionary reload failed", ready: true, loading: true },
    { ok: false, error: "the dictionary reload failed", ready: true, loading: true },
    { ok: false, error: "the dictionary reload failed", ready: true, loading: true },
    { ok: false, error: "the dictionary reload failed", ready: true, loading: true },
    { ok: false, error: "the dictionary reload failed", ready: true, loading: true },
    { ok: false, error: "the dictionary reload failed", ready: true, loading: true },
    { ready: true, loading: true }];
  const answersVerb = (message) => {
    if (busySweeps > 0) {
      busySweeps -= 1;
      return { ok: false, error: "the dictionary engine is busy mutating" };
    }
    return { generation: 3, dictionaryCount: 1,
      results: libraryAnswers && message.text.startsWith("辞書") ? [{ term: "辞書", matched: "辞書" }] : [] };
  };
  const page = startupCase(jsdom, { setup, dictionaries: frequencyOnly, lookup: answersVerb,
    status: () => recovering.shift() ?? {},
    reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }) });
  const { document } = page;
  const sample = () => document.querySelector("#setup-practice-scene:not([hidden]) #setup-practice-text");
  try {
    await page.load();
    await page.until(() => page.heading() === "Add a dictionary to try Hachidori", "the final step without a usable dictionary");
    const withoutDictionary = sample() === null && readerScripts(document).length === 0
      && document.getElementById("setup-body").textContent.includes("Add a term dictionary")
      && document.querySelector('#setup-body a[href="settings.html#add-dictionaries"]') !== null
      && document.querySelector(".setup-anki-outcome")?.dataset.status === "unavailable"
      && JSON.stringify(page.actionIds()) === JSON.stringify(["setup-finish"]);
    // A term dictionary arrives: the exercise appears and the reader is fetched once.
    page.library([...frequencyOnly, { id: "jitendex", title: "Jitendex.org [2026-08-11]", sourceId: "jitendex", enabled: true, termCount: 42 }]);
    await page.until(() => sample() !== null, "the practice exercise");
    // The refused exact-selection query is retried once; its hit settles the
    // exercise without a second sweep over the passage.
    const expected = ["辞書", "辞書"];
    const probed = JSON.stringify(page.lookups()) === JSON.stringify(expected);
    const invited = withoutDictionary && probed && sample()?.textContent === PRACTICE_SENTENCE_TEXT && sample().lang === "ja"
      && document.getElementById("setup-body").textContent.includes("Hold Shift and hover over a word, or use the lookup button.")
      && document.querySelector(".setup-anki-outcome")?.dataset.status === "unavailable"
      && JSON.stringify(page.actionIds()) === JSON.stringify(["setup-finish"])
      // jsdom does not run appended scripts, so the chain stops at the first one.
      && JSON.stringify(readerScripts(document)) === JSON.stringify(MANIFEST_READER_SCRIPTS.slice(0, 1));
    // Rerenders of the same step must not fetch the reader again.
    page.library([...frequencyOnly, { id: "jitendex", title: "Jitendex.org [2026-08-11]", sourceId: "jitendex", enabled: true, termCount: 43 }]);
    await page.until(() => sample() !== null, "the rerendered exercise");
    const loadedOnce = invited && JSON.stringify(readerScripts(document)) === JSON.stringify(MANIFEST_READER_SCRIPTS.slice(0, 1));
    // A group-only or presentation write advances the dictionary revision without
    // changing what the engine can answer, so it must disturb neither the probe
    // nor the sentence node a lookup in flight is anchored to.
    const sampleNode = sample();
    const beforeGroups = page.lookups().length;
    page.library([...frequencyOnly, { id: "jitendex", title: "Jitendex.org [2026-08-11]", sourceId: "jitendex", enabled: true, termCount: 43 }]);
    await page.until(() => sample() !== null, "the undisturbed exercise");
    const groupWriteIgnored = page.lookups().length === beforeGroups && sample() === sampleNode;
    // The answering package is removed while an unrelated term dictionary stays:
    // a previously successful probe must not keep the invitation standing.
    const beforeRetire = page.lookups().length;
    libraryAnswers = false;
    page.library([{ id: "other", title: "Unrelated", enabled: true, termCount: 1 }]);
    await page.until(() => page.document.getElementById("setup-body").textContent.includes("do not have the words in this sample"),
      "the retired invitation");
    const reprobed = loadedOnce && groupWriteIgnored && sample() === null
      && page.lookups().length === beforeRetire + [...PRACTICE_SENTENCE_TEXT].length + 1;
    const partial = await startupPracticePartial(jsdom, setup);
    const offHover = await startupPracticeWithoutHover(jsdom, setup);
    const unanswerable = await startupPracticeUnanswerable(jsdom, setup);
    return { withoutDictionary, invited, loadedOnce, reprobed, partial, offHover, unanswerable };
  } finally {
    page.window.close();
  }
}

// A prefix hit cannot answer the button's exact selection. Other passage words
// remain useful, even with a hover scan shorter than the selected button word.
async function startupPracticePartial(jsdom, setup) {
  const requests = [];
  let shortcutAnswers = false;
  const library = [{ id: "partial", title: "Partial", enabled: true, termCount: 1 }];
  const page = startupCase(jsdom, { setup, dictionaries: library,
    options: { revision: 1, scanLength: 1, maxResults: 7 },
    lookup: (message) => {
      requests.push(message);
      let matched = "踏";
      if (message.text === "辞書") matched = shortcutAnswers ? "辞書" : "辞";
      return { results: [{ term: matched, matched }] };
    },
    reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }) });
  const { document } = page;
  try {
    await page.load();
    const scene = document.getElementById("setup-practice-scene");
    const lookup = document.getElementById("setup-practice-lookup");
    await page.until(() => !scene.hidden, "the passage-only exercise");
    const partial = page.heading() === "You’re ready."
      && lookup.hidden && lookup.disabled && !document.getElementById("setup-practice-tools").hidden
      && document.getElementById("setup-practice-recovery").hidden
      && document.getElementById("setup-practice-instruction").textContent === "Try looking up a word below. Hold Shift and hover over a word."
      && readerScripts(document).length === 1
      && JSON.stringify(requests.map(({ text, scanLength, maxResults }) => [text, scanLength, maxResults]))
        === JSON.stringify([["辞書", 2, 7], [PRACTICE_SENTENCE_TEXT, 1, 1]]);
    shortcutAnswers = true;
    page.library([{ ...library[0], revision: "with-shortcut" }]);
    await page.until(() => !lookup.hidden, "the newly answerable shortcut");
    return partial && requests.length === 3 && requests[2].text === "辞書"
      && document.getElementById("setup-practice-scene") === scene
      && document.getElementById("setup-practice-instruction").textContent.includes("lookup button")
      && readerScripts(document).length === 1;
  } finally {
    page.window.close();
  }
}

// A library that cannot answer this sentence, and an engine that cannot answer
// at all, must not advertise a hover: the first says what is missing, the second
// falls back to the instruction that is true anywhere.
async function startupPracticeUnanswerable(jsdom, setup) {
  const library = [{ id: "other", title: "Unrelated", enabled: true, termCount: 1 }];
  const nothing = startupCase(jsdom, { setup, dictionaries: library, lookup: () => ({ generation: 3, dictionaryCount: 1, results: [] }),
    reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }) });
  const offline = startupCase(jsdom, { setup, dictionaries: library,
    reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }) });
  try {
    await nothing.load();
    await nothing.until(() => nothing.document.getElementById("setup-body").textContent.includes("do not have the words in this sample"),
      "the unanswerable sample");
    const missing = nothing.document.querySelector("#setup-practice-tools").hidden === true
      && readerScripts(nothing.document).length === 0
      && nothing.lookups().length === [...PRACTICE_SENTENCE_TEXT].length + 1
      && nothing.document.querySelector('#setup-body a[href="settings.html#add-dictionaries"]') !== null;
    await offline.load();
    await offline.until(() => offline.document.getElementById("setup-body").textContent.includes("on any webpage"),
      "the unavailable engine");
    // A refused engine is asked again before the step gives up on this page.
    const unavailable = offline.document.querySelector("#setup-practice-tools").hidden === true
      && readerScripts(offline.document).length === 0 && offline.lookups().length > 1;
    return missing && unavailable;
  } finally {
    nothing.window.close();
    offline.window.close();
  }
}

// The reader answers nothing while lookups are switched off, so the step says
// so and points at that setting rather than inviting an impossible hover.
async function startupPracticeWithoutHover(jsdom, setup) {
  const page = startupCase(jsdom, { setup, options: { revision: 2, hoverEnabled: false },
    dictionaries: [{ id: "jitendex", title: "Jitendex.org [2026-08-11]", sourceId: "jitendex", enabled: true, termCount: 42 }],
    reply: () => ({ runId: null, sequence: 0, finished: true, entries: [] }) });
  try {
    await page.load();
    await page.until(() => page.heading() === "Turn on lookups to try Hachidori", "the final step with lookups off");
    return page.document.querySelector("#setup-practice-tools").hidden === true
      && readerScripts(page.document).length === 0
      && page.document.getElementById("setup-body").textContent.includes("Lookups are turned off")
      && page.document.querySelector('#setup-body a[href="settings.html#lookup"]') !== null
      && JSON.stringify(page.actionIds()) === JSON.stringify(["setup-finish"]);
  } finally {
    page.window.close();
  }
}

async function visualNovelStage() {
  const jsdom = await loadJsdom();
  if (!jsdom) return null;
  const result = { randomStart: true, cycle: true, retained: true, startupSurface: true };
  for (const [random, first] of [[0, 0], [0xffffffff, 3]]) {
    const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "design-preview.html"), "utf8"), {
      runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/design-preview.html`,
    });
    const { window } = dom;
    try {
      let randomCalls = 0;
      window.crypto.getRandomValues = values => { randomCalls += 1; values[0] = random; return values; };
      window.eval(readFileSync(resolve(EXTENSION, "visual-novel.js"), "utf8"));
      const scene = window.document.querySelector(".vn-scene");
      const source = scene.querySelector("#preview-source");
      const text = source.firstChild;
      const dialogue = scene.querySelector(".vn-dialogue");
      const style = window.document.createElement("style");
      style.textContent = ["visual-novel.css", "startup.css"].map(file => readFileSync(resolve(EXTENSION, file), "utf8")).join("\n");
      window.document.head.append(style);
      dialogue.classList.add("setup-practice-dialogue");
      window.HDVisualNovel.initialize(scene);
      const next = scene.querySelector(".vn-next");
      const filename = index => `assets/preview-background${index === 0 ? "" : `-${index + 1}`}.webp`;
      result.randomStart &&= scene.style.getPropertyValue("--vn-background").includes(filename(first));
      result.cycle &&= next?.tagName === "BUTTON" && next.type === "button" && next.getAttribute("aria-label") === "Next background";
      const visited = new Set();
      for (let step = 0; step < 6; step += 1) {
        const index = (first + step) % 6;
        visited.add(scene.style.getPropertyValue("--vn-background"));
        result.cycle &&= scene.style.getPropertyValue("--vn-background").includes(filename(index))
          && scene.classList.contains("vn-dark-dialogue") === [3, 5].includes(index);
        result.startupSurface &&= window.getComputedStyle(dialogue).backgroundColor ===
          ([3, 5].includes(index) ? "rgba(28, 20, 35, 0.88)" : "rgba(250, 247, 252, 0.88)");
        next?.click();
      }
      result.cycle &&= visited.size === 6 && scene.style.getPropertyValue("--vn-background").includes(filename(first)) && randomCalls === 1;
      result.retained &&= scene.querySelector("#preview-source") === source && source.firstChild === text
        && source.textContent === "朝ごはんを食べる。" && scene.querySelector(".vn-dialogue") === dialogue;
    } finally { window.close(); }
  }
  return result;
}

describe("startup page", () => {
  test("first-run setup waits for a saved Start", async () => {
    const welcome = await startupWelcomeStage();
    check("first-run setup waits for a saved Start, resumes it and permits manual setup",
      welcome !== null && Object.values(welcome).every((value) => value === true), JSON.stringify(welcome));
  });

  test("the startup page mirrors its installer run", async () => {
    const startup = await startupPageStage();
    check("the startup page mirrors its own installer run, keeps focus, retries only missing dictionaries and advances immediately",
      startup !== null && Object.values(startup).every((value) => value === true), JSON.stringify(startup));
  });

  test("a silent run is observed again", async () => {
    const runRecovery = await startupRunRecoveryStage();
    check("a startup page whose run went silent observes the installer again and restarts the unrecorded sources",
      runRecovery !== null && Object.values(runRecovery).every((value) => value === true), JSON.stringify(runRecovery));
  });

  test("a failed source installed from Settings is reconciled", async () => {
    const reconcile = await startupReconcileStage();
    check("a failed source the user installed from Settings is reconciled once while a missing failure waits for Retry",
      reconcile !== null && Object.values(reconcile).every((value) => value === true), JSON.stringify(reconcile));
  });

  test("a refused immediate advance leaves Continue", async () => {
    const advanceFailure = await startupAdvanceFailureStage();
    check("a refused immediate advance leaves an explicit Continue without saving again",
      advanceFailure !== null && Object.values(advanceFailure).every((value) => value === true), JSON.stringify(advanceFailure));
  });

  test("the practice step", async () => {
    const practice = await startupPracticeStage();
    check("the practice step invites a lookup only when a dictionary can answer one and loads the reader once with that step",
      practice !== null && Object.values(practice).every((value) => value === true), JSON.stringify(practice));
  });

  test("visual novel scenes", async () => {
    const scenes = await visualNovelStage();
    check("visual novel scenes start randomly and cycle all six backgrounds without replacing the dialogue",
      scenes !== null && Object.values(scenes).every((value) => value === true), JSON.stringify(scenes));
  });
});
