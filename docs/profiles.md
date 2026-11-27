<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Profiles

Issue #796 asks for profiles that work like Yomitan's: several complete sets
of settings and dictionaries, and conditions that choose one automatically by
website, held key or popup level, with a default when nothing matches. This
page is the contract for that work. It builds on the language profile layer
of [languages.md](languages.md), which already gives each profile its own
settings, dictionaries, Anki Templates and pronunciation sources, and on its
language rules (section 8.1), which already choose a profile per lookup.

The owner chose the shape on 2026-11-27:

- **Scope.** A profile carries everything Yomitan's does. Besides what a
  language profile holds today, the reader's activation key or button, lookup
  mode, delays, child-popup mode, nesting depth, popup size, scale and toolbar
  position, and source highlight become profile settings. The machine's
  settings stay global: the AnkiConnect address, backups, sharing, memory
  modes, keybinds, Custom JavaScript and the experimental switches.
- **Placement.** Settings has a Profiles section of its own, behind
  Experimental features → Profiles while the feature settles, and it works
  for a Japanese-only reader.
- **Quick switch.** The toolbar shows the profile a tab uses and offers to use
  another on that site.

It arrives in three pull requests, each usable on its own:

1. Named profiles, several per language, and the Profiles section with the
   rules (this page, sections 2-9).
2. The activation and popup settings above as profile settings, so "no key on
   Netflix, Shift elsewhere" works (section 10).
3. The toolbar's quick switch (section 10).

## 1. Terms

Profile, active profile, edited profile and profile in effect keep their
meaning from [languages.md section 2](languages.md#2-terms). The **default
profile** is this page's name for the active profile: the one lookups use when
no rule picks another. A **copy** is a profile made from another profile of the
same language.

## 2. Names

A profile may have a `name`, text the reader chose, trimmed. A profile without
one is called by its language, as every profile was before. Names are not
unique and are not part of a profile's identity, which stays its id.

## 3. Storage

`options.profiles[]` gains the optional `name` beside `id` and `language`:

```json
{"id": "p-6f1c…", "language": "ja", "name": "Video", "settings": {…}, "packSettings": {}}
```

`normaliseProfile` keeps a non-empty trimmed name and drops anything else, so
every write through `applyOptionsPatch` keeps it. The single-profile shape of
[languages.md section 4.5](languages.md#45-the-single-profile-shape) is
unchanged: one Japanese profile has no name and no `profiles` record, so
naming needs a second profile.

`languageSelection` keeps the active profile and the rules exactly as
[languages.md section 4.4](languages.md#44-languageselection-installation-local)
describes. A rule is Yomitan's condition group: its conditions must all
match, and the first matching rule wins.

`hd_state_read` replies with records that have profiles gain
`profileLanguages`, each profile's language by id, which the engine uses to
place personal packages (section 5.1). A browser that has not opted into
language profiles never sees it.

## 4. Ids, the Japanese profile and the switch

A language's first profile keeps the language's code as its id, as in
version 1. A copy gets a generated id that is never a language code
(`p-` and a UUID from Settings), so no copy can be mistaken for another
language's first profile. Backups accept both and refuse a profile whose id is
another language's code.

The profile with the id `ja` stays the Japanese profile that older code,
older linked browsers, version 3 backup views and the Relay API know. It can
be removed only once it has no copies left (section 5.3), so a Japanese copy
never exists without it, and `japaneseProfileId` (`ja`, else the first
Japanese profile) only falls back for records written elsewhere.

**Experimental features → Profiles** (`experimental.profiles`) reveals
Settings → Profiles. While it is on, lookups may use any Japanese profile: the
default profile may be a copy, the rules apply, and Settings may show any
Japanese profile. Another language's profiles still need Multiple languages
(`profileUsable`). Off, lookups use the `ja` profile, as they did, unless
Multiple languages is on; the profiles, their names and the rules are kept.
Turning it off first moves Settings to the `ja` profile when the profile it
shows would no longer be usable, saving or refusing pending edits as Settings
shows does.

## 5. Requests

### 5.1 Copy

`hd_profile_add` with a `profileId` copies the profile `copyFrom` names under
that id and `name`. The language must be the source's, and the id must be new
and must not be a language code. The worker copies the source's settings
(Templates, custom buttons and dictionary selections included) and pack
settings verbatim. The engine copies its dictionary list with the enabled
flags, and its tab groups under new group ids, which stay unique across
profiles. Nothing is loaded or compiled. The first copy converts the
single-profile records as adding a language does.

A personal package is placed in every profile of its language, copies
included: `mergeEngineDictionaries` takes each profile's language from
`profileLanguages` instead of assuming the id is the language.

### 5.2 Rename

A name is written by `hd_options_write` with `profileId` and `profileName`
(text; empty or blank removes the name) through the same revision
compare-and-set as every options write, so linked browsers forward it to
their host like any setting.

### 5.3 Remove

`hd_profile_remove` names the profile and, from Settings, its `language`,
since a copy's id is not one. Removing one of a language's profiles while
another remains keeps the language's personal dictionary, lookup counts and
marked words, and the personal package stays in the remaining profiles. Such a
removal cannot erase them (`language-in-use`); the language's last profile can,
from Advanced → Languages, as before. The `ja` profile cannot be removed while
it has copies (`profile-original`). Removing the default profile, or the last
copy, behaves as removing a language does: the default moves to Japanese, the
profile's rules go, and one Japanese profile left converts the records back.

## 6. Settings → Profiles

The section follows Dictionaries in the rail and the section picker, and is
hidden, with `#profiles` leading to Advanced, while the switch is off.

**Your profiles** lists the profiles lookups may use, each row with:

- the default choice (a radio group, shown with two or more profiles), which
  writes `languageSelection.activeProfileId`;
- the name, a text field once there are two profiles, with the language's
  name as its placeholder, written when it changes or on Enter, and restored
  by Escape;
- the profile's language (shown when Multiple languages is on or a profile
  reads another language), its dictionary count, and **Default** and
  **Settings shows** badges;
- **Edit settings**, pressed as **Shown in Settings** for the edited profile,
  which makes it the profile every other section changes;
- **Copy**, which saves pending edits, copies the profile as "{name} copy",
  shows the copy in Settings and focuses its name;
- **Remove**, except on the last profile and on `ja` while it has copies,
  which asks first in a row under the list, with Cancel focused.

**Switch profiles automatically** is the rules card of the Languages tab
(`profile-rules-settings.js`) with the profiles' names, shown here with two or
more profiles. While Profiles is on, the Languages tab does not show it.

The sidebar link under Resume setup names the profile Settings shows
("Settings shows Video") and leads here while Profiles is on, and to Advanced
→ Languages otherwise.

The Languages tab shows each profile's name before its language, and its
removal question offers no erase while another profile of the language
remains.

## 7. Lookups

The content script applies the rules while Multiple languages or Profiles is
on, to the profiles lookups may use, which it works out when the records
change rather than at each scan. Automatic switching from the page's language
needs Multiple languages, and keeps the active profile when it already reads
the page's language rather than moving to the language's first profile.

## 8. Debug report

Each profile in the configuration carries its `name`, as the stored options
already do, and the experimental flags show the switch.

## 9. Tests

- `test/profiles.test.mjs`: a copy keeps its source's settings and list under
  a new id and name; the state read names each profile's language; the
  options writer names and unnames it; bad copy requests are refused; the `ja`
  profile and an erase are refused while another Japanese profile remains;
  removing the copy converts back; the switch lets lookups use any Japanese
  profile and only Multiple languages another language's.
- `test/backup-profiles.test.mjs`: a backup may hold a copy's id, never another
  language's code.
- `test/chrome-languages/profiles.mjs` (`node test/run.mjs chrome-languages`):
  the section in real Chrome, from the switch to a website rule and the
  default choice, with screenshots in both palettes.
- `test/data/profiles-golden.json` gained `profiles: false` in every recorded
  result, as `test/profiles-golden-record.mjs` describes.

## 10. Later pull requests

- The activation key or button, lookup mode, hover and hide delays,
  hide-on-exit, child-popup mode, nesting depth, popup width, height, scale and
  toolbar position, and source highlight move from `GLOBAL_OPTION_KEYS` to the
  profile, each profile starting from the value the installation had. The
  content script then reads them from the profile a frame's address picks, and
  a modifier rule chooses among the profiles whose activation that key
  satisfies, as Yomitan re-evaluates its options when a modifier changes.
- The toolbar shows the profile in effect for the tab and offers "Use {name} on
  this site", which adds or extends a Website domain rule.
