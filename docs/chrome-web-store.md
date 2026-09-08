# Chrome Web Store assessment and publishing guide

Initial audit: **8 September 2026**, against
[`5101f38460004544b60d49ec14a8bd334841e429`](https://github.com/bee-san/hachidori/tree/5101f38460004544b60d49ec14a8bd334841e429).
This guide now describes the store preparation implemented after that audit.
Recheck the actual release candidate and Google's linked policies before
submitting it; Google makes the final acceptance decision.

## Readiness

Hachidori uses Manifest V3 with bundled JavaScript and WebAssembly. Its local
Japanese dictionary, pronunciation and Anki study features fit one understandable
purpose. The repository now includes the disclosures, store artwork and release
packaging needed to prepare a submission.

| Area | Preparation included | At publication |
| --- | --- | --- |
| Privacy | [The privacy policy](privacy.md) describes local data, providers, capture, backups, retention and contact. Settings and setup link to it. | The GitHub policy URL must be readable without signing in. The repository was private at audit time. |
| First run | One short welcome and **Start setup** precede automatic dictionary downloads and local Anki discovery. Accepted runs resume automatically; **Set up manually** skips both. | Describe this behavior in the listing and verify it in the uploaded build. |
| Audio | HTTP localhost audio and custom-provider redirects remain supported. Audio Settings explains word/reading sharing and recommends HTTPS for remote sources. | Disclose configured provider/voice behavior; do not claim every audio source is offline or encrypted. |
| Permissions | The redundant `tabs` permission is removed. Capture controls are found through extension contexts, while host access supplies the reading-page titles/URLs. | Use the justifications below for the submitted manifest. |
| Assets | [Store assets](store/README.md) include a 440 × 280 promotional tile and genuine 1280 × 800 extension screenshots using original sample material. | Upload the supplied icon/tile/screenshots and check they match the release UI. |
| Licensing/source | [The packaging command](../scripts/package-store.py) includes the GPL license, dependency notices, policy and a checksummed source reference. It produces a matching source archive with recursive submodules and pinned dependency sources. | Make that source archive accessible to recipients and give its location in the listing. |

**Localhost audio is not a rejection issue by itself.** Google's
[user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
exempts same-computer native communication from transmission encryption and
separately discusses clients using user-specified servers. Yomitan's official
[custom-audio examples](https://github.com/yomidevs/yomitan/blob/master/ext/templates-modals.html)
use HTTP localhost. Hachidori preserves compatible user-selected HTTP(S) sources and
redirects, with explicit disclosure and an HTTPS recommendation for remote
services. That is not a promise about how a third-party provider handles data.

Broad page access still needs justification under Google's
[minimum-permissions policy](https://developer.chrome.com/docs/webstore/program-policies/permissions).
The welcome and settings copy provide the relevant
[in-product disclosures](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements).

### What already fits, and what needs an honest explanation

- **Bundled code:** the dictionary engine, AVIF encoder, workers and ZIP library
  live under `extension/`. The audited loading paths do not fetch remote JS or
  WASM. Dictionary ZIPs, update indexes, audio lists and media are data, not
  downloaded extension logic. The manifest's `'wasm-unsafe-eval'` is Chrome's
  supported mechanism for bundled Wasm, not permission to execute remote scripts.
  See [remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
  and [extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).
- **One purpose:** describe reading Japanese and saving study material. Capture
  supports that workflow; avoid presenting it as an unrelated general recorder.
  See [extension quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines).
- **Continuous capture:** it is off by default, requires Start capture and Chrome's source
  picker, retains temporary local history, and sends final assets to local Anki
  only when mining. Explain that closing controls continues recording and how
  to stop it. There is no microphone recording, OCR or DRM bypass in the audited
  implementation. See [media capture](media-capture.md#privacy-and-limitations).
  Separately, the enabled-by-default **Screenshot the page when mining** switch
  takes one picture of the whole visible reading page when a field maps
  `{screenshot}` and the user chooses Add or Overwrite. It uses the active tab
  directly and sends the picture to local Anki with the note.
- **Content and claims:** use material you have permission to show in store
  screenshots and verify rights for recommended dictionary distribution and
  audio sources. Describe capture for authorized study material; do not promise
  access to protected media. Avoid copying the README's unqualified “fastest”
  claim into the listing. Google's [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
  cover misleading claims, intellectual property and unauthorized media access.

## Permissions to explain in the dashboard

Use this as a source-based draft, then update it to match the submitted manifest.
Google requires [a justification for each permission](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).

| Permission | Hachidori use and proposed explanation |
| --- | --- |
| `storage` | Save dictionary configuration, reader preferences, custom entries, lookup counts and Anki settings locally. The engine stores dictionary indexes separately in OPFS or IndexedDB. |
| `unlimitedStorage` | Keep user-imported dictionaries and their generated indexes in OPFS or IndexedDB exempt from ordinary extension storage quotas and storage-pressure eviction. |
| `offscreen` | Run the local dictionary engine and pronunciation playback, and retain an explicitly started capture session when its controls close. [The worker](../extension/background.js) requests `DOM_SCRAPING`, `AUDIO_PLAYBACK` and `DISPLAY_MEDIA`. |
| `alarms` | Run the user's configured dictionary update schedules and refresh the optional local mature-word cache every 30 minutes while enabled. Scheduled runs can install dictionary data updates; they do not replace extension code. |
| `downloads` | Save an explicitly requested local backup ZIP and monitor that export's completion. [The implementation](../extension/backup-downloads.js) tracks its own export IDs. |
| `<all_urls>` host access | Fetch dictionaries and updates from configured HTTPS sources, pronunciation from configured sources, communicate with local Anki, and capture the visible reading page for mapped mining screenshots. Explain arbitrary source support and why a fixed allowlist does not cover the shipped feature. |
| `<all_urls>` content-script matching | Read Japanese text near the pointer/selection and display dictionary results on the user's reading pages. A fixed website list cannot cover where users read. User-enabled local-file access can support local reading pages. |
| `tabs` | Removed. Host permissions supply reading-page titles/URLs. `chrome.runtime.getContexts()` locates the extension’s own capture controls. |

The permission reduction follows Google's [Tabs API permission explanation](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions).
Changing to `activeTab` would require a user invocation before access and would
change the current hover-everywhere interaction. Optional host grants are a
possible product change, not something this documentation silently assumes.

## Privacy policy and data-use answers

The canonical policy is a plain Markdown file at [docs/privacy.md](privacy.md).
Its intended store URL is
`https://github.com/bee-san/hachidori/blob/main/docs/privacy.md`.
The upload ZIP also includes a copy. No separate website is required.

**Check the GitHub URL signed out before submitting.** Creating the file in a
private repository does not make it public. After merging, make the policy
readable publicly through the chosen GitHub publication arrangement. This PR
does not change repository visibility. Use the public contact email in the
policy for support while the issue tracker is private.

The policy contains the required affirmative
[Limited Use statement](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Keep it, the store listing, data-use checkboxes and UI consistent.

The policy covers the paths below; use this mapping when completing the dashboard:

| Data or operation | Current handling to disclose | Source |
| --- | --- | --- |
| Page text and lookup activity | Pointer/selection text and surrounding context support lookup and mining. Local statistics retain term, reading, count and first/last lookup timestamps. Turning off lookup counts pauses recording and preserves past rows, which do not store page URLs. | [Reader](../extension/content.js), [statistics](../extension/lookup-stats.js) |
| Dictionaries and personal settings | Imported/generated dictionaries and custom entries remain in extension storage. Preferences include custom URLs, CSS, templates and an optional AnkiConnect API key. | [Storage ownership](architecture.md#storage-ownership) |
| Dictionary downloads | After Start setup, the installer downloads Jitendex, JMnedict, Bee's Ultimate Kanji Dictionary and Jiten Frequency Dictionary. Their GitHub/GitHub asset hosts, jitendex.org and api.jiten.moe receive ordinary requests/IP metadata. Managed updates contact installed source URLs when checked or scheduled. These requests are not a remote term-lookup service. | [Catalogue](../extension/recommended-dictionaries.js), [updates](update-schedules.md) |
| Pronunciation | Configured custom audio providers receive the expression/reading substituted into their URLs. Built-in speech uses the browser/OS voice; the code does not require a `localService` voice, so do not promise every voice works offline. | [Sources](../extension/audio-sources.js), [player](../extension/audio-player.js) |
| Anki | Requests go to `http://127.0.0.1:8765`. After Start setup, Anki discovery reads deck/model/card/note metadata; enabled mature-word blur retrieves mature expressions from the configured note type for a local cache every 30 minutes. The cache retains expressions, refresh times and a configuration identifier when disabled. Explicit mining can send selected text, definitions, page title, audio, images and captured media according to field mappings. Anki controls any subsequent sync. | [Gateway](../extension/anki.js), [setup](../extension/anki-setup.js), [maturity](../extension/anki-maturity.js), [mining](../extension/anki-mining.js) |
| Lookup counts / texthooker | Lookup counts stay in this browser and never contact an external service. Optional capture texthooker receives timing/text over a loopback WebSocket. | [Statistics](lookup-statistics.md), [capture](media-capture.md) |
| Page screenshots | With Screenshot the page when mining enabled and a field mapping `{screenshot}`, Add or Overwrite takes one picture of the whole visible reading page directly from the active tab. The switch is on by default. The picture stays in temporary memory and is sent to local Anki with the note. | [Mining](../extension/anki-content.js), [screenshot ownership](../extension/background.js) |
| Continuous capture | User-selected tab/window/monitor frames and available source audio stay in transient capture history after Start capture and Chrome's picker. Stop clears it; explicitly mined final clips are sent to local Anki. Reading-page titles/URLs identify the linked source. | [Capture privacy](media-capture.md#privacy-and-limitations) |
| Other external resources | Explicit external dictionary links open dictionary-supplied HTTP(S) URLs, which may contain terms or other parameters. User-written popup CSS may fetch URL resources. Their destination hosts may receive request metadata; dictionary CSS has separate restrictions. | [Renderer](../extension/render/glossary.js), [links](../extension/external-links.js), [custom CSS](architecture.md#custom-popup-css) |
| Backups and deletion | User-requested backup ZIPs include settings, dictionaries, custom entries and statistics, and may include API keys. They are unencrypted and exclude the derived mature-word cache. Uninstalling the extension does not delete downloaded backups or already-created Anki notes; those need separate deletion. | [Backup format](backup-format.md) |

No analytics/advertising SDK or developer-operated lookup collection endpoint was
found in the audited runtime. That does **not** mean the extension handles no
user data or never contacts third parties. Ordinary Chrome storage and backup
ZIPs are not application-encrypted; review API-key storage and exported secrets
against Google’s [secure-handling requirements](https://developer.chrome.com/docs/webstore/program-policies/data-handling)
and [user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) before certifying. The existing
backup export UI explicitly warns that the ZIP is unencrypted and can contain
API keys. The policy describes that behavior; this preparation does not add a
new encryption or credential-storage system.

For the dashboard's data categories, evaluate **Website content**, **Web history**
(tab URLs read for capture source selection), **User activity** (lookups), and
**Authentication information** (the optional AnkiConnect key). Selected screen
or audio content can also contain sensitive information. These are starting
points for mapping the shipped behavior to the current form, not a pre-completed
certification. Do not select “no user data” simply because most work is local.

## Publish step by step

### 1. Finish the release candidate

Review the preparation changes and follow the repository's review gates before
merging the release candidate. Record the
release commit and choose a manifest version higher than any previously uploaded
version (`0.1.0` is the audited version, not an instruction to reuse it forever).

Use the [test harness setup](../test/README.md) and run the release checks against
that candidate, recording exact outcomes:

```sh
node test/make-fixture.mjs
node test/node-smoke.mjs
node test/extension-smoke.mjs
node test/chrome-e2e.mjs
node test/chrome-fallback.mjs
```

For a release including media capture, follow the additional browser/platform
checks in [the capture test guide](../test/README.md#chrome-capturemjs), including
actual Anki playback. Verify the claimed Chrome/OS support; the manifest's Chrome
118 minimum alone does not prove every capture feature on every platform.
These are release instructions. The pull request records which checks were run
for its exact changes and any test-environment limitations.

### 2. Make the upload ZIP

Google needs **`manifest.json` at the ZIP root**. The release command packages
tracked runtime files with their licenses and the privacy policy, then creates
a matching source ZIP containing recursive submodules and pinned AVIF/zip.js
sources. Existing dictionary/AVIF Wasm bundles are included unchanged unless
the release intentionally rebuilds them. See [source/build instructions](source-build.md)
and [Google's package preparation](https://developer.chrome.com/docs/webstore/prepare).

From a clean, committed release checkout with Git and Python 3.9 or newer:

```sh
git submodule update --init --recursive
python3 scripts/package-store.py --output-dir /tmp/hachidori-store
```

The command writes three files outside the repository:

- `hachidori-<version>-<commit>-chrome.zip`: upload this to the store.
- `hachidori-<version>-<commit>-source.zip`: distribute the matching source.
- `hachidori-<version>-<commit>-SHA256SUMS.txt`: checksums of both ZIPs.

A checksum-verified source cache avoids repeated downloads; override its
location with `--cache-dir /path/to/cache` if needed. The source archive needs
no private GitHub access after download. `SOURCE.json` in the Chrome ZIP binds
it to the source archive's name and SHA-256. Make that archive accessible and
put its public download location in the listing before distribution.

Extract the Chrome ZIP into a temporary directory and load that directory in a
fresh Chrome profile to check the exact upload contents. Verify setup, lookup,
local audio and any configured optional features. Keep private dictionaries,
backups, browser profiles and personal recordings out of the distribution.

### 3. Register the publisher account

Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
accept the terms and pay the one-time registration fee shown there. Enable
Google Account 2-Step Verification, choose a publisher name and verify a contact
email you monitor. Complete any identity and trader/non-trader declaration the
dashboard requests based on the publisher's actual situation.
See [registration](https://developer.chrome.com/docs/webstore/register),
[account setup](https://developer.chrome.com/docs/webstore/set-up-account) and
[trader identification](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure).

### 4. Prepare the listing

Use accurate, readable copy. A proposed **single purpose** is:

> Help users read Japanese with local dictionary lookups and save selected
> vocabulary and study context to Anki.

Suggested short description, if adopted in the release manifest:

> Japanese hover dictionary with local Yomitan lookup, pronunciation and Anki study tools.

The longer description should cover supported reading pages, automatic starter
dictionary downloads, local lookup/storage, pronunciation provider behavior,
optional Anki features and explicitly started capture. Explain that Anki
Desktop with AnkiConnect is needed for mining; ordinary lookup works without it.
Link a publicly reachable project/support destination and the published privacy
policy. The current [issue tracker](https://github.com/bee-san/hachidori/issues)
is only accessible to repository collaborators; do not use it as the sole public
support route while the repository is private. Choose the closest current
education/language category and the actual listing language.

Use the files and reproduction instructions in [Store assets](store/README.md)
for these [required store images](https://developer.chrome.com/docs/webstore/images):

- A **128 × 128 PNG icon**; [`hachidori-128.png`](../extension/icons/hachidori-128.png)
  already exists. Check its appearance against Google's artwork/padding guidance.
- A **440 × 280 small promotional tile**.
- **At least one screenshot**, up to five, at **1280 × 800** or **640 × 400**.
  The supplied welcome and hover-lookup screenshots use original sample text
  and definitions, with no personal browsing content.
- An optional **1400 × 560 marquee image** if desired.

The [asset ownership record](asset-rights.md) documents the supplied Hachidori
logo pack and all six visual novel backgrounds, including the owner's copyright
declaration, original filenames and image checksums. Use it as the artwork
reference for the package and publishing screenshots.

### 5. Upload and complete review information

In the dashboard, choose **Add new item**, upload the ZIP, and complete Store
listing, Privacy practices, Distribution and Test instructions. Supply the
single purpose, actual permission justifications, policy URL and accurate data
categories. For the audited local JS/WASM implementation, the remote-code answer
is **No**; re-audit dependencies if the candidate changes.

Use Public for general discovery, Unlisted for link-based access, or Private
for selected testers. Visibility does not bypass policy review.
See [publishing](https://developer.chrome.com/docs/webstore/publish) and
[distribution settings](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution).

Provide reviewer instructions specific to Hachidori:

1. Install in a fresh profile. Read the short welcome and click **Start setup**.
   Setup sequentially downloads the four starter dictionaries; failures offer
   retry. Anki discovery is read-only and
   absence of Anki does not prevent dictionary lookup.
2. At **Try it**, hover the Japanese sample to see a real dictionary result.
   Also test an ordinary Japanese webpage; Chrome internal pages and the store
   itself are restricted surfaces.
3. Reach Settings from setup or `chrome://extensions` → Hachidori details →
   **Extension options**. This manifest does not define a toolbar-action popup.
4. Test custom entries and local counts. For Anki, run Anki Desktop with
   AnkiConnect, configure a disposable deck/note type and map fields. If an origin
   grant is needed, use the uploaded extension's actual ID rather than an old
   unpacked ID. Explicitly add a note and verify its content.
5. To review capture, follow [media setup](media-capture.md#setup), choose a
   non-private test source in Chrome's picker, mine to the disposable deck,
   then stop capture. Provide OS/audio limitations and reproduction details.

No Hachidori account is needed. Give reviewers any additional test access that
the final configured features actually require, never a personal Anki backup or
real API key.

### 6. Submit, publish and maintain

Choose **Submit for Review**. For a controlled launch, disable automatic
publication after approval and publish manually when ready. Google's current
guide gives staged approvals **30 days** before they revert to draft. Review
duration varies; monitor dashboard status and email. A valid upload is not
approval. Fix a rejection's cited issue and resubmit the corrected candidate.

After publication, install the store build in a fresh profile and repeat the
onboarding/lookup checks, including the new extension ID for local integrations.
Update the README with the actual listing link and verify the privacy and
source-download links without signing in. Unpacked and store installations
can have different IDs and separate storage; use Hachidori's backup/restore if
migration is needed, and retain the old installation until the restore is
verified.

For subsequent releases, upload a ZIP with a higher manifest version to the
**same store item**, refresh disclosures/assets when behavior changes, and follow
the [update process](https://developer.chrome.com/docs/webstore/update).
Dictionary data updates use Hachidori's own source/update mechanism; extension
JavaScript and Wasm changes ship through store updates.
