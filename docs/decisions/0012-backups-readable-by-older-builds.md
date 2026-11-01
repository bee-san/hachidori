# 0012: Version 4 backups carry a version 3 snapshot of the Japanese view

Status: proposed (multi-language design, Phase 1, revision 7)

## Context

Backups are restored across versions: the Chrome Web Store build lags the
repository and the Firefox build installs separately. Today's reader accepts
any manifest version and skips fields it does not know, but it rejects a
schema-2 `dictionaryState` ("The backup contains invalid dictionary state.")
and drops unknown option keys.

## Decision

A backup with profiles is version 4. Its `snapshot` is a valid version 3
snapshot of the Japanese view, built from the Japanese data whether or not a
Japanese profile exists: the Japanese personal package first and enabled when
it exists, the Japanese profile's packages in order, then every other package
disabled except other languages' personal packages, which are left out;
Japanese options flattened (or the global keys over Japanese defaults); the
Japanese personal document, marks and lookup rows. A new manifest field
`profiles` carries the complete records and the other languages' data; a
version 4 restore rebuilds other languages' personal packages from their
documents. Automatic snapshots, the Relay dictionary download and restore use
the same payload.

## Options rejected

- **Schema-2 state and nested options in `snapshot`.** Older builds refuse the
  whole backup, dictionaries included.
- **Flatten every profile into `snapshot`.** One options record cannot hold two
  profiles' values.

## Consequences

- An older build restores the dictionaries and the Japanese setup of a newer
  backup.
- A profile-aware build restores every language it has a pack for, names
  the ones it leaves out, and reaches the single-profile shape only by the
  rule of languages.md section 4.5 (section 17.6).
- Single-profile installations keep writing today's version 3 backups.
