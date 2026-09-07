/*
 * Startup page: the first-run setup shell shown once after installation.
 *
 * The service worker owns the revisioned setup state; this page reads it from
 * storage, renders the current stage in one card, and advances it through
 * compare-and-set writes so a stale tab cannot move a newer screen backward.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./reader-options.js";
import { recommendedDictionaryInstalled } from "./managed-dictionary-source.js";
import { RECOMMENDED_DICTIONARIES } from "./recommended-dictionaries.js";
import { SETUP_STATE_KEY, SETUP_STAGES, normaliseSetupState } from "./setup-state.js";

const WORKER_TARGET = "hoshidicts-worker";
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

function element(id) {
  return document.getElementById(id);
}

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

async function send(type, fields) {
  requestCounter += 1;
  const reply = await chrome.runtime.sendMessage({
    target: WORKER_TARGET,
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

function button(id, text, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.id = id;
  node.dataset.focusKey = id;
  node.className = "primary-button";
  node.textContent = text;
  node.disabled = saving;
  node.addEventListener("click", onClick);
  return node;
}

function dictionaryRows() {
  const list = document.createElement("ul");
  list.className = "setup-dictionary-list";
  list.setAttribute("aria-label", "Default dictionaries");
  for (const entry of RECOMMENDED_DICTIONARIES) {
    const installed = recommendedDictionaryInstalled(entry, dictionaries);
    const row = document.createElement("li");
    row.className = "setup-dictionary";
    row.dataset.sourceId = entry.sourceId;
    const name = document.createElement("span");
    name.className = "setup-dictionary-name";
    name.textContent = entry.name;
    const purpose = document.createElement("span");
    purpose.className = "setup-dictionary-purpose";
    purpose.textContent = entry.description;
    const status = document.createElement("span");
    status.className = `setup-dictionary-status${installed ? " is-installed" : ""}`;
    status.textContent = installed ? "Already installed" : "Not installed";
    row.append(name, purpose, status);
    list.appendChild(row);
  }
  return list;
}

const VIEWS = {
  dictionaries: () => ({
    heading: "Default dictionaries",
    body: [
      paragraph("Hachidori works best with these four trusted dictionaries from their publishers."),
      dictionaryRows(),
      settingsNote("Install custom dictionaries in ", "settings.html#add-dictionaries"),
    ],
    actions: [button("setup-continue", "Continue setup", () => { void advance("anki"); })],
  }),
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
  return setupState === null ? inactiveView() : VIEWS[setupState.stage]();
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
  if (renderedStage !== undefined && renderedStage !== stage) {
    // The control that held focus belonged to the previous stage.
    heading.focus();
  } else if (focusKey) {
    [...card.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey)?.focus();
  }
  renderedStage = stage;
}

async function advance(stage) {
  if (saving || setupState === null) return false;
  saving = true;
  for (const control of element("setup-actions").querySelectorAll("button")) control.disabled = true;
  setStatus("Saving…");
  let advanced = false;
  try {
    const reply = await send("hd_setup_cas", { baseRevision: setupState.revision, stage });
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

async function start() {
  chrome.storage.onChanged.addListener(handleStorageChange);
  const stored = await chrome.storage.local.get([SETUP_STATE_KEY, "dictionaryState", "options"]);
  adoptSetupState(stored[SETUP_STATE_KEY]);
  adoptDictionaryState(stored.dictionaryState);
  adoptOptions(stored.options);
  render();
}

await start();
