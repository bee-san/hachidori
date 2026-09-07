<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Media mining

Media mining is an optional, default-off recorder for attaching local gameplay
or reading context to Anki notes. It produces two independent assets over the
same pinned interval:

- an animated AVIF, fitted to 640 × 360 at up to 8 fps in Standard mode or
  480 × 270 at up to 6 fps in Compact mode;
- a 16-bit mono WAV from the selected share's source audio, when Chrome makes
  that audio available.

Pronunciation `{audio}` remains separate. Media-mining templates use
`{capture-animation}` and `{capture-audio}`.

## Setup

1. Open **Settings → Media capture**.
2. Enable media capture and keep at least one output enabled.
3. Map `{capture-animation}` and/or `{capture-audio}` into non-first Anki
   fields. Unmapped outputs are neither encoded nor uploaded.
4. Open **Capture controls**, click **Start capture**, and choose exactly one
   tab or window in Chrome's picker. Do not choose an entire monitor.
5. Select and link the reading page. If it has several videos, select the
   relevant one. Hachidori may learn an ordinary accessible text area from the
   first root lookup, or you can use **Track this text area**.
6. Keep the Capture controls page open while recording.

Changing collection settings while recording asks for confirmation, then stops
capture and clears transient history. Settings, imports, extension restarts,
and browser restarts never arm capture automatically. **Stop capture** clears
media, text timing records, source bindings, and unsubmitted pins without
touching dictionary state.

![Media capture settings](assets/media-capture-settings.png)

## Timing

Auto mode resolves each root lookup independently:

1. a matching accepted live record from the configured loopback texthooker;
2. a matching cue transition witnessed on the selected linked-page video;
3. a matching change witnessed in the tracked ordinary DOM text area;
4. the recent history ending at lookup time.

The first text already present when an area is learned has no observed onset,
so it falls back. Later replacement, typewriter, append, hide, pause, seek, and
cue transitions can supply timing. Repeated or cross-session matches that
cannot be distinguished fail closed and continue down the priority chain.
Nested lookups inherit the root pin, so reading definitions does not move the
clip.

**Webpage only** skips texthooker input. **Recent clip only** skips all text and
cue collectors. A matching clip remains valid when its audio contains silence;
Hachidori does not use voice activity detection.

The texthooker client accepts only an explicitly configured loopback `ws://`
endpoint. Plain mode requires a live-only stream. GSM mode recognizes the
tested live text messages and ignores snapshots, acknowledgements,
translations, and unrelated commands. Incoming text is never displayed, used
as HTML, or treated as an instruction to create a note.

## Retention and export bounds

The recorder targets the configured 30- or 60-second history while enforcing
hard resource limits:

| Resource | Bound |
| --- | --- |
| Live compressed frames | 64 MiB, 256 KiB per frame |
| Extra pinned compressed frames | 32 MiB |
| Text timing records | 1,000 records, 4,096 characters each |
| Animated AVIF | 4 MiB |
| Mono WAV | 1 MiB |
| Encoder heap | 256 MiB |
| Encoder job | one at a time, 30-second watchdog |
| Capture asset message | 6 MiB serialized |

Frames are downscaled and JPEG-compressed before entering the ring; audio uses
a sample-clocked mono Float32 ring. A byte limit can shorten the available
video history. If the selected share has no source audio, animation can still
be exported with an explicit warning; Hachidori never substitutes microphone
or fabricated silent audio.

Anki preflight performs no media work. On submission, Hachidori encodes only
referenced outputs, rechecks duplicate/configuration state, uploads assets one
at a time, revalidates, writes the note, and verifies the result. An uncertain
write is not automatically retried or duplicated.

## Privacy and limitations

Raw frames, PCM, received text, identifiers, timing records, and source
bindings stay in the live capture page and are not written to
`chrome.storage.local`. Only explicitly mined final assets are sent to the
configured local AnkiConnect endpoint.

The generic page collector supports ordinary accessible DOM where Hachidori can
already locate text. Unsupported iframe or shadow-root combinations,
canvas-only text, burned-in subtitles, and private player surfaces require a
texthooker or recent-history timing. This release intentionally has no OCR,
speech recognition, VAD, subtitle interception/download, site-specific player
adapters, or microphone capture.

Chrome and the selected operating-system share determine whether tab or window
audio is available. Animated AVIF and WAV are separate Anki media files rather
than a synchronized video container, so client media support can vary.

## Verification

The focused Node suite covers settings, priority, epochs, matching, cue and DOM
lifecycles, pin/job ownership, buffer bounds, AVIF/WAV encoding, response
limits, and Anki commit behavior. `test/chrome-capture.mjs` additionally drives
real Chrome display capture, captured tab audio, a real loopback WebSocket,
animated-AVIF decoding/playback, WAV samples, AnkiConnect upload/readback,
settings lifecycle, storage privacy, lookup latency, and sustained retention.

On 7 September 2026, a 70-second Linux run with Chrome for Testing
152.0.7977.75 produced:

| Measurement | Result |
| --- | ---: |
| Stopped lookup median / p95 | 1.40 ms / 1.90 ms |
| Recording lookup median / p95 | 1.30 ms / 2.00 ms |
| Capture input | 7.99 fps / 47,890 audio samples per second |
| Retained history | 60.000 s video / 60.032 s audio |
| Retained compressed frames | 3,947,494 bytes across 481 frames |
| First AVIF + WAV encode | 2,847.39 ms |
| Exported assets | 12,640-byte AVIF / 231,040-byte WAV |
| Chrome-decoded AVIF frames | 19 |
| Decoded flash/beep offset | 45.3 ms |

These are one machine's regression measurements, not product guarantees. The
test enforces bounds and a relative stopped-versus-recording latency threshold
instead of freezing those exact timings.

See the exact commands and benchmark controls in the
[test harness documentation](../test/README.md#chrome-capturemjs).
