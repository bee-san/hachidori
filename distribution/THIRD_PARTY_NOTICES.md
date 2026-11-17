# Third-party software

Hachidori is distributed under GPL-3.0-or-later; the full license is in
`LICENSE`. The release package carries the following upstream notices under
`licenses/`. `SOURCE.json` identifies its matching source archive and SHA-256.
The archive includes all tracked Hachidori sources, recursive Hoshidicts
submodules and the pinned source distributions listed below.

| Component | Packaged notice | Use |
| --- | --- | --- |
| GameSentenceMiner, Hoshi Reader, Yomitan and Yomichan adaptations | `reader-and-language-NOTICE` and original file headers | Popup rendering, styles and Japanese language handling |
| Hoshidicts | `hoshidicts-LICENSE` | GPL dictionary engine |
| Glaze | `glaze-LICENSE` | JSON parsing |
| Zstandard | `zstd-LICENSE`, `zstd-COPYING` | Compressed dictionary indexes; upstream dual BSD/GPL notices |
| unordered_dense | `unordered_dense-LICENSE` | Hash containers |
| libdeflate | `libdeflate-COPYING` | Dictionary ZIP decompression |
| utf8proc | `utf8proc-LICENSE.md` | Text normalization, including its Unicode data notice |
| UTF8-CPP | `utfcpp-LICENSE` | UTF-8 handling |
| xxHash | `xxHash-LICENSE` | Dictionary hashing |
| kanji-processor | `kanji-processor-LICENSE` | Kanji-variant source data |
| zip.js 2.11.2 | `zipjs/LICENSE` and `vendor/zip-LICENSE` | Backup ZIP processing |
| Mediabunny 1.65.2 | `mediabunny/LICENSE` | Native AV1 and Opus encoding and media containers; MPL-2.0 |
| gifenc 1.0.3, Matt DesLauriers | `gifenc/LICENSE.md` and `vendor/gifenc-LICENSE` | Experimental Netflix mining's looping GIF encoder, under the MIT licence |
| lamejs 1.2.7 (`@breezystack/lamejs`), Alex Zhukov's port of LAME | `lamejs/LICENSE` and `vendor/lamejs-LICENSE` | Netflix and YouTube mining's MP3 encoder for sentence audio, under the LGPL-3.0 |
| KANJIDIC2, Electronic Dictionary Research and Development Group | `kanjidic-NOTICE` and `vendor/kanjidic/source.json` | Kanji readings that split headword furigana, under CC BY-SA 4.0 |
| jitendex-data kanwa, Stephen Kraus (Jitendex) | `kanwa-NOTICE` and `vendor/kanwa/source.json` | Character and compound readings that split headword furigana where KANJIDIC2's cannot, under CC BY-SA 4.0 |
| CodeMirror 6 (`@codemirror/*`, `@lezer/*`, style-mod, w3c-keyname, crelt, find-cluster-break), Marijn Haverbeke and others | `vendor/codemirror/LICENSE` | The code editor of Advanced → User scripts, under the MIT licence |
| Subadub, Russel Simmons, at [`a03b1b94`](https://github.com/rsimmons/subadub/tree/a03b1b94e59328c11e31485c6016626fcfeb2790) | `subadub-LICENSE` and the header of `netflix-page.js` | Experimental Netflix mining's subtitle-profile and track-list hooks, under the MIT licence |
| Emscripten | `emscripten-LICENSE` | Generated JavaScript runtime, including its Node.js-derived path code |
| musl | `musl-COPYRIGHT` | C runtime, including its upstream attribution list |
| LLVM runtime libraries | `libcxx-LICENSE`, `libcxxabi-LICENSE`, `compiler-rt-LICENSE`, `libunwind-LICENSE` | C++ and compiler runtime notices |

The Emscripten and runtime notices are copied from Emscripten
[4.0.15, commit 09f52557f0d48b65b8c724853ed8f4e8bf80e669](https://github.com/emscripten-core/emscripten/tree/09f52557f0d48b65b8c724853ed8f4e8bf80e669):
`LICENSE`, `system/lib/libc/musl/COPYRIGHT`, and
`system/lib/{libcxx,libcxxabi,compiler-rt,libunwind}/LICENSE.TXT` respectively.
Trailing whitespace is normalized. This identifies the notice sources; the historical committed Wasm binaries
did not record an exact Emscripten compiler version.

The zip.js source archive URL and checksum are recorded in
`scripts/store-sources.json` in the matching source archive. The zip.js
`dist/zip-core-external.min.js` file is byte-checked against the shipped
`vendor/zip.js` when packaging. The gifenc source is recorded the same way, and
its `dist/gifenc.esm.js` is byte-checked against the shipped `vendor/gifenc.js`.
So is the lamejs npm package, whose `dist/lamejs.js` is byte-checked against
the shipped `vendor/lamejs.js`; that package holds only the built file, so the
source of the commit it was published from is recorded beside it as
`lamejs-source`.

`vendor/codemirror/codemirror.js` is CodeMirror bundled by
`scripts/codemirror/build.mjs` from the npm releases that
`scripts/codemirror/package-lock.json` pins; CI rebuilds it and checks that
the shipped file is unchanged ([source-build.md](../docs/source-build.md#codemirror)).

User-selected dictionaries, media, and external audio services are separate
from this distribution. Their licenses and terms are supplied by their owners.
