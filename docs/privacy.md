# Hachidori privacy policy

Last updated: 14 September 2026.

Hachidori helps you read Japanese with local dictionaries and save selected
study material to Anki. It is maintained by Autumn (Bee). For privacy questions
or support, email [github@skerritt.blog](mailto:github@skerritt.blog).

## Reading and local storage

Hachidori reads text near your pointer or selection to show dictionary results.
Surrounding text and the page title can be used in a note you choose to create.
Dictionary lookup runs inside your browser. There is no Hachidori analytics,
advertising or remote lookup service.

Your browser profile stores imported dictionaries and their indexes, personal
dictionary entries, preferences, dictionary update settings, and local lookup
statistics. Statistics contain each looked-up term and reading, its count, and
first/last lookup times. Turning off lookup counts in Reading settings pauses
new recording and keeps your existing history. Statistics do not contain a list
of visited page URLs.

Settings can contain custom service URLs, CSS, Anki field templates and an
optional AnkiConnect API key. Hachidori does not add application-level encryption
to browser profile storage. The AnkiConnect key is used only for requests to the
AnkiConnect server you configure.

## Downloads and optional connections

**First-run setup.** Choosing **Start Setup** starts downloads of Jitendex,
JMnedict, Bee's Ultimate Kanji Dictionary, Jiten Frequency Dictionary and Bee's
Ultimate Grammar Dictionary from
their publishers, who receive your IP address. Setup also reads deck, note-type,
card and note metadata from your configured AnkiConnect server (local by default)
to configure an existing mining setup, including a note type, deck and field
mapping. No Anki notes are changed during setup. You can choose **Set up manually**
instead. Dictionary installation continues if you
close the setup tab after starting it.

**Dictionary sources.** Recommended dictionaries and their update information
come from GitHub and its download hosts, jitendex.org and api.jiten.moe. Other
managed dictionaries contact their configured source URLs. Manual checks and
enabled update schedules contact these sources; scheduled runs can download and
install dictionary updates. Providers receive ordinary network information,
including your IP address and the requested resource. Dictionary downloads do
not send the text you look up to those providers.

**Anki relay download.** Choosing **Download the Anki add-on** under
Settings → Sharing downloads a pinned Hachidori Relay release from GitHub and
its download hosts. They receive ordinary network information, including your
IP address and the requested resource. The download does not send your
dictionaries, lookup text, settings, or Anki data to GitHub.

**Pronunciation.** Playing or listing pronunciations, testing an audio source,
and mining a note with pronunciation audio can send the word and/or reading to
configured audio providers. Automatic playback does this when enabled.
Provider responses may identify additional media hosts. HTTP localhost
audio servers are supported; use HTTPS for services on other computers. Browser
speech uses your selected browser/operating-system voice, which may be provided
by an online service. If active Media capture is used to attach that speech to
Anki, its transient shared-audio PCM is read locally and only the mined WAV is
sent to the configured AnkiConnect endpoint. When linked, mining requests to URL
audio providers are made by the host (`localhost` means the host computer), but
browser speech is still produced and recorded in the reading browser; only its
final WAV crosses the relay. Hachidori does not guarantee that every voice works
offline or that every selected share captures browser speech.

**Anki.** Hachidori communicates with the AnkiConnect URL in Anki settings,
defaulting to `http://127.0.0.1:8765` on your computer. If you configure another
server, it receives the metadata requests, API key and selected note content.
When this browser is linked to another Hachidori, that host makes these
requests with its own saved URL and API key; the linked browser's endpoint is
not used as a fallback. Anki Settings discovery and existing-setup checks also
run on the host after pending linked settings have been saved there; linked
requests do not supply the mapping, endpoint or key used for those checks.
After you start setup, it reads note-type, deck and collection metadata to suggest
configuration. Opening the Anki settings section also reads configuration
metadata. Hachidori refreshes a local duplicate index every 30 minutes for the
scope selected in Anki settings. Each compact row stores a word, whether any
matching note is mature, and matching note IDs; it does not store note fields,
note-type names, deck names or card data. A missing word triggers a scoped
Anki lookup during mining and a found result repairs the local index. Mature-card
definition blur reads only that index. In Prevent mode, popup readiness also
checks this local index first: a warm positive shows View in Anki without
contacting Anki, while an unknown miss continues to the ordinary live mining
check. Clicking View validates the matching IDs live before opening Anki and
repairs or removes the compact row. These reads and checks do not create notes.
Frequency definition blur uses only native numeric values already
returned by the selected local dictionary lookup; it adds no request or
external disclosure. A linked browser suspends its own duplicate-index refresh and alarm; the
host owns View readiness, duplicate and maturity checks. Explicit mining sends the content
selected by your field mappings, such as a word, definition, sentence, page
title, image or audio, and creates or updates a note according to your settings.
Any later Anki synchronization is controlled by Anki and your Anki configuration.

**Texthookers.** Optional media-capture texthookers receive text and timing from
a WebSocket service on the same computer. Lookup counts use only local browser
storage and never contact an external service.

**Sharing between browsers.** A browser install of Hachidori shares itself by
default with other Hachidoris on the same computer through Anki: while Anki
runs with the Hachidori Relay add-on, Hachidori connects to that relay
(`127.0.0.1`, port 8771 by default) and answers lookups and settings edits from
browsers linked through it. Only browser extensions can connect to the relay,
and it listens on this computer alone until you tick **Also with my other
computers** in Settings, which makes it accept links from the network this
computer is on (Tailscale, your home network) and shows the addresses that
reach it; anyone on that network could then connect, as with AnkiConnect
bound to all interfaces. A linked browser receives dictionary results,
personal entries, lookup counts and settings, including custom URLs and the
AnkiConnect API key, and its edits are stored here. Nothing is sent to other
computers while that switch is off, and nothing is sent at all while Anki is
closed. Another program or extension on your computer could connect to the
relay while it runs, as with AnkiConnect. **Share this Hachidori** in Settings
turns it off. A browser linked to a shared Hachidori sends the text it looks up
and its settings, presentation and personal-dictionary edits to that Hachidori,
and keeps a mirror of its settings, personal entries and lookup counts until it
unlinks. An explicit mining action also sends its selected note context and
final screenshot, captured AVIF/WAV, or browser-speech WAV bytes through the
relay. The host validates them and performs Settings discovery and setup
checks, availability checks, duplicate checks, generation validation, media
uploads, note writes and browsing through the host's AnkiConnect
configuration. Endpoint credentials or mappings included in a linked request
are ignored.

**Links and styling.** Activating a link in a dictionary opens the URL supplied
by that dictionary. Custom toolbar links open the URL template you configured,
including its selected word, reading or sentence placeholders, only when you
click the link. Custom CSS you enter can load resources from URLs it
contains. Those destination services receive ordinary browser requests. Their
own privacy practices govern their handling of those requests.

## Page screenshots and continuous capture

**Page screenshots.** When **Screenshot the page when mining** is enabled and
a field maps `{screenshot}`, choosing Add or Overwrite takes one picture of the
whole visible reading page. The switch is on by default. This single screenshot
uses the active reading tab directly. The picture stays in temporary memory and
is sent to your configured AnkiConnect server with the note. When linked, it is
captured in this browser, transferred to the host only for that submission, and
sent by the host to its configured AnkiConnect server.

**Continuous media capture** is off by default. It starts only when you enable it, click
**Start capture** and select a tab, window or screen in Chrome's picker. Capture
can include everything visible on that source and its audio when available.
Hachidori does not request microphone recording.

The reading-page picker uses tab titles and URLs to identify a page to link.
While recording, recent frames, source audio and text/timing stay in temporary
memory. Closing the capture controls leaves recording active. **Stop capture**
ends recording and clears the temporary history; it does not delete notes or
media already sent to Anki. Final clips are sent to your configured AnkiConnect
server only when you explicitly mine a note. When linked, only those final
AVIF/WAV assets cross the relay to the host for its Anki transaction; raw
recording history stays in the capturing browser. Raw recording history is not
included in backups.

## Backups, retention and deletion

Data saved in the extension remains until you remove it, replace it by restoring
a backup, or uninstall the extension. Settings lets you remove dictionaries
and edit personal entries. Uninstalling removes the extension's browser-profile
storage.

Hachidori keeps the newest two automatic daily snapshots in this device's
browser profile. They use the same saved-state payload as an exported backup,
including personal entries, lookup statistics, custom URLs, settings and a
configured AnkiConnect API key. Hachidori does not upload them. Clearing a value
from current settings does not erase it from an older snapshot; it remains
until later successful snapshots replace that record or the extension is
uninstalled. A linked browser pauses local snapshot creation and keeps its
existing local snapshots until it is unlinked and local backup scheduling
resumes.

An exported backup is an **unencrypted file** containing dictionaries, personal
entries, settings and lookup statistics. It can include custom URLs and your
AnkiConnect API key. The derived Anki duplicate index is not included. Export the
backup only to a location you trust. Hachidori does not upload backups to a cloud
service. You control any later sharing or syncing of
that file. Delete downloaded backups and already-created Anki notes/media
separately; uninstalling Hachidori does not remove them.

## Limited use and contact

Hachidori uses data only to provide the reading and study features described
here. It does not sell user data, use it for advertising, or use it for lending
or credit decisions. Its use of information received through browser APIs
complies with the Chrome Web Store User Data Policy, including the Limited Use
requirements.

The maintainer does not receive your local dictionaries, lookup history or
recordings through Hachidori. If you email support or send a bug report, the
maintainer receives what you choose to include and uses it to respond and
investigate the issue. Do not send private dictionaries, recordings, backups or
API keys unless you intend to share them. You can request deletion of support
material by contacting [github@skerritt.blog](mailto:github@skerritt.blog).

Changes to data handling will be described in an updated policy and, where
needed, in the extension before the changed behavior begins.
