<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Popup themes

Open **Design → Theme Store**. Scroll the cards horizontally and choose **Use**.
Selection saves immediately and updates open popups and the preview. Existing
palettes continue to use Default.
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

## Crystal

Crystal is theme idea 5 in [hachidori-themes#24](https://github.com/bee-san/hachidori-themes/issues/24):
a fine gold frame with a blue crystal crest. Design → Colours chooses Grey or
Beige, after FFXIV's Dark and Light windows with red and gold buttons, or Retro
blue, the classic Final Fantasy menu window; Automatic is Beige in the system's
light mode and Grey in its dark mode (see [colour variants](#colour-variants)).
Each result has one header (serif headword, the reading with its pitch, the
deinflection trail and book/star frequency badges), then a framed section per
dictionary with a crystal plaque, numbered senses in diamonds, tag chips and
its own audio, Anki and pencil buttons. Group tabs, formatted definitions,
custom actions, the Note editor and the image preview behave as in Bee's Theme.
See [details and measurements](crystal.md).

## Version 2 view contract

`theme-host.js` chooses a bundled renderer before content construction. Default
adapts `HDPopup.createPopupView`; Nazeka, Plain, JL, Bee and Crystal export `{schema: 2, slug, contentMode,
createView(options)}`. Executable modules are maintainer-reviewed release assets;
no remote theme code is fetched for execution. This is not a JavaScript sandbox.
Sources and proposals live in [hachidori-themes](https://github.com/bee-san/hachidori-themes).

The options object supplies the popup element, document/window, core callbacks,
scoped source highlighter and optional shared components. A view owns its DOM
and returns `renderResults`, `renderKanji`, `renderNotice`, `renderLookupFailure`,
`clear`, `destroy`, `captureTermView`, `currentEntryIndex`, `focusEntry`,
`setDefinitionBlurState`, `setLookupStats`, `setSourceHighlightEnabled`,
`updateDictionaryPresentation`, and `scrollElement`. Rich-only methods such as
masonry, image preview, toolbar/custom buttons, note closing, action-menu dismissal and deferred
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
  with `setLookupStats(slot, statistics, pending)`; while `pending`, a count is on
  its way and the view keeps its place. Core also binds current-request actions.
  When the shown entries change without a new render, `onResultsExpanded`
  announces the arrays again, as Default's Show more and JL's tabs do; keybinds
  index the announced entries.
- `updateDictionaryPresentation` edits dictionary labels without rebuilding
  definitions. Blur updates edit state only. A new lookup replaces content;
  Back carries scroll state. Default retains its existing incremental renderer.
- With Definition blur's **On click only** reveal (#598), core's
  `HDPopup.createDefinitionReveal` marks a blurred lookup's definitions after
  each render and blur change, and removes the marks at the reveal. Each
  `.gsm-hoshidicts-definitions` element gets `data-definition-reveal`,
  `role="button"`, `tabindex="0"` and the label "Reveal definitions", and its
  element children become `inert`. (Default's definitions are a list, which
  cannot be a button, so there the `.gsm-hoshidicts-glossary-card` holding the
  list is the button and the list itself becomes `inert`.) Put definition
  content in child elements so links and images are disabled until the reveal;
  text directly in that element, as in Plain, stays readable only as the
  button's presentational content. A blur `filter` on that element would blur
  its focus ring, so draw the ring on an unfiltered ancestor with `:has()`, as
  the bundled themes do (JL:
  `.jl-entry:has(> [data-definition-reveal]:focus-visible)`), and give
  `[data-definition-reveal]` `cursor: pointer`. The bundled JL, Bee, Nazeka and
  Plain `theme.css` carry these rules locally; the hachidori-themes revision in
  `extension/vendor/themes/source.json` predates them, so an update from it must
  keep them.
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
`showFrequencyTagsWithAverage`,
`showPitchAccentFurigana`, `pitchAccentFuriganaDictionary`, `pitchAccentFuriganaStyle`,
`showPitchAccentColors`, `showPitchAccentBadge`, `showPitchAccentDictionaryNames`,
`showPitchAccentText`, `showPitchAccentPosition`, `showPitchAccentGraph`,
`hidePopupGrammarTags`, `showCompactDefinitionSummary`,
`compactDefinitionSummaryCount`, `compactDefinitionSummaryDictionary` and
`customButtons`. Core applies Theme, Width, Height, Scale, Highlight the word on
the page and Custom CSS/JavaScript to every renderer, so those always show and
are never declared. Colours is core too, and shows for a theme whose entry
lists [colour variants](#colour-variants).

| Theme | Design settings besides the core ones |
| --- | --- |
| Default | All (`"all"`) |
| Nazeka | Clicked-kanji dictionary |
| Plain | None |
| JL | Background opacity, Clicked-kanji dictionary, Show pitch on the reading, Pitch accent dictionary |
| Bee's Theme | JL's four, plus Image source, Image hover preview and Custom buttons |
| Crystal | JL's four, plus Compact glossaries, Show frequency dictionary names, Abbreviate large numbers, Show frequency averages, Show each dictionary's frequencies with the averages, Reading pitch style, Image source, Image hover preview and Custom buttons |

Settings shows the core controls and the selected theme's declared ones, and
hides a group whose controls are all hidden. Search skips hidden controls.
Hidden settings keep their saved values and apply again on Default; choosing a
theme writes only `popupTheme`. The filter follows the theme in use. An entry
without `designSettings`, an unknown
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

### Colour variants

A catalogue entry may list colour variants, each an `id` and a `name`:
Crystal lists `grey` (Grey), `beige` (Beige) and `blue` (Retro blue). For a
theme with variants, Design → Appearance shows **Colours** below Theme, with
Automatic first and then the variants in catalogue order; other themes hide it.
The choice is the core option `popupThemeVariant`: `"auto"` by default, or one
of the ids in `POPUP_THEME_VARIANTS` in `reader-options.js`, which a new
variant id must join. Reset Design restores Automatic, and choosing a theme
leaves the stored choice alone, so it applies again when the theme returns;
Colours shows Automatic for a theme without that variant.

`createPopupAppearance` sets `data-hoshidicts-theme-variant` to the chosen id on
the popup host and removes it for Automatic, so a change recolours open popups,
child popups and the Design preview without rendering again or touching a Note
draft. A theme's stylesheet selects on the attribute and decides what
Automatic means: Crystal's Grey and Beige colours are `light-dark()` pairs on a
popup whose `color-scheme` is `light dark`, so Automatic follows the system's
mode. (The host's inline `all: initial` resets `color-scheme` there, so the
popup element declares it.) Hachidori's own palettes are unaffected.
`test/theme-renderer.test.mjs` checks that every listed id is a stored value and
that the theme's stylesheet styles it.

### Languages

Hachidori looks words up in several languages, one profile per language
([docs/languages.md](../languages.md), sections 10 and 11). A view gets the
language of what it shows and marks language text with it; core does the
rest, including for themes written before languages existed.

**What a view receives.** `createView(options)` gets `options.language`, and
every render context (`renderResults`, `renderKanji`, `renderNotice`,
`updateDictionaryPresentation`) carries `context.language`. Two consecutive
renders can carry different languages, so read `context.language` on every
render and keep `options.language` for one-time work such as font warm-up. A
caller that passes no language gets Japanese. Fields are added within
`version: 1`; ignore fields you do not know.

```js
{
  version: 1, code: "ar", bcp47: "ar", name: "Arabic", direction: "rtl", scripts: ["Arab"],
  capabilities: { readings: "none", ruby: null, pitchAccent: false, characterView: null, wordHighlighting: true },
  typography: { fontFamily: null, wordBreak: null, lineBreak: null, joinedScript: true },
  labels: { reading: "Reading", traceMarker: "", readingBrackets: ["(", ")"], senseSeparator: "; ", listSeparator: ", ",
            character: null, onyomi: null, kunyomi: null, readingSeparator: null },
  settings: { vowelMarks: "hide" }, sampleText: "قرأ",
  sourceAttributes(), readingAttributes(), glossaryAttributes(title, result), nameAttributes(name),
  isolate(text), isCharacterLink(character), display(result, field), readingFor(result), sliceText(text, start, end),
}
```

Until a second language is added the language is *unmarked*: every attribute
helper returns `{}` and `isolate` returns its text, so a theme that uses them
renders exactly what it rendered before. Japanese labels are the Japanese
pack's (`～`, `《》`, `On`, `Kun`, `、`).

**Where each helper goes.**

| Text | What to use |
| --- | --- |
| Headword (`.gsm-hoshidicts-expression`), the matched form in a deinflection trail, the character in the character view, a sentence excerpt | `sourceAttributes()` on its element; `display(result, "expression")` for its text |
| Reading | `readingAttributes()`; `display(result, "reading")`, or `readingFor(result)`, which is `""` when the reading equals the displayed headword |
| One dictionary's block of definitions | `glossaryAttributes(title, result)` on the element holding the whole block, so numbers, bullets and text turn together |
| Dictionary titles, display names, group names, frequency labels | `nameAttributes(name)` on an inline element that holds only the name, never on a box layout can widen; in plain text, `isolate(name)` |
| Clickable characters | `isCharacterLink(character)`; the links' labels name `labels.character` |
| Trace markers, reading brackets, sense and list separators, character-view reading labels | `labels` |
| Excerpts cut to a length | `sliceText(text, start, end)`, which never splits a grapheme |

Results may carry `presentation` (a display setting such as Arabic vowel
marks); `display()` reads it. Mining, counts and word status read `term`, so
never mine or compare stored data with displayed text.

**Shared components.** `options.components.language` holds the helpers above
as functions that take the language first (`components.language.isolate(language,
text)`), for code that runs outside a render, plus:

- `appendHeadword(document, parent, result, language, onCharacterClick)`:
  Default's headword with the language's ruby mode (kana furigana, one ruby
  per syllable, one over the word, or a reading line beside the headword);
- `characterEntryResult(character, entry, language)`: `kanjiEntryResult` with
  the language's reading labels, for mining a character;
- `glossaryToPlainText(glossary, language, { direction })`: the text-mode
  flattener; `direction` is the dictionary's, `glossaryAttributes(title,
  result).dir ?? "ltr"`. A paragraph of the other direction is wrapped in a
  directional isolate after its list marker; it keeps its order, not its
  alignment;
- `isolateParagraph(language, text, direction)`: the same for a line a theme
  composes itself, such as JL's `; `-joined senses;
- `setAttributes(element, attributes)`.

`options.appendTextOnlyGlossary` applies the language's glossary rules
(direction per paragraph, language per string) for the render's language;
pass `language` and `direction` in its options to name them yourself.

**What core does to the popup.** Once the records have profiles, core sets
`dir="ltr"` and `lang="en"` on `.gsm-hoshidicts-popup`, because the interface
is English, plus `data-hd-language`, `data-hd-direction` and the custom
properties `--hd-language-font-family`, `--hd-language-word-break` and
`--hd-language-line-break` from the pack's typography (each unset when the
pack leaves it null). Use them with your own values as fallbacks:

```css
.gsm-hoshidicts-popup {
  font: 15px/1.5 var(--hd-language-font-family, "My Serif", serif);
  word-break: var(--hd-language-word-break, normal);
  line-break: var(--hd-language-line-break, auto);
  text-align: start;
}
```

Write spacing inside definitions with logical properties
(`padding-inline-start`, `margin-inline-end`, `border-inline-start`), which
compute to the physical ones left to right. Do not letter-space text when
`typography.joinedScript` is true (Arabic, Syriac): spacing breaks the joins.

After every render, after `onResultsExpanded` and `updateDictionaryPresentation`,
and whenever the popup's content changes, core labels text whose nearest
`lang` is the popup's own or a block's default (`data-hd-lang-default`): it
sets `lang` on the text's parent, or moves the text, or one line of it, into
a `span[lang]`. Do not keep references to text nodes across a render. Core
also gives a list of mixed direction (`[data-hd-mixed-list]`) an inline
`padding-inline-end` equal to its start padding, so every number stays inside
its card.

**Declaring support.** A catalogue entry says which directions the theme lays
out and whether it shows `display()` text:

```json
"language": { "directions": ["ltr", "rtl"], "presentation": true }
```

An entry without `language` reads as `{ "directions": ["ltr"],
"presentation": false }`. For such a theme, core marks the contract's content
hooks when a render needs another direction: `.gsm-hoshidicts-expression`
gets the source attributes, and each `.gsm-hoshidicts-definitions` gets its
dictionary's direction and `text-align: start` when core can name its one
dictionary (`data-dictionary` on it or an ancestor, else
`data-hoshidicts-dictionary` on the glossary content inside it), or
`unicode-bidi: plaintext` and `text-align: start` on itself and its block
descendants when it holds several or none, where a row takes the direction of
whatever text comes first. Outside Japanese core ignores its character
clicks and hides the clicked-character dictionary, and a theme that does not
declare `presentation` shows the stored headword while Design hides the
pack's display settings. Every vendored theme declares both directions;
Plain, which shows no headword, declares `presentation: false`.

## Content and stylesheet ownership

Default loads `render/reader.css`; Default, Bee and Crystal load scoped dictionary CSS. Bee
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
