// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dictionaries per profile (docs/languages.md 14): the edited profile's
// library, Dictionaries in your other languages with Use in, Remove from and
// Delete, bulk Remove, Remove all across languages, imports into the edited
// profile with the sourceLanguage hint and Move to, and recommended links for
// other packs. A Japanese-only library is today's.
import assert from "node:assert/strict";
import test from "node:test";
import { LANGUAGES, PACKAGE, openSettings, settle } from "./language-settings-harness.mjs";

const JITENDEX = PACKAGE("a".repeat(32), "Jitendex", { language: "ja" });
const ARABIC = PACKAGE("b".repeat(32), "Arabic-English", { language: "ar" });
const SHARED = PACKAGE("c".repeat(32), "Wiktionary images", { language: null });
const ARABIC_PERSONAL = PACKAGE(LANGUAGES.ar.personalDictionary.id, LANGUAGES.ar.personalDictionary.title, { language: "ar" });

function withProfiles({ activeProfileId = "ar", extraProfiles = [] } = {}) {
  return {
    options: {
      revision: 3,
      profiles: [
        { id: "ja", language: "ja", settings: {}, packSettings: {} },
        { id: "ar", language: "ar", settings: {}, packSettings: {} },
        ...extraProfiles.map(code => ({ id: code, language: code, settings: {}, packSettings: {} })),
      ],
    },
    dictionaryState: {
      schemaVersion: 2, revision: 5,
      dictionaries: [JITENDEX, ARABIC, SHARED, ARABIC_PERSONAL].map(({ enabled, ...row }) => row),
      profiles: {
        ja: { dictionaries: [{ id: JITENDEX.id, enabled: true }, { id: SHARED.id, enabled: true }], groups: [] },
        ar: { dictionaries: [{ id: ARABIC_PERSONAL.id, enabled: true }, { id: ARABIC.id, enabled: true }], groups: [] },
        ...Object.fromEntries(extraProfiles.map(code => [code, { dictionaries: [], groups: [] }])),
      },
    },
    languageSelection: { revision: 1, activeProfileId, autoSwitch: false },
  };
}

async function open(t, options) {
  const settings = openSettings(t, options);
  await settings.page.start();
  await settle();
  return settings;
}

const sent = (settings, type) => settings.messages.filter(message => message.type === type);
const titles = settings => settings.page.dictionaries().map(entry => entry.title);
const row = (settings, title) => [...settings.el("dict-list").children]
  .find(item => item.querySelector(".dict-title").textContent === title);

test("a Japanese-only library keeps today's rows and confirmation", async t => {
  const settings = await open(t, { stored: { options: { revision: 1 },
    dictionaryState: { schemaVersion: 1, revision: 1, groups: [], dictionaries: [JITENDEX] } } });
  const remove = row(settings, "Jitendex").querySelector(".dict-remove");
  assert.equal(remove.textContent.trim(), "Remove");
  assert.equal(remove.getAttribute("aria-label"), "Remove Jitendex");
  assert.equal(row(settings, "Jitendex").querySelector(".dict-leave"), null);
  assert.equal(settings.el("dict-other-languages"), null);
  let question = "";
  settings.window.confirm = text => { question = text; return true; };
  remove.click();
  await settle(50);
  assert.equal(question, "Remove Jitendex? Its imported data is deleted and has to be imported again.");
  const [request] = sent(settings, "hd_remove");
  assert.deepEqual(Object.keys(request).sort(), ["id", "requestId", "target", "title", "type"]);
});

test("the library is the edited profile's, and Dictionaries in your other languages offers the rest", async t => {
  const settings = await open(t, { stored: withProfiles() });
  const { el } = settings;
  assert.deepEqual(titles(settings), [LANGUAGES.ar.personalDictionary.title, "Arabic-English"]);
  const pinned = row(settings, LANGUAGES.ar.personalDictionary.title);
  assert.equal(pinned.querySelector(".dict-pinned").hidden, false, "Arabic's personal package is managed and first");
  assert.equal(pinned.querySelector(".dict-enabled").disabled, true);
  const others = [...el("dict-other-language-list").children].map(item =>
    [item.querySelector(".dict-other-language-title").textContent, item.querySelector(".field-hint").textContent]);
  assert.deepEqual(others, [["Jitendex", "Used by Japanese"], ["Wiktionary images", "Used by Japanese"]]);
  el("dict-other-language-list").querySelector('[aria-label="Use Wiktionary images in Arabic"]').click();
  await settle(50);
  const [apply] = sent(settings, "hd_apply_state");
  assert.equal(apply.profileId, "ar");
  assert.deepEqual(apply.dictionaries.map(entry => [entry.id, entry.enabled]),
    [[ARABIC_PERSONAL.id, true], [ARABIC.id, true], [SHARED.id, true]], "enabled and last");
  assert.deepEqual(titles(settings), [LANGUAGES.ar.personalDictionary.title, "Arabic-English", "Wiktionary images"]);
  assert.deepEqual(settings.records.dictionaryState.profiles.ja.dictionaries.map(entry => entry.id), [JITENDEX.id, SHARED.id],
    "Japanese keeps it too");
});

test("Remove from a language keeps the package; Delete names every language using it", async t => {
  const stored = withProfiles();
  stored.dictionaryState.profiles.ar.dictionaries.push({ id: SHARED.id, enabled: false });
  const settings = await open(t, { stored });
  const shared = row(settings, "Wiktionary images");
  assert.equal(shared.querySelector(".dict-remove").textContent, "Delete");
  shared.querySelector('[aria-label="Remove Wiktionary images from Arabic"]').click();
  await settle(50);
  assert.deepEqual(sent(settings, "hd_apply_state")[0].dictionaries.map(entry => entry.id), [ARABIC_PERSONAL.id, ARABIC.id]);
  assert.ok(settings.records.dictionaryState.dictionaries.some(entry => entry.id === SHARED.id), "still installed");
  let question = "";
  settings.window.confirm = text => { question = text; return true; };
  row(settings, "Arabic-English").querySelector(".dict-remove").click();
  await settle(50);
  assert.equal(question, "Delete Arabic-English from Hachidori? Used by Arabic. Its imported data is deleted and has to be imported again.");
  const [remove] = sent(settings, "hd_remove");
  assert.deepEqual([remove.id, remove.profileId], [ARABIC.id, "ar"]);
});

test("bulk Remove deletes from Hachidori and names the other languages that use the selection", async t => {
  const stored = withProfiles();
  stored.dictionaryState.profiles.ar.dictionaries.push({ id: SHARED.id, enabled: true });
  const settings = await open(t, { stored });
  for (const title of ["Arabic-English", "Wiktionary images"]) row(settings, title).querySelector(".dict-selected").click();
  let question = "";
  settings.window.confirm = text => { question = text; return false; };
  settings.el("dict-bulk-remove").click();
  await settle();
  assert.equal(question, "Delete 2 selected dictionaries from Hachidori? Japanese also use some of them."
    + " Their imported data is deleted and has to be imported again. The personal dictionary is kept.");
});

test("Remove all removes every language's packages and, when asked, erases every language's source", async t => {
  const stored = withProfiles({ extraProfiles: ["en"] });
  stored.customDictionarySource = { schemaVersion: 1, revision: 4, semanticRevision: "1".repeat(64), text: "蜂, はち, bee\n",
    languages: { ar: { revision: 2, semanticRevision: "2".repeat(64), text: "كتاب, , book\nقلم, , pen\n" },
      vi: { revision: 7, semanticRevision: "3".repeat(64), text: "sách, , book\n" } } };
  const settings = await open(t, { stored });
  const { el, window } = settings;
  assert.equal(el("library-reset-personal").nextElementSibling.textContent,
    "Also erase every language's personal dictionary source");
  el("library-reset-personal").click();
  let question = "";
  window.confirm = text => { question = text; return true; };
  el("library-remove-all").click();
  await settle(150);
  assert.equal(question, "Remove 3 imported dictionaries and erase every language's personal dictionary source:"
    + " Japanese (1 entry), Arabic (2 entries) and Vietnamese (0 entries)? That is every imported dictionary of every"
    + " language, including disabled ones and any the search hides. This deletes them from this browser. Anki notes"
    + " are not changed, and existing backups still hold them.");
  assert.deepEqual(sent(settings, "hd_remove").map(request => [request.title, request.profileId]),
    [["Jitendex", "ar"], ["Arabic-English", "ar"], ["Wiktionary images", "ar"]]);
  assert.deepEqual(sent(settings, "hd_custom_save").map(request => [request.profileId, request.baseDocumentRevision, request.text]),
    [["ja", 4, ""], ["ar", 2, ""]]);
  assert.deepEqual(sent(settings, "hd_profile_remove").map(request => [request.language, request.erase, request.baseDocumentRevision]),
    [["vi", true, 7]], "a language without a profile is erased as a held language");
});

test("an import joins the edited profile, and an archive of another profile's language offers Move to", async t => {
  const added = PACKAGE("d".repeat(32), "Kaikki English", { language: "en" });
  const settings = await open(t, { hash: "#add-dictionaries", stored: withProfiles({ extraProfiles: ["en"] }),
    onMessage(message, { records, write }) {
      if (message.type === "hd_status") return { ok: true, ready: true, loading: false, failedDictionaries: [] };
      if (message.type !== "hd_import") return undefined;
      const state = structuredClone(records.dictionaryState);
      const { enabled, ...rowData } = added;
      state.dictionaries.push(rowData);
      state.profiles[message.profileId].dictionaries.push({ id: added.id, enabled: true });
      state.revision += 1;
      write({ dictionaryState: state });
      return { ok: true, report: { success: true, title: added.title, termCount: 1, frequencyCount: 0, pitchCount: 0,
        kanjiCount: 0, mediaCount: 0 } };
    } });
  const { el, window } = settings;
  const input = el("import-file");
  const file = new window.File(["zip"], "kaikki-en.zip", { type: "application/zip" });
  window.__archiveIdentities.set("kaikki-en.zip", { title: added.title, revision: "1", indexUrl: null, downloadUrl: null });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event("change"));
  await settle(400);
  const [request] = sent(settings, "hd_import");
  assert.equal(request.profileId, "ar", "bound to the profile edited when the import started");
  const offer = el("import-language-moves");
  assert.ok(offer, el("import-state").textContent);
  assert.match(offer.textContent, /^Kaikki English is a English dictionary\. It was added to Arabic\.Move to English$/u);
  offer.querySelector("button").click();
  await settle(100);
  const applies = sent(settings, "hd_apply_state");
  assert.deepEqual(applies.map(apply => [apply.profileId, apply.dictionaries.map(entry => entry.id).includes(added.id)]),
    [["en", true], ["ar", false]], "it joins English first, then leaves Arabic");
  assert.equal(offer.textContent, "Moved Kaikki English to English.");
});

test("another language's library links to its pack's recommended dictionaries instead of the Japanese installer", async t => {
  const packs = { ar: { host: { recommendedDictionaries: [
    { name: "Kaikki Arabic-English", url: "https://github.com/yomidevs/kaikki-to-yomitan", description: "Wiktionary", licence: "CC BY-SA 4.0" },
    { name: "Unsafe", url: "http://example.com/x.zip", description: "not https" },
  ] } } };
  const settings = await open(t, { hash: "#add-dictionaries", stored: withProfiles(), packs });
  const { el } = settings;
  await settle(50);
  assert.equal(el("recommended-starter").hidden, true, "the Japanese catalogue is for the Japanese profile");
  assert.equal(el("recommended-language-heading").textContent, "Recommended Arabic dictionaries");
  const links = [...el("recommended-language-list").querySelectorAll("a")].map(link => [link.textContent, link.href]);
  assert.deepEqual(links, [["Kaikki Arabic-English", "https://github.com/yomidevs/kaikki-to-yomitan"]]);
  el("settings-language-select").value = "ja";
  el("settings-language-select").dispatchEvent(new settings.window.Event("change", { bubbles: true }));
  await settle(50);
  assert.equal(el("recommended-language"), null);
});
