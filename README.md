# Evidence for #582: focus when Copy error details hides

These are viewport screenshots in Chrome for Testing 152.0.7977.75 (headless) with the real extension loaded, on #582's head. In each one a keyboard-focused **Copy error details** button hid because its status left the error tone, and focus moved to the status.

- Settings: the engine status went "Cannot reach the engine…" → "Ready…".
- Startup: the setup status went "X could not be installed…" → "Y installed in …".
- Both have a visible focus ring. The next Tab continues after the status.
- Light is the default scheme; dark is `prefers-color-scheme: dark`.

`scripts/focus-copy.mjs` is the probe from the independent audit (audit-pr-sweep-hachidori-b), with a `PRSWEEP_SCHEME` switch added. Run it as `HACHIDORI_CHROME=<chrome> AUDIT_SHOTS=<dir> node scripts/focus-copy.mjs <repo> <profile> <repo>/test/tooling`.
