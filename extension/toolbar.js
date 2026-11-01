// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import "./reader-options.js";
import { captureDebugLog, captureDocumentActions, openDebugLogStore, recordUserError } from "./debug-log.js";
import { openSearchPage } from "./search-window.js";

// Settings → Advanced → Get debug info includes what failed here.
captureDocumentActions(document, captureDebugLog(window, {
  context: "toolbar", store: openDebugLogStore(window.indexedDB),
}));

const {
  activationLabel, normaliseOptions, hasProfiles, profiles, activeProfileId, LANGUAGE_SELECTION_KEY,
  normaliseLanguageSelection,
} = globalThis.HDReaderOptions;
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
let options = null;
let storedOptions = null;
let selection = null;
let linkedAddress = null;
let revision = -1;
let pending = false;
let requestCounter = 0;

function adoptOptions(stored) {
  const nextRevision = Number.isInteger(stored?.revision) && stored.revision >= 0 ? stored.revision : 0;
  // Settings and the startup page skip an equal revision; the toolbar adopts
  // it again and re-renders.
  if (nextRevision < revision) return;
  revision = nextRevision;
  storedOptions = stored ?? null;
  options = normaliseOptions(stored);
  render();
}

function languageName(code) {
  const name = globalThis.HDLanguages?.get?.(code)?.name;
  if (typeof name === "string") return name;
  if (code === "ja") return "Japanese";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// The profiles once the records have them (docs/languages.md 16.2); none in
// the single-profile shape, whose toolbar is today's.
function profileList() {
  return hasProfiles(storedOptions) ? profiles(storedOptions) : [];
}

// With two or more profiles, a radio group above today's controls, one
// button per language; a click makes it this browser's language.
function renderLanguages(list, active) {
  let row = elements["language-switcher"];
  if (list.length < 2) {
    row?.remove();
    delete elements["language-switcher"];
    return;
  }
  if (!row) {
    row = document.createElement("div");
    row.id = "language-switcher";
    row.className = "language-switcher";
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", "Language");
    elements["lookup-toggle"].before(row);
    elements["language-switcher"] = row;
  }
  const key = JSON.stringify([list.map(profile => [profile.id, profile.language]), active, pending]);
  if (row.dataset.key === key) return;
  row.dataset.key = key;
  row.replaceChildren(...list.map(profile => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "language-choice";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(profile.id === active));
    button.dataset.profileId = profile.id;
    button.disabled = pending;
    const descriptor = globalThis.HDLanguages?.get?.(profile.language);
    const name = document.createElement("span");
    name.textContent = languageName(profile.language);
    button.append(name);
    if (typeof descriptor?.nativeName === "string" && descriptor.nativeName !== name.textContent) {
      const native = document.createElement("span");
      native.className = "language-native";
      native.lang = descriptor.bcp47 ?? profile.language;
      native.dir = descriptor.direction === "rtl" ? "rtl" : "ltr";
      native.textContent = descriptor.nativeName;
      button.append(native);
    }
    button.addEventListener("click", () => {
      if (profile.id !== active) void run(() => chooseLanguage(profile.id));
    });
    return button;
  }));
}

function render() {
  elements["lookup-toggle"].disabled = pending || !options;
  if (!options) return;
  const list = profileList();
  const active = list.length > 0 ? activeProfileId(storedOptions, selection) : "ja";
  const language = list.find(profile => profile.id === active)?.language ?? "ja";
  renderLanguages(list, active);
  // "Japanese lookups" while the only profile is Japanese (docs/languages.md 16.2).
  const onlyJapanese = list.length === 0 || (list.length === 1 && language === "ja");
  elements["lookup-toggle"].setAttribute("aria-label", onlyJapanese ? "Japanese lookups" : "Lookups");
  elements["lookup-toggle"].setAttribute("aria-checked", String(options.hoverEnabled));
  elements["lookup-state"].textContent = options.hoverEnabled ? "On" : "Off";
  elements["open-search"].hidden = !options.showToolbarSearchButton;
  const activeHint = options.lookupMode !== "hover"
    ? `Hold ${activationLabel(options.activationKey)} to scan` : `Hover over ${languageName(language)} text to scan`;
  elements["activation-hint"].textContent = options.hoverEnabled ? activeHint : "Lookups paused";
}

// This browser's language (docs/languages.md 4.4). A choice made meanwhile in
// another page wins; the click asks once more against it.
async function chooseLanguage(profileId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_language_selection_write",
      requestId: `toolbar-${++requestCounter}`, baseRevision: normaliseLanguageSelection(selection).revision,
      activeProfileId: profileId });
    if (reply?.selection) adoptSelection(reply.selection);
    if (reply?.ok) return;
    if (reply?.conflict !== true) throw new Error(reply?.error || "Hachidori did not reply. Please try again.");
  }
  throw new Error("The language changed in another page. Please try again.");
}

function adoptSelection(value) {
  selection = value ?? null;
  render();
}

function showError(error) {
  elements["toolbar-error"].textContent = error instanceof Error ? error.message : String(error);
  elements["toolbar-error"].hidden = false;
  recordUserError(window, "toolbar-error", elements["toolbar-error"].textContent, error);
}

async function send(type, fields = {}, target = "hoshidicts-worker") {
  const reply = await chrome.runtime.sendMessage({ target, type, requestId: `toolbar-${++requestCounter}`, ...fields });
  if (reply?.options) adoptOptions(reply.options);
  if (!reply?.ok) throw new Error(reply?.error || "Hachidori did not reply. Please try again.");
  return reply;
}

async function writeOptions(patch) {
  await send("hd_options_write", { baseRevision: revision, options: patch }, "hoshidicts-worker");
}

async function run(action) {
  if (pending) return;
  pending = true;
  elements["toolbar-error"].hidden = true;
  render();
  try { await action(); }
  catch (error) { showError(error); }
  finally { pending = false; render(); }
}

// A linked install shows where its lookups go and whether that host answers.
function adoptSharing(stored) {
  linkedAddress = typeof stored?.client?.address === "string" ? stored.client.address : null;
  elements["toolbar-sharing"].hidden = linkedAddress === null;
  if (linkedAddress === null) elements["toolbar-sharing"].textContent = "";
}

async function refreshSharing() {
  if (linkedAddress === null) return;
  try {
    const status = await send("hd_sharing_status", {}, "hachidori-sharing");
    elements["toolbar-sharing"].textContent = status.sharing?.client?.connected
      ? "Linked to another Hachidori" : "Linked Hachidori not reachable";
  } catch (error) { showError(error); }
}

elements["lookup-toggle"].addEventListener("click", () => {
  void run(() => writeOptions({ hoverEnabled: !options.hoverEnabled }));
});
elements["open-settings"].addEventListener("click", () => {
  void run(async () => { await chrome.runtime.openOptionsPage(); window.close(); });
});
// Yomitan's action popup Search: the open search page, or a new tab with it.
elements["open-search"].addEventListener("click", () => {
  void run(async () => { await openSearchPage(chrome, "existingOrNewTab"); window.close(); });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Adopted in commit order whatever its revision (docs/languages.md 4.4).
  if (changes[LANGUAGE_SELECTION_KEY]) selection = changes[LANGUAGE_SELECTION_KEY].newValue ?? null;
  if (changes.options) {
    adoptOptions(changes.options.newValue);
  } else if (changes[LANGUAGE_SELECTION_KEY]) render();
  if (changes.sharing) {
    adoptSharing(changes.sharing.newValue);
    void refreshSharing();
  }
});

try {
  const stored = await chrome.storage.local.get(["options", "sharing", LANGUAGE_SELECTION_KEY]);
  selection = stored[LANGUAGE_SELECTION_KEY] ?? null;
  adoptOptions(stored.options);
  adoptSharing(stored.sharing);
  await refreshSharing();
} catch (error) { showError(error); }
const sharingPoll = setInterval(() => { void refreshSharing(); }, 1000);
window.addEventListener("pagehide", () => clearInterval(sharingPoll), { once: true });
