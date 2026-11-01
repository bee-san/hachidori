// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings' Language menu (docs/languages.md 5.3 and 16.3-16.5): the menu that
// chooses the profile this page edits, Use for lookups, the Add or remove
// languages dialog with the languages held without a profile, the All
// languages notes beside shared settings and Reading → Scanning's automatic
// switch. settings.js loads this module once the page has a language
// registry and owns what a profile change does to the rest of the page.

import { describeErrorOrJson } from "./error-text.js";
import { setStatusOutput } from "./settings-dom.js";
import { customDictionaryDocumentFor, parseCustomDictionary, personalDictionaryIdentity } from "./custom-dictionary.js";
import { heldLanguages } from "./profile-state.js";

const { JAPANESE_PROFILE_ID, hasProfiles, hasDictionaryProfiles, profiles: optionProfiles } = globalThis.HDReaderOptions;

// Settings every language shares (section 16.4): fieldsets and sections whose
// settings are all shared get the note under their heading; single shared
// controls in fieldsets that mix scopes get it beside them.
const SHARED_GROUPS = [
  "#lookup > fieldset:first-of-type", "#cursor-exit-settings", "#search-page-settings",
  "#updates", "#keybinds", "#backup", "#sharing", "#advanced",
];
const SHARED_CONTROLS = ["opt-popup-width", "opt-popup-height", "opt-popup-scale", "opt-popup-toolbar",
  "opt-source-highlight", "opt-custom-popup-css", "opt-custom-popup-javascript", "opt-popup-nesting-depth",
  "opt-smaller-anki-cards", "opt-anki-url"];

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function createProfileSettings({ document, element, send, readEditedProfile, readActiveProfileId,
  readOptionsRecord, readDictionaryState, readSelection, readRecords, languageName, chooseEditedProfile,
  useEditedProfileForLookups, writeAutoSwitch, settleEdits, afterProfileChange }) {
  const registry = globalThis.HDLanguages;
  const originals = new Map();
  let busy = false;
  let removing = null;
  let held = [];

  function create(tag, { className = "", text = "", ...attributes } = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  // The menu sits at the top of the sidebar, above the search field; it is
  // not a navigation link.
  const menu = create("div", { className: "settings-language", id: "settings-language" });
  const picker = create("label", { className: "settings-language-picker", for: "settings-language-select" });
  picker.append(create("span", { className: "field-label", text: "Language" }));
  const select = create("select", { id: "settings-language-select" });
  picker.append(select);
  const actions = create("div", { className: "settings-language-actions" });
  const use = create("button", { className: "ghost", id: "settings-language-use", type: "button", text: "Use for lookups" });
  use.hidden = true;
  const manage = create("button", { className: "ghost", id: "settings-language-manage", type: "button",
    text: "Add or remove languages", "aria-haspopup": "dialog" });
  actions.append(use, manage);
  const status = create("output", { className: "settings-language-status", id: "settings-language-status",
    "aria-live": "polite" });
  menu.append(picker, actions, status);
  document.querySelector(".settings-sidebar .settings-search").before(menu);

  const dialog = create("dialog", { className: "language-dialog", id: "settings-language-dialog",
    "aria-labelledby": "settings-language-dialog-heading" });
  dialog.innerHTML = `<form method="dialog">
      <h2 id="settings-language-dialog-heading">Languages</h2>
      <p class="field-hint">Each language has its own dictionaries and settings. Settings every language shares say All languages.</p>
      <h3>Your languages</h3>
      <ul class="language-list" id="settings-language-profiles"></ul>
      <div class="language-remove" id="settings-language-remove" hidden>
        <p id="settings-language-remove-text"></p>
        <label class="check-row"><input id="settings-language-erase" type="checkbox"><span id="settings-language-erase-label"></span></label>
        <div class="language-dialog-buttons">
          <button type="button" class="ghost danger" id="settings-language-remove-confirm"></button>
          <button type="button" class="ghost" id="settings-language-remove-cancel">Cancel</button>
        </div>
      </div>
      <h3>Add a language</h3>
      <ul class="language-list" id="settings-language-available"></ul>
      <p class="field-hint" id="settings-language-available-empty" hidden>This Hachidori has no other language yet.</p>
      <div id="settings-language-held" hidden>
        <h3>Removed languages</h3>
        <ul class="language-list" id="settings-language-held-list"></ul>
      </div>
      <output class="settings-language-status" id="settings-language-dialog-status" aria-live="polite"></output>
      <div class="language-dialog-buttons"><button type="button" class="ghost" id="settings-language-use-added" hidden>Use for lookups</button></div>
      <div class="language-dialog-buttons"><button class="ghost" value="close">Close</button></div>
    </form>`;
  document.body.append(dialog);
  const dialogStatus = dialog.querySelector("#settings-language-dialog-status");
  const useAdded = dialog.querySelector("#settings-language-use-added");

  function descriptorName(code) {
    const descriptor = registry.get(code);
    const name = languageName(code);
    const native = typeof descriptor?.nativeName === "string" && descriptor.nativeName !== name ? descriptor.nativeName : "";
    return { name, native, direction: descriptor?.direction === "rtl" ? "rtl" : "ltr", bcp47: descriptor?.bcp47 ?? code };
  }

  // A language's name, and its own name in its own language when that differs.
  function nameNodes(code) {
    const { name, native, direction, bcp47 } = descriptorName(code);
    const nodes = [create("strong", { text: name })];
    if (native) nodes.push(" ", create("span", { className: "language-native", text: native, lang: bcp47, dir: direction }));
    return nodes;
  }

  function profileList() {
    return optionProfiles(readOptionsRecord());
  }

  function profileDictionaryCount(profileId) {
    const state = readDictionaryState();
    if (state === null) return 0;
    if (!hasDictionaryProfiles(state)) return profileId === JAPANESE_PROFILE_ID ? state.dictionaries?.length ?? 0 : 0;
    return state.profiles?.[profileId]?.dictionaries?.length ?? 0;
  }

  function setStatus(output, message, tone = "", error = null) {
    setStatusOutput(output, message, tone, error);
  }

  function renderMenu() {
    const list = profileList();
    const edited = readEditedProfile();
    const wanted = list.map(profile => [profile.id, descriptorName(profile.language)]);
    const current = [...select.options].map(option => [option.value, option.textContent]);
    const labels = wanted.map(([id, { name, native }]) => [id, native ? `${name} (${native})` : name]);
    if (JSON.stringify(current) !== JSON.stringify(labels) && select !== document.activeElement) {
      select.replaceChildren(...labels.map(([id, label]) => new Option(label, id)));
    }
    if (select.value !== edited.id && select !== document.activeElement) select.value = edited.id;
    // Use for lookups appears once there is a choice to make (section 16.3).
    const several = list.length > 1;
    use.hidden = !several;
    const active = readActiveProfileId() === edited.id;
    use.disabled = busy || active;
    use.textContent = active ? "Used for lookups" : "Use for lookups";
    select.disabled = busy;
    manage.disabled = busy;
  }

  function renderProfiles() {
    const list = profileList();
    const container = dialog.querySelector("#settings-language-profiles");
    container.replaceChildren(...list.map(profile => {
      const item = create("li", { className: "language-row" });
      const label = create("span", { className: "language-label" });
      label.append(...nameNodes(profile.language), " ",
        create("span", { className: "field-hint", text: countLabel(profileDictionaryCount(profile.id), "dictionary", "dictionaries") }));
      const remove = create("button", { className: "ghost danger", type: "button", text: "Remove",
        "aria-label": `Remove ${languageName(profile.language)}` });
      // The last language cannot be removed (section 16.5).
      remove.disabled = busy || list.length === 1;
      remove.addEventListener("click", () => openRemoval(profile));
      item.append(label, remove);
      return item;
    }));
  }

  function renderAvailable() {
    const used = new Set(profileList().map(profile => profile.language));
    const codes = (Array.isArray(registry.codes) ? registry.codes : []).filter(code => !used.has(code));
    const container = dialog.querySelector("#settings-language-available");
    container.replaceChildren(...codes.map(code => {
      const item = create("li", { className: "language-row" });
      const label = create("span", { className: "language-label" });
      label.append(...nameNodes(code));
      const add = create("button", { className: "ghost", type: "button", text: "Add",
        "aria-label": `Add ${languageName(code)}` });
      add.disabled = busy;
      add.addEventListener("click", () => { void addLanguage(code); });
      item.append(label, add);
      return item;
    }));
    dialog.querySelector("#settings-language-available-empty").hidden = codes.length > 0;
  }

  // Languages the records hold without a profile (section 2), each with Erase.
  function renderHeld() {
    const container = dialog.querySelector("#settings-language-held-list");
    container.replaceChildren(...held.map(({ language, entries }) => {
      const item = create("li", { className: "language-row" });
      const label = create("span", { className: "language-label" });
      label.append(`${languageName(language)}: personal dictionary, lookup counts and marks are kept`);
      const erase = create("button", { className: "ghost danger", type: "button", text: "Erase",
        "aria-label": `Erase ${languageName(language)}` });
      erase.disabled = busy;
      erase.addEventListener("click", () => { void eraseHeld(language, entries); });
      item.append(label, erase);
      return item;
    }));
    dialog.querySelector("#settings-language-held").hidden = held.length === 0;
  }

  function personalEntries(records, language) {
    const document_ = customDictionaryDocumentFor(records.customDictionarySource, language);
    const readingRequired = personalDictionaryIdentity(language)?.readingRequired ?? true;
    return { revision: document_.revision, count: parseCustomDictionary(document_.text, { readingRequired }).entries.length };
  }

  async function refreshHeld() {
    const records = await readRecords();
    const languages = heldLanguages({ options: records.options, state: records.dictionaryState,
      document: records.customDictionarySource, lookupStats: records.lookupStats,
      wordStatusOverrides: records.wordStatusOverrides });
    const profiled = new Set(profileList().map(profile => profile.language));
    held = [...languages].filter(code => !profiled.has(code)).sort()
      .map(language => ({ language, entries: personalEntries(records, language) }));
    renderHeld();
  }

  function renderDialog() {
    renderProfiles();
    renderAvailable();
    renderHeld();
    if (removing !== null && !profileList().some(profile => profile.id === removing.id)) closeRemoval();
  }

  function openRemoval(profile) {
    removing = profile;
    const name = languageName(profile.language);
    dialog.querySelector("#settings-language-remove-text").textContent = `Remove ${name}? Its settings and its`
      + " list of dictionaries are deleted. Its dictionaries stay in your library, and its personal dictionary,"
      + " lookup counts and marked words are kept.";
    dialog.querySelector("#settings-language-erase").checked = false;
    dialog.querySelector("#settings-language-erase-label").textContent =
      `Also erase my ${name} personal dictionary, lookup counts and marked words`;
    const confirm = dialog.querySelector("#settings-language-remove-confirm");
    confirm.textContent = `Remove ${name}`;
    dialog.querySelector("#settings-language-remove").hidden = false;
    confirm.focus();
  }

  function closeRemoval() {
    removing = null;
    dialog.querySelector("#settings-language-remove").hidden = true;
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    useAdded.hidden = true;
    render();
    try {
      await action();
    } catch (error) {
      setStatus(dialog.open ? dialogStatus : status, describeErrorOrJson(error), "error", error);
    } finally {
      busy = false;
      render();
    }
  }

  function replyError(reply, fallback) {
    return new Error(reply?.error || fallback);
  }

  // Adding copies the edited profile's settings, including its unsaved edits,
  // which are saved first; the page then edits the new profile, while lookups
  // stay in the active one (sections 6.3 and 16.3).
  function addLanguage(code) {
    return run(async () => {
      const name = languageName(code);
      await settleEdits();
      setStatus(dialogStatus, `Adding ${name}…`, "working");
      const reply = await send("hd_profile_add", { language: code, copyFrom: readEditedProfile().id });
      if (!reply.ok) throw replyError(reply, `${name} could not be added`);
      await afterProfileChange();
      // Version 1 gives a language's profile the language's code as its id.
      const refused = await chooseEditedProfile(code);
      setStatus(dialogStatus, refused === null ? `Added ${name}. Settings now shows ${name}.`
        : `Added ${name}. ${refused}`, "ready");
      useAdded.textContent = `Use ${name} for lookups`;
      useAdded.hidden = readActiveProfileId() === code;
      useAdded.dataset.profileId = code;
    });
  }

  function remove() {
    const profile = removing;
    if (profile === null) return Promise.resolve();
    const erase = dialog.querySelector("#settings-language-erase").checked;
    return run(async () => {
      const name = languageName(profile.language);
      // Settings leaves a language before it removes it, so its drafts are
      // saved or discarded first; it then shows the language that will be
      // used for lookups (section 16.5).
      if (readEditedProfile().id === profile.id) {
        const others = profileList().filter(candidate => candidate.id !== profile.id);
        const active = readActiveProfileId();
        const next = others.find(candidate => candidate.id === active)
          ?? others.find(candidate => candidate.id === JAPANESE_PROFILE_ID) ?? others[0];
        const refused = await chooseEditedProfile(next.id);
        if (refused !== null) throw new Error(refused);
      }
      setStatus(dialogStatus, `Removing ${name}…`, "working");
      const reply = await send("hd_profile_remove", { profileId: profile.id, ...(erase ? { erase: true } : {}) });
      if (!reply.ok) throw replyError(reply, `${name} could not be removed`);
      closeRemoval();
      await afterProfileChange();
      await refreshHeld();
      setStatus(dialogStatus, erase ? `Removed ${name} and erased its personal dictionary, lookup counts and marked words.`
        : `Removed ${name}. Its dictionaries, personal dictionary, lookup counts and marked words are kept.`, "ready");
    });
  }

  // Erasing a language held without a profile (section 16.3).
  function eraseHeld(language, entries) {
    const name = languageName(language);
    const what = `${countLabel(entries.count, "entry", "entries")} in its personal dictionary`;
    if (!document.defaultView.confirm(`Erase ${name}? This deletes the ${what}, its lookup counts and its marked`
      + " words from this browser. Existing backups still hold them.")) return Promise.resolve();
    return run(async () => {
      setStatus(dialogStatus, `Erasing ${name}…`, "working");
      const reply = await send("hd_profile_remove", { language, erase: true });
      if (!reply.ok) throw replyError(reply, `${name} could not be erased`);
      await afterProfileChange();
      await refreshHeld();
      setStatus(dialogStatus, `Erased ${name}.`, "ready");
    });
  }

  // Reading → Scanning → Switch language automatically, with two or more
  // languages (section 16.3). Not an option: this browser's own choice.
  function renderAutoSwitch(several) {
    let row = element("language-auto-switch-row");
    if (!several) {
      row?.remove();
      element("language-auto-switch-help")?.remove();
      return;
    }
    if (row === null) {
      row = create("label", { className: "lookup-enable", id: "language-auto-switch-row" });
      const input = create("input", { type: "checkbox", id: "language-auto-switch",
        "aria-describedby": "language-auto-switch-help" });
      row.append(create("span", { text: "Switch language automatically from the page's language" }), input);
      const help = create("p", { className: "field-hint", id: "language-auto-switch-help" });
      element("opt-japanese-only").closest("fieldset").querySelector(".fields").after(row, help);
      input.addEventListener("change", () => {
        const enabled = input.checked;
        void writeAutoSwitch(enabled).catch(error => {
          input.checked = !enabled;
          setStatus(status, `Could not change automatic switching: ${describeErrorOrJson(error)}`, "error", error);
        });
      });
    }
    const input = element("language-auto-switch");
    if (input !== document.activeElement) input.checked = readSelection().autoSwitch === true;
    const help = `Each lookup uses the language the page or the hovered element declares, when it is one of yours;`
      + ` otherwise ${languageName(profileList().find(profile => profile.id === readActiveProfileId())?.language ?? "ja")}.`
      + " This browser only.";
    if (element("language-auto-switch-help").textContent !== help) element("language-auto-switch-help").textContent = help;
  }

  function scopeNote(tag) {
    return create(tag, { className: "field-hint scope-note", text: "All languages", "data-scope-note": "" });
  }

  // Shared settings say so once the records have profiles (section 16.4).
  function renderScopeNotes(withProfiles) {
    const existing = document.querySelectorAll("[data-scope-note]");
    if (!withProfiles) {
      for (const note of existing) note.remove();
      return;
    }
    if (existing.length > 0) return;
    for (const selector of SHARED_GROUPS) {
      const group = document.querySelector(selector);
      if (!group) continue;
      const heading = group.localName === "fieldset" ? group.querySelector(":scope > legend")
        : group.querySelector(".card-head");
      if (group.localName === "fieldset") heading.after(scopeNote("p"));
      else heading.append(scopeNote("p"));
    }
    for (const id of SHARED_CONTROLS) {
      const control = element(id);
      const label = control?.closest("label.field") ?? null;
      if (label !== null) {
        label.append(scopeNote("span"));
        continue;
      }
      // A switch row or a stand-alone label: the note follows it.
      const row = control?.closest("label") ?? document.querySelector(`label[for="${id}"]`);
      row?.after(scopeNote("p"));
    }
  }

  // Resets that reach every language say so (section 16.4).
  function renderResetHints(withProfiles) {
    const hints = {
      "reset-design-help": withProfiles
        ? `Resets every Design setting of ${languageName(readEditedProfile().language)}, including ones this theme hides,`
          + " and switches it back to the Default theme. It also resets the popup size, scale, toolbar position,"
          + " source highlighting and Custom CSS and JavaScript for every language. Reading and your library stay unchanged."
        : null,
      "lookup-counts-reset-help": withProfiles
        ? "Every word in every language starts again from zero; your next lookup of it counts as 1. Dictionaries,"
          + " settings and Anki notes are not changed. Exported backups and earlier automatic backups keep the previous counts."
        : null,
    };
    for (const [id, text] of Object.entries(hints)) {
      const hint = element(id);
      if (!originals.has(id)) originals.set(id, hint.textContent);
      const wanted = text ?? originals.get(id);
      if (hint.textContent !== wanted) hint.textContent = wanted;
    }
  }

  function render() {
    const record = readOptionsRecord();
    const withProfiles = hasProfiles(record);
    renderMenu();
    renderAutoSwitch(withProfiles && profileList().length > 1);
    renderScopeNotes(withProfiles);
    renderResetHints(withProfiles);
    if (dialog.open) renderDialog();
  }

  select.addEventListener("change", () => {
    const id = select.value;
    void run(async () => {
      const refused = await chooseEditedProfile(id);
      // The menu stays on the current language until the user settles its edits.
      if (refused !== null) {
        select.value = readEditedProfile().id;
        setStatus(status, refused, "error");
      } else setStatus(status, "");
    });
  });
  use.addEventListener("click", () => {
    void run(async () => {
      await useEditedProfileForLookups();
      setStatus(status, `Lookups now use ${languageName(readEditedProfile().language)}.`, "ready");
    });
  });
  useAdded.addEventListener("click", () => {
    void run(async () => {
      const refused = await chooseEditedProfile(useAdded.dataset.profileId);
      if (refused !== null) throw new Error(refused);
      await useEditedProfileForLookups();
      useAdded.hidden = true;
      setStatus(dialogStatus, `Lookups now use ${languageName(readEditedProfile().language)}.`, "ready");
    });
  });
  manage.addEventListener("click", () => {
    setStatus(dialogStatus, "");
    useAdded.hidden = true;
    closeRemoval();
    renderDialog();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    void refreshHeld().catch(error => setStatus(dialogStatus, describeErrorOrJson(error), "error", error));
  });
  dialog.querySelector("#settings-language-remove-confirm").addEventListener("click", () => { void remove(); });
  dialog.querySelector("#settings-language-remove-cancel").addEventListener("click", closeRemoval);

  return {
    render,
    // A message about the edited profile, such as its removal elsewhere.
    announce(message) { setStatus(status, message, "error"); },
    // Records changed while the dialog is open: held languages may have too.
    recordsChanged() {
      if (dialog.open) void refreshHeld().catch(() => {});
    },
  };
}
