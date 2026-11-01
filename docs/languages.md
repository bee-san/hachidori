<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Languages and profiles

Status: design for review (Phase 1, revision 8). Nothing described here is
implemented yet.

Hachidori is a Japanese dictionary today. This document describes how it
becomes a dictionary for many languages without becoming worse at Japanese:
each language is a **profile** the user switches between in one click, every
language is described by a **language pack** in the engine, and settings and
themes follow the capabilities of the profile's language.

The engine side (pack format, deinflection rules, lookup API, conformance
test) is specified in hoshidicts'
[`docs/languages.md`](https://github.com/bee-san/hoshidicts/blob/feat/multi-language/docs/languages.md),
referred to below as *the engine contract*. The inventory this design was
built from, every setting, feature and theme hook with its language
assumption, is [Appendix: inventory](languages-inventory.md). Hard choices
are recorded in [`docs/decisions/`](decisions/).

## Contents

1. [What users get](#1-what-users-get)
2. [Terms](#2-terms)
3. [What belongs to a profile](#3-what-belongs-to-a-profile)
4. [Storage](#4-storage)
5. [The profile layer](#5-the-profile-layer)
6. [Migration of existing installations](#6-migration-of-existing-installations)
7. [Capabilities and settings](#7-capabilities-and-settings)
8. [Reading pages in a language](#8-reading-pages-in-a-language)
9. [The engine](#9-the-engine)
10. [Rendering text in a language](#10-rendering-text-in-a-language)
11. [The language-aware theme contract](#11-the-language-aware-theme-contract)
12. [Anki](#12-anki)
13. [Pronunciation audio](#13-pronunciation-audio)
14. [Dictionaries per profile](#14-dictionaries-per-profile)
15. [Personal dictionary, lookup counts and known words](#15-personal-dictionary-lookup-counts-and-known-words)
16. [Choosing and switching languages](#16-choosing-and-switching-languages)
17. [Backup, restore and sharing](#17-backup-restore-and-sharing)
18. [Tests](#18-tests)
19. [Performance](#19-performance)
20. [Adding a language to Hachidori](#20-adding-a-language-to-hachidori)
21. [Known limits](#21-known-limits)

## 1. What users get

- **First run asks which language.** The welcome card has a language choice,
  Japanese by default. Japanese keeps today's automatic setup. Other languages
  get links to recommended dictionaries and an import button.
- **Each language is a profile.** A profile holds its dictionaries (which
  ones, their order, their tab groups), deinflection, scanning and text
  options, Anki Templates (note type, fields, deck), pronunciation sources,
  popup theme and Design settings, and the settings its language defines.
- **One click to switch.** The toolbar popup lists the profiles; the browser
  shortcut **Switch to the next language** (suggested Alt+Shift+L) cycles
  them; the toolbar badge shows the active one when there is more than one.
  Each browser keeps its own active language. Optionally, Hachidori picks the
  profile for each lookup from the page's or element's `lang` attribute.
- **Settings follow the language you edit.** Settings shows one profile at a
  time, chosen in its own menu, without changing the language you read in. A
  setting that does not apply to the language (pitch accent for English, the
  clicked-kanji dictionary for Arabic) is hidden. Its stored value is kept and
  has no effect. Settings shared by every language say *All languages*.
- **Every theme works in every language.** Themes receive the language with
  every render; right-to-left text keeps its direction even in a theme that
  knows nothing about it.
- **Existing users see no change in lookups, popups, mining, backups or stored
  data** until they add a second language. Their settings and dictionaries
  become the Japanese profile. They do see where to add a language: a
  **Language** menu in the Settings sidebar and one new browser command,
  *Switch to the next language*, which has no suggested key.

The user interface stays in English.

## 2. Terms

- **Language pack**: the description of one language in
  `third_party/hoshidicts/languages/<code>/`. Hachidori ships a generated copy
  in `extension/vendor/languages/`.
- **Profile**: a language plus the user's settings and dictionaries for it.
  Version 1 allows one profile per language, whose id is the language code;
  the data model allows more later.
- **Active profile**: the profile this browser looks words up in. Each
  installation has its own (section 4.4).
- **Edited profile**: the profile a Settings page shows and saves to. It
  starts as the active profile and changes only in that page's menu.
- **Profile in effect**: the profile a particular lookup uses: the active
  profile, unless automatic switching picked another for that page element.
- **Capability**: a feature a language has (section 7.1). Packs declare
  them; settings and popup features require them.
- **Language-scoped data**: user data that belongs to a language rather than
  to a profile: the personal dictionary, lookup counts, known and ignored
  words.
- **Held language**: a language for which the records have a profile, a
  personal package, a personal document with text, a lookup-count entry, or a
  marks entry with a word (section 4.3).
- **Single-profile shape**: the stored records of an installation whose only
  profile is Japanese and which holds no other language: exactly today's
  records (section 4.5).

## 3. What belongs to a profile

| Scope | What | Why |
| --- | --- | --- |
| Profile | Dictionaries enabled, their order and tab groups; scan length, maximum results, the language text gate, personal-dictionary switches, metadata-only results; frequency sorting and its dictionary; definition blur; word highlighting; lookup-count display; Anki Templates; pronunciation sources, autoplay and the audio button; popup theme, colours, opacity, columns and every Design content setting; custom buttons and links; the clicked-character dictionary; pack settings | These differ by language: a Japanese and an English dictionary, a JLPT deck and a vocabulary deck, a Japanese and an English voice. |
| Language | Personal dictionary source and its package; lookup counts; words marked known or ignored | They are facts about words of a language, shared by every profile of it. |
| Package | Title, files, revision, update source and schedule, display name, favourite, source and target language | A dictionary is one thing however many profiles use it. |
| Installation | Active profile; automatic switching | Each browser, and GameSentenceMiner's overlay, reads its own language. |
| Global | Enable lookups; lookup mode, activation key and delays; hide-on-exit; nesting depth; keybinds; popup width, height, scale and toolbar position; source highlight; Custom CSS and JavaScript; AnkiConnect address and key; smaller Anki cards; experimental flags; memory and storage modes; automatic backups; the update schedule; sharing; search button | They describe the reader's hands, screen and machine, not a language. |

Appendix A lists every option key with its scope and reason.

## 4. Storage

All writes still go through the service worker's serialised storage queue.
The existing records gain profile structures, and one installation-local key
is added.

### 4.1 `options`

```json
{
  "revision": 57,
  "hoverEnabled": true,
  "lookupMode": "activationSticky",
  "keybinds": [],
  "anki": {"url": "http://127.0.0.1:8765", "apiKey": ""},
  "profiles": [
    {"id": "ja", "language": "ja", "settings": {"scanLength": 16, "popupTheme": "jl", "anki": {"templates": []}}, "packSettings": {}},
    {"id": "ar", "language": "ar", "settings": {"scanLength": 16, "popupTheme": "jl"}, "packSettings": {"vowelMarks": "hide"}}
  ]
}
```

- Global keys stay at the top level, as today.
- Profile keys live only in `profiles[].settings`. A missing key takes its
  `DEFAULT_OPTIONS` value, as a missing key does today.
- `anki` is split: `url` and `apiKey` at the top level, `templates` in the
  profile.
- `packSettings` holds the values of the pack's own settings (section 7.5).
- `profiles` is not an option key: it is not in `DEFAULT_OPTIONS`, and only
  the profile requests and the profile-aware writer (section 5.2) write it.
- One `revision` covers the whole record, so every write keeps today's
  compare-and-set behaviour.

### 4.2 `dictionaryState`

```json
{
  "schemaVersion": 2,
  "revision": 31,
  "dictionaries": [
    {"id": "9f0c…", "title": "Jitendex.org [2026-08-11]", "displayName": null, "favorite": false, "path": "/dicts/.hdw-generation-…",
     "language": "ja", "targetLanguage": "en", "termCount": 298131}
  ],
  "profiles": {
    "ja": {"dictionaries": [{"id": "e4c2…", "enabled": true}, {"id": "9f0c…", "enabled": true}], "groups": []},
    "ar": {"dictionaries": [{"id": "77ab…", "enabled": true}], "groups": [{"id": "g1", "name": "Main", "dictionaryIds": ["77ab…"]}]}
  }
}
```

- `dictionaries` lists every package once, with its identity and package-wide
  presentation (display name, favourite, update metadata). It does not carry
  `enabled`; its order is installation order. Package rows gain
  `targetLanguage` from the index (`language` is today's `sourceLanguage`).
- `profiles[id].dictionaries` is that profile's ordered list with each
  package's `enabled` flag: lookup order, as the single array is today.
- `profiles[id].groups` are that profile's tab groups. Group ids stay unique
  across profiles.
- A package may appear in several profiles, or in none. A package is loaded
  when it is enabled in any profile (section 9.2).

### 4.3 Language-scoped records

- `customDictionarySource` keeps the Japanese document at its top level, as
  today, and gains `languages: {"<code>": {revision, semanticRevision, text}}`
  for other languages.
- `lookupStats` rows keep today's key `lookupStats:<generation>:<[term, reading]>`
  in every language, because the generation names the language. The
  descriptor's top-level `generation` is Japanese's alone; it gains
  `languages: {"<code>": "<generation>"}` for other languages, each entry
  created with the language's first row in the same serialised write, as
  today's first row creates `generation`. Erasing Japanese's counts replaces
  the top-level generation, erasing another language's replaces its entry,
  one revision up, and a reset replaces the top-level generation and drops
  `languages`. Every path that deletes rows outside the live generations
  keeps the rows of the top-level generation and of every `languages` entry:
  `hd_lookup_stats_cleanup` and the unlink cleanup in
  `hd_sharing_client_unlink`, which share one helper in `lookup-stats.js`. A
  restore gives every restored language a fresh entry, and `hd_backup_cas`
  refuses an entry equal to a current one, as it does for the top-level
  generation. Rows of an erased or dropped language therefore never share a
  live prefix, and today's cleanup and
  backup reader stay correct after the records convert back to the
  single-profile shape, which drops `languages`. A reader re-reads the counts
  of the terms it shows in a language whose generation changed (an empty
  generation gives 0) and leaves other terms alone. The Japanese view is the
  descriptor without `languages`, which older readers ignore anyway, so no
  reply needs projecting.
- `wordStatusOverrides` keeps `known` and `ignored` for Japanese and gains
  `languages: {"<code>": {"known": [], "ignored": []}}`.
- **Writers.** Every write of these three records changes only the addressed
  language's part and keeps the rest of the record, `languages` included,
  through one helper in the module that owns the record
  (`custom-dictionary.js`, `lookup-stats.js`, `word-status-overrides.js`), as
  `applyOptionsPatch` is for `options`. The writers are `hd_custom_cas` (and
  through it the engine's `hd_custom_save` and `hd_custom_append`),
  `hd_lookup_stats_record`, `hd_word_status_override`, the erase in
  `hd_profile_cas` and the restore in `hd_backup_cas`. Older linked clients'
  writes reach the same handlers on the host, so they keep other languages'
  data too.
- `ankiDuplicateIndex` keeps today's single-snapshot record while one source
  exists, and holds one snapshot per source key once two profiles' first
  Templates have usable sources (section 12).

### 4.4 `languageSelection` (installation-local)

```json
{"revision": 4, "activeProfileId": "ar", "autoSwitch": false}
```

A new key, written only once the records have profiles, by
`hd_language_selection_write` (section 5.2). It is not in the sharing mirror
(`SHARED_STATE_KEYS`) and not in backups, so every browser, linked or not, and
GameSentenceMiner's overlay choose their own language. When it is absent or
names a profile that does not exist, the active profile is the Japanese
profile, or the first profile when there is none. Converting back to the
single-profile shape, a restore that yields it, or an unlink whose restored
records are in it removes the key. Linking captures the browser's own
selection with its other local records only when the key exists, so a
single-profile link stores the same bytes as today, and unlinking puts it
back.

### 4.5 The single-profile shape

While an installation has exactly one profile, it is Japanese, and no other
language is held (section 2), every record keeps exactly today's shape: no
`profiles`, `dictionaryState`
`schemaVersion` 1, no `languages` maps, no `languageSelection`. The profile
layer reads such records as one Japanese profile (section 5.1).

**The single-profile invariant.** In the single-profile shape, every stored
record, every runtime message, every sharing frame, every backup, every engine
request and the popup's markup are byte-identical to today's. New message
fields (`profileId`), engine options (`language`, `dictionaries`,
`languageOptions`), the sharing capability, `lang`/`dir` additions and
`data-hd-*` attributes appear only once the records have profiles. This is
what lets every existing test suite pass unchanged (section 6.2) and keeps
Japanese-only users exactly where they are.

The new shapes are written by the first write that needs them: adding a
second profile, or choosing another language at first run. Adding a second
profile moves the record's profile keys into a profile with id `ja`, splits
`anki`, and turns the dictionary array into the package list (same order)
plus `profiles.ja` (same order, same `enabled` flags, same groups), keeping
every value. Choosing another language at first run, before anything is
installed (section 16.1), moves the stored profile keys, edits made before
setup included, into that language's profile instead and applies the pack's
replacements of section 6.3. The records convert back when one Japanese
profile remains and no other language is held (section 16.5).

## 5. The profile layer

The profile layer lives in `reader-options.js`, which every runtime context
already loads, so no context gains a script it might miss. Language
descriptors come from the two generated registry scripts of section 9.1,
classic scripts that set `globalThis.HDLanguages`:

- extension pages (Settings, startup, search, toolbar, the offscreen
  document) load `registry.js` with a classic `<script>` tag before their
  modules (Settings loads `reader-options.js` with a tag too; startup and
  toolbar import it in their modules); the jsdom harnesses run pages with
  `runScripts: "outside-only"`, so the tag is inert there;
- the manifest's content scripts list `registry-reader.js` before
  `reader-options.js`; it holds only the fields the reader uses, within a
  budget of 64 KB for every pack together, because every frame of every page
  parses it;
- the service worker and the engine workers import `registry.js` statically,
  and
  `engine-service.js` also imports `reader-options.js` statically for the
  profile projections; the worker harness strips every import, which is
  harmless because the worker reads the registry only when records have
  profiles or a profile is being added;
- the Design preview (`design-preview.html`) loads `registry.js` with a
  `<script>` tag;
- `reader-page.js` injects the manifest's content scripts into the startup and
  search pages after their own `registry.js` has run; `registry-reader.js`
  leaves an `HDLanguages` that is already set in place, so those pages keep
  the fuller copy.
- `language-settings.js` (section 7.5) is loaded with a dynamic `import()`
  only when the edited profile's pack declares settings; the Japanese pack
  declares none.

Code that finds no `HDLanguages` treats the installation as Japanese-only (no
welcome language menu, no **Add a language** list). The single-profile shape
needs neither the registry nor the profile code paths: its projection is
today's code path, and the Japanese pack has every capability, so nothing is
masked.

### 5.1 Reading

- `HDReaderOptions.profiles(storedOptions)` returns the profile list. A record
  without `profiles` yields `[{id: "ja", language: "ja", settings: <the
  record's own profile keys>, packSettings: {}}]`.
- `HDReaderOptions.projectOptions(storedOptions, profileId, { masked = true })`
  returns flat options shaped exactly like `normaliseOptions`' result: global
  keys from the top level, profile keys from the profile, then capability
  masking (section 7.3) unless `masked` is false. For a single-profile record
  `normaliseOptions(record)` is unchanged and returns exactly what it returns
  today. For a record with profiles, `normaliseOptions(record)` returns the
  projection of the Japanese profile (the profile older code knows), or the
  global keys over Japanese defaults when there is no Japanese profile, and
  new code calls
  `projectOptions` with the profile it needs. Settings renders controls from
  the unmasked projection.
- `HDReaderOptions.profileDescriptor(storedOptions, profileId)` returns
  `{ id, language, packSettings }`; `HDLanguages.get(code)` returns the
  pack's descriptor. The language is never added to the flat options object,
  whose shape existing tests pin.
- `HDReaderOptions.projectDictionaryState(storedState, profileId)` returns the
  schema-1 view of one profile: its packages in its order with its `enabled`
  flags and its groups. `normalizeDictionaryState` in
  `content-dictionaries.js` and the Settings library read it.
- `HDReaderOptions.allPackages(storedState)` returns every package with
  `enabled` meaning "enabled in any profile", for the engine service, managed
  updates and the installer.

### 5.2 Writing

**One writer.** `HDReaderOptions.applyOptionsPatch(storedOptions, patch,
profileId)` applies a flat patch to the stored, unmasked record: global keys
to the top level, profile keys to the named profile, `anki` split as in 4.1.
It keeps `profiles` and every other profile intact. For a single-profile
record it does exactly what today's code does, so no stored byte changes.
Every path that writes `options` uses it:

| Writer | Where | Profile it writes |
| --- | --- | --- |
| Options write `hd_options_write`, including its `packSettings` field (validated against the profile's pack) | background-core.js `optionsWriteResult` | the request's `profileId` |
| Dictionary commits (selection pruning and title migration) | background-core.js `dictionaryCommit` | every profile, each against its own packages and groups |
| Setup's Anki and local-audio detection | background-requests.js `detectFirstRunAnki` | `ja` (Kiku, Lapis, Senren and Local Audio Server are Japanese), unmasked reads |
| First-install selections | background-requests.js `firstInstallSelections` | `ja` (Jitendex, Bee's Ultimate Kanji Dictionary), unmasked reads |
| Overlay seeding and local keys | background.js `seedOverlayModeOptions`; background-sharing.js `composeOverlayOptions`, `localOverlayOptionsValues` | the overlay's own flat record of local keys, laid over every profile's projection (section 17.5) |
| Backup export, restore, prepare, automatic snapshots and the restore compare-and-set | background-backup.js `readBackupPayload`; backup-state.js; backup-automatic.js; background-requests.js `hd_backup_cas` | every profile (section 17.2) |

No writer rebuilds a record with profiles through `projectStoredOptions`.

**Requests without a profile.** Once the records have profiles, every caller
in this version names the profile it means, except an `hd_options_write`
whose patch holds only global keys (the browser command and toolbar switch
for lookups, overlay seeding), which needs no profile in any shape. Any other
request that names none comes from code that predates profiles (an older
linked browser, section 17.4) and always means the Japanese data. When there
is no Japanese profile, reads are answered from the Japanese view (section
17.1), whose only enabled package is the Japanese personal package when it
still exists; lookups get `dictionaries: []` (section 9.3) and find nothing.
Writes to profile options, dictionary state and the personal document are
refused with "This Hachidori has no Japanese profile. Add Japanese in its
Settings, or update the linked browser." The Relay API's profile index 0 is
answered the same way. A request naming a
profile that does not exist is refused; Settings then switches to the active
profile and says why (section 5.3).

**Dictionary state.**

- `hd_state_cas` and `hd_apply_state` from Settings carry `profileId` and a
  schema-1 view of that profile. The worker merges the view into the whole
  state, writing that profile's list and groups and the packages'
  package-wide fields, and leaves other profiles alone. `hd_apply_state`
  merges before the engine loads anything, so the loaded set stays the union.
  A view from a linked client that has not opted in (section 17.3) lists every
  package; merging it keeps the Japanese profile's own packages in the view's
  order with the view's flags and adds another package only if the view
  enables it.
- The engine service's own commits (import, reimport, managed update,
  removal, personal-dictionary compilation, profile addition and removal) read the whole
  record through `hd_state_read` and write it whole: in the schema-2 shape
  `hd_state_cas` carries `{ baseRevision, state: { dictionaries, profiles } }`
  and a lost reply is checked by reading back that whole record (and the
  personal document for custom commits), as AGENTS.md requires. In the
  single-profile shape these messages are today's.
- An import adds the package to the profile it was requested for, bound when
  the request is made: Settings names the edited profile; the recommended
  installer names `ja`. A reimport or update replaces the package's
  generation in every profile that uses it, keeping each profile's order and
  enabled state; a removal removes the package from every profile. Once the
  records have profiles, every `hd_remove` this version sends (**Delete**,
  **Remove**, **Remove all imported dictionaries**) names the edited profile,
  as `hd_state_cas` does, so an `hd_remove` that names none comes from an
  older client (section 17.4). Such a removal is refused when a profile other than
  Japanese uses the package, judged on the snapshot that `hd_remove` commits:
  "This dictionary is used by {Language} on the linked Hachidori. Remove it
  there."
  Every transaction rule in AGENTS.md applies unchanged.
- Selection pruning and title migration run per profile, against that
  profile's packages and groups.

**Profile requests.** `hd_profile_add` and `hd_profile_remove` are engine
mutations, routed like `hd_apply_state` (`MUTATION_TYPES` in `offscreen.js`,
which gives them the mutation lock and refused reads), because they change
what the engine loads. Under the mutation lock the engine loads the pack
(`hdw_language_load`) and strict-loads every package that enters the loaded
set (a re-added language's personal package among them); the worker's
`hd_profile_cas` writes `options` and `dictionaryState` in one
compare-and-set; the engine publishes, and only then unloads the packages
that left the set (after a language is removed; after the last other
language, the set is the Japanese packages again). Like the engine's other
commits, a profile request recomputes and retries when `hd_profile_cas` meets
a conflict (`STORAGE_ATTEMPTS`), so an unrelated toolbar or Settings write
does not fail it. A lost `hd_profile_cas` reply is checked by reading back
every record it wrote. On failure the committed state and loaded set are
restored. Neither request compiles
anything. **Also erase…** (section 16.5) is the flag `erase` of
`hd_profile_remove`: the same compare-and-set also writes the language's
emptied personal document (which keeps its monotonic revision),
`dictionaryState` without its personal package, and the records without the
language's `wordStatusOverrides.languages` and `lookupStats.languages`
entries, so the language is no longer held (section 2); for Japanese it
empties the top-level marks and replaces the top-level generation. The rows
of the dropped generation are then deleted as `hd_lookup_stats_cleanup`
deletes unreachable rows. `hd_profile_cas` derives
the new count entry and the marks inside the worker's storage queue, as
`hd_lookup_stats_reset` does, and compares only `options`, `dictionaryState`
and the personal document, so ordinary browsing in other tabs does not make
it conflict; after a lost reply it checks those three exactly and the other
two by effect (the language has no count or marks entry; for Japanese, the
top-level generation differs from the replaced one and the top-level marks
are empty).

The messages are `hd_profile_add { language, copyFrom, firstRun? }`, where
`copyFrom` is the profile whose settings the new one copies (section 6.3:
Settings sends the edited profile, the startup page the active one), and
`hd_profile_remove { profileId, erase? }`, or
`hd_profile_remove { language, erase: true }` to erase a held language that
has no profile (section 16.3).
`hd_language_selection_write { baseRevision, activeProfileId?, autoSwitch? }`
writes the installation-local `languageSelection` and is never forwarded to a
sharing host.

### 5.3 Settings edits one profile

A Settings page has its own edited-profile id, chosen in its Language menu
and initialised from the active profile. It changes because of a storage event
only when the edited profile is removed elsewhere: the page then switches to
the active profile and says so. Its saved, saving, pending and conflict states are keyed by that id,
and every write it sends names it, so a profile switch from the toolbar or the
shortcut cannot move an edit to another profile. Choosing another profile in
the menu first saves the page's pending edits, so no draft of a global key is
left behind under the previous profile; if that save meets a conflict, the
menu stays on the current profile until the user settles it (**Save my
changes** or **Use saved settings**). **Use for lookups** beside the menu
activates the edited profile; choosing a profile in the menu does not.

### 5.4 Requests made for a profile

Once the records have profiles, these requests carry the `profileId` of the
profile in effect (or, from Settings, the edited profile), and the worker,
engine service and Anki worker resolve options with
`projectOptions(stored, profileId)`:

- engine lookups: `hd_lookup`, `hd_lookup_dictionary`, `hd_segment`,
  `hd_kanji`, including Settings' frequency-direction probe and the startup
  practice probe;
- pronunciation: `hd_audio_play`, `hd_audio_candidates`;
- Anki: every `hd_anki_*` request (status, view, preflight, batch preflight,
  submit, browse, fields, maturity, word status) and the Relay API's card
  formats;
- counts and marks: `hd_lookup_stats_record`, `hd_lookup_stats_read`,
  `hd_word_status_override`;
- the personal dictionary: `hd_custom_read`, `hd_custom_cas`,
  `hd_custom_save`, `hd_custom_append`;
- imports: `hd_import`.

A Template id is unique within its profile, and Templates copied into a new
profile get new ids (section 6.3), so a request that lost its profile on the
way fails with "The selected Anki Template is no longer available" instead of
mining into another profile's deck.

## 6. Migration of existing installations

### 6.1 Nothing is rewritten

Because of the single-profile shape, upgrading writes nothing. The stored
`options`, `dictionaryState`, personal dictionary, lookup counts and marked
words are read as the Japanese profile, with every value exactly as stored.

### 6.2 What proves identical behaviour

- Every existing test suite passes without changes to its files: lint, Node
  contracts, the three WebAssembly smoke variants, the extension smoke suite,
  `chrome-e2e`, `chrome-sharing`, `chrome-fallback`, `chrome-overlay`,
  `chrome-theme-contrast`, `firefox-e2e` and `firefox-lint`.
- hoshidicts' three Japanese parity tests: deinflection, text processing and
  whole lookups compared with today's code (engine contract, section 11.3),
  and Yomitan's complete Japanese conjugation corpus.
- `test/profiles.test.mjs` checks that every stored record shape the existing
  suites use projects to the output of today's `normaliseOptions`, recorded as
  golden files before the change; that a single-profile installation sends
  byte-identical engine requests, runtime messages and sharing frames; and
  that no write happens on upgrade.

A Japanese-only user sees two additions, both outside what the suites pin:
the Settings sidebar's **Language** menu with **Add or remove languages**, and
the browser command *Switch to the next language* in Keybinds → Browser
shortcuts, on Chrome's shortcuts page and in the keybind action list. The
command has no suggested key, so it takes no key from pages. Everything else
that appears with a second language (the toolbar row, *All languages* notes,
automatic switching, **Use for lookups**, *{Language} options*) is rendered at
run time only when the records have profiles, so it is not in the static
markup and Settings search cannot find it while it does not apply.

If an existing test pins a detail this design would change for a Japanese-only
installation, the design changes, not the test. For example, `chrome-e2e`
pins the nine Settings rail links, so language management is not a new rail
section; the extension smoke suite pins the welcome card's text and action
ids, so the language choice sits outside them (section 16.1).

### 6.3 New profiles

Adding a profile copies the edited profile's profile settings, so the new
language looks and behaves like the one the user already set up, and then
replaces the language-bound ones. Settings first saves its pending edits, as
choosing in the menu does (section 5.3), so the copy includes them, and then
edits the new profile. Lookups stay in the active profile, so the dialog's
success line offers **Use for lookups**.

- dictionaries: none; groups: none; dictionary selections (frequency,
  clicked character, compact summary, pitch, blur frequency, image source):
  unset;
- Anki: the Templates with new ids, their note types and field mappings, and
  an empty deck. Until the user chooses a deck, the Anki button says so and
  links to Settings → Anki;
- audio: one browser speech source in the pack's language (`text-to-speech`
  for packs without readings, `text-to-speech-reading` otherwise);
- custom buttons: none, since they usually link to a language's websites;
- the pack's `settings` defaults.

## 7. Capabilities and settings

### 7.1 Capabilities

A profile's capabilities are the pack's (engine contract, section 4.6), with
optional capabilities on only when a pack setting turns them on:

| Capability | Japanese | What depends on it |
| --- | --- | --- |
| `readings` (`required`, `optional`, `none`) | `required` | Note form Reading field; `{reading}` in the marker list; the reading line in the popup. |
| `ruby` (`kana`, `syllable`, `word`, or none) | `kana` | Furigana over the headword; `{furigana}`, `{furigana-plain}`, `{sentence-furigana}`, `{sentence-furigana-plain}`; the KANJIDIC furigana split (`kana` only). |
| `pitchAccent` | yes | Every pitch display option and the pitch, position, category and graph markers. |
| `characterView` | Kanji, On/Kun | Clickable characters, the character view, the clicked-character dictionary, `{character}`, `{onyomi}`, `{kunyomi}`, `{stroke-count}`. |
| `wordHighlighting` | yes | The Word highlighting section, its settings, keybinds and commands. |

Every pack also has a text gate, sentence rules, a direction, a speech
language and a personal dictionary; those are data, not capabilities.

### 7.2 Where generalising is honest

- **Character view: one capability.** Japanese kanji, Chinese hanzi and Korean
  hanja are all single characters looked up in Yomitan `kanji_bank`
  dictionaries. The pack supplies which characters are clickable and what the
  two reading columns are called (On/Kun, Pinyin, Eum/Hun). The view, Back
  and the dictionary choice are shared code.
- **Readings and ruby: one capability with alignment modes.** Japanese
  furigana distributes a kana reading around the kana of the spelling;
  Korean hanja and spaced pinyin give one syllable per character; other
  readings sit over the whole word.
- **Not generalised: pitch accent.** It is Japanese mora pitch. Chinese tones
  and English stress are different data; until a pack needs them they show
  only through readings and IPA.
- **Not generalised: kana conversion, the KANJIDIC split, Japanese Anki note
  types, the Sanseido and Jitendex summary heuristics.** They stay Japanese
  code, reached only through the Japanese pack's capabilities and data.

### 7.3 Hidden, kept, inert

`reader-options.js` gains one table, `OPTION_REQUIREMENTS`, mapping each option
key that needs something of the language to the requirement and to its
**neutral value**. A requirement is a capability name, `{ "scripts": [...] }`
(the pack's `scripts` include one of them, where `Hani` matches every code that
includes Han: `Hani`, `Hans`, `Hant`, `Hanb`, `Jpan`, `Kore`), or
`"ankiNoteTypeFamilies"` (the pack lists note-type families, section 12):

```js
const OPTION_REQUIREMENTS = {
  showPitchAccentFurigana: { requires: "pitchAccent", neutral: false },
  pitchAccentFuriganaDictionary: { requires: "pitchAccent", neutral: "" },
  pitchAccentFuriganaStyle: { requires: "pitchAccent", neutral: "contour" },
  showPitchAccentBadge: { requires: "pitchAccent", neutral: false },
  showPitchAccentDictionaryNames: { requires: "pitchAccent", neutral: false },
  showPitchAccentText: { requires: "pitchAccent", neutral: false },
  showPitchAccentPosition: { requires: "pitchAccent", neutral: false },
  showPitchAccentGraph: { requires: "pitchAccent", neutral: false },
  showPitchAccentColors: { requires: "pitchAccent", neutral: false },
  kanjiClickDictionary: { requires: "characterView", neutral: "" },
  wordHighlightEnabled: { requires: "wordHighlighting", neutral: false },
  wordHighlightUnknown: { requires: "wordHighlighting", neutral: true },
  wordHighlightLearning: { requires: "wordHighlighting", neutral: true },
  wordHighlightKnown: { requires: "wordHighlighting", neutral: false },
  wordHighlightIgnored: { requires: "wordHighlighting", neutral: false },
  wordHighlightStyle: { requires: "wordHighlighting", neutral: "underline" },
};
```

For a profile without the requirement:

1. **Hidden**: Settings hides the control (and its group when every control in
   it is hidden); search skips it; the keybind editor does not offer it as a
   Toggle option argument; the Design preview does not show it. Word
   highlighting hides as a whole: its Reading tab, its section picker option,
   and a `#word-highlighting` link resolves to `#lookup`, as gated
   experimental sections do. Requirement-bound controls carry `data-requires`,
   and Settings search skips `[data-requires][hidden]`, as it skips
   `[data-design-setting][hidden]`; a shown control stays searchable.
   Keybinds are global and their Toggle option targets are profile keys: the
   reader writes the toggle to the profile in effect of the popup it acts on,
   or to the active profile in the page scope, and sends nothing when that
   profile does not meet the key's requirement. The keybind editor keeps every
   stored bind (normalisation keeps arguments in `KEYBIND_TOGGLE_OPTIONS`, as
   today), offers only met keys as new arguments, and shows a stored bind
   whose key is masked in the edited profile as *Not available in
   {Language}*.
2. **Kept**: hiding, profile switching and restore never write the stored
   value. An explicit **Reset Design to defaults** resets every Design key of
   the edited profile, hidden or not, as it resets theme-hidden keys today.
3. **Inert**: `projectOptions` replaces the value by its neutral value, so
   every consumer behaves as if the setting were off without knowing about
   capabilities. Two neutral values mean "Automatic" rather than off:
   `kanjiClickDictionary: ""` and `pitchAccentFuriganaDictionary: ""`. They
   are inert because a profile without a character view offers no clickable
   characters and every pitch switch is masked; `profiles.test.mjs` checks
   both.

Settings controls carry `data-requires` attributes written into
`settings.html`; `test/profiles.test.mjs` checks that they and
`OPTION_REQUIREMENTS` agree. Design's theme filter (`designSettings`) still
applies (section 11.5). The Japanese pack meets every requirement, so nothing
is hidden or masked for the Japanese profile.

### 7.4 Labels that name the language

Labels that say "Japanese" today name the edited profile's language instead
(the active profile's on the toolbar). For the Japanese profile every string
is exactly today's:

| Today | In a profile for {Language} |
| --- | --- |
| "Japanese text only" (`settings.html:543`; the Toggle option label in `keybind-settings.js:7`) | "{Language} text only" (the key stays `onlyScanJapaneseText` and now means text matching the pack's `text.pattern`) |
| "Hover over Japanese text to scan" (toolbar hint) | "Hover over {Language} text to scan" |
| "Your Japanese library starts here" (empty library) | "Your {Language} library starts here" |
| The Activation, Personal dictionary and Word highlighting hints that say "Japanese text" | the same with {Language} |
| "Clicked-kanji dictionary", "Look up kanji X" | the pack's `characterView.name` ("Clicked-hanzi dictionary") |

The manifest's static strings ("Study Japanese vocabulary…", "Turn Japanese
lookups on or off") cannot vary and are pinned by existing tests. They stay;
section 21 lists them.

### 7.5 Settings a pack defines

A pack's `settings` (engine contract, section 4.7) appear without any
language-specific code:

- **Where.** Reading → *{Language} options* for `group: "lookup"`, Design →
  *{Language} display* for `group: "display"`. Settings imports
  `language-settings.js` only when the edited profile's pack declares
  settings; it renders the rows from the schema, as `experimental-settings.js`
  renders flags, before Settings search builds its index and again when the
  edited profile changes. The fieldsets do not exist for a pack without
  settings, so a Japanese-only Settings page is unchanged.
- **Storage.** `profiles[].packSettings`, written as a patch by id through
  the `packSettings` field of `hd_options_write`, which the worker validates
  against the target profile's pack schema (`validateOptionsPatch` would drop
  it as an unknown option key): ids the host's pack declares are validated,
  ids the patch omits keep their values, and ids the pack does not declare
  are kept and ignored, so linked browsers with older or newer versions of a
  pack do not reset each other's values. Invalid values read as the default.
  Backups carry them.
- **Effects.**
  - Engine effects (`preprocessor`, `transforms`, `variantPass`), allowed only
    on boolean settings, travel with each lookup as `languageOptions`
    (section 9.3).
  - `display` effects are applied by core before rendering: each result gets
    `result.presentation = {expression, reading}` with the display transform
    applied (section 10.4). Anki, the Note form, lookup counts and word status
    keep reading `result.term`, so a display setting never changes what is
    mined, stored or counted. A change re-renders open popups and the Design
    preview under the rules that protect a Note draft, as a dictionary
    presentation change does.
  - `capability` effects turn an optional capability on for the profile, and
    the settings that require it appear.
- **Themes.** A `display` setting shows only while the selected theme declares
  that it renders `presentation` (section 11.3).
- **Keybinds.** Pack settings are not Toggle option targets in version 1.

Examples the format supports: Arabic *Vowel marks in headwords: Show / Hide*
(display), Korean *Hanja character view* (capability), Chinese *Readings:
Pinyin / Zhuyin* (display, with a pinyin-to-zhuyin `map` step).

## 8. Reading pages in a language

### 8.1 Which profile a lookup uses

The content script holds the projection of every profile. For each candidate
it chooses the profile in effect:

1. With **Switch language automatically** off (the default): the active
   profile.
2. With it on: the nearest `lang` attribute of the hovered element, or of the
   field or document it belongs to, is matched against the profiles' packs by
   primary subtag (`ja-JP` → `ja`, `zh-Hant` → `zh`); no match leaves the
   active profile. It does not change the active profile.
3. A lookup inside a popup (a child popup over a definition) uses the parent
   lookup's profile. With automatic switching on, the nearest `lang` inside
   the glossary content (a label from section 10.3 or from the labelling
   pass, or the block's default) is matched as in rule 2, and no match leaves
   the parent's profile.
4. The search page, the startup exercise and keybind scans use the active
   profile.

The popup shows the profile in effect only when it differs from the active
one, as a small language label beside the close button.

### 8.2 Text gate

`onlyScanJapaneseText` stays one profile key; its predicate is the pack's
`text.pattern` (for Japanese, today's `JAPANESE_CHARACTER_PATTERN`). The token
and selection gates in `content-scan.js` and the block, run and chunk gates in
`word-highlights.js` read the profile's predicate.

### 8.3 Where a scan starts

For packs with `scanStart: "cursor"` the scan starts at the hovered character,
as today. For `"word"` packs `content-scan.js` moves the start back to the
first character of the hovered word (`text.wordCharacters` and
`wordInternal`), and the source highlight starts there. Exact selections are
not moved. The collected length is `max(scanLength, longKeyLength + 8)` code
points over the profile's enabled packages, capped at 256, as today; under the
engine's word resolution it also reaches the end of the last word (engine
contract, section 9.2).

### 8.4 Sentences and highlight chunks

`sentence.js` takes its terminators and quote pairs from the profile's
`text.sentence`; the Japanese pack carries `sentence.js`'s current tables.
`word-highlights.js` keeps its own chunk breaks, which differ from the
sentence terminators, and takes them from the pack's `text.highlightBreaks`;
the Japanese pack carries `word-highlights.js:39-40` exactly. The
200-character extent and every cutting rule stay.

### 8.5 Other surfaces

- **Search page**: with profiles, the search box and the echoed query take the
  profile's `lang`; for right-to-left packs also `dir="auto"`. The leading
  punctuation the page skips stays.
- **Word highlighting**: each text block is segmented with the profile a
  lookup in that block would use (section 8.1). Profiles without
  `wordHighlighting` show no marks.
- **Netflix (experimental)**: the subtitle track filter takes the pack's
  `bcp47` primary subtag instead of `ja`, and lines are joined with the pack's
  `lineJoiner`.
- **Google Docs (experimental)**: the imposter text gains the hovered run's
  direction, which it lacks today.
- **Text fields**: the imposter already copies the field's computed style,
  direction included. Its clipping assumes a field scrolls to the right, so in
  a right-to-left field a lookup near the clipped edge may miss (section 21).
- **Debug log redaction** keeps today's Japanese pattern and adds the
  `text.pattern` of each other profile's pack, with the pack code as the
  replacement (`[ar]`). A Japanese-only installation's log is unchanged.

## 9. The engine

### 9.1 Packs

`scripts/sync-languages.mjs` copies every pack from the submodule into
`extension/vendor/languages/<code>/` (`language.json`, `transforms.json`) and
writes two classic scripts that set `globalThis.HDLanguages` (section 5):

- `registry.js`, for extension pages and workers: the parts of every
  descriptor that Settings and the other pages need (identity, `text`,
  `capabilities`, `presentation`, `settings`, the speech and audio languages,
  `host.anki.noteTypeFamilies`) and each pack's personal-dictionary id
  (section 15);
- `registry-reader.js`, for content scripts: identity, `text`,
  `capabilities`, `presentation`, `host.sample.warmup` and the pack settings'
  display effects. It sets `HDLanguages` only when it is not already set.

Both hold every pattern and display-transform step with its class references
expanded, by the expansion that hoshidicts' `tools/check-classes.mjs` uses
(`tools/lib/classes.mjs`), which the engine's conformance test compares with
the engine's own parser (engine contract, section 5). Samples other than
`sample.warmup`, and recommended dictionaries, stay in the JSON files, which
Settings and the startup page fetch when they need them. The copy is
committed with each submodule bump, as the
WebAssembly bundles are; `test/language-packs.test.mjs` fails when a copied
file or either script differs from what the submodule gives.

### 9.2 Loading

- The Japanese pack is built into the engine (engine contract, section 10.1),
  so Japanese lookups need no loading. Other packs load from the stored
  records, through the read the engine service already makes at every start
  and reload: once the records have profiles, the `hd_state_read` reply
  carries `languages`, the profiles' language codes, and `reconcile` loads
  every pack that is not loaded (`hdw_language_load`, with the two JSON files
  fetched from the extension) before it publishes. `boot` runs through the
  engine's queue, and every lookup (`hd_segment` one chunk per turn) waits
  behind it, so `hd_status` may say ready while packs load, but no lookup
  runs before they are loaded. A new engine instance
  (a Low memory recycle, the restart after a memory option changes, a browser
  start) therefore has its packs before its first lookup.
- `hd_profile_add`, the first-run choice of another language (the same
  mutation, section 16.1) and a version 4 restore load a new pack before they
  publish. The registry lives outside the object `hdw_reset` rebuilds, so a
  full reload keeps the packs.
- A pack that fails to load is reported by `hd_status` in `failedLanguages`,
  as dictionaries are in `failedDictionaries`; the field appears only once the
  records have profiles; `offscreen.js` sets it in the `hd_status` cache it
  serves during a mutation when the reply has it and deletes it otherwise,
  so the single-profile reply is unchanged. That profile's lookups fail
  with "{Language} could not be loaded." and other languages keep working.
- The loaded dictionary set is every package enabled in any profile, plus the
  load verification of disabled packages that exists today. Loading one
  package for two profiles costs it once.
- The warm-up lookup after loading uses the Japanese pack's `sample.warmup`
  (`食べました`, today's text) when a Japanese profile exists, otherwise that
  of the first profile in the records (the engine cannot see the
  installation-local `languageSelection`).

### 9.3 Requests

The engine cannot read storage, so the profile is resolved where storage is
visible. The worker keeps a map from profile id to the profile's language,
its ordered list of enabled package ids and its pack setting engine effects,
updated by its own `storage.onChanged` listeners. A worker that has just
started builds it from the read `initialiseSharing` already makes at worker
start, which gains `options`; every `relayEngineRequest` already awaits that
read, so a Japanese-only browser gains no storage round trip. Once the records
have profiles, `relay()` (`background-core.js`) resolves the four lookups
addressed to the engine (`hd_lookup`, `hd_lookup_dictionary`, `hd_segment`,
`hd_kanji`); on a linked browser `relayEngineRequest` forwards them to the
host before they reach `relay()`, so the host resolves them. Every caller is
covered:

- a request that names a profile (section 5.4) gets that profile's
  `language`, `dictionaries` and `languageOptions`;
- a request that names none means the Japanese data (section 5.2): the
  Japanese profile's keys, or `dictionaries: []` when there is no Japanese
  profile;
- worker-internal callers copy the `profileId` of the request they serve onto
  their sub-requests: the Anki worker's `hd_segment` for sentence furigana,
  and the Relay API host's `hd_lookup` and `hd_kanji`, which name the profile
  that `profileIndex` selects.

The worker sets these keys on every request, replacing any a forwarded
request carried. The engine service maps the package ids to the paths it has
loaded, which it already tracks by id (`loadedManifest`), so a lookup
resolved before a reimport or update swaps a generation, or before the worker
sees the commit, still finds the dictionary. The engine service passes the
keys to the engine (engine contract, section 9.7); a profile without
dictionaries sends an empty list, which selects nothing. In the
single-profile shape none of these keys is sent, so the request reaching the
engine is today's.

### 9.4 Japanese-only work in the engine service

- The KANJIDIC furigana split (`withFurigana`) runs only for profiles whose
  pack has `ruby.alignment: "kana"`.
- The personal-dictionary filter removes the personal package of the profile's
  language.
- The frequency-direction sampler uses the pack's `host.frequencySamples`
  (Japanese keeps today's twenty words) and reports no direction for a pack
  without them, as it does today for every non-Japanese dictionary.

## 10. Rendering text in a language

### 10.1 What is marked, and when

The popup's interface is English. In the single-profile shape nothing in this
section applies: the popup's markup is today's (section 21 lists what that
leaves unfixed). Once the records have profiles:

- **The popup itself.** Each `.gsm-hoshidicts-popup` the content script, the
  search page and the Design preview create gets `dir="ltr"` and `lang="en"`.
  The reader's shadow host resets inherited properties with `all: initial`,
  which does not reset `direction`, and `lang` is inherited through the host,
  so without them the popup takes a right-to-left page's direction (mirroring
  its English buttons and tabs) and the page's language (screen readers then
  read the interface with the page's voice).
- **Language text.** Text in the profile's language is marked where it appears,
  in every theme:

| Text | Left-to-right pack | Right-to-left pack |
| --- | --- | --- |
| Headword, matched text, deinflection endpoints, the character in the character view, the sentence excerpt | `lang` = pack `bcp47` | `lang` and `dir="rtl"` |
| Reading | `lang` | `lang` and `dir="auto"` (a transliteration may be in another script) |
| Note form inputs, search box | `lang` | `lang` and `dir="auto"` |

- **Dictionary text.** Direction and language of definitions belong to the
  dictionary, not to the profile (sections 10.2 and 10.3), so a right-to-left
  dictionary is marked in any profile: an English-to-Arabic dictionary in an
  English profile as much as an Arabic one in an Arabic profile.
  `glossaryAttributes` returns the dictionary's `targetLanguage` as `lang` in
  every profile, as it returns `dir`, together with
  `data-hd-lang-default`, which marks that `lang` as a default taken from the
  index rather than from the text.
- **Labelling pass.** Themes write text into their own elements (text-mode
  definitions, definition tags, the character view's readings and meanings)
  that no rule above labels. Under the popup's `lang="en"`, or a dictionary
  block's default `lang`, that text would read as the wrong language. Core
  therefore walks every text node whose nearest `lang` is the popup's own or a
  default from `glossaryAttributes`. It gives such a node a language from its
  characters and, when that differs from the language the node inherits, puts
  it on the node's parent. In the Japanese profile the test is today's
  `JAPANESE_TEXT_PATTERN`; in other profiles it is section 10.3's steps 2 to
  6 in order, where step 5 is the language the node inherits, so it adds no
  label. Labels from a dictionary's own structured content or from section
  10.3 stay as they are. A node that holds several lines (a text-mode
  definition, where the flattener writes each paragraph and each glossary
  string on its own line) is labelled line by line: a line whose language
  differs from the inherited one moves into a `span` with that `lang`, and
  the other lines stay plain text, so each line is labelled like a glossary
  string. This applies to every such node the pass visits, inside a
  dictionary's block or not (JL's and Bee's character view writes meanings,
  readings and statistics into one element); text that themes update in
  place (names, frequency values, pitch markers) is one line.
  docs/themes/README.md says that core may wrap lines of text in
  `span[lang]`. A line that mixes scripts
  (`See also 食う`,
  `[他動] to have (a meal)`, JL's `; `-joined rows) takes the language its
  characters give, a text-mode limit (section 11.2). The theme host runs the
  pass after every theme method that renders or updates content (`call()` in
  `theme-host.js`, so `renderKanji` and `renderNotice` too), after
  `onResultsExpanded` and after `updateDictionaryPresentation`, each time
  after a synchronous `takeRecords()`, so a render's first frame is labelled.
  It also runs from the `MutationObserver`'s own callback, at the microtask
  checkpoint after any task that changed the popup and before the next frame,
  so content a theme adds later (Default's deferred glossary fills, its tab
  re-renders, **Show more**, any theme's own timers) is labelled too. It walks
  only the subtrees added or changed since the last pass and takes the
  records of its own writes after writing, so a tab selection that adds
  nothing costs nothing. It needs nothing from themes, covers undeclared ones, and leaves
  the English interface alone in Latin-script profiles. For
  32 Jitendex-sized results it visits 32 to 2,244 text nodes, depending on the
  theme, in at most 2 ms; the labels it adds cost more in layout, which
  section 19 measures.
- **Names.** Dictionary titles, display names, group names and frequency
  labels whose text contains a right-to-left character are isolated: themes
  put the name alone in an inline element with `dir="auto"` (as `<bdi>`
  does), never on a box that layout can widen, and text-mode themes wrap it in
  U+2068 … U+2069. A name in one of the pack's scripts also gets the pack's
  `lang`.

Each `.gsm-hoshidicts-popup` element (not the shadow host, which several open
popups share) also gets `data-hd-language` and `data-hd-direction` and the
custom properties `--hd-language-font-family`, `--hd-language-word-break` and
`--hd-language-line-break` from the pack's typography, each unset when the
pack leaves it null (the Japanese pack leaves all three null). Child popups
and the Design preview get their own.

Mirroring the whole popup for an Arabic profile was rejected: its words,
buttons and tabs are English, and the definitions of an Arabic-English
dictionary are English too (decision record 0004).

### 10.2 Direction of definitions

Once the records have profiles, core decides one direction per dictionary for
each result before rendering: the direction of the dictionary's
`targetLanguage` when its index declares one, otherwise the direction of the
majority of the letters in that dictionary's own gloss strings in the result
(the glossary data, never a theme's composed text with its tags and numbers),
by the rule below. A target language with a pack in this build takes the
pack's scripts and direction. One without (an English-Persian dictionary in a
build with no `fa` pack) takes its script from
`new Intl.Locale(tag).maximize().script` and its direction from that script:
right to left for `Arab`, `Hebr`, `Syrc`, `Thaa`, `Nkoo`, `Adlm` and
Unicode's other right-to-left scripts. When the platform knows no script for
the tag, the dictionary's direction comes from the majority rule, as without
`targetLanguage`, and it keeps its tag for section 10.3. Steps 4 and 5 of
section 10.3 use the same scripts. A dictionary
whose direction is right to left is marked on the element that holds its
block, so numbers, bullets, chips and text turn together; left-to-right blocks
stay unmarked, so Japanese and other left-to-right markup does not change:

| Theme | Element |
| --- | --- |
| Default | `.gsm-hoshidicts-glossary-card` |
| JL, Bee | each `.jl-entry`'s `.gsm-hoshidicts-definitions` (Bee: `.bee-rich-content`) |
| Crystal | `.crystal-senses` |
| Nazeka | `.nazeka-sense` |
| Plain | one element per dictionary |

Inside a dictionary's block, paragraphs of the other direction keep their own:
an Arabic example sentence in an Arabic-English dictionary, an English
etymology in a monolingual Arabic one. Core decides a paragraph's direction
while it renders structured content, by one rule shared with Anki (section
12) and text mode (section 11.2). A block's direction comes from its own
letters (its text outside nested blocks), or from all its letters when it has
none of its own (a wrapper or a list): right to left when more than half of
those letters are right-to-left letters; a block without letters has none.
Core marks a block with `dir` when its direction differs from the one it
inherits (its nearest marked ancestor's, else its dictionary's), and adds
`text-align: start` only when no dictionary style on the block or on an
ancestor inside the glossary sets `text-align`. A list that holds an item of
the other direction is marked while rendering; the labelling pass, with the
popup attached, reads the computed `padding-inline-start` of every marked
list and then writes each one's `padding-inline-end` to match (one style
recalculation, only when a marked list exists), so every item's number stays
inside the card. A paragraph that merely
begins with a word in the other script (`كِتَاب kitāb pl. كُتُب kutub
writing; letter…`, `n. صحائف مجموعة مكتوبة.`) keeps its dictionary's
direction, and left-to-right dictionaries get no marks, so Japanese layouts
do not change. Every theme that uses core's structured-content renderer gets
the rule.

In the Japanese profile of an installation with profiles, the visible
differences from today are the popup's own `lang="en"` and what follows from
it: English glosses on Japanese pages are no longer labelled `ja`, so Crystal
draws them in its serif face rather than Mincho, and in the text-mode themes
the Japanese lines of a definition are `ja` on every page.

Every physical margin, padding and border inside glossary content becomes
logical (`padding-left` → `padding-inline-start` and so on, in `reader.css`
and the themes' glossary rules), including the negative margin that lets
tables inside disclosures reach into the indent, the external-link icon's
margin and Crystal's example rule. The logical forms compute to today's values
left to right.

### 10.3 Language of glossary text

In the single-profile shape and in the Japanese profile, glossary text keeps
today's detection, which labels Japanese text `ja` (`yomitan-parity.test.mjs`
pins it). In other profiles each glossary string takes, in order:

1. the dictionary's own structured-content `lang`;
2. a language detected from characters specific to one script: kana → `ja`,
   Hangul → `ko`, bopomofo → `zh`;
3. the pack's `bcp47` when the string contains characters of one of the pack's
   scripts other than Latin (taken from the pack's `text.pattern`), as today's
   detection labels Japanese strings: an Arabic example in an Arabic-English
   dictionary is `ar`. Han characters count here only when every non-Latin
   script of the pack is a Han script (`Hani`, `Hans`, `Hant`, `Hanb`), as
   for Chinese. `Kore` and `Jpan` also hold Hangul or kana, so a Korean pack
   leaves a Han-only gloss to the later steps;
4. in a profile whose pack is written only in Latin, the profile's `bcp47`
   for a string that has letters, all of them Latin, when the dictionary's
   target language has a pack whose scripts do not include Latin: an English example
   in an English-Arabic or English-Japanese dictionary is `en`;
5. the dictionary's `targetLanguage`, except for Han characters or CJK
   punctuation alone when the target language is not written with Han (its
   pack's scripts do not include Han, and it is not `ja`, `ko` or `zh`);
6. for Han characters or CJK punctuation alone, the profile's `bcp47` when the
   pack's `scripts` include Han, where `Hani` matches every code that includes
   Han (`Hani`, `Hans`, `Hant`, `Hanb`, `Jpan`, `Kore`): 學校 in a
   Korean-English dictionary is `ko`, and in a Korean-Chinese one step 5 gives
   `zh`;
7. otherwise no `lang`.

Korean definitions with hanja and Chinese definitions with `，` are therefore
never labelled Japanese, and in a Chinese profile a Japanese example
(`学校へ行きます。`) stays `ja` and a Korean gloss stays `ko`.

### 10.4 Display transforms

Before a render, core builds `result.presentation` for each result when the
profile has an active `display` setting: the headword and reading with the
setting's display transform applied, using the step kinds of the engine
contract (`case`, `normalize`, `strip`, `map`, `pattern`) implemented in
`language-text.js`. Without such a setting no `presentation` is built.

### 10.5 Default renderer

- The headword's `lang` comes from the profile, as section 10.1 says; in the
  Japanese profile it is today's literal `ja`.
- The headword builder follows `ruby`: `kana` keeps `appendExpressionRuby`
  exactly; `syllable` and `word` draw one ruby per syllable or over the word;
  without ruby, a reading that differs from the headword shows as a reading
  line beside it.
- Clickable characters use the pack's `characterView.pattern`; without a
  character view nothing is clickable. The Japanese pattern is today's
  `HAN_CHARACTER_PATTERN`.
- The character view's labels (On, Kun, Meanings) and the links' "Look up
  kanji X" come from the pack's `characterView`.
- The Note form's Reading field is required, optional or hidden according to
  `readings`.
- Fonts and line breaking read the custom properties of section 10.1, with
  today's values as fallbacks.

## 11. The language-aware theme contract

Themes keep the version 2 view contract (docs/themes/README.md). This section
adds to it.

### 11.1 What a view receives

`createView(options)` gets `options.language`, and every render context gets
`context.language`, for the profile the render is for:

```js
{
  version: 1,
  code: "ar", bcp47: "ar", name: "Arabic", direction: "rtl", scripts: ["Arab"],
  capabilities: { readings: "none", ruby: null, pitchAccent: false, characterView: null, wordHighlighting: true },
  typography: { fontFamily: null, wordBreak: null, lineBreak: null, joinedScript: true },
  // Host display labels: the pack's presentation.labels with their defaults, and its characterView name,
  // reading labels and reading separator (null without a character view).
  labels: { reading: "Reading", traceMarker: "", readingBrackets: ["(", ")"], senseSeparator: "; ", listSeparator: ", ",
            character: null, onyomi: null, kunyomi: null, readingSeparator: null },
  settings: { vowelMarks: "hide" },
  sampleText: "قرأ",              // the pack's host.sample.warmup, for font warm-up
  sourceAttributes() {},           // attributes for text in this language (section 10.1); {} in the single-profile shape
  readingAttributes() {},          // the same for a reading
  glossaryAttributes(title, result) {}, // dir (right-to-left dictionaries, any profile), lang and data-hd-lang-default for one dictionary's block (10.1-10.3)
  nameAttributes(name) {},         // attributes for the inline element holding a name alone (section 10.1)
  isolate(text) {},                // a name wrapped in U+2068 … U+2069 when it contains a right-to-left character
  isCharacterLink(character) {},   // section 11.6
  display(result, field) {},       // result.presentation[field] ?? result.term[field]; field is "expression" or "reading"
  readingFor(result) {},           // the displayed reading, or "" when it equals the displayed expression
  sliceText(text, start, end) {},  // a slice that never splits a grapheme; UTF-16 units for Japanese, as today
}
```

`readingFor` compares displayed forms. The engine gives every term a reading
(equal to the expression when the dictionary has none), so a theme never needs
to treat an empty reading specially.

Two consecutive renders can carry different languages when automatic
switching is on, so a view reads `context.language` on every render;
`options.language` is for one-time work such as font warm-up. Fields are added
within `version: 1`, and a theme ignores fields it does not know. The theme
host injects the Japanese descriptor only when a caller passes none, which
keeps the existing theme tests (which pass none) on today's behaviour; a test
asserts that `content.js` and `design-preview.js` always pass the profile's
language.

### 11.2 Shared components

`components.language` exposes the functions above without a context, for code
that runs outside a render, plus:

- `appendHeadword(document, parent, result, language, onCharacterClick)`: the
  Default renderer's headword and ruby builder;
- `characterEntryResult(character, entry, language)`: today's
  `kanjiEntryResult` with the pack's labels and separator (`kanjiEntryResult`
  stays, for Japanese);
- `glossaryToPlainText(glossary, language, { direction })`: `direction` is the
  dictionary's, `glossaryAttributes(title, result).dir ?? "ltr"`. In the
  single-profile shape, today's flattener exactly. With profiles, the text of
  each paragraph whose direction by the rule of section 10.2 differs from
  `direction` is wrapped, after its list marker, in U+2066 … U+2069 (left to
  right) or U+2067 … U+2069 (right to left), never in U+2068, which takes the
  first strong character. An isolate keeps the paragraph's order but cannot
  change its line's alignment, so in text mode such a paragraph starts at its
  dictionary's side, and a line that mixes scripts takes one language
  (section 10.1). In profiles other than Japanese, tag pills are also
  always followed by a space and bracketed readings use
  `labels.readingBrackets`.

### 11.3 What a theme declares

A theme's catalogue entry in `extension/vendor/themes/index.json` gains:

```json
"language": { "directions": ["ltr", "rtl"], "presentation": true }
```

`directions` lists the directions the theme lays out itself; `presentation`
says it shows `display()` text for the headword and reading. An entry without
`language` is read as `{ "directions": ["ltr"], "presentation": false }`.
Which Design controls a theme implements stays the job of `designSettings`.

### 11.4 Fallbacks for themes that do not declare a language

- **Direction.** When a direction the render needs is not in the theme's
  `directions`, core marks the contract's content hooks at the labelling
  pass's points (section 10.1), so a theme that reports no render still gets
  them.
  `.gsm-hoshidicts-expression` gets the source attributes. Core finds which
  dictionaries a `.gsm-hoshidicts-definitions` holds from `data-dictionary` on
  it or an ancestor, otherwise from `data-hoshidicts-dictionary` on the
  glossary content inside it (docs/themes/README.md documents this hook). A
  container that holds one dictionary gets that dictionary's `dir` (section
  10.2) and `text-align: start`, which its blocks inherit; one that holds
  several, or none core can name, gets `unicode-bidi: plaintext` and
  `text-align: start` on itself and on its block descendants, because neither
  property reaches them otherwise in every Chrome version. With `plaintext`, a
  row takes the direction of whatever text the theme writes first, so a row
  that starts with the theme's own label may take the label's direction. The
  interface and its alignment are left alone. The visual tests of section
  11.7 confirm what this gives for every vendored theme with its declaration
  removed; the claim is no more than that: Arabic paragraphs read in the right
  order and start on the right side.
- **Characters.** Outside the Japanese profile, core ignores character clicks
  from a theme that declares no language, and the clicked-character
  dictionary is hidden while it is selected, because such a theme may test
  characters with Japanese rules.
- **Presentation.** A theme that does not declare `presentation` shows the
  stored headword, and the pack's display settings are hidden while it is
  selected.

### 11.5 Design settings

A Design control shows when:

1. it is a core control, or the theme lists it in `designSettings`; and
2. the edited profile meets the control's requirement (section 7.3).

A pack `display` setting shows when the theme declares `presentation`; rule 1
does not apply to it. Design settings stay per theme as today.
Language-specific Design settings come in two kinds:

- **Defined by a language**: pack `display` settings (Arabic vowel marks,
  Chinese zhuyin). The pack defines them once and every theme that declares
  `presentation` honours them.
- **Defined by a theme for some languages**: a theme that needs a setting of
  its own uses the existing route: a core Design key, declared in its
  `designSettings`, with an `OPTION_REQUIREMENTS` entry naming a capability or
  scripts (for example Mincho headwords for `{ "scripts": ["Jpan", "Hani"] }`).
  It shows only for that theme and only in profiles that meet it.

Settings search skips controls hidden by a requirement or by a theme's missing
`presentation`, as it skips theme-hidden ones today. The Design preview keeps
core's sample scaffolding (two dictionaries, frequencies, tags, images,
structured content) and replaces the language fields with the pack's
`host.sample.entry`; its scene uses `host.sample.practice` with the pack's
`lang`, `dir` and font, and finds its candidate by the sample's lookup word.

### 11.6 The vendored themes

Each change below reproduces today's output in the single-profile shape and in
the Japanese profile:

| Theme | Changes |
| --- | --- |
| Default | Section 10.5. Declares `{"directions": ["ltr", "rtl"], "presentation": true}`. |
| Plain | One element per dictionary with `glossaryAttributes`; `text-align: start`. Declares `{"directions": ["ltr", "rtl"], "presentation": false}`: it shows no headword. |
| Nazeka | Character links from `isCharacterLink`; headword and reading through `display`, `sourceAttributes` and `readingAttributes`; the reading's `《》` from `labels.readingBrackets`; the `～` before rule names from `labels.traceMarker`; the headword's `aria-label` from `readingFor`; each sense in `.nazeka-sense` with `glossaryAttributes`; dictionary labels and frequency entries through `nameAttributes`; the sentence excerpt in its own element with Close and Back outside it, cut with `sliceText`; `text-align: left` becomes `start`; font and line breaking from the custom properties. Declares both directions and `presentation`. |
| JL, Bee | Character links from `isCharacterLink`; headword, reading and deconjugation endpoints through `display` and the attribute helpers; the `～` before rule names from `labels.traceMarker`; the matched form compared with the displayed forms; the pitch marker on the spelling only when the language has `pitchAccent`, and drawn on `display()` text; kanji view `On:`/`Kun:` and `、` from the character-view labels; mined character results from `characterEntryResult`; sense separators from `labels.senseSeparator`; each frequency entry and dictionary name through `nameAttributes`; `text-align: left` becomes `start`; fonts and line breaking from the custom properties, with Meiryo and today's stacks as fallbacks. Declare both directions and `presentation`. |
| Crystal (Grey, Beige, Retro blue) | As JL. Letter-spacing on the headword, plaques, tabs, frequency names and character-view labels is dropped when the language's `typography.joinedScript` is true, because spacing opens gaps inside joined letters in Chrome 128. The font warm-up string stays `食べる たべる Aa` at module load; `createView` warms `options.language.sampleText` for other languages. The gold frame and plaque artwork stay as they are, because the interface they frame stays left to right. Declares both directions and `presentation`. |

**Clickable characters in Japanese.** Nazeka, JL, Bee and Crystal test
characters with `\p{Script=Han}` today, Default with `HAN_CHARACTER_PATTERN`.
To keep both exactly, `isCharacterLink` in the Japanese profile is
`\p{Script=Han}`, and Default keeps `HAN_CHARACTER_PATTERN`. Unifying them
would stop 々, 〇 and CJK radicals being clickable in four themes; that is a
separate change for the owner to decide.

### 11.7 Contract tests

- **jsdom, every theme and Crystal variant** (`test/theme-languages.test.mjs`):
  fixtures shaped like engine replies (the reading equal to the expression
  where a language has none), for Japanese, English, Arabic and Korean:
  a monolingual Arabic dictionary with an Arabic title and Latin tags, an
  Arabic-English dictionary, an Arabic-titled frequency dictionary,
  structured `ol`/`ul` content, a two-step trace, a Korean gloss with hanja
  and `「」`, a Chinese gloss with `，` and `。`. Checks: the view renders;
  source text, readings, glossary blocks and names carry the attributes of
  section 10.1; no Japanese label appears in another language (the forbidden
  strings are derived from the Japanese pack's labels and character view:
  `On`, `Kun`, `、`, `～`, `《》`, "Look up kanji"); clickable characters follow
  section 11.6; glossary `lang` follows section 10.3 for every fixture gloss;
  a pack display setting changes `presentation` text in themes that declare
  it, is hidden for the others, and survives a pitch repaint.
- **More fixtures** for the same suite: an Arabic-English entry with an Arabic
  example sentence and its translation, a monolingual Arabic entry with a
  Latin etymology, an English paragraph that begins with an Arabic word, an
  Arabic paragraph that begins with a Latin label, an English profile with an
  English-to-Arabic dictionary, and in a Chinese profile a Japanese example and
  a Korean gloss; a phrase sense with a nested sense of the other direction,
  an example wrapper with a long Arabic sentence and a short translation, and
  a list with one item of each direction. Fixture dictionaries declare
  `targetLanguage` as real ones do (Jitendex `en`, 大辞林 `ja`, the
  Arabic-English dictionary `en`), and one bilingual dictionary has a tag in
  the profile's script; a Han-only string in a Korean-English and in a
  Korean-Chinese dictionary; an English example sentence in the
  English-to-Arabic dictionary; an English-Persian dictionary with no `fa`
  pack in the build (glosses `rtl`, the English example `en`); a CC-CEDICT
  note that mixes Han and Latin (`CL:所[suo3]`, expected `zh-Hans`); a
  bilingual dictionary without `targetLanguage`. The monolingual Arabic
  entry's Latin etymology is expected `ar` (section 21). In text-mode themes
  the glossary-`lang` check applies per line, with fixture glosses that take
  one line each, and it covers JL's and Bee's character view. The suite
  also asserts that no text in the profile's
  non-Latin scripts matches `:lang(en)`, in the term view and the character
  view.
- **Real Chrome, theme matrix** (`test/chrome-theme-languages.mjs`), on the
  current and the minimum Chrome, every theme and variant with those fixtures,
  declared and with the declaration removed (the fallback), on a
  left-to-right page and on a page with `<html lang="ar" dir="rtl">`.
  Assertions, by geometry: each Arabic gloss ends at its left; lines in their
  block's direction start at the block's start edge; each
  paragraph of the other direction inside a block keeps its own order and,
  in the themes that use core's structured-content renderer on the current
  Chrome, its alignment (text-mode themes keep the dictionary's, section
  11.2); list markers and sense numbers sit on
  the text's start side, inside their card; deinflection endpoints keep the
  row's order (matched form before the lemma); each frequency value sits next
  to its own name; joined-script text has computed `letter-spacing: normal`;
  Close, Back and tab geometry are the same on both pages and match the
  Japanese run; the interface does not match the page's `:lang()`, and on a
  Japanese page no Japanese text matches `:lang(en)`. A Default run selects
  a tab group, goes Back from the character view and presses **Show more**,
  then checks the labels and list padding again. It saves
  one screenshot per theme and language (Japanese, English, Arabic, Korean)
  under `test/tmp/languages/`.
- **Fonts.** The language suites install `fonts-noto-core` (Arabic, Hebrew,
  Syriac) beside `fonts-noto-cjk`, and fail when sample text has no covering
  font (`CSS.getPlatformFontsForNode`), because headless Chrome draws missing
  glyphs as empty space.
- `test/theme-renderer.test.mjs` keeps its Japanese checks unchanged.

## 12. Anki

- **Templates per profile.** `anki.templates` belongs to the profile; the
  AnkiConnect address and key are global. The flat `anki` projection (`deck`,
  `model`, `fields`, …) is the profile's first Template, as it is the single
  list's first Template today.
- **Built-in mining, word status and the duplicate index** use the first
  Template of the profile each request names (section 5.4). The duplicate
  index keeps one snapshot per source key, each refreshed and retried on its
  own, evicted when no profile's first Template uses it; with one source it
  keeps today's record. `writeLocalState` invalidates a snapshot when the
  first-Template source of any profile changes, compared profile by profile.
  The index keeps one row revision across its snapshots and the word-status
  signal carries it; a reader re-reads every status when it changes. Word
  status and maturity answer for the requested profile's source.
- **Markers.** The marker list in Settings hides markers whose capability the
  edited profile lacks (`{furigana*}` and `{sentence-furigana*}` without ruby,
  `{pitch*}` without pitch accent, `{character}`, `{onyomi}`, `{kunyomi}`,
  `{stroke-count}` without a character view). A saved template keeps them and
  they produce what they produce today: an empty string, or for `{furigana}`
  the plain headword. `{phonetic-transcriptions}` (IPA) is offered in every
  language.
- **`{part-of-speech}`** reads the pack's `anki.partOfSpeechLabels`; the
  Japanese pack carries today's table.
- **Note types.** Automatic detection and presets (Kiku, Lapis, Senren) run
  only for packs listing those families in `anki.noteTypeFamilies`. The
  **Automatic setup detection** row (with **Find existing setup**), the Preset
  select and the hint "Kiku, Lapis and Senren fill their matching fields
  automatically" carry `data-requires="ankiNoteTypeFamilies"`, so they are
  hidden, and skipped by search, for other packs. Field-name suggestions add
  the pack's `anki.fieldAliases`.
- **Right-to-left text in notes.** Once the records have profiles, notes mined
  in a profile whose pack is right to left, and in other profiles the fields
  that hold a right-to-left dictionary, follow these rules; other notes keep
  today's markup, except that glossary `lang` follows section 10.3 outside the
  Japanese profile (below):
  - every glossary root gets the direction of its dictionaries, `ltr`
    included, so a right-to-left card template cannot turn English glosses
    around; when the field's dictionaries differ in direction, the `ol` gets
    `padding-inline: 40px` and each `li[data-dictionary]` its dictionary's
    `dir`, so every number stays inside the field;
  - structured blocks whose direction by the rule of section 10.2 differs from
    the one they inherit get `dir` and `text-align: start` as attributes, and
    lists holding an item of the other direction get `padding-inline: 40px`,
    as the root `ol` does, because a note has no stylesheet and cannot read
    its card template's padding;
  - the glossary root, the compact root and the `{frequencies}` list use
    `text-align: start` instead of `left`; names that contain a right-to-left
    character, in `{frequencies}` too, sit in their own `dir="auto"` element;
    the details footer (`Rules: …`, `Deinflection: …`) gets `dir="ltr"`,
    because it is English;
  - `{sentence}` is wrapped in `<span dir="auto">`; the cloze parts are not
    wrapped, because isolating each part would break the sentence's order.
  The mining request carries each dictionary's direction and target language
  beside the display names it already carries, and the note builder passes
  the profile's language to `appendTextOnlyGlossary`, so glossary `lang`
  follows section 10.3 (in the single-profile shape and the Japanese profile,
  today's detection).
- **Relay API (GameSentenceMiner).** `profileIndex` 0 is the Japanese profile
  (every older GameSentenceMiner uses it); later indexes list the other
  profiles in order. The API host reads dictionaries through
  `projectDictionaryState(state, <that profile>)`, so its frequency
  dictionaries and dictionary paths are the profile's, with `enabled` flags.

## 13. Pronunciation audio

- `audioSources`, `audioAutoplay` and the audio button belong to the profile;
  requests name the profile in effect (section 5.4).
- Browser speech uses the pack's `host.ttsLanguage` for `utterance.lang` and
  for choosing an automatic voice; the messages name the language ("No
  English speech voice is available…"). Japanese keeps `ja-JP` and today's
  Google voice preference.
- `{language}` in audio URL templates is the pack's `host.audioLanguage`
  (`ja` for Japanese).
- Local Audio Server detection runs only for the Japanese profile.
- The Test button uses the pack's sample entry instead of `聞く`.
- A **Play audio from source** keybind names a source id; in a profile
  without that source it plays nothing, as it does today after the source is
  removed.

## 14. Dictionaries per profile

- **Library.** Settings → Dictionaries shows the edited profile's
  dictionaries in its order, with enable switches, reordering and groups as
  today. Below it, *Dictionaries in your other languages* lists packages the
  profile does not use, with **Use in {language}**; it never lists a personal
  package. A package can be removed
  from the profile without deleting it (**Remove from {language}**) or
  deleted from Hachidori (**Delete**, whose confirmation names every profile
  using it).
- **Bulk actions.** With the edited profile's selection, **Remove** deletes the
  selected packages from Hachidori, naming the other profiles that use them.
  **Remove all imported dictionaries** removes every package from every
  profile; with **Also erase the personal dictionary source** it erases every
  language's personal source, and with two or more languages the label and the
  confirmation say *every language* and give each language's entry count.
- **Import.** An import adds the package to the edited profile, enabled and
  last (section 5.2). When the archive's `sourceLanguage` names another
  profile's language, the success line says so and offers **Move to
  {language}**.
- **Recommended dictionaries.** The Japanese catalogue, its trust rules and
  its automatic installation stay exactly as they are and install into the
  Japanese profile. Other packs list `host.recommendedDictionaries` as links
  that open the dictionary's download page; the user imports the file. No
  source is added to the catalogue (decision record 0006).
- **Selections.** The frequency, clicked-character, compact-summary, pitch,
  blur and image-source selections belong to the profile and are pruned and
  migrated against the profile's packages and groups.
- **Updates** stay global: one schedule, per-package overrides.
- **Status.** With profiles, Settings' status line counts the edited
  profile's enabled dictionaries; Settings → Advanced → Memory shows what the
  engine has loaded for all profiles.

## 15. Personal dictionary, lookup counts and known words

- **Personal dictionary per language.** Japanese keeps today's package (fixed
  id `e4c2e20a1a964b6cbd4ae3f87643c1f0`, title *Hachidori Custom Dictionary*)
  and source document. Another language's personal package has the fixed id
  given by the first 32 hexadecimal digits of SHA-256
  (`hachidori-custom-dictionary:` + code), computed when `registry.js` is
  generated, and the title *Hachidori Custom Dictionary ({English name})*.
  Every personal title is reserved at import. Each package is pinned first and
  enabled in every profile of its language and never appears in other
  profiles; while its language has no profile it belongs to no profile and is
  not loaded, and it keeps its source; `assertOrdinaryCustomTransition` and the other invariant checks
  run per profile list, and `customDictionaryMetadataMatches` checks the
  package's own language. Every rule in AGENTS.md's "Managed custom
  dictionary" section applies per language.
- **Rows.** The source format stays `term, reading, definition`. The reading
  may be empty when the pack's `readings` is not `required`; the parser, the
  Note form and backup validation apply each document's pack rule.
- **Lookup counts** are counted per language (section 4.3); resetting counts
  resets every language. The count shown is for the profile in effect's
  language.
- **Known and ignored words** are kept per language (section 4.3).

## 16. Choosing and switching languages

### 16.1 First run

The welcome card gains *I'm learning*, a language menu with every pack,
Japanese first and selected, when `HDLanguages` is present (section 5). It
sits in its own element after `#setup-actions`, outside `#setup-body` and not
among the action buttons, whose text and ids existing tests pin. The choice
applies to **Start setup**, **Set up separately** and **Set up manually**. On
an unlinked installation that is still at the start (`setupState` at
`welcome`, the single-profile shape, no packages; option edits made before
setup are allowed), another language sends `hd_profile_add` with
`firstRun: true`, which creates that profile as the only one (section 4.5)
and loads its pack like any added profile (section 5.2). `hd_profile_cas`
judges "still at the start" on the snapshot it commits, so an import queued
ahead of it is seen; otherwise it refuses with "Hachidori is already set up.
Add {Language} in Settings.", and `firstRun` is never forwarded. A `firstRun`
add whose language is already the only profile succeeds, so a retry after a
lost reply does no harm. On a linked browser the choice selects that language locally
when the host has a profile for it, or sends an ordinary `hd_profile_add` to
the host and then selects it; **Use the Hachidori in {name}** links first and
then follows the same rule, selecting the language once the mirror holds
the new profile (it arrives in a change frame, not in the reply). A link
that does not carry profiles leaves the browser on Japanese, the card sends
no `hd_profile_add`, and it says why: a host whose `hello` lacks the
capability (an older build, or one without a second language) gets "Add
{Language} on {host} first; if its Settings have no Language section, update
it."; a client refused at opt-in gets "Update Hachidori in this browser to
use {Language} from {host}."; and a host that lacks the language gets "The
linked Hachidori does not have {Language}. Update it and try again."
The request is sent before the stage advances,
and a failure keeps the welcome card with the error. The
dictionary stage then shows the pack's recommended links and an import area
that uses Settings' import code instead of automatic installation; the Anki
stage runs detection only for packs with note-type families and otherwise says
Anki can be set up in Settings; the practice stage uses the pack's
`sample.practice`. The stage order and the setup record do not change.

### 16.2 Toolbar, shortcut and badge

- **Toolbar.** With two or more profiles, a row above today's controls has one
  button per profile (the language's name, and its native name when that
  differs) in a radio group; one click activates it. With one profile the
  toolbar is exactly today's. The lookup switch keeps today's label
  ("Japanese lookups") while the only profile is Japanese and reads "Lookups"
  otherwise.
- **Shortcut.** A browser command and keybind action `switchLanguage`
  (**Switch to the next language**, `web` scope) with no suggested key, like
  `openSearchPageCurrentTab`; users assign one on Chrome's shortcuts page. It
  is routed to the active tab's reader like the other popup actions, and the
  reader asks the worker to activate the next profile. Its id is not Yomitan's
  `profileNext`, which existing tests pin as an action Hachidori drops. On
  pages where Hachidori cannot run (browser pages), use the toolbar.
- **Badge.** With two or more profiles the toolbar icon's badge shows the
  active profile's code (`JA`, `EN`).

### 16.3 Settings

- **Language menu.** At the top of the sidebar, above the search field, a
  **Language** menu chooses the edited profile (section 5.3). It is not a link
  in `.settings-nav` and not a `.nav-item`. In the narrow layout it sits above
  the `#settings-section` picker. With two or more profiles, **Use for
  lookups** beside it activates the edited profile.
- **Add or remove languages** opens a dialog: the profiles with their
  dictionary counts, **Remove**, and **Add a language** with every pack not in
  use. Each held language without a profile is listed too ("Vietnamese:
  personal dictionary, lookup counts and marks are kept") with **Erase**. On a
  linked client whose host's `hello` lacks the capability, **Add a language**
  shows the welcome card's message for that case (section 16.1).
- **Reading → Scanning** gains **Switch language automatically from the page's
  language** (`languageSelection.autoSwitch`, per installation, off, written
  by `hd_language_selection_write`), rendered with two or more profiles.

### 16.4 Which settings are per language

With two or more profiles, Settings marks shared settings *All languages*:

- under the legend of fieldsets whose settings are all shared: Reading →
  Activation, Popup closing and Search page; Dictionaries → Updates; Keybinds;
  Backup; Sharing; Advanced; and under the first heading of Anki's connection
  card, which has no legend;
- beside single shared controls in fieldsets that mix scopes: Design →
  Appearance's Width, Height, Scale, Headword and toolbar position and
  Highlight the word on the page; Design's Custom CSS and Custom JavaScript;
  Reading → Results' Maximum child popups; Anki's Smaller Anki cards.

**Reset Design to defaults** resets the edited profile's Design keys and says
in its hint that it also resets the popup size, scale, toolbar position,
source highlighting and Custom CSS and JavaScript for every language. The
**Reset lookup counts** hint says *for every language*.

### 16.5 Removing a language

- **Remove** deletes the profile's settings and dictionary list and keeps its
  dictionaries in the library, including the language's personal package
  with its source, lookup counts and marked words. The personal package then
  belongs to no profile and is unloaded. Adding the language again puts that
  package back first and enabled and loads it before publishing, without
  compiling anything. Both run as engine mutations (section 5.2).
- **Also erase my {Language} personal dictionary, lookup counts and marked
  words** sends `hd_profile_remove { erase: true }` (section 5.2): the same
  commit empties the personal source and removes the package (today's
  zero-row rule), removes the language's marks and gives its counts a new
  generation (section 4.3).
- The last profile cannot be removed. When the active profile is removed, the
  active profile becomes the Japanese profile, or the first profile when there
  is none, the same rule every installation applies when its
  `languageSelection` names a profile that no longer exists (section 4.4).
- When the only remaining profile is Japanese and no other language is held
  (section 2), which needs an explicit erase, the removal or erase converts
  the records back to the single-profile shape (section 4.5).

## 17. Backup, restore and sharing

### 17.1 The Japanese view

Backups and older linked browsers need a Japanese-only picture of an
installation with profiles. The **Japanese view** is built from the Japanese
data whether or not a Japanese profile exists:

- `options`: the Japanese profile flattened with the global keys, or the global
  keys over Japanese defaults when there is no Japanese profile;
- `dictionaryState` in schema 1: the Japanese personal package first and
  enabled when it exists, then the Japanese profile's list in its order with
  its `enabled` flags, then every other package disabled, except other
  languages' personal packages, which it leaves out; the Japanese groups;
- the Japanese personal document, marks and lookup rows.

It is valid for today's code: every invariant AGENTS.md states for the managed
personal dictionary holds in it.

### 17.2 Backups

- A single-profile installation writes today's version 3 format, byte for
  byte, and today's automatic snapshots.
- With profiles, `readBackupPayload` returns the Japanese view as `snapshot`
  plus a field `profiles` with the complete records (`options`,
  `dictionaryState` in schema 2) and, per other language, the personal
  document, marks and lookup rows. The same object is used everywhere the
  payload goes:
  - **Archives** are version 4: the view is the manifest's `snapshot`, and
    `profiles` is a manifest field that older builds skip, as the archive
    reader promises for fields a newer version adds. The archive's files are
    those of the packages the view lists; other languages' personal packages
    are not archived, and a version 4 restore rebuilds them from their
    documents in the same restore transaction.
  - **Automatic snapshots** store the same object. Their validator checks the
    view as today and `profiles` by the version 4 rules, so a snapshot with
    profiles is never counted as corrupt, and the roots it protects are those
    of every package either part references.
  - **The Relay dictionary download** (`hd_api_dictionary_open`) uses the view.
  - **Restore** (`hd_backup_cas`) validates the view as today, validates
    `profiles` when present and restores from it, pruning selections per
    profile through `applyOptionsPatch`, and leaving out every language this
    build has no pack for (section 17.6). It writes every language's personal
    document at its current revision plus one, as it does the top-level
    records (a language that keeps a profile but whose document the restore
    removes gets an emptied document), and `hd_backup_cas` checks those
    revisions as it checks the top-level ones. The engine loads the
    packs of the restored profiles before the restore publishes (section
    9.2).
- Versions 1-3 restore as one Japanese profile through the same projection.
  Restoring replaces every profile at once, as it replaces every setting
  today, and keeps this installation's `languageSelection` unless the result
  is the single-profile shape. Because a restore also replaces other
  languages' personal sources, counts and marks, its preview names every
  language whose data it removes.

### 17.3 Sharing

A host whose records have profiles speaks to each client according to that
client. A linked client stores a different projection of the host's records
(the Japanese view or the real records) only at newer revisions, because its
pages adopt only newer revisions:

1. **Hello.** The host adds `language-profiles-v1` to its `hello`
   capabilities; a single-profile host sends today's frame. The client's
   `hello` does not change.
2. **Opt-in.** A client that sees the capability sends
   `hd_language_profiles_opt_in` with its pack codes before it applies the
   hello's snapshot, and applies the opt-in reply's snapshot (the real
   records) instead, so its pages never adopt the Japanese view first. The
   host answers in one turn of its storage queue: it reads the snapshot,
   refuses a client that lacks a language the snapshot holds (section 17.6),
   records the opt-in per connection when it accepts, and queues that
   client's change frames until the reply is sent; the client discards change
   frames that arrive between its request and the reply, none of which is
   newer than the reply. A new link's probe connection opts in too, and the
   link stores the opt-in reply's snapshot, or the refusal's, never the
   probe's `hello` snapshot from a host with the capability. Every other
   client, older ones included, gets the Japanese view.
3. **Changes.** With profiles, the host sends each client its own storage
   change frame, projected to the Japanese view unless that client opted in;
   a single-profile host keeps its one broadcast.
4. **Replies.** For clients that have not opted in, the host replaces every
   reply field that carries options, dictionary state or a personal document
   with its Japanese view: `hd_options_write` (`options`, also in a conflict),
   `hd_state_read`, `hd_state_cas` (`state`, also in a conflict),
   `hd_custom_read` and `hd_custom_cas` (`state`, `document`), and the engine's
   `hd_custom_save`, `hd_custom_append`, `hd_apply_state` and `hd_remove`
   (`state`, also in a conflict).
5. **Requests.** The linked Anki, Anki setup and linked import allowlists keep
   a validated `profileId`, and the upload host passes it to
   `hd_upload_import`. A forwarded request without one means the Japanese
   profile (section 5.2). `FORWARDED_REQUESTS` gains
   `hd_language_profiles_opt_in` under `hoshidicts-worker`, answered by the
   host's sharing code for that connection, and `hd_profile_add` and
   `hd_profile_remove` under `hoshidicts-offscreen`, which are also in that
   target's `MUTATING_FORWARDED_REQUESTS`; pack setting writes travel inside
   `hd_options_write`. `hd_language_selection_write` is never forwarded.
6. **Forced reconnections.** A connection must reconnect when a commit
   changes which projection it should receive: whenever the records leave the
   single-profile shape (a second language, a version 4 restore on a
   single-profile host), so clients say hello again and see the capability;
   when an opted-in client would receive a language it lacks; and when a
   refused client would now be accepted (the host keeps each refused
   connection's pack codes). From that commit the host sends the connection
   no change frames. Requests that connection sends after the commit are
   dispatched when they are lookups or count requests, and refused with "The
   linked Hachidori is changing its languages. Try again." when their
   replies carry records (item 4's list). Requests already running finish
   with their usual replies (section 21), and the host closes the connection
   once they have finished, so no client is told that a change may have
   completed. Every client then receives the new revisions in one
   projection from its next `hello` or opt-in reply; lookup-count rows
   written meanwhile reach its mirror only through later change frames, as
   after any reconnection today, while its forwarded count reads answer from
   the host.

### 17.4 Linked browsers running an older Hachidori

Every older build is Japanese-only. A client that has not opted in receives
the Japanese view, whatever language the host reads in, and its writes, which
carry no profile, go to the Japanese profile and the Japanese personal
document; when the host has no Japanese profile they are refused with the
message of section 5.2, except patches of global keys alone. Its views keep
the host's revisions, so a conflict is
detected as today; because its target is always the Japanese data, a stale
base cannot land in another profile or another language's document. Its
**Delete** and **Remove all imported dictionaries** cannot delete a package
that a profile other than Japanese uses (section 5.2). A new client linked to an older host
sees the host's state as one Japanese profile and cannot add languages while
linked.

### 17.5 Overlay mode

GameSentenceMiner's overlay is an installation of its own with its own
`languageSelection`. Its local option keys (`OVERLAY_LOCAL_OPTION_KEYS`) stay
flat in its own record, one value per overlay as today, and are laid over the
projection of whichever profile a lookup uses.

### 17.6 Builds with different packs

A build holds only languages it has a pack for, in the sense of section 2: a
profile, a personal package, a personal document with text, a lookup-count
entry or a marks entry with a word. Builds differ in packs: a language arrives
with a submodule bump, the Chrome Web Store build lags the repository, and
GameSentenceMiner ships its own copy. So:

- **Restore.** For every language the backup holds whose pack this build
  lacks, a version 4 restore leaves out its profile, its personal package,
  its document, counts and marks; its other packages stay in the library, in
  no profile. The preview names each such language ("Vietnamese needs a
  newer Hachidori and is not restored"), with the name from
  `Intl.DisplayNames(["en"], { type: "language" })`. The result is the
  single-profile shape exactly when section 4.5's rule says so. When no
  profile of the backup remains (an installation set up in Vietnamese,
  restored on a build without Vietnamese), the restore builds the Japanese
  profile from the backup's Japanese view (section 17.1), as an older build
  does, keeps the other held languages it has packs for, and its preview says
  that the Japanese settings and dictionaries are restored in place of the
  left-out language.
- **Opt-in.** The host answers an opt-in in one turn of its storage queue: it
  reads the snapshot, checks the client's pack codes against every language
  that snapshot holds, and records the opt-in only when it accepts, so no add
  lands between the check and the snapshot. A refusal names the languages the
  client lacks and carries the Japanese view read at that moment, and the
  host queues that client's change frames until the refusal is sent, as for
  an acceptance. The refused client keeps the Japanese view and cannot add
  languages while linked, as with an older host (section 17.4), and Settings →
  Sharing says "Update Hachidori in this browser to use {Language} from
  {host}."
- **Later changes.** The host never sends an opted-in client records that hold
  a language the client lacks. When a commit would (an add, a restore), the
  connection is forced to reconnect (section 17.3, item 6), says hello again
  and is refused. A refused connection that a later commit makes acceptable
  (an erase, a restore without that language) reconnects the same way.
- **Adding a language through a link.** The opt-in reply lists the host's
  pack codes, and **Add a language** on a client offers the packs both
  installations have. The host refuses an `hd_profile_add` for a language it
  has no pack for: "The linked Hachidori does not have {Language}. Update it
  and try again."
- **Downgrading** to a build without one of the installation's packs is not
  supported (section 21).

## 18. Tests

- **Unchanged:** every existing suite (section 6.2). New checks go into new
  files, never into the existing suites, so those files stay byte-identical;
  only the runner (`test/run.mjs`) and the CI workflow learn the new suite
  names.
- **New, Node:** `profiles.test.mjs` (projection, `applyOptionsPatch` for every
  writer in section 5.2, masking and the two Automatic neutral values,
  requirement table against `data-requires`, the single-profile invariant for
  records, messages and frames, migration of every stored shape and backup
  version, version 4 backups read by the version 3 code path, a version 4
  backup with a profile whose pack is missing restoring the rest and naming
  that language, a backup with a Vietnamese personal dictionary and no
  Vietnamese profile restored on a build without Vietnamese, a backup with
  one Japanese profile and English data keeping the English data on a build
  with English, a restore of the same installation's snapshot replacing its
  English counts, the first-run `firstRun` rules, a Japanese personal save,
  lookup and mark each keeping English's document, generation and marks and
  the English writes keeping Japanese's, a restore that leaves no profile
  building the Japanese profile, restored document revisions above the
  current ones);
  `language-packs.test.mjs` (vendored copy and both registry scripts equal
  what the submodule gives, class references expanded by hoshidicts'
  `tools/lib/classes.mjs`; `registry-reader.js` within 64 KB; every
  descriptor's host blocks are valid; the JavaScript display steps and classes
  agree with the engine's expectation tables); `theme-languages.test.mjs`
  (section 11.7); sentence, highlight-chunk and content-scanning cases per
  pack (word starts, terminators, right to left), including hovers on the
  second part of separated words: *five-minute* → *minute*, *mother’s* →
  *mother*, *l’homme* → *homme*, and Ukrainian *м’ясо* kept whole.
- **New, engine smoke:** `node-smoke-languages.mjs` with English and Arabic
  fixture dictionaries built by `make-language-fixtures.mjs` (with
  `sourceLanguage` and `targetLanguage`), checking `hdw_lookup` with
  `language` and `dictionaries` (including an empty list, which finds
  nothing), the Japanese reply bytes without them, and per-language
  segmentation.
- **New, real Chrome:** `chrome-theme-languages.mjs` (section 11.7) and
  `chrome-languages.mjs`, each with its own fixed plan. The second covers the
  user flows: first-run language choice; create Japanese, English and Arabic
  profiles; import one dictionary per language; hover inflected words on sample
  pages (spaces, CJK, right to left); add an Anki note through the fake
  AnkiConnect, with an Arabic note's fields checked in a left-to-right and a
  right-to-left card template for a monolingual Arabic entry and an
  Arabic-English entry with an Arabic example: every list number drawn inside
  the field and every paragraph in its own order; switch profiles from the toolbar, by the
  shortcut and automatically by `lang`; edit one profile in Settings while
  another is active; hidden settings per profile; backup and restore with
  profiles, an automatic snapshot with profiles, and a version 4 backup
  restored by the current release; a linked older client and an opted-in
  client, including a host that gains profiles while both are connected, and
  an older client linked to an English-only host (lookups find nothing, writes
  are refused with the message of section 5.2); the Relay API's dictionaries
  for profile index 0; adding English and looking up at once, removing and
  re-adding a language that has personal entries, and removing the last other
  language and looking up Japanese (only Japanese packages answer); with Low
  memory mode on, adding English, waiting for the engine's recycle and
  looking up English; restarting the browser with an English profile and
  looking up English; restoring a version 4 backup with an English profile
  into a fresh installation and looking up English; an older client linked to
  a Japanese and Chinese host finding only Japanese dictionaries for Han
  text, and its **Remove all imported dictionaries** refused for the Chinese
  packages; a client whose registry lacks one of the host's languages refused
  at opt-in and working on the Japanese view, an opted-in client never
  storing a profile it lacks when the host adds one, and an `hd_profile_add`
  for a language the host lacks refused with its message; an opt-in refused
  for a language the host holds only through data, and accepted after that
  language is erased; unlinking a browser with its own English counts keeps
  them; an open tab and Settings on a
  profile-aware client show the host's profiles right after a new link and
  after the host gains profiles. It saves screenshots of
  the picker, the switcher and one lookup
  per script.
- **Firefox:** `firefox-e2e` unchanged, plus `firefox-languages`: one profile
  switch and one English and one Arabic lookup.
- **Accessibility.** The `lang`, `dir` and label changes affect screen-reader
  semantics; the pull request carries the `accessibility` label and the
  screenshots of section 11.7.

## 19. Performance

- **Japanese lookups**: the engine contract's budget (section 13 there),
  measured with `benchmark/run.mjs` (Jitendex and Pixiv Light) and the Node
  `hdw_lookup` timings before and after, same machine, repeated runs.
- **Hover**: `benchmark/hover-popup.mjs` input-to-first-frame and complete,
  before and after, with the Japanese fixture, in the single-profile shape and
  with a second profile (which adds the worker's profile resolution and the
  labelling pass of section 10.1), each also from a worker that has just
  started: within noise.
- **Large popups**: render plus first layout of a 32-result popup of
  Jitendex-sized entries in every theme, before and after, on a Japanese page,
  with a second profile, on a system that has each theme's named fonts and on
  one that lacks them. A review probe measured JL about 11 ms slower when its
  fonts were missing, from layout of interleaved `en` and `ja` elements; a
  measured regression is fixed before merging, as AGENTS.md requires.
- **Frame start-up**: content-script start in a page with many frames, before
  and after, with every pack in `registry-reader.js`.
- **Profile switch**: no reload; the first lookup after switching is as fast
  as any other. Measured from the toolbar click to the first popup.
- **Engine start**: restart-to-first-lookup with the Japanese, English and
  Arabic packs loaded, against today's.
- **Memory**: unchanged for single-profile installations; otherwise the sum of
  the dictionaries enabled in any profile plus the loaded packs, reported with
  `benchmark/low-memory-mode.mjs` for a Japanese plus English library.
- **Other languages**: `hd_lookup` p50 and p95 per pilot language with a real
  dictionary, reported in the pull request.

## 20. Adding a language to Hachidori

A language is added in hoshidicts (engine contract, section 14). Hachidori
needs no code for it:

1. Bump `third_party/hoshidicts` to a commit that contains the pack.
2. Run `node scripts/sync-languages.mjs` and commit the regenerated
   `extension/vendor/languages/`.
3. Run `node --test test/language-packs.test.mjs test/theme-languages.test.mjs`
   and the language browser suites.

The language then appears in the first-run choice, in **Add a language**, and
in every theme.

## 21. Known limits

- The user interface is English; only content follows the language.
- The manifest description and the "Turn Japanese lookups on or off" command
  name stay Japanese: they are static and pinned by tests. Renaming them is a
  one-line change for the owner to decide.
- One profile per language in version 1.
- Recommended dictionaries for other languages are links, not one-click
  installs.
- Downgrading is not supported once a second language is added: older builds
  cannot read schema-2 records, and a profile-aware build cannot use a profile
  whose pack it lacks. Version 4 backups restore their Japanese view in older
  builds and every language they have a pack for in profile-aware builds
  (section 17.6).
- Debug-log redaction does not cover Latin-script languages, whose text cannot
  be told apart from log messages.
- The Relay API's profile 0 is the Japanese profile; GameSentenceMiner picks
  other languages by index.
- Lookups load every profile's enabled dictionaries; loading a profile's
  dictionaries on first use is possible later behind the same engine API.
- In a right-to-left text field, a lookup near the field's clipped edge may
  miss: the imposter's clipping assumes left-to-right scrolling.
- The single-profile shape keeps today's markup exactly, including two
  existing faults: the popup takes a right-to-left page's direction and
  language, and right-to-left glosses get no direction. Both are fixed once a
  second language is added (section 10); fixing them for Japanese-only
  installations too is a separate change for the owner to decide.
- The `-plain` Anki glossary markers join lines with `<br>` and have no
  element to carry a direction.
- A linked client's request that is already running when the host forces a
  reconnection (section 17.3, item 6) gets its reply in the old projection,
  which can leave one page on the Japanese view until the host's next
  write.
- Detection by characters cannot tell two Latin-script languages apart: an
  English example in an English-French dictionary takes the dictionary's
  `fr` (section 10.3). Outside profiles written only in Latin, a Latin-script
  string in a dictionary whose target language is written without Latin
  takes that language: a Latin etymology in a monolingual Arabic dictionary
  is `ar`.
