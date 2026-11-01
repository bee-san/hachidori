# 0009: Older linked browsers see the host's active profile as their only one

Status: proposed (multi-language design, Phase 1)

## Context

A linked browser mirrors the host's storage keys and runs its own code on
them. GameSentenceMiner's overlay embeds a copy of Hachidori that is updated
with GameSentenceMiner, not with the browser extension, so versions differ.
An older client cannot read a schema-2 `dictionaryState`.

## Decision

The host advertises `language-profiles-v1`. To a client without it, a host
with profiles sends the single-profile projection of its active profile and
applies the client's writes (which carry no `profileId`) to the active
profile.

## Options rejected

- **Refuse older clients once the host has a second language.** Simple, but
  breaks a working overlay the moment the user adds English in Chrome.
- **Send the raw records and let the client fail.** Corrupts the client's
  state.

## Consequences

- An older client keeps working and follows the host's language switches.
- The projection functions that the rest of the design needs anyway do the
  work; the sharing host gains one branch on the capability.
