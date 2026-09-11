# README artwork fitted for the Chrome Web Store

Upload the PNGs individually to the matching dashboard fields. All seven files
are **24-bit RGB PNGs without alpha**, at the exact sizes below.

| Upload field | File | Canvas |
| --- | --- | --- |
| Screenshot 1 | [01-japanese-lookup-1280x800.png](01-japanese-lookup-1280x800.png) | 1280 × 800 |
| Screenshot 2 | [02-dictionary-import-1280x800.png](02-dictionary-import-1280x800.png) | 1280 × 800 |
| Screenshot 3 | [03-word-lookup-1280x800.png](03-word-lookup-1280x800.png) | 1280 × 800 |
| Screenshot 4 | [04-custom-dictionary-1280x800.png](04-custom-dictionary-1280x800.png) | 1280 × 800 |
| Screenshot 5 | [05-lookup-blur-1280x800.png](05-lookup-blur-1280x800.png) | 1280 × 800 |
| Small promo tile | [small-promo-440x280.png](small-promo-440x280.png) | 440 × 280 |
| Marquee promo tile | [marquee-promo-1400x560.png](marquee-promo-1400x560.png) | 1400 × 560 |

The five screenshots reuse the README's setup/lookup, import benchmark, lookup
benchmark, custom-dictionary and lookup-blur artwork. GIFs are exported as
visually checked static frames: the custom entry is visible and the blur popup
is fully inside the recorded viewport. Images are resized proportionally with
matching edge-color padding; their content is neither cropped nor stretched.
The two promo tiles reuse the existing hummingbird logo with plain typography.

The original artwork and extension runtime are unchanged. These files are
outside `extension/` and are not part of the Chrome extension upload package.
The existing [native Chrome screenshots](../README.md) remain available too.
Benchmark claims are preserved from the supplied artwork, not newly measured
or independently verified by this conversion.

## Regenerate

From the repository root, with Python 3.10+ and DejaVu Sans installed:

```sh
python3 -m pip install Pillow==11.3.0
python3 scripts/fit-store-readme-assets.py
python3 scripts/fit-store-readme-assets.py --check-only
```

Generation downloads the two image attachments linked in the README. All other
sources are already in the repository. No browser, dictionary import, Anki
instance or image-generation service is required. Fonts are read from the
system and are not copied into this folder.

[manifest.json](manifest.json) records source URLs/paths, source checksums,
selected GIF frames, output sizes and output checksums. `--check-only` verifies
the seven files, dimensions, PNG bit depth/color type, lack of transparency and
checksums without accessing the network. Source artwork retains its existing
project attribution and licensing; see [asset rights](../../asset-rights.md).
