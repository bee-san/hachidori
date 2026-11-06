# 0011: Settings edits one profile, chosen in the page, independently of the active profile

Status: accepted (multi-language design, Phase 1, revision 9). The languages
have since moved under Settings → Advanced (docs/languages.md 16.3): the
Language menu below is Advanced → Languages → **Settings shows**, and the
sidebar names the edited language with a link to it. That tab is the
experimental feature Multiple languages; while it is off the edited profile is
the Japanese profile, which lookups then use.

## Context

Settings adopts every newer `options` revision and shows the saved values with
its drafts laid over them. Activating another profile from the toolbar or the
shortcut writes storage. If Settings followed the active profile, a draft
typed for Japanese would be shown, and saved, over the English profile's
values.

## Decision

A Settings page has its own edited-profile id, chosen in its Language menu and
initialised from the active profile. Storage events change it only when the
edited profile is removed elsewhere, and the page says so. Its
drafts, pending saves and conflicts are keyed by it, and every write names it.
**Use for lookups** activates the edited profile; choosing a profile in the
menu does not.

## Options rejected

- **Settings always shows the active profile.** Edits can land in a profile
  the user did not edit, and editing English settings while reading Japanese
  would switch every tab to English.
- **One Settings section per profile.** Duplicates every control and breaks the
  existing rail and search.

## Consequences

- The edited profile and the active profile can differ; the Settings header
  says which language is edited, and the toolbar says which one is read.
