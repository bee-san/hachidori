# Chrome Web Store assessment and publishing guide

Assessed on **8 September 2026**, against commit
[`5101f38460004544b60d49ec14a8bd334841e429`](https://github.com/bee-san/hachidori/tree/5101f38460004544b60d49ec14a8bd334841e429).
This is a source and packaging audit, not a Google review or a fresh runtime
test result. Recheck the actual release candidate and Google's linked policies
before submitting it.

## Would Hachidori be accepted?

**Hachidori has a plausible path to approval, but this checkout is not ready to
submit unchanged.** Japanese lookup, dictionary management, pronunciation and
Anki study tools fit one understandable purpose. The extension uses Manifest V3
and packages its JavaScript and WebAssembly locally. The main work before
submission is privacy disclosure, transport and permission review, and preparing
the distribution and listing. Google makes the final acceptance decision.

| Area | Finding | Action before submission |
| --- | --- | --- |
| Privacy policy | No standalone policy or published policy URL was found in the repository. Local page processing, statistics, Anki integration and capture handle user data. | Publish an accurate policy, link it from the project and extension, and complete the dashboard disclosures. Local-only storage still needs disclosure. |
| Network security | [Audio URL validation](../extension/audio-sources.js) accepts non-loopback HTTP templates and provider-returned URLs. [Audio fetches](../extension/audio-repository.js) follow redirects without checking the final scheme. Terms/readings can therefore leave the machine unencrypted. | Resolve this in a focused code PR: use HTTPS for remote audio requests/candidates and prevent insecure redirect paths, while preserving intentional same-device services. This guide does not implement that change. |
| Permissions | [The manifest](../extension/manifest.json) requests `<all_urls>` and `tabs`. Hover lookup supports broad page access, but the separate `tabs` permission appears potentially redundant with host access. | Test whether `tabs` can be removed; separately justify content-script matching and cross-origin host access. Do not justify a permission solely because the API namespace is used. |
| First-run disclosure | [Setup](../extension/startup.js) automatically downloads recommended dictionaries and probes local Anki, including reading collection metadata to infer configuration. | Explain both before installation and prominently in setup; verify that the disclosure and consent sequence covers the actual automatic behavior. Creating notes and starting capture are separate actions. |
| Store assets | Icons exist, but no dedicated promotional tile was found; current documentation screenshots are not store screenshot dimensions. | Prepare the assets listed below using the actual release UI. |
| Distribution notices | A ZIP containing only `extension/` omits the root GPL license and the AVIF binary notices. | Include licenses, dependency notices and an exact source reference in the staged package; make corresponding source/build instructions available. |
| Public links | GitHub reports this repository as private; its source and issue links return 404 without authentication. | Provide public privacy/support pages and arrange accessible corresponding source for recipients. A private development repository is not itself a store violation. |

The privacy, transport and permission findings apply Google's [privacy and secure-handling FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
[minimum-permissions policy](https://developer.chrome.com/docs/webstore/program-policies/permissions)
and [disclosure requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements).
A reviewer might accept well-explained broad access; its presence alone does not
establish a violation.

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
- **Capture:** it is off by default, requires Start capture and Chrome's source
  picker, retains temporary local history, and sends final assets to local Anki
  only when mining. Explain that closing controls continues recording and how
  to stop it. There is no microphone recording, OCR or DRM bypass in the audited
  implementation. See [media capture](media-capture.md#privacy-and-limitations).
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
| `unlimitedStorage` | Keep user-imported dictionaries and their generated indexes available locally, including dictionaries larger than ordinary extension storage quotas. |
| `offscreen` | Run the local dictionary engine and pronunciation playback, and retain an explicitly started capture session when its controls close. [The worker](../extension/background.js) requests `DOM_SCRAPING`, `AUDIO_PLAYBACK` and `DISPLAY_MEDIA`. |
| `alarms` | Run the user's configured dictionary update schedules while the service worker is idle. Scheduled runs can install dictionary data updates; they do not replace extension code. |
| `downloads` | Save an explicitly requested local backup ZIP and monitor that export's completion. [The implementation](../extension/backup-downloads.js) tracks its own export IDs. |
| `<all_urls>` host access | Fetch dictionaries and updates from configured HTTPS sources, pronunciation from configured sources, and communicate with local Anki. Explain arbitrary source support and why a fixed allowlist does not cover the shipped feature. |
| `<all_urls>` content-script matching | Read Japanese text near the pointer/selection and display dictionary results on the user's reading pages. A fixed website list cannot cover where users read. User-enabled local-file access can support local reading pages. |
| `tabs` — review before keeping | The capture page picker reads tab titles/URLs. However, host permissions already expose those properties on matching pages. Verify the picker, linking, navigation and reopening controls without `tabs`; remove it if those paths still work. Opening tabs and sending messages alone do not require this permission. |

The `tabs` assessment follows Google's [Tabs API permission explanation](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions).
Changing to `activeTab` would require a user invocation before access and would
change the current hover-everywhere interaction. Optional host grants are a
possible product change, not something this documentation silently assumes.

## Privacy policy and data-use answers

Publish a readable HTTPS policy at a stable, public URL; link it from the project
homepage and extension settings, then enter that URL in the dashboard. This
guide is not the policy. Identify the publisher and contact route, describe
purpose, recipients, retention and deletion, and include an affirmative
[Limited Use statement](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Keep the policy, store listing, checkboxes and UI consistent.

The policy must cover the actual paths below, including automatic setup:

| Data or operation | Current handling to disclose | Source |
| --- | --- | --- |
| Page text and lookup activity | Pointer/selection text and surrounding context support lookup and mining. Local statistics retain term, reading, count and first/last lookup timestamps even when the count display is hidden. Statistics rows do not store page URLs. | [Reader](../extension/content.js), [statistics](../extension/lookup-stats.js) |
| Dictionaries and personal settings | Imported/generated dictionaries and custom entries remain in extension storage. Preferences include custom URLs, CSS, templates and an optional AnkiConnect API key. | [Storage ownership](architecture.md#storage-ownership) |
| Dictionary downloads | Fresh setup downloads Jitendex, JMnedict, Bee's Ultimate Kanji Dictionary and Jiten Frequency Dictionary. Their GitHub/GitHub asset hosts, jitendex.org and api.jiten.moe receive ordinary requests/IP metadata. Managed updates contact installed source URLs when checked or scheduled. These requests are not a remote term-lookup service. | [Catalogue](../extension/recommended-dictionaries.js), [updates](update-schedules.md) |
| Pronunciation | Configured custom audio providers receive the expression/reading substituted into their URLs. Built-in speech uses the browser/OS voice; the code does not require a `localService` voice, so do not promise every voice works offline. | [Sources](../extension/audio-sources.js), [player](../extension/audio-player.js) |
| Anki | Requests go to `http://127.0.0.1:8765`. Setup reads deck/model/card/note metadata; enabled mature-word blur sends read-only expression queries. Explicit mining can send selected text, definitions, page title, audio, images and captured media according to field mappings. Anki controls any subsequent sync. | [Gateway](../extension/anki.js), [setup](../extension/anki-setup.js), [maturity](../extension/anki-maturity.js), [mining](../extension/anki-mining.js) |
| Lookup counts / texthooker | Lookup counts stay in this browser and never contact an external service. Optional capture texthooker receives timing/text over a loopback WebSocket. | [Statistics](lookup-statistics.md), [capture](media-capture.md) |
| Shared media | User-selected tab/window/monitor frames and available source audio stay in transient capture history. Stop clears it; explicitly mined final clips are sent to local Anki. Reading-page titles/URLs identify the linked source. | [Capture privacy](media-capture.md#privacy-and-limitations) |
| Other external resources | Explicit external dictionary links open dictionary-supplied HTTP(S) URLs, which may contain terms or other parameters. User-written popup CSS may fetch URL resources. Their destination hosts may receive request metadata; dictionary CSS has separate restrictions. | [Renderer](../extension/render/glossary.js), [links](../extension/external-links.js), [custom CSS](architecture.md#custom-popup-css) |
| Backups and deletion | User-requested backup ZIPs include settings, dictionaries, custom entries and statistics, and may include API keys. They are unencrypted. Uninstalling the extension does not delete downloaded backups or already-created Anki notes; those need separate deletion. | [Backup format](backup-format.md) |

No analytics/advertising SDK or developer-operated lookup collection endpoint was
found in the audited runtime. That does **not** mean the extension handles no
user data or never contacts third parties. Ordinary Chrome storage and backup
ZIPs are not application-encrypted; review API-key storage and exported secrets
against Google's current secure-handling guidance before certifying. Google's
[FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) expressly exempts traffic to native programs on the same computer from the
transmission-encryption requirement; that does not cover remote HTTP audio.

For the dashboard's data categories, evaluate **Website content**, **Web history**
(tab URLs read for capture source selection), **User activity** (lookups), and
**Authentication information** (the optional AnkiConnect key). Selected screen
or audio content can also contain sensitive information. These are starting
points for mapping the shipped behavior to the current form, not a pre-completed
certification. Do not select “no user data” simply because most work is local.

## Publish step by step

### 1. Finish the release candidate

Resolve the findings above in focused PRs, including any needed runtime/UI
changes. Follow the repository's review gates before merging them. Record the
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
These are release instructions; this documentation-only audit did not run them.

### 2. Make the upload ZIP

Google needs **`manifest.json` at the ZIP root**, not
`extension/manifest.json`. Include both dictionary Wasm variants and the AVIF
encoder. The committed bundles suffice unless their source changed; rebuild
instructions are in [Architecture](architecture.md#build-outputs) and
[`wasm/avif/build.sh`](../wasm/avif/build.sh). There is no existing store-packaging
workflow in the audited checkout. See [Google's package preparation](https://developer.chrome.com/docs/webstore/prepare).

From a clean checkout of the selected release commit, run this Bash/Python 3
example. It stages tracked extension files outside the repository, adds the
existing license material, records source identity, and prints the output path:

```sh
git submodule update --init --recursive
python3 - <<'PY'
import io
import json
from pathlib import Path
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

repo = Path.cwd()
assert not subprocess.check_output(["git", "status", "--porcelain"]).strip(), "Use a clean release checkout"
revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
modules = subprocess.check_output(["git", "submodule", "status", "--recursive"], text=True)
assert all(line.startswith(" ") for line in modules.splitlines()), "Check submodule revisions"
stage = Path(tempfile.mkdtemp(prefix="hachidori-store-"))
payload = stage / "extension"
archive = subprocess.check_output(["git", "archive", "--format=zip", "HEAD:extension"])
with ZipFile(io.BytesIO(archive)) as source:
    source.extractall(payload)
(payload / "LICENSE").write_bytes((repo / "LICENSE").read_bytes())
(payload / "THIRD_PARTY_NOTICES").write_bytes((repo / "wasm/avif/THIRD_PARTY_NOTICES").read_bytes())
engine = repo / "third_party/hoshidicts"
assert (engine / "LICENSE").is_file(), "Initialize the engine submodule"
for notice in sorted(engine.rglob("*")):
    if notice.is_file() and notice.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
        target = payload / "licenses/hoshidicts" / notice.relative_to(engine)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(notice.read_bytes())
(payload / "SOURCE.txt").write_text(
    f"Hachidori source: https://github.com/bee-san/hachidori/tree/{revision}\n"
    f"Build instructions: docs/architecture.md and wasm/avif/build.sh at that revision.\n"
    f"Pinned submodules:\n{modules}", encoding="utf-8")
manifest = json.loads((payload / "manifest.json").read_text())
output = stage / f"hachidori-{manifest['version']}.zip"
with ZipFile(output, "w", ZIP_DEFLATED) as bundle:
    for entry in sorted(payload.rglob("*")):
        if entry.is_file():
            bundle.write(entry, entry.relative_to(payload).as_posix())
with ZipFile(output) as bundle:
    assert bundle.testzip() is None
    assert "manifest.json" in bundle.namelist()
print(f"Load unpacked for final inspection: {payload}")
print(f"Upload ZIP: {output}")
PY
```

Review dependency/source obligations for the final binaries; copying existing
notices is not a complete license audit. Preserve the exact corresponding source,
submodules and build instructions for each release, and make them accessible
alongside its distribution. Do not include private dictionaries, backups, test
profiles or capture recordings in the upload. Load the staged directory in a
fresh Chrome profile and check setup, lookup and configured optional features.

The example records the repository's source identity. If the repository remains
private, update the `SOURCE.txt` generation to include the actual source delivery
location before producing a distribution ZIP. An inaccessible GitHub link does
not provide recipients with the corresponding source. This audit does not change
repository visibility or publish source archives.

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

Prepare these [required store images](https://developer.chrome.com/docs/webstore/images):

- A **128 × 128 PNG icon**; [`hachidori-128.png`](../extension/icons/hachidori-128.png)
  already exists. Check its appearance against Google's artwork/padding guidance.
- A **440 × 280 small promotional tile**.
- **At least one screenshot**, up to five, at **1280 × 800** or **640 × 400**.
  Use fresh captures of lookup, dictionaries and optional study tools with
  authorized sample content. Existing [documentation assets](assets/) are useful
  references, but must not be assumed to meet store dimensions.
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

1. Install in a fresh profile. Setup opens and sequentially downloads the four
   starter dictionaries; failures offer retry. Anki discovery is read-only and
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
Update the README with the actual listing link. Unpacked and store installations
can have different IDs and separate storage; use Hachidori's backup/restore if
migration is needed, and retain the old installation until the restore is
verified.

For subsequent releases, upload a ZIP with a higher manifest version to the
**same store item**, refresh disclosures/assets when behavior changes, and follow
the [update process](https://developer.chrome.com/docs/webstore/update).
Dictionary data updates use Hachidori's own source/update mechanism; extension
JavaScript and Wasm changes ship through store updates.
