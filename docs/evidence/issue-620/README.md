# Evidence for #620: words that only frequency or pitch dictionaries have

Not part of the extension. These files back the numbers in the pull request.

## Screenshots

`popup-off.png` and `popup-on.png` are the real-Chrome suite's popup for 東京タワー with
Reading → Results → **Show words that only frequency or pitch dictionaries have** off and on.
The fixture dictionaries are 東京 in a term dictionary, plus 東京タワー only in a rank-based
frequency dictionary (5000) and a pitch dictionary ([5]). `settings.png` is the Settings control.
They come from `test/chrome-e2e/metadata.mjs` with
`HACHIDORI_METADATA_ONLY_SCREENSHOTS=<dir>`.

## Renderers

`renderers.json` is the output of audit-hachi-fix-620-b's real-Chrome probe (its `audit-themes-e2e-b.patch` applied to
`test/chrome-e2e/metadata.mjs` locally, not committed), run on #628's head after the second round of fixes. For every bundled
renderer, with the option off and on, it hovers ぴえんぱおん (a frequency row only), selects it exactly and hovers 東京タワー,
recording the visible text, pencils and page highlight. With the option on, Default and Nazeka show the frequency-only word;
Crystal, JL, Bee's Theme and Plain give the option-off results in all three cases. `crystal-on-select.png` is Crystal's
exact selection with the option on: the no-definition notice and the pencil.

## Default installation

The inputs are the five recommended dictionaries as published on 2026-10-31, downloaded from
`extension/recommended-dictionaries.js`'s `downloadUrl`s, and 吾輩は猫である from Aozora Bunko
(`https://www.aozora.gr.jp/cards/000148/files/789_ruby_5639.zip`). `inputs.sha256` lists their
hashes. `run.sh <hoshidicts#44 checkout> <hoshidicts main checkout>` builds four programs against
each checkout's `build/` and runs them:

- `measure.cpp` imports the dictionaries and looks up every distinct Jiten expression, off and on.
- `measure_text.cpp` makes one 16-character hover per character of the novel's first 40,000
  characters, off and on.
- `dump.cpp` writes every field of every result of the 494,979 inputs from `inputs.py`: the novel
  hovers, the 703 windows of `test/segmentation-reference.mjs` (`windows.mjs`) and the Jiten
  expressions. It runs once for main and twice for the branch, off and on.

`measure.log` is the whole run's output (`run.sh` also writes `text.log`, the novel hovers alone), and `dump.sha256` holds the three dumps' hashes. The repository ignores `*.log`, so these were added with `git add -f`. Main `3c7fffa`, Hachidori's current gitlink
`20019e4` and the branch with the option off give the same dump (`cfef815d…`). With the option on,
18,211 lists change, and in each of them the results with glossaries are the off list's prefix,
cut only by `maxResults` (32).

The toolchain was GCC 14.3 (conda-forge), CMake 3.31.6 and Node 22.23.1. `run.sh` sources
`env.sh`, which only puts these on `PATH` and sets `CXX` and `CC`; edit its paths for another host.
The downloaded archives go in `dicts/` and the novel's ZIP beside the scripts as `neko.zip`.

## Native lookups

`bench-native.sh <#44 checkout> <hoshidicts main checkout>` runs hoshidicts' `benchmark-lookup` (each checkout configured
with `-DHOSHIDICTS_BENCHMARK=ON`) over the 40,000 novel hovers, 2 iterations each, in six rotated rounds: main, #44 with
the option off, and #44 with `--metadata-only-terms`. `bench-native.log` holds every round's total. Medians: main
13,339 ms, off 13,406 ms (+0.5%), on 13,800 ms (+3.5%).

## WASM lookups

`bench-wasm.sh` runs `bench-wasm.mjs` in six rotated rounds, with main's and this branch's
`extension/vendor/hoshidicts-threaded.{mjs,wasm}` in `../wasm-main` and `../wasm-branch`. Each run copies the natively imported
dictionaries into MEMFS, loads them into main's committed `hoshidicts-threaded.wasm` or this
branch's, and times `hdw_lookup` over the 40,000 novel hovers twice: main, the branch with
`metadataOnlyTerms: false`, and the branch with `true`. `bench-wasm.log` is the output. Warm-pass medians: main 34,497 ms, off 34,446 ms, on 34,887 ms (+1.1%). Main's and
the branch-off replies are the same length to the character. These are
targeted engine timings on a shared 64-core host, not end-to-end popup latency.
