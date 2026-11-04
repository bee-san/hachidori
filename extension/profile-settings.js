// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings → Advanced → Languages (docs/languages.md 5.3 and 16.3-16.5): your
// languages with Add and Remove, and the languages held without a profile
// with Erase; with two or more, Settings shows (the profile this page edits)
// with Use for lookups, Switch language automatically and the sidebar link
// that names the edited language. Also the All languages notes beside shared
// settings and the reset hints. settings.js loads this module once the page
// has a language registry and owns what a profile change does to the rest of
// the page.

import { describeErrorOrJson } from "./error-text.js";
import { customDictionaryDocumentFor, parseCustomDictionary, personalDictionaryIdentity } from "./custom-dictionary.js";
import { heldLanguages } from "./profile-state.js";

const { JAPANESE_PROFILE_ID, hasProfiles, hasDictionaryProfiles, profiles: optionProfiles } = globalThis.HDReaderOptions;

// Settings every language shares (section 16.4): fieldsets and sections whose
// settings are all shared get the note under their heading; single shared
// controls in fieldsets that mix scopes get it beside them.
const SHARED_GROUPS = [
  "#lookup > fieldset:first-of-type", "#cursor-exit-settings", "#search-page-settings",
  "#updates", "#keybinds", "#backup", "#sharing", "#memory-settings", "#search-history-settings", "#experimental-settings",
];
const SHARED_CONTROLS = ["opt-popup-width", "opt-popup-height", "opt-popup-scale", "opt-popup-toolbar",
  "opt-source-highlight", "opt-custom-popup-css", "opt-custom-popup-javascript", "opt-popup-nesting-depth",
  "opt-smaller-anki-cards", "opt-anki-url"];

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// A language's personal dictionary: its document's revision and entry count.
function personalEntries(records, language) {
  const document = customDictionaryDocumentFor(records.customDictionarySource, language);
  const readingRequired = personalDictionaryIdentity(language)?.readingRequired ?? true;
  return { revision: document.revision, count: parseCustomDictionary(document.text, { readingRequired }).entries.length };
}

function replyError(reply, fallback) {
  return new Error(reply?.error || fallback);
}

export function createProfileSettings({ document, element, send, setStatus, readEditedProfile, readActiveProfileId,
  readOptionsRecord, readDictionaryState, readSelection, readRecords, languageName, chooseEditedProfile,
  useEditedProfileForLookups, writeAutoSwitch, settleEdits, afterProfileChange, openLanguages }) {
  const registry = globalThis.HDLanguages;
  const originals = new Map();
  let busy = false;
  let removing = null;
  let held = [];
  // While linked, the packs the host has too (17.6); null otherwise.
  let hostLanguages = null;

  function create(tag, { className = "", text = "", ...attributes } = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  // The first card of Advanced, so the sidebar link and a search for a
  // language land on it. Only static markup; names and values are set below.
  const card = create("fieldset", { className: "lookup-group", id: "language-settings" });
  card.innerHTML = `<legend data-search-keywords="profiles add remove">Languages</legend>
    <p class="field-hint" id="language-settings-help">Each language has its own dictionaries and settings. Settings every language shares say All languages.</p>
    <ul class="language-list" id="settings-language-profiles"></ul>
    <ul class="language-list" id="settings-language-held-list" hidden></ul>
    <div class="setting-row" id="settings-language-add-row">
      <div class="setting-text">
        <label class="field-label" for="settings-language-add-select">Add a language</label>
        <p class="field-hint" id="settings-language-add-help"></p>
      </div>
      <div class="options-actions language-actions">
        <select id="settings-language-add-select" aria-describedby="settings-language-add-help"></select>
        <button type="button" class="ghost" aria-describedby="settings-language-add-help">Add</button>
      </div>
    </div>
    <output class="section-note custom-dictionary-status" id="settings-language-status" aria-live="polite"></output>`;
  element("advanced").querySelector(".options-feedback-slot").after(card);
  const intro = card.querySelector("#language-settings-help");
  const addSelect = card.querySelector("#settings-language-add-select");
  // No id, so search offers the row rather than a bare Add.
  const addButton = card.querySelector("#settings-language-add-row button");

  // The removal question, in the card only while it is asked, so search
  // never finds it.
  const panel = create("div", { className: "setting-row language-remove", id: "settings-language-remove" });
  panel.innerHTML = `<div class="setting-text">
      <p id="settings-language-remove-text"></p>
      <label class="check-row"><input id="settings-language-erase" type="checkbox" aria-describedby="settings-language-erase-help"><span id="settings-language-erase-label"></span></label>
      <p class="field-hint" id="settings-language-erase-help"></p>
    </div>
    <div class="options-actions">
      <button type="button" class="ghost danger" id="settings-language-remove-confirm"></button>
      <button type="button" class="ghost" id="settings-language-remove-cancel">Cancel</button>
    </div>`;
  const panelPart = id => panel.querySelector(`#${id}`);

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

  // "English (Deutsch)" in a menu, where a name cannot carry its own language.
  function optionLabel(code) {
    const { name, native } = descriptorName(code);
    return native ? `${name} (${native})` : name;
  }

  function profileList() {
    return optionProfiles(readOptionsRecord());
  }

  function activeName() {
    return languageName(profileList().find(profile => profile.id === readActiveProfileId())?.language ?? "ja");
  }

  function profileDictionaryCount(profileId) {
    const state = readDictionaryState();
    if (state === null) return 0;
    if (!hasDictionaryProfiles(state)) return profileId === JAPANESE_PROFILE_ID ? state.dictionaries?.length ?? 0 : 0;
    return state.profiles?.[profileId]?.dictionaries?.length ?? 0;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  // Replaces a select's options only when they change, and never while it is
  // being used, so a keyboard user's choice is not reset.
  function renderChoices(select, entries) {
    if (select === document.activeElement) return;
    const current = [...select.options].map(option => [option.value, option.textContent]);
    if (JSON.stringify(current) !== JSON.stringify(entries)) {
      const value = select.value;
      select.replaceChildren(...entries.map(([id, label]) => new Option(label, id)));
      if (entries.some(([id]) => id === value)) select.value = value;
    }
  }

  // With two or more languages (section 16.3): Settings shows with Use for
  // lookups, and Switch language automatically, which is this browser's own
  // choice and not an option. Built when they apply, so search finds them only
  // then.
  let edited = null;

  function createEditedRows() {
    const picker = create("div", { className: "setting-row", id: "settings-language-picker" });
    picker.innerHTML = `<div class="setting-text">
        <label class="field-label" for="settings-language-select">Settings shows</label>
        <p class="field-hint" id="settings-language-select-help"></p>
      </div>
      <div class="options-actions language-actions">
        <select id="settings-language-select" aria-describedby="settings-language-select-help"></select>
        <button type="button" class="ghost" id="settings-language-use" aria-describedby="settings-language-select-help">Use for lookups</button>
      </div>`;
    const select = picker.querySelector("select");
    const use = picker.querySelector("button");
    const row = create("label", { className: "lookup-enable", id: "language-auto-switch-row" });
    const input = create("input", { type: "checkbox", id: "language-auto-switch",
      "aria-describedby": "language-auto-switch-help" });
    row.append(create("span", { text: "Switch language automatically from the page's language" }), input);
    const help = create("p", { className: "field-hint", id: "language-auto-switch-help" });
    select.addEventListener("change", () => {
      const id = select.value;
      void run(async () => {
        const refused = await chooseEditedProfile(id);
        // The menu stays on the current language until the user settles its edits.
        if (refused !== null) {
          select.value = readEditedProfile().id;
          setStatus(refused, "error");
        } else setStatus("");
      });
    });
    use.addEventListener("click", () => {
      if (readActiveProfileId() === readEditedProfile().id) return;
      void run(async () => {
        await useEditedProfileForLookups();
        setStatus(`Lookups now use ${languageName(readEditedProfile().language)}.`, "ready");
      });
    });
    input.addEventListener("change", () => {
      const enabled = input.checked;
      void writeAutoSwitch(enabled).catch(error => {
        input.checked = !enabled;
        setStatus(`Could not change automatic switching: ${describeErrorOrJson(error)}`, "error", error);
      });
    });
    intro.after(picker, row, help);
    return { nodes: [picker, row, help], select, use, input, help, hint: picker.querySelector(".field-hint") };
  }

  function renderEdited(several) {
    if (!several) {
      for (const node of edited?.nodes ?? []) node.remove();
      edited = null;
      return;
    }
    edited ??= createEditedRows();
    const { select, use, input, help, hint } = edited;
    const editedProfile = readEditedProfile();
    renderChoices(select, profileList().map(profile => [profile.id, optionLabel(profile.language)]));
    if (select.value !== editedProfile.id && select !== document.activeElement) select.value = editedProfile.id;
    select.disabled = busy;
    const active = readActiveProfileId() === editedProfile.id;
    // Enabled while pressed, as the theme store's Current theme is, so it
    // keeps focus after a click.
    use.disabled = busy;
    use.setAttribute("aria-pressed", String(active));
    setText(use, active ? "Used for lookups" : "Use for lookups");
    setText(hint, "The language whose settings and dictionaries this page shows and changes."
      + ` Lookups in this browser use ${activeName()}.`);
    if (input !== document.activeElement) input.checked = readSelection().autoSwitch === true;
    setText(help, "Each lookup uses the language the page or the hovered element declares, when it is one of yours;"
      + ` otherwise ${activeName()}. This setting applies to this browser only.`);
  }

  // The sidebar names the edited language once there is a choice (section
  // 16.3): one link, styled as Resume setup, to Settings shows.
  let link = null;

  function renderLink(several) {
    if (!several) {
      link?.remove();
      link = null;
      return;
    }
    if (link === null) {
      link = create("a", { className: "settings-language-link", id: "settings-language-link", href: "#advanced" });
      link.addEventListener("click", event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openLanguages();
      });
      element("setup-resume").after(link);
    }
    setText(link, `Settings shows ${languageName(readEditedProfile().language)}`);
  }

  // Rebuilds a list only when its rows change, and gives focus that was on a
  // row's button to the same row's button after a rebuild. Buttons are
  // disabled in place while a change runs, so focus stays where it is.
  function renderRows(container, rows) {
    const signature = JSON.stringify(rows.map(row => row.key));
    if (container.dataset.rows !== signature) {
      const focused = container.contains(document.activeElement) ? document.activeElement.closest("li")?.dataset.key : null;
      container.dataset.rows = signature;
      container.replaceChildren(...rows.map(row => {
        const item = row.build();
        item.dataset.key = row.key;
        return item;
      }));
      if (focused) rowButton(container, focused)?.focus();
    }
    for (const button of container.querySelectorAll("button")) button.disabled = busy;
  }

  function rowButton(container, key) {
    return [...container.children].find(item => item.dataset.key === key)?.querySelector("button") ?? null;
  }

  function renderProfiles() {
    const list = profileList();
    // The last language cannot be removed (section 16.5).
    const removable = list.length > 1;
    renderRows(card.querySelector("#settings-language-profiles"), list.map(profile => {
      const count = countLabel(profileDictionaryCount(profile.id), "dictionary", "dictionaries");
      return { key: JSON.stringify([profile.id, profile.language, count, removable]), build() {
        const item = create("li", { className: "language-row", "data-profile-id": profile.id });
        const label = create("span", { className: "language-label" });
        label.append(...nameNodes(profile.language), " ", create("span", { className: "field-hint", text: count }));
        item.append(label);
        if (removable) {
          const remove = create("button", { className: "ghost danger", type: "button", text: "Remove",
            "aria-label": `Remove ${languageName(profile.language)}` });
          remove.addEventListener("click", () => openRemoval(profile));
          item.append(remove);
        }
        return item;
      } };
    }));
  }

  function renderAvailable() {
    const used = new Set(profileList().map(profile => profile.language));
    // By English name, as a reader looks for one among many.
    const codes = (Array.isArray(registry.codes) ? registry.codes : [])
      .filter(code => !used.has(code) && (hostLanguages === null || hostLanguages.has(code)))
      .sort((a, b) => languageName(a).localeCompare(languageName(b), "en"));
    renderChoices(addSelect, [["", "Choose a language"], ...codes.map(code => [code, optionLabel(code)])]);
    addSelect.disabled = busy;
    addButton.disabled = busy;
    addSelect.hidden = codes.length === 0;
    addButton.hidden = codes.length === 0;
    setText(card.querySelector("#settings-language-add-help"), codes.length === 0
      ? "This Hachidori has no other language yet."
      : `A new language starts with a copy of your ${languageName(readEditedProfile().language)} settings and no`
        + ` dictionaries, and Settings then shows it. Lookups stay in ${activeName()} until you choose Use for lookups.`);
  }

  // Languages the records hold without a profile (section 2), each with Erase.
  function renderHeld() {
    const container = card.querySelector("#settings-language-held-list");
    renderRows(container, held.map(({ language, entries }) => ({ key: JSON.stringify([language, entries]), build() {
      const item = create("li", { className: "language-row", "data-language": language });
      const label = create("span", { className: "language-label" });
      label.append(...nameNodes(language), " ", create("span", { className: "field-hint",
        text: "Removed, with its personal dictionary, lookup counts and marked words kept" }));
      const erase = create("button", { className: "ghost danger", type: "button", text: "Erase",
        "aria-label": `Erase ${languageName(language)}` });
      erase.addEventListener("click", () => { void eraseHeld(language, entries); });
      item.append(label, erase);
      return item;
    } })));
    container.hidden = held.length === 0;
  }

  async function refreshHeld() {
    const records = await readRecords();
    const languages = heldLanguages({ options: records.options, state: records.dictionaryState,
      document: records.customDictionarySource, lookupStats: records.lookupStats,
      wordStatusOverrides: records.wordStatusOverrides });
    const profiled = new Set(profileList().map(profile => profile.language));
    held = [...languages].filter(code => !profiled.has(code)).sort((a, b) => a.localeCompare(b))
      .map(language => ({ language, entries: personalEntries(records, language) }));
    renderHeld();
  }

  function openRemoval(profile) {
    removing = { ...profile, document: null };
    const name = languageName(profile.language);
    panelPart("settings-language-remove-text").textContent = `Remove ${name}? Its settings and its`
      + " list of dictionaries are deleted. Its dictionaries stay in your library, and its personal dictionary,"
      + " lookup counts and marked words are kept.";
    panelPart("settings-language-erase").checked = false;
    panelPart("settings-language-erase-label").textContent =
      `Also erase my ${name} personal dictionary, lookup counts and marked words`;
    panelPart("settings-language-remove-confirm").textContent = `Remove ${name}`;
    const help = panelPart("settings-language-erase-help");
    help.textContent = "";
    card.querySelector("#settings-language-profiles").after(panel);
    // Cancel first, so Enter pressed twice does not remove a language.
    panelPart("settings-language-remove-cancel").focus();
    // An erase is refused when the personal dictionary changed after this
    // read, so it never deletes entries the confirmation did not count
    // (docs/languages.md 5.2).
    const opened = removing;
    void readRecords().then(records => {
      if (removing !== opened) return;
      opened.document = personalEntries(records, profile.language);
      help.textContent = `Its personal dictionary has ${countLabel(opened.document.count, "entry", "entries")}.`;
    }).catch(error => setStatus(describeErrorOrJson(error), "error", error));
  }

  // Focus that was in the question goes back to the Remove button that asked
  // it, or to Add a language once that row is gone.
  function closeRemoval() {
    const focused = panel.contains(document.activeElement);
    const id = removing?.id;
    removing = null;
    panel.remove();
    if (!focused) return;
    const row = [...card.querySelector("#settings-language-profiles").children].find(item => item.dataset.profileId === id);
    (row?.querySelector("button") ?? addSelect).focus();
  }

  // Runs one change at a time. A control disabled while busy gets its focus
  // back; `action` may name where focus goes instead, when its control is gone.
  async function run(action) {
    if (busy) return;
    const trigger = document.activeElement;
    let next = null;
    busy = true;
    render();
    try {
      next = await action();
    } catch (error) {
      setStatus(describeErrorOrJson(error), "error", error);
    } finally {
      busy = false;
      render();
      const focused = document.activeElement;
      const lost = focused === null || focused === document.body || !focused.isConnected;
      if (next?.isConnected && (lost || focused === trigger)) next.focus();
      else if (lost && trigger?.isConnected && !trigger.disabled) trigger.focus();
    }
  }

  // Adding copies the edited profile's settings, including its unsaved edits,
  // which are saved first; the page then edits the new profile, while lookups
  // stay in the active one (sections 6.3 and 16.3).
  function addLanguage(code) {
    return run(async () => {
      const name = languageName(code);
      await settleEdits();
      setStatus(`Adding ${name}…`, "working");
      // Lookups stay in the active profile (docs/languages.md 6.3). Without a
      // stored choice the active profile is the Japanese one (4.4), so adding
      // Japanese to an installation that reads another language would move
      // its lookups: the choice is stored first.
      if (hasProfiles(readOptionsRecord()) && readSelection().activeProfileId === null) {
        const kept = await send("hd_language_selection_write", { baseRevision: readSelection().revision,
          activeProfileId: readActiveProfileId() }, "hoshidicts-worker");
        if (!kept.ok && kept.conflict !== true) throw replyError(kept, `${name} could not be added`);
      }
      const reply = await send("hd_profile_add", { language: code, copyFrom: readEditedProfile().id });
      if (!reply.ok) throw replyError(reply, `${name} could not be added`);
      addSelect.value = "";
      await afterProfileChange();
      // Version 1 gives a language's profile the language's code as its id.
      const refused = await chooseEditedProfile(code);
      setStatus(refused === null ? `Added ${name}. Settings now shows ${name}.` : `Added ${name}. ${refused}`, "ready");
      // Use for lookups is the next step; while Settings stays on the
      // previous language, choosing the new one is.
      return refused === null ? element("settings-language-use") : element("settings-language-select");
    });
  }

  function remove() {
    const profile = removing;
    if (profile === null) return Promise.resolve();
    const erase = panelPart("settings-language-erase").checked;
    if (erase && profile.document === null) {
      setStatus("Reading the personal dictionary… Try again in a moment.", "working");
      return Promise.resolve();
    }
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
      setStatus(`Removing ${name}…`, "working");
      const reply = await send("hd_profile_remove", { profileId: profile.id,
        ...(erase ? { erase: true, baseDocumentRevision: profile.document.revision } : {}) });
      if (!reply.ok) throw replyError(reply, `${name} could not be removed`);
      closeRemoval();
      await afterProfileChange();
      await refreshHeld();
      setStatus(erase ? `Removed ${name} and erased its personal dictionary, lookup counts and marked words.`
        : `Removed ${name}. Its dictionaries, personal dictionary, lookup counts and marked words are kept.`, "ready");
      return addSelect.hidden ? null : addSelect;
    });
  }

  // Erasing a language held without a profile (section 16.3).
  function eraseHeld(language, entries) {
    const name = languageName(language);
    const what = `${countLabel(entries.count, "entry", "entries")} in its personal dictionary`;
    if (!document.defaultView.confirm(`Erase ${name}? This deletes the ${what}, its lookup counts and its marked`
      + " words from this browser. Existing backups still hold them.")) return Promise.resolve();
    return run(async () => {
      setStatus(`Erasing ${name}…`, "working");
      const reply = await send("hd_profile_remove", { language, erase: true, baseDocumentRevision: entries.revision });
      if (!reply.ok) throw replyError(reply, `${name} could not be erased`);
      await afterProfileChange();
      await refreshHeld();
      setStatus(`Erased ${name}.`, "ready");
      return addSelect.hidden ? null : addSelect;
    });
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
    for (const selector of SHARED_GROUPS) addGroupScopeNote(document.querySelector(selector));
    for (const id of SHARED_CONTROLS) addControlScopeNote(id);
  }

  function addGroupScopeNote(group) {
    if (!group) return;
    if (group.localName === "fieldset") group.querySelector(":scope > legend").after(scopeNote("p"));
    else group.querySelector(".card-head").append(scopeNote("p"));
  }

  function addControlScopeNote(id) {
    const control = element(id);
    const label = control?.closest("label.field") ?? null;
    // A control with a hint gets the note as the hint's last line, so a
    // field keeps its grid and a switch keeps its description under it.
    const hint = label?.querySelector(":scope > .field-hint")
      ?? element(control?.getAttribute("aria-describedby")?.split(" ")[0] ?? "");
    if (hint) {
      // The space keeps Search settings' text of the hint apart from the note.
      hint.append(" ", create("span", { className: "scope-note", text: "All languages", "data-scope-note": "" }));
      return;
    }
    if (label !== null) {
      label.append(scopeNote("span"));
      return;
    }
    // A switch row or a stand-alone label: the note follows it.
    const row = control?.closest("label") ?? document.querySelector(`label[for="${id}"]`);
    row?.after(scopeNote("p"));
  }

  // Reading → Search page's hint names what the Clipboard monitor searches:
  // with profiles, text in the language used for lookups (section 8.2). Only
  // the words change, in the hint's own text, so its links stay.
  const JAPANESE_CLIPBOARD = "to search Japanese text as soon as";
  const PROFILE_CLIPBOARD = "to search text in the language used for lookups as soon as";
  function renderClipboardHint(withProfiles) {
    const [from, to] = withProfiles ? [JAPANESE_CLIPBOARD, PROFILE_CLIPBOARD] : [PROFILE_CLIPBOARD, JAPANESE_CLIPBOARD];
    const hint = element("search-page-help");
    const node = hint && [...hint.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.data.includes(from));
    if (node) node.data = node.data.replace(from, to);
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
    const withProfiles = hasProfiles(readOptionsRecord());
    const several = withProfiles && profileList().length > 1;
    renderEdited(several);
    renderLink(several);
    renderProfiles();
    renderAvailable();
    renderHeld();
    if (removing !== null && !profileList().some(profile => profile.id === removing.id)) closeRemoval();
    panelPart("settings-language-remove-confirm").disabled = busy;
    panelPart("settings-language-remove-cancel").disabled = busy;
    renderScopeNotes(withProfiles);
    renderResetHints(withProfiles);
    renderClipboardHint(withProfiles);
  }

  addButton.addEventListener("click", () => {
    if (addSelect.value !== "") {
      void addLanguage(addSelect.value);
      return;
    }
    setStatus("Choose a language to add.", "error");
    addSelect.focus();
  });
  panelPart("settings-language-remove-confirm").addEventListener("click", () => { void remove(); });
  panelPart("settings-language-remove-cancel").addEventListener("click", closeRemoval);

  async function refreshHostLanguages() {
    let next = null;
    try {
      const client = (await send("hd_sharing_status", {}, "hachidori-sharing"))?.sharing?.client;
      const codes = client?.linked === true ? client.languageProfiles?.hostLanguages : null;
      next = Array.isArray(codes) ? new Set(codes) : null;
    } catch {
      // Without the status every pack stays listed; the host refuses one it lacks.
    }
    const key = codes => (codes === null ? null : [...codes].sort((a, b) => a.localeCompare(b)).join(" "));
    if (key(next) === key(hostLanguages)) return;
    hostLanguages = next;
    renderAvailable();
  }

  const shown = () => card.closest("section")?.hidden === false;

  return {
    render,
    // A message about the edited profile, such as its removal elsewhere.
    announce(message) { setStatus(message, "error"); },
    // Advanced is shown: the held languages and a linked host's packs are
    // read again.
    refresh() {
      void refreshHeld().catch(error => setStatus(describeErrorOrJson(error), "error", error));
      void refreshHostLanguages();
    },
    // Records changed while Advanced is shown: held languages may have too.
    recordsChanged() {
      if (shown()) void refreshHeld().catch(() => {});
    },
  };
}
