<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Experimental popup themes

Enable **Advanced → Experimental features → Theme Store**, then open **Design**.
Scroll the cards horizontally and choose **Use**. Selection saves immediately
and updates open popups and the preview. Disabling the experiment hides the
Store and keeps the selected popup. Existing palettes continue to use Default.
Design shows only the settings the selected theme uses (see
[Design settings](#design-settings)); the others keep their values for Default.

Default is the existing rich popup. Nazeka is a separate text renderer adapted
from [wareya/nazeka](https://github.com/wareya/nazeka). It constructs expression,
reading, frequency, deinflection and definition rows directly, with audio and
Anki controls supplied by Hachidori. It deliberately omits pitch graphs, images,
dictionary tabs, the Note editor and custom buttons in this MVP. All returned
entries are rendered; there is no Show more truncation in Nazeka. Keyboard entry
navigation, nested dictionary lookups, kanji/Back, definition blur and resizing
use the reader's existing state and handlers. Popup dimensions remain Design's
saved dimensions. Nazeka omits the lookup-count display. Its borderless audio
control follows the reading and Anki follows the entry metadata, as in JL.
The preview shows a disabled Anki sample; real Anki controls appear when mining
is configured and available, using the existing core behaviour.

## Plain

Plain renders only complete dictionary definitions: one text element per result,
inside the popup itself. It does not construct headwords, readings, dictionary
labels, frequency/pitch metadata, counts, icons, audio or Anki controls. It loads
no icon stylesheet, dictionary styles or rich dictionary DOM. No Anki checks or
audio playback are initiated through empty action bindings. Definition blur,
source highlighting, scrolling and nested lookups still use the core reader.
It has no resize handle or dictionary navigation UI; size remains configurable
in Design. Native kanji requests display their definitions only.

## JL

JL follows the popup of [rampaa/JL](https://github.com/rampaa/JL) with its
default colours, font sizes, spacing and Meiryo. Each result gets one block per
dictionary, so a word with JMdict and 大辞泉 definitions appears twice, and each
block repeats the word's frequencies and pitch. The top line wraps: spelling,
reading, audio, deconjugation (`攫い ～masu stem`), frequencies (`#3551` from one
frequency dictionary, `JPDB: 9209, …` from several), dictionary name and Anki.
Definitions are plain text; a dictionary's rows are numbered and one sense's
plain glosses are joined with `; `. As in JL's JMdict, word classes and other
tags get separate brackets (`[v5u, vt] [uk]`), and a bracket every row shares
goes on the line above them. A dotted line marks pitch over the reading using
Default's pitch rules, supplied through the `buildPitchAccentMorae` and
`pitchAccentPositions` components. Design's pitch accent switch and pitch
dictionary apply.

The tab row shows All and each dictionary with results, in Settings order.
Choosing a tab hides the other blocks without rendering again, and the reader
keeps the tab for Back, as with Default's tabs. Core binds audio, Anki and
keybinds to the blocks the tab shows, so autoplay and keyboard actions follow
the tab as they do in Default. A block's audio and Anki buttons act on that
block: Anki receives only its dictionary's definitions, as in JL. Tabs and audio
are always visible, where JL shows them in mining mode only. JL's title row
holds its x, which appears where Hachidori offers Close (nested popups); a root
popup starts with the tabs. The background is black at Design's opacity (JL
ships 80%; Hachidori defaults to 85%). The theme leaves out JL's alternative
spellings, which Hachidori returns as separate results, and has no images, Note
editor, custom buttons or lookup counts. Its kanji view lists meanings, then
JL's `On:`, `Kun:` and `Statistics:` lines.

## Bee's Theme

Bee's Theme puts Girlypop blush, magenta and violet colours on JL's typography, per-dictionary headers, inline
audio/Anki controls and pitch marker. It adds All followed by tabs for configured dictionary
groups with matching results, a pencil editor and custom actions beside each
block, and shows each dictionary's formatted definition (markup and media) in
place of JL's text and tag brackets. Audio, Anki and pencil sit together as one
set of icon buttons, the kanji view's Back is top left, and hovering a glossary
image shows Default's enlarged preview.
With no matching groups, all results appear without a tab row. Extra custom
actions go into More actions after the first two. The Design preview includes
explicitly labelled sample group tabs when no configured group matches. Compact glossaries,
frequency names, compact numbers, averages and pitch notation style are
available in Design. See [details and measurements](bee.md).

## Version 2 view contract

`theme-host.js` chooses a bundled renderer before content construction. Default
adapts `HDPopup.createPopupView`; Nazeka, Plain, JL and Bee export `{schema: 2, slug, contentMode,
createView(options)}`. Executable modules are maintainer-reviewed release assets;
no remote theme code is fetched for execution. This is not a JavaScript sandbox.
Sources and proposals live in [hachidori-themes](https://github.com/bee-san/hachidori-themes).

The options object supplies the popup element, document/window, core callbacks,
scoped source highlighter and optional shared components. A view owns its DOM
and returns `renderResults`, `renderKanji`, `renderNotice`, `renderLookupFailure`,
`clear`, `destroy`, `captureTermView`, `currentEntryIndex`, `focusEntry`,
`setDefinitionBlurState`, `setLookupStats`, `setSourceHighlightEnabled`,
`updateDictionaryPresentation`, and `scrollElement`. Rich-only methods such as
masonry, image preview, toolbar/custom buttons, note closing and deferred
presentation updates are optional.

`createDictionaryTabs` supplies the existing dictionary/group descriptors.
`createLookupActions` shares the personal dictionary editor and custom link/Anki
buttons with Default; the renderer supplies prefill, form placement and optional
custom-button layout. Core still binds mining to the returned actions container.

- Render calls receive structured lookup results and the current request context.
  Never scrape Default DOM. Core owns cancellation, navigation and action engines.
- Term rendering supplies arrays of `{button,result}` audio bindings and
  `{actions,feedback,result}` mining bindings through `onResultsRendered`, with
  a `lookupStats` slot (or `null` when the theme omits counts). Core paints counts
  and binds current-request actions. When the shown entries change without a new
  render, `onResultsExpanded` announces the arrays again, as Default's Show more
  and JL's tabs do; keybinds index the announced entries.
- `updateDictionaryPresentation` edits dictionary labels without rebuilding
  definitions. Blur updates edit state only. A new lookup replaces content;
  Back carries scroll state. Default retains its existing incremental renderer.
- Switching retires action bindings, destroys the previous view and replaces its
  content/styles, then replays the latest model and view settings. Switching closes
  the Note editor; finish or cancel a draft before changing renderers. Obsolete request
  contexts are not replayed. A throwing alternative renderer is disabled for that page
  and the current model is rendered with Default's CSS. The saved choice remains.
- `destroy` releases listeners/observers and owned DOM; core closes audio menus
  and retires mining state. Removed node listeners become collectible.

### Design settings

Each entry in `extension/vendor/themes/index.json` declares, in `designSettings`,
which Design settings its renderer implements: `"all"` or a list of option keys.
The keys are the renderer-owned controls, tagged `data-design-setting` in
`settings.html`: `popupOpacityPercent`, `popupToolbarPosition`, `popupColumns`,
`glossaryLayoutMode`, `popupImageSource`, `imageHoverPreview`, `kanjiClickDictionary`,
`showFrequencyDictionaryNames`, `compactFrequencyNumbers`, `averageFrequency`,
`showPitchAccentFurigana`, `pitchAccentFuriganaDictionary`, `pitchAccentFuriganaStyle`,
`showPitchAccentColors`, `showPitchAccentBadge`, `showPitchAccentDictionaryNames`,
`showPitchAccentText`, `showPitchAccentPosition`, `showPitchAccentGraph`,
`hidePopupGrammarTags`, `showCompactDefinitionSummary`,
`compactDefinitionSummaryCount`, `compactDefinitionSummaryDictionary` and
`customButtons`. Core applies Theme, Width, Height, Scale, Highlight the word on
the page and Custom CSS/JavaScript to every renderer, so those always show and
are never declared.

| Theme | Design settings besides the core ones |
| --- | --- |
| Default | All (`"all"`) |
| Nazeka | Clicked-kanji dictionary |
| Plain | None |
| JL | Background opacity, Clicked-kanji dictionary, Show pitch in furigana, Pitch accent dictionary |
| Bee's Theme | JL's four, plus Image source, Image hover preview and Custom buttons |

Settings shows the core controls and the selected theme's declared ones, and
hides a group whose controls are all hidden. Search skips hidden controls.
Hidden settings keep their saved values and apply again on Default; choosing a
theme writes only `popupTheme`. The filter follows the theme in use, even with
the Theme Store switched off. An entry without `designSettings`, an unknown
theme or an unreadable catalogue shows every control. Default declares `"all"`
because new Design settings are built there first; the other themes list their
keys, so a new setting stays hidden on them until each implements and declares it.

A declared setting must change an open popup and the Design preview without a
new lookup. Core delivers changes through `updateDictionaryPresentation`
(frequency, pitch, tag, compact-summary and image-source options),
`setToolbarPosition`, `setCustomButtons`, the `getPopupColumns` and
`getImageHoverPreview` callbacks, the `--gsm-hoshidicts-popup-opacity`
custom property and the `data-hoshidicts-glossary-layout` host attribute.
`test/theme-renderer.test.mjs` checks every declaration
against its renderer, in both directions.

## Content and stylesheet ownership

Default loads `render/reader.css`; Default and Bee load scoped dictionary CSS. Bee
uses its own JL-based stylesheet and builds rich glossary DOM only on expansion.
Nazeka loads
its own CSS plus shared icon controls. Plain loads only its own CSS. Both still parse the shared `popup.js`
script for existing geometry/action helpers; Nazeka never calls its Default
view factory. Splitting that script could reduce startup parsing later, but is
outside this MVP. Custom CSS remains last. Nazeka's
`glossaryToPlainText` traverses dictionary data without building rich DOM,
requesting images, or creating dictionary links. Rich content remains untrusted.
It lays structured content out as JL does: spaced tag pills, `昨日[きのう]`
furigana, list markers, `| a | b |` table rows and one line break per block.
The existing `appendTextOnlyGlossary` is a rich helper and is not text mode.

## Focused validation

```sh
node test/make-fixture.mjs
node --test test/theme-renderer.test.mjs test/settings-search.test.mjs
node test/chrome-theme-store.mjs
```

The browser check saves real popup, kanji and Store screenshots under
`test/tmp/theme-store`. See the benchmark report for repeatable performance
measurements and limitations. The full Nazeka extension's lookup engine is not
part of that comparison.
