# Backup archive

L2 follows GSM PR #549 at `524ed0b3b92decae87f65df02df9ef9e512f7674`:
prepare and validate an immutable archive, install fresh dictionary generations,
publish the complete state transaction, then clean superseded generations.
Desktop paths, profiles and application-backup plumbing are not portable.

The extension format is a stored ZIP64 archive. Native dictionary data is already
compressed; storing it avoids recompression and allows files and archives larger
than classic ZIP's representation. `hachidori-backup.json` identifies format
`hachidori-backup`, version 1, creation time, the persisted-state snapshot and the
exact file list with sizes. Payload names are `dictionaries/<ordinal>/<relative
file path>`; paths from a backup are never used as live generation paths.

Every entry's CRC32, declared size, path and ZIP headers are validated before
restore. CRC32 detects accidental corruption, not authenticity: only restore
archives you trust. Unlike GSM's Node streaming SHA-256 implementation, the
browser format uses ZIP's streaming checksum without buffering a whole native
file for WebCrypto. There are no product size or entry-count caps. Available
browser storage and the ZIP/browser numeric representation remain constraints.

The lazy backup module uses zip.js 2.11.2, vendored from commit
`3b81b8f79d2abd2bc0ac1f09afd7e933effced62`, under its BSD-3-Clause license in
`extension/vendor/zip-LICENSE`. `extension/vendor/zip.js` is the unmodified
`dist/zip-core-external.min.js` (SHA-256
`09a4776c6baf40f3e2aa0c7c66199f6aa3ebdefc927e83dcaf1dfffd432f9bac`).
It runs in the existing engine context with additional workers disabled. Only
stored, unencrypted regular files are part of this format, so neither external
codecs nor an additional WebAssembly binary are needed. This is not a GSM or
general-purpose ZIP importer.
