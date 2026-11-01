# Contributing to Hachidori

Thanks for helping make private Japanese lookup easier.

## Before you start

- Search the [open issues](https://github.com/bee-san/hachidori/issues) for related work.
- Open an issue before a large behavior or architecture change.
- Keep pull requests focused enough to review and test independently.

Use the [issue template](https://github.com/bee-san/hachidori/issues/new?template=feature_request.md) and answer its four sections: What is your problem?, Debug log, Why is it a problem?, and What is your ideal solution? GitHub Actions closes incomplete submissions with a comment listing what is missing. Template instructions do not count as answers. If a section does not apply, say why.

## Set up a development checkout

```sh
git clone --recurse-submodules https://github.com/bee-san/hachidori.git
cd hachidori
```

The committed `extension/vendor/hoshidicts.{mjs,wasm}` bundle is enough to load and test ordinary JavaScript changes. Rebuilding it requires Emscripten and CMake; see the [architecture guide](docs/architecture.md).

To run the extension, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension/`. [Its README](extension/README.md) maps what is in that folder. For Firefox, run `python3 scripts/build-firefox.py --output-dir /tmp/hachidori-firefox` and load its `manifest.json` from `about:debugging`; see [the Firefox guide](docs/firefox.md).

## Run the checks

Use Node **22.23.1** (pinned in `.node-version`) and npm **10.9.8**. The relay
checks need Python; CI uses **3.13.2**. Install the locked test-only dependencies:

```sh
npm ci --prefix test/tooling
npm --prefix test/tooling run lint
npm --prefix test/tooling test
npm --prefix test/tooling run test:smoke
```

Run the real-browser test for changes to the manifest, service worker, offscreen lifecycle, IndexedDB persistence, content script, or rendered popup:

```sh
npm --prefix test/tooling run install:chrome
npm --prefix test/tooling run test:chrome
```

Sharing changes also need `npm --prefix test/tooling run test:sharing` and a
usable non-loopback network address. The Runtime tests workflow runs ESLint and
`web-ext lint`, Node contracts, both WASM smoke variants, the extension smoke
suite, the real Chrome suites and the real Firefox suite on pull requests. It
separately runs the primary suites on the manifest-minimum Chrome and Firefox
builds and builds and verifies the checksummed release set. Test tooling stays under `test/tooling` and the browser under ignored
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

[Open an issue using the template](https://github.com/bee-san/hachidori/issues/new?template=feature_request.md). Describe what happens, attach the debug info file from Settings → Advanced → Troubleshooting → Get debug info, explain how the problem affects you, and describe what you would like to happen instead. For a feature request or if you cannot get a log, say so in Debug log. Steps and screenshots are welcome when helpful. Do not attach private dictionaries unless you have permission to share them.

## License

By contributing, you agree that your contribution is licensed under [GPL-3.0-or-later](LICENSE).
