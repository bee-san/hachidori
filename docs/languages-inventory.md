<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Appendix: language inventory

Phase 0 of the multi-language design ([languages.md](languages.md)). Seven
readers went through the code at `main` b1964358 (hoshidicts 35e2dab) and
recorded every setting, popup feature and theme hook with the language
assumption it makes, citing file and line. This appendix condenses those
notes: every option key is listed individually; other items are grouped
where they share one assumption and one outcome. Line numbers are at
b1964358.

Column **Outcome** says where the item ends up in the design: its scope
(G global, P profile, L language-scoped, K package), the capability it
requires, or the pack field that replaces a hard-coded Japanese value.

## A. Option keys (`extension/reader-options.js` `DEFAULT_OPTIONS`)

| Key (default) | Settings control | Language assumption | Outcome |
| --- | --- | --- | --- |
| `scanLength` (16) | Reading → Scanning → Scan length | Code points scanned from the cursor: the CJK model | P; for `spaces` packs the scan starts at the word start (8.3) |
| `maxResults` (32) | Reading → Results | None | P |
| `hoverEnabled` (true) | Reading → Enable lookups; toolbar "Japanese lookups"; Alt+Delete | Labels name Japanese | G; label names the language (7.4) |
| `onlyScanJapaneseText` (true) | Reading → "Japanese text only" `#opt-japanese-only` | `JAPANESE_CHARACTER_PATTERN` (content-scan.js:22) | P; predicate = pack `text.pattern`; label per language |
| `personalDictionaryEnabled` (true) | Dictionaries → Personal dictionary | Personal package is Japanese by invariant | P; personal dictionary per language (15) |
| `showNoResultNotice` (true) | Dictionaries → Personal dictionary | None | P |
| `lookupMode` (activationSticky) | Reading → Activation | None | G |
| `activationKey` (Shift) | Reading → Activation | None | G |
| `definitionLookupMode` (inherit) | Reading → Activation | None | G |
| `scanDelayMs` (0) | Reading → Activation | Hint "hover over Japanese text" | G; hint names the language |
| `definitionScanDelayMs` (null) | Reading → Activation | None | G |
| `popupHideDelayMs` (160) | Reading → Activation | None | G |
| `hidePopupOnCursorExit` (false) | Reading → Activation | None | G |
| `hidePopupOnCursorExitDelayMs` (160) | Reading → Activation | None | G |
| `showMetadataOnlyResults` (false) | Reading → Results | Frequency/pitch-only terms; text themes turn it off (`DEFINITION_ONLY_RENDERERS`, content.js) | P |
| `popupNestingMaxDepth` (10) | Reading → Child popups | None | G |
| `popupTheme` (default) | Design → Theme Store | Themes hard-code Japanese typography | P |
| `popupThemeVariant` (auto) | Design → Colours | None | P |
| `popupToolbarPosition` (auto) | Design | None | G (geometry) |
| `customPopupCss` ("") | Design → Custom CSS | None | G; can target `[data-hd-language]` |
| `customPopupJavascript` ("") | Design → Custom JavaScript | None | G |
| `customLinks` ([]) | derived from `customButtons` | `%w`, `%r` word and reading | P (derived) |
| `customButtons` ([]) | Design → Custom buttons; placeholder "Search Jisho" | Link targets are language sites | P |
| `audioSources` (speech: reading) | Audio | `text-to-speech-reading`; speech is `ja-JP` (speech.js:30-35) | P; pack default source and speech language (13) |
| `audioAutoplay` (false) | Audio | None | P |
| `anki` (url, apiKey, templates) | Anki | Template fields include reading/pitch; presets are Japanese note types | url, apiKey G; templates P (12) |
| `smallerAnkiCards` (false) | Anki | Help mentions furigana | G |
| `experimental` (flags) | Advanced → Experimental | Netflix flag text says Japanese subtitles | G; Netflix uses pack `bcp47` (8.5) |
| `popupWidthPx` (560) | Design | None | G (geometry) |
| `popupHeightPx` (420) | Design | None | G |
| `popupScalePercent` (100) | Design | None | G |
| `popupOpacityPercent` (85) | Design (theme-declared) | None | P |
| `sourceHighlightEnabled` (true) | Design | None | G |
| `showPopupAudioButton` (true) | Audio | None | P |
| `popupColumns` (1) | Design (Default) | None | P |
| `glossaryLayoutMode` (default) | Design | `" \| "` separator neutral | P |
| `showLookupCounts` (true) | Reading → Lookup history | Counts keyed by `[term, reading]` | P; counts per language (15) |
| `definitionBlurCountEnabled` (false) | Reading → Definition blur | None | P |
| `definitionBlurAnkiMature` (false) | Reading → Definition blur | First Template's deck | P |
| `definitionBlurFrequencyEnabled` (false) | Reading → Definition blur | None | P |
| `definitionBlurFrequencyDictionary` ("") | Reading → Definition blur | Title reference | P; pruned per profile |
| `definitionBlurFrequencyOrder` (auto) | Reading → Definition blur | `frequencyModeOrder` assumes ranks for undeclared lists (Japanese corpora) | P |
| `definitionBlurFrequencyThreshold` (10000) | Reading → Definition blur | Rank-list tuned | P |
| `definitionBlurDirection` (atLeast) | Reading → Definition blur | None | P |
| `definitionBlurThreshold` (5) | Reading → Definition blur | None | P |
| `definitionBlurReveal` (timed) | Reading → Definition blur | None | P |
| `definitionBlurDelayMs` (5000) | Reading → Definition blur | None | P |
| `wordHighlightEnabled` (false) | Reading → Word highlighting | Japanese segmentation (`hdw_segment`, 103 function words); hint "Mark the Japanese words" | P; requires `wordHighlighting`, neutral false |
| `wordHighlightUnknown` (true) | Reading → Word highlighting | None | P |
| `wordHighlightLearning` (true) | Reading → Word highlighting | None | P |
| `wordHighlightKnown` (false) | Reading → Word highlighting | None | P |
| `wordHighlightIgnored` (false) | Reading → Word highlighting | None | P |
| `wordHighlightStyle` (underline) | Reading → Word highlighting | None | P |
| `showCompactDefinitionSummary` (false) | Design (Default) | Sanseido/Jitendex heuristics; letter class is Latin/kana/Han only (popup.js:163-164) | P; letter class extended with the pack's script |
| `compactDefinitionSummaryCount` (3) | Design | None | P |
| `compactDefinitionSummaryDictionary` ("") | Design | Title reference; first install picks Jitendex | P |
| `popupImageSource` (null) | Design | Title or group reference | P |
| `imageHoverPreview` (large) | Design | None | P |
| `averageFrequency` (false) | Design | None | P |
| `showFrequencyTagsWithAverage` (false) | Design | None | P |
| `showFrequencyDictionaryNames` (false) | Design | None | P |
| `compactFrequencyNumbers` (false) | Design | English k/m/b, ASCII digits | P |
| `showPitchAccentFurigana` (true) | Design → Show pitch on the reading | Japanese mora pitch | P; requires `pitchAccent`, neutral false |
| `pitchAccentFuriganaDictionary` ("") | Design → Pitch accent dictionary | Title reference | P; requires `pitchAccent`, neutral "" |
| `pitchAccentFuriganaStyle` (contour) | Design → Reading pitch style | Mora contour/overline | P; requires `pitchAccent`, inert |
| `showPitchAccentBadge` (true) | Design | Pitch groups | P; requires `pitchAccent`, neutral false |
| `showPitchAccentDictionaryNames` (true) | Design | Pitch groups (IPA rows always name their dictionary) | P; requires `pitchAccent`, neutral false |
| `showPitchAccentText` (true) | Design | Downstep text over kana | P; requires `pitchAccent`, neutral false |
| `showPitchAccentPosition` (true) | Design | Downstep number | P; requires `pitchAccent`, neutral false |
| `showPitchAccentGraph` (false) | Design | Mora graph | P; requires `pitchAccent`, neutral false |
| `showPitchAccentColors` (false) | Design | jp-mining-note pitch colours | P; requires `pitchAccent`, neutral false |
| `hidePopupGrammarTags` (true) | Design → Show grammar tags | Tag vocabulary of the dictionaries | P |
| `kanjiClickDictionary` ("") | Design → Clicked-kanji dictionary | Han characters open the kanji view | P; requires `characterView`, neutral ""; label from pack |
| `frequencyDictionary` ("") | Reading → Frequency | Title reference | P; pruned per profile |
| `frequencyOrder` (auto) | Reading → Frequency | Direction inference samples Japanese words (frequency-direction.js) | P; samples from pack `host.frequencySamples` |
| `automaticBackupDays` (2) | Backup | None | G |
| `useLessRamByDefault` (false) | Advanced → Memory | None | G |
| `lowMemoryMode` (false) | Advanced → Memory | None | G |
| `dictionaryEntryStorage` (auto) | Advanced → Memory | None | G |
| `dictionaryIndexStorage` (auto) | Advanced → Memory | None | G |
| `showToolbarSearchButton` (true) | Reading → Search page | None | G |
| `keybinds` (Yomitan defaults) | Keybinds | Toggle option may name gated keys | G; gated keys not offered (7.3) |
| new `activeProfileId`, `profileAutoSwitch`, `profiles` | Languages section, toolbar | — | G structure (4.1) |

Retired keys (`modifier`, `definitionBlurEnabled`, `hoverDelayMs`,
`experimental.smallerAnkiCards`) keep their migrations and are read from the
top level of a single-profile record.

## B. Storage keys, messages, backups, sharing

| Item | Where | Language assumption | Outcome |
| --- | --- | --- | --- |
| `options` record, one `revision` | background-core.js:46, 310-327 | One flat record | Gains profiles; flat projection (4.1, 5) |
| `dictionaryState` schema 1: one ordered array, `enabled` per row, `groups` | background-core.js:44, 253-279 | One order, one enabled set | Schema 2 with per-profile lists and groups (4.2) |
| Package `language` from `index.json` `sourceLanguage` | engine-service.js:976 | The only language datum; used by frequency direction and the custom-dictionary check | K; import hint (14) |
| Package `pitchCount` includes IPA rows | engine-service.js:980 | Pitch and IPA counted together | Unchanged; IPA shown in every language |
| Package `kanjiCount`, library badge "Kanji" | engine-service.js:981, library-settings.js:562-566 | Character bank named kanji | Badge label from pack `characterView.name` |
| `id = stableDictionaryId(title)`, unique titles | engine-service.js:967; backup-state.js:42-49 | One title namespace | Kept global (decision 0001) |
| `customDictionarySource`, fixed id/title, `language === "ja"` check | custom-dictionary.js:10-21, 308-317 | Personal dictionary is Japanese | L; one per language (15) |
| `lookupStats` rows `[term, reading]`, NFC | lookup-stats.js:5-33; lookup-stats-identity.js | No language key | L; non-Japanese rows add the code (4.3) |
| `wordStatusOverrides` known/ignored headwords | word-status-overrides.js:17 | No language key | L (4.3) |
| `ankiDuplicateIndex` keyed by first Template | anki-index-cache.js:4 | One Template list | One snapshot per source key (12) |
| `setupState`, `recommendedDictionarySelections` | setup-state.js:6-8 | Japanese catalogue ids | G; non-Japanese first run records no catalogue outcome (16) |
| `automaticBackups`, `sharing`, `sharingLocalState`, `sharingOptionsVersion`, session `backupDownloads`, IndexedDB debug log | backup-automatic.js, background-sharing.js, debug-log.js | None except redaction | G |
| `OVERLAY_LOCAL_OPTION_KEYS` (includes `onlyScanJapaneseText`) | setup-state.js:46-51 | Partition precedent | Applied over the active profile's projection (17.4) |
| `hd_options_write`, `hd_state_cas`, `hd_apply_state`, `hd_custom_*`, `hd_lookup_stats_*`, `hd_word_status_override` | background-requests.js | No profile dimension | Optional `profileId` (5.2) |
| `hd_lookup`, `hd_lookup_dictionary`, `hd_segment`, `hd_kanji` | content.js termPayload; engine-service.js | Japanese pipeline | Optional `profileId` → language and dictionaries (9.3) |
| Backup archive version 3, six snapshot keys | backup-archive.js:7; docs/backup-format.md | No profiles | Version 3 unchanged for single-profile installs; version 4 with profiles (17.1) |
| Sharing `SHARED_STATE_KEYS`, `hello` capabilities, protocol 1 | background-sharing.js:33-56; sharing-protocol.js | One profile | Capability `language-profiles-v1`; projection for older clients (17.3) |
| Debug-log redaction `[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}]+ → [ja]` | debug-log.js:44, 84; settings.html:1475 | Only Japanese redacted | Adds non-Latin packs' patterns (8.5) |
| Debug info `navigator.languages` | debug-info.js:94-140 | Browser language, not study language | Adds profiles and pack ids |

## C. Default popup renderer (`extension/render/`)

| Item | Where | Language assumption | Outcome |
| --- | --- | --- | --- |
| Headword, kanji glyph and pitch text `lang="ja"` | popup.js:3319, 4031; glossary.js:566 | Every headword is Japanese | `lang` from pack (10.1) |
| `languageFromText`: kana/Han → `ja`, bopomofo → `zh` | glossary.js:1007-1018 | Han is Japanese | Han-only text takes `zh` in a Chinese profile |
| No `lang`/`dir` on the popup; physical CSS (list padding, masonry, toolbar push, resize handle) | reader.css; popup.js | Left to right | Per-element `dir` for RTL packs; popup stays LTR (decision 0004) |
| Font stacks Japanese first (popup, Note inputs, audio menu, VN scene) | reader.css | Japanese glyphs | `--hd-language-font-family` with today's stacks as fallback |
| `overflow-wrap: anywhere`, no `word-break` | reader.css | CJK line breaking | `--hd-language-word-break`, `--hd-language-line-break` |
| `appendExpressionRuby`, `distributeFurigana`, `segmentFurigana`, `termFurigana`, `matchedFurigana`, `toHiragana`, `KANA_PATTERN` | glossary.js:217-888, 927 | Kana-anchored furigana | `ruby.alignment: kana` only; other modes for other packs (10.2) |
| Non-CJK readings drawn as ruby (IPA or transliteration over Latin/Arabic) | glossary.js:757-790 | Reading is kana | Readings without ruby shown as a reading line |
| KANJIDIC furigana split (`kanjiFurigana`, `kanji-readings.json`) | glossary.js; engine-service.js:345-373 | Japanese kanji readings | Only with `ruby.alignment: kana` (9.4) |
| Han click targets `HAN_CHARACTER_PATTERN` → `onKanjiClick` | glossary.js:51-52, 939-942 | Han is kanji | Pack `characterView.pattern` |
| Pitch: `splitPitchAccentMorae`, `isMoraPitchHigh`, `pitchAccentCategory` (kana endings, `v1 v5 vk vs vz adj-i`), `createPronunciationText` (dakuten), graphs, colours, `data-pitch-category` | glossary.js:222-353, 566 | Japanese mora pitch | `pitchAccent` capability; options masked (7.3) |
| IPA row from `pitches[].transcriptions` | popup.js:3060-3143 | None | Every language |
| Frequency tags, `㋕` kana marker, `formatFrequencyValue`, averages `/^\d+/` | popup.js:472-675 | Jiten marker; ASCII digits | Unchanged; harmless elsewhere |
| Grammar tags, definition tags with Yomitan categories | popup.js; glossary.js | Tag vocabulary | Unchanged |
| Character view `renderKanji`, `kanjiEntryGlossary` ("On", "Kun", "Meanings", "Details") | popup.js:1605-1636, 4031 | Japanese reading classes | Labels from pack `characterView.readingLabels` |
| Clicked-kanji Back/Forward | popup.js; content.js | Kanji only | Character view in any pack that has one |
| Deinflection disclosure; labels keyed on browser locale (en, ja, uk) | popup.js `buildDeinflectionDisclosure` | Trace names are Japanese rule names | Trace names come from the pack; locale strings unchanged |
| Compact summary: Sanseido `語義/語釈/ルビG`, Jitendex heuristics, `COMPACT_DEFINITION_LETTER`, `COMPACT_DEFINITION_JAPANESE` | popup.js:163-164 | Latin/kana/Han letters only | Letter class gains the profile's script; heuristics stay |
| Structured content, dictionary CSS, images, masonry, tabs, Show more, notices, lookup counts, blur reveal, source highlight, placement | popup.js; glossary.js | Tab arrow keys and placement assume LTR | Unchanged (popup stays LTR) |
| Note form: Term, Reading, Definition all `required` | popup.js:2290-2380 | Every word has a reading | Reading required/optional/hidden by `readings` (10.2) |
| Design preview sample (食べる, ひなた, 朝ごはんを食べる。, KANJIDIC sample) | design-preview.js:103-268 | Japanese sample | Pack `host.sample` |
| Visual-novel scene and practice passage `lang="ja"`, `line-break: strict` | visual-novel.css; startup-practice.js:63-69 | Japanese | Pack `host.sample.practice` |
| `createPopupAppearance` host attributes (`data-hoshidicts-pitch-colors`, …) | popup.js:85-157 | Pitch colours Japanese | Adds `data-hd-language`, `data-hd-direction` |

## D. Theme contract and vendored themes

| Item | Where | Language assumption | Outcome |
| --- | --- | --- | --- |
| Module `{schema: 2, slug, contentMode, createView}`; host checks and fallback to Default on throw | theme-host.js:32-70 | No language field | Unchanged; catalogue gains `language` (11.3) |
| `createView` options (document, popup, callbacks, `appendExpressionRuby`, `createPronunciationPitchAccent`, `onKanjiClick`, …) | content.js:1882-1941 | Japanese callbacks | Adds `options.language` (11.1) |
| Components: `kanjiEntryResult`, `buildPitchAccentMorae`, `pitchAccentPositions`, `glossaryToPlainText`, `createFrequencyTags`, `createLookupActions`, `deinflectionSteps`, … | theme-host.js:90-98 | Pitch, kanji and text mode are Japanese | Adds `components.language` (11.2) |
| Render context (blur, presentation, tabs, metadata options) | content.js `renderContextFor` | No language | Adds `context.language` (11.1) |
| `glossaryToPlainText`: `[reading]` furigana brackets, `•`/`1.` markers, ASCII pill spacing | glossary.js:1967-2049 | Japanese typography | Unchanged for Japanese; pills spaced for any script in other packs |
| `designSettings` declarations, `data-design-setting` tags, `applyDesignSettings` | index.json; settings.html; settings.js | Theme filter only | Theme filter ∧ capability (11.5) |
| Plain: `text-align: left`, `sans-serif` | plain/theme.css | LTR | `text-align: start`; declares both directions |
| Nazeka: `/\p{Script=Han}/u` links, `《》` readings, `aria-label "${expression}, ${reading}"`, `～` trail, Noto JP font, `float: right` | nazeka/theme.js:73-84; theme.css | Japanese | Pack pattern and labels (11.6) |
| JL and Bee: `HAN = /\p{Script=Han}/u`, JMdict `WORD_CLASS` brackets, `～` trail with `→`, mora pitch marker, `On:`/`Kun:` with `、`, Meiryo, `text-spacing-trim` | jl/theme.js:7, 89-108; theme.css:100-117 | Japanese | Pack pattern and labels; `text-align: start` |
| Crystal (Grey, Beige, Retro blue): `HAN`, `CIRCLED` senses, font warm-up `"食べる たべる Aa"`, `:lang(ja)` mincho, `～` trail, mora marker, `On`/`Kun`, small-caps letter-spacing, asymmetric plaque art | crystal/theme.js:7, 121-145; theme.css:123-141 | Japanese; letter-spacing breaks Arabic joins | Pack pattern and labels; plaque spacing dropped for RTL profiles |
| Icons (speaker, open, edit) not mirrored; Theme Store carousel `scrollLeft` | icons.css; theme-store.js | LTR interface | Unchanged: the interface stays LTR |
| Tests: `theme-renderer.test.mjs`, `popup-theme.test.mjs`, `autumn-theme.test.mjs`, `chrome-theme-store.mjs`, `chrome-theme-contrast.mjs` | test/ | Japanese fixtures only; contrast suite skips renderer themes | Unchanged; new `theme-languages.test.mjs`, `chrome-languages.mjs` (11.7) |

## E. Anki, audio, custom buttons

| Item | Where | Language assumption | Outcome |
| --- | --- | --- | --- |
| `{expression}`, `{dictionary}`, `{glossary*}`, `{single-glossary-*}`, `{tags}`, `{search-query}`, `{popup-selection-text}`, `{document-title}`, `{url}`, `{sentence}`, `{cloze-*}`, `{frequencies}`, frequency aggregates, `{audio}`, `{screenshot}`, `{sentence-audio}`, `{gif}` | anki-templates.js:5-84; anki-values.js:204-332 | None (UTF-16 offsets) | Every language |
| `{reading}` | anki-values.js:234 | Kana reading | Hidden from the list without readings; empty value as today |
| `{furigana}`, `{furigana-plain}`, `{sentence-furigana}`, `{sentence-furigana-plain}` | anki-values.js:34-61, 218-227; anki-worker.js:79-93 | Kana-anchored ruby | Require `ruby` (12) |
| `{character}`, `{onyomi}`, `{kunyomi}`, `{stroke-count}` | anki-values.js:207-238 | Kanji entries | Require `characterView` |
| `{pitch}` (also prints IPA), `{pitch-position}`, `{pitch-accent-categories}`, `{pitch-accent-graphs}`, `{pitch-accent-graphs-jj}` | anki-values.js:87-106; anki-pitch.js | Japanese pitch | Require `pitchAccent`; `{phonetic-transcriptions}` covers IPA everywhere |
| `{conjugation}` (trace names joined ` « `) | anki-values.js:247 | Japanese rule names | Pack trace names |
| `{part-of-speech}` (`v1` → "Ichidan verb", …) | anki-values.js:27-28 | Japanese POS | Pack `anki.partOfSpeechLabels` |
| `text-align: left` on glossary and frequency HTML | anki-glossary.js:185; anki-compact.js:200; anki-values.js:76 | LTR cards | `dir="auto"` added only for RTL packs |
| Kiku, Lapis, Senren presets; `ANKI_SETUP_FAMILIES`; `all`-scope recognition; Netflix sentence-audio field | anki-templates.js:116-148; anki-setup.js:13-23; anki-index.js:57-80; anki-mining.js:11-31 | Japanese note types | Pack `anki.noteTypeFamilies` (only Japanese lists them) |
| Field-name suggestions (`Kana`, `Pitch Accent`, …) | anki-templates.js:107-113 | Japanese field names | Plus pack `anki.fieldAliases` |
| Duplicate key `ankiWordKey` (expression, ASCII case fold), word status, maturity | anki-index.js:13-33; anki-index-cache.js:366-390 | None; first Template only | First Template of the profile in effect |
| Audio URL `{language}` = `"ja"` | audio-sources.js:17-26 | Japanese | Pack `host.audioLanguage` |
| Speech `utterance.lang = "ja-JP"`, ja voice filter, Google ja preference, "Automatic Japanese", "No Japanese speech voice" | speech.js:23-47; audio-repository.js:80-93 | Japanese voices | Pack `host.ttsLanguage`; Japanese unchanged |
| Test term `聞く/きく`; local audio probe `猫/ねこ`; Local Audio Server `127.0.0.1:5050` | audio-offscreen.js:6-10; local-audio-setup.js:88; local-audio-source.js | Japanese provider | Pack sample; Local Audio Server for Japanese only |
| Relay API `profileIndex === 0` | api-host.js:333-339 | One profile | Active profile (12) |
| Custom link `%w %r %s` | external-links.js `expandCustomLinkUrl` | Reading | Unchanged; buttons per profile |

## F. Scanning, sentences, search, highlighting, personal dictionary, Netflix

| Item | Where | Language assumption | Outcome |
| --- | --- | --- | --- |
| `JAPANESE_CHARACTER_PATTERN`, `isJapaneseToken`, token boundary | content-scan.js:22-24 | Japanese gate | Pack `text.pattern` (8.2) |
| `collectScanEntries` caret-forward walk, `scanWindow`, 256 cap, long-key slack | content-scan.js | No word starts | Word-start seek for `spaces` packs (8.3) |
| `dropCjkSegmentBreaks`, `sentenceSource` segment breaks → spaces | content-scan.js | CJK line joining | Pack `lineJoiner` decides |
| `rt`/`rp` opaque | content-scan.js `OPAQUE_TAGS` | Ruby | Unchanged |
| Text-field and Google Docs imposters | content-scan.js; google-docs.js | Docs imposter has no direction | Docs gains direction; field clipping is a known limit |
| `SENTENCE_SCAN_EXTENT = 200`, `TERMINATORS`, `PAIRS` | sentence.js:14-23 | Japanese and ASCII punctuation | Pack `text.sentence` |
| Word highlighting: `isJapanese`, `textBlocks`, `SENTENCE_END`, `CLAUSE_END`, `readingCandidates` (kana surface borrows status), function words | word-highlights.js:39-40; content.js | Japanese segmentation | `wordHighlighting` capability; pack tables (8.5) |
| Search page: `lang="ja"`, leading punctuation and `～` skipped, no kana conversion | search.html; search.js | Japanese query | Profile `lang`/`dir`; punctuation rule kept |
| Selection lookups, exact match | content.js | None | Unchanged |
| Child popups over definitions | content-scan.js `resolveDefinitionCandidate` | Gloss text read as the profile language | Parent's profile; automatic switching may pick the gloss language (8.1) |
| Lookup counts first result `term.expression/reading` | content.js `acceptLookupStatistics` | Reading in identity | Language-scoped rows (15) |
| Note prefill `{term, reading, definition, sentence}`; CSV `term, reading, definition`; placeholder `蜂, はち, bee` | content.js; custom-dictionary.js; settings.html:438 | Reading required | Reading optional by pack; placeholder from pack sample |
| Netflix `japanese(track)`, lines joined with `""`, invisible marks stripped, "no Japanese subtitle track" | netflix-page.js:113; netflix-subtitles.js | Japanese subtitles | Pack `bcp47` and `lineJoiner` |
| Practice passage and probe | startup-practice.js; startup.js:710-740 | Japanese | Pack `sample.practice` |
| Grammar dictionary: Bee's Ultimate Grammar Dictionary (catalogue source), its `～ている` pointer entries, its own chevron styles | recommended-dictionaries.js; search.js leading `～`; dictionary `styles.css` | Japanese grammar points | Japanese catalogue unchanged; the search page's `～` skip stays for every language (it is punctuation elsewhere) |
| Yomitan scanner features absent here: word scan resolution, per-language preprocessors, text replacements, configurable sentence terminators, romaji input | yomitan text-scanner.js, translator.js | — | Word resolution and pack preprocessors adopted; the rest not ported |

## G. Engine and data path

| Item | Where | Language assumption | Outcome |
| --- | --- | --- | --- |
| `Deinflector` with compiled rules, 18-flag `Conditions`, `pos_to_conditions`, whole-word honorifics, irregular tables | hoshidicts src/deinflector.cpp | Japanese only | Data-driven; Japanese pack (engine contract 7, 11) |
| NekoPara cat speech (`deinflect_neko_speech`, `LookupOptions::neko_speech`) | deinflector.cpp; lookup.cpp | Japanese; not exposed by Hachidori | Japanese variant pass; still not exposed |
| `text_processor::process` with eight Japanese processors and the kanji-variant table | text_processor.cpp:341-460 | Japanese | Pack processors; Japanese as builtins |
| Prefix scan from `scan_length` down to 1 code point | lookup.cpp:231-236 | CJK | Word resolution for `spaces` packs |
| Long-key scan index | scan_index.hpp | None | Every language |
| POS filter on the term's `rules` | lookup.cpp:486-499 | Japanese POS | Pack conditions |
| Ranking: primary reading, matched length, steps, trace length, written form, frequency, dictionary rank, score, written = reading | lookup.cpp:378-438 | Reading and kana terms | Unchanged; rank from the request's dictionaries |
| Importer writes reading = expression when empty; keeps `sourceLanguage`, `targetLanguage`; skips dictionary-form redirects | importer.cpp:447, 470, 642-651 | None | Unchanged |
| `hdw_*` exports; `WireOptions`; `hdw_segment` with 103 Japanese function words; `hdw_kanji` | wasm/bindings.cpp | No language parameter | `language`, `dictionaries`, `languageOptions`; pack function words (engine contract 10.4) |
| `WARM_LOOKUP_TEXT = "食べました"` | engine-service.js:1605 | Japanese | Pack `sample.warmup` (9.2) |
| `withFurigana`, `withoutPersonalDictionary`, tag expansion | engine-service.js:333-373 | Japanese furigana | Furigana only with kana ruby (9.4) |
| Loaded set = enabled packages; incremental reorder/add/remove | engine-service.js:1388-1598 | One library | Union of profiles; per-request lists (9.2) |
| `inferFrequencyDirection` returns null unless `language` is ja | frequency-direction.js:26 | Japanese samples | Pack `frequencySamples` |
| API host `tokenize` (GameSentenceMiner) | api-host.js | Greedy CJK tokenisation | Active profile; word resolution for `spaces` packs |
| hoshidicts CI: one deinflector job on the Japanese TSV | .github/workflows/deinflector.yml | Japanese | Conformance test per pack (engine contract 12) |

## H. Onboarding and user-visible strings that name Japanese

| Item | Where | Outcome |
| --- | --- | --- |
| Five Japanese catalogue sources; `FIRST_INSTALL_SELECTIONS` (Jitendex summary, Bee's Kanji) | recommended-dictionaries.js:9-96; setup-state.js:81-95 | Unchanged for Japanese; links for other packs (14) |
| Startup tagline "Blazing fast, feature rich Japanese dictionary by Bee", practice copy "Hover over Japanese text…" | startup.html:25; startup-practice.js:16-50 | Tagline unchanged; practice copy names the language |
| Settings empty library "Your Japanese library starts here", glyph `辞` | library-settings.js:669; settings.html:186 | Names the language |
| Toolbar `aria-label="Japanese lookups"`, hint "Hover over Japanese text to scan" | toolbar.html:14; toolbar.js:37 | Unchanged with one Japanese profile; names the language otherwise (16) |
| Manifest description "Study Japanese vocabulary…", command "Turn Japanese lookups on or off" | manifest.json:6, 33 | Unchanged (pinned by tests; owner decision) |
| Activation, highlighting and personal-dictionary hints that say "Japanese text" | settings.html | Name the language |
| Store listing copy | docs/chrome-web-store.md:230-235 | Unchanged |

## I. Tests that pin Japanese behaviour

Every suite uses the Japanese fixture `hachidori-fixture.zip` and hovers
`食べたかった` and `漢字`; Latin text appears only as a negative control
(`hello world` must show no popup). Fixed-denominator browser plans
(`chrome-e2e` 375 checks, `firefox-e2e`) fail if a planned check does not run.
Specific pins: `extension-smoke/content-scanning.mjs` (Japanese gate),
`yomitan-parity.test.mjs` (`lang="ja"` tagging, furigana, pitch markup),
`furigana.test.mjs`, `pitch-badges.test.mjs`, `anki-values.test.mjs`,
`anki-pitch.test.mjs`, `audio-player.test.mjs` (`ja-JP` voices),
`audio-sources.test.mjs` (`{language}` → `ja`), `frequency-direction.test.mjs`,
`keybind-settings.test.mjs` and `chrome-e2e/session.mjs` (command text),
`browser-commands.test.mjs` (every popup-action command is a keybind action),
`settings-labels.test.mjs`, `debug-log.test.mjs`, `netflix-subtitles.test.mjs`,
`custom-dictionary.test.mjs`, `lookup-stats.test.mjs`,
`chrome-backup-release.mjs` and the 0.1.1/0.3.0 backups, hoshidicts'
`deinflector_test.cpp` on Yomitan's 1,446-case corpus. The design keeps all of
them unchanged (languages.md 6.2, 18) and adds new suites beside them.
