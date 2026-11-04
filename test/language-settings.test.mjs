// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings edits one profile (docs/languages.md 5.3, 5.4, 7.5, 16.3-16.5):
// Advanced → Languages with Settings shows, Use for lookups, automatic
// switching, Add, Remove and the held languages; the sidebar link; the edited
// profile's own values and writes, the explicit-save prompt, removal
// elsewhere, the All languages notes and a pack's own settings. A
// Japanese-only page has languages only in Advanced and keeps today's
// requests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PACKAGE, openSettings, plain, settle } from "./language-settings-harness.mjs";

function withProfiles({ activeProfileId = "ar" } = {}) {
  return {
    options: {
      revision: 3, hoverEnabled: true, popupWidthPx: 600, anki: { url: "http://127.0.0.1:8765", apiKey: "" },
      profiles: [
        { id: "ja", language: "ja", settings: { scanLength: 12 }, packSettings: {} },
        { id: "ar", language: "ar", settings: { scanLength: 24, popupTheme: "default" }, packSettings: { vowelMarks: "show" } },
      ],
    },
    dictionaryState: {
      schemaVersion: 2, revision: 5,
      dictionaries: [PACKAGE("a".repeat(32), "Jitendex", { language: "ja" }), PACKAGE("b".repeat(32), "Arabic", { language: "ar" })],
      profiles: { ja: { dictionaries: [{ id: "a".repeat(32), enabled: true }], groups: [] },
        ar: { dictionaries: [{ id: "b".repeat(32), enabled: true }], groups: [] } },
    },
    languageSelection: { revision: 2, activeProfileId, autoSwitch: false },
  };
}

async function open(t, options) {
  const settings = openSettings(t, options);
  await settings.page.start();
  await settle();
  return settings;
}

const EMPTY_SEMANTIC_REVISION = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const writesOf = (settings, type) => settings.messages.filter(message => message.type === type);
const rowsOf = (settings, id) => [...settings.el(id).querySelectorAll(".language-row")].map(row => row.querySelector("strong").textContent);
const choicesOf = select => [...select.options].map(option => option.value);
const addButton = settings => settings.el("settings-language-add-row").querySelector("button");
// The sidebar as settings.html writes it, by element.
const STATIC_SIDEBAR = (() => {
  const markup = readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8");
  return [...markup.slice(markup.indexOf('<aside class="settings-sidebar">'), markup.indexOf("</aside>"))
    .matchAll(/<([a-z]+)\b([^>]*)>/gu)].map(([, tag, attributes]) => `${tag}#${attributes.match(/\bid="([^"]+)"/u)?.[1] ?? ""}`);
})();
const sidebarOf = settings => [settings.document.querySelector(".settings-sidebar"),
  ...settings.document.querySelectorAll(".settings-sidebar *")].map(node => `${node.localName}#${node.id}`);

test("a Japanese-only page has languages only in Advanced, and sends today's requests", async t => {
  const settings = await open(t, { hash: "#lookup", stored: { options: { revision: 1 } } });
  const { document, el, page } = settings;
  assert.deepEqual(sidebarOf(settings), STATIC_SIDEBAR, "the sidebar is settings.html's");
  assert.equal(el("settings-language-select"), null, "Settings shows needs a second language");
  assert.equal(el("language-auto-switch"), null);
  assert.equal(document.querySelectorAll("[data-scope-note]").length, 0, "no All languages notes");
  assert.equal(document.querySelectorAll("#language-lookup-settings, #language-display-settings").length, 0);
  // Advanced → Languages, Advanced's first card.
  const card = el("language-settings");
  assert.equal(card.closest("section").id, "advanced");
  assert.equal(el("advanced").querySelector("fieldset"), card);
  assert.equal(card.querySelector("legend").textContent, "Languages");
  assert.deepEqual(rowsOf(settings, "settings-language-profiles"), ["Japanese"]);
  assert.equal(el("settings-language-profiles").querySelector("button"), null, "the last language has no Remove");
  assert.deepEqual(choicesOf(el("settings-language-add-select")), ["", "ar", "en"]);
  assert.match(el("settings-language-add-help").textContent,
    /^A new language starts with a copy of your Japanese settings and no dictionaries/u);
  assert.deepEqual(settings.search("add a language"), ["Languages", "Add a language"]);
  assert.deepEqual(settings.search("settings shows"), []);
  el("opt-scan-length").value = "20";
  el("opt-scan-length").dispatchEvent(new settings.window.Event("change", { bubbles: true }));
  await settle(250);
  const [write] = writesOf(settings, "hd_options_write");
  assert.deepEqual(Object.keys(write).sort(), ["baseRevision", "options", "requestId", "target", "type"]);
  assert.deepEqual(write.options, { scanLength: 20 });
  assert.equal(page.options().scanLength, 20);
});

test("Settings starts on the active profile, shows its values and names it in every write", async t => {
  const settings = await open(t, { hash: "#lookup", stored: withProfiles() });
  const { el, page, records } = settings;
  assert.equal(page.editedProfile().id, "ar");
  assert.equal(el("settings-language-select").value, "ar");
  assert.equal(el("opt-scan-length").value, "24", "the profile's own value");
  assert.equal(el("opt-popup-width").value, "600", "a global value");
  assert.equal(el("settings-language-use").hidden, false);
  assert.equal(el("settings-language-select").closest("#language-settings")?.closest("section").id, "advanced");
  assert.equal(el("settings-language-use").getAttribute("aria-pressed"), "true", "Arabic is already used for lookups");
  assert.equal(el("settings-language-use").textContent, "Used for lookups");
  assert.match(el("settings-language-select-help").textContent, /Lookups in this browser use Arabic\.$/u);
  assert.equal(el("settings-language-link").textContent, "Settings shows Arabic");
  assert.equal(page.dictionaries().map(entry => entry.title).join(), "Arabic", "the library is the profile's");
  el("opt-scan-length").value = "30";
  el("opt-scan-length").dispatchEvent(new settings.window.Event("change", { bubbles: true }));
  el("opt-hover-enabled").click();
  await settle(250);
  const [write] = writesOf(settings, "hd_options_write");
  assert.equal(write.profileId, "ar");
  assert.deepEqual(write.options, { scanLength: 30, hoverEnabled: false });
  assert.equal(records.options.profiles[1].settings.scanLength, 30);
  assert.equal(records.options.profiles[0].settings.scanLength, 12, "Japanese is untouched");
  assert.equal(records.options.hoverEnabled, false, "a global key goes to the top level");
});

test("choosing another language saves pending edits for the profile they were made for, and Use for lookups activates it", async t => {
  const settings = await open(t, { hash: "#lookup", stored: withProfiles() });
  const { el, page, records, window } = settings;
  el("opt-scan-length").value = "31";
  el("opt-scan-length").dispatchEvent(new window.Event("change", { bubbles: true }));
  const select = el("settings-language-select");
  select.value = "ja";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle(250);
  assert.equal(records.options.profiles[1].settings.scanLength, 31, "the draft was saved to Arabic");
  assert.equal(writesOf(settings, "hd_options_write")[0].profileId, "ar");
  assert.equal(page.editedProfile().id, "ja");
  assert.equal(el("opt-scan-length").value, "12");
  assert.equal(page.dictionaries().map(entry => entry.title).join(), "Jitendex");
  assert.equal(records.languageSelection.activeProfileId, "ar", "choosing in the menu does not change lookups");
  assert.equal(el("settings-language-use").disabled, false);
  el("settings-language-use").click();
  await settle();
  const [selection] = writesOf(settings, "hd_language_selection_write");
  assert.deepEqual([selection.baseRevision, selection.activeProfileId], [2, "ja"]);
  assert.equal(records.languageSelection.activeProfileId, "ja");
  assert.equal(el("settings-language-use").textContent, "Used for lookups");
  // A toolbar switch elsewhere does not move the page.
  settings.write({ languageSelection: { revision: 9, activeProfileId: "ar", autoSwitch: false } });
  await settle();
  assert.equal(page.editedProfile().id, "ja");
  assert.equal(el("settings-language-use").textContent, "Use for lookups");
});

test("a refused save keeps the menu on the current language until the user settles it", async t => {
  const settings = await open(t, { hash: "#lookup", stored: withProfiles(), onMessage(message, { records, write }) {
    if (message.type !== "hd_options_write") return undefined;
    // Another page saved first.
    write({ options: { ...records.options, revision: records.options.revision + 1 } });
    return { ok: false, conflict: true, error: "Settings changed in another page.", options: records.options };
  } });
  const { el, page, window } = settings;
  el("opt-scan-length").value = "40";
  el("opt-scan-length").dispatchEvent(new window.Event("change", { bubbles: true }));
  el("settings-language-select").value = "ja";
  el("settings-language-select").dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle(250);
  assert.equal(page.editedProfile().id, "ar");
  assert.equal(el("settings-language-select").value, "ar");
  assert.match(el("settings-language-status").textContent, /Save my changes or Use saved settings/u);
  assert.equal(el("options-conflict-actions").hidden, false);
  el("options-use-saved").click();
  el("settings-language-select").value = "ja";
  el("settings-language-select").dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(page.editedProfile().id, "ja");
});

test("an unsaved personal dictionary source asks to be saved or discarded before another language", async t => {
  const stored = withProfiles();
  stored.customDictionarySource = { schemaVersion: 1, revision: 1, semanticRevision: "1".repeat(64), text: "蜂, はち, bee\n",
    languages: { ar: { revision: 4, semanticRevision: "2".repeat(64), text: "كتاب, , book\n" } } };
  const settings = await open(t, { hash: "#custom-dictionary", stored });
  const { el, page, window } = settings;
  await settle();
  assert.equal(el("custom-dictionary-source").value, "كتاب, , book\n", "the editor holds Arabic's document");
  el("custom-dictionary-source").value = "كتاب, , book\nقلم, , pen\n";
  el("custom-dictionary-source").dispatchEvent(new window.Event("input", { bubbles: true }));
  el("settings-language-select").value = "ja";
  el("settings-language-select").dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(page.editedProfile().id, "ar");
  assert.equal(el("settings-language-status").textContent,
    "Save or discard your changes to the personal dictionary before choosing another language.");
  el("custom-dictionary-source").value = "كتاب, , book\n";
  el("custom-dictionary-source").dispatchEvent(new window.Event("input", { bubbles: true }));
  el("settings-language-select").value = "ja";
  el("settings-language-select").dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle(100);
  assert.equal(page.editedProfile().id, "ja");
  assert.equal(el("custom-dictionary-source").value, "蜂, はち, bee\n", "the editor loads Japanese's document");
});

test("a profile removed elsewhere moves the page to the active profile, discards its drafts and says so", async t => {
  const settings = await open(t, { hash: "#lookup", stored: withProfiles({ activeProfileId: "ja" }) });
  const { el, page, records, window } = settings;
  el("settings-language-select").value = "ar";
  el("settings-language-select").dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(page.editedProfile().id, "ar");
  el("opt-scan-length").value = "50";
  el("opt-scan-length").dispatchEvent(new window.Event("input", { bubbles: true }));
  el("opt-scan-length").dispatchEvent(new window.Event("change", { bubbles: true }));
  settings.write({ options: { ...records.options, revision: 10, profiles: records.options.profiles.slice(0, 1) },
    dictionaryState: { ...records.dictionaryState, revision: 9, profiles: { ja: records.dictionaryState.profiles.ja } } });
  await settle(250);
  assert.equal(page.editedProfile().id, "ja");
  assert.match(el("settings-language-status").textContent, /^Arabic was removed in another Hachidori page, so Settings now shows Japanese\./u);
  // Reading is open: the rail's Advanced says so.
  assert.match(el("nav-status-advanced").textContent, /^Languages: Arabic was removed in another Hachidori page/u);
  assert.equal(el("settings-language-link"), null, "one language left");
  assert.deepEqual(plain(page.pending()), {});
  assert.equal(writesOf(settings, "hd_options_write").length, 0, "the removed profile's draft is not written anywhere");
  assert.equal(el("opt-scan-length").value, "12");
});

test("shared settings say All languages once the records have profiles, and the reset hints say every language", async t => {
  const settings = await open(t, { hash: "#design", stored: withProfiles() });
  const { document, el } = settings;
  const noted = id => Boolean(el(id).closest("label")?.querySelector("[data-scope-note]")
    || el(id).closest("label")?.nextElementSibling?.matches("[data-scope-note]")
    || document.querySelector(`label[for="${id}"]`)?.nextElementSibling?.matches("[data-scope-note]")
    // A control with a hint has the note as the hint's last line.
    || el(el(id).getAttribute("aria-describedby")?.split(" ")[0] ?? "")?.querySelector("[data-scope-note]"));
  for (const id of ["opt-popup-width", "opt-popup-height", "opt-popup-scale", "opt-popup-toolbar", "opt-source-highlight",
    "opt-custom-popup-css", "opt-custom-popup-javascript", "opt-popup-nesting-depth", "opt-smaller-anki-cards", "opt-anki-url"]) {
    assert.ok(noted(id), id);
  }
  for (const id of ["opt-scan-length", "opt-popup-opacity", "opt-popup-columns"]) assert.equal(noted(id), false, id);
  const legend = text => [...document.querySelectorAll("legend")].find(node => node.textContent === text);
  for (const text of ["Activation", "Popup closing", "Search page"]) {
    assert.ok(legend(text).nextElementSibling.matches("[data-scope-note]"), text);
  }
  assert.equal(legend("Scanning").nextElementSibling.matches("[data-scope-note]"), false);
  for (const id of ["updates", "keybinds", "backup", "sharing"]) {
    assert.ok(el(id).querySelector(".card-head [data-scope-note]"), id);
  }
  // Advanced holds per-language settings too, so its shared cards say so one by one.
  assert.equal(el("advanced").querySelector(".card-head [data-scope-note]"), null);
  for (const text of ["Memory", "Search history", "Experimental features"]) {
    assert.ok(legend(text).nextElementSibling.matches("[data-scope-note]"), text);
  }
  assert.equal(el("language-settings").querySelector("[data-scope-note]"), null);
  assert.match(el("reset-design-help").textContent, /^Resets every Design setting of Arabic.*for every language\./u);
  assert.match(el("lookup-counts-reset-help").textContent, /^Every word in every language starts again from zero/u);
  assert.equal(el("language-auto-switch").closest("fieldset").id, "language-settings", "Advanced → Languages offers it");
  assert.deepEqual(settings.search("switch language automatically"), ["Switch language automatically from the page's language"]);
});

test("automatic switching is this browser's choice, written through the language selection", async t => {
  const settings = await open(t, { hash: "#advanced", stored: withProfiles() });
  const { el, records } = settings;
  const input = el("language-auto-switch");
  assert.equal(el("lookup").querySelector("#language-auto-switch"), null, "no longer in Reading → Scanning");
  assert.equal(input.checked, false);
  input.click();
  await settle();
  const [write] = writesOf(settings, "hd_language_selection_write");
  assert.deepEqual([write.baseRevision, write.autoSwitch, write.activeProfileId], [2, true, undefined]);
  assert.equal(records.languageSelection.autoSwitch, true);
  assert.equal(writesOf(settings, "hd_options_write").length, 0, "not an option");
});

test("Add a language copies the edited profile, edits the new one and offers Use for lookups", async t => {
  const settings = await open(t, { hash: "#advanced", stored: withProfiles() });
  const { document, el, page, records, window } = settings;
  assert.deepEqual(rowsOf(settings, "settings-language-profiles"), ["Japanese", "Arabic"]);
  assert.match(el("settings-language-profiles").textContent, /1 dictionary/u);
  const select = el("settings-language-add-select");
  assert.deepEqual(choicesOf(select), ["", "en"]);
  assert.equal(select.options[0].textContent, "Choose a language");
  // Add without a choice asks for one.
  addButton(settings).click();
  assert.equal(el("settings-language-status").textContent, "Choose a language to add.");
  assert.equal(document.activeElement, select);
  assert.equal(writesOf(settings, "hd_profile_add").length, 0);
  select.value = "en";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  addButton(settings).focus();
  addButton(settings).click();
  await settle(100);
  const [add] = writesOf(settings, "hd_profile_add");
  assert.deepEqual([add.language, add.copyFrom], ["en", "ar"]);
  assert.equal(add.target, "hoshidicts-offscreen");
  assert.equal(page.editedProfile().id, "en");
  assert.equal(el("settings-language-select").value, "en");
  assert.equal(el("opt-scan-length").value, "24", "the new profile copies the edited one");
  assert.equal(records.languageSelection.activeProfileId, "ar", "lookups stay where they were");
  assert.equal(el("settings-language-status").textContent, "Added English. Settings now shows English.");
  assert.deepEqual(rowsOf(settings, "settings-language-profiles"), ["Japanese", "Arabic", "English"]);
  assert.deepEqual(choicesOf(select), [""], "every test pack is in use");
  assert.equal(document.activeElement, el("settings-language-use"), "Use for lookups is the next step");
  assert.equal(el("settings-language-use").textContent, "Use for lookups");
  el("settings-language-use").click();
  await settle();
  assert.equal(records.languageSelection.activeProfileId, "en");
  assert.equal(el("settings-language-use").textContent, "Used for lookups");
});

test("Remove asks first, can erase, and the last language cannot be removed", async t => {
  const settings = await open(t, { hash: "#advanced", stored: withProfiles({ activeProfileId: "ja" }) });
  const { document, el, page } = settings;
  el("settings-language-select").value = "ar";
  el("settings-language-select").dispatchEvent(new settings.window.Event("change", { bubbles: true }));
  await settle(100);
  assert.equal(page.editedProfile().id, "ar");
  const removeArabic = () => el("settings-language-profiles").querySelector('[aria-label="Remove Arabic"]');
  assert.equal(el("settings-language-remove"), null, "the question is asked only after Remove");
  removeArabic().focus();
  removeArabic().click();
  // The question follows the list, with Cancel first.
  assert.equal(el("settings-language-remove").previousElementSibling, el("settings-language-profiles"));
  assert.equal(document.activeElement, el("settings-language-remove-cancel"));
  el("settings-language-remove-cancel").click();
  assert.equal(el("settings-language-remove"), null);
  assert.equal(document.activeElement, removeArabic(), "Cancel returns to the language's Remove");
  removeArabic().click();
  assert.equal(el("settings-language-erase-label").textContent,
    "Also erase my Arabic personal dictionary, lookup counts and marked words");
  await settle(50);
  assert.equal(el("settings-language-erase-help").textContent, "Its personal dictionary has 0 entries.");
  el("settings-language-erase").checked = true;
  el("settings-language-remove-confirm").focus();
  el("settings-language-remove-confirm").click();
  await settle(100);
  const [remove] = writesOf(settings, "hd_profile_remove");
  assert.deepEqual([remove.profileId, remove.erase, remove.baseDocumentRevision], ["ar", true, 0],
    "an erase names the document revision the confirmation read");
  assert.equal(page.editedProfile().id, "ja", "Settings left Arabic before removing it");
  assert.doesNotMatch(el("settings-language-status").textContent, /another Hachidori page/u);
  assert.equal(el("settings-language-remove"), null);
  assert.deepEqual(rowsOf(settings, "settings-language-profiles"), ["Japanese"]);
  assert.equal(el("settings-language-profiles").querySelector("button"), null, "the last language cannot be removed");
  assert.equal(el("settings-language-select"), null, "one language: nothing to choose");
  assert.equal(document.activeElement, el("settings-language-add-select"));
});

test("languages held without a profile are listed with Erase", async t => {
  const stored = withProfiles();
  stored.lookupStats = { revision: 4, generation: "g-ja", languages: { vi: "g-vi" } };
  stored.customDictionarySource = { schemaVersion: 1, revision: 0, semanticRevision: EMPTY_SEMANTIC_REVISION, text: "",
    languages: { vi: { revision: 2, semanticRevision: "3".repeat(64), text: "sách, , book\n" } } };
  const settings = await open(t, { hash: "#advanced", stored });
  const { el, document, window } = settings;
  window.confirm = () => true;
  await settle(50);
  assert.equal(el("settings-language-held-list").hidden, false);
  const heldRow = el("settings-language-held-list").querySelector(".language-row");
  assert.equal(heldRow.querySelector("strong").textContent, "Vietnamese");
  assert.equal(heldRow.querySelector(".field-hint").textContent,
    "Removed, with its personal dictionary, lookup counts and marked words kept");
  document.querySelector('[aria-label="Erase Vietnamese"]').click();
  await settle(50);
  const [erase] = writesOf(settings, "hd_profile_remove");
  assert.deepEqual([erase.language, erase.erase, erase.profileId, erase.baseDocumentRevision], ["vi", true, undefined, 2]);
});

test("a pack's display setting shows under Advanced → Languages for a theme that renders presentation and is saved by id", async t => {
  // Default renders presentation (vendor/themes/index.json).
  const settings = await open(t, { hash: "#advanced", stored: withProfiles() });
  const { el, records, window } = settings;
  await settle();
  const fieldset = el("language-display-settings");
  assert.ok(fieldset);
  assert.equal(fieldset.previousElementSibling, el("language-settings"), "after the Languages card");
  assert.equal(el("design").querySelector("[data-language-settings]"), null);
  assert.equal(fieldset.querySelector("legend").textContent, "Arabic display");
  assert.equal(fieldset.hidden, false);
  const select = el("opt-pack-vowelMarks");
  assert.equal(select.value, "show");
  assert.deepEqual(settings.search("vowel marks"), ["Vowel marks in headwords"]);
  select.value = "hide";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle(250);
  const [write] = writesOf(settings, "hd_options_write");
  assert.deepEqual([write.profileId, plain(write.options), plain(write.packSettings)], ["ar", {}, { vowelMarks: "hide" }]);
  assert.deepEqual(records.options.profiles[1].packSettings, { vowelMarks: "hide" });
  // Japanese declares no settings: the fieldset goes.
  el("settings-language-select").value = "ja";
  el("settings-language-select").dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(el("language-display-settings"), null);
});

test("a theme without presentation hides the pack's display settings", async t => {
  const stored = withProfiles();
  stored.options.profiles[1].settings.popupTheme = "plain";
  const settings = await open(t, { hash: "#advanced", stored });
  await settle();
  assert.equal(settings.el("language-display-settings").hidden, true);
  assert.deepEqual(settings.search("vowel marks"), []);
});

// Design 5.3: when another page removes the edited profile, its drafts are
// discarded, including a save that was in flight and is then refused.
test("a save refused because its profile was removed elsewhere is not written into the next profile", async t => {
  const stored = {
    options: { revision: 5, profiles: [
      { id: "ja", language: "ja", settings: { scanLength: 16 }, packSettings: {} },
      { id: "en", language: "en", settings: { scanLength: 16 }, packSettings: {} },
    ] },
    dictionaryState: { schemaVersion: 2, revision: 3, dictionaries: [], profiles: { ja: { dictionaries: [], groups: [] },
      en: { dictionaries: [], groups: [] } } },
    languageSelection: { revision: 1, activeProfileId: "ja", autoSwitch: false },
  };
  let removed = false;
  const writes = [];
  const settings = openSettings(t, { hash: "?profile=en#lookup", stored, onMessage: async (message, { records, write }) => {
    if (message.type !== "hd_options_write") return undefined;
    writes.push(message.profileId ?? null);
    if (removed) return undefined;
    removed = true;
    // Another page's removal of English commits first.
    const options = structuredClone(records.options);
    options.profiles = options.profiles.filter(profile => profile.id !== "en");
    options.revision += 1;
    const dictionaryState = structuredClone(records.dictionaryState);
    delete dictionaryState.profiles.en;
    dictionaryState.revision += 1;
    write({ options, dictionaryState });
    return { ok: false, conflict: true, error: "Settings changed in another page.", options };
  } });
  await settings.page.start();
  await settle(50);
  const input = settings.el("opt-scan-length");
  input.value = "21";
  input.dispatchEvent(new settings.window.Event("change", { bubbles: true }));
  await settle(400);
  assert.equal(settings.page.editedProfile().id, "ja");
  assert.deepEqual(plain(settings.page.pending()), {});
  assert.equal(settings.el("options-conflict-actions").hidden, true);
  settings.el("options-retry").click();
  await settle(400);
  assert.deepEqual(writes, ["en"]);
  assert.equal(settings.records.options.profiles.find(profile => profile.id === "ja").settings.scanLength, 16);
});

// Design 17.6: a linked browser can add only the languages both installations
// have packs for.
test("while linked, Add a language lists only the packs the host has too", async t => {
  const settings = await open(t, { hash: "#advanced", stored: withProfiles(), onMessage: async message => (
    message.type === "hd_sharing_status"
      ? { ok: true, sharing: { client: { linked: true, connected: true, languageProfiles: { hostLanguages: ["ja", "ar"] } } } }
      : undefined) });
  const { el } = settings;
  await settle(100);
  assert.deepEqual(rowsOf(settings, "settings-language-profiles"), ["Japanese", "Arabic"]);
  assert.equal(el("settings-language-add-select").hidden, true, "the host has no English pack");
  assert.equal(el("settings-language-add-help").textContent, "This Hachidori has no other language yet.");
});

test("with two languages the sidebar names the one Settings shows and leads to Settings shows", async t => {
  const settings = await open(t, { hash: "#lookup", stored: withProfiles() });
  const { document, el, records, visible, window } = settings;
  const link = el("settings-language-link");
  assert.equal(link.previousElementSibling, el("setup-resume"), "under Resume setup, styled as it is");
  assert.equal(link.textContent, "Settings shows Arabic");
  assert.equal(link.getAttribute("href"), "#advanced");
  link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  assert.equal(window.location.hash, "#advanced");
  assert.deepEqual(visible(), ["advanced"]);
  assert.equal(document.activeElement, el("settings-language-select"));
  el("settings-language-select").value = "ja";
  el("settings-language-select").dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(el("settings-language-link").textContent, "Settings shows Japanese");
  // One language left: the sidebar is settings.html's again.
  settings.write({ options: { ...records.options, revision: 10, profiles: records.options.profiles.slice(0, 1) } });
  await settle();
  assert.deepEqual(sidebarOf(settings), STATIC_SIDEBAR);
});

test("Switch to the next language is a keybind action once the records have profiles", async t => {
  const actionOffered = settings => [...settings.document.querySelectorAll("#keybind-list .keybind-action")]
    .map(select => !select.querySelector('option[value="switchLanguage"]').hidden);
  const japanese = await open(t, { hash: "#keybinds", stored: { options: { revision: 1 } } });
  assert.ok(actionOffered(japanese).length > 0);
  assert.ok(actionOffered(japanese).every(offered => !offered), "a Japanese-only page does not offer it");
  const languages = await open(t, { hash: "#keybinds", stored: withProfiles() });
  assert.ok(actionOffered(languages).every(Boolean));
  // A stored bind keeps showing its action.
  const stored = await open(t, { hash: "#keybinds", stored: { options: { revision: 1, keybinds: [{ action: "switchLanguage",
    argument: "", key: "KeyL", modifiers: ["alt", "shift"], scopes: ["web"], enabled: true }] } } });
  const select = stored.document.querySelector("#keybind-list .keybind-action");
  assert.equal(select.value, "switchLanguage");
  assert.equal(select.selectedOptions[0].hidden, false);
});
