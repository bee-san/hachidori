#!/usr/bin/env python3
"""Package a committed extension and its matching source using only Git/Python."""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parents[1]
ENGINE = "third_party/hoshidicts/"
ENGINE_LICENSES = {
    "hoshidicts-LICENSE": "LICENSE",
    "glaze-LICENSE": "external/glaze/LICENSE",
    "zstd-LICENSE": "external/zstd/LICENSE",
    "zstd-COPYING": "external/zstd/COPYING",
    "unordered_dense-LICENSE": "external/unordered_dense/LICENSE",
    "libdeflate-COPYING": "external/libdeflate/COPYING",
    "utf8proc-LICENSE.md": "external/utf8proc/LICENSE.md",
    "utfcpp-LICENSE": "external/utfcpp/LICENSE",
    "xxHash-LICENSE": "external/xxHash/LICENSE",
    "kanji-processor-LICENSE": "external/kanji-processor/LICENSE",
}


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def tar_entries(data, strip_prefix=""):
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive:
            if member.isdir():
                continue
            if not member.name.startswith(strip_prefix):
                raise ValueError(f"Unexpected archive prefix: {member.name}")
            name = member.name[len(strip_prefix):]
            if not name or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
                raise ValueError(f"Invalid archive path: {name}")
            if member.issym():
                entries[name] = (member.linkname.encode(), 0o120777)
            elif member.isfile():
                entries[name] = (archive.extractfile(member).read(), 0o100755 if member.mode & 0o111 else 0o100644)
            else:
                raise ValueError(f"Unsupported source archive entry: {name}")
    return entries


def git_sources(repo, revision, prefix=""):
    # Read committed objects so a later working-tree edit cannot change this pair.
    entries = {prefix + name: entry for name, entry in tar_entries(git(repo, "archive", revision)).items()}
    revisions = {prefix.rstrip("/") or ".": revision}
    for record in git(repo, "ls-tree", "-rz", revision).split(b"\0"):
        if not record:
            continue
        metadata, raw_name = record.split(b"\t", 1)
        mode, _, object_id = metadata.split()
        if mode == b"160000":
            name = raw_name.decode()
            nested, nested_revisions = git_sources(repo / name, object_id.decode(), prefix + name + "/")
            entries.update(nested)
            revisions.update(nested_revisions)
    return entries, revisions


def download_source(dependency, cache):
    destination = cache / (dependency["sha256"] + ".tar.gz")
    if not destination.exists():
        print(f"Downloading {dependency['name']} {dependency['version']}", flush=True)
        with urllib.request.urlopen(dependency["url"]) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != dependency["sha256"]:
            raise ValueError(f"Source checksum mismatch: {dependency['name']}")
        destination.write_bytes(data)
    data = destination.read_bytes()
    if hashlib.sha256(data).hexdigest() != dependency["sha256"]:
        raise ValueError(f"Cached source checksum mismatch: {dependency['name']}")
    return tar_entries(data, dependency["strip_prefix"])


def write_zip(path, entries):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, (data, mode) in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = mode << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(path) as archive:
        bad_file = archive.testzip()
        if bad_file:
            raise ValueError(f"ZIP integrity failure: {bad_file}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True, help="Directory outside the checkout for both ZIPs and checksums")
    parser.add_argument("--cache-dir", type=Path, default=Path.home() / ".cache/hachidori-store-sources", help="Reusable checksum-verified dependency source cache")
    args = parser.parse_args()
    if args.output_dir.resolve().is_relative_to(ROOT):
        parser.error("Choose an output directory outside the checkout.")
    if git(ROOT, "status", "--porcelain", "--untracked-files=normal").strip():
        parser.error("Commit the intended changes first; release packages require a clean checkout and submodules.")
    revision = git(ROOT, "rev-parse", "HEAD").decode().strip()
    sources, revisions = git_sources(ROOT, revision)
    dependencies = json.loads(sources["scripts/store-sources.json"][0])
    manifest = json.loads(sources["extension/manifest.json"][0])
    stem = f"hachidori-{manifest['version']}-{revision[:12]}"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.cache_dir.mkdir(parents=True, exist_ok=True)

    upload = {name.removeprefix("extension/"): entry for name, entry in sources.items() if name.startswith("extension/")}
    upload["LICENSE"] = sources["LICENSE"]
    upload["privacy.md"] = sources["docs/privacy.md"]
    upload["THIRD_PARTY_NOTICES.md"] = sources["distribution/THIRD_PARTY_NOTICES.md"]
    for name, path in ENGINE_LICENSES.items():
        upload["licenses/" + name] = sources[ENGINE + path]
    for name, entry in sources.items():
        if name.startswith("distribution/licenses/"):
            upload[name.removeprefix("distribution/")] = entry
    for dependency in dependencies:
        if dependency["name"] == "libavif" and dependency["revision"].encode() not in sources["wasm/avif/CMakeLists.txt"][0]:
            raise ValueError("Pinned libavif source no longer matches the build configuration.")
        entries = download_source(dependency, args.cache_dir)
        prefix = "third_party/store-sources/" + dependency["name"] + "/"
        sources.update({prefix + name: entry for name, entry in entries.items()})
        for name in dependency["licenses"]:
            upload[f"licenses/{dependency['name']}/{name}"] = entries[name]
        if dependency["name"] == "zipjs" and entries["dist/zip-core-external.min.js"][0] != upload["vendor/zip.js"][0]:
            raise ValueError("Pinned zip.js source no longer matches the shipped runtime.")

    sources["SOURCE_REVISIONS.json"] = (json_bytes({"repositories": revisions, "dependencies": dependencies}), 0o100644)
    source_name = stem + "-source.zip"
    source_hash = write_zip(args.output_dir / source_name, {stem + "/" + name: entry for name, entry in sources.items()})
    reference = {"version": manifest["version"], "revision": revision, "sourceArchive": source_name, "sourceSha256": source_hash}
    upload["SOURCE.json"] = (json_bytes(reference), 0o100644)
    upload["SOURCE.txt"] = ((
        "Hachidori is licensed under GPL-3.0-or-later. See LICENSE.\n"
        f"Matching source archive: {source_name}\nSHA-256: {source_hash}\n"
        "The publisher distributes this source archive alongside this release.\n"
        "It includes recursive submodule sources, pinned AVIF and zip.js sources,\n"
        "and docs/source-build.md. The store listing provides the download location.\n"
    ).encode(), 0o100644)
    upload_name = stem + "-chrome.zip"
    upload_hash = write_zip(args.output_dir / upload_name, upload)
    checksums = f"{upload_hash}  {upload_name}\n{source_hash}  {source_name}\n"
    (args.output_dir / (stem + "-SHA256SUMS.txt")).write_text(checksums)
    print(checksums, end="")
    print("Publish the matching source archive before uploading the Chrome ZIP; add its public location to the store listing.")


if __name__ == "__main__":
    main()
