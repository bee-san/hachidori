# Asset ownership and publishing record

This record identifies the artwork supplied by Hachidori's repository owner,
**bee-san**, for the extension, documentation and Chrome Web Store materials.
The source files below were supplied on **September 8, 2026**.

## Visual novel backgrounds

**Copyright © 2026 bee-san.** The owner explicitly stated “i own the copyright”
and directed Hachidori to use the image made at 6:29am, with that ownership
recorded for Chrome publishing. This is the owner's declaration and
authorization to include the artwork in Hachidori and its publishing materials.

- Original filename: `ChatGPT Image Sep 8, 2026, 06_29_20 AM.png`.
- Selected image time: **September 8, 2026, 06:29:20am**, Europe/London.
- Repository file: [`extension/assets/preview-background.webp`](../extension/assets/preview-background.webp).
- Supplied format and dimensions: PNG, **1672 × 941**, **2,154,041 bytes**.
- Supplied SHA-256: `84c3fd0ff5803596a5991b52a8ce2f3d2da5083393197112425f5f340bdca361`.
- Usage: first-run practice and the Design preview, plus screenshots of those
  surfaces in documentation and store materials.

The supplied artwork bakes its own illustrated dialogue panel into the bottom of
the frame; Hachidori never shows that panel, and places selectable Japanese text
over the live scene above it. This replaces the earlier GSM preview background in
the packaged extension.

The owner subsequently supplied the five additional scenes below and requested
their use alongside the original in first-run practice and the Design preview,
with a random starting scene and an arrow to cycle through them. This extends
the record to those owner-supplied files and their authorized use in Hachidori
and its publishing screenshots. Every supplied image is a **1672 × 941 PNG**.

| Repository file | Original filename | Supplied bytes |
| --- | --- | ---: |
| [`preview-background-2.webp`](../extension/assets/preview-background-2.webp) | `ChatGPT Image Sep 8, 2026, 07_16_27 AM.png` | 2,306,454 |
| [`preview-background-3.webp`](../extension/assets/preview-background-3.webp) | `ChatGPT Image Sep 8, 2026, 07_16_31 AM.png` | 2,172,556 |
| [`preview-background-4.webp`](../extension/assets/preview-background-4.webp) | `ChatGPT Image Sep 8, 2026, 07_16_38 AM.png` | 2,508,746 |
| [`preview-background-5.webp`](../extension/assets/preview-background-5.webp) | `ChatGPT Image Sep 8, 2026, 07_16_43 AM.png` | 2,306,899 |
| [`preview-background-6.webp`](../extension/assets/preview-background-6.webp) | `ChatGPT Image Sep 8, 2026, 07_18_10 AM.png` | 2,314,792 |

SHA-256 checksums of the supplied PNG files:

```text
ac8c161853b335b7c28f5e3d68cf7bb11862072974dae805642af6258e6a608e  preview-background-2.png
95f23c4cd334a93f3c560dccf40ef7b40c7ea3d1188af5eb97a371b951e3d97f  preview-background-3.png
579182b5dd57fa306ab569238f8812ee5b7b214a1042fb1836596d9528c793ec  preview-background-4.png
35b57369c49ec315ac1c9b0d4aa9c732e86ab928f40ac68a1097f6dd8af6f692  preview-background-5.png
6556de21bdd8fc3f8faced963b8936be85aaa443fdf296e746b259c3c233ea14  preview-background-6.png
```

## Packaged form of the backgrounds

The extension only ever displays the top **1672 × 672** of each frame, so that
crop is what Hachidori packages, encoded as WebP at quality 82: 970,930 bytes for
all six, where the PNGs cost 13,413,193.

The supplied files stay retrievable from this repository's history at commit
`b41c6a2`. The PNGs the WebP files replace were those same images after ImgBot's
lossless re-compression in `c0a96aa` and `23f138c`, which is why their bytes and
checksums differ from the supplied ones recorded above while every pixel matches.

| Packaged file | Bytes |
| --- | ---: |
| `preview-background.webp` | 147,244 |
| `preview-background-2.webp` | 153,232 |
| `preview-background-3.webp` | 145,796 |
| `preview-background-4.webp` | 191,904 |
| `preview-background-5.webp` | 178,482 |
| `preview-background-6.webp` | 154,272 |

```text
976b9f69104c66cbde4bc11e554ba3a1c9d1688493593621bba121d64d0066ba  preview-background.webp
d787d3b3a0025e025eeb31b5158b28787465293176cce41456adbdc5ab2f24f8  preview-background-2.webp
52c66542fca697f226607cc4419c6ea333cb959663a327a3c1d73643f08eb449  preview-background-3.webp
0f996a30dd3ae0657d14d4021e4a3f028cfd57875b37cc16b19baf97f2690527  preview-background-4.webp
894588bd6b898c983d4d60abcaa2b08862a53df081d8f4ba2c0f898a08556f49  preview-background-5.webp
2b715d36fb5ad2be6810ffaf322a8700083e8a8173702bffb9ba477c350caf17  preview-background-6.webp
```

## Hachidori logo pack

The owner supplied `hachidori-logo-pack.zip` and requested its use for the README
and other Hachidori branding. Archive SHA-256:
`b34398f7eb27eb136247445b20a48d69606366c0f8e1f929280f670519228e21`.

The following files are copied unchanged from that pack:

| Project asset | Purpose |
| --- | --- |
| [`docs/assets/hachidori.png`](assets/hachidori.png) | Transparent 1024 × 1024 hummingbird mark in the README |
| [`docs/assets/hachidori-icon.svg`](assets/hachidori-icon.svg) | Original vector mark |
| [`docs/assets/hachidori-logo.svg`](assets/hachidori-logo.svg) | Stacked logo with outlined lettering |
| [`docs/assets/hachidori-wordmark.svg`](assets/hachidori-wordmark.svg) | Horizontal logo with outlined lettering |
| [`docs/assets/hachidori-app-icon.svg`](assets/hachidori-app-icon.svg) | App icon source |
| [`extension/icons/hachidori-16.png`](../extension/icons/hachidori-16.png), [`32`](../extension/icons/hachidori-32.png), [`48`](../extension/icons/hachidori-48.png), [`128`](../extension/icons/hachidori-128.png) | Supplied icon sizes used by Chrome and the Settings/startup headers |

The SVG lettering is outlined and needs no external font. The pack's README
describes these variants; it contains no separate license terms. This record
documents the owner's instruction to use the supplied branding for Hachidori.

## Publishing reference

Use this record and the linked repository assets when identifying the artwork
included in Hachidori's Chrome Web Store package, screenshots and branding.
The packaged backgrounds also carry a short
[ownership notice](../extension/assets/ATTRIBUTION.md).

Hachidori's software license remains [GPL-3.0-or-later](../LICENSE). Attribution
for the imported dictionary renderer and other upstream code is maintained
separately in [renderer attribution](../extension/render/ATTRIBUTION.md).
