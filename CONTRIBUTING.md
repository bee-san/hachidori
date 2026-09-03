# Contributing to Hachidori

Thanks for helping make private Japanese lookup easier.

## Before you start

- Search the [open issues](https://github.com/bee-san/hachidori/issues) for related work.
- Open an issue before a large behavior or architecture change.
- Keep pull requests focused enough to review and test independently.

## Set up a development checkout

```sh
git clone --recurse-submodules https://github.com/bee-san/hachidori.git
cd hachidori
```

The committed `extension/vendor/hoshidicts.{mjs,wasm}` bundle is enough to load and test ordinary JavaScript changes. Rebuilding it requires Emscripten and CMake; see the [architecture guide](docs/architecture.md).

To run the extension, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension/`.

## Run the checks

```sh
node test/make-fixture.mjs
node test/node-smoke.mjs
node test/extension-smoke.mjs
```

Run the real-browser test for changes to the manifest, service worker, offscreen lifecycle, IndexedDB persistence, content script, or rendered popup:

```sh
node test/chrome-e2e.mjs
```

The browser and jsdom dependencies live outside the repository. [The test harness guide](test/README.md) contains setup commands, the native baseline, and an exact account of what each suite proves.

## Pull requests

A useful pull request includes:

- the user-visible problem and the chosen behavior;
- focused source changes without generated dependency trees;
- the checks that were run and their exact outcomes;
- screenshots for visible UI changes;
- updated documentation when installation, behavior, or architecture changes.

The real-browser suite gives each assertion a fixed name and predeclares its denominator. When extending it, add the planned assertion before its implementation so a code path that never runs cannot look like a smaller successful suite.

## Reporting bugs

[Open an issue](https://github.com/bee-san/hachidori/issues/new) with your Chrome version, the smallest reproducible page or dictionary, the behavior you expected, and what happened instead. Do not attach private dictionaries unless you have permission to share them.

## License

By contributing, you agree that your contribution is licensed under [GPL-3.0-or-later](LICENSE).
