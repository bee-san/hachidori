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
| libavif 1.3.0 | `libavif/LICENSE` | AVIF encoder; complete upstream notice includes dav1d-derived code and its bundled libyuv subset |
| libaom 3.12.1 | `libaom/LICENSE`, `libaom/PATENTS` | AV1 encoding and upstream patent license |
| libaom's bundled libyuv, fastfeat and vector | `libaom/third_party/{libyuv,fastfeat,vector}/LICENSE` | Encoder dependencies |
| zip.js 2.11.2 | `zipjs/LICENSE` and `vendor/zip-LICENSE` | Backup ZIP processing |
| Emscripten | `emscripten-LICENSE` | Generated JavaScript runtime, including its Node.js-derived path code |
| musl | `musl-COPYRIGHT` | C runtime, including its upstream attribution list |
| LLVM runtime libraries | `libcxx-LICENSE`, `libcxxabi-LICENSE`, `compiler-rt-LICENSE`, `libunwind-LICENSE` | C++ and compiler runtime notices |

The Emscripten and runtime notices are copied from Emscripten
[4.0.15, commit 09f52557f0d48b65b8c724853ed8f4e8bf80e669](https://github.com/emscripten-core/emscripten/tree/09f52557f0d48b65b8c724853ed8f4e8bf80e669):
`LICENSE`, `system/lib/libc/musl/COPYRIGHT`, and
`system/lib/{libcxx,libcxxabi,compiler-rt,libunwind}/LICENSE.TXT` respectively.
Trailing whitespace is normalized. This identifies the notice sources; the historical committed Wasm binaries
did not record an exact Emscripten compiler version.

The AVIF and zip.js source archive URLs and checksums are recorded in
`scripts/store-sources.json` in the matching source archive. The zip.js
`dist/zip-core-external.min.js` file is byte-checked against the shipped
`vendor/zip.js` when packaging.

User-selected dictionaries, media, and external audio services are separate
from this distribution. Their licenses and terms are supplied by their owners.
