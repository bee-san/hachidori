/*
 * Settings page: dictionary import, load order, and lookup options.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { extensionApi as chrome } from "./browser-api.js";
import "./reader-options.js";
import { createAudioSettingsController } from "./audio-settings.js";
import { createKeybindSettingsController } from "./keybind-settings.js";
import { createAnkiTemplateSettingsController } from "./anki-settings.js";
import { createLocalAudioSetup } from "./local-audio-setup.js";
import { createBackupSettingsController } from "./backup-settings.js";
import { createExperimentalSettings } from "./experimental-settings.js";
import { createThemeStore } from "./theme-store.js";
import { createActivationSettings } from "./activation-settings.js";
import { createMemorySettings } from "./memory-settings.js";
import { downloadBlob } from "./blob-download.js";
import { collectDebugInfo, debugInfoBlob, debugInfoFilename } from "./debug-info.js";
import { captureDebugLog } from "./debug-log.js";
import { describeErrorOrJson } from "./error-text.js";
import { createSharingSettingsController } from "./sharing-settings.js";
import { ANKI_ADDON_FILE_NAME, fetchAnkiAddon } from "./anki-addon.js";
import { createLocalFileAccessController } from "./local-file-access.js";
import { createSettingsSearch } from "./settings-search.js";
import { applyPageTheme, setStatusOutput } from "./settings-dom.js";
import { HOST_CAPABILITIES, MINING_CAPABILITIES, OVERLAY_MODE } from "./overlay-mode.js";
import { createRecommendedInstallClient } from "./recommended-install-client.js";
import { createCustomButtonSettings } from "./custom-button-settings.js";
import { createDictionaryNameDrafts } from "./dictionary-name-drafts.js";
import { createDictionaryGroupController } from "./dictionary-groups.js";
import { CUSTOM_DICTIONARY_SOURCE_KEY } from "./custom-dictionary.js";
import { SETUP_STATE_KEY, normaliseSetupState, setupIncomplete } from "./setup-state.js";
import {
  attachGroupHandlers, attachLibraryHandlers, bindNameDraft, commitGroups, committing, dictionaries,
  dictionaryLabel, dictionaryState, handleDictionaryStateChange, moveListItem, pendingDictionaryCommits,
  reloadDictionaries, removing, renderChangedDictionaryState, renderDeferredAfterBlur, setControlsDisabled,
  setPendingManagementFocus, updateItemById,
} from "./library-settings.js";
import {
  attachImportHandlers, attachRecommendedHandlers, importing, installingRecommended,
  renderRecommendedCatalogue, renderRecommendedInstallation, setImportState,
} from "./import-settings.js";
import {
  adoptUpdateSettings, attachUpdateHandlers, pendingSchedule, renderUpdateControls, renderUpdatingRows,
  savingSchedule, updating,
} from "./update-settings.js";
import {
  adoptCustomDictionaryDocument, attachCustomDictionaryHandlers, customDictionaryDirty, customEditorLoaded,
  customLoading, customSaving, handleCustomDictionarySourceChange, loadCustomDictionarySource,
  renderCustomDictionaryControls,
} from "./custom-dictionary-settings.js";
import {
  attachDefinitionBlurHandlers, renderDefinitionBlurControls, renderDefinitionBlurFrequencyChoices,
  renderLookupCountsReset, resetLookupCounts,
} from "./lookup-stats-settings.js";

const TARGET = "hoshidicts-offscreen";
const WORKER_TARGET = "hoshidicts-worker";
const UPDATE_TARGET = "hachidori-updates";
const AUDIO_TARGET = "hachidori-audio";
const SHARING_TARGET = "hachidori-sharing";
const ANKI_TARGET = "hachidori-anki";
const BACKUP_LIFECYCLE_PORT = "hachidori-backup-settings";
const OPTION_SECTIONS = {
  lookup: "Reading",
  "word-highlighting": "Word highlighting",
  design: "Design",
  audio: "Audio",
  anki: "Anki",
  keybinds: "Keybinds",
  advanced: "Advanced",
  // Library → Personal dictionary owns its lookup switches.
  "custom-dictionary": "Personal dictionary",
};
const LIBRARY_SECTIONS = new Set(["dictionaries", "add-dictionaries", "updates", "dictionary-groups", "custom-dictionary"]);
const {
  DEFAULT_OPTIONS, DEFINITION_LOOKUP_MODES, FREQUENCY_ORDERS,
  POPUP_THEME_GROUPS, POPUP_RENDERER_IDS, popupRenderer, DESIGN_OPTION_KEYS, DEFINITION_BLUR_DIRECTIONS, DEFINITION_BLUR_REVEALS,
  DEFINITION_BLUR_FREQUENCY_ORDERS, EXPERIMENTAL_FEATURES, WORD_HIGHLIGHT_STYLES, definitionBlurFrequencyDictionary,
  activationLabel, clampOption, hasCapability, normaliseCustomButtons, normaliseKanjiSelection, normaliseOptions,
} = globalThis.HDReaderOptions;
const STATUS_POLL_MS = 1000;
// Slower than the boot poll: a failing poll may be failing for a while, and the
// settings page can be left open.
const STATUS_RETRY_MS = 5000;

const NUMBER_FIELDS = [
  { key: "scanLength", id: "opt-scan-length" },
  { key: "maxResults", id: "opt-max-results" },
  { key: "scanDelayMs", id: "opt-scan-delay" },
  { key: "popupHideDelayMs", id: "opt-hide-delay" },
  { key: "hidePopupOnCursorExitDelayMs", id: "opt-hide-on-cursor-exit-delay" },
  { key: "popupNestingMaxDepth", id: "opt-popup-nesting-depth" },
  { key: "popupColumns", id: "opt-popup-columns" },
  { key: "compactDefinitionSummaryCount", id: "opt-summary-count" },
  { key: "definitionBlurThreshold", id: "opt-blur-threshold" },
  { key: "definitionBlurFrequencyThreshold", id: "opt-blur-frequency-threshold" },
  { key: "popupWidthPx", id: "opt-popup-width", live: true },
  { key: "popupHeightPx", id: "opt-popup-height", live: true },
  { key: "popupScalePercent", id: "opt-popup-scale", live: true },
  { key: "popupOpacityPercent", id: "opt-popup-opacity", live: true },
  { key: "automaticBackupDays", id: "opt-automatic-backup-days" },
];
const METADATA_FIELDS = [
  { key: "showLookupCounts", id: "opt-lookup-counts" },
  { key: "showFrequencyDictionaryNames", id: "opt-frequency-names" },
  { key: "compactFrequencyNumbers", id: "opt-frequency-compact" },
  { key: "averageFrequency", id: "opt-average-frequency" },
  { key: "showPitchAccentFurigana", id: "opt-pitch-furigana" },
  { key: "showPitchAccentColors", id: "opt-pitch-colors" },
  { key: "showPitchAccentBadge", id: "opt-pitch-badge" },
  { key: "showPitchAccentDictionaryNames", id: "opt-pitch-names" },
  { key: "showPitchAccentText", id: "opt-pitch-text" },
  { key: "showPitchAccentPosition", id: "opt-pitch-position" },
  { key: "showPitchAccentGraph", id: "opt-pitch-graph" },
  { key: "hidePopupGrammarTags", id: "opt-grammar-tags", inverted: true },
];
const APPEARANCE_CHOICES = [
  { key: "popupTheme", id: "opt-popup-theme" },
  { key: "popupToolbarPosition", id: "opt-popup-toolbar" },
  { key: "imageHoverPreview", id: "opt-image-hover-preview" },
  { key: "glossaryLayoutMode", id: "opt-glossary-layout" },
  { key: "pitchAccentFuriganaStyle", id: "opt-pitch-furigana-style" },
  { key: "definitionBlurDirection", id: "opt-blur-direction", values: DEFINITION_BLUR_DIRECTIONS },
  { key: "definitionBlurFrequencyOrder", id: "opt-blur-frequency-order", values: DEFINITION_BLUR_FREQUENCY_ORDERS },
  { key: "definitionBlurReveal", id: "opt-blur-reveal", values: DEFINITION_BLUR_REVEALS },
  { key: "wordHighlightStyle", id: "opt-word-highlight-style", values: WORD_HIGHLIGHT_STYLES },
];
// Reading → Word highlighting (#520, experimental).
const WORD_HIGHLIGHT_SWITCHES = [
  { key: "wordHighlightEnabled", id: "opt-word-highlight" },
  { key: "wordHighlightUnknown", id: "opt-word-highlight-unknown" },
  { key: "wordHighlightLearning", id: "opt-word-highlight-learning" },
  { key: "wordHighlightKnown", id: "opt-word-highlight-known" },
  { key: "wordHighlightIgnored", id: "opt-word-highlight-ignored" },
];

const numberFormat = new Intl.NumberFormat();
let options = normaliseOptions({});
const themeStore = createThemeStore({ root: document.getElementById("theme-store"), design: document.getElementById("design"), onSelect(slug) {
  options.popupTheme = slug;
  renderThemeChoices();
  writeOptions();
} });
let savedOptions = normaliseOptions({});
let optionsRevision = -1;
let pendingOptions = {};
let pendingOptionsRevision = 0;
let savingOptions = null;
let optionsSaveCompletion = Promise.resolve();
let optionsTimer = null;
let optionsSaveFailed = false;
let optionsEditRevision = null;
const OPTIONS_SAVE_DELAY_MS = 150;
const nameDrafts = createDictionaryNameDrafts({
  delayMs: OPTIONS_SAVE_DELAY_MS,
  afterSave: () => renderChangedDictionaryState(),
});
const recommendedInstallation = createRecommendedInstallClient({
  send: sourceIds => send("hd_setup_install", { sourceIds }, "hachidori-setup"),
  onChange: renderRecommendedInstallation,
  onError(error) { setImportState(`Could not observe dictionary installation: ${describeErrorOrJson(error)}`, "error"); },
});
let statusTimer = null;
let lastEngineStatus = null;
let requestCounter = 0;
let audioController;
let keybindController;
let ankiController;
let localAudioSetup;
let sharingController;
// The address of the Hachidori this install is linked to, or null.
let sharingLinkedAddress = null;
let backupController;
let backupLifecyclePort = null;
let backupLifecycleReconnectTimer = null;
const backupLifecycleTokens = new Set();
let customButtonController;
let experimentalController;
let activationController;
let memoryController;
let backingUp = false;
let settingsSearch;

const SECTION_STATUSES = {
  "library-reset-status": { section: "dictionaries", label: "Library" },
  "import-state": { section: "add-dictionaries", label: "Import" },
  "update-state": { section: "updates", label: "Updates" },
  "custom-dictionary-status": { section: "custom-dictionary", label: "Personal dictionary" },
  "options-status": { section: "lookup", label: "Reading" },
  "lookup-counts-reset-status": { section: "lookup", label: "Lookup history" },
  "dict-group-error": { section: "dictionary-groups", label: "Groups" },
  "backup-status": { section: "backup", label: "Backup" },
  "sharing-status": { section: "sharing", label: "Sharing" },
  "debug-info-status": { section: "advanced", label: "Troubleshooting" },
};
let activeSection = "dictionaries";
const unseenSectionCompletions = new Set();

function element(id) {
  return document.getElementById(id);
}

function configureBrowserUi() {
  if (!HOST_CAPABILITIES.customJavaScript) {
    const customJavascript = element("custom-javascript");
    customJavascript.dataset.settingsUnavailable = "true";
    customJavascript.hidden = true;
  }
}

function sectionHasPendingWork(id) {
  switch (id) {
    case "import-state": return importing || installingRecommended;
    case "update-state": return updating || savingSchedule !== null || pendingSchedule !== null;
    case "custom-dictionary-status": return customLoading || customSaving || customDictionaryDirty();
    case "backup-status": return backingUp;
    case "options-status": return savingOptions !== null || Object.keys(pendingOptions).length > 0;
    default: return false;
  }
}

function primaryNavigationSection(section) {
  return LIBRARY_SECTIONS.has(section) ? "dictionaries" : section;
}

function renderNavigationStatuses() {
  const messages = new Map();
  for (const [id, { section, label }] of Object.entries(SECTION_STATUSES)) {
    const source = element(id);
    const attention = source.classList.contains("is-error") || unseenSectionCompletions.has(id) || sectionHasPendingWork(id);
    if (section === activeSection || !attention || !source.textContent) continue;
    const navigationSection = primaryNavigationSection(section);
    const status = messages.get(navigationSection) ?? { messages: [], error: false, ready: true };
    status.messages.push(`${label}: ${source.textContent}`);
    status.error ||= source.classList.contains("is-error");
    status.ready &&= source.classList.contains("is-ready");
    messages.set(navigationSection, status);
  }
  for (const notice of document.querySelectorAll(".nav-status")) {
    const status = messages.get(notice.id.slice("nav-status-".length));
    const message = status?.messages.join(" ") ?? "";
    if (notice.textContent !== message) notice.textContent = message;
    notice.classList.toggle("is-error", status?.error === true);
    notice.classList.toggle("is-ready", status?.ready === true && status?.error !== true);
  }
  const compact = element("settings-navigation-status");
  const message = [...document.querySelectorAll(".nav-status")].map(output => output.textContent).filter(Boolean).join(" ");
  if (compact.textContent !== message) compact.textContent = message;
}

function syncNavigationStatus(id) {
  const { section } = SECTION_STATUSES[id];
  if (section === activeSection) unseenSectionCompletions.delete(id);
  renderNavigationStatuses();
}

function setSectionStatus(id, message, tone, completed = false) {
  const output = element(id);
  setStatusOutput(output, message, tone);
  if (completed && SECTION_STATUSES[id].section !== activeSection) unseenSectionCompletions.add(id);
  syncNavigationStatus(id);
}

// Whether an experimental flag that is off hides `section`.
function sectionGated(section) {
  return EXPERIMENTAL_FEATURES.some(feature => feature.section === section && !options.experimental[feature.id]);
}

function requestedSection() {
  const fragment = window.location.hash.slice(1);
  return fragment === "settings-content" ? activeSection : fragment;
}

// Sections the host browser cannot offer are marked by configureBrowserUi().
function availableSections() {
  return [...document.querySelectorAll("main > section:not([data-settings-unavailable='true'])")];
}

function sectionAvailable(id) {
  return element(id)?.dataset.settingsUnavailable !== "true";
}

function resolveSection(requested) {
  if (!availableSections().some((section) => section.id === requested)) return "dictionaries";
  // A gated section leads to the switch that reveals it.
  return sectionGated(requested) ? "advanced" : requested;
}

function showSettingsSection(focus = false) {
  settingsSearch?.clear();
  const sections = availableSections();
  activeSection = resolveSection(requestedSection());
  setPendingManagementFocus(null);
  for (const section of sections) section.hidden = section.id !== activeSection;
  element("settings-section").value = activeSection;
  const libraryActive = LIBRARY_SECTIONS.has(activeSection);
  element("library-navigation").hidden = !libraryActive;
  const primarySection = primaryNavigationSection(activeSection);
  for (const link of document.querySelectorAll(".settings-nav a")) {
    if (link.hash === `#${primarySection}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const link of document.querySelectorAll("#library-navigation a")) {
    if (libraryActive && link.hash === `#${activeSection}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (Object.hasOwn(OPTION_SECTIONS, activeSection)) {
    SECTION_STATUSES["options-status"] = { section: activeSection, label: OPTION_SECTIONS[activeSection] };
    const slot = element(activeSection).querySelector(".options-feedback-slot");
    if (element("options-feedback").parentElement !== slot) slot.append(element("options-feedback"));
  }
  for (const [id, { section }] of Object.entries(SECTION_STATUSES)) {
    if (section === activeSection) unseenSectionCompletions.delete(id);
  }
  renderNavigationStatuses();
  renderThemeChoices();
  updateDesignPreview();
  updateAudioSettings();
  updateAnkiSettings();
  updateKeybindSettings();
  updateBackupSettings();
  updateSharingSettings();
  if (activeSection === "advanced") refreshAdvancedMemory();
  if (activeSection === "design") {
    customButtonController ??= createCustomButtonSettings({ document,
      readButtons: () => options.customButtons,
      readTemplates: () => options.anki.templates,
      saveButtons: buttons => {
        options.customButtons = normaliseCustomButtons(buttons);
        options.customLinks = options.customButtons.filter(button => button.type === "link")
          .map(({ label, url }) => ({ label, url }));
        writeOptions();
      },
    });
    customButtonController.render();
  }
  if (activeSection === "custom-dictionary" && !customEditorLoaded) void loadCustomDictionarySource();
  if (window.location.hash === "#settings-content") element("settings-content").focus();
  else if (focus) element(activeSection).querySelector("h1").focus();
}

function updateAudioSettings() {
  if (activeSection !== "audio") { audioController?.stop(); return; }
  audioController ??= createAudioSettingsController({
    document,
    readSources: () => options.audioSources,
    editSources: sources => {
      options.audioSources = sources;
      writeOptions();
    },
    send: (type, fields) => send(type, fields, AUDIO_TARGET),
  });
  audioController.render();
}

function updateKeybindSettings() {
  if (activeSection !== "keybinds" || optionsRevision < 0) return;
  keybindController ??= createKeybindSettingsController({ document,
    readKeybinds: () => options.keybinds,
    editKeybinds: keybinds => { options.keybinds = keybinds; writeOptions(); },
    readAudioSources: () => options.audioSources,
    getBrowserCommands: () => chrome.commands.getAll(),
    openBrowserShortcuts: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }),
    browserShortcutsAvailable: HOST_CAPABILITIES.browserShortcuts,
  });
  keybindController.render();
}

function updateAnkiSettings() {
  if (activeSection !== "anki" || optionsRevision < 0) return;
  ankiController ??= createAnkiTemplateSettingsController({ document, readAnki: () => options.anki,
    capabilities: MINING_CAPABILITIES,
    readExperimental: () => options.experimental,
    readButtons: () => options.customButtons,
    editAnki: anki => {
      options.anki = anki;
      customButtonController?.render();
      writeOptions();
    },
    send: async (type, fields) => {
      // Linked checks cannot forward draft endpoint credentials or mappings.
      // Commit them to the host first, then let the host read its saved copy.
      if (["hd_anki_discover", "hd_anki_setup"].includes(type) && sharingLinkedAddress !== null) {
        await flushOptionsUntilIdle();
      }
      return send(type, fields, WORKER_TARGET);
    },
  });
  ankiController.render();
  localAudioSetup ??= createLocalAudioSetup({ document, readSources: () => options.audioSources,
    isLinked: () => sharingLinkedAddress !== null,
    editSources: sources => { options.audioSources = sources; writeOptions(); },
  });
  localAudioSetup.render();
}

// While linked, imported archives go to the host and backups belong to it; the notices say so.
// The two resets act only on this browser's own data, so they wait for Unlink.
function renderSharingLink(value) {
  const wasLinked = sharingLinkedAddress !== null;
  sharingLinkedAddress = typeof value?.client?.address === "string" ? value.client.address : null;
  const linked = sharingLinkedAddress !== null;
  localAudioSetup?.render();
  element("sharing-overlay-preferences").hidden = !linked || !OVERLAY_MODE;
  element("sharing-import-notice").hidden = !linked;
  element("sharing-backup-notice").hidden = !linked;
  element("library-reset-linked").hidden = !linked;
  element("lookup-counts-reset-linked").hidden = !linked;
  for (const node of document.querySelectorAll("#backup > .backup-action, #backup > .section-note")) node.hidden = linked;
  element("automatic-backups").hidden = linked;
  setControlsDisabled(importing);
  renderLookupCountsReset();
  if (wasLinked && !linked) {
    void backupController?.refreshAutomaticBackups();
  }
}

// Advanced → Troubleshooting. A blob download, so it also works in hosts
// without chrome.downloads.
async function downloadDebugInfo() {
  const button = element("debug-info-download");
  button.disabled = true;
  setSectionStatus("debug-info-status", "Collecting debug info… This can take up to half a minute.", "working");
  try {
    const report = await collectDebugInfo({ chrome, window, send,
      targets: { worker: WORKER_TARGET, sharing: SHARING_TARGET, anki: ANKI_TARGET }, context: {
        overlayMode: OVERLAY_MODE, hostCapabilities: HOST_CAPABILITIES, miningCapabilities: MINING_CAPABILITIES,
        linkedTo: sharingLinkedAddress, activeSection, lastEngineStatus, effectiveOptions: options,
        busy: { importing, installingRecommended, updating, removing, committing, customLoading, customSaving,
          backingUp, pendingDictionaryCommits, savingOptions: savingOptions !== null },
        statuses: Object.fromEntries(Object.keys(SECTION_STATUSES).map(id => [id, element(id).textContent])),
      } });
    downloadBlob(document, debugInfoBlob(report), debugInfoFilename(new Date(report.generatedAt)));
    setSectionStatus("debug-info-status", "Debug info downloaded.", "ready", true);
  } catch (error) {
    setSectionStatus("debug-info-status", `Could not collect debug info: ${describeErrorOrJson(error)}`, "error");
  } finally {
    button.disabled = false;
  }
}

// Save the pinned release through a blob download, including in Electron hosts.
async function downloadAnkiAddon() {
  const archive = await fetchAnkiAddon();
  downloadBlob(document, archive, ANKI_ADDON_FILE_NAME);
}

function updateSharingSettings() {
  if (activeSection !== "sharing") { sharingController?.stop(); return; }
  sharingController ??= createSharingSettingsController({ document,
    send: (type, fields) => send(type, fields, SHARING_TARGET),
    setStatus: (message, tone) => setSectionStatus("sharing-status", message, tone),
    downloadAddon: downloadAnkiAddon,
  });
  sharingController.start();
}

async function toggleExperimental(id, enabled) {
  options.experimental = { ...options.experimental, [id]: enabled };
  // Word highlighting keeps its own switches and style, but its marks must
  // not stay on pages behind a hidden section.
  if (id === "wordHighlighting" && !enabled) {
    options.wordHighlightEnabled = false;
    renderWordHighlightControls();
  }
  renderExperimentalSettings();
  writeOptions();
}

function renderExperimentalSettings() {
  const features = EXPERIMENTAL_FEATURES.filter(feature => !feature.section || sectionAvailable(feature.section));
  experimentalController ??= createExperimentalSettings({
    document, features, onToggle: (id, enabled) => { void toggleExperimental(id, enabled); },
  });
  experimentalController.render(options.experimental);
  for (const feature of EXPERIMENTAL_FEATURES) {
    if (!feature.section) continue;
    const hidden = !options.experimental[feature.id] || !sectionAvailable(feature.section);
    document.querySelector(`.settings-nav a[href="#${feature.section}"]`).parentElement.hidden = hidden;
    element("settings-section").querySelector(`option[value="${feature.section}"]`).hidden = hidden;
    // Global search leaves the hidden section's settings out as well.
    element(feature.section).toggleAttribute("data-settings-gated", hidden);
  }
  // A flag that changed elsewhere can hide the visible section, or reveal the
  // one this page was opened on before the stored options arrived.
  if (resolveSection(requestedSection()) !== activeSection) showSettingsSection();
}

// Low memory mode recycles the engine worker, so it needs the threaded engine:
// not when the offscreen document runs the local engine
// (hd_status.threaded false). The memory readout stays either way.
function renderLowMemoryMode() {
  const available = HOST_CAPABILITIES.lowMemoryMode && lastEngineStatus?.threaded !== false;
  element("low-memory-mode").hidden = !available;
  element("opt-low-memory-mode-help").hidden = !available;
  element("low-memory-mode-unavailable").hidden = available;
  element("opt-low-memory-mode").checked = options.lowMemoryMode;
  element("dictionary-entry-storage").hidden = !available;
  element("opt-dictionary-entry-storage").value = options.dictionaryEntryStorage;
  element("opt-dictionary-entry-storage").disabled = options.lowMemoryMode;
  element("dictionary-index-storage").hidden = !available || lastEngineStatus?.storageBackend !== "opfs";
  element("opt-dictionary-index-storage").value = options.dictionaryIndexStorage;
  element("use-less-ram-by-default").hidden = element("dictionary-index-storage").hidden;
  element("opt-use-less-ram-by-default").checked = options.useLessRamByDefault;
  element("opt-use-less-ram-by-default").disabled = options.lowMemoryMode || options.dictionaryIndexStorage !== "auto";
}

function memorySettings() {
  memoryController ??= createMemorySettings({ document, numberFormat, readMemory: () => send("hd_memory"),
    readExtensionTotal: () => send("hd_memory_total") });
  return memoryController;
}

// The readout is asked for on demand, not polled: when Advanced is shown or
// the engine publishes a new generation while it is shown, and when a Library
// row's Details opens. Nothing is requested while the Library is being worked
// on: a rebuilt row shows the last reading.
function refreshMemorySettings() {
  void memorySettings().refresh();
}

// Advanced also measures the whole extension; a row's Details does not.
function refreshAdvancedMemory() {
  refreshMemorySettings();
  void memorySettings().refreshExtensionTotal();
}

function updateBackupSettings() {
  if (activeSection !== "backup") return;
  backupController ??= createBackupSettingsController({
    document, send,
    download: typeof chrome.downloads?.download === "function"
      ? () => send("hd_backup_download", {}, WORKER_TARGET) : null,
    browserName: "Chrome",
    listAutomatic: () => send("hd_backup_auto_list", {}, WORKER_TARGET),
    trackPreparation: trackBackupPreparation,
    cancelPreparation(token) {
      if (backupLifecycleTokens.has(token)) postBackupLifecycle({ type: "cancel", token });
    },
    checkReady() {
      if (importing || installingRecommended || updating || removing || committing || customLoading || customSaving || pendingDictionaryCommits > 0) {
        throw new Error("Wait for the current dictionary operation to finish, then try again.");
      }
      if (customDictionaryDirty() || customButtonController?.dirty() || ankiController?.dirty()
          || savingOptions !== null || optionsEditRevision !== null
          || Object.keys(pendingOptions).length > 0 || savingSchedule !== null || pendingSchedule !== null
          || nameDrafts.hasPendingChanges()) {
        throw new Error("Save or discard your pending changes before working with a backup.");
      }
    },
    setBusy(value) { backingUp = value; setControlsDisabled(importing); },
    status: (message, tone, completed) => setSectionStatus("backup-status", message, tone, completed),
    async refresh() {
      const stored = await chrome.storage.local.get(["options", "dictionaryUpdates", CUSTOM_DICTIONARY_SOURCE_KEY]);
      adoptOptions(stored.options);
      adoptUpdateSettings(stored.dictionaryUpdates);
      adoptCustomDictionaryDocument(stored[CUSTOM_DICTIONARY_SOURCE_KEY]);
      await reloadDictionaries();
      await refreshStatus();
    },
  });
}

function connectBackupLifecycle() {
  const port = chrome.runtime.connect({ name: BACKUP_LIFECYCLE_PORT });
  backupLifecyclePort = port;
  port.onDisconnect.addListener(() => {
    if (backupLifecyclePort !== port) return;
    backupLifecyclePort = null;
    if (backupLifecycleTokens.size === 0 || backupLifecycleReconnectTimer !== null) return;
    backupLifecycleReconnectTimer = window.setTimeout(() => {
      backupLifecycleReconnectTimer = null;
      if (backupLifecyclePort !== null || backupLifecycleTokens.size === 0) return;
      try { connectBackupLifecycle(); } catch { /* A later ownership change retries. */ }
    }, 250);
  });
  try {
    for (const token of backupLifecycleTokens) {
      port.postMessage({ type: "track", token, active: true });
    }
  } catch (error) {
    if (backupLifecyclePort === port) backupLifecyclePort = null;
    throw error;
  }
  return port;
}

function postBackupLifecycle(message) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let port = backupLifecyclePort;
    try {
      if (port === null) port = connectBackupLifecycle();
      port.postMessage(message);
      return true;
    } catch {
      if (backupLifecyclePort === port) backupLifecyclePort = null;
    }
  }
  return false;
}

function trackBackupPreparation(token, active) {
  if (active) {
    backupLifecycleTokens.add(token);
    postBackupLifecycle({ type: "track", token, active: true });
    return;
  }
  backupLifecycleTokens.delete(token);
  if (backupLifecycleReconnectTimer !== null && backupLifecycleTokens.size === 0) {
    window.clearTimeout(backupLifecycleReconnectTimer);
    backupLifecycleReconnectTimer = null;
  }
  if (backupLifecyclePort !== null) {
    postBackupLifecycle({ type: "track", token, active: false });
  }
}

function updateDesignPreview() {
  if (activeSection !== "design") return;
  let frame = element("design-preview");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = "design-preview";
    frame.title = "Live dictionary popup preview";
    frame.addEventListener("load", updateDesignPreview);
    frame.src = "design-preview.html";
    element("preview-canvas").append(frame);
    resizeDesignPreview();
    element("preview-size").addEventListener("change", resizeDesignPreview);
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(resizeDesignPreview).observe(element("preview-viewport"));
    }
  }
  if (frame.style.width !== `${options.popupWidthPx * options.popupScalePercent / 100 + 96}px`
      || frame.style.height !== `${options.popupHeightPx * options.popupScalePercent / 100 + 216}px`) resizeDesignPreview();
  frame.contentWindow.HDDesignPreview?.update(options, dictionaryState);
}

function resizeDesignPreview() {
  const viewport = element("preview-viewport");
  const frame = element("design-preview");
  const width = options.popupWidthPx * options.popupScalePercent / 100 + 96;
  const height = options.popupHeightPx * options.popupScalePercent / 100 + 216;
  const scale = element("preview-size").value === "actual" ? 1 : Math.min(1, viewport.clientWidth / width);
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.transform = `scale(${scale})`;
  element("preview-canvas").style.width = `${width * scale}px`;
  element("preview-canvas").style.height = `${height * scale}px`;
}

function attachSettingsNavigation() {
  settingsSearch = createSettingsSearch({ document, navigate(section) {
    if (section && window.location.hash !== `#${section}`) window.history.pushState(null, "", `#${section}`);
    showSettingsSection();
  } });
  const picker = element("settings-section");
  picker.addEventListener("change", (event) => {
    const fragment = `#${event.target.value}`;
    // Native fragment navigation moves focus off the select before hashchange.
    // Preserve arrow-key selection while adding the section to browser history.
    if (window.location.hash !== fragment) window.history.pushState(null, "", fragment);
    showSettingsSection();
  });
  window.addEventListener("hashchange", () => showSettingsSection(document.activeElement !== picker));
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    element("settings-content").focus();
  });
  for (const link of document.querySelectorAll(".settings-nav a, #library-navigation a, .section-action")) {
    link.addEventListener("click", (event) => {
      if (link.hash === window.location.hash
          && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        // The native same-fragment action would move focus back to the section
        // after our heading focus. Modified clicks retain their browser action.
        event.preventDefault();
        showSettingsSection(true);
      }
    });
  }
  showSettingsSection();
}

async function send(type, fields = {}, target = TARGET) {
  requestCounter += 1;
  const reply = await chrome.runtime.sendMessage({
    target,
    type,
    requestId: `${type.replace(/^hd_/, "")}-${requestCounter}`,
    ...fields,
  });
  if (!reply) {
    throw new Error("the extension's service worker did not reply");
  }
  return reply;
}

function selectionParts(value) {
  if (value && typeof value === "object") {
    return value;
  }
  return typeof value === "string" && value !== ""
    ? { title: value, kind: "" }
    : null;
}

function selectionValue(selection) {
  return selection ? JSON.stringify(selection) : "";
}

function selectionFromValue(value) {
  if (!value) {
    return "";
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return normaliseKanjiSelection(parsed);
    }
  } catch {
    // Legacy title-only values are not JSON.
  }
  return normaliseKanjiSelection(value);
}

function isAvailableFrequencyDictionary(dictionary) {
  return dictionary.enabled !== false && hasCapability(dictionary, "freq");
}

function selectedFrequencyDictionary(title = options.frequencyDictionary) {
  return dictionaries.find((dictionary) => dictionary.title === title
    && isAvailableFrequencyDictionary(dictionary));
}

function normaliseKanjiClickOption() {
  let changed = false;
  const kanjiSelection = selectionParts(options.kanjiClickDictionary);
  if (kanjiSelection?.kind === "tabGroup") {
    if (!dictionaryState.groups.some((group) => group.id === kanjiSelection.id)) {
      options.kanjiClickDictionary = "";
      changed = true;
    }
  } else if (kanjiSelection) {
    const selected = dictionaries.find((entry) => entry.title === kanjiSelection.title);
    const requestedKind = kanjiSelection.kind || (selected && hasCapability(selected, "kanji") ? "kanji" : "term");
    if (!selected || selected.enabled === false || !hasCapability(selected, requestedKind)) {
      options.kanjiClickDictionary = "";
      changed = true;
    } else if (kanjiSelection.kind === "") {
      options.kanjiClickDictionary = { title: kanjiSelection.title, kind: requestedKind };
      changed = true;
    }
  }
  return changed;
}

function setStatus(message, tone, failures = []) {
  const status = element("engine-status");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-ready", tone === "ready");
  renderStatusFailures(failures);
}

// One entry per package the engine could not load, its title and raw load error
// as literal text. Unchanged records keep their nodes across status polls.
function renderStatusFailures(failures) {
  const list = element("engine-status-failures");
  list.hidden = failures.length === 0;
  if (list.childElementCount === failures.length
      && failures.every(({ title, error }, index) => {
        const [renderedTitle, renderedError] = list.children[index].children;
        return renderedTitle.textContent === title && renderedError.textContent === error;
      })) {
    return;
  }
  const items = document.createDocumentFragment();
  for (const { title, error } of failures) {
    const item = document.createElement("li");
    const titleText = document.createElement("span");
    titleText.className = "engine-status-failure-title";
    titleText.textContent = title;
    const errorText = document.createElement("span");
    errorText.className = "engine-status-failure-error";
    errorText.textContent = error;
    item.append(titleText, errorText);
    items.appendChild(item);
  }
  list.replaceChildren(items);
}

function scheduleStatusPoll(delay = STATUS_POLL_MS) {
  if (statusTimer !== null) {
    return;
  }
  statusTimer = setTimeout(() => {
    statusTimer = null;
    void refreshStatus();
  }, delay);
}

async function refreshStatus() {
  let reply;
  try {
    reply = await send("hd_status");
  } catch (error) {
    lastEngineStatus = null;
    // A poll can fail transiently: the service worker can be torn down mid-relay,
    // or the offscreen document can be recreated faster than background.js's
    // retries. Keep polling, or one blip freezes this line on a stale error while
    // the engine finishes booting and every lookup works.
    setStatus(`Cannot reach the engine: ${describeErrorOrJson(error)}`, "error");
    scheduleStatusPoll(STATUS_RETRY_MS);
    return;
  }
  if (!reply.ok) {
    lastEngineStatus = null;
    // Either a boot failure or background.js's relay giving up, and the two are
    // not distinguishable from here, so retry both: a boot error survives the
    // retry and keeps saying so.
    setStatus(`Engine error: ${reply.error ?? "unknown"}`, "error");
    scheduleStatusPoll(STATUS_RETRY_MS);
    return;
  }
  const previousGeneration = lastEngineStatus?.generation;
  const previousUpdating = lastEngineStatus?.updating?.id ?? null;
  lastEngineStatus = reply;
  renderEngineStatus();
  renderUpdatingRows(previousUpdating, reply.updating?.id ?? null);
  renderLowMemoryMode();
  if (activeSection === "advanced" && reply.ready && !reply.loading && reply.generation !== previousGeneration) {
    refreshAdvancedMemory();
  }
  if (!reply.ready || reply.loading || updating) {
    scheduleStatusPoll();
  }
}

function renderEngineStatus() {
  if (lastEngineStatus === null) return;
  const count = dictionaries.filter((entry) => entry.enabled !== false).length;
  const failed = Array.isArray(lastEngineStatus.failedDictionaries) ? lastEngineStatus.failedDictionaries : [];
  if (lastEngineStatus.ready && failed.length > 0) {
    const subject = failed.length === 1 ? "1 dictionary" : `${numberFormat.format(failed.length)} dictionaries`;
    const pronoun = failed.length === 1 ? "it" : "them";
    setStatus(`Could not load ${subject}. Re-import or remove ${pronoun}; the other dictionaries still work.`, "error", failed);
    return;
  }
  if (lastEngineStatus.ready) {
    if (count === 0 && !lastEngineStatus.loading) {
      setStatus(dictionaries.length === 0
        ? "Ready to add your first dictionary."
        : "Ready. Enable a dictionary in Library to start reading.");
      return;
    }
    const enabled = count === 1 ? "1 dictionary enabled" : `${numberFormat.format(count)} dictionaries enabled`;
    setStatus(lastEngineStatus.loading ? `Ready, ${enabled}, working…` : `Ready, ${enabled}.`, "ready");
  } else {
    setStatus("Starting the engine and loading dictionaries…");
  }
}

function renderFrequencyChoices() {
  const select = element("opt-frequency-dictionary");
  if (select === document.activeElement) return;
  const previous = options.frequencyDictionary;
  select.textContent = "";

  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Any — automatic across all dictionaries";
  select.appendChild(automatic);

  const enabled = dictionaries.filter(isAvailableFrequencyDictionary);
  const withFrequencies = new Set(
    enabled.map((entry) => entry.title),
  );
  const groups = [{ label: "Frequency dictionaries", titles: [...withFrequencies] }];
  for (const group of groups) {
    if (group.titles.length === 0) {
      continue;
    }
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const title of group.titles) {
      const dictionary = enabled.find((entry) => entry.title === title);
      const option = document.createElement("option");
      option.value = title;
      option.textContent = dictionary ? dictionaryLabel(dictionary) : title;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  // Keep a removed selection visible rather than silently rewriting the option.
  if (previous !== "" && !withFrequencies.has(previous)) {
    const stale = document.createElement("option");
    stale.value = previous;
    stale.textContent = `${previous} (unavailable)`;
    stale.disabled = true;
    select.appendChild(stale);
  }
  select.value = previous;
}

function renderCursorExitControls() {
  element("opt-hide-on-cursor-exit").checked = options.hidePopupOnCursorExit;
  const delay = element("opt-hide-on-cursor-exit-delay");
  // Like the compact summary count: a focused draft keeps its field enabled.
  if (delay !== document.activeElement) delay.disabled = !options.hidePopupOnCursorExit;
}

// The notice belongs to the personal dictionary, and the Library card says why
// its entries are missing from lookups while it is off.
function renderPersonalDictionaryControls() {
  const enabled = options.personalDictionaryEnabled;
  element("opt-personal-dictionary").checked = enabled;
  element("selection-notice-controls").hidden = !enabled;
  element("custom-dictionary-off").hidden = enabled;
}

function renderCompactSummaryControls() {
  const enabled = options.showCompactDefinitionSummary;
  element("opt-compact-summary").checked = enabled;
  const count = element("opt-summary-count");
  // Disabling Chrome's focused select emits blur before its pending change.
  // Keep that draft's captured revision until the existing focusout boundary.
  if (count !== document.activeElement) count.disabled = !enabled;
  renderPreferredDictionary("opt-summary-dictionary", options.compactDefinitionSummaryDictionary,
    "term", "Automatic — first available definition", enabled);
}

function renderPreferredDictionary(id, preferred, kind, automaticLabel, enabled) {
  const select = element(id);
  if (select === document.activeElement) return;
  select.disabled = !enabled;
  select.replaceChildren(new Option(automaticLabel, ""));
  let available = preferred === "";
  for (const dictionary of dictionaries) {
    if (!hasCapability(dictionary, kind)) continue;
    const label = dictionaryLabel(dictionary) + (dictionary.enabled === false ? " (disabled)" : "");
    select.add(new Option(label, dictionary.title));
    available ||= dictionary.title === preferred;
  }
  // Already-missing sources remain a soft preference, not a lookup filter.
  if (!available) select.add(new Option(`${preferred} (unavailable)`, preferred));
  select.value = preferred;
}

function renderWordHighlightControls() {
  for (const { key, id } of WORD_HIGHLIGHT_SWITCHES) element(id).checked = options[key];
  const style = element("opt-word-highlight-style");
  if (style !== document.activeElement) style.value = options.wordHighlightStyle;
}

function renderMetadataControls() {
  for (const field of METADATA_FIELDS) {
    element(field.id).checked = field.inverted ? !options[field.key] : options[field.key];
  }
  renderDefinitionBlurControls();
  // The dictionary picks the furigana's pitch, which also gives the headword's colour.
  renderPreferredDictionary("opt-pitch-dictionary", options.pitchAccentFuriganaDictionary,
    "pitch", "Automatic — first available pitch", options.showPitchAccentFurigana || options.showPitchAccentColors);
  // Like the dictionary picker, a focused style keeps its draft until blur.
  const furiganaStyle = element("opt-pitch-furigana-style");
  if (furiganaStyle !== document.activeElement) {
    furiganaStyle.disabled = !options.showPitchAccentFurigana;
    furiganaStyle.value = options.pitchAccentFuriganaStyle;
  }
}

function renderPopupImageSources() {
  const select = element("opt-image-source");
  if (select === document.activeElement) return;
  const source = options.popupImageSource;
  const previous = selectionValue(source);
  select.replaceChildren(new Option("Automatic — current tab", ""));
  let available = source === null;
  function addSource(value, label) {
    const encoded = selectionValue(value);
    select.add(new Option(label, encoded));
    available ||= encoded === previous;
  }
  for (const dictionary of dictionaries) {
    addSource({ kind: "dictionary", title: dictionary.title },
      `Dictionary: ${dictionaryLabel(dictionary)}${dictionary.enabled === false ? " (disabled)" : ""}`);
  }
  for (const group of dictionaryState.groups) {
    addSource({ kind: "tabGroup", id: group.id }, `Group: ${group.name}`);
  }
  if (!available) addSource(source, `${source.title || source.id} (unavailable)`);
  select.value = previous;
}

function renderFrequencyOrder() {
  const order = element("opt-frequency-order");
  if (order !== document.activeElement) order.value = options.frequencyOrder;
  const selected = selectedFrequencyDictionary();
  for (const choice of order.options) {
    choice.disabled = !selected && (choice.value === "ascending" || choice.value === "descending");
  }
  element("opt-frequency-auto").disabled = !selected;
  let hint;
  if (options.frequencyOrder === "auto") hint = "Automatic compares all enabled frequency dictionaries in their listed order.";
  else if (options.frequencyOrder === "disabled") hint = "Frequency sorting is off. Your dictionary choice is remembered.";
  else if (!selected) hint = "Choose an available frequency dictionary to use this direction.";
  else if (selected.frequencyMode === "rank-based") hint = "Rank-based: Auto puts the lowest numbers first.";
  else if (selected.frequencyMode === "occurrence-based") hint = "Occurrence-based: Auto puts the highest numbers first.";
  else hint = "No mode declared: Auto uses highest numbers first.";
  const hintElement = element("frequency-order-hint");
  if (hintElement.textContent !== hint) hintElement.textContent = hint;
}

function applyFrequencyDirection() {
  const direction = selectedFrequencyDictionary()?.frequencyMode === "rank-based" ? "ascending" : "descending";
  options.frequencyOrder = options.frequencyDictionary === "" ? "auto" : direction;
  renderFrequencyOrder();
  writeOptions();
}

function appendKanjiGroup(select, enabled, group, availableValues) {
  if (group.titles.length === 0) {
    return;
  }
  const optgroup = document.createElement("optgroup");
  optgroup.label = group.label;
  for (const title of group.titles) {
    const dictionary = enabled.find((entry) => entry.title === title);
    const option = document.createElement("option");
    option.value = selectionValue({ title, kind: group.kind });
    option.textContent = dictionary ? dictionaryLabel(dictionary) : title;
    availableValues.add(option.value);
    optgroup.appendChild(option);
  }
  select.appendChild(optgroup);
}

function selectedKanjiValue(previousSelection, withKanji, withTerms) {
  if (previousSelection?.kind !== "") {
    return selectionValue(previousSelection);
  }
  let kind = "";
  if (withKanji.has(previousSelection.title)) {
    kind = "kanji";
  } else if (withTerms.has(previousSelection.title)) {
    kind = "term";
  }
  return kind === ""
    ? previousSelection.title
    : selectionValue({ title: previousSelection.title, kind });
}

function appendStaleKanjiChoice(select, previousSelection, selectedValue, availableValues) {
  if (!previousSelection || availableValues.has(selectedValue)) {
    return;
  }
  const stale = document.createElement("option");
  stale.value = selectedValue;
  stale.textContent = `${previousSelection.kind === "tabGroup" ? "Group" : previousSelection.title} (not available)`;
  select.appendChild(stale);
}

function appendKanjiGroupChoices(select, availableValues) {
  if (dictionaryState.groups.length === 0) return;
  const optgroup = document.createElement("optgroup");
  optgroup.label = "Groups";
  for (const group of dictionaryState.groups) {
    const option = new Option(group.name, selectionValue({ kind: "tabGroup", id: group.id }));
    availableValues.add(option.value);
    optgroup.appendChild(option);
  }
  select.appendChild(optgroup);
}

function renderKanjiChoices() {
  const select = element("opt-kanji-dictionary");
  // Inventory updates wait for focusout, as the Image source chooser does.
  if (select === document.activeElement) return;
  const previousSelection = selectionParts(options.kanjiClickDictionary);
  select.textContent = "";

  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Automatic — use every kanji dictionary";
  select.appendChild(automatic);

  const enabled = dictionaries.filter((entry) => entry.enabled !== false);
  const withKanji = new Set(
    enabled.filter((entry) => hasCapability(entry, "kanji")).map((entry) => entry.title),
  );
  const withTerms = new Set(
    enabled.filter((entry) => hasCapability(entry, "term")).map((entry) => entry.title),
  );
  const groups = [
    { kind: "kanji", label: "Kanji dictionaries", titles: [...withKanji] },
    {
      kind: "term",
      label: "Term dictionaries — requires a matching single-kanji entry",
      titles: [...withTerms],
    },
  ];
  const availableValues = new Set();
  for (const group of groups) {
    appendKanjiGroup(select, enabled, group, availableValues);
  }
  appendKanjiGroupChoices(select, availableValues);

  const selectedValue = selectedKanjiValue(previousSelection, withKanji, withTerms);
  appendStaleKanjiChoice(select, previousSelection, selectedValue, availableValues);
  select.value = selectedValue;
}

// Theme Store renderer names for the Theme select, matching the Store cards.
const rendererLabel = slug => slug === "jl" ? "JL" : slug[0].toUpperCase() + slug.slice(1);

function renderThemeChoices() {
  themeStore.render(options);
  if (activeSection !== "design") return;
  const theme = element("opt-popup-theme");
  if (theme.options.length === 0) {
    for (const group of POPUP_THEME_GROUPS) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const entry of group.themes) optgroup.append(new Option(entry.label, entry.id));
      theme.append(optgroup);
    }
  }
  let storeGroup = [...theme.children].find(group => group.label === "Theme Store");
  if (!storeGroup && (options.experimental.themeStore || popupRenderer(options.popupTheme) !== "default")) {
    storeGroup = document.createElement("optgroup");
    storeGroup.label = "Theme Store";
    for (const slug of POPUP_RENDERER_IDS) storeGroup.append(new Option(rendererLabel(slug), slug));
    theme.append(storeGroup);
  }
  if (storeGroup) storeGroup.hidden = !options.experimental.themeStore && popupRenderer(options.popupTheme) === "default";
  if (theme !== document.activeElement) theme.value = options.popupTheme;
}

function renderCustomCss(force = false) {
  const editor = element("opt-custom-popup-css");
  if ((force || editor !== document.activeElement) && editor.value !== options.customPopupCss) {
    editor.value = options.customPopupCss;
  }
  element("custom-css-count").textContent = `${numberFormat.format(editor.value.length)} characters`;
}

function renderCustomJavascript(force = false) {
  const editor = element("opt-custom-popup-javascript");
  if ((force || editor !== document.activeElement) && editor.value !== options.customPopupJavascript) {
    editor.value = options.customPopupJavascript;
  }
  element("custom-javascript-count").textContent = `${numberFormat.format(editor.value.length)} characters`;
}

// Yomitan's "Scan modifier key" lists No key first. Its empty value is never
// stored: it means lookupMode "hover" and keeps the remembered activationKey.
// No key leaves the keep-open switch on for the next key, as a re-render would.
function renderActivationControls() {
  activationController ??= createActivationSettings({ document, report: message => setOptionsStatus(message) });
  activationController.render(options.lookupMode === "hover" ? "" : options.activationKey);
  element("opt-lookup-sticky").checked = options.lookupMode !== "activation";
  element("opt-lookup-sticky-row").hidden = options.lookupMode === "hover";
  // Child popups name the remembered key, which No key keeps.
  const childPopups = element("opt-definition-lookup-mode");
  childPopups.querySelector('option[value="activation"]').textContent = `Hold ${activationLabel(options.activationKey)}`;
  if (childPopups !== document.activeElement) childPopups.value = options.definitionLookupMode;
  renderScanDelayControls();
}

// Only lookups that need no key wait for the pointer to rest: page lookups
// with No key, and definitions that follow them. Same as page delay is stored
// as null, so it keeps following later page delay edits.
function renderScanDelayControls() {
  const hover = options.lookupMode === "hover";
  const custom = options.definitionScanDelayMs !== null;
  for (const [id, hidden] of [["opt-scan-delay-row", !hover],
    ["opt-definition-scan-delay-row", !hover || options.definitionLookupMode !== "inherit"],
    ["opt-definition-scan-delay-custom", !custom]]) {
    const row = element(id);
    // Hiding a focused control can emit blur before its pending change.
    if (!hidden || !row.contains(document.activeElement)) row.hidden = hidden;
  }
  const mode = element("opt-definition-scan-delay-mode");
  mode.querySelector('option[value="inherit"]').textContent = `Same as page delay (${options.scanDelayMs} ms)`;
  if (mode !== document.activeElement) mode.value = custom ? "custom" : "inherit";
  const delay = element("opt-definition-scan-delay");
  if (delay !== document.activeElement) delay.value = String(options.definitionScanDelayMs ?? options.scanDelayMs);
}

function renderOptions() {
  applyPageTheme(document, options);
  for (const field of NUMBER_FIELDS) {
    const input = element(field.id);
    if (input !== document.activeElement) {
      input.value = String(options[field.key]);
    }
  }
  element("opt-hover-enabled").checked = options.hoverEnabled;
  element("opt-japanese-only").checked = options.onlyScanJapaneseText;
  renderPersonalDictionaryControls();
  element("opt-no-result-notice").checked = options.showNoResultNotice;
  renderCursorExitControls();
  element("opt-source-highlight").checked = options.sourceHighlightEnabled;
  element("opt-popup-audio-button").checked = options.showPopupAudioButton;
  element("opt-audio-autoplay").checked = options.audioAutoplay;
  renderThemeChoices();
  renderCustomCss();
  renderCustomJavascript();
  customButtonController?.render();
  const toolbar = element("opt-popup-toolbar");
  if (toolbar !== document.activeElement) toolbar.value = options.popupToolbarPosition;
  const imageHoverPreview = element("opt-image-hover-preview");
  if (imageHoverPreview !== document.activeElement) imageHoverPreview.value = options.imageHoverPreview;
  const glossaryLayout = element("opt-glossary-layout");
  if (glossaryLayout !== document.activeElement) glossaryLayout.value = options.glossaryLayoutMode;
  renderActivationControls();
  renderFrequencyOrder();
  renderKanjiChoices();
  renderFrequencyChoices();
  renderCompactSummaryControls();
  renderPopupImageSources();
  renderMetadataControls();
  renderWordHighlightControls();
  renderExperimentalSettings();
  renderLowMemoryMode();
  updateDesignPreview();
  updateAudioSettings();
  updateAnkiSettings();
  updateKeybindSettings();
}

const dictionaryGroupController = createDictionaryGroupController({
  setError: (message) => setSectionStatus("dict-group-error", message, "error"),
  readState: () => dictionaryState,
  readDictionaries: () => dictionaries,
  commitGroups,
  dictionaryLabel,
  moveListItem,
  updateItemById,
  renderDeferredAfterBlur,
  bindNameDraft,
});

function attachHandlers() {
  attachCustomDictionaryHandlers();

  attachImportHandlers();

  attachLibraryHandlers();
  element("lookup-counts-reset").addEventListener("click", () => { void resetLookupCounts(); });
  element("debug-info-download").addEventListener("click", () => { void downloadDebugInfo(); });

  attachGroupHandlers();

  attachRecommendedHandlers();
  attachUpdateHandlers();

  for (const field of NUMBER_FIELDS) {
    const input = element(field.id);
    input.addEventListener("change", () => {
      options[field.key] = clampOption(field.key, input.value);
      input.value = String(options[field.key]);
      writeOptions();
    });
  }

  element("opt-hover-enabled").addEventListener("change", (event) => {
    options.hoverEnabled = event.target.checked;
    writeOptions();
  });
  for (const field of APPEARANCE_CHOICES) {
    element(field.id).addEventListener("change", (event) => {
      options[field.key] = field.values && !field.values.includes(event.target.value)
        ? DEFAULT_OPTIONS[field.key] : event.target.value;
      if (field.key === "definitionBlurReveal") renderDefinitionBlurControls();
      writeOptions();
    });
  }
  attachDefinitionBlurHandlers();
  element("opt-source-highlight").addEventListener("change", (event) => {
    options.sourceHighlightEnabled = event.target.checked;
    writeOptions();
  });
  element("opt-popup-audio-button").addEventListener("change", (event) => {
    options.showPopupAudioButton = event.target.checked;
    writeOptions();
  });
  element("reset-design").addEventListener("click", () => {
    for (const key of DESIGN_OPTION_KEYS) options[key] = DEFAULT_OPTIONS[key];
    customButtonController?.reset();
    renderCustomCss(true);
    renderCustomJavascript(true);
    renderOptions();
    writeOptions();
  });
  element("opt-custom-popup-css").addEventListener("input", event => {
    // This target listener runs before the section's bubbling draft listener.
    optionsEditRevision ??= Math.max(0, optionsRevision);
    options.customPopupCss = event.target.value;
    renderCustomCss();
    writeOptions();
  });
  element("reset-custom-css").addEventListener("click", () => {
    options.customPopupCss = DEFAULT_OPTIONS.customPopupCss;
    renderCustomCss(true);
    writeOptions();
  });
  element("opt-custom-popup-javascript").addEventListener("input", event => {
    optionsEditRevision ??= Math.max(0, optionsRevision);
    options.customPopupJavascript = event.target.value;
    renderCustomJavascript();
    writeOptions();
  });
  element("reset-custom-javascript").addEventListener("click", () => {
    options.customPopupJavascript = DEFAULT_OPTIONS.customPopupJavascript;
    renderCustomJavascript(true);
    writeOptions();
  });
  for (const field of METADATA_FIELDS) {
    element(field.id).addEventListener("change", (event) => {
      options[field.key] = field.inverted ? !event.target.checked : event.target.checked;
      renderMetadataControls();
      writeOptions();
    });
  }
  element("opt-pitch-dictionary").addEventListener("change", (event) => {
    options.pitchAccentFuriganaDictionary = event.target.value;
    writeOptions();
  });
  element("opt-japanese-only").addEventListener("change", (event) => {
    options.onlyScanJapaneseText = event.target.checked;
    writeOptions();
  });
  for (const { key, id } of WORD_HIGHLIGHT_SWITCHES) {
    element(id).addEventListener("change", (event) => {
      options[key] = event.target.checked;
      writeOptions();
    });
  }
  element("opt-personal-dictionary").addEventListener("change", (event) => {
    options.personalDictionaryEnabled = event.target.checked;
    renderPersonalDictionaryControls();
    writeOptions();
  });
  element("opt-no-result-notice").addEventListener("change", (event) => {
    options.showNoResultNotice = event.target.checked;
    writeOptions();
  });
  element("opt-hide-on-cursor-exit").addEventListener("change", (event) => {
    options.hidePopupOnCursorExit = event.target.checked;
    renderCursorExitControls();
    writeOptions();
  });
  element("opt-low-memory-mode").addEventListener("change", (event) => {
    options.lowMemoryMode = event.target.checked;
    renderLowMemoryMode();
    writeOptions();
  });
  element("opt-dictionary-index-storage").addEventListener("change", (event) => {
    options.dictionaryIndexStorage = event.target.value;
    renderLowMemoryMode();
    writeOptions();
  });
  element("opt-use-less-ram-by-default").addEventListener("change", (event) => {
    options.useLessRamByDefault = event.target.checked;
    writeOptions();
  });
  element("opt-dictionary-entry-storage").addEventListener("change", (event) => {
    options.dictionaryEntryStorage = event.target.value;
    writeOptions();
  });
  element("opt-audio-autoplay").addEventListener("change", (event) => {
    options.audioAutoplay = event.target.checked;
    writeOptions();
  });
  element("opt-compact-summary").addEventListener("change", (event) => {
    options.showCompactDefinitionSummary = event.target.checked;
    renderCompactSummaryControls();
    writeOptions();
  });
  element("opt-summary-dictionary").addEventListener("change", (event) => {
    options.compactDefinitionSummaryDictionary = event.target.value;
    writeOptions();
  });
  element("opt-image-source").addEventListener("change", (event) => {
    // Values come from the canonical descriptors rendered above, not labels.
    options.popupImageSource = event.target.value ? JSON.parse(event.target.value) : null;
    writeOptions();
  });
  // The picker and the keep-open switch together choose one lookup mode, so
  // either control's change reads both.
  const writeActivation = () => {
    const key = element("opt-activation-key").value;
    if (key === "") {
      options.lookupMode = "hover";
    } else {
      options.activationKey = key;
      options.lookupMode = element("opt-lookup-sticky").checked ? "activationSticky" : "activation";
    }
    renderActivationControls();
    writeOptions();
  };
  element("opt-activation-key").addEventListener("change", writeActivation);
  element("opt-lookup-sticky").addEventListener("change", writeActivation);
  element("opt-definition-lookup-mode").addEventListener("change", (event) => {
    options.definitionLookupMode = DEFINITION_LOOKUP_MODES.includes(event.target.value) ? event.target.value : "inherit";
    renderScanDelayControls();
    writeOptions();
  });
  element("opt-definition-scan-delay-mode").addEventListener("change", (event) => {
    // Custom starts from the page delay it was following.
    options.definitionScanDelayMs = event.target.value === "custom" ? options.scanDelayMs : null;
    renderScanDelayControls();
    writeOptions();
  });
  element("opt-definition-scan-delay").addEventListener("change", (event) => {
    options.definitionScanDelayMs = clampOption("definitionScanDelayMs", event.target.value);
    event.target.value = String(options.definitionScanDelayMs);
    writeOptions();
  });

  element("opt-frequency-order").addEventListener("change", (event) => {
    options.frequencyOrder = FREQUENCY_ORDERS.includes(event.target.value) ? event.target.value : "auto";
    renderFrequencyOrder();
    writeOptions();
  });

  element("opt-frequency-dictionary").addEventListener("change", (event) => {
    // A focused native chooser can outlive a dictionary capability change.
    if (event.target.value && !selectedFrequencyDictionary(event.target.value)) {
      event.target.value = options.frequencyDictionary;
      setOptionsStatus("That frequency dictionary is no longer available.");
      return;
    }
    options.frequencyDictionary = event.target.value;
    // Blur set to "Same as sorting" follows this choice.
    renderDefinitionBlurControls();
    applyFrequencyDirection();
  });
  element("opt-frequency-auto").addEventListener("click", applyFrequencyDirection);

  element("opt-kanji-dictionary").addEventListener("change", (event) => {
    options.kanjiClickDictionary = selectionFromValue(event.target.value);
    writeOptions();
  });
  const optionSections = Object.keys(OPTION_SECTIONS).map(element);
  for (const section of optionSections) {
    section.addEventListener("input", (event) => {
      if (!event.target.id.startsWith("opt-")) return;
      optionsEditRevision ??= Math.max(0, optionsRevision);
      const field = NUMBER_FIELDS.find(({ id, live }) => live && id === event.target.id);
      if (field && event.target.value !== "" && event.target.validity.valid) {
        options[field.key] = Number(event.target.value);
        writeOptions();
      }
    });
    section.addEventListener("change", () => {
      optionsEditRevision = null;
    });
    section.addEventListener("focusout", (event) => {
      optionsEditRevision = null;
      if (event.target.id === "opt-custom-popup-css") renderCustomCss(true);
      if (event.target.id === "opt-custom-popup-javascript") renderCustomJavascript(true);
      if (event.target.id === "opt-frequency-dictionary") renderFrequencyChoices();
      if (event.target.id === "opt-blur-frequency-dictionary") renderDefinitionBlurFrequencyChoices();
      if (event.target.id === "opt-image-source") renderPopupImageSources();
      if (event.target.id === "opt-kanji-dictionary") renderKanjiChoices();
      if (event.target.id === "opt-pitch-dictionary" || event.target.id === "opt-pitch-furigana-style") renderMetadataControls();
      if (event.target.closest("#definition-blur-settings")) {
        renderDefinitionBlurControls();
      }
      if (event.target.id === "opt-summary-dictionary" || event.target.id === "opt-summary-count") renderCompactSummaryControls();
      if (event.target.id === "opt-hide-on-cursor-exit-delay") renderCursorExitControls();
      if (event.target.closest("#opt-scan-delay-row, #opt-definition-scan-delay-row")) renderScanDelayControls();
      const choice = APPEARANCE_CHOICES.find(({ id }) => id === event.target.id);
      if (choice) event.target.value = options[choice.key];
      const field = NUMBER_FIELDS.find(({ id }) => id === event.target.id);
      if (field) event.target.value = String(options[field.key]);
    });
  }
  element("options-retry").addEventListener("click", () => {
    optionsSaveFailed = false;
    pendingOptionsRevision = optionsRevision;
    void flushOptions();
  });
  element("options-use-saved").addEventListener("click", () => {
    window.clearTimeout(optionsTimer);
    optionsTimer = null;
    pendingOptions = {};
    optionsEditRevision = null;
    optionsSaveFailed = false;
    renderCurrentOptions();
    renderCustomCss(true);
    renderCustomJavascript(true);
    setOptionsStatus("Using saved settings.");
  });

  window.addEventListener("beforeunload", (event) => {
    if (!importing && !backingUp && pendingDictionaryCommits === 0 && savingOptions === null && optionsEditRevision === null
        && Object.keys(pendingOptions).length === 0 && savingSchedule === null && pendingSchedule === null
        && !nameDrafts.hasPendingChanges() && !customButtonController?.dirty() && !ankiController?.dirty()) {
      return;
    }
    // Leaving can revoke an import's blob URL or discard a queued settings draft.
    event.preventDefault();
    event.returnValue = "";
  });

  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.runtime.onMessage?.addListener(recommendedInstallation.receive);
  window.addEventListener("pagehide", recommendedInstallation.stop);
  window.addEventListener("pageshow", event => { if (event.persisted) void recommendedInstallation.request(); });
}

function renderCurrentOptions() {
  options = { ...savedOptions, ...savingOptions?.patch, ...pendingOptions };
  renderOptions();
}

function adoptOptions(value) {
  const revision = Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0;
  if (revision <= optionsRevision) return false;
  optionsRevision = revision;
  savedOptions = normaliseOptions(value);
  renderCurrentOptions();
  return true;
}

function handleOptionsChange(change) {
  adoptOptions(change.newValue);
}

function renderSetupResume(value) {
  let incomplete = false;
  try {
    incomplete = setupIncomplete(normaliseSetupState(value));
  } catch {
    // An unreadable setup record hides the resume link; the startup page reports it.
  }
  element("setup-resume").hidden = !incomplete;
}

function handleStorageChange(changes, area) {
  if (area !== "local") {
    return;
  }
  if (changes[SETUP_STATE_KEY]) {
    renderSetupResume(changes[SETUP_STATE_KEY].newValue);
  }
  if (changes.sharing) {
    renderSharingLink(changes.sharing.newValue);
  }
  if (changes[CUSTOM_DICTIONARY_SOURCE_KEY]) {
    handleCustomDictionarySourceChange(changes[CUSTOM_DICTIONARY_SOURCE_KEY]);
  }
  if (changes.dictionaryState && !handleDictionaryStateChange(changes.dictionaryState)) {
    return;
  }
  if (changes.options) {
    handleOptionsChange(changes.options);
  }
  if (changes.dictionaryUpdates) {
    if (adoptUpdateSettings(changes.dictionaryUpdates.newValue)) renderUpdateControls();
  }
  if (changes.automaticBackups) {
    void backupController?.refreshAutomaticBackups();
  }
}

function setOptionsStatus(message, completed = false) {
  let tone = message === "Saved." ? "ready" : "";
  if (optionsSaveFailed) tone = "error";
  setSectionStatus("options-status", message, tone, completed);
  element("options-status").classList.toggle("is-quiet", !optionsSaveFailed
    && ["Saved.", "Saving…", "Unsaved changes…", "Using saved settings."].includes(message));
  element("options-conflict-actions").hidden = !optionsSaveFailed;
}

// Keep only edited fields. A storage event can update the committed snapshot,
// but cannot replace a local draft or authorize a stale draft's write.
function writeOptions() {
  applyPageTheme(document, options);
  themeStore.render(options);
  updateDesignPreview();
  const previous = { ...savedOptions, ...savingOptions?.patch };
  const changes = Object.fromEntries(Object.entries(options).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(previous[key])));
  if (Object.keys(pendingOptions).length === 0) {
    pendingOptionsRevision = optionsEditRevision ?? Math.max(0, optionsRevision);
  }
  pendingOptions = changes;
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  if (optionsSaveFailed) return;
  setOptionsStatus("Unsaved changes…");
  optionsTimer = window.setTimeout(() => { void flushOptions(); }, OPTIONS_SAVE_DELAY_MS);
}

async function flushOptions() {
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  if (savingOptions !== null) return optionsSaveCompletion;
  if (optionsSaveFailed) return;
  if (Object.keys(pendingOptions).length === 0) {
    setOptionsStatus("Saved.");
    return;
  }
  let finishSave;
  optionsSaveCompletion = new Promise(resolve => { finishSave = resolve; });
  const sent = { patch: pendingOptions, baseRevision: pendingOptionsRevision };
  savingOptions = sent;
  pendingOptions = {};
  setOptionsStatus("Saving…");
  try {
    const reply = await send("hd_options_write", {
      baseRevision: sent.baseRevision,
      options: sent.patch,
    }, WORKER_TARGET);
    if (reply.options) adoptOptions(reply.options);
    if (!reply.ok) {
      throw new Error(reply.error || "the options could not be saved");
    }
    // A newer external event may already have arrived; keep that state, while
    // binding queued edits to the reply we actually committed, not that event.
    pendingOptionsRevision = Math.max(pendingOptionsRevision, reply.options.revision);
    if (optionsEditRevision !== null) {
      optionsEditRevision = Math.max(optionsEditRevision, reply.options.revision);
    }
    setOptionsStatus(Object.keys(pendingOptions).length > 0 ? "Unsaved changes…" : "Saved.", true);
  } catch (error) {
    pendingOptions = { ...sent.patch, ...pendingOptions };
    optionsSaveFailed = true;
    // A reply can be lost after storage commits. Read the current revision for
    // explicit retry; do not silently overwrite it or drop the retained draft.
    try {
      const stored = await chrome.storage.local.get("options");
      adoptOptions(stored.options);
    } catch { /* The draft stays available even while storage is unreachable. */ }
    setOptionsStatus(`Could not save settings: ${describeErrorOrJson(error)}`);
  } finally {
    savingOptions = null;
    syncNavigationStatus("options-status");
    renderCurrentOptions();
    if (!optionsSaveFailed && optionsTimer === null && Object.keys(pendingOptions).length > 0) {
      void flushOptions();
    }
    finishSave();
  }
}

async function flushOptionsUntilIdle() {
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  for (;;) {
    if (optionsSaveFailed) {
      throw new Error("Save the pending settings before checking AnkiConnect.");
    }
    if (savingOptions === null && Object.keys(pendingOptions).length === 0) return;
    await flushOptions();
  }
}

function renderMiningCapabilityHelp() {
  element("audio-mining-help").hidden = MINING_CAPABILITIES.browserSpeech;
}

async function start() {
  // Get debug info includes this page's own recent warnings and errors.
  captureDebugLog(window, { context: "settings" });
  configureBrowserUi();
  renderMiningCapabilityHelp();
  element("custom-buttons-settings").disabled = false;
  element("custom-buttons-overlay-help").hidden = !HOST_CAPABILITIES.externalLinkHost;
  if (HOST_CAPABILITIES.localFileAccessPrompt) {
    createLocalFileAccessController({ document, container: element("settings-local-file-access") });
  }
  attachSettingsNavigation();
  renderRecommendedCatalogue();
  attachHandlers();
  const stored = await chrome.storage.local.get(["options", "dictionaryUpdates", SETUP_STATE_KEY, "sharing"]);
  adoptOptions(stored.options);
  adoptUpdateSettings(stored.dictionaryUpdates);
  renderSetupResume(stored[SETUP_STATE_KEY]);
  renderSharingLink(stored.sharing);
  renderCustomDictionaryControls();
  if (await reloadDictionaries()) {
    writeOptions();
  }
  renderOptions();
  renderUpdateControls();
  await refreshStatus();
  void recommendedInstallation.request();
}

export {
  backingUp, clampOption, definitionBlurFrequencyDictionary, dictionaryGroupController, element,
  isAvailableFrequencyDictionary, lastEngineStatus, memorySettings, nameDrafts, normaliseKanjiClickOption,
  numberFormat, options, OPTIONS_SAVE_DELAY_MS, recommendedInstallation, refreshMemorySettings, refreshStatus,
  renderEngineStatus, renderOptions, scheduleStatusPoll, selectedFrequencyDictionary, send, setOptionsStatus,
  setSectionStatus, setStatus, sharingLinkedAddress, syncNavigationStatus, TARGET, UPDATE_TARGET,
  WORKER_TARGET, writeOptions
};

await start();
