# Lookup counts

Settings → Reading → Lookup history controls recording and display. It is on by
default. Turning it off keeps existing history but stops new increments. The
Design preview uses a fixed sample count and never records a lookup.

A successful new reader request records its primary result's canonical term and
reading, not the inflected search text. Readings remain distinct. Misses and
obsolete replies do not count. Internal links and clicked-kanji term entries
are independent visits; native kanji entries are not term lookups. Tabs,
expansion, Back, and Note refresh reuse the original visit. A lost statistics
reply is never retried as an increment.

The All tab shows the primary result's count. A dictionary/group projection may
display another expression, so it does not borrow that count. Definitions do
not wait for storage: counts arrive independently, guarded by the current
request and committed statistics namespace. Statistics changes do not reload
dictionaries or invalidate lookup results.

![Local lookup history controls](assets/lookup-statistics-settings.png)

Lookup history belongs to Hachidori and stays in this browser. Recording and
reading a count never contacts another application or service. Old external
corpus connection settings are ignored; restoring an older backup discards those
retired fields while preserving its other preferences and lookup history.

The service worker serializes updates. Each lookup reads a descriptor and one
term/reading row, then writes that row and the advanced descriptor together;
it does not scan or rewrite the collection. Terms and readings are trimmed and
NFC-normalized, with JSON-pair keys preserving delimiter identity. Counts and
timestamps survive worker/browser restart and participate in [complete backup
and restore](backup-format.md). There is no product entry cap; browser storage
and safe JSON integer representation still apply.

## Definition blur

Settings → Reading → Definition blur hides definitions, compact summaries and
reading furigana behind a blur until you recall the word. Both rules are off by
default and can be enabled independently; a match from either rule qualifies.
**Blur definitions by lookup count** needs lookup counts. Choose **At least**
to blur words looked up the threshold number of times (default 5) or more, or
**Below** to blur words looked up fewer times. Zero is a valid Below count. The decision uses the same count the popup displays, after
the current lookup is recorded.

**Blur definitions for mature Anki words** works even with lookup counts off.
It checks the first result's canonical expression against the configured Anki
note type across all decks. A word qualifies if at least one matching card is
in review with an interval of **21 days or more**, following
[Anki's card states](https://docs.ankiweb.net/getting-started.html#card-states).
New, learning and relearning cards do not qualify. The mining deck and duplicate
scope do not restrict this check; the reading and inflected search text do not
form part of the match.

In Settings → Anki, map **Expression** to a dedicated field, or use a field
template containing only `{expression}`. Templates that combine the expression
with other text, readings or markup cannot identify the word through this check.
A missing or unsupported mapping leaves maturity unavailable without changing
the mapping. The Design preview uses a fixed mature sample with three lookups,
without contacting Anki or recording history.

The check makes one read-only AnkiConnect `findCards` request after the result
renders. It does not add or edit notes, cards or scheduling data. The existing
AnkiConnect timeout bounds the wait; Anki being closed, denied access, malformed
responses and other errors leave this rule unqualified. There is no persistent
known-word cache: each new lookup checks again, and only the count rule remains
available offline. Dictionary lookup never waits for Anki.

![Lookup-count and mature-Anki definition blur controls](assets/anki-mature-blur-settings.png)

A new lookup renders blurred while an enabled rule is undecided. A qualifying
rule keeps the blur; when neither qualifies, including unavailable checks,
definitions reveal. Hovering a definition or the compact summary
reveals in either mode. With the timed reveal, one deadline runs from the
first display: navigating to a kanji entry or another word cancels the live
timer, and Back continues with the remaining time rather than restarting, as
does a page restored from the back/forward cache. The decision belongs to that
lookup, so tabs, Show more, a Note refresh and Back keep it; a later count for
the same word never blurs a revealed view, and a different lookup starts
fresh. A lookup made before the saved settings have loaded waits for them.
Native kanji entries are outside term blur; term entries reached through a
clicked kanji participate.

Automatic pronunciation waits until the definitions are revealed, so the audio
does not give the reading away while they are blurred. The first count snapshot
and Anki result decide the blur once for the whole visit. A result that does not
qualify reveals and plays at once; a blurred result plays once when hover, the
deadline or disabling blur reveals it. Pressing the Audio button while blurred
plays it then instead, and nothing replays at the reveal.

Turning both rules off reveals open popups without touching a Note draft.
Disabling lookup counts removes only the count rule. Changes to Anki settings
invalidate pending and completed maturity evidence, including a word retained
for Back; old replies cannot blur the current view.
Revealed definitions never become blurred again during the same lookup. Other
live edits apply to unrevealed popups from their original display time. With
Anki blur off, the original count behavior and lookup path are unchanged.
