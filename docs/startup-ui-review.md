# Startup UI review

This review improves the first-run flow from [issue #58](https://github.com/bee-san/hachidori/issues/58)
on the MacBook Air M2. The baseline is `6b895529ef4ff6e98be0e8ce406e8176d3e7c9b2`;
the comparison’s updated page sources are from `ed023b6`.

The screenshots use Chrome for Testing 152.0.7977.82 with isolated profiles,
at **1024 × 900** desktop and **360 × 900** narrow viewports. Full-page captures
include content below the viewport, so image heights differ. Both Settings
palettes and reduced motion were selected through browser media emulation.
Every image below was inspected and copied without editing.

## Dictionary failure and responsive layout

The baseline’s desktop error column overlaps JMnedict’s name and description
when the publisher failure wraps. Status now sits below the dictionary’s name
and purpose, with its own full-width progress bar. The narrow layout keeps the
three steps together, reduces header space, and retains readable retry and
continuation controls.

| View | Before | After |
| --- | --- | --- |
| Desktop, light | ![Overlapping JMnedict error before the change](assets/startup-review-before-failure-desktop-light.png) | ![Wrapped error below the dictionary name after the change](assets/startup-review-after-failure-desktop-light.png) |
| Narrow, dark | ![Previous stacked setup steps and failure state](assets/startup-review-before-failure-narrow-dark.png) | ![Compact setup steps and readable failure recovery](assets/startup-review-after-failure-narrow-dark.png) |

## Practice and optional saved pages

The previous final screen only explained how to hover on another webpage.
The new screen supplies a street scene, a longer Japanese passage, a keyboard
lookup control, retained Anki feedback and the optional saved-HTML prompt.
Finish remains available, and missing dictionaries or disabled lookups lead to
the appropriate Settings recovery section.

| View | Before | After |
| --- | --- | --- |
| Desktop, light | ![Previous final screen in the light palette](assets/startup-review-before-practice-desktop-light.png) | ![Practice and saved-page prompt in the light palette](assets/startup-review-after-practice-desktop-light.png) |
| Desktop, dark | ![Previous final screen in the dark palette](assets/startup-review-before-practice-desktop-dark.png) | ![Practice and saved-page prompt in the dark palette](assets/startup-review-after-practice-desktop-dark.png) |
| Narrow, light | ![Previous final screen at narrow width in light mode](assets/startup-review-before-practice-narrow-light.png) | ![Wrapped Japanese passage and optional controls at narrow width in light mode](assets/startup-review-after-practice-narrow-light.png) |
| Narrow, dark | ![Previous final screen at narrow width in dark mode](assets/startup-review-before-practice-narrow-dark.png) | ![Wrapped Japanese passage and optional controls at narrow width in dark mode](assets/startup-review-after-practice-narrow-dark.png) |

These comparison images render the actual packaged page DOM and CSS in Chrome,
with controlled storage, dictionary progress and Anki outcomes. Their background
worker is inert: the displayed installation times and inventory are fixtures,
and these images alone do not prove downloads, imports or lookup results.
The capture driver and complete state matrix remain in ignored
`test/tmp/ui-review/`; production-path checks are documented in
[the test guide](../test/README.md#chrome-e2emjs).

The separate real-Chrome run imports the catalogue fixtures through the normal
WASM engine. Pressing Enter on **Look up 辞書** returns their actual glossary
content in the ordinary popup; pointer lookup is checked too. This viewport
capture shows that result and the still-available Finish control:

![Actual installed-fixture lookup on the practice scene](assets/startup-practice-lookup.png)

The shared Settings tokens give the dim, success and error text on the inset
surface contrast ratios of at least **5.67:1** in light mode and **6.77:1** in
dark mode. The active step is **5.86:1** and **6.95:1**, respectively. Keyboard
checks cover the skip link, lookup control, preserved selections, recovery and
Finish. Live-region checks cover stage/outcome announcements without per-byte
announcements; this is DOM/browser validation, not a VoiceOver session.

Chrome 152 closes extension tabs when the native file-access switch reloads
Hachidori. The optional prompt now explains **Extension options → Resume
setup** after opening the details page. This final narrow capture uses the
retained real fixture profile, with access disabled:

![Saved-page instructions and reload recovery at narrow width](assets/startup-file-access-recovery.png)

## Targeted progress-update measurements

The persistent rows change the setup progress render path. On macOS 14.6.1,
MacBook Air M2/8 GiB, Node 22.22.3 and headless Chrome 152.0.7977.82, the local
capture driver compared `6b89552` with production sources at `fae45dd`.
The independent benchmark's timed workloads had finished; these runs used
separate profiles, serially, at Puppeteer's 800 × 600 default viewport.

Reproduction setup: load each revision's startup page and Settings CSS in a
scratch extension with an inert background. Stub the initial storage read to
an empty dictionary inventory and a dictionary-stage setup record. Return an
unfinished run from `hd_setup_install`: four catalogue rows, Jitendex downloading
59,768,832 of 125,829,120 bytes and the other three waiting. Capture the startup
runtime listener, then time 11 batches of 100 synchronous `hd_setup_progress`
messages with `performance.now()`, incrementing the run sequence and received
bytes by 1,024 per message. Use the same run ID and production listener/render
path throughout. Verify the final row says 58.1 MB (48%) rather than 57.0 MB
(47%) and record whether the original row remains connected. Run before/after,
then after/before, each in a separate browser. The local commands are
`node test/tmp/ui-review/capture.mjs before measure` and the corresponding
`after measure`; raw samples and the capture driver remain beside that file.

| Run | Before, median ms / 100 updates | After, median ms / 100 updates |
| --- | ---: | ---: |
| Before then after | 1.500 | 1.105 |
| After then before | 1.615 | 1.050 |

Before sample ranges were 1.255–3.185 and 1.240–2.760 ms; after ranges were
0.790–2.080 and 0.765–5.725 ms. Both revisions applied the same updates; only
the updated page retained the row. These short samples show no median
synchronous-update regression, with visible warmup/noise. They exclude layout,
paint, asynchronous work, downloads, native import and lookup latency, and do
not establish an end-to-end speedup.

The scene uses the exact background from GameSentenceMiner PR #549, retaining
the embedded SovietGames, *Love, Money, Rock’n’Roll* and ArseniXC credits.
[Asset attribution](../extension/assets/ATTRIBUTION.md) records its immutable
source, dimensions and SHA-256.

Screenshot-only Anki mining remains a separate acceptance item in #58; this
review does not claim that the entire issue is complete.
