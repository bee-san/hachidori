# Contributing to Hachidori

Thanks for helping make private Japanese lookup easier.

## Before you start

- Search the [open issues](https://github.com/bee-san/hachidori/issues) for related work.
- Open an issue before a large behavior or architecture change.
- Keep pull requests focused enough to review and test independently.

Use the [issue template](https://github.com/bee-san/hachidori/issues/new?template=feature_request.md), fill in all three sections, and check the acknowledgement. GitHub Actions checks issues when they are opened, edited, or reopened, and closes incomplete submissions with a comment listing what is missing. Template instructions and the acknowledgement do not count as answers. Explain the practical benefit for the creator's Japanese-learning workflow; the [README](README.md#opinionated) describes the project's priorities.

## Set up a development checkout

```sh
git clone --recurse-submodules https://github.com/bee-san/hachidori.git
cd hachidori
```

The committed `extension/vendor/hoshidicts.{mjs,wasm}` bundle is enough to load and test ordinary JavaScript changes. Rebuilding it requires Emscripten and CMake; see the [architecture guide](docs/architecture.md).

To run the extension, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension/`. [Its README](extension/README.md) maps what is in that folder.

## Run the checks

Use Node **22.23.1** (pinned in `.node-version`) and npm **10.9.8**. The relay
checks need Python; CI uses **3.13.2**. Install the locked test-only dependencies:

```sh
npm ci --prefix test/tooling
npm --prefix test/tooling test
npm --prefix test/tooling run test:smoke
```

Run the real-browser test for changes to the manifest, service worker, offscreen lifecycle, IndexedDB persistence, content script, or rendered popup:

```sh
npm --prefix test/tooling run install:chrome
npm --prefix test/tooling run test:chrome
```

Sharing changes also need `npm --prefix test/tooling run test:sharing` and a
usable non-loopback network address. The Runtime tests workflow runs Node
contracts, both WASM smoke variants, the extension smoke suite, and four real
Chrome suites on pull requests. It separately runs the primary suite on the
manifest-minimum Chrome build and builds and verifies the checksummed release
pair. Test tooling stays under `test/tooling` and the browser under ignored
`test/tmp/browsers`; neither ships in the extension.
[The test harness guide](test/README.md) contains the exact CI commands, browser
dependencies, external-tooling overrides, and what each suite proves.

## Pull requests

A useful pull request includes:

- the user-visible problem and the chosen behavior;
- focused source changes without generated dependency trees;
- the checks that were run and their exact outcomes;
- screenshots for visible UI changes;
- updated documentation when installation, behavior, or architecture changes.

The real-browser suite gives each assertion a fixed name and predeclares its denominator. When extending it, add the planned assertion before its implementation so a code path that never runs cannot look like a smaller successful suite.

## Reporting bugs

[Open an issue using the template](https://github.com/bee-san/hachidori/issues/new?template=feature_request.md). Put your Chrome version, the smallest reproducible page or dictionary, the behavior you expected, and what happened instead in the Problem section. Explain how a fix would help the creator in Benefit to the creator, and describe any solution or workaround you have considered (or say if you have none) in Proposed solution and alternatives. Check the acknowledgement. Do not attach private dictionaries unless you have permission to share them.

## License

By contributing, you agree that your contribution is licensed under [GPL-3.0-or-later](LICENSE).
