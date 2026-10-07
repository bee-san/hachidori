<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Netflix sentence audio: research

Research for bringing back retrospective audio recording for **Netflix mining**,
7 October 2026. The owner asked for audio recording "similar to media mining
before" and to look at how other apps, Language Reactor in particular, do it.
No Netflix page or account was used: every Netflix behaviour below comes from
source code, shipped packages, public documentation or a Clear Key fixture.

## Summary

- No other tool keeps a rolling buffer of a streaming tab. Migaku and asbplayer
  seek back and replay the line while they record it through `chrome.tabCapture`.
  Language Reactor records nothing in the browser. It uploads Netflix's whole
  audio track to its own server, which cuts the clips, and falls back to
  text-to-speech.
- A rolling `tabCapture` buffer cannot work for Hachidori. Chrome mutes a tab
  for as long as it is captured, so the viewer would hear nothing for the
  whole session. The capture can only be played back from a context outside
  the tab, and Hachidori's offscreen document cannot use the stream (see
  [What Chrome allows](#what-chrome-allows)).
- Hachidori can read the video's own decoded sound instead. A Web Audio graph
  in the Netflix page passes the `<video>` element's audio to the speakers and
  copies it into a 30-second buffer. This needs no capture grant, mutes
  nothing, and in Chrome 152 it delivered the decrypted audio of an
  EME-protected (Clear Key) MSE video, where `captureStream()` refused.
- Line audio is then cut from that buffer by the subtitle cue's media time,
  which Hachidori already reads. When the video was paused partway through the
  line (hover pause does this), Hachidori plays the rest of the line and stops.
  It replays the whole line only when the line was not heard at normal speed.
  The existing tab-capture replay stays for `{gif}`, and for sentence audio when
  the page's sound cannot go through Web Audio.

## What does not work today

Netflix mining on `main` at `245c091c` records every line by replaying it
(`netflix-content.js` `record`, `netflix-page.js` `replay`, `netflix-capture.js`):

- **Every note replays the line.** The video jumps back to 250 ms before the
  cue, plays the line at 1×, then seeks back. The popup is hidden throughout,
  and Netflix may rebuffer after each seek; a seek may take up to 10 s before
  the replay gives up.
- **You can't hear the replay.** Chrome mutes a captured tab, and the
  recorder frame inside the tab is the only context that can use the stream ID
  (see [#518](https://github.com/bee-san/hachidori/pull/518)).
- **It needs a grant on each tab.** Without a click on Hachidori's toolbar
  button on that tab, or the **Add the current popup entry to Anki** shortcut,
  a note gets no sentence audio. The warning reads "Chrome has not let
  Hachidori record this tab yet." The manifest's `addNote` command has no
  suggested key. Hachidori's own popup keybinds, such as Alt+E, are page
  keystrokes, not Chrome commands, so they grant nothing.
- **It depends on a private player call.** Seeking goes through
  `netflix.appContext…videoPlayer.seek`, because writing `currentTime` stops
  Netflix with error M7375. If that call is missing, the note says the line
  could not be replayed.
- **Protected playback can record as silence.** A clip of exact zeros
  attaches no audio, with the graphics-acceleration advice. This check stays.

## How other tools do it

| Tool, version inspected | How it gets the line's audio | Buffer or replay | Consent | DRM / silence | Format, padding |
| --- | --- | --- | --- | --- | --- |
| **Language Reactor** 5.1.8 (Web Store package, SHA-256 `d884058867f40c98…f5b`) | None in the browser. No `tabCapture`, `getUserMedia`, `MediaRecorder` or `AudioContext` in any script. A saved Netflix line stores only `{ movieId, track, subtitleIndex, startTime_ms, endTime_ms }` and `audio: null` | Server-side: the Netflix page script downloads the title's **entire audio stream** in the page and `POST`s it to `api.dioco.io/mmd_makeClips` when the server lacks it. The website attaches "movie" audio or TTS on export | None needed. Permissions: `storage`, `contextMenus`, `activeTab`, `scripting` | Not applicable; TTS fallback (Microsoft/Google voices) | Decided by the server; export via the website, "Include media" |
| **Migaku** 1.30.15.0 (Web Store package, SHA-256 `7bd7121b…49bd2bd`) | `tabCapture.getMediaStreamId({ consumerTabId })` from the service worker, consumed by Migaku's own extension window. Plays the stream back through an `AudioContext` so the tab stays audible | **Replay**: pause, seek with Netflix's player API, wait until `getBusy()` is null, play, record `(end − start) / playbackRate`, screenshot halfway | `activeTab` per session: toolbar click or Alt+R. Toast: "Click the Migaku extension icon or hit ‘Alt+R’ to accept" | Decodes the clip; if its first 10,000 samples are exactly 0 *and* the picture is blank, tells you to turn off graphics acceleration (HDCP) | WebM/Opus (`MediaRecorder` default; the `mimetype` option is misspelt), 500 ms each side |
| **asbplayer** `72661f2` (1.22.0, latest tag v1.21.2), AGPL-3.0 | `tabCapture.getMediaStreamId({ targetTabId })` from the service worker, consumed by an offscreen document (`USER_MEDIA`). `AudioContext` passthrough keeps it audible. Stream opened per recording | **Replay**: seek to `start − padStart`, play, record `(end − start) / rate + padEnd`, restore paused state | Commands with suggested keys (Ctrl+Shift+X mines and grants), toolbar popup or context menu. Otherwise an in-page notice: "Click on the asbplayer action button … to enable audio recording for this tab." | No silence check on Chrome. Issues [#304](https://github.com/asbplayer/asbplayer/issues/304), [#511](https://github.com/asbplayer/asbplayer/issues/511), [#573](https://github.com/asbplayer/asbplayer/issues/573), [#734](https://github.com/asbplayer/asbplayer/issues/734) report blank Netflix audio; disabling hardware acceleration fixed each | WebM/Opus, re-encoded to 192 kbps MP3 with lamejs 1.2.0 by default; padding 0 / 500 ms; no length cap |
| **Animebook** `c4d9b3e`, Anki Export extension 1.1.3 | ffmpeg.wasm cuts the user's **local** video file (`-ss/-to -map 0:a:N`) | Seek-and-cut of a file; nothing recorded | None: the user opens the file | None (local files) | MP3, 0.5 s padding, 0.2 s fades |
| **GameSentenceMiner** `a2f15fc` (2026.10.0) | OBS Studio's replay buffer of the desktop audio, saved over obs-websocket when a new Anki note appears | **Retrospective**: a 300 s rolling buffer, trimmed by texthooker line times, then voice activity detection (FireRedVAD by default) | None from the browser; OBS records the whole desktop | Not handled; desktop capture sidesteps it | MP3 by default, −0.5 / +0.5 s offsets |
| mpvacious `976ce5e`, Memento `e45a792`, Voracious `0d4b7b7`, subs2srs | mpv or ffmpeg cut the file mpv plays, or a local library | Seek-and-cut of a file | None | subs2srs: "Make sure that the video does not have any DRM restrictions" | Opus/AAC/MP3, 0–0.25 s padding |

Packages were downloaded from the Chrome Web Store update service and unpacked with the CRX parser
and beautifier of [Chrome-Decompiler at `37db9f0`](https://github.com/eoxd/Chrome-Decompiler/tree/37db9f0d2fc7d8a4bfd2a0148345f5aaa495d8a0),
as in the [screenshot research](netflix-screenshot-research.md). asbplayer, Animebook,
GameSentenceMiner, mpvacious, Memento and Voracious were cloned at the SHAs above. Nothing of
any of them is copied into Hachidori: quotes here are user-facing strings. Trancy (7.9.4) and
Lingopie are closed source and say nothing public about recording a line's audio.

Notes on the table:

- **Language Reactor** is the opposite of what Hachidori may do. It sends a
  copy of Netflix's audio track to its own server, and what a saved line gets
  is decided there. Its public guide only says the export "will … include
  audio and images from your saved items". Hachidori keeps everything local,
  so this approach is ruled out.
- **Migaku** keeps the capture stream open between cards until recording is
  turned off. It can play the stream back only because its consumer is a
  separate extension window, outside the captured tab.
- **asbplayer** documents the feature as "When mining a subtitle, record the
  audio covered by the subtitle"
  ([settings](https://docs.asbplayer.dev/docs/reference/settings/#record-audio-when-mining)).
  It also gets its grant from the mining shortcut itself, which carries a
  suggested key.
- **GameSentenceMiner** is the only retrospective design. It is the model for
  the removed media mining: keep recent audio and cut by the line's time.

## What Chrome allows

From Chromium `main` at
[`25818ddfd245`](https://github.com/chromium/chromium/tree/25818ddfd2459c642dc31eb03bfad2fdc31b421d)
and the Chrome extension documentation:

- **`tabCapture` always mutes the tab** while its stream lives. The `tab` source
  defaults `disable_local_echo` to true
  (`third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc`).
  The only switch that keeps local playback (`disableLocalEcho`) is parsed only
  behind an experimental runtime feature, and `suppressLocalAudioPlayback` is
  not consulted on that path. The documented remedy is to play the stream back
  through an `AudioContext`. Inside the tab that doesn't help: the mute covers
  every output of the tab's audio group, that playback included, and the
  capture would record it again.
- **A stream ID works only in the caller's process.**
  `content/browser/media/capture/desktop_streams_registry_impl.cc` compares the
  consumer's render process and origin, and the ID expires after 10 s.
  #518 reproduced the failure in Chrome 152: the cross-origin-isolated
  offscreen document's `getUserMedia` fails with "Error starting tab capture".
  The threaded engine needs that isolation.
- **`getDisplayMedia` keeps the tab audible** (`suppressLocalAudioPlayback`
  defaults to false). It needs transient user activation, with no extension
  exemption (`third_party/blink/renderer/modules/mediastream/media_devices.cc`),
  and shows a picker every session. The removed media mining used it.
- **The grant.** An action click (with or without a popup), a `commands`
  shortcut or a context-menu item grants an extension that has `tabCapture`
  the per-tab capture right, even without `activeTab`
  (`extensions/browser/permissions/active_tab_permission_granter.cc`). The grant
  survives same-document and same-origin navigation and ends on a cross-origin
  one.
- **`HTMLMediaElement.captureStream()` refuses EME media**:
  `NotSupportedError: Stream capture not supported with EME`
  (`third_party/blink/renderer/modules/mediacapturefromelement/html_media_element_capture.cc`).
- **Web Audio has no EME check.** `createMediaElementSource` refuses only
  cross-origin (tainted) media
  (`third_party/blink/renderer/modules/webaudio/media_element_audio_source_handler.cc`),
  and MSE data appended by the page is not tainted. Once connected, the element
  plays only through that `AudioContext`, for the element's lifetime. While it
  does, the media clock is not told about the context's output latency:
  `WebAudioSourceProviderImpl` renders with a zero delay
  (`third_party/blink/renderer/platform/media/web_audio_source_provider_impl.cc`).
  On wired output that is a few tens of milliseconds; Bluetooth output adds more.
- **Starting an `AudioContext`** needs sticky user activation in the frame,
  sticky activation from before a same-origin navigation, or high media
  engagement (`third_party/blink/renderer/core/html/media/autoplay_policy.cc`).
- **`MediaStreamTrackProcessor`** is exposed to windows, and its `AudioData`
  timestamps are on the page's `performance.now()` timeline by default
  (`third_party/blink/renderer/modules/breakout_box/media_stream_audio_track_underlying_source.cc`).

## Experiment: Web Audio on an EME video

In Chrome for Testing 152.0.7977.75 (headless, `--disable-audio-output`), a page
played a 6 s AAC clip with a 200 ms, 1 kHz beep at 2.5 s through `MediaSource`.
The clip was encrypted with Clear Key `cenc` (AES-CTR; a small Node packager
wrote the `senc`/`saiz`/`saio` boxes, because ffmpeg's fragmented CENC output
was rejected with "Sample encryption info is not available"). A script in a
CDP isolated world, as a content script runs, then tapped the video:

| Check | Result |
| --- | --- |
| `video.captureStream()` with `mediaKeys` set | `NotSupportedError: Stream capture not supported with EME` |
| `createMediaElementSource` → destination and a `MediaStreamAudioDestinationNode` → `MediaStreamTrackProcessor` | Decrypted audio delivered; the beep placed at media 2,519 ms by the median wall-minus-media offset (2,500 ms plus about 21 ms of AAC priming) |
| `video.volume` 1, 0.25, `muted` | Beep peak 0.1265, 0.0316 and 0: the element's volume applies before the tap, as it does to tab capture |
| `AudioData` timestamps | About every 90 ms one 10 ms block is stamped 8–9 ms late and the next is on time again; blocks must be placed by counting samples |
| 600 ms main-thread stall | 502 ms lost with `maxBufferSize: 10`, nothing lost with 100 |
| Stopping the copy (reader, track, sink) | The passthrough keeps playing; a second `AudioContext` cannot take the element |

Clear Key decrypts in the renderer, as Widevine's software path does. Hardware-secure
playback (Windows, Edge's PlayReady) is rendered outside Chrome's audio pipeline, so it
may record as silence here, as it can through tab capture. This was not tested, nor was
real Widevine on Netflix; both are owner checks.

## Design

Behind the existing **Netflix mining** switch, because it changes how that
feature gets `{sentence-audio}` rather than adding a separate one:

1. While the switch is on, `netflix-audio.js` (content script, top frame of
   `www.netflix.com`) starts an `AudioContext` once Chrome allows it. Until
   then it waits for the next click or key press in the page. It routes the
   watch page's `<video>` through the graph only once the context is running,
   so routing never starts on a silent graph. The graph passes the sound to the
   speakers and copies a mono mix to a `MediaStreamTrackProcessor`.
2. Only audio played at 1× is kept: 30 seconds of it, in one `Float32Array` in
   the page. Played stretches are segments that close on pause, seek, a stall
   or a speed change. Each segment places its samples on the video's media
   clock by the median of per-block estimates, as the recorder's clock fit does.
   A new episode clears the buffer.
3. On Add, the line is cut from the cue start − 250 ms to the cue end + 250 ms:
   - **heard at 1×** → cut at once: no seek, no replay, no capture;
   - **stopped partway**, the start heard (hover pause stops lines mid-way) →
     the page plays on to the cue end + 250 ms and pauses there; the viewer
     hears the rest of the line once;
   - **otherwise** → the existing replay through Netflix's player, now audible,
     recorded by the same buffer.
4. Exact zeros are still "silent", with the same note text. The WAV goes to the
   worker, which holds it like a recorded one (`sentenceAudio`), so
   `{sentence-audio}`, the Kiku/Lapis/Senren routing and the upload lifecycle are
   unchanged.
5. `{gif}` keeps the tab-capture replay and its grant; with a GIF the buffer
   records the audio of that same replay. The tab-capture recorder still
   records sentence audio when the buffer is not running: Chrome has not let
   the page start audio yet (a browser shortcut is not a page gesture, but it
   does grant tab capture), or another extension or the page already routes the
   element through Web Audio.
6. Turning the switch off stops the copy and frees the buffer. The video's sound
   keeps going through the graph until the page reloads, because Chrome cannot
   disconnect an element from Web Audio.

### Alternatives

| Alternative | Why not |
| --- | --- |
| Rolling `tabCapture` buffer (the removed design, with a stream ID) | Mutes Netflix for the whole session; no context outside the tab can play it back, because the offscreen document cannot use the stream ID |
| Rolling `getDisplayMedia` buffer in the offscreen document (as #71 did) | Needs a picker and a user gesture in the capturing document every session; an offscreen document has neither |
| Migaku's separate extension window as the stream's consumer | A window that must stay open; still needs the per-tab grant |
| Replay for every line (today, Migaku, asbplayer) | Kept as the fallback only: it repeats the line, seeks through a private API and, through tab capture, is silent |
| `video.captureStream()` | Refused for EME media |
| Server-side clips (Language Reactor) | Sends Netflix's audio off the machine |
| Disabling cross-origin isolation for the offscreen document | The threaded dictionary engine needs it |
| MP3 or Opus instead of WAV | Unchanged from #510; a separate card-size question |

Known costs of routing the video through Web Audio:

- **Lip sync.** The picture can lead the sound by the context's output
  latency. That is small on wired output and can be noticeable on Bluetooth.
- **Shared element.** Another extension that routes the same `<video>` through
  Web Audio first leaves Hachidori on the tab-capture path. One that tries
  after Hachidori fails.
- **Volume.** A quiet or muted video gives a quiet or silent clip, as tab
  capture does.

## Owner checks on a real title

Automated suites can't contact Netflix. With the switch on:

1. Watch a line, let it finish, and add a note. You should not hear a replay,
   and no recorder frame should appear. The audio should match the line,
   including with Chrome's Widevine and graphics acceleration on.
2. Hover a line while it plays, so it pauses partway, and add a note. The rest
   of the line should play once and stop; the card's audio should be the whole line.
3. On a tab with no toolbar click, add a note mapped only to `{sentence-audio}`.
   It should get audio; `{gif}` should still ask for the click.
4. Watch for lip-sync drift with wired and with Bluetooth output, and for
   Netflix errors while the switch is on.
5. On hardware-secure playback (Windows; Edge), check the sound still plays
   for you, and whether the note says the recording was silent.
