<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Experimental popup themes

Enable **Advanced → Experimental features → Theme Store**, then open **Design**.
Scroll the cards horizontally and choose **Use**. Selection saves immediately
and updates open popups and the preview. Disabling the experiment hides the
Store and keeps the selected popup. Existing palettes continue to use Default.

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

## Version 2 view contract

`theme-host.js` chooses a bundled renderer before content construction. Default
adapts `HDPopup.createPopupView`; Nazeka and Plain export `{schema: 2, slug, contentMode,
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

- Render calls receive structured lookup results and the current request context.
  Never scrape Default DOM. Core owns cancellation, navigation and action engines.
- Term rendering supplies arrays of `{button,result}` audio bindings and
  `{actions,feedback,result}` mining bindings through `onResultsRendered`, with
  a `lookupStats` slot (or `null` when the theme omits counts). Core paints counts
  and binds current-request actions.
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

## Content and stylesheet ownership

Default alone loads `render/reader.css` and scoped dictionary CSS. Nazeka loads
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
node --test test/theme-renderer.test.mjs
node test/chrome-theme-store.mjs
```

The browser check saves real popup, kanji and Store screenshots under
`test/tmp/theme-store`. See the benchmark report for repeatable performance
measurements and limitations. The full Nazeka extension's lookup engine is not
part of that comparison.
