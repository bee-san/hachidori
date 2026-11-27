// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings → Profiles (docs/profiles.md 6), which Advanced → Experimental
// features → Profiles reveals: your profiles, each with a name, the one
// lookups use by default, the one Settings shows, Copy and Remove; then the
// rules that switch profiles automatically by website, held key or popup
// level. settings.js loads this module once the switch is on and owns what a
// profile change does to the rest of the page.

import { describeErrorOrJson } from "./error-text.js";
import { createProfileRules } from "./profile-rules-settings.js";

const { JAPANESE_PROFILE_ID, hasProfiles, hasDictionaryProfiles, languagesEnabled, profileUsable,
  profiles: optionProfiles } = globalThis.HDReaderOptions;

const RULES_CARD = {
  id: "profile-rules",
  legend: "Switch profiles automatically",
  help: "In this browser, a lookup uses the profile of the first rule whose conditions all match, such as your video"
    + " profile on youtube.com or another profile while Alt is held. Website domains match their subdomains too, Key"
    + " held is checked as each word is scanned, and popup level 0 is the page, 1 the first popup. When no rule"
    + " matches, lookups use the default profile.",
  noun: "Profile",
  failure: "profile rules",
};

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// A new profile's id: never a language code, which a language's first
// profile has (docs/profiles.md 4).
function newProfileId() {
  return `p-${crypto.randomUUID()}`;
}

export function createProfileListSettings({ document, element, send, setStatus, languageName, readOptionsRecord,
  readDictionaryState, readSelection, readEditedProfile, readActiveProfileId, chooseEditedProfile, setDefaultProfile,
  renameProfile, writeRules, settleEdits, afterProfileChange }) {
  let busy = false;
  let removing = null;

  function create(tag, { className = "", text = "", ...attributes } = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  const section = element("profiles");
  const card = create("fieldset", { className: "lookup-group", id: "profile-list-settings" });
  card.innerHTML = `<legend data-search-keywords="profile name default copy duplicate remove edit">Your profiles</legend>
    <p class="field-hint" id="profile-list-help"></p>
    <ul class="language-list profile-list" id="profile-list"></ul>
    <output class="section-note custom-dictionary-status" id="profile-list-status" aria-live="polite"></output>`;
  section.querySelector(".options-feedback-slot").after(card);
  const list = card.querySelector("#profile-list");
  const help = card.querySelector("#profile-list-help");

  // The removal question, in the card only while it is asked.
  const panel = create("div", { className: "setting-row", id: "profile-remove" });
  panel.innerHTML = `<p class="setting-text" id="profile-remove-text"></p>
    <div class="options-actions">
      <button type="button" class="ghost danger" id="profile-remove-confirm" aria-describedby="profile-remove-text"></button>
      <button type="button" class="ghost" id="profile-remove-cancel" aria-describedby="profile-remove-text">Cancel</button>
    </div>`;
  const panelPart = id => panel.querySelector(`#${id}`);

  function profileList() {
    return optionProfiles(readOptionsRecord());
  }

  // The profiles this page offers: any while Multiple languages is on,
  // otherwise the Japanese ones (docs/profiles.md 4).
  function shownProfiles() {
    const record = readOptionsRecord();
    return profileList().filter(profile => profileUsable(record, profile) || profile.id === JAPANESE_PROFILE_ID);
  }

  function profileLabel(profile) {
    return profile.name ?? languageName(profile.language);
  }

  function dictionaryCount(profileId) {
    const state = readDictionaryState();
    if (state === null) return 0;
    if (!hasDictionaryProfiles(state)) return profileId === JAPANESE_PROFILE_ID ? state.dictionaries?.length ?? 0 : 0;
    return state.profiles?.[profileId]?.dictionaries?.length ?? 0;
  }

  // Runs one change at a time; focus goes to `next` when the action returns
  // one, else back to the control that started it.
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

  function rowOf(profileId) {
    return [...list.children].find(item => item.dataset.profileId === profileId) ?? null;
  }

  function button(text, role, label, onClick, { danger = false, pressed = null } = {}) {
    const node = create("button", { type: "button", className: danger ? "ghost danger" : "ghost", text,
      "aria-label": label, "data-role": role });
    if (pressed !== null) node.setAttribute("aria-pressed", String(pressed));
    node.addEventListener("click", onClick);
    return node;
  }

  // A row: the default choice, the name (a field once there is a choice of
  // profiles), what the profile reads in and holds, and its actions.
  function buildRow(profile, { several, active, edited, removable, showLanguage }) {
    const label = profileLabel(profile);
    const item = create("li", { className: "language-row profile-row" });
    item.dataset.profileId = profile.id;
    const radio = create("input", { type: "radio", name: "profile-default", "data-role": "default",
      "aria-label": `Use ${label} by default` });
    radio.checked = active;
    radio.hidden = !several;
    radio.addEventListener("change", () => {
      if (radio.checked) void run(async () => {
        await setDefaultProfile(profile.id);
        setStatus(`Lookups now use ${label} unless a rule below picks another profile.`, "ready");
      });
    });
    const body = create("div", { className: "profile-row-body" });
    let name;
    if (several) {
      name = create("input", { type: "text", className: "profile-name", spellcheck: "false", autocomplete: "off",
        "aria-label": `Name of ${label}`, placeholder: languageName(profile.language), "data-role": "name" });
      name.value = profile.name ?? "";
      const save = () => {
        const value = name.value.trim();
        if (value === (profile.name ?? "")) return;
        void run(async () => {
          await renameProfile(profile.id, value);
          setStatus(value === "" ? `The profile is called ${languageName(profile.language)} again.` : `Renamed to ${value}.`,
            "ready");
        });
      };
      name.addEventListener("change", save);
      name.addEventListener("keydown", event => {
        if (event.key === "Enter") save();
        else if (event.key === "Escape") name.value = profile.name ?? "";
      });
    } else {
      name = create("strong", { text: label });
    }
    const details = [showLanguage ? languageName(profile.language) : null,
      countLabel(dictionaryCount(profile.id), "dictionary", "dictionaries")].filter(Boolean).join(" · ");
    const meta = create("span", { className: "field-hint profile-meta", text: details });
    const badges = create("span", { className: "profile-badges" });
    if (active && several) badges.append(create("span", { className: "profile-badge", text: "Default" }));
    if (edited && several) badges.append(create("span", { className: "profile-badge profile-badge-edited", text: "Settings shows" }));
    body.append(name, meta, badges);
    const actions = create("div", { className: "options-actions profile-actions" });
    if (several) {
      actions.append(button(edited ? "Shown in Settings" : "Edit settings", "edit",
        `Show ${label} in Settings`, () => {
          if (readEditedProfile().id === profile.id) return;
          void run(async () => {
            const refused = await chooseEditedProfile(profile.id);
            if (refused !== null) throw new Error(refused);
            setStatus(`Settings now shows ${label}. Every other section changes ${label}'s settings.`, "ready");
          });
        }, { pressed: edited }));
    }
    actions.append(button("Copy", "copy", `Copy ${label}`, () => { void copyProfile(profile); }));
    if (removable) actions.append(button("Remove", "remove", `Remove ${label}`, () => openRemoval(profile), { danger: true }));
    item.append(radio, body, actions);
    return item;
  }

  // Rebuilt only when what the rows show changes, so a render keeps a name
  // being typed and the focus where it is.
  let shownKey = null;

  function renderRows() {
    const profiles = shownProfiles();
    const several = hasProfiles(readOptionsRecord()) && profiles.length > 1;
    const active = readActiveProfileId();
    const edited = readEditedProfile().id;
    const showLanguage = languagesEnabled(readOptionsRecord()) || profiles.some(profile => profile.language !== "ja");
    const sharedLanguage = profile => profiles.some(other => other.id !== profile.id && other.language === profile.language);
    const rows = profiles.map(profile => ({ profile, several, active: profile.id === active, edited: profile.id === edited,
      showLanguage,
      // The last profile stays, and the ja profile goes after its copies
      // (docs/profiles.md 5.3).
      removable: several && !(profile.id === JAPANESE_PROFILE_ID && sharedLanguage(profile)) }));
    const key = JSON.stringify(rows.map(row => [row.profile.id, row.profile.name, row.profile.language, row.several,
      row.active, row.edited, row.removable, row.showLanguage, dictionaryCount(row.profile.id)]));
    if (key !== shownKey && !(list.contains(document.activeElement) && document.activeElement.dataset.role === "name")) {
      const focused = list.contains(document.activeElement)
        ? { id: document.activeElement.closest("li")?.dataset.profileId, role: document.activeElement.dataset.role } : null;
      shownKey = key;
      list.replaceChildren(...rows.map(row => buildRow(row.profile, row)));
      if (focused) (rowOf(focused.id)?.querySelector(`[data-role="${focused.role}"]`) ?? rowOf(focused.id)?.querySelector("button"))?.focus();
    }
    for (const control of list.querySelectorAll("button, input")) control.disabled = busy;
    setText(help, several
      ? "Lookups use the default profile unless a rule below picks another. Settings shows one profile at a time: every"
        + " other section changes the profile marked Settings shows. Copy makes a new profile with the same settings and"
        + " dictionaries."
      : "Copy your profile to keep a second set of settings and dictionaries, such as one for video with no activation"
        + " key, and switch between them automatically below.");
  }

  // Copy starts from the profile's saved settings, so this page's unsaved
  // edits are saved first; Settings then shows the copy (docs/profiles.md 5.1).
  function copyProfile(profile) {
    return run(async () => {
      const label = profileLabel(profile);
      await settleEdits();
      setStatus(`Copying ${label}…`, "working");
      // Lookups stay in the default profile: without a stored choice it is
      // the Japanese one, so the choice is stored first, as adding a
      // language does.
      if (hasProfiles(readOptionsRecord()) && readSelection().activeProfileId === null) {
        await setDefaultProfile(readActiveProfileId());
      }
      const profileId = newProfileId();
      const name = `${label} copy`;
      const reply = await send("hd_profile_add", { language: profile.language, copyFrom: profile.id, profileId, name });
      if (!reply.ok) throw new Error(reply.error || `${label} could not be copied`);
      await afterProfileChange();
      const refused = await chooseEditedProfile(profileId);
      setStatus(refused === null ? `Made ${name}. Settings now shows it; rename it here.` : `Made ${name}. ${refused}`, "ready");
      return rowOf(profileId)?.querySelector('[data-role="name"]') ?? null;
    });
  }

  function openRemoval(profile) {
    removing = profile;
    const label = profileLabel(profile);
    const language = languageName(profile.language);
    const shared = profileList().some(other => other.id !== profile.id && other.language === profile.language);
    panelPart("profile-remove-text").textContent = `Remove ${label}? Its settings, its list of dictionaries and its rules`
      + ` are deleted. Its dictionaries stay in your library, and the ${language} personal dictionary, lookup counts and`
      + ` marked words are kept${shared ? ` for your other ${language} profiles` : ""}.`;
    panelPart("profile-remove-confirm").textContent = `Remove ${label}`;
    list.after(panel);
    // Cancel first, so Enter pressed twice does not remove a profile.
    panelPart("profile-remove-cancel").focus();
  }

  function closeRemoval() {
    const focused = panel.contains(document.activeElement);
    const id = removing?.id;
    removing = null;
    panel.remove();
    if (focused) (rowOf(id)?.querySelector('[data-role="remove"]') ?? list.querySelector("button"))?.focus();
  }

  function remove() {
    const profile = removing;
    if (profile === null) return Promise.resolve();
    return run(async () => {
      const label = profileLabel(profile);
      // Settings leaves a profile before it removes it, so its drafts are
      // saved or discarded first; it then shows the default profile.
      if (readEditedProfile().id === profile.id) {
        const others = profileList().filter(candidate => candidate.id !== profile.id);
        const next = others.find(candidate => candidate.id === readActiveProfileId())
          ?? others.find(candidate => candidate.id === JAPANESE_PROFILE_ID) ?? others[0];
        const refused = await chooseEditedProfile(next.id);
        if (refused !== null) throw new Error(refused);
      }
      setStatus(`Removing ${label}…`, "working");
      const reply = await send("hd_profile_remove", { profileId: profile.id, language: profile.language });
      if (!reply.ok) throw new Error(reply.error || `${label} could not be removed`);
      closeRemoval();
      await afterProfileChange();
      setStatus(`Removed ${label}.`, "ready");
      return list.querySelector("button");
    });
  }

  panelPart("profile-remove-confirm").addEventListener("click", () => { void remove(); });
  panelPart("profile-remove-cancel").addEventListener("click", closeRemoval);

  let rules = null;

  function renderRules(several) {
    if (!several) {
      rules?.card.remove();
      rules = null;
      return;
    }
    if (rules === null) {
      rules = createProfileRules({ document, create, readSelection, profileList: shownProfiles, profileLabel, writeRules,
        setStatus, card: RULES_CARD });
      card.after(rules.card);
    }
    rules.render();
  }

  function render() {
    renderRows();
    renderRules(hasProfiles(readOptionsRecord()) && shownProfiles().length > 1);
    if (removing !== null && !profileList().some(profile => profile.id === removing.id)) closeRemoval();
    panelPart("profile-remove-confirm").disabled = busy;
    panelPart("profile-remove-cancel").disabled = busy;
  }

  return { render };
}
