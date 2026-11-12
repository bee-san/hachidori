<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Deleted Anki note repair: request costs

Compared base `8f2ddb18` with `863a2e63` under Node v22.23.1,
linux/x64, Intel(R) Core(TM) Ultra 7 165U. Both runs use the production gateway, worker and
persistent duplicate cache against a disposable in-memory AnkiConnect. Every
case has two excluded warmups and 20 measured samples, with 25 ms injected per
request. Neither run contacts a real Anki collection.

```sh
node benchmark/anki-deleted-notes.mjs --source /tmp/hachidori-681-handlebars-before --runs 20 --delay-ms 25
node benchmark/anki-deleted-notes.mjs --runs 20 --delay-ms 25
```

The target input is one live note whose first field is `word:{expression}`,
with no directly mapped expression field. Discovery and the preceding Add are
excluded. View took 26.24 ms median / 27.24 ms
p95 before, and 51.82 ms median / 52.68 ms p95
after. Before, it sent only `guiBrowse`; after, it sends `findNotes` for the
exact supplied IDs and opens only surviving IDs. The extra transport round trip
is intentional: it lets View reset to Add after a deletion instead of repeatedly
opening an empty browser. If every ID was deleted, the repair sends only the
live query and never opens Anki's browser.

The existing ordinary mining benchmark was also compared under the same runtime,
20-sample setup and delay:

```sh
node benchmark/anki-mining-requests.mjs --source /tmp/hachidori-681-handlebars-before --runs 20 --delay-ms 25
node benchmark/anki-mining-requests.mjs --runs 20 --delay-ms 25
```

| Mapping | Before ready median ms | Before Add median ms | After ready median ms | After Add median ms |
| --- | ---: | ---: | ---: | ---: |
| Text | 26.43 | 29.09 | 26.77 | 29.00 |
| Text + screenshot | 26.35 | 28.56 | 26.31 | 28.56 |
| Text + pronunciation + screenshot | 26.40 | 28.96 | 26.38 | 28.65 |

Every ordinary sample retained one readiness request and one Add request.
These noisy local differences do not establish a speed change. These are
transport-plus-production-JavaScript timings, not real Anki latency or browser
rendering/capture/audio timings. The benchmark exercises a live custom-identity
View; the four focused lifecycle contracts exercise deleted-note recovery and
AnkiConnect's actual `{}` placeholder shape.

[Raw samples and environment](../assets/deleted-anki-note-timings.json).
