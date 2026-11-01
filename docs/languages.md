<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Languages and profiles

Status: design for review (Phase 1). Nothing described here is implemented
yet.

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
  options, Anki Templates (deck, note type, fields), pronunciation sources,
  popup theme and Design settings, and the settings its language defines.
- **One click to switch.** The toolbar popup lists the profiles; the browser
  shortcut **Switch to the next language** (suggested Alt+Shift+L) cycles
  them; the toolbar badge shows the active one when there is more than one.
  Optionally, Hachidori picks the profile for each lookup from the page's or
  element's `lang` attribute.
- **Settings follow the language.** Settings show the active profile's
  values. A setting that does not apply to the language (pitch accent for
  English, the clicked-kanji dictionary for Arabic) is hidden. Its stored
  value is kept and has no effect.
- **Every theme works in every language.** Themes receive the language with
  every render; right-to-left text is shown correctly even by a theme that
  knows nothing about it.
- **Existing users see no change** until they add a second language. Their
  settings, dictionaries and storage stay exactly as they are and become the
  Japanese profile.

The user interface stays in English.

## 2. Terms

- **Language pack**: the description of one language in
  `third_party/hoshidicts/languages/<code>/`. Hachidori ships a generated copy
  in `extension/vendor/languages/`.
- **Profile**: a language plus the user's settings and dictionaries for it.
  Version 1 allows one profile per language; the data model allows more
  later.
- **Active profile**: the profile the toolbar shows and Settings edits.
- **Profile in effect**: the profile a particular lookup uses. It is the
  active profile, unless automatic switching picked another for that page
  element.
- **Capability**: a feature a language has (section 7.1). Packs declare
  them; settings and popup features require them.
- **Language-scoped data**: user data that belongs to a language rather than
  to a profile: the personal dictionary, lookup counts, known and ignored
  words.

## 3. What belongs to a profile

| Scope | What | Why |
| --- | --- | --- |
| Profile | Dictionaries enabled, their order and tab groups; scan length, maximum results, the language text gate, personal-dictionary switches, metadata-only results; frequency sorting and its dictionary; definition blur; word highlighting; Anki Templates; pronunciation sources and autoplay; popup theme, colours, opacity, columns and every Design content setting; custom buttons and links; the clicked-character dictionary; pack settings | These differ by language: a Japanese and an English dictionary, a JLPT deck and a vocabulary deck, a Japanese and an English voice. |
| Language | Personal dictionary source and its package; lookup counts; words marked known or ignored | They are facts about words of a language, shared by every profile of it. |
| Package | Title, files, revision, update source and schedule, display name, favourite | A dictionary is one thing however many profiles use it. |
| Global | Enable lookups; lookup mode, activation key and delays; hide-on-exit; nesting depth; keybinds; popup width, height, scale and toolbar position; source highlight; Custom CSS and JavaScript; AnkiConnect address and key; smaller Anki cards; experimental flags; memory and storage modes; automatic backups; the update schedule; sharing; search button; automatic profile switching | They describe the reader's hands, screen and machine, not a language. |

Appendix A lists every option key with its scope and reason.

## 4. Storage

All writes still go through the service worker's serialised storage queue.
No storage key is added; the existing records gain profile structures.

### 4.1 `options`

```json
{
  "revision": 57,
  "hoverEnabled": true,
  "lookupMode": "activationSticky",
  "keybinds": [],
  "anki": {"url": "http://127.0.0.1:8765", "apiKey": ""},
  "activeProfileId": "ja",
  "profileAutoSwitch": false,
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
- One `revision` covers the whole record, so every write keeps today's
  compare-and-set behaviour.

### 4.2 `dictionaryState`

```json
{
  "schemaVersion": 2,
  "revision": 31,
  "dictionaries": [
    {"id": "9f0c…", "title": "Jitendex.org [2026-08-11]", "displayName": null, "favorite": false, "path": "/dicts/.hdw-generation-…", "language": "ja", "termCount": 298131}
  ],
  "profiles": {
    "ja": {"dictionaries": [{"id": "e4c2…", "enabled": true}, {"id": "9f0c…", "enabled": true}], "groups": []},
    "ar": {"dictionaries": [{"id": "77ab…", "enabled": true}], "groups": [{"id": "g1", "name": "Main", "dictionaryIds": ["77ab…"]}]}
  }
}
```

- `dictionaries` lists every package once, with its identity and package-wide
  presentation (display name, favourite, update metadata). It no longer
  carries `enabled`; its order is installation order.
- `profiles[id].dictionaries` is that profile's ordered list with each
  package's `enabled` flag: lookup order, as the single array is today.
- `profiles[id].groups` are that profile's tab groups. Group ids stay unique
  across profiles.
- A package may appear in several profiles, or in none.

### 4.3 Language-scoped records

- `customDictionarySource` keeps the Japanese document at its top level, as
  today, and gains `languages: {"<code>": {revision, semanticRevision, text}}`
  for other languages.
- `lookupStats` rows keep the key `lookupStats:<generation>:<[term, reading]>`
  for Japanese and use `<[term, reading, code]>` for other languages.
- `wordStatusOverrides` keeps `known` and `ignored` for Japanese and gains
  `languages: {"<code>": {"known": [], "ignored": []}}`.

### 4.4 The single-profile rule

While an installation has exactly one profile and it is Japanese, every
record keeps exactly today's shape: no `profiles`, no `activeProfileId`,
`dictionaryState.schemaVersion` 1, no `languages` maps. The profile layer reads
such records as one Japanese profile (section 5.1). The new shapes are
written by the first write that needs them: adding a second profile, or
choosing another language at first run.

**The single-profile invariant.** In the single-profile shape every stored
record, every runtime message and every engine request is byte-identical to
today's. New message fields (`profileId`) and engine options (`language`,
`dictionaries`, `languageOptions`) are sent only when the stored records have
profiles. This is what lets every existing test suite pass unchanged (section
6.2): those suites read and write `options` and `dictionaryState` directly,
pin the messages Settings and the toolbar send, and compare engine replies
byte for byte. It also keeps backups and the sharing mirror of Japanese-only
users exactly as they are, so older builds keep reading what newer builds
write for them.

The first conversion moves the record's profile keys into a profile with id
`ja`, splits `anki` (section 4.1), and turns the dictionary array into the
package list (same order) plus `profiles.ja` (same order, same `enabled`
flags, same groups). Every value is kept. Removing profiles until one
Japanese profile remains does not convert the records back; the projection
reads either shape.

## 5. The profile layer

`profiles.js`, a classic script loaded wherever `reader-options.js` is, owns
the projections and the write routing. Every existing consumer keeps reading
the flat shapes it reads today, so most of the code base does not change.

### 5.1 Reading

- `HDProfiles.profiles(storedOptions)` returns the profile list. A record
  without `profiles` yields `[{id: "ja", language: "ja", settings: <the
  record's own profile keys>, packSettings: {}}]`.
- `HDProfiles.projectOptions(storedOptions, profileId?, { masked = true })`
  returns flat options shaped exactly like today's `normaliseOptions` result:
  global keys from the top level, profile keys from the profile (the active
  profile when `profileId` is omitted), then capability masking (section 7.3)
  unless `masked` is false. For a single-profile record it returns exactly
  what `normaliseOptions` returns today. `normaliseOptions` and
  `projectContentOptions` call it, so the reader, the worker, the engine
  service and the Anki worker receive the projection without code changes.
  Settings renders controls from the unmasked projection.
- `HDProfiles.profile(storedOptions, profileId?)` returns
  `{ id, language, packSettings }`, and `HDLanguages.get(code)` the pack's
  descriptor. The language is never added to the flat options object, whose
  shape existing tests pin.
- `HDProfiles.projectDictionaryState(storedState, profileId?)` returns the
  schema-1 view of one profile: its packages in its order with its `enabled`
  flags and its groups. `normalizeDictionaryState` in
  `content-dictionaries.js` and the Settings library read it.
- `HDProfiles.allPackages(storedState)` returns every package, for the engine
  service, managed updates and the installer, which work on the whole
  library.

### 5.2 Writing

- `hd_options_write` gains an optional `profileId`. The worker routes each
  patch key by its scope: global keys to the top level, profile keys to the
  named profile (the active profile when `profileId` is absent), `anki` split
  as in section 4.1. Settings always names the profile it rendered, so a
  profile switch in another window cannot redirect an edit.
- `hd_state_cas` and `hd_apply_state` gain `profileId`. Their `dictionaries`
  and `groups` are a schema-1 view of that profile; the worker writes the
  profile's list and groups and the packages' package-wide fields, and leaves
  other profiles alone.
- The engine service's own commits (import, reimport, managed update,
  removal, personal-dictionary compilation) read and write the whole stored
  state, as they do today, under the same compare-and-set. In the schema-2
  shape: an import adds the package to the profile `hd_import` names (the
  active profile when it names none), enabled and last; a reimport or update
  replaces the package's generation in every profile that uses it, keeping
  each profile's order and enabled state; a removal removes the package from
  every profile. Every transaction rule in AGENTS.md applies unchanged.
- `hd_profile_add`, `hd_profile_remove` and `hd_profile_activate` are new
  worker requests. Each is one storage write covering `options` and
  `dictionaryState`.
- The selection pruning and title migration that run with every dictionary
  commit (`normaliseDictionarySelections`,
  `migrateCommittedDictionarySelections`) run once per profile, against that
  profile's packages and groups.

### 5.3 Callers without a profile

Every writer that exists today sends no `profileId` and therefore writes the
active profile. That is what the toolbar switch, the browser command,
overlay seeding, setup's Anki detection, first-install selections and a
linked browser running an older Hachidori (section 17.3) need.

## 6. Migration of existing installations

### 6.1 Nothing is rewritten

Because of the single-profile rule, upgrading writes nothing. The stored
`options`, `dictionaryState`, personal dictionary, lookup counts and marked
words are read as the Japanese profile, with every value exactly as stored.

### 6.2 What proves identical behaviour

- Every existing test suite passes without changes to its files: lint, Node
  contracts, the three WebAssembly smoke variants, the extension smoke suite,
  `chrome-e2e`, `chrome-sharing`, `chrome-fallback`, `chrome-overlay`,
  `chrome-theme-contrast`, `firefox-e2e` and `firefox-lint`. Their fixtures
  are Japanese and they pin engine replies, popup DOM, Anki output and
  backups byte for byte.
- hoshidicts' Japanese parity test and Yomitan's complete Japanese
  conjugation corpus (engine contract, section 11).
- `test/profiles.test.mjs` checks that the projection of every stored record
  shape the existing suites use equals the output of today's
  `normaliseOptions`, recorded as golden files before the change; that a
  single-profile install sends byte-identical requests to the engine (no new
  keys); and that no write happens on upgrade.

If an existing test pins a detail this design would change for a
Japanese-only installation, the design changes, not the test. For example,
`chrome-e2e` pins the nine Settings rail links, so language management is not
a new rail section (section 16).

### 6.3 New profiles

Adding a profile copies the active profile's profile settings, so the new
language looks and behaves like the one the user already set up, and then
replaces the language-bound ones:

- dictionaries: none; groups: none; dictionary selections (frequency,
  clicked character, compact summary, pitch, image source): unset;
- Anki: the active profile's Templates with their deck, note type and field
  mapping copied, so a user mining both languages into one note type keeps
  it; Settings shows a note under Anki that the Templates were copied;
- audio: one browser speech source in the pack's language (`text-to-speech`
  for packs without readings, `text-to-speech-reading` otherwise);
- custom buttons: none, since they usually link to a language's websites;
- the pack's `settings` defaults.

## 7. Capabilities and settings

### 7.1 Capabilities

A profile's capabilities are the pack's (engine contract, section 4.6) plus
any optional capability a pack setting turns on. Hachidori uses them as
follows:

| Capability | Japanese | What depends on it |
| --- | --- | --- |
| `readings` (`required`, `optional`, `none`) | `required` | Note form Reading field; `{reading}` in Anki marker lists; reading line in the popup. |
| `ruby` (`kana`, `syllable`, `word`, or none) | `kana` | Furigana over the headword; `{furigana}`, `{furigana-plain}`, `{sentence-furigana}` markers; KANJIDIC furigana split (`kana` only). |
| `pitchAccent` | yes | Every pitch display option and the pitch, position, category and graph markers. |
| `characterView` | Kanji, On/Kun | Clickable characters, the character view, the clicked-character dictionary, `{character}`, `{onyomi}`, `{kunyomi}`, `{stroke-count}`. |
| `wordHighlighting` | yes | Word highlighting and its settings, keybinds and commands. |

Every pack also has a text gate, sentence rules, a direction, a speech
language and a personal dictionary; those are data, not capabilities.

### 7.2 Where generalising is honest

- **Character view: one capability.** Japanese kanji, Chinese hanzi and Korean
  hanja are all single characters looked up in Yomitan `kanji_bank`
  dictionaries. The pack supplies which characters are clickable and what the
  two reading columns are called (On/Kun, Pinyin, Eum/Hun). The view, the
  Back button and the dictionary choice are shared code.
- **Readings and ruby: one capability with alignment modes.** Japanese
  furigana distributes a kana reading around the kana of the spelling;
  Korean hanja and spaced pinyin give one syllable per character; other
  readings sit over the whole word. These are three modes of one feature.
- **Not generalised: pitch accent.** It is Japanese mora pitch. Chinese tones
  and English stress are different data and would be different capabilities;
  until a pack needs them they show only through readings and IPA.
- **Not generalised: kana conversion, the KANJIDIC split, Japanese Anki note
  types, the Sanseido and Jitendex summary heuristics.** They stay Japanese
  code, reached only through the Japanese pack's capabilities and data.

### 7.3 Hidden, kept, inert

`reader-options.js` gains one table, `OPTION_REQUIREMENTS`, mapping each
option key that needs a capability to the capability and to its **neutral
value**:

```js
const OPTION_REQUIREMENTS = {
  showPitchAccentFurigana: { requires: "pitchAccent", neutral: false },
  pitchAccentFuriganaDictionary: { requires: "pitchAccent", neutral: "" },
  showPitchAccentBadge: { requires: "pitchAccent", neutral: false },
  kanjiClickDictionary: { requires: "characterView", neutral: "" },
  wordHighlightEnabled: { requires: "wordHighlighting", neutral: false },
  // ... every key in Appendix A with a requirement
};
```

For a profile without the capability:

1. **Hidden**: Settings hides the control (and its group when every control
   in it is hidden), search skips it, the keybind editor does not offer it as
   a Toggle option argument, and the Design preview does not show it. A saved
   Toggle option keybind for such a key does nothing in that profile and
   writes nothing.
2. **Kept**: the stored value is never written by hiding, profile switching,
   Reset or restore.
3. **Inert**: `projectOptions` replaces the value by its neutral value, so
   every consumer behaves as if the setting were off without knowing about
   capabilities.

Design's existing theme filter (`designSettings`) still applies. A Design
control shows when the theme implements it **and** the profile has its
capability. Settings controls carry `data-requires` attributes generated
from the same table, and `test/profiles.test.mjs` checks that every
`data-requires` and every table entry agree.

The Japanese pack has every capability, so nothing is hidden or masked for
the Japanese profile.

### 7.4 Labels that name the language

Labels that say "Japanese" today name the profile's language instead:
**Only scan Japanese text** becomes *Only scan {language} text* (the option
keeps its key, `onlyScanJapaneseText`, and now means "only text matching the
pack's `text.pattern`"); the toolbar's switch, its hint and the empty
library card do the same. For the Japanese profile every string is exactly
today's. Labels that name the character view take the pack's
`characterView.name`: *Clicked-kanji dictionary* reads *Clicked-hanzi
dictionary* in a Chinese profile.

The manifest's static strings ("Study Japanese vocabulary…", "Turn Japanese
lookups on or off") cannot vary and are pinned by existing tests. They stay
as they are; section 21 lists them.

### 7.5 Settings a pack defines

A pack's `settings` (engine contract, section 4.7) appear without any
language-specific code:

- **Where.** Reading → *{Language} options* for `group: "lookup"`, Design →
  *{Language} display* for `group: "display"`. `language-settings.js` renders
  them from the schema, as `experimental-settings.js` renders flags.
- **Storage.** `profiles[].packSettings`, written as a complete record through
  `hd_options_write` (as the experimental flags are). Unknown ids are dropped;
  invalid values become the default. Backups carry them.
- **Effects.**
  - Engine effects (`preprocessor`, `transforms`, `variantPass`) travel with
    each lookup as `languageOptions` (section 9.3).
  - `display` effects are applied by core before rendering: each result gets
    `result.presentation = {expression, reading}` with the display transform
    applied (section 10.3). Anki, the Note form, lookup counts and word status
    keep reading `result.term`, so a display setting never changes what is
    mined, stored or counted.
  - `capability` effects turn an optional capability on for the profile, and
    the settings that require it appear.
- **Themes.** A `display` setting shows only when the selected theme declares
  that it renders `presentation` (section 11.3).

Examples the format supports: Arabic *Vowel marks in headwords: Show / Hide*
(display), Korean *Hanja character view* (capability), Chinese
*Readings: Pinyin / Zhuyin* (display, with a pinyin-to-zhuyin `map` step),
Japanese NekoPara cat speech (variant pass; not offered in version 1).

## 8. Reading pages in a language

### 8.1 Which profile a lookup uses

The content script holds the projections of every profile. For each
candidate it chooses the profile in effect:

1. With **Switch language automatically** off (the default): the active
   profile.
2. With it on: the nearest `lang` attribute of the hovered element, or of the
   field or document it belongs to, is matched against the profiles' packs by
   primary subtag (`ja-JP` → `ja`, `zh-Hant` → `zh`); no match leaves the
   active profile. It does not change the active profile.
3. A lookup inside a popup (a child popup over a definition) uses the parent
   lookup's profile. With automatic switching on, the definition container's
   `lang` (from the dictionary's `targetLanguage`) can pick another profile.
4. The search page, the startup exercise and keybind scans use the active
   profile.

The popup shows the profile in effect only when it differs from the active
one, as a small language label beside the close button.

### 8.2 Text gate

`onlyScanJapaneseText` stays one profile key; its predicate is the pack's
`text.pattern` (for Japanese, today's `JAPANESE_CHARACTER_PATTERN`). The
token, selection and word-highlighting gates in `content-scan.js` and
`word-highlights.js` read the profile's predicate.

### 8.3 Where a scan starts

For `segmentation: "scan"` packs the scan starts at the hovered character, as
today. For `"spaces"` packs `content-scan.js` moves the start back to the
first character of the hovered word (`text.wordCharacters` and
`wordInternal`, as Yomitan's word scan resolution does), and the source
highlight starts there. Exact selections are not moved. The collected length
is `max(scanLength, longKeyLength + 8)` code points over the profile's
enabled packages, capped at 256, as today.

### 8.4 Sentences

`sentence.js` takes its terminators and quote pairs from the profile's pack;
the Japanese pack carries today's tables. The 200-character extent and every
cutting rule stay. `word-highlights.js` uses the same tables instead of its
own list.

### 8.5 Other surfaces

- **Search page**: the search box and the echoed query take the profile's
  `lang` and `dir`. The leading punctuation the page skips stays.
- **Word highlighting**: each text block is segmented with the profile a
  lookup in that block would use (section 8.1); `hd_segment` carries it.
  Profiles whose pack lacks `wordHighlighting` show no marks and hide the
  feature.
- **Netflix (experimental)**: the subtitle track filter takes the pack's
  `bcp47` primary subtag instead of `ja`, and lines are joined with the
  pack's `lineJoiner`.
- **Google Docs (experimental)**: the imposter text gains the hovered run's
  direction, which it lacks today.
- **Text fields**: the imposter already copies the field's computed style,
  direction included. Its clipping assumes a field scrolls to the right, so in
  a right-to-left field a lookup near the clipped edge may miss (section 21).
- **Debug log redaction** keeps today's Japanese pattern and adds each
  installed non-Latin pack's `text.pattern`, with the pack code as the
  replacement (`[ar]`).

## 9. The engine

### 9.1 Packs

`scripts/sync-languages.mjs` copies every pack from the submodule into
`extension/vendor/languages/<code>/` (`language.json`, `transforms.json`) and
writes `extension/vendor/languages/registry.js`, a classic script with the
parts of every descriptor that readers and Settings need on every page
(identity, `text`, `capabilities`, `presentation`, `settings`, the speech and
audio languages) and each pack's personal-dictionary id (section 15). Samples
and recommended dictionaries stay in the JSON files, which Settings and the
startup page fetch when they need them. The copy is committed with each
submodule bump, as the WebAssembly bundles are; `test/language-packs.test.mjs`
fails when it differs from the submodule. `registry.js` is loaded by the
content scripts, Settings, the worker and the engine service.

### 9.2 Loading

- The Japanese pack is built into the engine (engine contract, section 10),
  so Japanese lookups need no loading. The engine service loads every other
  profile's pack as the engine starts, before it reports ready
  (`hdw_language_load` with the two JSON files, fetched from the extension),
  and loads a pack when a profile for it is added.
- The loaded dictionary set is every package enabled in any profile, plus the
  load verification of disabled packages that exists today. Loading one
  package for two profiles costs it once.
- The warm-up lookup after loading uses the Japanese pack's `sample.warmup`
  (`食べました`, today's text) when a Japanese profile exists, otherwise the
  active profile's.

### 9.3 Requests

`hd_lookup`, `hd_lookup_dictionary`, `hd_segment` and `hd_kanji` gain an
optional `profileId`. The engine service maps it to the profile's language,
its ordered list of enabled package paths and its pack setting engine
effects, and passes them to the engine as `language`, `dictionaries` and
`languageOptions` (engine contract, section 9.6). In the single-profile shape
none of these keys is sent, so the request reaching the engine is
byte-identical to today's.

### 9.4 Japanese-only work in the engine service

- The KANJIDIC furigana split (`withFurigana`) runs only for profiles whose
  pack has `ruby.alignment: "kana"`.
- The personal-dictionary filter removes the profile language's personal
  package.
- The frequency-direction sampler uses the pack's `host.frequencySamples`
  (Japanese keeps today's twenty words) and reports no direction when a pack
  has none, as it does today for every non-Japanese dictionary.

## 10. Rendering text in a language

### 10.1 `lang` and `dir`

The popup's interface is English and stays left to right. Text in the
profile's language is marked where it appears:

- headword, reading, matched text, deinflection endpoints, the sentence and
  the character view's character get `lang` = the pack's `bcp47` (the
  Japanese pack's is today's literal `ja`);
- glossary text keeps today's detection, which labels Japanese text `ja`,
  extended so that Han-only text takes `zh` in a Chinese profile;
- for a right-to-left pack only: the source text above also gets
  `dir="rtl"`, each glossary container gets `dir="auto"` (and the
  dictionary's `targetLanguage` as `lang` when the index declares one), and
  user-input fields (Note form, search box) get `dir="auto"`.

Left-to-right packs get no `dir` attributes, so a Japanese popup's markup is
exactly today's.

The popup host also gets `data-hd-language` and `data-hd-direction`, and the
custom properties `--hd-language-font-family`, `--hd-language-word-break` and
`--hd-language-line-break` from the pack's typography (unset when the pack
leaves them null, which the Japanese pack does).

Mirroring the whole popup for an Arabic profile was rejected: the popup's
words, buttons and tabs are English, and the definitions of an
Arabic-English dictionary are English too (decision record 0004).

### 10.2 Default renderer

- The headword's `lang` comes from the profile instead of the literal `ja`.
- The headword builder follows `ruby`: `kana` keeps `appendExpressionRuby`
  exactly; `syllable` and `word` draw one ruby per syllable or over the word;
  no ruby shows a non-empty reading that differs from the headword as a
  reading line beside it.
- Clickable characters use the pack's `characterView.pattern`; without a
  character view nothing is clickable. The Japanese pattern is today's
  `HAN_CHARACTER_PATTERN`.
- The character view's labels (On, Kun, Meanings) come from the pack.
- The Note form's Reading field is required, optional or hidden according to
  `readings`.
- Fonts and line breaking read the custom properties of section 10.1 with
  today's values as fallbacks.

### 10.3 Display transforms

Before a render, core builds `result.presentation` for each result when the
profile has an active `display` setting: the headword and reading with the
setting's display transform applied, using the step kinds of the engine
contract (`case`, `normalize`, `strip`, `map`, `pattern`) implemented in
`language-text.js`. Without such a setting no `presentation` is built.

## 11. The language-aware theme contract

Themes keep the version 2 view contract (docs/themes/README.md). This section
adds to it; nothing in it changes what a theme receives for the Japanese
profile, except the language fields themselves.

### 11.1 What a view receives

`createView(options)` gets `options.language`, and every render context gets
`context.language`, for the profile the render is for:

```js
{
  version: 1,
  code: "ar", bcp47: "ar", name: "Arabic", direction: "rtl",
  capabilities: { readings: "none", ruby: null, pitchAccent: false, characterView: null, wordHighlighting: true },
  // character, onyomi, kunyomi: the pack's characterView name and reading labels (null without one);
  // reading, traceMarker, readingBrackets: the pack's presentation.labels, with these defaults.
  labels: { reading: "Reading", character: null, onyomi: null, kunyomi: null, traceMarker: "", readingBrackets: ["(", ")"] },
  settings: { vowelMarks: "hide" },
  sourceAttributes() {},          // -> { lang: "ar", dir: "rtl" }; only lang for left-to-right packs
  glossaryAttributes(title) {},   // -> { dir: "auto", lang?: target language of that dictionary }
  isCharacterLink(character) {},  // pack characterView.pattern; always false without a character view
  display(result, field) {},      // result.presentation[field] ?? result.term[field]
  readingFor(result) {},          // the reading to show, or "" when there is none to show
}
```

Two consecutive renders can carry different languages when automatic
switching is on, so a view reads `context.language` on every render; the
`options.language` passed at creation is for one-time work such as font
warm-up. The object is the same for every theme and versioned by `version`.
A view created or rendered without it (an older host, the existing theme
tests) uses the Japanese descriptor, which reproduces today's behaviour.

### 11.2 Shared components

`components.language` exposes the functions above without a context, for
code that runs outside a render, plus the Default renderer's ruby and
character-view builders for themes that want them:
`appendHeadword(document, parent, result, language, onCharacterClick)` and
`characterEntryResult(character, entry, language)` (today's
`kanjiEntryResult` with the pack's labels).

### 11.3 What a theme declares

A theme's catalogue entry in `extension/vendor/themes/index.json` gains:

```json
"language": {
  "directions": ["ltr", "rtl"],
  "renders": ["readings", "ruby", "pitchAccent", "characterView", "pronunciation", "presentation"]
}
```

An entry without `language`, which is every theme written for version 2, is
read as `{"directions": ["ltr"], "renders": ["readings", "ruby",
"pitchAccent", "characterView", "pronunciation"]}`: what those themes do
today.

### 11.4 Fallbacks

- **Direction.** When the profile's direction is not in the theme's
  `directions`, the host adds `render/language-fallback.css` after the
  theme's stylesheet. It gives every element in the popup
  `unicode-bidi: plaintext` and `text-align: start` (with `!important`, so it
  overrides a theme's `text-align: left`). Every paragraph then takes the
  direction of its first strong character and aligns to its start: Arabic
  lines read right to left, and English interface text is unchanged. The
  theme needs no change.
- **Capabilities a theme does not render** are omitted, as Nazeka omits pitch
  graphs today: an older theme shows no ruby for a Chinese reading, but
  never shows wrong data. A theme that does not render `characterView` offers
  no clickable characters.
- **`presentation`.** A theme that does not render `presentation` shows the
  stored headword, and the pack's display settings are hidden while it is
  selected.

### 11.5 Design settings

A Design control shows when:

1. it is a core control, or the theme lists it in `designSettings`, and
2. the profile has the capability the control requires (section 7.3), and
3. for a pack `display` setting, the theme renders `presentation`.

Design settings stay per theme as today. Language-specific Design settings
come in two kinds:

- **Defined by a language**: pack `display` settings (Arabic vowel marks,
  Chinese zhuyin). The pack defines them once and every theme that renders
  `presentation` honours them.
- **Defined by a theme for some languages**: a theme that needs a setting of
  its own (say, Crystal's Mincho headwords) uses the existing route: a core
  Design key, declared in the theme's `designSettings`, with a requirement in
  `OPTION_REQUIREMENTS` (for example `ruby`). It shows only for that theme
  and only in profiles with the capability.

### 11.6 The vendored themes

| Theme | Changes |
| --- | --- |
| Default | Section 10.2. Declares both directions and every render. |
| Plain | Glossary containers take `glossaryAttributes`; `text-align: start`. Declares both directions and `presentation`. |
| Nazeka | Character links from `isCharacterLink` instead of `/\p{Script=Han}/u`; headword and reading through `display` and `sourceAttributes`; the reading's `《》` brackets come from `labels.readingBrackets` (the Japanese pack keeps `《》`); the headword's `aria-label` leaves out an empty reading. |
| JL, Bee | Character links from `isCharacterLink`; headword, reading and deconjugation endpoints through `display` and `sourceAttributes`; the `～` before rule names from `labels.traceMarker` (Japanese keeps `～`); kanji view `On:` and `Kun:` from the pack's labels; `text-align: left` on text containers becomes `start`. |
| Crystal (Grey, Beige, Retro blue) | As JL, including the deinflection trail's `～`. The dictionary plaques' letter-spacing is dropped while the profile is right to left (`:host([data-hd-direction="rtl"])`), because spacing breaks the joins of an Arabic title. The gold frame and plaque artwork stay as they are, because the interface they frame stays left to right. |

For Japanese each change reproduces today's output: the Japanese pack's
labels are today's strings and its character pattern is
`HAN_CHARACTER_PATTERN`. One exception, chosen on purpose: Nazeka, JL, Bee and
Crystal test characters with `\p{Script=Han}` today, which also makes `々`,
`〇` and the CJK radicals clickable. They will use the Japanese pack's pattern
like Default, so those characters stop being clickable in the four themes.

### 11.7 Contract tests

- `test/theme-languages.test.mjs` renders every vendored theme (and each
  Crystal variant) in jsdom with the Japanese, English and Arabic packs'
  `host.sample.entry` and character samples, and a Korean sample kept in
  `test/data/languages/` until the Korean pack lands. For each it checks:
  the view renders without errors; source text carries the pack's `lang` and
  `dir`; no Japanese-only label (`On:`, `～`, `《》`) appears for another
  language; clickable characters follow the pack's pattern; a pack display
  setting changes `presentation` text in themes that render it and is absent
  from the others; a theme without the language declaration gets the
  direction fallback stylesheet for Arabic.
- `test/chrome-languages.mjs` renders the same matrix in real Chrome and
  saves one screenshot per theme and language (Japanese, English, Arabic,
  Korean) under `test/tmp/languages/`, as `chrome-theme-store.mjs` does.
- `test/theme-renderer.test.mjs` keeps its Japanese checks unchanged, and its
  `designSettings` equality check runs with the Japanese capabilities.

## 12. Anki

- **Templates per profile.** `anki.templates` belongs to the profile; the
  AnkiConnect address and key are global. The flat `anki` projection
  (`deck`, `model`, `fields`, …) is the profile's first Template, as it is
  the single list's first Template today.
- **Built-in mining, word status and the duplicate index** use the profile in
  effect's first Template. The duplicate-index cache keeps one snapshot per
  source key, so switching back to a profile reuses its snapshot.
- **Markers.** The marker list in Settings hides markers whose capability the
  profile lacks (`{furigana*}` without ruby, `{pitch*}` without pitch accent,
  `{character}`, `{onyomi}`, `{kunyomi}`, `{stroke-count}` without a character
  view). A saved template keeps them and they produce what they produce
  today: an empty string, or for `{furigana}` the plain headword.
  `{phonetic-transcriptions}` (IPA) is offered in every language.
- **`{part-of-speech}`** reads the pack's `anki.partOfSpeechLabels`; the
  Japanese pack carries today's table.
- **Note types.** Automatic detection and presets (Kiku, Lapis, Senren) run
  only for packs listing those families in `anki.noteTypeFamilies`. Field-name
  suggestions add the pack's `anki.fieldAliases`.
- **Right-to-left.** For a pack whose direction is `rtl`, the glossary
  markers' root element gets `dir="auto"`. Nothing changes for other packs,
  so Japanese notes are byte-identical.
- **Relay API (GameSentenceMiner).** `profileIndex` 0 answers with the active
  profile's Templates. Exposing every profile as a Yomitan profile index is
  later work.

## 13. Pronunciation audio

- `audioSources` and `audioAutoplay` belong to the profile.
- Browser speech uses the pack's `host.ttsLanguage` for `utterance.lang` and
  for choosing an automatic voice; the messages name the language ("No
  English speech voice is available…"). Japanese keeps `ja-JP` and today's
  Google voice preference.
- `{language}` in audio URL templates is the pack's `host.audioLanguage`
  (`ja` for Japanese).
- Local Audio Server detection runs only for Japanese profiles.
- The Test button uses the pack's sample entry instead of `聞く`.

## 14. Dictionaries per profile

- **Library.** Settings → Dictionaries shows the active profile's
  dictionaries in its order, with enable switches, reordering and groups as
  today. Below it, *Dictionaries in your other languages* lists packages the
  profile does not use, with **Use in {language}**; and a package can be
  removed from the profile without deleting it (**Remove from {language}**)
  or deleted from Hachidori (**Delete**, which names every profile using it).
- **Import.** An import adds the package to the active profile, enabled and
  last. When the archive's `sourceLanguage` names another installed profile's
  language, the success line says so and offers **Move to {language}**. A
  reimport or update keeps every profile's membership, order and enabled
  state.
- **Recommended dictionaries.** The Japanese catalogue, its trust rules and
  its automatic installation stay exactly as they are and install into the
  Japanese profile. Other packs list `host.recommendedDictionaries` as links
  that open the dictionary's download page; the user imports the file. No
  source is added to the catalogue (decision record 0006).
- **Selections.** The frequency, clicked-character, compact-summary, pitch,
  blur and image-source selections belong to the profile and are pruned and
  migrated against the profile's packages and groups.
- **Updates** stay global: one schedule, per-package overrides.
- **Memory.** Every package enabled in any profile is loaded. Settings →
  Advanced → Memory shows the total as today.

## 15. Personal dictionary, lookup counts and known words

- **Personal dictionary per language.** Japanese keeps today's package (fixed
  id `e4c2e20a1a964b6cbd4ae3f87643c1f0`, title *Hachidori Custom Dictionary*)
  and source document. Another language's personal package has the fixed id
  the first 32 hexadecimal digits of SHA-256(`hachidori-custom-dictionary:` +
  code), computed when `registry.js` is generated, and the title
  *Hachidori Custom Dictionary ({English name})*. Every personal title is
  reserved. Each is pinned first and enabled in every profile of its language
  and never appears in other profiles. Every invariant in AGENTS.md's
  "Managed custom dictionary" section applies per language.
- **Rows.** The source format stays `term, reading, definition`. The reading
  may be empty when the pack's `readings` is not `required`; the parser and
  the Note form follow that.
- **Lookup counts** are counted per language (section 4.3); resetting counts
  resets every language. The count shown is for the profile in effect's
  language.
- **Known and ignored words** are kept per language (section 4.3).

## 16. Choosing and switching languages

- **First run.** The welcome card has *I'm learning* with every pack, Japanese
  first and selected. Choosing another language and **Start setup** creates
  that profile as the only one. The dictionary stage then shows the pack's
  recommended links and an import area that uses Settings' import code
  instead of automatic installation; the Anki stage runs detection only for
  packs with note-type families and otherwise says Anki can be set up in
  Settings; the practice stage uses the pack's `sample.practice`. The stage
  order and the setup record do not change.
- **Toolbar.** With two or more profiles, a row above today's controls has
  one button per profile (the language's name, and its native name when that
  differs) in a radio group; one click activates it. With one profile the
  toolbar is exactly today's. The lookup switch keeps today's label
  ("Japanese lookups") while the only profile is Japanese and reads
  "Lookups" otherwise.
- **Shortcut.** A browser command and keybind action **Switch to the next
  language**, suggested Alt+Shift+L, routed to the active tab's reader like
  the other popup actions; the reader asks the worker to activate the next
  profile. On pages where Hachidori cannot run (browser pages), use the
  toolbar.
- **Badge.** With two or more profiles the toolbar icon's badge shows the
  active profile's code (`JA`, `EN`).
- **Settings sidebar.** Under the Hachidori name, a **Language** menu shows
  the active profile and switches it, and **Add or remove languages** opens a
  dialog: the profiles with their dictionary counts, **Remove** (after
  confirmation; it deletes the profile's settings and keeps its dictionaries
  in the library, and keeps the language's personal dictionary until its last
  profile is removed), and **Add a language** with every pack not in use.
  Language management is not a new rail section, because existing tests pin
  the nine rail links.
- **Reading → Scanning** gains **Switch language automatically from the
  page's language** (`profileAutoSwitch`, global, off), shown with two or
  more profiles.
- Sections whose settings are all global say *All languages* under their
  heading when there are two or more profiles.

## 17. Backup, restore and sharing

### 17.1 Backups

- A backup is still the six-key snapshot plus files. Profiles travel inside
  `options` and `dictionaryState`; language-scoped data inside
  `customDictionarySource`, `wordStatusOverrides` and the lookup rows, whose
  row objects gain `language` for non-Japanese rows.
- An installation in the single-profile shape writes the version 3 format of
  today, byte for byte. An installation with profiles writes version 4.
- Version 1-3 backups restore as one Japanese profile, through the same
  projection. Version 4 backups restore every profile. A version 4 backup
  restored by an older Hachidori restores its dictionaries and falls back to
  default settings, the existing rule for settings it cannot read.
- Restoring replaces every profile at once, as it replaces every setting
  today.

### 17.2 Sharing

- The linked browsers mirror the host's options and library, profiles
  included, and share the active profile.
- The `hello` frame gains the capability `language-profiles-v1`.

### 17.3 Linked browsers running an older Hachidori

A client without `language-profiles-v1` cannot read the profile shapes. When
the host has profiles, it sends such a client the single-profile projection
of its active profile for `options`, `dictionaryState`,
`customDictionarySource`, `wordStatusOverrides` and the lookup rows, and
applies that client's writes, which carry no `profileId`, to the active
profile. The client cannot see or switch other languages. A new client linked
to an older host sees the host's state as one Japanese profile and cannot add
languages while linked.

### 17.4 Overlay mode

GameSentenceMiner's overlay keeps its local option keys on top of the active
profile's projection, as it does on top of the single options record today.

## 18. Tests

- **Unchanged:** every existing suite (section 6.2). New checks go into new
  files, never into the existing suites, so those files stay byte-identical;
  only the runner (`test/run.mjs`) and the CI workflow learn the new suite
  names.
- **New, Node:** `profiles.test.mjs` (projection, routing, masking,
  single-profile rule, migration of every stored shape and backup version,
  requirement table vs `data-requires`); `language-packs.test.mjs` (vendored
  copy equals the submodule; every descriptor's host blocks are valid; the
  JavaScript display steps and classes agree with the engine's expectations
  shipped in each pack); `theme-languages.test.mjs` (section 11.7);
  `sentence.test.mjs` and `content-scanning` cases per pack (word starts,
  terminators, RTL).
- **New, engine smoke:** `node-smoke-languages.mjs` with English and Arabic
  fixture dictionaries built by `make-language-fixtures.mjs` (with
  `sourceLanguage`), checking `hdw_lookup` with `language` and
  `dictionaries`, the Japanese reply bytes without them, and per-language
  segmentation.
- **New, real Chrome:** `chrome-languages.mjs`, with its own fixed plan:
  first-run language choice; create Japanese, English and Arabic profiles;
  import one dictionary per language; hover inflected words on sample pages
  (spaces, CJK, right-to-left); add an Anki note through the fake
  AnkiConnect; switch profiles from the toolbar, by the shortcut and
  automatically by `lang`; hidden settings per profile; backup and restore
  with profiles; screenshots of the picker, the switcher and one lookup per
  script.
- **Firefox:** `firefox-e2e` unchanged, plus `firefox-languages`: one profile
  switch and one English and one Arabic lookup.

## 19. Performance

- **Japanese lookups**: the engine contract's budget (section 13 there),
  measured with `benchmark/run.mjs` (Jitendex and Pixiv Light) and the Node
  `hdw_lookup` timings before and after, same machine, repeated runs.
- **Hover**: `benchmark/hover-popup.mjs` input-to-first-frame and complete,
  before and after, with the Japanese fixture: within noise.
- **Profile switch**: no reload; the first lookup after switching is as fast
  as any other. Measured from the toolbar click to the first popup.
- **Memory**: unchanged for single-profile installations; otherwise the sum
  of the dictionaries enabled in any profile, reported with
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
   and the browser suites.

The language then appears in the first-run choice, in **Add a language**,
and in every theme.

## 21. Known limits

- The user interface is English; only content follows the language.
- The manifest description and the "Turn Japanese lookups on or off" command
  name stay Japanese: they are static and pinned by tests. Renaming them is a
  one-line change for the owner to decide.
- One profile per language in version 1.
- Recommended dictionaries for other languages are links, not one-click
  installs.
- Debug-log redaction does not cover Latin-script languages, whose text
  cannot be told apart from log messages.
- Word highlighting for space-delimited languages marks single words; it does
  not split clitics.
- The Relay API exposes the active profile only.
- Lookups load every profile's enabled dictionaries; loading a profile's
  dictionaries on first use is possible later behind the same engine API.
- In a right-to-left text field, a lookup near the field's clipped edge may
  miss: the imposter's clipping assumes left-to-right scrolling.
