# Chrome Web Store artwork

These PNGs are ready for the listing's image upload fields. The screenshots
show the actual extension in Chrome, at their native dimensions, with no
composited interface or resized documentation screenshots.

| File | Size | Content |
| --- | --- | --- |
| [lookup-1280x800.png](lookup-1280x800.png) | 1280 × 800 | Real hover lookup of 食べる on an original reading page. |
| [welcome-1280x800.png](welcome-1280x800.png) | 1280 × 800 | The first-run disclosure before Start setup. |
| [promo-440x280.png](promo-440x280.png) | 440 × 280 | Small promotional tile using Hachidori's existing logo and plain HTML/CSS. |

Use the lookup image first and the welcome image second. The extension's
[128-pixel icon](../../extension/icons/hachidori-128.png) is also available for
the dashboard's store-icon field.

## Reproduce

Install the external Chrome/Puppeteer prerequisites described in
[the test guide](../../test/README.md), then run from the repository root:

```sh
node scripts/capture-store-assets.mjs
```

`HACHIDORI_CHROME` or `CHROME_BIN` selects the browser; the default is
`/usr/bin/chromium`. `HACHIDORI_PUPPETEER` selects the Puppeteer module, otherwise
the script uses the existing `~/.cache/hachidori-e2e` installation (or its
`XDG_CACHE_HOME` equivalent). Regenerate from the release candidate if the
visible interface changes.

The script creates a temporary browser profile, captures the untouched welcome
screen, chooses manual setup, and saves three original entries through the
personal-dictionary editor. That save uses the production ZIP builder and
WebAssembly importer. It then hovers 食べる on
[reading-sample.html](reading-sample.html) and verifies that the real popup
contains the expected definition before capturing it. The popup uses the
ordinary Light theme, 320-pixel height and 100% background opacity, saved through
the worker's options-write handler. No popup markup or display data is injected.

HTTP(S) requests other than the script's sample-page server are blocked on page,
service-worker and offscreen-document targets. The flow never opens Anki
settings, plays audio or starts capture, and the browser profile is removed on
exit. [capture.json](capture.json) records the browser version, dimensions,
dictionary source, appearance choices and attempted blocked requests. The
checked-in capture used **Chrome 150.0.7871.186** and made **zero** such requests.

The short Japanese story, English definitions and example sentences were
written for these assets; they contain no private user dictionaries, study
history or third-party media. [promo.html](promo.html) is the promotional tile's
editable source and references the existing project icon. These asset sources
and outputs use the repository's GPL-3.0-or-later license. The artwork does not
claim endorsement or approval by Google.
