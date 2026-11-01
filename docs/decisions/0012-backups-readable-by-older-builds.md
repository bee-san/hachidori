# 0012: Version 4 backups carry a version 3 snapshot of the Japanese view

Status: proposed (multi-language design, Phase 1, revision 2)

## Context

Backups are restored across versions: the Chrome Web Store build lags the
repository and the Firefox build installs separately. Today's reader accepts
any manifest version and skips fields it does not know, but it rejects a
schema-2 `dictionaryState` ("The backup contains invalid dictionary state.")
and drops unknown option keys.

## Decision

A backup with profiles is version 4. Its `snapshot` is a valid version 3
snapshot of the Japanese view (every package, the Japanese order and enabled
flags first; Japanese options flattened; the Japanese personal document,
marks and lookup rows). A new manifest field `profiles` carries the complete
records and the other languages' data. A version 4 reader restores from
`profiles`.

## Options rejected

- **Schema-2 state and nested options in `snapshot`.** Older builds refuse the
  whole backup, dictionaries included.
- **Flatten every profile into `snapshot`.** One options record cannot hold two
  profiles' values.

## Consequences

- An older build restores the dictionaries and the Japanese setup of a newer
  backup.
- Single-profile installations keep writing today's version 3 backups.
