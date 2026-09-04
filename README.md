<p align="center">
  <img src="docs/assets/hachidori.png" width="180" alt="Hachidori hummingbird logo">
</p>

<h1 align="center">Hachidori</h1>

<p align="center"><strong>Your Japanese dictionaries, on every webpage — fast, private, and entirely in Chrome.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-7c3aed" alt="GPL-3.0-or-later license"></a>
  <a href="#install-in-60-seconds"><img src="https://img.shields.io/badge/Chrome-118%2B-4285F4?logo=googlechrome&logoColor=white" alt="Chrome 118 or newer"></a>
  <a href="#privacy-by-default"><img src="https://img.shields.io/badge/lookups-100%25_local-0f766e" alt="Lookups run locally"></a>
  <a href="https://sonarcloud.io/summary/new_code?id=bee-san_hachidori"><img src="https://sonarcloud.io/api/project_badges/measure?project=bee-san_hachidori&metric=alert_status" alt="SonarQube Cloud quality gate"></a>
  <a href="https://github.com/bee-san/hachidori"><img src="https://img.shields.io/github/stars/bee-san/hachidori?style=flat&logo=github&color=f59e0b" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#install-in-60-seconds">Install</a> ·
  <a href="#use-it">Usage</a> ·
  <a href="#benchmarks">Benchmarks</a> ·
  <a href="#hachidori-vs-the-alternatives">Compare</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

Hachidori turns any Yomitan-compatible `.zip` dictionary into instant Japanese definitions on the page you are reading. Hover a word, see the matching entry, and keep reading. You do not need a native helper, local server, account, or network lookup.

## Install in 60 seconds

```sh
git clone https://github.com/bee-san/hachidori.git
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the cloned `hachidori/extension` directory.
4. Open Hachidori's **Options**, import a Yomitan `.zip`, then hover Japanese text on any page.

Hachidori requires Chrome 118 or newer. The WebAssembly bundle is committed, so using the extension needs no build step and no submodules.

## See it in action

<p align="center">
  <img src="docs/assets/demo.png" alt="Hachidori showing a Japanese dictionary definition while hovering text in Chrome" width="820">
</p>

Hachidori scans forward from the character under your pointer, deinflects forms such as `食べたかった` to `食べる`, ranks matches using your chosen dictionaries, and renders the result beside the text.

## Why Hachidori?

- **Bring your own dictionaries.** Import the same open Yomitan `.zip` ecosystem used by established Japanese-learning tools.
- **Stay on the page.** Definitions appear beside the word under your pointer, including structured content, images, frequencies, pitch accents, and kanji details.
- **Keep lookups private.** The engine, your dictionaries, and every lookup stay inside Chrome.
- **Keep the tool focused.** Hachidori does dictionary import and hover lookup instead of becoming a full study suite.

## Use it

Open Hachidori's options page to:

- import one or more Yomitan dictionaries;
- choose whether each dictionary supplies terms, frequencies, pitch accents, or kanji;
- search titles and aliases, select visible matches, and bulk enable, disable, favourite, or unfavourite them;
- reorder dictionaries by dragging, with the arrow buttons, or by entering a position;
- configure the hover key, delay, scan length, result limit, frequency ranking, and the dictionary opened when you click a kanji.

Selected dictionaries import one at a time, with an outcome retained for every archive; a failure does not stop the rest. Large dictionaries can take several minutes, so keep the page open until the batch finishes.

The kanji dictionary chooser accepts both traditional Yomitan kanji dictionaries and term dictionaries with single-kanji entries.

## Benchmarks

This directional smoke comparison uses the full **VNDB Characters by Bee** dictionary: 6,648,310 term rows, 146,570 media files, a 291.7 MB archive, and 4.46 GB expanded.

<p align="center">
  <img src="docs/assets/benchmark-import.jpg" alt="Import-to-usable benchmark for the 6.65-million-row VNDB Characters by Bee dictionary: Hachidori 15 seconds, JL 4 minutes 6 seconds, and Yomitan 20 minutes 36 seconds" width="820">
</p>

<p align="center">
  <img src="docs/assets/benchmark-hit-latency.jpg" alt="Shared-hit lookup latency benchmark: Hachidori 1.03 milliseconds, JL 4.84 milliseconds, and Yomitan 3.20 milliseconds" width="820">
</p>

<p align="center">
  <img src="docs/assets/benchmark-throughput.jpg" alt="Two-query lookup throughput benchmark: Hachidori 1,108 lookups per second, JL 375, and Yomitan 317" width="820">
</p>

## Hachidori vs the alternatives

| | **Hachidori** | **Yomitan** | **hoshidicts CLI** |
| --- | --- | --- | --- |
| Best for | Focused hover lookups | A complete browser study workflow | Native and command-line integrations |
| Runs in the browser | Yes, including the engine | Yes | No |
| Imports Yomitan dictionaries | Yes | Yes | Yes |
| Hover popup on ordinary pages | Yes | Yes | No built-in browser popup |
| Native helper or local server needed | No | No | The native program itself |
| Audio, Anki, and mining workflows | Deliberately out of scope | Built in or integrated | Build your own integration |

Choose Hachidori when you want the shortest path from a Yomitan dictionary to a private hover definition. Choose Yomitan when you want the broader study ecosystem; choose the hoshidicts CLI when you want the native engine outside a browser.

## Privacy by default

Hachidori makes no network calls. Dictionary archives are imported locally, persisted in Chrome's IndexedDB-backed extension storage, and queried by the bundled WebAssembly engine.

Only import dictionaries you trust. Hachidori validates the archive title before the engine creates its on-disk directory, but dictionary-supplied content and CSS still come from the archive you choose.

## Documentation

- [Architecture and WebAssembly build](docs/architecture.md)
- [Test harness and guarantees](test/README.md)
- [Contributing](CONTRIBUTING.md)
- [Issues and support](https://github.com/bee-san/hachidori/issues)

## Build and test

Building the bundled engine requires [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) and CMake:

```sh
git clone --recurse-submodules https://github.com/bee-san/hachidori.git
cd hachidori
. ./wasm/env.sh && ./wasm/build.sh
```

The fast checks use the committed WebAssembly bundle:

```sh
node test/make-fixture.mjs
node test/node-smoke.mjs
node test/extension-smoke.mjs
```

The [test guide](test/README.md) explains the real-Chrome E2E test, dependencies, fixed assertion counts, and native baseline.

## Contributing

Bug reports, focused pull requests, and documentation improvements are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); if you are unsure where a change belongs, [open an issue](https://github.com/bee-san/hachidori/issues/new).

## Credits

Hachidori is powered by [hoshidicts](https://github.com/Manhhao/hoshidicts) by Manhhao. Its popup renderer, structured-content renderer, furigana segmentation, and CSS are ported from [GameSentenceMiner PR #549](https://github.com/bpwhelan/GameSentenceMiner/pull/549), which adapts [Hoshi Reader](https://github.com/Manhhao/Hoshi-Reader) and [Yomitan](https://github.com/yomidevs/yomitan). See the full [renderer attribution](extension/render/ATTRIBUTION.md).

## License

Hachidori is available under [GPL-3.0-or-later](LICENSE), matching hoshidicts and the ported GameSentenceMiner code.
