---
name: cut-release
description: Cut a Hachidori release end to end. On a release/X.Y.Z branch, bump the manifest and add docs/releases/X.Y.Z.md, verify the release contract and packaging locally, then open and squash-merge the PR. Push the bare version tag on the merge commit so release.yml packages the release, creates it from those notes and submits it to the Chrome Web Store, then verify every artifact. Use when asked to release, ship, tag, or bump the version.
---

# Cut a Hachidori release

Input: `$ARGUMENTS` is the new version (e.g. `0.3.2`). If it is omitted, propose
the next patch version from `extension/manifest.json` and confirm with the
user before doing anything.

The release pipeline is `.github/workflows/release.yml`. A pushed tag matching
`[0-9]*` triggers its three jobs:

1. **Package release** refuses a tag that isn't exactly `manifest.version`, a
   tag whose commit is not on `origin/main`, and a manifest or pins that fail
   `scripts/check-release.mjs`.
2. **Publish GitHub release assets** creates the release with the notes from
   `docs/releases/<tag>.md`. Without that file it falls back to generated notes
   plus `.github/release-notes-header.md`. If a release already exists, the job
   only uploads the assets.
3. **Submit Chrome Web Store update** uploads the Chrome ZIP and submits it for
   review.

A tag cannot be reused once its package has been submitted to the store
(`docs/chrome-web-store.md`, "maintain").

Never push to `main` directly (AGENTS.md working agreement). The version bump
and the notes go through a PR. Only the tag is pushed by hand, and only after
the PR has merged.

## 0. Preflight

```sh
git fetch origin --tags
git status --porcelain                  # must be empty; packaging refuses a dirty tree
git submodule update --init --recursive
gh auth status
gh run list --workflow runtime-tests.yml --branch main --limit 1   # main must be green
gh release view <prev>                  # what the last release looked like
gh run list --workflow release.yml --limit 1   # did the last store submission pass?
node -p "require('./extension/manifest.json').version"           # current version
```

Hachidori uses bare `X.Y.Z` tags, with no `v`. Confirm `<version>` does not
already exist: `git tag -l <version>` and `gh release view <version>` should
both come back empty.

If the last run's **Submit Chrome Web Store update** job failed, read its log
before continuing. 0.3.0 got HTTP 400 "Your submission does not meet the
requirements to be published in the store. Check the Developer Dashboard."
Only the owner can resolve that, in the dashboard. Tell the user before you tag.

Check whether the pinned Anki add-on release in `extension/anki-addon.js`
should move with this release (see AGENTS.md → hachidori-anki). If it should,
that is a separate PR that must land BEFORE the release PR.

## 1. Release branch

```sh
git switch -c release/<version> origin/main
```

Change exactly two things:

- the `"version"` field of `extension/manifest.json`, set to `<version>`;
- a new `docs/releases/<version>.md` with the release notes (step 2).

## 2. Write the release notes

Write them in the shape of the previous file (`docs/releases/<prev>.md`):

```
# 🐦 Hachidori <version>

<2–4 sentence summary a learner would care about>

## <emoji> <Feature heading>
<what changed for the reader, with Settings paths in bold> (#PR)

## 📦 Downloads
<the previous file's Downloads section, updated if the asset set changed>

**Full changelog:** https://github.com/bee-san/hachidori/compare/<prev>...<version>
```

Source the list from `git log --oneline <prev>..origin/main`. `main` is
squash-merged, so each commit is `Title (#n)`. Cite the PR in every bullet.
Say what changed for the reader, not in the code.

Check every user-facing claim against the shipped code before committing:

- Run examples (lookups, conjugations) on the real runtime, as `node-smoke.mjs` does.
- Copy labels and messages from `extension/settings.html` and the source.
- State speed only as the measured result in the merged PR, with its range. "No slower" is a claim, not a measurement.

## 3. Verify the release contract locally

```sh
node scripts/check-release.mjs --tag <version>
#   → "Hachidori <version>: Chrome <min> minimum, <cur> current; tag <version>"
node --test test/release-compatibility.test.mjs
node test/run.mjs chrome-backup-release   # the pinned previous release's backup restores here; re-pin after release
git add extension/manifest.json docs/releases/<version>.md
git commit -m "release: prepare Hachidori <version>"
python3 scripts/package-store.py --output-dir /tmp/hachidori-release-<version>
( cd /tmp/hachidori-release-<version> && sha256sum -c ./*-SHA256SUMS.txt )
unzip -p /tmp/hachidori-release-<version>/*-chrome.zip manifest.json \
  | node -p "JSON.parse(require('fs').readFileSync(0)).version"      # <version>
```

`package-store.py` reads committed objects only, so commit first. It produces
`*-chrome.zip`, `*-source.zip` and `*-SHA256SUMS.txt`. If a runtime changed in
this release, also check that the packaged `vendor/hoshidicts*.wasm` files are
byte-identical to the committed ones.

If anything fails, fix the root cause in a separate PR first: pins in
`test/tooling/package.json`, `minimum_chrome_version`, and so on. Do not work
around it in the release PR.

## 4. Open and merge the release PR

```sh
git push -u origin release/<version>
gh pr create --title "Prepare Hachidori <version>" --body-file <body>
```

In the body, list the changes the notes cover, the exact output of each step-3
command, and the result of checking the notes' claims. If the last store
submission failed, add a note for the owner.

Before merging, pass the full merge gate from AGENTS.md: CI green for the exact
head, a clean merge state, no unresolved threads, and SonarCloud with zero
issues and hotspots for that head. Then squash-merge, as #557 (0.3.0) and #562
(0.3.1) were:

```sh
gh pr merge <n> --squash --delete-branch
git switch main && git pull --ff-only
RELEASE_COMMIT=$(git rev-parse HEAD)
git log -1 --format='%H %s' "$RELEASE_COMMIT"   # must be "release: prepare Hachidori <version> (#n)"
node scripts/check-release.mjs --tag <version>
```

Ask the user before merging unless they already said "release it".

## 5. Tag and watch the workflow

Tag the merge commit with a lightweight tag, as for 0.3.0 and 0.3.1:

```sh
git tag <version> "$RELEASE_COMMIT"
git rev-parse <version>^{commit}    # must equal $RELEASE_COMMIT
git push origin refs/tags/<version>
gh run list --workflow release.yml --limit 1
gh run watch <run-id> --exit-status
```

Do not create the release first. The publish job creates it from
`docs/releases/<version>.md`. If you need to edit the notes after publication,
merge the change to that file through a PR, then run
`gh release edit <version> --notes-file docs/releases/<version>.md`.

All three jobs must succeed. On a failure, read
`gh run view <run-id> --log-failed`. Common causes and fixes:

- "manifest.version is not a Chrome-compatible release version", or a tag
  mismatch: the release PR was wrong. Fix it in a new PR, with a NEW version.
  Delete the unused tag or release only if the Chrome Web Store job never ran.
- "Published releases must point to a commit on main": the tag points at the
  branch commit instead of the merge commit. Delete it and recreate it on
  `$RELEASE_COMMIT`. This is allowed only because nothing was published.
- The Chrome Web Store step fails with HTTP 400 "does not meet the
  requirements": the owner must resolve the item in the Developer Dashboard.
- The Chrome Web Store step fails on auth: check the repo variables and secret
  (`CHROME_WEBSTORE_PUBLISHER_ID`, `CHROME_WEBSTORE_EXTENSION_ID`,
  `CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON`); see
  `docs/chrome-web-store.md#publish-step-by-step`.

In either store case, re-run with `workflow_dispatch` (`ref=<version>`,
`publish=true`) once it is fixed. The asset upload is idempotent (`--clobber`).

## 6. Verify the artifacts

```sh
gh release view <version> --json assets,isDraft --jq '{isDraft,assets:[.assets[].name]}'
gh release view <version> --json body --jq .body | diff - docs/releases/<version>.md   # GitHub adds one trailing blank line
gh release download <version> --dir /tmp/hd-<version> && cd /tmp/hd-<version>
sha256sum -c ./*-SHA256SUMS.txt
unzip -p ./*-chrome.zip manifest.json | node -p "JSON.parse(require('fs').readFileSync(0)).version"   # <version>
```

Expect three assets named
`hachidori-<version>-<12-char-sha>-{chrome.zip,source.zip,SHA256SUMS.txt}`,
where the sha is the first 12 characters of `$RELEASE_COMMIT`, and
`isDraft: false`.

A successful store job means the package was uploaded and submitted for review
with `DEFAULT_PUBLISH`. The user has to confirm "Pending review" in the
Developer Dashboard; you cannot see it. Google's review takes hours to days,
and the listing updates by itself on approval.

## 7. Report

Tell the user:

- the release URL and the merge commit;
- the workflow run URL and the result of each of its three jobs;
- the three asset names and the checksum result;
- that the store submission is pending review, or what blocked it.

## Do not

- Do not tag a commit that is not the release PR's squash merge on `main`.
- Do not create the GitHub release by hand before the tag is pushed.
- Do not reuse or move a tag after the Chrome Web Store job has run.
- Do not include unrelated changes in the release PR.
- Do not `git push` to `main`.
