# 0001: Profiles live inside the existing records and are read through flat projections

Status: proposed (multi-language design, Phase 1)

## Context

About a hundred places read `options` through `normaliseOptions` and
`dictionaryState` through its normalisers: the reader, Settings, the worker,
the engine service, the Anki worker, backups, sharing. Every write goes
through one compare-and-set revision per record. Backups and sharing carry a
fixed list of six storage keys.

## Decision

`options` gains `profiles`, `activeProfileId` and `profileAutoSwitch`;
profile-scoped keys move into `profiles[].settings`. `dictionaryState` gains
`profiles` with each profile's ordered package list and groups. The profile
layer (`profiles.js`) projects either record into today's flat shape for one
profile, and the worker routes flat patches to the right place. While an
installation has one Japanese profile, nothing is rewritten and both records
keep today's shape.

## Options rejected

- **One storage key per profile** (`options:ja`, `options:en`). Every
  `storage.onChanged` listener, the backup snapshot, the sharing key list and
  the overlay's local-key partition would multiply, and a profile switch
  would need writes to several keys without one compare-and-set.
- **Duplicating the active profile's values at the top level.** Old readers
  would keep working, but every write would have to keep two copies equal.
- **Rewriting stored records on upgrade.** A migration write at startup races
  the reader's first read and the sharing mirror, and would change backups of
  users who never add a language.

## Consequences

- Existing consumers keep their code; only writers learn `profileId`.
- One revision serialises edits of different profiles. Settings already
  handles conflicts, and two people editing two profiles at once is not a
  real case.
