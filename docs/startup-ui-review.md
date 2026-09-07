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

The scene uses the exact background from GameSentenceMiner PR #549, retaining
the embedded SovietGames, *Love, Money, Rock’n’Roll* and ArseniXC credits.
[Asset attribution](../extension/assets/ATTRIBUTION.md) records its immutable
source, dimensions and SHA-256.

Screenshot-only Anki mining remains a separate acceptance item in #58; this
review does not claim that the entire issue is complete.
