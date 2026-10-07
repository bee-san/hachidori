# Netflix pictures: capture research

Investigation for [#531](https://github.com/bee-san/hachidori/issues/531),
7 October 2026. The report shows black video with visible subtitles in Edge,
and graphics acceleration already off. The capture method used to make the
attached images and the exact installed browser/extension builds are unknown.

## What other apps actually do

These findings come from source inspection, including the shipped extensions,
not an assumption that their marketing proves every protected title works.

| App inspected | Netflix image source | Audio approach | Consequence |
| --- | --- | --- | --- |
| Migaku 1.30.15.0 | `tabs.captureVisibleTab` as PNG, then crop to the player | Audio-only `tabCapture` stream, `MediaRecorder`; screenshot halfway through the replay | Uses the browser compositor, which can withhold protected video |
| asbplayer, `72661f2` | `tabs.captureVisibleTab` as JPEG, then crop/resize | Chromium `tabCapture` stream | Same fundamental screenshot limitation |
| Video Screenshot 7.0.7, `ppkojackhibeogijphhfnamhemklmial` | Try video-to-canvas; when unavailable/black, hide player UI, wait two animation frames, capture the visible tab and crop | Not relevant to its screenshot workflow | Its fallback is ordinary tab capture |
| FrameX / Video Screenshot 0.2.0, `aldfcopeogeloogeepjppfpfmbjfcjjh` | On Netflix, hide surrounding UI, wait two animation frames plus 50 ms, capture visible tab as PNG and crop | Not relevant to its screenshot workflow | No special access to protected video was found |
| Language Reactor 5.1.8 | Netflix's `getTrickPlayFrame(timestampMs)` preview JPEG | Separate source-audio handling; not `tabCapture` | The picture avoids protected screen capture, but is a low-resolution nearby preview |

The two extensions named Video Screenshot are different products. The supplied
Reddit self-promotion links to FrameX, not to the supplied `ppkojack…` store ID.
The asbplayer comparison is reproducible from its
[capture implementation](https://github.com/killergerbah/asbplayer/blob/72661f223e989c403179cf520b60e9232ae6b7a6/extension/src/services/capture-visible-tab.ts).

## Migaku, unpacked and traced

The official Web Store package was downloaded and inspected. The CRX-to-ZIP
parser and JavaScript beautifier from
[Chrome-Decompiler at `37db9f0`](https://github.com/eoxd/Chrome-Decompiler/tree/37db9f0d2fc7d8a4bfd2a0148345f5aaa495d8a0)
were used directly under Node. Its Electron viewer is a UI around those same
components. The extension ships bundled JavaScript; this process exposes and
formats that code, not original TypeScript or unpublished source maps. No
Migaku code is incorporated into Hachidori.

Package SHA-256:
`7bd7121b7152e4ae891c8ec37fd97bac1fd83699a6c0e3347bec8576849bd2bd`.

Relevant shipped files:

- `assets/app-window-cc3fddf4.js`: screenshot class `Wn` and recording class
  `zn`. `captureStream` opens an audio-only tab stream and connects an
  `AudioContext` to the output so sound remains audible. `recordSegment`
  seeks and plays; `getRecordingResponse` starts recording, takes the
  screenshot halfway through the line, then stops the recorder. The stream
  can remain open between cards until recording is disabled.
- `assets/v4-c8a7dd6d.js`: the screenshot wrapper calls
  `chrome.tabs.captureVisibleTab(windowId, options, callback)`.
- `assets/jFNkW8z65JGnFf4B1nUyDtUkUFW.umd.cjs`: the Netflix page adapter
  accesses Netflix's player, seeks/replays, changes subtitle handling and
  requests WebVTT. No EME key-system or robustness override was found here
  or in the inspected package's JavaScript.
- `assets/_plugin-vue_export-helper-37cb2a5b.js`: the card creator has a
  blank-recording message advising users to disable graphics acceleration
  and restart. Even Migaku explicitly anticipates unavailable capture.

The image is a crop of a browser screenshot, not a decoded Netflix video
frame. Its PNG format and crop do not confer additional readback permissions.
Hachidori already has `tabCapture`, `scripting` and `<all_urls>` host access;
Migaku's extra unrelated permissions do not explain a universal DRM solution.

## Why audio timing was not selected as the fix

Migaku captures while its audio stream is active; Hachidori takes its picture
before recording starts. That is a real difference, but not proof of the cause.
An experimental sequencing patch was considered and discarded from this PR.

Chromium's [screenshot implementation](https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/api/web_contents_capture_client.cc)
already requests a compositor copy. The Windows
[overlay processor](https://chromium.googlesource.com/chromium/src/+/main/components/viz/service/display/dc_layer_overlay.cc)
changes ordinary overlay handling for captures while preserving required
protected overlays. Audio loopback also changes tab visibility/capture
bookkeeping, but that does not establish access to protected video pixels.
[Chromium graphics engineers](https://groups.google.com/a/chromium.org/g/graphics-dev/c/R14cLG4dRrY)
describe the software/hardware and platform distinction. Neither another
permission nor an arbitrary delay is a demonstrated fix for the reported Edge
configuration.

## The independently supported alternative

Language Reactor's developer
[described its preview-image approach](https://forum.languagelearningwithnetflix.com/t/an-idea-for-automatic-screenshot-and-audio-capture/1395)
in 2020. Its current 5.1.8 `pageScript_lln.min.js` still accesses Netflix's
player and calls `getTrickPlayFrame` with milliseconds. The returned `image`
contains JPEG bytes; `time`, `width`, `height` and pixel-aspect metadata belong
to the preview. It does not read the video element or the screen. Its choice
of neighboring previews and ten-second cache buckets must not be confused
with exact frame capture or a guaranteed preview interval on every title.

Independent open-source confirmation exists in
[Theater-Mode-Everywhere's Netflix provider](https://github.com/TomaszJanusz/Theater-Mode-Everywhere/blob/1ff1135a0061a52521595ceec6709a3ba699fe5e/src/providers/netflix/main.ts).
Its [verification record](https://github.com/TomaszJanusz/Theater-Mode-Everywhere/blob/1ff1135a0061a52521595ceec6709a3ba699fe5e/docs/netflix-watch-player.md)
reports a live Netflix preview in Brave Beta on 7 October 2026. That is the
other project's reported verification, not a Hachidori end-to-end result.

This is the approach used by **Netflix preview screenshots**. It is an explicit
experimental choice because it substitutes a lower-resolution, approximate
scene image for the exact screen. Hachidori obtains the player's existing
preview on demand and feeds its JPEG into the existing Anki screenshot
lifecycle. It changes no DRM settings, extracts no content keys, downloads no
video, and requires no recording or replay. Missing previews produce a useful
warning while the note's remaining fields are saved.

Language Reactor's different audio workflow is not evidence of a hidden
recording permission: its shipped code uses source-audio URLs and clipping
services. Reproducing that separate system is outside this screenshot change.

## Validation boundary

Automated tests can verify the native-player contract, bytes, timestamp units,
session selection, exact-document execution, note ownership and failure
behavior. They cannot establish the availability or visual quality of every
Netflix title's previews. Verify the PR on the affected signed-in Edge setup
before treating #531 as resolved. Full-resolution exact protected-frame
capture and GIF/audio restrictions remain separate questions.
