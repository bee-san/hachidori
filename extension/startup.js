/*
 * Startup page: the first-run setup shown once after installation.
 *
 * The service worker owns the revisioned setup state; this page reads it from
 * storage, renders the current stage in one card, and advances it through
 * compare-and-set writes so a stale tab cannot move a newer screen backward.
 * The dictionary stage attaches to the offscreen installer's run, which outlives
 * this page, and mirrors its per-dictionary phases.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./reader-options.js";
import { recommendedDictionaryInstalled } from "./managed-dictionary-source.js";
import { RECOMMENDED_DICTIONARIES } from "./recommended-dictionaries.js";
import { SETUP_STATE_KEY, SETUP_STAGES, normaliseSetupState } from "./setup-state.js";
import { createPracticeView, practiceReadiness } from "./startup-practice.js";

const WORKER_TARGET = "hoshidicts-worker";
const SETUP_TARGET = "hachidori-setup";
const SETUP_EVENTS_TARGET = "hachidori-setup-events";
const ENGINE_TARGET = "hoshidicts-offscreen";
const SUCCESS_DISPLAY_MS = 5000;
const COUNTDOWN_TICK_MS = 250;
// A run reports at every phase change and about ten times a second while a body
// arrives, so a longer silence means the offscreen document that owned it is gone.
const RUN_SILENCE_MS = 4000;
// A dictionary mutation refuses lookups while it holds the engine, so the
// practice probe waits for the engine to go idle and asks again rather than
// calling the sentence unanswerable. Only an idle engine that still refuses is
// counted, so a long generation cleanup cannot exhaust these attempts.
const PROBE_RETRY_MS = 400;
const PROBE_ATTEMPTS = 5;
const { normaliseOptions } = globalThis.HDReaderOptions;
const STEP_STAGES = SETUP_STAGES.slice(0, 3);

let setupState = null;
let setupError = null;
let dictionaries = [];
let dictionaryRevision = -1;
let options = normaliseOptions(undefined);
let optionsRevision = -1;
let requestCounter = 0;
let saving = false;
let renderedStage;
// The installer run this page follows: the latest attach reply, then only
// newer events carrying the same run identity.
let run = null;
let attaching = null;
let countdown = null;
let countdownPaused = false;
let advanceFailed = false;
// A failed install request is shown once with Retry; the page never re-requests on its own.
let installFailed = false;
let runSilenceTimer = null;
let readerLoading = null;
// What a real lookup of the practice sentence found: unknown, "ready" (the
// exact-selection shortcut answers), "passage" (another passage lookup answers),
// "missing" (nothing in the installed dictionaries) or "unavailable" (the engine
// could not answer). Probed again whenever the inventory or the options it
// depends on change, so a removed dictionary or a shortened scan cannot leave a
// stale invitation standing.
let practiceOutcome = null;
let practiceProbed = "";
// Anki detection is asked for once per page; a failed request waits for Retry.
let ankiRequest = null;
let ankiFailed = false;
let ankiAdvancing = false;
const announced = new Map();
let dictionaryList;
let practice;

function element(id) {
  return document.getElementById(id);
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function describe(error) {
  return typeof error?.message === "string" && error.message !== "" ? error.message : String(error);
}

async function send(type, fields, target = WORKER_TARGET) {
  requestCounter += 1;
  const reply = await chrome.runtime.sendMessage({
    target,
    type,
    requestId: `${type.replace(/^hd_/u, "")}-${requestCounter}`,
    ...fields,
  });
  if (!reply) throw new Error("the extension's service worker did not reply");
  return reply;
}

function adoptSetupState(value) {
  let state;
  try {
    state = normaliseSetupState(value);
  } catch (error) {
    setupError = describe(error);
    return true;
  }
  setupError = null;
  if (state !== null && setupState !== null && state.revision <= setupState.revision) return false;
  setupState = state;
  return true;
}

function adoptDictionaryState(value) {
  const revision = Number.isInteger(value?.revision) ? value.revision : 0;
  if (revision <= dictionaryRevision) return false;
  dictionaryRevision = revision;
  dictionaries = Array.isArray(value?.dictionaries) ? value.dictionaries : [];
  return true;
}

function adoptOptions(value) {
  const revision = Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0;
  if (revision <= optionsRevision) return false;
  optionsRevision = revision;
  options = normaliseOptions(value);
  return true;
}

function setStatus(message, tone = "") {
  const status = element("setup-status");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
}

function paragraph(text, className = "hint") {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

// Every control the card rebuilds carries a stable key so a rerender can hand
// focus back to its replacement.
function settingsNote(before, href, after = ".") {
  const node = document.createElement("p");
  node.className = "hint";
  const link = document.createElement("a");
  link.href = href;
  link.dataset.focusKey = `link:${href}`;
  link.textContent = "Settings";
  node.append(before, link, after);
  return node;
}

function button(id, text, onClick, className = "primary-button") {
  const node = document.createElement("button");
  node.type = "button";
  node.id = id;
  node.dataset.focusKey = id;
  node.className = className;
  node.textContent = text;
  node.disabled = saving;
  node.addEventListener("click", onClick);
  return node;
}

function formatBytes(bytes) {
  return bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatSeconds(seconds) {
  return seconds < 10 ? `${seconds.toFixed(1)} seconds` : `${Math.round(seconds)} seconds`;
}

function missingEntries() {
  return RECOMMENDED_DICTIONARIES.filter((entry) => !recommendedDictionaryInstalled(entry, dictionaries));
}

// Sources setup has no settled outcome for: a missing one installs, an
// installed one is recorded as already installed. That covers a package whose
// commit outlived the installer that made it, and one the user installed from
// Settings after an automatic attempt failed — its stale failure is reconciled
// without importing anything. A failed source that is still missing waits for
// the explicit Retry.
function untouchedEntries() {
  return RECOMMENDED_DICTIONARIES.filter((entry) => {
    const outcome = setupState.dictionaries.outcomes[entry.sourceId];
    if (outcome === undefined) return true;
    return outcome.status === "failed" && recommendedDictionaryInstalled(entry, dictionaries);
  });
}

function runActive() {
  return run !== null && run.finished === false;
}

// A row's text follows the live run while one is active, and otherwise the
// recorded outcome checked against the current inventory: a dictionary removed
// after setup shows as not installed rather than keeping an old time.
function rowState(entry) {
  const live = runActive() ? run.entries.find((candidate) => candidate.sourceId === entry.sourceId) : undefined;
  if (live !== undefined) {
    switch (live.phase) {
      case "downloading": {
        const received = formatBytes(live.receivedBytes);
        if (live.totalBytes === null) return { text: `Downloading… ${received}`, progress: { value: null } };
        const fraction = Math.min(1, live.receivedBytes / live.totalBytes);
        return {
          text: `Downloading… ${received} of ${formatBytes(live.totalBytes)} (${Math.floor(fraction * 100)}%)`,
          progress: { value: fraction },
        };
      }
      case "installing": return { text: "Installing…", progress: { value: null } };
      case "installed": return { text: `Installed in ${formatSeconds(live.seconds)}`, tone: "ok" };
      case "already-installed": return { text: "Already installed", tone: "ok" };
      case "failed": return { text: `Failed: ${live.error}`, tone: "error" };
      default: return { text: "Waiting" };
    }
  }
  const outcome = setupState.dictionaries.outcomes[entry.sourceId];
  if (recommendedDictionaryInstalled(entry, dictionaries)) {
    return outcome?.status === "installed" && outcome.seconds !== null
      ? { text: `Installed in ${formatSeconds(outcome.seconds)}`, tone: "ok" }
      : { text: "Already installed", tone: "ok" };
  }
  if (outcome?.status === "failed") return { text: `Failed: ${outcome.error}`, tone: "error" };
  return { text: "Not installed" };
}

function progressBar(progress, labelId) {
  const track = document.createElement("div");
  track.className = `track setup-track${progress.value === null ? "" : " is-determinate"}`;
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-labelledby", labelId);
  if (progress.value === null) {
    track.setAttribute("aria-valuetext", "In progress");
  } else {
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.floor(progress.value * 100)));
    track.style.setProperty("--progress", `${progress.value * 100}%`);
  }
  const fill = document.createElement("div");
  fill.className = "track-fill";
  track.appendChild(fill);
  return track;
}

function dictionaryRows() {
  if (dictionaryList) {
    updateDictionaryRows();
    return dictionaryList;
  }
  const list = document.createElement("ul");
  dictionaryList = list;
  list.className = "setup-dictionary-list";
  list.setAttribute("aria-label", "Default dictionaries");
  for (const entry of RECOMMENDED_DICTIONARIES) {
    const row = document.createElement("li");
    row.className = "setup-dictionary";
    row.dataset.sourceId = entry.sourceId;
    const name = document.createElement("span");
    name.className = "setup-dictionary-name";
    name.id = `setup-dictionary-${entry.sourceId}`;
    name.textContent = entry.name;
    const purpose = document.createElement("span");
    purpose.className = "setup-dictionary-purpose";
    purpose.textContent = entry.description;
    const status = document.createElement("span");
    status.className = "setup-dictionary-status";
    status.id = `setup-dictionary-status-${entry.sourceId}`;
    row.append(name, purpose, status);
    const track = progressBar({ value: null }, name.id);
    track.setAttribute("aria-describedby", status.id);
    row.appendChild(track);
    list.appendChild(row);
  }
  updateDictionaryRows();
  return list;
}

function updateDictionaryRows() {
  for (const [index, entry] of RECOMMENDED_DICTIONARIES.entries()) {
    const state = rowState(entry);
    const row = dictionaryList.children[index];
    const status = row.querySelector(".setup-dictionary-status");
    if (status.textContent !== state.text) status.textContent = state.text;
    status.classList.toggle("is-ok", state.tone === "ok");
    status.classList.toggle("is-error", state.tone === "error");
    row.classList.toggle("is-active", Boolean(state.progress));
    const track = row.querySelector(".setup-track");
    track.hidden = !state.progress;
    const value = state.progress?.value;
    const determinate = typeof value === "number";
    track.classList.toggle("is-determinate", determinate);
    if (determinate) {
      track.removeAttribute("aria-valuetext");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(Math.floor(value * 100)));
      track.style.setProperty("--progress", `${value * 100}%`);
    } else {
      track.removeAttribute("aria-valuenow");
      track.removeAttribute("aria-valuemin");
      track.removeAttribute("aria-valuemax");
      track.setAttribute("aria-valuetext", state.text);
    }
  }
}

// Announce outcomes, not bytes: one sentence when a dictionary settles.
function announceOutcomes() {
  if (!runActive()) return;
  for (const entry of run.entries) {
    if (!["installed", "already-installed", "failed"].includes(entry.phase) || announced.get(`${run.runId}:${entry.sourceId}`) === entry.phase) continue;
    announced.set(`${run.runId}:${entry.sourceId}`, entry.phase);
    const name = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.sourceId === entry.sourceId)?.name ?? entry.sourceId;
    if (entry.phase === "installed") setStatus(`${name} installed in ${formatSeconds(entry.seconds)}.`);
    else if (entry.phase === "already-installed") setStatus(`${name} was already installed.`);
    else setStatus(`${name} could not be installed: ${entry.error}`, "error");
  }
}

function cancelCountdown() {
  if (countdown === null) return;
  clearTimeout(countdown.timer);
  clearInterval(countdown.ticker);
  countdown = null;
}

function countdownLabel() {
  const remaining = Math.max(0, Math.ceil((SUCCESS_DISPLAY_MS - (Date.now() - countdown.startedAt)) / 1000));
  return `Continuing to Anki in ${remaining} ${remaining === 1 ? "second" : "seconds"}`;
}

function updateCountdown() {
  if (countdown === null) return;
  const label = element("setup-countdown-label");
  const track = element("setup-countdown-track");
  if (!label || !track) return;
  const elapsed = Math.min(1, (Date.now() - countdown.startedAt) / SUCCESS_DISPLAY_MS);
  label.textContent = countdownLabel();
  track.setAttribute("aria-valuenow", String(Math.floor(elapsed * 100)));
  track.style.setProperty("--progress", `${elapsed * 100}%`);
}

async function finishCountdown() {
  cancelCountdown();
  if (setupState?.stage !== "dictionaries" || missingEntries().length > 0) return;
  // The installer may have recorded its run total between our read and this
  // write; the second attempt carries the revision that reply delivered.
  let advanced = await advance("anki");
  if (!advanced && setupState?.stage === "dictionaries" && missingEntries().length === 0) advanced = await advance("anki");
  if (!advanced && setupState?.stage === "dictionaries") {
    // Leave the result readable with an explicit control instead of retrying on a timer.
    advanceFailed = true;
    render();
  }
}

// The all-installed result stays readable for five seconds, then setup moves
// on by itself. The countdown label is not a live region: ticks are not news.
function startCountdown() {
  if (countdown !== null) return;
  countdown = {
    startedAt: Date.now(),
    ticker: setInterval(updateCountdown, COUNTDOWN_TICK_MS),
    timer: setTimeout(() => { void finishCountdown(); }, SUCCESS_DISPLAY_MS),
  };
}

function countdownView() {
  const wrapper = document.createElement("div");
  wrapper.className = "setup-countdown";
  const label = document.createElement("span");
  label.id = "setup-countdown-label";
  label.className = "setup-countdown-label";
  label.textContent = countdownLabel();
  const track = document.createElement("div");
  track.id = "setup-countdown-track";
  track.className = "track setup-track is-determinate";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-labelledby", "setup-countdown-label");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", "0");
  track.style.setProperty("--progress", "0%");
  track.appendChild(document.createElement("div")).className = "track-fill";
  wrapper.append(label, track);
  return wrapper;
}

function adoptRun(snapshot) {
  run = {
    runId: snapshot.runId ?? null,
    sequence: Number(snapshot.sequence) || 0,
    finished: snapshot.finished !== false,
    entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
  };
  watchRun();
}

// An offscreen document terminated mid-run stops reporting with this page still
// holding an unfinished snapshot, which no event can ever complete. After a
// silence longer than any phase change, the page observes the installer again
// with an empty request: a live run answers with its own snapshot, and a
// replacement installer answers with an empty, finished one, which lets the
// sources that have no recorded outcome be requested once more.
function watchRun() {
  if (runSilenceTimer !== null) clearTimeout(runSilenceTimer);
  runSilenceTimer = null;
  if (!runActive()) return;
  runSilenceTimer = setTimeout(() => {
    runSilenceTimer = null;
    if (!runActive() || attaching !== null) return;
    void send("hd_setup_install", { sourceIds: [] }, SETUP_TARGET).then((reply) => {
      // A live run keeps the progress this page already applied and is watched
      // again; only a replaced or finished run changes the screen.
      if (reply.ok !== true || (reply.runId === run?.runId && reply.finished !== true)) {
        watchRun();
        return;
      }
      adoptRun(reply);
      render();
    }).catch(() => { watchRun(); });
  }, RUN_SILENCE_MS);
}

function requestInstall(sourceIds) {
  if (attaching !== null) return attaching.promise;
  installFailed = false;
  const promise = send("hd_setup_install", { sourceIds }, SETUP_TARGET).then((reply) => {
    if (!reply.ok) throw new Error(reply.error || "the dictionary installer did not start");
    adoptRun(reply);
    if (runActive() && sourceIds.length > 0) setStatus("Installing default dictionaries.");
  }).catch((error) => {
    installFailed = true;
    setStatus(`Could not start dictionary installation: ${describe(error)}`, "error");
  }).finally(() => {
    attaching = null;
    render();
  });
  attaching = { promise, installing: sourceIds.length > 0 };
  return promise;
}

// A complete inventory is announced with this setup's own install time only
// when it installed something; a profile that already carried every source
// reads as already installed. The result holds for five seconds.
function installedView(rows, importNote) {
  const total = setupState.dictionaries.totalSeconds;
  const installedHere = Object.values(setupState.dictionaries.outcomes).some((outcome) => outcome.status === "installed");
  // A failed advance is an action-required state: the countdown a render during
  // those attempts restarted is cancelled rather than left to retry silently.
  if (advanceFailed || countdownPaused) cancelCountdown();
  else startCountdown();
  return {
    heading: installedHere && total !== null ? `All dictionaries installed in ${formatSeconds(total)}` : "All dictionaries are already installed",
    body: [paragraph("Your recommended dictionaries are installed. You can add your own whenever you like."), rows, importNote,
      ...(advanceFailed ? [] : [countdownPaused ? paragraph("Automatic continuation is paused. Continue when you’re ready.") : countdownView()])],
    actions: [button("setup-continue", "Continue now", () => { void finishCountdown(); }),
      ...(advanceFailed ? [] : [button("setup-pause", countdownPaused ? "Resume countdown" : "Pause countdown", () => {
        countdownPaused = !countdownPaused;
        render();
      }, "ghost")])],
  };
}

// A failed or later removed source waits for an explicit retry of the missing
// ones, and setup can be continued without them.
function incompleteView(rows, importNote, missing) {
  const failed = installFailed || missing.some((entry) => setupState.dictionaries.outcomes[entry.sourceId]?.status === "failed");
  return {
    heading: failed ? "Some dictionaries could not be installed" : "Some dictionaries are not installed",
    body: [paragraph("Retry the missing dictionaries, or continue and add them later in Settings."), rows, importNote],
    actions: [
      button("setup-retry", "Retry missing dictionaries", () => { void requestInstall(missing.map((entry) => entry.sourceId)); }),
      button("setup-continue", "Continue setup", () => { void advance("anki", { continued: true }); }, "ghost"),
    ],
  };
}

// Every source without a recorded outcome is requested on its own; the run's
// live rows and the recorded result follow.
function dictionariesView() {
  const rows = dictionaryRows();
  const importNote = settingsNote("Import your own dictionary ZIPs in ", "settings.html#add-dictionaries");
  const installingView = () => ({
    heading: "Installing default dictionaries…",
    body: [paragraph("These four dictionaries get you started. Installation continues if you close this tab; use Resume setup in Settings to return."), rows, importNote],
    actions: [],
  });
  if (attaching !== null && !attaching.installing && !runActive()) {
    cancelCountdown();
    return { heading: "Checking installed dictionaries…", body: [rows, importNote], actions: [] };
  }
  if (runActive() || attaching !== null) {
    cancelCountdown();
    return installingView();
  }
  const untouched = untouchedEntries();
  if (untouched.length > 0 && !installFailed) {
    void requestInstall(untouched.map((entry) => entry.sourceId));
    return installingView();
  }
  const missing = missingEntries();
  if (missing.length === 0) return installedView(rows, importNote);
  cancelCountdown();
  return incompleteView(rows, importNote, missing);
}

function requestAnkiSetup() {
  if (ankiRequest !== null) return ankiRequest;
  ankiFailed = false;
  ankiRequest = send("hd_setup_anki", {}).then((reply) => {
    if (!reply.ok) throw new Error(reply.error || "Anki could not be checked");
    adoptSetupState(reply.state);
    // The reply promises a recorded outcome; without one the check is reported, not repeated.
    if (setupState?.anki === null) throw new Error("no Anki outcome was recorded");
  }).catch((error) => {
    ankiFailed = true;
    setStatus(`Could not check Anki: ${describe(error)}`, "error");
  }).finally(() => {
    ankiRequest = null;
    render();
  });
  return ankiRequest;
}

// The settled Anki outcome, with its Settings link, as one readable sentence.
// Names come from Anki and are rendered as text, never as markup.
function ankiOutcomeNote(anki) {
  const node = document.createElement("p");
  node.className = "hint setup-anki-outcome";
  node.dataset.status = anki.status;
  const link = document.createElement("a");
  link.href = "settings.html#anki";
  link.dataset.focusKey = "link:settings.html#anki";
  link.textContent = "Settings";
  if (anki.status === "configured") {
    node.append(`Automatically set up ${anki.model} for deck ‘${anki.deck}’. Change in `, link, ".");
  } else if (anki.status === "already-configured") {
    node.append(`Anki is already set up with ${anki.model} for deck ‘${anki.deck}’. Change in `, link, ".");
  } else if (anki.status === "unavailable") {
    node.append("Anki isn’t connected. It’s optional — you can set it up later in ", link, ".");
  } else {
    node.append(`Anki needs attention: ${anki.detail} Set up in `, link, ".");
  }
  return node;
}

function ankiHeading(anki) {
  switch (anki.status) {
    case "configured": return "Anki is set up";
    case "already-configured": return "Anki is already set up";
    case "unavailable": return "Anki isn’t connected";
    default: return "Anki needs attention";
  }
}

// Detection runs once per installation; its recorded outcome moves setup on by
// itself and stays readable on the final screen.
function ankiView() {
  const anki = setupState.anki;
  if (anki === null) {
    if (ankiFailed) {
      return {
        heading: "Anki could not be checked",
        body: [settingsNote("Anki is optional. You can set it up later in ", "settings.html#anki")],
        actions: [
          button("setup-retry", "Retry", () => { void requestAnkiSetup(); }),
          button("setup-continue", "Continue setup", () => { void advance("practice"); }, "ghost"),
        ],
      };
    }
    void requestAnkiSetup();
    return {
      heading: "Connect Anki, if you use it",
      body: [paragraph("Anki is optional. Hachidori can look up words without it."),
        paragraph("Checking for an existing Senren, Lapis or Kiku setup to use for flashcards…"),
        paragraph("You can continue while the check finishes in the background.")],
      actions: [button("setup-continue", "Continue now", () => { void advance("practice"); })],
    };
  }
  if (advanceFailed) {
    return { heading: ankiHeading(anki), body: [ankiOutcomeNote(anki)],
      actions: [button("setup-continue", "Continue setup", () => { void advance("practice"); })] };
  }
  if (!ankiAdvancing) void advanceAfterAnki();
  return { heading: ankiHeading(anki), body: [ankiOutcomeNote(anki)], actions: [] };
}

async function advanceAfterAnki() {
  ankiAdvancing = true;
  try {
    if (!await advance("practice") && setupState?.stage === "anki") advanceFailed = true;
  } finally {
    ankiAdvancing = false;
  }
  if (advanceFailed) render();
}

// The reader itself, in the one authoritative order: the manifest's own
// content-script list, minus `reader-options.js`, which this module already
// loaded. It arrives only when the practice step does, so nothing scans the
// installation or Anki screens.
function readerScripts() {
  const [injected] = chrome.runtime.getManifest().content_scripts ?? [];
  return (injected?.js ?? []).filter((src) => src !== "reader-options.js");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.dataset.setupReader = "true";
    script.addEventListener("load", () => { resolve(); });
    script.addEventListener("error", () => { reject(new Error(`${src} could not be loaded`)); });
    document.head.appendChild(script);
  });
}

// One load per page: the reader initialises itself when its last script runs.
function loadReader() {
  readerLoading ??= readerScripts().reduce(
    (chain, src) => chain.then(() => loadScript(src)), Promise.resolve(),
  ).catch((error) => {
    // The persistent practice controller also exposes its recovery link.
    setStatus(`The lookup exercise could not start: ${describe(error)}`, "error");
    throw error;
  });
  return readerLoading;
}

// The invitation is only made when this exact sentence can be answered, so the
// page asks the exact-selection shortcut first, then ordinary lookups from the
// passage offsets if needed, stopping at the first hit. A partly installed or
// unrelated library therefore cannot advertise an exercise that returns nothing.
// What the answer depends on, rather than the whole revision: the engine-visible
// library and the lookup options the probe sends. A group-only or presentation
// write leaves this unchanged, so it cannot invalidate a ready exercise.
function practiceSignature() {
  const library = dictionaries.map((dictionary) => [dictionary?.id ?? "", dictionary?.title ?? "",
    dictionary?.revision ?? "", dictionary?.path ?? "", dictionary?.enabled !== false,
    dictionary?.termCount ?? 0].join("\u001f")).join("\u001e");
  return `${library}|${options.scanLength}|${options.maxResults}|${options.frequencyDictionary}|${options.frequencyOrder}`;
}

async function probePracticeText(signature, text, exact = false) {
  let reply;
  try {
    // Selection uses the selected word's length and ignores prefix-only hits;
    // hover uses the configured scan length and needs just one term result.
    reply = await send("hd_lookup", { text,
      scanLength: exact ? [...text].length : options.scanLength,
      maxResults: exact ? options.maxResults : 1,
      options: { frequencyDictionary: options.frequencyDictionary, frequencyOrder: options.frequencyOrder, primaryReading: "" },
    }, ENGINE_TARGET);
  } catch {
    return "refused";
  }
  if (practiceProbed !== signature) return "gone";
  if (reply?.ok === false) return "refused";
  const found = Array.isArray(reply?.results) && reply.results.some((result) => result?.term
    && (!exact || result.matched === text));
  return found ? "ready" : "missing";
}

// Prove the fixed shortcut first. If it misses, one passage sweep can still
// enable ordinary hover/selection without advertising that unanswered button.
async function sweepPractice(signature) {
  const word = practice.node.querySelector("#setup-practice-word").textContent;
  const shortcut = await probePracticeText(signature, word, true);
  if (shortcut !== "missing") return shortcut;
  const characters = [...practice.node.querySelector("#setup-practice-text").textContent];
  for (let start = 0; start < characters.length; start += 1) {
    const found = await probePracticeText(signature, characters.slice(start).join(""));
    if (found === "ready") return "passage";
    if (found !== "missing") return found;
  }
  return "missing";
}

// The engine reports ready after boot and loading while any mutation, including
// a long generation cleanup, holds it. Waiting here is what keeps a refusal from
// becoming a verdict. A failed status is also worth waiting on: a status poll is
// what drives the engine's own reload recovery, so the next one can describe a
// repaired engine. Only an unreachable engine, or one that keeps failing, ends
// the wait, as does a newer signature.
async function awaitIdleEngine(signature) {
  for (let failures = 0; failures < PROBE_ATTEMPTS;) {
    let status;
    try {
      status = await send("hd_status", {}, ENGINE_TARGET);
    } catch {
      return false;
    }
    if (practiceProbed !== signature) return false;
    if (status?.ok === true && status.ready === true && status.loading !== true) return true;
    // A failure that is still loading is recovery in progress, not a verdict.
    if (status?.ok !== true && status?.loading !== true) failures += 1;
    await wait(PROBE_RETRY_MS);
    if (practiceProbed !== signature) return false;
  }
  return false;
}

function probePractice() {
  const signature = practiceSignature();
  practiceProbed = signature;
  practiceOutcome = null;
  void (async () => {
    const settle = (found) => {
      if (practiceProbed !== signature) return;
      practiceOutcome = found;
      render();
    };
    for (let refusals = 0; refusals < PROBE_ATTEMPTS; refusals += 1) {
      const found = await sweepPractice(signature);
      // A newer inventory or option has its own probe; this one's answer is stale.
      if (found === "gone" || practiceProbed !== signature) return;
      if (found !== "refused") {
        settle(found);
        return;
      }
      if (!await awaitIdleEngine(signature)) {
        settle("unavailable");
        return;
      }
    }
    settle("unavailable");
  })();
}

// Preserve the reviewed scene while the current library is proved answerable.
// Finish and saved-page guidance remain available throughout the probe.
function practiceView() {
  practice ??= createPracticeView({ document, loadReader, onReaderSettled: render,
    onDismiss: () => { element("setup-finish")?.focus(); } });
  if (!practiceReadiness(options, dictionaries).canProbe) {
    // Retire an in-flight probe when lookup becomes unavailable too.
    practiceProbed = "";
    practiceOutcome = null;
  } else if (practiceProbed !== practiceSignature()) {
    probePractice();
  }
  const readiness = practice.update(options, dictionaries, practiceOutcome);
  return {
    heading: readiness.heading,
    body: [practice.node, ...(setupState.anki === null ? [] : [ankiOutcomeNote(setupState.anki)])],
    actions: [button("setup-finish", "Finish setup", () => { void finish(); }, readiness.message ? "ghost" : "primary-button"), paragraph("The exercise is optional. You can finish any time.")],
  };
}

const VIEWS = {
  dictionaries: dictionariesView,
  anki: ankiView,
  practice: practiceView,
  complete: () => ({
    heading: "Setup is complete.",
    body: [paragraph("You can close this tab. Your setup progress is saved."), settingsNote("Change dictionaries, Anki and reading preferences any time in ", "settings.html")],
    actions: [],
  }),
};

function inactiveView() {
  return {
    heading: "Manage Hachidori",
    body: [settingsNote("Setup runs once after installation. Manage dictionaries and preferences in ", "settings.html")],
    actions: [],
  };
}

function failedView() {
  return {
    heading: "Setup could not be read.",
    body: [paragraph(setupError, "hint is-error"), settingsNote("Manage dictionaries and preferences in ", "settings.html")],
    actions: [button("setup-reload", "Reload setup", () => { location.reload(); })],
  };
}

function renderSteps(stage) {
  const position = stage === null ? -1 : SETUP_STAGES.indexOf(stage);
  for (const step of element("setup-steps").querySelectorAll(".setup-step")) {
    const index = STEP_STAGES.indexOf(step.dataset.stage);
    const current = index === position;
    step.classList.toggle("is-current", current);
    step.classList.toggle("is-done", position > index);
    if (current) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  }
}

function currentView() {
  if (setupError !== null) return failedView();
  if (setupState === null) return inactiveView();
  if (setupState.stage !== "dictionaries") cancelCountdown();
  return VIEWS[setupState.stage]();
}

function renderBody(children) {
  const body = element("setup-body");
  // Remove obsolete nodes backwards before inserting replacements, keeping
  // persistent rows and the scene connected throughout the update.
  for (let index = body.children.length - 1; index >= 0; index -= 1) {
    const child = body.children[index];
    if (!children.includes(child)) child.remove();
  }
  for (const [index, child] of children.entries()) {
    if (body.children[index] !== child) body.insertBefore(child, body.children[index] ?? null);
  }
}

function render() {
  const stage = setupError === null ? setupState?.stage ?? null : null;
  // A stage of its own starts without the previous stage's failed-advance state.
  if (stage !== renderedStage) advanceFailed = false;
  const card = element("setup-card");
  const focusKey = card.contains(document.activeElement) ? document.activeElement.dataset.focusKey ?? "" : "";
  const view = currentView();
  renderSteps(stage);
  const heading = element("setup-heading");
  if (heading.textContent !== view.heading) heading.textContent = view.heading;
  renderBody(view.body);
  element("setup-actions").replaceChildren(...view.actions);
  announceOutcomes();
  if (heading.textContent !== lastAnnouncedHeading) {
    lastAnnouncedHeading = heading.textContent;
    if (!element("setup-status").classList.contains("is-error")) setStatus(view.heading);
  }
  if (renderedStage !== undefined && renderedStage !== stage) {
    // The control that held focus belonged to the previous stage.
    heading.focus();
  } else if (focusKey) {
    const replacement = [...card.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
    // Retry removes its button while work runs; keep a keyboard user's place
    // at the result heading when that action no longer exists.
    (replacement ?? heading).focus();
  }
  renderedStage = stage;
}

let lastAnnouncedHeading;

async function advance(stage, { continued = false } = {}) {
  if (saving || setupState === null) return false;
  saving = true;
  for (const control of element("setup-actions").querySelectorAll("button")) control.disabled = true;
  setStatus("Saving…");
  let advanced = false;
  try {
    const reply = await send("hd_setup_cas", { baseRevision: setupState.revision, stage, ...(continued ? { continued } : {}) });
    if (reply.state) adoptSetupState(reply.state);
    // Another tab may have already made this exact move: the conflict it leaves
    // behind is the move this page asked for, not a failure to report.
    const reached = setupState !== null && SETUP_STAGES.indexOf(setupState.stage) >= SETUP_STAGES.indexOf(stage);
    if (!reply.ok && !(reply.conflict === true && reached)) throw new Error(reply.error || "setup progress could not be saved");
    setStatus("");
    advanced = true;
  } catch (error) {
    setStatus(`Could not save setup progress: ${describe(error)}`, "error");
  } finally {
    saving = false;
    render();
  }
  return advanced;
}

async function finish() {
  if (!await advance("complete")) return;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  } catch {
    // The completed view stays readable when the tab cannot close itself.
  }
}

function handleStorageChange(changes, area) {
  if (area !== "local") return;
  let changed = false;
  if (changes[SETUP_STATE_KEY]) changed = adoptSetupState(changes[SETUP_STATE_KEY].newValue) || changed;
  if (changes.dictionaryState) changed = adoptDictionaryState(changes.dictionaryState.newValue) || changed;
  if (changes.options) changed = adoptOptions(changes.options.newValue) || changed;
  // A write in flight renders once its reply settles.
  if (changed && !saving) render();
}

// Progress from the installer, which also reaches any other startup tab. Only
// events for the run this page attached to, in order, can change the screen.
// Nothing is answered, so the listener never claims an asynchronous response.
function handleRuntimeMessage(message) {
  if (message?.target !== SETUP_EVENTS_TARGET || message.type !== "hd_setup_progress" || run === null) return;
  const sequence = Number(message.sequence);
  if (message.runId !== run.runId || !Number.isFinite(sequence) || sequence <= run.sequence) return;
  adoptRun(message);
  if (!saving) render();
}

async function start() {
  // Focus directly without a new history entry. The reader also permits the
  // native heading fragment if the link ran before this handler was attached.
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    element("setup-heading").focus();
  });
  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  const stored = await chrome.storage.local.get([SETUP_STATE_KEY, "dictionaryState", "options"]);
  adoptSetupState(stored[SETUP_STATE_KEY]);
  adoptDictionaryState(stored.dictionaryState);
  adoptOptions(stored.options);
  if (setupError === null && setupState?.stage === "dictionaries") {
    // Reconnect first: a run started by an earlier page may still be active.
    await requestInstall(untouchedEntries().map((entry) => entry.sourceId));
  }
  render();
}

try {
  await start();
} catch (error) {
  setupError = describe(error);
  render();
}
