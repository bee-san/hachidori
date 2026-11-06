# Anki mining requests

For the default **This note type** duplicate scope, with `{expression}` in the
first field and without **Overwrite**, normal readiness sends one
`canAddNotesWithErrorDetail` request. All popup entries share that request. Only
the first field and any authored cloze fields are rendered; an expression-only
check does not wake the dictionary engine or offscreen renderer. A known
positive in the word index can still offer View without contacting Anki.

Normal Add sends one `addNote`, with native `picture` and `audio` attachments
for media-only fields. AnkiConnect stores the media and appends the returned
filenames. There is no second duplicate check, field readback, or pronunciation
update. Anki's native duplicate guard still rejects a duplicate created after
readiness. View discovers and repairs exact note IDs when clicked.

| Case | Readiness requests | Add requests |
| --- | ---: | ---: |
| Text | 1 | 1 |
| Text and screenshot | 1 | 1 |
| Text, screenshot and pronunciation | 1 | 1 |
| Dictionary images or media embedded in custom HTML | 1 | 2 |

These counts exclude initial metadata discovery, which is one `multi`
request, and apply to successful normal requests on current AnkiConnect.
Metadata stays cached for the worker and unchanged configuration. Configuration
changes, a failed check/write, or a worker restart trigger fresh discovery.
Externally changed note fields are not continuously polled. Older AnkiConnect
versions without detailed duplicate checks use the existing fallback calls.

Embedded media keeps its exact position in formatted fields by uploading it
in one checked `multi` before Add. Required dictionary-image failures stop
the add. For native optional attachments, AnkiConnect itself keeps the text
note if storage fails and writes the escaped error message into the media
field; its successful `addNote` reply does not provide a separate media warning.

Capture, audio retrieval and full card rendering still precede Add. This is a
single complete-note request, not a text-first background enrichment job.
Broader duplicate scopes, Overwrite and custom first-field identities retain
the indexed checks and verified enrichment needed for their policies. Lost
write acknowledgements remain uncertain and are never retried automatically.

## Reproduce request counts

```sh
node benchmark/anki-mining-requests.mjs --runs 20 --delay-ms 25
```

The benchmark uses the production gateway, duplicate index and worker with an
isolated fake AnkiConnect. Each of the three cases has two warmups and 20
measured samples, a fresh index per sample, and metadata discovery excluded.
The JSON records every sample, counts, median, p95, revision and environment.
The injected 25 ms per request measures accumulated transport delays; it is
not a real Anki, capture, rendering or audio-download benchmark.

To compare an earlier checkout, copy `test/anki-request-fixture.mjs` and
`test/anki-connect-fake.mjs` from this revision into its `test/` directory and
pass `--source /path/to/earlier-checkout` to the same driver. Keep both reports
with the PR and compare under the same runtime and injected delay.
