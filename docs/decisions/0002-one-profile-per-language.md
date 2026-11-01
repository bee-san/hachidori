# 0002: One profile per language; personal words belong to the language

Status: proposed (multi-language design, Phase 1, revision 7)

## Context

The owner asked for "a per language profile kind of thing". Yomitan has
free-form profiles unrelated to language. Some user data (the personal
dictionary, lookup counts, words marked known) is about words, not about
settings.

## Decision

Version 1 allows one profile per language and gives the first profile of a
language that language's code as its id (`ja` for every existing user). The
personal dictionary, lookup counts and known or ignored words are keyed by
language, so a second profile of the same language, if one is ever allowed,
shares them.

## Options rejected

- **Free-form profiles as in Yomitan.** Users would have to build a "language
  profile" out of generic parts, and the toolbar would list names rather than
  languages. Nothing in the data model prevents adding them later.
- **Per-profile personal dictionaries, counts and marks.** Two Japanese
  profiles (for example one per Anki deck) would split one learner's words in
  two.
- **One global personal dictionary for every language.** Its single compiled
  package would answer every language's lookups, and its rows would need a
  language column the engine cannot filter on.

## Consequences

- AGENTS.md's managed custom dictionary rules apply once per language, with a
  fixed id derived from the language code.
- Removing a language's profile keeps its personal package with its source,
  outside every profile and unloaded, so the pair stays valid and adding the
  language again needs no compile; erasing saves an empty source, which
  removes the package in the same commit as today.
- Japanese keeps today's personal package id, title and source document.
