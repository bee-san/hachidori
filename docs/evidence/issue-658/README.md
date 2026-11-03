# Evidence for #658

Readings that only frequency or pitch dictionaries have, for words a dictionary
defines (bee-san/hachidori#658, bee-san/hoshidicts#80). Not part of the
extension; kept on the branch `evidence/issue-658-metadata-only-readings` for
the pull request.

## Screenshots

`name-off.png`, `name-on.png` and `settings.png` come from the real-Chrome
suite's step "words only frequency and pitch dictionaries have"
(`test/chrome-e2e/metadata.mjs`) with
`HACHIDORI_METADATA_ONLY_SCREENSHOTS` set, in the full `node test/run.mjs
chrome-e2e` run (`suite-chrome-e2e.log`).

## Dictionaries and inputs

The five recommended dictionaries as published on 2026-10-31, downloaded and
imported natively by #628's audit (Jitendex 2026-10-03, JMnedict 2026-10-31,
Bee's Ultimate Kanji Dictionary, Jiten 26-10-29, Bee's Ultimate Grammar
Dictionary). `inputs.sha256` pins the inputs: `all-inputs.txt` (494,276 lines:
every Jiten expression and the hovers below), `neko-32.txt` (one 32-code-point
window per character of the first 40,000 characters of 吾輩は猫である, 39,997
distinct) and `neko-16.txt` (their first 16 code points).

## Programs

- `env.sh`: the toolchain (Node 22.23.1, CMake 3.31.6, GCC 14.3) and paths.
- `build-native.sh`, `build-native-main.sh`: hoshidicts Release builds with
  tests and the benchmark (the second as hoshidicts CI configures main).
- `probe.cpp`, `build-probe.sh`: lookups through the native engine.
  `probe show` prints results off and on (`repro-base.log` for `35e2dab`,
  `repro-fix.log` for `a95758b`: 田中 and 東京タワー); `probe dump` writes every
  field of every result.
- `run-dumps.sh`: option off over `all-inputs.txt` for both revisions (sha256
  in `dumps.sha256`, identical), option on over `neko-32.txt` for both.
- `check.py`, `extras.py`: properties of the option-on dumps (`check-neko.log`,
  `extras-neko.log`).
- `pairs.py`, `names.py`: Jiten's (expression, reading) pairs against the term
  dictionaries (`pairs.log`, `names.log`).
- `mutate.py`: the four mutations of `src/lookup.cpp` (`mutations.log`).
- `bench-native.sh`, `bench-summary.py`: hoshidicts `benchmark-lookup`
  (`bench-native.log`, `bench-native-summary.log`).
- `bench-wasm.mjs` (#620's harness), `bench-wasm.sh`: `hdw_lookup` through
  main's committed threaded bundle and this branch's (`bench-wasm.log`,
  `bench-wasm-summary.log`).
- `build-wasm.sh`: `wasm/build.sh` with 8 jobs. `wasm-main-sources.sha256`:
  the gitlink at `35e2dab`, equal to main's committed bundles;
  `wasm-fix-1.sha256`, `wasm-fix.sha256`: two builds of `a95758b`;
  `wasm-build.log`: the second.
- `e2e-step.sh`: only the real-Chrome metadata step. `e2e-step-fix.log` passes;
  `e2e-step-main-wasm.log` fails with main's committed bundles.

## Logs

- hoshidicts: `lookup-order-before-fix.log` (the new cases fail on `35e2dab`),
  `ctest-fix-35e2dab.log` (19/19), `ctest-merge.log` (51/51 on `a76884b`),
  `parity-old-oracle.log` and `parity-old-engine.log` (`ja-lookup-parity`
  fails with only one side changed).
- Hachidori: `suite-lint.log`, `suite-node.log`, `suite-smoke.log`,
  `suite-chrome-e2e.log`, `e2e-first-frame-{1,2,3}.log` (the one failed
  timing check, alone), `suite-firefox-lint.log`, `firefox-lint-main.log`,
  `suite-firefox-e2e.log`, `node-smoke-main-wasm.log` and `node-smoke-fix.log`.
