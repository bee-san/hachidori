# Hachidori privacy policy

Last updated: 8 September 2026.

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
first/last lookup times. Hiding the count display does not stop these local
statistics. Statistics do not contain a list of visited page URLs.

Settings can contain custom service URLs, CSS, Anki field templates and an
optional AnkiConnect API key. Hachidori does not add application-level encryption
to browser profile storage. The AnkiConnect key is used only for requests to the
AnkiConnect service on your own computer.

## Downloads and optional connections

**First-run setup.** Choosing **Start setup** starts downloads of Jitendex,
JMnedict, Bee's Ultimate Kanji Dictionary and Jiten Frequency Dictionary. Setup
then checks local Anki to suggest a note type, deck and field mapping. You can
choose **Set up manually** instead. Dictionary installation continues if you
close the setup tab after starting it.

**Dictionary sources.** Recommended dictionaries and their update information
come from GitHub and its download hosts, jitendex.org and api.jiten.moe. Other
managed dictionaries contact their configured source URLs. Manual checks and
enabled update schedules contact these sources; scheduled runs can download and
install dictionary updates. Providers receive ordinary network information,
including your IP address and the requested resource. Dictionary downloads do
not send the text you look up to those providers.

**Pronunciation.** Playing or listing pronunciations, testing an audio source,
and mining a note with pronunciation audio can send the word and/or reading to
configured audio providers. Automatic playback does this when enabled.
Provider responses may identify additional media hosts. HTTP localhost
audio servers are supported; use HTTPS for services on other computers. Browser
speech uses your selected browser/operating-system voice, which may be provided
by an online service. Hachidori does not guarantee that every voice works offline.

**Anki.** Hachidori communicates with AnkiConnect at `http://127.0.0.1:8765`.
After you start setup, it reads note-type, deck and collection metadata to suggest
configuration. Opening the Anki settings section also reads configuration
metadata. Optional mature-word blur and duplicate checks query your local
collection. These checks do not create notes. Explicit mining sends the content
selected by your field mappings, such as a word, definition, sentence, page
title, image or audio, and creates or updates a note according to your settings.
Any later Anki synchronization is controlled by Anki and your Anki configuration.

**GSM and texthookers.** Corpus Seen is off by default. When enabled, it sends
the looked-up word to your configured GSM service on the same computer to read
a count. Optional media-capture texthookers receive text and timing from a
WebSocket service on the same computer.

**Links and styling.** Activating a link in a dictionary opens the URL supplied
by that dictionary. Custom CSS you enter can load resources from URLs it
contains. Those destination services receive ordinary browser requests. Their
own privacy practices govern their handling of those requests.

## Screen and source-audio capture

Media capture is off by default. It starts only when you enable it, click
**Start capture** and select a tab, window or screen in Chrome's picker. Capture
can include everything visible on that source and its audio when available.
Hachidori does not request microphone recording.

The reading-page picker uses tab titles and URLs to identify a page to link.
While recording, recent frames, source audio and text/timing stay in temporary
memory. Closing the capture controls leaves recording active. **Stop capture**
ends recording and clears the temporary history; it does not delete notes or
media already sent to Anki. Final clips are sent to local Anki only when you
explicitly mine a note. Raw recording history is not included in backups.

## Backups, retention and deletion

Data saved in the extension remains until you remove it, replace it by restoring
a backup, or uninstall the extension. Settings lets you remove dictionaries
and edit personal entries. Uninstalling removes the extension's browser-profile
storage.

An exported backup is an **unencrypted file** containing dictionaries, personal
entries, settings and lookup statistics. It can include custom URLs and your
AnkiConnect API key. Export it only to a location you trust. Hachidori does not
upload backups to a cloud service. You control any later sharing or syncing of
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
