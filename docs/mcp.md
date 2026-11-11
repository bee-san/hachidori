<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# MCP configuration

[hachidori-mcp](https://github.com/bee-san/hachidori-mcp) lets a local AI client
set up languages, edit settings and install userscripts. It connects as a native
Hoshidicts client to the existing Anki relay (`/link`, origin
`hoshi://hoshidicts`). Keep Anki and the sharing browser open; Sharing must say
*Sharing through Anki*. No new Anki add-on or exposed HTTP endpoint is needed.
As with sharing today, an empty installation must import a dictionary before it
becomes a host.

The host advertises `mcp-configuration-v1`. The client performs the ordinary
language-profile opt-in using the host's pack codes, then sends these requests
to `hachidori-mcp`:

| Type | Fields | Result |
| --- | --- | --- |
| `hd_mcp_describe` | optional `profileId` | Version, options and selection revisions, stored/effective settings, defaults, enum choices, numeric ranges, global keys, profiles, language descriptors, dictionary rows, themes and userscript registration |
| `hd_mcp_options_write` | `baseRevision`, optional `profileId`, `options`, optional `packSettings` | Ordinary options-write result, with credentials redacted |
| `hd_mcp_select_profile` | `baseRevision` of selection, `profileId`, optional `autoSwitch` | Ordinary language-selection result |
| `hd_mcp_user_script_write` | `baseRevision`, stable `id`, `script` patch or `remove: true` | Ordinary options-write result, with credentials redacted |

Metadata comes from the production registries. The dedicated target keeps an
explicit change to the **host's** active language distinct from ordinary linked
browsers' `hd_language_selection_write`, which remains installation-local.
Omitting a profile uses the host's current active profile. Selection requires
Multiple languages to be on.

Writes run in the background storage queue and delegate to the existing option
and language-selection handlers. Unknown setting keys and invalid values fail;
stale revisions return conflicts. Nested options merge against current values,
arrays replace as a unit, and omitted credentials are preserved on the host.
Anki's first-Template projection stays consistent when editing either its flat
fields or its Templates list. Script edits preserve the other scripts and their
order. Changing a store script's code, name or CSS removes its store attribution;
toggling it preserves that attribution.

Profile creation and dictionary imports use the existing engine and chunked
upload messages. They must never run while holding the storage queue. Adding
the first non-Japanese profile deliberately retires the sharing session; the
MCP client opens a new session for the next operation and never replays writes.

JavaScript permission still requires a user gesture in Chrome/Firefox.
Registration reports availability, not execution in a particular page; saved
JavaScript runs on the next page load. CSS applies to the next popup. The debug
report identifies this capability and transport alongside its existing sharing,
per-profile configuration and script-registration diagnostics.

Tests: `test/mcp-host.test.mjs` exercises the production shared-request dispatcher,
validated writes, conflicts, credentials, script preservation and host selection.
The MCP repository runs stdio/WebSocket tests and an integration suite against
this extension and the Python relay.
