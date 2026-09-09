<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Media mining

Media mining is an optional, default-off recorder for attaching local gameplay
or reading context to Anki notes. It produces two independent assets over the
same pinned interval:

- an animated AVIF, fitted to 640 × 360 in Standard mode or 480 × 270 in
  Compact mode;
- a 16-bit mono WAV from the selected share's source audio, when Chrome makes
  that audio available.

The default recent window is ten seconds. Longer windows reduce video and
audio sampling so the same output limits can cover up to sixty seconds.
Pronunciation `{audio}` remains separate. Media-mining templates use
`{capture-animation}` and `{capture-audio}`.

## Setup

1. Open **Settings → Media capture**.
2. Enable media capture and keep at least one output enabled.
3. Map `{capture-animation}` and/or `{capture-audio}` into non-first Anki
   fields. Unmapped outputs are neither encoded nor uploaded.
4. Open **Capture controls**, click **Start capture**, and choose one browser
   tab, application window, or monitor in Chrome's picker. Source audio depends
   on the browser, operating system, chosen surface, and picker audio option.
5. Select and link the reading page. Each root lookup from that page pins the
   preceding configured recent window.
6. The controls may be closed and reopened while recording continues. The
   recorder lives in the extension's shared offscreen document.

Changing collection settings while recording asks for confirmation, then stops
capture and clears transient history. **Stop capture** cancels pending capture
and export work and clears media, source bindings, and unsubmitted pins. A note
mutation already sent to Anki may still succeed; stopping during media upload
prevents a new note mutation from being sent.

Settings, imports, extension restarts, and browser restarts never arm capture
automatically. A service-worker restart can recover the same recording and
linked reading document while the offscreen recorder survives. Losing that
recorder or the shared source requires another **Start capture** click.

![Media capture settings](assets/media-capture-settings.png)

## Page screenshot

A note can also carry one picture of the page it was made from, without recording
anything. It needs no share, no **Start capture**, and no session:

1. Open **Settings → Anki**.
2. Keep **Screenshot the page when mining** on, and give a field the
   `{screenshot}` marker — the Kiku, Lapis and Senren presets already map their
   picture field to it, and **Apply preset** does so for the fields your note
   type actually has.
3. Add a note as usual. One picture of the visible page is taken at that moment,
   with Hachidori's popup and image preview hidden for it.

The picture is stored through the same AnkiConnect media gateway as dictionary
images and pronunciation audio, under its own `hachidori-screenshot-<uuid>.jpg`
name, and the mapped field receives an ordinary `<img>` reference. It is uploaded
with the note rather than before it, so a note Anki rejects leaves no stray file. Nothing is
captured while you read, hover or during first-run setup, and only the tab that
asked is captured: if it is no longer the active tab, or has moved to another
page, the screenshot is skipped. `{screenshot}` cannot go in the first field, which is the
note's identity for duplicate checks. A skipped or refused screenshot is a warning
beside the note's own result — the note is still added or updated, its other
fields intact, and no duplicate retry is invited.

![The Anki settings section with the mining screenshot switch](assets/anki-screenshot-settings.png)

## Recent window

**Recent window** accepts a whole number from 1 through 60 seconds and defaults
to 10. Hachidori retains only that rolling window. A root lookup pins the window
immediately preceding the lookup; partial warmup can produce a shorter clip.
Nested lookups inherit the root pin, so reading definitions does not move it.

The linked reading page establishes which document may pin and submit a clip.
Hachidori does not currently connect to a capture WebSocket, watch moving page
text, or inspect video cues to change the interval.

## Retention and export bounds

The recorder retains and exports the same configured 1–60 second recent window.
It enforces these resource limits:

| Resource | Bound |
| --- | --- |
| Live compressed frames | 64 MiB, 256 KiB per frame |
| Extra pinned compressed frames | 32 MiB |
| Animated AVIF | 4 MiB |
| Mono WAV | 1 MiB |
| Encoder heap | 256 MiB |
| Encoder job | one at a time, 30-second watchdog |
| Capture asset message | 6 MiB serialized |

Frames are fitted without upscaling and JPEG-compressed in a dedicated worker
before entering the ring. Each frame preserves its aspect ratio inside the
session's original canvas, with letterboxing after a source resize when needed.
Audio uses a sample-clocked mono Float32 ring. A byte limit can shorten the
available video history.

For windows up to ten seconds, Standard requests at most 8 fps and Compact at
most 6 fps. Longer windows multiply that ceiling by `10 / seconds`; a
sixty-second window requests about 1.33 fps Standard or 1 fps Compact. A static
or background source may deliver fewer frames, and capture cannot restore
frames the browser did not deliver.
In a controlled Chrome test, moving the captured tab behind the controls
reduced delivery from 7.99 to 6.49 fps; returning to the source restored
7.99 fps. Every delivered frame reached the JPEG worker in that probe.

At the selected interval's end, the recorder allows up to 250 ms for already
captured audio and JPEG frames to arrive. This delivery drain does not move
the lookup anchor or extend the clip. The frame displayed at the interval's
start is retained, including when it precedes the boundary; a stationary source
can hold its last frame. WAV output is 48 kHz through ten seconds. Longer full
windows scale the output rate by `10 / seconds`, with an 8 kHz minimum; a
sixty-second WAV is 8 kHz. AVIF frame durations use the same output timebase, so
both files cover the same duration. Equal duration alone does not establish
flash/beep synchronization; see the acceptance record below.

If audio samples are still missing after the bounded drain, an export requiring
that audio fails explicitly. Fully delivered source silence remains valid.
If the selected share supplies no audio track, animation can still be exported
with a warning; an audio-only mapping reports unavailable source audio.
Hachidori never substitutes microphone or fabricated silent audio.

Anki preflight performs no media work. On submission, Hachidori encodes only
referenced outputs, rechecks duplicate/configuration state, uploads assets one
at a time, revalidates, writes the note, and verifies the result. An uncertain
write is not automatically retried or duplicated.

## Privacy and limitations

Raw frames, PCM, identifiers, and source bindings stay in the offscreen
recorder and linked page's transient state and are not written to
`chrome.storage.local`. Only explicitly mined final assets are sent to the
configured local AnkiConnect endpoint.

The recent-window recorder does not inspect subtitles or detect moving strings.
The active recorder opens no capture WebSocket and performs no OCR, speech
recognition, VAD, subtitle interception/download, site-specific player
adaptation, or microphone capture.

Navigating away from or unlinking the reading page clears its binding and
unsubmitted pins while recording continues. An export already admitted owns
its clip independently. A shared track ending or becoming unavailable stops
capture and clears history. Detected capture-clock interruptions also stop
capture. Minimize behavior depends on the selected share: it may keep producing
frames or make the source unavailable. Stopped capture never resumes itself.

Animated AVIF and WAV are separate Anki media files; client media support and
playback scheduling can vary. Physical sleep/wake and media sync to additional
Anki devices have not been validated.

## Verification

The focused Node suite exercises production settings handlers, 1–60 second
intervals, lookup ownership, restart routing, buffer and drain behavior,
AVIF/WAV encoding, and the final Anki mutation boundary. The dormant collector
modules retain their focused regressions. Separate browser, Linux surface, and
installed-Anki harnesses cover the real runtimes.

The [PR #71 acceptance record](media-capture-review.md) records passing processor
and AudioWorklet capture, flash/beep alignment within 125 ms, a thirty-minute
retention soak, and actual Anki Desktop playback. It also records measurement
limits and untested platform/client behavior. See the commands in the
[test harness documentation](../test/README.md#chrome-capturemjs).
