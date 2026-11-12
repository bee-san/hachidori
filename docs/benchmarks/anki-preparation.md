<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Ordinary mining with Anki preparation available

The ordinary production mining path keeps one readiness request and one Add
request when its Template has no preparation script. The comparison below
covers text alone, a screenshot, and screenshot plus pronunciation.

- Before: `8f2ddb184b019f21814f39145a4d2afbe05ba5e8`.
- After: `4f6cf94d604a09776745d5a71b45d35dd066ecba`.
- Node 22.23.1, Linux x64, Intel Core Ultra 7 165U.
- Three alternating before/after runs; each case has two warmups and twenty
  measured samples. Each sample starts with a new duplicate index and one
  synthetic new word in the configured note-type scope.
- The harness injects 25 ms per AnkiConnect request. Metadata discovery is
  excluded. It uses the production gateway, duplicate index and mining worker,
  with an isolated fake endpoint.

Each cell gives the three runs' medians in milliseconds:

| Case | Readiness before | Readiness after | Add before | Add after |
| --- | --- | --- | --- | --- |
| Text | 26.389 / 26.462 / 26.424 | 26.512 / 26.328 / 26.543 | 28.574 / 28.749 / 29.168 | 29.186 / 28.319 / 29.119 |
| Screenshot | 26.307 / 26.438 / 26.414 | 26.495 / 26.421 / 26.402 | 28.403 / 28.779 / 29.056 | 29.002 / 28.756 / 29.199 |
| Screenshot and pronunciation | 26.337 / 26.401 / 26.272 | 26.197 / 26.268 / 26.217 | 28.595 / 28.906 / 28.528 | 28.199 / 28.318 / 28.319 |

Every measured sample in both revisions used exactly one readiness and one Add
request. The small timing differences do not show a consistent regression;
these results make no speedup claim. Raw samples, p95 values and environment
metadata are in [the retained reports](../assets/anki-preparation-mining.json).

Run the current driver against each checkout, alternating the two commands
three times:

```sh
node benchmark/anki-mining-requests.mjs --source /path/to/before --runs 20 --delay-ms 25
node benchmark/anki-mining-requests.mjs --source /path/to/after --runs 20 --delay-ms 25
```

These timings exclude browser startup, real dictionary rendering, screenshot
capture, audio retrieval, and user-script or external-service latency. Other
browser validation was running on the same host, so sub-millisecond differences
have limited meaning. Script readiness/registration and API effects are checked
separately by `test/chrome-anki-preparation.mjs`: opening lookups makes no
preparation request, and only explicit Add invokes the service.
