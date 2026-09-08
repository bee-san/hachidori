# Building a distributed source archive

Each release's `hachidori-<version>-<commit>-source.zip` includes Hachidori's
tracked files, the complete recursive Hoshidicts submodules, and the pinned
libavif, libaom and unminified zip.js sources. It contains no Git metadata and
does not require access to a private repository. `SOURCE_REVISIONS.json`
records the repository commits and downloaded dependency checksums.

The Chrome upload ZIP contains `LICENSE`, the dependency notices,
`SOURCE.txt` and `SOURCE.json`. The source reference names the accompanying
archive and its SHA-256. Publish that exact source archive at a public download
location and put the location in the store listing before distributing the
extension. A private GitHub repository link is not a substitute for that
download.

## Load the JavaScript source

Extract the archive. Open `chrome://extensions`, enable **Developer mode**,
choose **Load unpacked**, and select its `extension/` directory. Committed
Wasm files are included, so JavaScript development needs no compiler.

## Rebuild the dictionary engine

Install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html)
with C++23 support, CMake 3.31 or newer, and a native build tool. Activate the
SDK environment so `emcmake`, `emcc`, and `em++` are on `PATH`. Run these commands
from the extracted archive's top-level directory:

```sh
emcmake cmake -S wasm -B wasm/build -DCMAKE_BUILD_TYPE=Release -DHACHIDORI_PTHREADS=ON
cmake --build wasm/build --parallel
emcmake cmake -S wasm -B wasm/build-fallback -DCMAKE_BUILD_TYPE=Release -DHACHIDORI_PTHREADS=OFF
cmake --build wasm/build-fallback --parallel
cp wasm/build/hoshidicts-threaded.mjs wasm/build/hoshidicts-threaded.wasm extension/vendor/
cp wasm/build-fallback/hoshidicts.mjs wasm/build-fallback/hoshidicts.wasm extension/vendor/
```

The source archive already includes each CMake dependency under
`third_party/hoshidicts/external/`; no submodule checkout is needed.

## Rebuild the AVIF encoder

Use the source archive's bundled dependencies to avoid fetching them during
configuration:

```sh
emcmake cmake -S wasm/avif -B wasm/avif/build -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DFETCHCONTENT_SOURCE_DIR_LIBAVIF="$PWD/third_party/store-sources/libavif" \
  -DFETCHCONTENT_SOURCE_DIR_LIBAOM="$PWD/third_party/store-sources/libaom"
cmake --build wasm/avif/build --parallel
cp wasm/avif/build/avif-encoder.mjs wasm/avif/build/avif-encoder.wasm extension/vendor/
```

The sources are libavif 1.3.0 at
`1aadfad932c98c069a1204261b1856f81f3bc199` and libaom 3.12.1 at
`10aece4157eb79315da205f39e19bf6ab3ee30d0`. Both libavif's small libyuv subset
and libaom's internal dependencies are present in those archives. Other AVIF
codecs and external libyuv are disabled by `wasm/avif/CMakeLists.txt`.

Packaging pins libaom's official release archive. Its source files and executable
modes match that commit, while the Gitiles archive endpoint rewrites timestamps
on each request and cannot provide a stable download checksum.

## zip.js and validation

`third_party/store-sources/zipjs/lib/` contains zip.js 2.11.2's editable source;
its upstream `README.md` and `package.json` describe the library. The release
uses its existing `dist/zip-core-external.min.js`, copied unchanged to
`extension/vendor/zip.js`. No npm install or JavaScript build is needed to
restore that shipped file:

```sh
cp third_party/store-sources/zipjs/dist/zip-core-external.min.js extension/vendor/zip.js
node test/make-fixture.mjs
node test/node-smoke.mjs
node test/extension-smoke.mjs
```

See [the test guide](../test/README.md) for the browser suite and its external
test dependencies. The packaging command verifies archive checksums and file
integrity; it does not compile or run these runtime suites.

These instructions preserve the source revisions and build settings. The
historical committed Wasm files do not record the exact compiler version, so
they do not establish byte-for-byte reproduction of those binaries. Record
`emcc --version`, `cmake --version`, build commands and test results whenever
publishing newly built Wasm files.

## Produce a release pair from a Git checkout

Commit the intended release changes and initialize recursive submodules. With
Python 3.9 or newer and Git installed:

```sh
git submodule update --init --recursive
python3 scripts/package-store.py --output-dir /tmp/hachidori-store
```

The command refuses a dirty checkout, reads only committed Git objects, and
writes the upload ZIP, source ZIP and `SHA256SUMS.txt` outside the repository.
Its first run downloads only checksum-pinned dependency sources. Pass
`--cache-dir /path/to/cache` to reuse them across machines or offline runs.
ZIP paths, timestamps, order and permissions are normalized, giving identical
bytes when repeated with the same commit and Python/zlib version. ZIP integrity
is checked before checksums are written. Load unpacked from an extracted Chrome
ZIP to check the exact staged runtime before uploading it.
