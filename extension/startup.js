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

const WORKER_TARGET = "hoshidicts-worker";
const SETUP_TARGET = "hachidori-setup";
const SETUP_EVENTS_TARGET = "hachidori-setup-events";
const SUCCESS_DISPLAY_MS = 5000;
const COUNTDOWN_TICK_MS = 250;
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
let advanceFailed = false;
// A failed install request is shown once with Retry; the page never re-requests on its own.
let installFailed = false;
const announced = new Map();

function element(id) {
  return document.getElementById(id);
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

// Sources without a recorded outcome: missing ones install, installed ones are
// recorded as already installed, including a package whose commit outlived the
// installer that made it.
function untouchedEntries() {
  return RECOMMENDED_DICTIONARIES.filter((entry) => setupState.dictionaries.outcomes[entry.sourceId] === undefined);
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
  const list = document.createElement("ul");
  list.className = "setup-dictionary-list";
  list.setAttribute("aria-label", "Default dictionaries");
  for (const entry of RECOMMENDED_DICTIONARIES) {
    const state = rowState(entry);
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
    if (state.tone) status.classList.add(`is-${state.tone}`);
    status.textContent = state.text;
    row.append(name, purpose, status);
    if (state.progress) row.appendChild(progressBar(state.progress, name.id));
    list.appendChild(row);
  }
  return list;
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
  if (!advanceFailed) startCountdown();
  return {
    heading: installedHere && total !== null ? `All dictionaries installed in ${formatSeconds(total)}` : "All dictionaries are already installed",
    body: [importNote, rows, ...(advanceFailed ? [] : [countdownView()])],
    actions: advanceFailed ? [button("setup-continue", "Continue setup", () => { void advance("anki"); })] : [],
  };
}

// A failed or later removed source waits for an explicit retry of the missing
// ones, and setup can be continued without them.
function incompleteView(rows, importNote, missing) {
  const failed = installFailed || missing.some((entry) => setupState.dictionaries.outcomes[entry.sourceId]?.status === "failed");
  return {
    heading: failed ? "Some dictionaries could not be installed" : "Some dictionaries are not installed",
    body: [rows, importNote],
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
  const importNote = settingsNote("Install custom dictionaries in ", "settings.html#add-dictionaries");
  const installingView = () => ({
    heading: "Installing default dictionaries…",
    body: [paragraph("Hachidori works best with these four trusted dictionaries from their publishers."), rows, importNote],
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

const VIEWS = {
  dictionaries: dictionariesView,
  anki: () => ({
    heading: "Anki",
    body: [
      paragraph("Hachidori can add the words you look up to Anki through AnkiConnect."),
      settingsNote("Set up in ", "settings.html#anki"),
    ],
    actions: [button("setup-continue", "Continue setup", () => { void advance("practice"); })],
  }),
  practice: () => ({
    heading: "You’re ready.",
    body: [paragraph(options.lookupMode === "activation"
      ? `Hold ${options.activationKey} and hover over Japanese text on any webpage to look it up.`
      : "Hover over Japanese text on any webpage to look it up.")],
    actions: [button("setup-finish", "Finish", () => { void finish(); })],
  }),
  complete: () => ({
    heading: "Setup is complete.",
    body: [settingsNote("Change dictionaries, Anki and reading preferences any time in ", "settings.html")],
    actions: [],
  }),
};

function inactiveView() {
  return {
    heading: "Hachidori is ready.",
    body: [settingsNote("Setup runs once after installation. Manage dictionaries and preferences in ", "settings.html")],
    actions: [],
  };
}

function failedView() {
  return {
    heading: "Setup could not be read.",
    body: [paragraph(setupError, "hint is-error"), settingsNote("Hachidori still works; manage it in ", "settings.html")],
    actions: [],
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
  if (setupState.stage !== "dictionaries") {
    cancelCountdown();
    advanceFailed = false;
  }
  return VIEWS[setupState.stage]();
}

function render() {
  const stage = setupError === null ? setupState?.stage ?? null : null;
  const card = element("setup-card");
  const focusKey = card.contains(document.activeElement) ? document.activeElement.dataset.focusKey ?? "" : "";
  const view = currentView();
  renderSteps(stage);
  const heading = element("setup-heading");
  heading.textContent = view.heading;
  element("setup-body").replaceChildren(...view.body);
  element("setup-actions").replaceChildren(...view.actions);
  announceOutcomes();
  if (renderedStage !== undefined && renderedStage !== stage) {
    // The control that held focus belonged to the previous stage.
    heading.focus();
  } else if (focusKey) {
    [...card.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey)?.focus();
  }
  renderedStage = stage;
}

async function advance(stage, { continued = false } = {}) {
  if (saving || setupState === null) return false;
  saving = true;
  for (const control of element("setup-actions").querySelectorAll("button")) control.disabled = true;
  setStatus("Saving…");
  let advanced = false;
  try {
    const reply = await send("hd_setup_cas", { baseRevision: setupState.revision, stage, ...(continued ? { continued } : {}) });
    if (reply.state) adoptSetupState(reply.state);
    if (!reply.ok) throw new Error(reply.error || "setup progress could not be saved");
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

await start();
