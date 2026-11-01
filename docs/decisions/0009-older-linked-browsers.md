# 0009: Older linked browsers see the host's Japanese profile as their only one

Status: proposed (multi-language design, Phase 1, revision 2)

## Context

A linked browser mirrors the host's storage keys and runs its own code on
them. GameSentenceMiner's overlay embeds a copy of Hachidori that is updated
with GameSentenceMiner, not with the browser extension, so versions differ.
An older client cannot read a schema-2 `dictionaryState`. Every older build is
Japanese-only.

## Decision

A host whose records have profiles advertises `language-profiles-v1`; the
client's hello does not change, and a new client opts in with one forwarded
request. To every client that has not opted in, the host sends the
single-profile projection of its Japanese profile, whatever language the host
itself reads in, and applies that client's writes (which carry no profile) to
the Japanese profile.

## Options rejected

- **Project the host's active profile.** Switching the host to English would
  switch an older overlay reading a Japanese game, and a write based on one
  profile's view could land in another profile or another language's personal
  document.
- **Refuse older clients once the host has a second language.** Simple, but
  breaks a working overlay the moment the user adds English in Chrome.
- **Send the raw records and let the client fail.** Corrupts the client's
  state.
- **Advertise the capability unconditionally.** Changes the hello frame of
  Japanese-only hosts, which existing tests pin.

## Consequences

- An older client keeps working on the Japanese profile; its target never
  changes, so a stale base revision is still refused as today.
- The projection functions that the rest of the design needs do the work; the
  sharing host gains one branch on the opt-in.
