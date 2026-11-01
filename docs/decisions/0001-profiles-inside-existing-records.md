# 0001: Profiles live inside the existing records, read through flat projections; the active profile is local

Status: proposed (multi-language design, Phase 1, revision 8)

## Context

About a hundred places read `options` through `normaliseOptions` and
`dictionaryState` through its normalisers: the reader, Settings, the worker,
the engine service, the Anki worker, backups, sharing. Every write goes
through one compare-and-set revision per record. Backups and sharing carry a
fixed list of six storage keys. Linked browsers mirror the host's records,
and GameSentenceMiner's overlay is linked to a browser while reading a game.

## Decision

`options` gains `profiles`; profile-scoped keys move into
`profiles[].settings`. `dictionaryState` gains `profiles` with each profile's
ordered package list and groups. The profile layer, inside `reader-options.js`,
projects either record into today's flat shape for one profile, and one
profile-aware writer applies flat patches. The active profile and automatic
switching live in a new installation-local key, `languageSelection`, outside
the sharing mirror and backups. While an installation has one Japanese
profile, nothing is rewritten and every record, message and frame keeps
today's shape.

## Options rejected

- **One storage key per profile** (`options:ja`, `options:en`). Every
  `storage.onChanged` listener, the backup snapshot, the sharing key list and
  the overlay's local-key partition would multiply, and a profile switch
  would need writes to several keys without one compare-and-set.
- **The active profile inside `options`.** Switching to English in Chrome
  would switch GameSentenceMiner's overlay, reading a Japanese game, to
  English dictionaries and Templates.
- **A separate `profiles.js` script.** Twenty-nine tests and several harnesses
  load `reader-options.js` on its own; a second required script would make
  `normaliseOptions` throw there.
- **Rewriting stored records on upgrade.** A migration write at startup races
  the reader's first read and the sharing mirror, and would change backups of
  users who never add a language.

## Consequences

- Existing consumers keep their code; writers go through one function and new
  requests name their profile.
- One revision serialises edits of different profiles. Settings already
  handles conflicts, and it keys its drafts by the profile it edits.
