---
name: cut-release
description: Cut a Hachidori release end to end — bump both manifests on a bump/manifest-X.Y.Z branch, verify the release contract and packaging locally, open and merge the PR, write the GitHub release notes against the merge commit on main, push the bare version tag so release.yml packages, publishes assets and submits to the Chrome Web Store, then verify every artifact. Use when asked to release, ship, tag, or bump the version.
---

# Cut a Hachidori release

Input: `$ARGUMENTS` — the new version (e.g. `0.1.7`). If omitted, propose
the next patch version from `extension/manifest.json` and confirm with the
user before doing anything.

The release pipeline is `.github/workflows/release.yml`. It triggers on a
pushed tag matching `[0-9]*` and runs package → publish → chrome-web-store.
It refuses a tag whose name is not exactly `manifest.version`, whose commit
is not on `origin/main`, or whose manifests/pins fail
`scripts/check-release.mjs`. Everything below exists to make that push
succeed the first time; a tag cannot be reused once its package has been
submitted to the store (`docs/chrome-web-store.md`, "maintain").

Never push to `main` directly (AGENTS.md working agreement). The version
bump goes through a PR; only the tag is pushed by hand.

## 0. Preflight

```sh
git fetch origin --tags
git status --porcelain                  # must be empty; packaging refuses a dirty tree
git submodule update --init --recursive
gh auth status
gh run list --workflow runtime-tests.yml --branch main --limit 1   # main must be green
gh release view <prev>                  # know what the last release looked like
node -p "require('./extension/manifest.json').version"           # current version
```

Decide the version. Hachidori uses bare `X.Y.Z` tags (no `v`). Confirm
`<version>` does not already exist as a tag or release:
`git tag -l <version>; gh release view <version>` should both be empty.

Check whether the pinned Anki add-on release in `extension/anki-addon.js`
needs to move with this release (see AGENTS.md → hachidori-anki). If it
does, that is a separate PR that must land BEFORE the bump.

## 1. Bump branch

```sh
git switch -c bump/manifest-<version> origin/main
```

Edit the `"version"` field in BOTH `extension/manifest.json` and
`extension/manifest.firefox.json` to `<version>`. Change nothing else
(`check-release.mjs` fails if the two differ; the bump PR is the one place a
two-line diff is the whole change).

## 2. Verify the release contract locally

Run exactly these and keep the outputs for the PR body:

```sh
node scripts/check-release.mjs --tag <version>
#   → "Hachidori <version>: Chrome <min> minimum, <cur> current; Firefox <min> minimum, <cur> current; tag <version>"
node --test test/release-compatibility.test.mjs test/firefox-manifest.test.mjs
git add extension/manifest.json extension/manifest.firefox.json
git commit -m "release: set manifest version to <version>"
python3 scripts/package-store.py --output-dir /tmp/hachidori-release-<version>
( cd /tmp/hachidori-release-<version> && sha256sum -c ./*-SHA256SUMS.txt )
node scripts/verify-firefox-package.mjs /tmp/hachidori-release-<version>/*-firefox-unsigned.xpi
```

`package-store.py` reads committed objects only, so commit first. It should
produce `*-chrome.zip`, `*-firefox-unsigned.xpi`, `*-source.zip`,
`*-SHA256SUMS.txt`. Optionally load the extracted Chrome ZIP unpacked and
hover a word once — this is the exact runtime that will be submitted.

If anything fails, fix the root cause in a separate PR first (pins in
`test/tooling/package.json`, `minimum_chrome_version`, Firefox
`strict_min_version`…). Do not work around it in the bump PR.

## 3. Open and merge the bump PR

```sh
git push -u origin bump/manifest-<version>
gh pr create --title "release: set manifest version to <version>" --body-file - <<'EOF'
Bumps `extension/manifest.json` and `extension/manifest.firefox.json` to <version> for the release. No other changes.

Verified locally on this commit:
- `node scripts/check-release.mjs --tag <version>` → <paste output>
- `node --test test/release-compatibility.test.mjs test/firefox-manifest.test.mjs` → <n>/<n>
- `python3 scripts/package-store.py --output-dir …` → Chrome ZIP, Firefox XPI, source ZIP, SHA256SUMS; checksums verified; Firefox package verified

After merge the GitHub release <version> is created against the merge commit with hand-written notes; the tag push runs `release.yml` (package → publish assets → Chrome Web Store submission).
EOF
gh pr checks --watch
```

Merge only when checks are green. Use a merge commit (previous releases were
merge commits `Merge pull request #N from bee-san/bump/manifest-X.Y.Z`):

```sh
gh pr merge --merge --delete-branch
git switch main && git pull --ff-only
RELEASE_COMMIT=$(git rev-parse HEAD)
git log -1 --format='%H %s' "$RELEASE_COMMIT"   # must be the bump merge commit
```

Ask the user before merging unless they already said "release it".

## 4. Write the release notes

Draft `/tmp/release-notes-<version>.md` before tagging, in the shape of the
previous release (`gh release view <prev> --json body --jq .body`):

```
# Hachidori <version>

<2–4 sentence summary a learner would care about>

## Highlights
### <Feature>  … (#PR)
## Settings / Reading / Anki / Under the hood
- … (#PR)

**Full Changelog**: https://github.com/bee-san/hachidori/compare/<prev>...<version>
```

Source the list from `gh pr list --state merged --base main --search
"merged:><prev-release-date>"` and `git log <prev>..HEAD --merges`. Every
bullet cites its PR. Say what changed for the reader, not the code. Keep
`.github/release-notes-header.md` in mind: the workflow appends the package
list only when it creates the release itself; when you create the release
first, paste that header's "## Packages" block at the end of your notes so
users still get the download explanation.

Create the release against the merge commit BEFORE pushing the tag. Creating
it with `--target` makes GitHub create the tag; the workflow then sees a
release already exists and only uploads assets, preserving your notes:

```sh
gh release create <version> --target "$RELEASE_COMMIT" \
  --title "Hachidori <version>" --notes-file /tmp/release-notes-<version>.md
git fetch origin --tags
git rev-parse <version>^{commit}   # must equal $RELEASE_COMMIT
```

If you prefer to push the tag yourself instead:
`git tag <version> "$RELEASE_COMMIT" && git push origin <version>` — then the
workflow creates the release with `--generate-notes` and the header, and you
edit the notes afterwards with `gh release edit <version> --notes-file …`.

## 5. Watch the workflow

```sh
gh run list --workflow release.yml --limit 1
gh run watch <run-id> --exit-status
```

Three jobs must succeed: `Package release`, `Publish GitHub release assets`,
`Submit Chrome Web Store update`. On failure read
`gh run view <run-id> --log-failed`. Common causes and the fix:

- "manifest.version is not a Chrome-compatible release version" / tag
  mismatch → the bump PR was wrong; fix via a new PR and a NEW version.
  Delete the unused tag/release only if the CWS job never ran.
- "Published releases must point to a commit on main" → tag points at the
  branch commit, not the merge commit. Delete and recreate the tag on
  `$RELEASE_COMMIT` (allowed only because nothing was published).
- Chrome Web Store step fails on auth → repo variables/secret
  (`CHROME_WEBSTORE_PUBLISHER_ID`, `CHROME_WEBSTORE_EXTENSION_ID`,
  `CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON`); see
  `docs/chrome-web-store.md#publish-step-by-step`. Re-run with
  `workflow_dispatch` (`ref=<version>`, `publish=true`) after fixing; the
  release assets are idempotent (`--clobber`).

## 6. Verify the artifacts

```sh
gh release view <version> --json assets,isDraft,body \
  --jq '{isDraft,assets:[.assets[].name]}'
```

Expect exactly four assets named
`hachidori-<version>-<12-char-sha>-{chrome.zip,firefox-unsigned.xpi,source.zip,SHA256SUMS.txt}`
where the sha is the first 12 characters of `$RELEASE_COMMIT`, and
`isDraft: false`. Download and check them:

```sh
gh release download <version> --dir /tmp/hd-<version> && cd /tmp/hd-<version>
sha256sum -c ./*-SHA256SUMS.txt
unzip -p *-chrome.zip manifest.json | node -p "JSON.parse(require('fs').readFileSync(0)).version"   # <version>
```

Chrome Web Store: the workflow uploads and submits for review with
`DEFAULT_PUBLISH`. Confirm the item shows "Pending review" in the Developer
Dashboard (the user has to look; you cannot). Google's review takes hours to
days; the listing updates by itself on approval.

## 7. Report

Tell the user: the release URL, the merge commit, the workflow run URL and
its three job results, the four asset names with checksum verification
result, and that the CWS submission is pending review. If notes were
generated automatically, link them and ask whether they should be rewritten.

## Do not

- Do not tag a commit that is not the bump merge on `main`.
- Do not bump one manifest without the other.
- Do not reuse or move a tag after the Chrome Web Store job has run.
- Do not include unrelated changes in the bump PR.
- Do not `git push` to `main`.
