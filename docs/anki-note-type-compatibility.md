<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Anki note-type compatibility

Hachidori maps existing Anki note types; it does not install Kiku, Lapis or
Senren. The production implementation is
[`anki-templates.js`](../extension/anki-templates.js), used by Settings and the
read-only first-run setup detector.

## Reviewed packages

The schema contract was reviewed on September 15, 2026 against these published
packages:

- Kiku 2.1.0 (`youyoumu/kiku`, asset `Kiku_v2.1.0.apkg`): 24 Kiku fields plus
  an unrelated Basic model.
- Lapis 1.7.0 (`donkuri/lapis`, asset `Lapis.apkg`): 22 fields.
- Senren 5.1.0 (`BrenoAqua/Senren`, asset `Senren.v5.1.0.apkg`): 22 fields.

[`contracts.json`](../test/data/anki-note-types/contracts.json) records the
reviewed releases, SHA-256 digests, exact model names, field order, production
values, overwrite modes through the checker, and intentional blanks.
[`upstream-snapshot.json`](../test/data/anki-note-types/upstream-snapshot.json)
retains only extracted schemas and provenance. It contains no decks, notes,
templates, fonts or media. Crop Theft is not a Hachidori preset and is outside
this contract.

## Hachidori-specific mappings

Kiku and Lapis are separate presets. Kiku maps `SentenceFurigana` to
`{sentence-furigana-plain}`; Lapis intentionally leaves it blank. Senren keeps
the publisher's `group` wrapper around furigana and its nested `group` /
`highlight` sentence wrappers.

Hachidori intentionally differs from a plain publisher mapping in three places:

- Kiku and Lapis `Picture`, and Senren `picture`, use `{screenshot}` so the
  existing static or captured-media path can attach the page image.
- `MainDefinition` / `definition` use `{main-definition}`, Hachidori's current
  projected primary definition.
- Senren `pitchAccents` uses the canonical `{pitch}` marker; the accepted
  `pitch-accents` spelling is an alias of the same renderer value.

Unsupported card flags, translations, hints, notes and other package fields are
explicitly blank. `SentenceAudio` / `sentenceAudio` also stay blank in saved
presets; request-local capture routing may fill captured audio without changing
the saved template. Existing customized mappings are never migrated. Corrected
defaults apply only when a preset is newly selected or automatically configured.

## Checks

The offline Node contract sends the exact extracted field names and order
through production `applyAnkiPreset`. It requires:

- exactly one reviewed model;
- the exact field set and order, including intentional blanks;
- the first identifying field to map to `{expression}`;
- every value and `coalesce` overwrite mode to match;
- every marker to exist in Hachidori's production marker inventory; and
- the family-specific core to qualify for read-only automatic setup.

Negative controls reject added, removed, renamed, duplicated and reordered
fields; wrong models and first fields; incorrect values, markers, overwrite
modes and blanks; failed downloads; and missing or ambiguous model results.

The Python reader is adapted from Manabitan's GPL-3.0-or-later
`dev/anki-note-type-upstream.py` at commit
`81b149f44426dbfa8bca6af57f3bef9a3af02620`. It bounds downloaded, archived and
Zstandard-expanded data; prefers a real modern collection over Anki's dummy
legacy database; supports legacy `col.models` and modern
`notetypes` / `fields`; opens SQLite read-only; and fails closed for corrupt,
duplicate, ambiguous or unsupported packages. Authentication is sent only to
GitHub's API host and removed from cross-host redirects.

Run the checks locally:

```sh
node --test test/anki-note-type-compatibility.test.mjs \
  test/anki-templates.test.mjs test/anki-setup.test.mjs

python -m pip install zstandard==0.25.0
python -m unittest discover -s test -p 'anki_note_type_upstream_test.py' -v

python scripts/anki-note-type-upstream.py --mode pinned --output /tmp/anki-pinned.json
node scripts/anki-note-type-compatibility.mjs /tmp/anki-pinned.json

python scripts/anki-note-type-upstream.py --mode latest --output /tmp/anki-latest.json
node scripts/anki-note-type-compatibility.mjs /tmp/anki-latest.json
```

The dedicated workflow runs for relevant pull-request changes, manual
dispatches, and Mondays at 09:23 UTC. Pinned and latest stable releases run
separately. Only the JSON schema/provenance report is retained for 30 days.

## Updating a reviewed release

When a latest-release check fails:

1. Read the publisher's release notes, field instructions and template changes.
2. Inspect the extracted report without importing it into a personal Anki
   collection.
3. Review every field addition, removal, rename, order change and intentional
   blank.
4. Update the production preset, contract, snapshot, version and checksum
   together.
5. Run both pinned and latest checks plus the normal Hachidori test suites.

Do not generate expected mappings from production or accept unknown fields just
to make CI green.

## Boundary

These checks prove schema and mapping compatibility only. An APKG can change
card templates or runtime behavior without changing field names. Passing does
not prove card rendering, media playback, duplicate handling, AnkiConnect
availability or browser/device integration. Those still require human review
and a representative test note.
