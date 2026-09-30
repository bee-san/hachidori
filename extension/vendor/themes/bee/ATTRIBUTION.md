# Bee's Theme

Bee's Theme shares the direct JL renderer in `../jl/theme.js` and keeps JL's
typography, repeated dictionary headers, frequencies and pitch marker. Its
charcoal, turquoise and pink palette adapts Hachidori's Miku colours, with
brighter text accents and focus colours for contrast. Group tabs share one
frame and equal widths.
See [JL's attribution](../jl/ATTRIBUTION.md) and [Apache-2.0 licence](../jl/LICENSE.Apache-2.0).

The additions are group-only tabs, expandable rich dictionary content, the shared
Hachidori personal dictionary editor and custom link/Anki buttons. Rich content
uses Hachidori's existing structured glossary renderer. The theme never builds
Default's popup. Hachidori integration is GPL-3.0-or-later.

The host supplies `createLookupActions` and `createDictionaryTabs` components,
plus its existing `appendTextOnlyGlossary` callback, and loads scoped dictionary
styles. Without configured groups with matching results, all definitions appear
without a tab row. Custom actions beyond the first two appear in More actions.
Rich DOM and images are created only when Formatted definition is opened.
