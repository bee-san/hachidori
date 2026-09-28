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
saved dimensions.

## Version 2 view contract

`theme-host.js` chooses a bundled renderer before content construction. Default
adapts `HDPopup.createPopupView`; Nazeka exports `{schema: 2, slug, contentMode,
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
  a hidden `lookupStats` slot. Core paints counts and binds current-request actions.
- `updateDictionaryPresentation` edits dictionary labels without rebuilding
  definitions. Blur updates edit state only. A new lookup replaces content;
  Back carries scroll state. Default retains its existing incremental renderer.
- Switching retires action bindings, destroys the previous view and replaces its
  content/styles, then replays the latest model and view settings. Obsolete request
  contexts are not replayed. A throwing Nazeka renderer is disabled for that page
  and the current model is rendered with Default's CSS. The saved choice remains.
- `destroy` releases listeners/observers and owned DOM; core closes audio menus
  and retires mining state. Removed node listeners become collectible.

## Content and stylesheet ownership

Default alone loads `render/reader.css` and scoped dictionary CSS. Nazeka loads
its own CSS plus shared icon controls. Custom CSS remains last. Nazeka's
`glossaryToPlainText` traverses dictionary data without building rich DOM,
requesting images, or creating dictionary links. Rich content remains untrusted.
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
