# 0008: Automatic switching chooses a profile per lookup from `lang`, without changing the active profile

Status: proposed (multi-language design, Phase 1, revision 4)

## Context

The task asks for optional automatic switching by the page's or element's
`lang`. A page can hold several languages, and every lookup passes through
the reader's hot path.

## Decision

With **Switch language automatically** on, each lookup uses the profile whose
pack matches the nearest `lang` attribute (primary subtag), or the active
profile when none matches. The active profile and storage do not change.

## Options rejected

- **Change the active profile when the page's language changes.** Every
  hover across two languages would write storage, broadcast to every frame
  and every linked browser, and move Settings under the user's hands.
- **Detect the language from the text's script.** Han text is Japanese or
  Chinese, Latin text is any of a dozen languages, and pages mark their
  language more often than not. Packs carry `text.pattern`, so script hints
  can be added later as a second step.

## Consequences

- Two lookups on one page can use different profiles, so the content script
  keeps every profile's projection and themes read the language from each
  render's context.
- The popup labels a lookup whose profile differs from the active one.
