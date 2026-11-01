# 0009: Older linked browsers see the host's Japanese profile as their only one

Status: proposed (multi-language design, Phase 1, revision 5)

## Context

A linked browser mirrors the host's storage keys and runs its own code on
them. GameSentenceMiner's overlay embeds a copy of Hachidori that is updated
with GameSentenceMiner, not with the browser extension, so versions differ.
An older client cannot read a schema-2 `dictionaryState`. Every older build is
Japanese-only.

## Decision

A host whose records have profiles advertises `language-profiles-v1`; the
client's hello does not change, and a new client opts in with one forwarded
request before it applies the hello's snapshot. To every client that has not
opted in, the host sends the Japanese view (the Japanese data in today's
shapes) in its own change frames and in every reply that carries options,
dictionary state or a personal document, whatever language the host itself
reads in, and applies that client's writes (which carry no profile) to the
Japanese profile. When the host has no Japanese profile, that client's reads
and lookups are answered from the Japanese view (which finds nothing) and its
writes are refused with a message that names the cause, so they never land in
another language. When a host first gains profiles it closes its connections
once, after the converting request's reply, so clients say hello again.

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

- An older client keeps working on the Japanese profile; its target is always
  the Japanese data, so a stale base revision is still refused as today. It
  cannot delete a package that a profile other than Japanese uses, because it
  shows those packages as disabled Japanese dictionaries.
- The sharing host changes in several places: per-client change frames
  instead of one broadcast, projected replies by request type, allowlists that
  keep a validated `profileId`, and one reconnect when profiles first appear.
  The projection functions the rest of the design needs build the view.
