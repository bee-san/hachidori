<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Anki marker-path regression check for Handlebars fields

The existing production mining request benchmark compared `8f2ddb18` with
`a39a635b`, under Node 22.23.1 on Linux x64, Intel(R) Core(TM) Ultra 7 165U. Each case
uses a fresh duplicate index, two excluded warmups and 20 measured samples with
25 ms injected per fake-AnkiConnect request. Metadata discovery is excluded.

```sh
node benchmark/anki-mining-requests.mjs --source /tmp/hachidori-681-handlebars-before --runs 20 --delay-ms 25
node benchmark/anki-mining-requests.mjs --runs 20 --delay-ms 25
```

Times are milliseconds, with readiness and Add measured separately:

| Mapping | Before ready median | Before ready p95 | Before Add median | Before Add p95 | After ready median | After ready p95 | After Add median | After Add p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Text | 26.43 | 33.57 | 29.09 | 49.93 | 26.56 | 26.87 | 29.14 | 30.48 |
| Text + screenshot | 26.35 | 26.55 | 28.56 | 31.81 | 26.40 | 26.78 | 28.84 | 33.06 |
| Text + pronunciation + screenshot | 26.40 | 26.69 | 28.96 | 29.33 | 26.35 | 26.94 | 28.83 | 31.02 |

Every sample retained one readiness request and one Add request. These small
local differences do not establish a speed change. The benchmark checks the
unchanged ordinary marker path: one new word, model duplicate scope, no
dictionary images. It does not measure Handlebars compilation, browser capture,
real network latency, audio downloads, or rendering twenty dictionary entries.
The browser acceptance harness separately proves the production sandbox and
rich glossary renderer, without making a latency claim.

[Raw samples and environment](../assets/handlebars-mining-timings.json).
