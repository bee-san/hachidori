# 0006: Recommended dictionaries for other languages are links, not catalogue installs

Status: accepted (multi-language design, Phase 1, revision 9)

## Context

The Japanese catalogue installs five pinned sources automatically. AGENTS.md
requires catalogue sources to be validated by final URL, repository, title,
revision, index and capability, and names exactly which five exist. Most
other languages are served by Wiktionary-based dictionaries
(kaikki-to-yomitan), released as large archives per language pair.

## Decision

A pack lists recommended dictionaries as links (`host.recommendedDictionaries`:
name, download page, description, licence). Settings and first run open the
page; the user imports the file. The Japanese catalogue does not change.

## Options rejected

- **Catalogue entries per language.** Each needs pinning, validation rules
  and review under the catalogue trust rules, and an owner decision to extend
  the exact list of sources. Twenty-five languages would multiply that work
  for the first version.
- **Downloading from a URL template without validation.** Contradicts the
  trust rules.

## Consequences

- Setting up a new language takes one more step (download, then import).
- A language can be promoted to catalogue installation later, one source at a
  time, under the existing rules.
