<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# PR #71 capture acceptance record

This records the follow-up to the 7 September 2026 review of
[PR #71](https://github.com/bee-san/hachidori/pull/71), reviewed at
`5e85e291ccf39f27c56f5f83da4f35762ec2b1c2`. Results below are local validation
snapshots. The final capture runtime is `9cc5907`, extension tree
`79cdedc83ca5b15bf42977925bd00c90ca4662df`. Its full and static export components
have passed browser checks; the thirty-minute headful aggregate remains pending.
Earlier complete capture runs passed processor and AudioWorklet paths on
Chromium 150 and Chrome for Testing 152 respectively.

## Nine review findings

All nine have focused production-path regressions. The complete Node suite
passed **226 tests, 0 failures** for runtime `9cc5907`. Run the capture review subset with:

```sh
node --test test/capture-*.test.mjs test/avif-sequence.test.mjs \
  test/anki-worker.test.mjs test/anki-templates.test.mjs \
  test/media-settings.test.mjs test/texthooker-protocol.test.mjs
```

| Finding | Corrected behavior | Verified evidence and limits |
| --- | --- | --- |
| 1. Stop followed by a new Anki mutation | Recheck the capture job immediately before add/update, after uploads and the final configuration read. Preserve the result of a mutation already sent. | [Anki worker tests](../test/anki-worker.test.mjs) exercise both add and overwrite through the production worker/service with a controlled gateway. No cancellation experiment writes to a live Anki collection. |
| 2. Fresh texthooker settings deadlock | The endpoint is editable before the feed is enabled. | [Settings regression](../test/media-settings.test.mjs) loads the production settings source and invokes the actual input/checkbox handlers. |
| 3. Invalid Automatic capture markers | Automatic and basic mapping share semantic-to-marker conversion, including when capture is disabled. | [Template tests](../test/anki-templates.test.mjs) validate `{capture-animation}` and `{capture-audio}` from the production helper. |
| 4. Stale nested lookup releases the root pin | Only the owner releases an unadopted provisional pin; child requests borrow it. | [Reader ownership tests](../test/capture-reader-ownership.test.mjs) invoke production lookup entrypoints for dismissed/superseded children, errors, stale root replay, and an unlink during pending acquisition. |
| 5. Cue interruption sends an Event timestamp | Pause, seeking, and ended listeners close with a numeric timestamp. | [Collector tests](../test/capture-content.test.mjs) dispatch actual events through the production message validator and timeline, then check the closed interval. |
| 6. Worker restart loses the reader binding | A surviving offscreen recorder and reader recover their same session/document through a validated handshake. | [Routing tests](../test/capture-routing.test.mjs) cover fresh worker handlers, immediate lookup, concurrent recovery, navigation, and settings races. The real-browser run replaced the worker target and recovered the same session/reader successfully. |
| 7. AVIF and WAV durations differ | Retain the start predecessor and serialize both assets on the same sample timebase. A single static frame becomes two identical timed samples, preserving a looping sequence. | [Buffer tests](../test/capture-buffer.test.mjs) and [real libavif tests](../test/avif-sequence.test.mjs) check irregular boundaries, static clips, odd sample counts, and exact WAV duration. Real-browser exports covered exactly ten seconds for both an 80-frame moving sequence and a two-frame static sequence. Content alignment is tracked separately below. |
| 8. Recently captured audio arrives after finalization | Allow a bounded 250 ms delivery drain without moving the anchor; report a continuous audio gap explicitly. | [Session tests](../test/capture-session.test.mjs) deliver late audio/JPEGs for recent and future intervals, test missing samples, stationary video, and Stop during drain. Committed-runtime processor and AudioWorklet browser runs both passed. |
| 9. Resizing stretches the source | Fit each frame inside the original canvas, preserving aspect ratio and adding letterboxing without upscaling. | [Drawing-path regression](../test/capture-routing.test.mjs) checks the production drawing geometry. The real X11 window test delivered a resize from 960 × 540 to 500 × 500; it does not inspect encoded pixels after resize. |

## Additional acceptance checks

| Area | Evidence as of 7 September 2026 | Status / remaining work |
| --- | --- | --- |
| Closed texthooker lines, DOM range association, ancestor visibility | Timeline/session/collector tests cover retained closed lines in the current live epoch, sentence ranges inside paragraphs, ambiguous ranges, and transparent ancestors with layout boxes. The production hover candidate supplies its DOM range. | Focused tests passed. |
| Controls closure and source interruption | The shared offscreen document owns capture. Host tests cover a late picker after Stop/settings changes and source mute without a controls page; clock tests cover backward video timestamps and interrupted audio delivery. | Focused tests and real controls close/reopen passed. The final runtime also rejects delayed reader linking after Stop or session replacement, and an obsolete same-page link cannot unlink the replacement collector. |
| Real application window and monitor | `chrome-capture-surfaces.mjs`: **5/5** at `9cc5907`, Chrome for Testing **152.0.7977.82**, isolated Xvfb/KWin. Window resize arrived; minimize/restore retained the session and resumed frames; closing the source stopped and cleared history. Monitor capture and Stop passed. Neither surface provided audio, and the controls reported it unavailable. | Verified for this Linux/X11 setup. Physical sleep/wake and other OS capture/audio behavior untested. |
| Default ten-second moving-text clip | Final-runtime browser export produced 80 frames over exactly ten seconds, with matching AVIF/WAV durations, a 32 MiB encoder heap, and 8,560.7 ms export time. | This export component passed actual Anki review: 80 distinct frames observed and repeated in the second loop; its ten-second WAV played/replayed for 10.049/10.087 seconds with PCM peaks of 65 matching the source. |
| Captured tab behind controls | A controlled focus comparison measured 7.99 fps with the source in front, 6.49 fps behind controls, and 7.99 fps after restoring source focus. In the background phase, Chrome counted 70 upstream frames and delivered 65 after five browser rate-adapter discards; all 65 reached JPEG encoding. | The configured 8 fps is a ceiling. The full-rate soak keeps the source in front to match its baseline; it does not establish 8 fps for background sources. |
| Static-scene export | The final runtime exported a static scene after sixty seconds as a looping two-frame AVIF and WAV, each exactly ten seconds. Export took 771.8 ms with a 32 MiB encoder heap. Actual Anki held the same scene for 23.36 seconds and played/replayed audio for 10.068/10.082 seconds. | Static component passed. Rendered RGB RMS difference was 0.3840/255, within the 1/255 limit. An independent moving-frame negative control measured 17.2280/255 and was rejected. Both audio peaks of 65 matched the source; static pixels alone cannot prove a loop. |
| Flash/beep content alignment ≤125 ms | The decoded white-area/WAV-onset oracle measured **22.479 ms** on Chromium 150 processor audio and **33.979 ms** on Chrome for Testing 152 AudioWorklet audio, both on runtime tree `f628dd9a3117921330377e6c61ff874ee7ee3765`. | Both **13/13** runs passed. The oracle recognizes the flash area across fixture layouts; it does not assume a centered video. Thirty-minute validation remains pending. |
| Thirty-minute retention, CPU, sampled memory, full-export lookup latency | The 1,800-second run cycles static/moving/dense scenes, checks ring bounds, exports each period, and records CPU/RSS for the entire test browser, including fixture tabs. New processes contribute observed CPU time; phase totals exclude intervening phases. | **Running at `9cc5907`; final aggregate pending.** This run explicitly enables headful mode and restores source focus after lifecycle checks, matching the throughput baseline. `sampledPeakRssMiB` is a sampled RSS sum with duplicated shared pages, not a continuous or unique-memory peak. Processes entirely between samples are missed; encoder heap is measured separately. |
| Actual Anki Desktop AVIF/WAV | Anki **26.05**, Qt **6.11.1**, embedded Chromium **140.0.7339.225**. Fresh isolated collection, real reviewer, AVIF looping, actual MPV playback/replay, private recorded audio sink, remote reviewer requests blocked. | Short, full moving, and full static asset pairs passed their respective checks. Audible and low-level source PCM were preserved on playback/replay. Static pixels do not independently establish a loop boundary. No AnkiWeb sync or extra-device/client playback was tested. |
| Repository checks | Node **226/226**, focused collector/host/routing **28/28**, and extension smoke **445/445** for runtime `9cc5907`; Chrome E2E **170/170** at `9cc5907`; earlier Node/WASM smoke **116/116** and benchmark tests **39/39**. Capture runs: Chromium **150.0.7871.186** processor **13/13**, Chrome for Testing **152.0.7977.82** AudioWorklet **13/13**. | Checks are local results for the recorded revisions. Final CI, Sonar, and review status remain tied to the eventual PR head. |

The earlier complete processor and AudioWorklet runs recorded commit `acf81a9`, runtime tree
`f628dd9a3117921330377e6c61ff874ee7ee3765`, and `extensionModified: false`.
The Chromium 150 run also used the corrected white-area oracle. Full exports
covered exactly ten seconds in both formats and used a measured 32 MiB encoder
WASM heap:

| Runtime / audio path | Full AVIF frames | Export time | Largest lookup-batch median / p95 during export |
| --- | ---: | ---: | ---: |
| Chromium 150 / processor | 81 | 6,241.4 ms | 7.9 / 18.0 ms across 21 batches |
| Chrome for Testing 152 / AudioWorklet | 79 | 8,549.1 ms | 7.3 / 13.4 ms across 34 batches |

These are one machine's results, not performance guarantees or a completed
long-run memory assessment. They do not isolate extension CPU from the animated
fixture. The current headful run records `9cc5907`, extension tree
`79cdedc83ca5b15bf42977925bd00c90ca4662df`; its full ten-second export measured
8,560.7 ms with 29 lookup batches, whose largest median/p95 was 7.9/14.0 ms.
The completed thirty-minute aggregate remains pending.

Chromium forwards the requested frame rate as a
[minimum capture period](https://github.com/chromium/chromium/blob/152.0.7977.82/content/browser/media/capture/frame_sink_video_capture_device.cc#L327).
Its [capture oracle](https://github.com/chromium/chromium/blob/152.0.7977.82/media/capture/content/video_capture_oracle.cc#L140)
samples compositor events and can rewrite animated-content timestamps. Blink's
[track adapter](https://github.com/chromium/chromium/blob/152.0.7977.82/third_party/blink/renderer/modules/mediastream/video_track_adapter.cc#L503)
separately drops frames whose timestamps are too close together. These sources
support a maximum-rate interpretation; the probe does not identify which
upstream compositor decision caused its lower background delivery rate.

## Local evidence provenance

These paths identify the machine-local evidence, not files distributed with the
repository. Use the [test commands](../test/README.md#chrome-capturemjs) to create
new evidence on another machine.

| Run | Evidence |
| --- | --- |
| Full Node for runtime `9cc5907` | `/tmp/pr71-link-race-node-final.log`: **226/226** |
| Focused lifecycle / extension smoke for runtime `9cc5907` | `/tmp/pr71-link-race-root-tests.log`: **28/28**; `/tmp/pr71-extension-smoke-9cc5907.log`: **445/445** |
| Earlier Node-WASM smoke / benchmark tests | `/tmp/pr71-node-smoke.log`: **116/116**; `/tmp/pr71-benchmark-tests.log`: **39/39** |
| Chrome E2E | `/tmp/pr71-chrome-e2e-9cc5907.log`: **170/170** |
| Real tab capture, processor audio | `/tmp/pr71-capture-worker.log`; assets and process resource samples in `/tmp/pr71-capture-assets-worker/` |
| Committed-runtime Chromium 150 processor run | `/tmp/pr71-capture-chromium150-marker-fixed.log`: **13/13**, 22.479 ms flash/beep offset |
| Committed-runtime Chrome for Testing 152 AudioWorklet run | `/tmp/pr71-capture-worklet-acf81a9.log`: **13/13**, 33.979 ms flash/beep offset |
| Current thirty-minute headful soak | `/tmp/pr71-capture-soak-active.log`; assets in `/tmp/pr71-capture-assets-soak-active/`; final aggregate pending |
| Controlled captured-tab focus comparison | `/tmp/pr71-focus-cadence-ICTWdp/results.json` and `instrumentation.diff`: identical source and 1280 × 720 capture settings across foreground, background, and restored-foreground phases |
| X11 surfaces | `/tmp/pr71-surfaces-9cc5907.log`; `/tmp/hachidori-surfaces-CCRf3L/results.json` |
| Actual Anki audible clip | `/tmp/hachidori-anki-desktop-pm4uygh1/result.json`: 2.6173125 s WAV, two playback peaks of 8,669 matching the source; 14 distinct rendered AVIF frames, 13 observed again in the second loop. |
| Final-runtime actual Anki full clip | `/tmp/hachidori-anki-desktop-xuc5hjr8/result.json`: 80 distinct rendered frames repeated in the second loop, 9.956 s sampled recurrence, 10.049/10.087 s audio plays with PCM peaks of 65 matching the source |
| Final-runtime actual Anki static clip | `/tmp/hachidori-anki-desktop-6o14q5ti/result.json`: same scene observed for 23.36 s, RMS difference 0.3840/255; ten-second WAV played/replayed for 10.068/10.082 s, both PCM peaks of 65 matching source |
| Static image tolerance controls | `/tmp/pr71-anki-static-controls-final.json`: final static RMS difference 0.3840 accepted; final moving-frame RMS of 17.2280 rejected against the 1/255 normalized RGB limit |

The Anki harness snapshots the exact input bytes before importing them. Recorded
SHA-256 identities for those runs are below. Full/static assets come from
`9cc5907`; the earlier short pair separately proves playback of its audible
flash/beep marker.

| Asset | SHA-256 |
| --- | --- |
| Short AVIF | `d6070f7a9ff1da028b465917012b0dbfc8b23de32e38c811949695d6a1e33ce3` |
| Short WAV | `d90e9ef665e639d4288ddb6df427850f2699e4c6075ce27896686d865279b276` |
| Full AVIF | `418b5a24b61d42642cc10080ebf67ab27a1442ce30560be63de5fe802e4c06fd` |
| Full WAV | `ec1989b706825d4b6fb5b8f5207551529c4d6a91dbcbce2dd53ff22f7ae9d763` |
| Static AVIF | `9e558f663acb46562b746a82d50d40567b227b54a0a75cc7427078e86d74ed7d` |
| Static WAV | `35e10e6fc5c9dab306b74d6744e7d1d5eb9e005f066df22b3d46178a32668495` |

## Superseded attempts

These explain the earlier failures and are not evidence that the current full
soak passed. `/tmp/pr71-capture-static-check.log` passed its static export but
later failed alignment. `/tmp/pr71-capture-soak-measured.log` omitted headful
mode and stopped after 387 seconds on its dense-frame gate. Its silent-source
assets did pass isolated Anki playback checks
(`/tmp/hachidori-anki-desktop-92dz6t51/result.json` and
`/tmp/hachidori-anki-desktop-qyaufsca/result.json`), but current asset provenance
comes from the explicitly headful run above.
