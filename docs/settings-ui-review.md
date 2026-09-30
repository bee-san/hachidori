# Settings UI review

Settings now treats Hachidori as a standalone reader. Lookup history stays in
this browser; the external Corpus Seen controls and request path are removed.
Old stored connection fields are ignored, and restore drops those two retired
fields from older backups while retaining other preferences and local counts.
Source attribution and the compatible text-receiver protocol remain intact.

Lookup history and definition blur live in **Reading**. **Design** concentrates
on appearance and definition presentation, with wider selectors, compact numeric
rows and a live preview that is always shown. Reset Design preserves the Reading rules.
Definition blur presents lookup count, mature Anki and frequency threshold as
independent conditions, with one shared reveal policy.
The selected lookup theme now colours the complete Settings document as well as
the lookup and preview.
Threshold/reveal details and custom CSS use native disclosures. Narrow windows
use a section picker that keeps keyboard focus and browser history; background
operation notices remain available beside it.

The navigation follow-up keeps all eleven mounted task sections while reducing
the primary navigation to seven destinations. **Library** now owns
**Dictionaries**, **Add**, **Updates**, **Groups**, and
**Personal dictionary** in a local navigation row; **Backup & restore** remains
global. The narrow picker groups the same five choices, and search results name
their hierarchy, such as **Library › Updates**. Existing hashes, drafts, and
Back/Forward behaviour are unchanged.

The empty Library offers recommended dictionaries and ZIP import directly.
Recommendations remain available after a local import or a partial installation,
and installation controls wait for the initial inventory. Readiness distinguishes
an empty or disabled library, while failed dictionary edits retain their error.
Options save feedback sits near each section heading; failures stay visible while
scrolling, with the existing retry and use-saved actions.

## Option audit (#401)

[#401](https://github.com/bee-san/hachidori/issues/401) audited every stored
key in `DEFAULT_OPTIONS` against its Settings control. Each concept now has one
control, and no two controls share a visible label
(`test/settings-labels.test.mjs`). *Keybind* is the Keybinds → Toggle option
label (booleans only, except `lowMemoryMode`). *Finding* records what #401
changed; "—" means the key was already unambiguous.

| Key | Section › group | Control | Visible label | Keybind | Finding |
| --- | --- | --- | --- | --- | --- |
| `scanLength` | Reading › Scanning | `#opt-scan-length` | Scan length | — | — |
| `maxResults` | Reading › Results | `#opt-max-results` | Maximum results | — | — |
| `hoverEnabled` | Reading › Activation | `#opt-hover-enabled` | Enable lookups | Enable lookups | — |
| `onlyScanJapaneseText` | Reading › Scanning | `#opt-japanese-only` | Japanese text only | Japanese text only | — |
| `personalDictionaryEnabled` | Library › Personal dictionary › Lookups | `#opt-personal-dictionary` | Use the personal dictionary | same | Moved from Reading; Reading › Activation links to it because it also makes highlighting open a popup |
| `showNoResultNotice` | Library › Personal dictionary › Lookups | `#opt-no-result-notice` | Show a popup when a selection has no definition | same | Moved with the switch it depends on |
| `lookupMode` | Reading › Activation | `#opt-activation-key` (No key = `hover`), `#opt-lookup-sticky` | Activation key or button; Keep the popup open after releasing the key or button | — | Three stored fields (`hoverEnabled`, `lookupMode`, `activationKey`) drive one visible concept; kept, since #349/#355 designed this mapping |
| `activationKey` | Reading › Activation | `#opt-activation-key` | Activation key or button | — | See `lookupMode` |
| `definitionLookupMode` | Reading › Activation | `#opt-definition-lookup-mode` | Child popups | — | — |
| ~~`hoverDelayMs`~~ | — | none | — | — | **Removed.** It always normalised to 0 and had no control. Older records and backups are accepted and drop it |
| `popupHideDelayMs` | Reading › Popup closing | `#opt-hide-delay` | Grace period to reach the popup | — | Was "Hide delay" under Scanning, away from the cursor-exit delay it resembles |
| `hidePopupOnCursorExit` | Reading › Popup closing | `#opt-hide-on-cursor-exit` | Hide popup on cursor exit | same | Group renamed from Cursor exit |
| `hidePopupOnCursorExitDelayMs` | Reading › Popup closing | `#opt-hide-on-cursor-exit-delay` | Delay after leaving the popup | — | Was "Delay" |
| `popupNestingMaxDepth` | Reading › Results | `#opt-popup-nesting-depth` | Maximum child popups | — | — |
| `popupTheme` | Design › Appearance / Theme Store | `#opt-popup-theme` | Theme | — | Not audited further: theme work is out of scope for #401 |
| `popupToolbarPosition` | Design › Appearance | `#opt-popup-toolbar` | Toolbar position | — | — |
| `customPopupCss` | Design › Custom CSS | `#opt-custom-popup-css` | Popup stylesheet | — | — |
| `customPopupJavascript` | Design › Custom CSS | `#opt-custom-popup-javascript` | Custom JavaScript | — | — |
| `customLinks` | Design › Custom buttons | (derived) | — | — | Legacy projection of link `customButtons` |
| `customButtons` | Design › Custom buttons | `#custom-button-list` | Button name, Action, URL template, Template | — | — |
| `audioSources` | Audio | `#audio-source-list` | per-source rows | — | — |
| `audioAutoplay` | Audio | `#opt-audio-autoplay` | Automatically play the first lookup result | same | — |
| `anki` | Anki | see below | — | — | — |
| `experimental` | Advanced › Experimental features | `#experimental-features` | `EXPERIMENTAL_FEATURES` labels | — | One registry, rendered once |
| `popupWidthPx` | Design › Appearance | `#opt-popup-width` | Width | — | — |
| `popupHeightPx` | Design › Appearance | `#opt-popup-height` | Height | — | — |
| `popupScalePercent` | Design › Appearance | `#opt-popup-scale` | Scale | — | — |
| `popupOpacityPercent` | Design › Appearance | `#opt-popup-opacity` | Background opacity | — | — |
| `sourceHighlightEnabled` | Design › Appearance | `#opt-source-highlight` | Highlight the word on the page | same | — |
| `showPopupAudioButton` | Audio | `#opt-popup-audio-button` | Show the audio button | same | Moved from Design › Appearance; no longer reset by Reset Design |
| `popupColumns` | Design › Definitions | `#opt-popup-columns` | Definition columns | — | — |
| `showLookupCounts` | Reading › Lookup history | `#opt-lookup-counts` | Record and show lookup counts | same | — |
| `definitionBlurCountEnabled` | Reading › Definition blur | `#opt-blur-count` | Blur by lookup count | Blur definitions by lookup count | **Renamed** from `definitionBlurEnabled`, which only ever enabled the count condition; old records, patches and backups migrate. Label was "Lookup count" |
| `definitionBlurAnkiMature` | Reading › Definition blur | `#opt-blur-anki` | Blur mature Anki cards | Blur definitions of mature Anki cards | Was "Mature Anki card" |
| `definitionBlurFrequencyEnabled` | Reading › Definition blur | `#opt-blur-frequency` | Blur by frequency | Blur definitions by frequency | Was "Frequency threshold", the same label as the threshold field |
| `definitionBlurFrequencyDictionary` | Reading › Definition blur | `#opt-blur-frequency-dictionary` | Blur threshold dictionary | — | Was "Frequency dictionary", the same label as the sort picker. Empty now means **Same as sorting** (the default) |
| `definitionBlurFrequencyOrder` | Reading › Definition blur | `#opt-blur-frequency-order` | Blur threshold direction | — | Was "Frequency order", the same label as the sort order |
| `definitionBlurFrequencyThreshold` | Reading › Definition blur | `#opt-blur-frequency-threshold` | Threshold (frequency value) | — | Was "Frequency threshold" |
| `definitionBlurDirection` | Reading › Definition blur | `#opt-blur-direction` | Blur when looked up | — | — |
| `definitionBlurThreshold` | Reading › Definition blur | `#opt-blur-threshold` | Threshold (lookups) | — | — |
| `definitionBlurReveal` | Reading › Definition blur | `#opt-blur-reveal` | Reveal | — | — |
| `definitionBlurDelayMs` | Reading › Definition blur | `#opt-blur-delay` | Delay (seconds) | — | — |
| `showCompactDefinitionSummary` | Design › Compact summary | `#opt-compact-summary` | Show brief definitions beside the headword | same | — |
| `compactDefinitionSummaryCount` | Design › Compact summary | `#opt-summary-count` | Snippets | — | — |
| `compactDefinitionSummaryDictionary` | Design › Compact summary | `#opt-summary-dictionary` | Summary dictionary | — | Was "Preferred dictionary", the same label as the pitch picker |
| `popupImageSource` | Design › Definitions | `#opt-image-source` | Image source | — | — |
| `imageHoverPreview` | Design › Definitions | `#opt-image-hover-preview` | Image hover preview | — | — |
| `averageFrequency` | Design › Frequency labels | `#opt-average-frequency` | Show frequency averages | same | — |
| `showFrequencyDictionaryNames` | Design › Frequency labels | `#opt-frequency-names` | Show frequency dictionary names | same | Was "Show dictionary names", the same label as the pitch switch |
| `compactFrequencyNumbers` | Design › Frequency labels | `#opt-frequency-compact` | Abbreviate large numbers (51.5k) | Abbreviate large frequency numbers | — |
| `showPitchAccentFurigana` | Design › Pitch accent | `#opt-pitch-furigana` | Show pitch in furigana | same | — |
| `pitchAccentFuriganaDictionary` | Design › Pitch accent | `#opt-pitch-dictionary` | Pitch accent dictionary | — | Was "Preferred dictionary" |
| `showPitchAccentBadge` | Design › Pitch accent | `#opt-pitch-badge` | Show pitch badges | same | — |
| `showPitchAccentDictionaryNames` | Design › Pitch accent | `#opt-pitch-names` | Show pitch dictionary names | same | Was "Show dictionary names" |
| `showPitchAccentText` | Design › Pitch accent | `#opt-pitch-text` | Show pitch accent text | same | — |
| `showPitchAccentPosition` | Design › Pitch accent | `#opt-pitch-position` | Show pitch accent position | same | — |
| `showPitchAccentGraph` | Design › Pitch accent | `#opt-pitch-graph` | Show pitch accent graph | same | — |
| `hidePopupGrammarTags` | Design › Tags | `#opt-grammar-tags` (inverted) | Show grammar tags | Show grammar tags | Keybind said "Hide grammar tags": opposite polarity to the checkbox |
| `kanjiClickDictionary` | Design › Definitions | `#opt-kanji-dictionary` | Clicked-kanji dictionary | — | — |
| `frequencyDictionary` | Reading › Frequency sorting | `#opt-frequency-dictionary` | Sort by frequency dictionary | — | Was "Frequency dictionary"; also the blur dictionary unless blur picks its own |
| `frequencyOrder` | Reading › Frequency sorting | `#opt-frequency-order` | Sort order | — | Was "Frequency order" |
| `automaticBackupDays` | Backup & restore | `#opt-automatic-backup-days` | Days kept | — | — |
| `lowMemoryMode` | Advanced › Memory | `#opt-low-memory-mode` | Low memory mode | not offered | The Advanced intro no longer calls Memory experimental |
| `keybinds` | Keybinds | `#keybind-list` | per-keybind rows | — | — |

`anki` holds `url` (AnkiConnect link), `apiKey` (AnkiConnect API key) and
`templates`; each Template stores `deck`, `model` (Note type), `tags`,
`fields` / `fieldTemplates` (Field mapping), `duplicateScope` (Check within),
`duplicateBehavior` (When found) and `captureScreenshot`. The top-level
copies of those Template fields are a compatibility projection of the first
Template, not separate settings. One remaining oddity is left for a later
change: **Screenshot page during card creation** sits in the connection card
although it edits the selected Template.

Also removed: the sidebar's `#nav-status-media` item, which had a status output
but no link or section. Not changed: Sharing's **Advanced** disclosure (a port
field), a Library "Dictionary roles" panel, and a global "Show advanced
settings" switch; the dictionary pickers keep their sections and now say which
role they choose.
## Browser captures

These unedited captures use the unpacked extension in Chromium 150.0.7871.186,
Linux, with an isolated profile containing four small catalogue fixtures imported
through the production engine. The dictionaries are disabled for the captures.
Only the empty-library capture temporarily clears that fixture inventory; it is
restored afterward. The save-error capture injects a failed worker write reply
and exercises the production feedback path.

All eleven sections were checked at 1440, 900 and 375 pixels in light and dark
palettes: 66 views, no horizontal overflow and no page errors. At 1440 pixels,
Design's document height fell from 3647 to 2411 pixels. At 375 pixels, the first
Design control moved from y=1022 to y=510 with the preview initially collapsed.
An intentionally opened preview stays open during subsequent navigation/resizing.
The save-error panel stays at y=12–108.5 in a 1000-pixel-high scrolled viewport.
These are browser geometry checks, not a screen-reader usability study.

The theme follow-up was checked in Chrome for Testing 152.0.7977.75. All 42
lookup palettes resolved on Settings with at least 4.5:1 text contrast and 3:1
control-boundary contrast. Every one of the eleven sections also fit at 320 and
1280 pixels under representative light and dark palettes, with the opposite
system colour preference forced to prove that the saved theme wins.
The Hachidori default uses blue-charcoal surfaces, lavender controls and muted
rose, sage and slate metadata. Its Settings mapping lowers border glare and
separates supporting text from the primary content without changing the other
41 themes.

![Settings using the selected Miku lookup theme](assets/settings-theme-miku.png)

![Library with its five related settings views](assets/settings-library-navigation.png)

| Desktop Design | Narrow Design |
| --- | --- |
| ![Design with full-width selectors and live preview](assets/settings-design-1440-dark.png) | ![Compact navigation and the live preview above the controls at 375 pixels](assets/settings-design-375-light.png) |

![Reading with local lookup history and definition blur](assets/settings-reading.png)

![Empty Library with installation and import actions](assets/settings-empty-library.png)

![Save failure with recovery actions remains visible while scrolling](assets/settings-save-error.png)

## Targeted timings

Compared `5101f38` with `7488edf` (the original settings implementation, rebased
as `05dfbf9`) in Chromium 150.0.7871.186, Node 26.4.0, Linux x86_64. The later
backup, error-state and picker-focus fixes do not change the measured sidebar
navigation or lookup-count transaction path.

Reproduction: load each checkout's unpacked extension in a fresh Chrome profile,
mark setup complete and seed 100 dictionary metadata rows. At 1440 × 1000,
warm the Design preview, then time 20 cycles of Reading → Design → Library.
For each visit, set the fragment with `history.replaceState`, click the matching
sidebar link and read the main element's `offsetHeight`, exercising the production
same-fragment handler plus synchronous layout. Discard one warmup batch and keep
eleven measured batches. In the same profile, time eleven batches of twenty
sequential `hd_lookup_stats_record` worker messages for 食べる / たべる after one
warmup batch. Verify the final count is 240, the library has 100 rows and the
last section is Library. Run before/after/after/before, each in a fresh browser.

The local command was `node /tmp/hachidori-ui-review/benchmark-settings.mjs`;
the repeat used the identical driver with a separate output path. Both runs'
[raw samples](assets/settings-ui-timings.json) are retained. Medians below are
milliseconds per batch, not per individual navigation or count request.

| Run / order | Navigation before | Navigation after | Count before | Count after |
| --- | ---: | ---: | ---: | ---: |
| Initial, before then after | 1448.18 | 1296.69 | 27.43 | 15.35 |
| Initial, after then before | 1349.72 | 2025.45 | 22.38 | 21.07 |
| Repeat, before then after | 1297.60 | 1118.29 | 23.57 | 20.31 |
| Repeat, after then before | 1256.48 | 1220.83 | 56.26 | 15.95 |

The initial navigation results changed direction, so the complete comparison was
repeated with other browser work paused. No consistent regression was measured;
the storage samples remain noisy. These timings do not establish an end-to-end
speedup: navigation excludes deferred paint/async work, the metadata rows do not
contain real dictionary payloads, and count timing excludes dictionary lookup.
No product limits or runtime caches were added for this result.

The simplification pass reused existing section navigation, option-save recovery,
dictionary installation and storage transactions. Native select/details controls
supply the new navigation and disclosures. Removing the external corpus path also
removes its URL validator, timeout, reader refresh bookkeeping and display segment.
