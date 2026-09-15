#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Read field schemas from fixed upstream APKGs without importing or rendering them.

Adapted from Manabitan's GPL-3.0-or-later dev/anki-note-type-upstream.py at
commit 81b149f44426dbfa8bca6af57f3bef9a3af02620.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 128 * 1024 * 1024
HOSTS = {
    "api.github.com",
    "github.com",
    "raw.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
}


class SafeRedirect(HTTPRedirectHandler):
    """Permit only the fixed GitHub hosts and never forward API credentials."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and urlsplit(newurl).netloc != urlsplit(req.full_url).netloc:
            redirected.remove_header("Authorization")
        return redirected


def validate_url(url: str) -> None:
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or parts.hostname not in HOSTS
        or parts.username
        or parts.password
        or parts.port not in (None, 443)
    ):
        raise ValueError(f"Unexpected upstream URL: {url}")


def read_bounded(stream, limit: int = LIMIT) -> bytes:
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"Input exceeds {limit} bytes")
    return data


def download(url: str, limit: int = LIMIT) -> bytes:
    validate_url(url)
    headers = {"User-Agent": "Hachidori-Anki-Compatibility", "Accept": "application/octet-stream"}
    if urlsplit(url).hostname == "api.github.com":
        headers["Accept"] = "application/vnd.github+json"
        token = os.environ.get("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
    for attempt in range(3):
        try:
            with build_opener(SafeRedirect()).open(Request(url, headers=headers), timeout=45) as response:
                return read_bounded(response, limit)
        except (HTTPError, URLError, TimeoutError) as error:
            retryable = not isinstance(error, HTTPError) or error.code in (429, 500, 502, 503, 504)
            if not retryable or attempt == 2:
                raise
            time.sleep(2**attempt)
    raise AssertionError("Unreachable")


def api(path: str):
    return json.loads(download(f"https://api.github.com/{path}", 4 * 1024 * 1024))


def resolve_source(source: dict, mode: str) -> dict:
    if source["kind"] != "release":
        raise ValueError(f"Unknown source kind: {source['kind']}")
    endpoint = "latest" if mode == "latest" else f"tags/{quote(source['revision'], safe='')}"
    release = api(f"repos/{source['repository']}/releases/{endpoint}")
    if release["draft"] or release["prerelease"]:
        raise ValueError("Expected a published stable release")
    assets = [asset for asset in release["assets"] if asset["name"].lower().endswith(".apkg")]
    if mode == "pinned":
        assets = [asset for asset in assets if asset["name"] == source["asset"]]
    if len(assets) != 1:
        raise ValueError(f"Expected one APKG, found {[asset['name'] for asset in assets]}")
    asset = assets[0]
    if asset["size"] > LIMIT:
        raise ValueError("APKG exceeds download limit")
    return {
        "revision": release["tag_name"],
        "publishedAt": release["published_at"],
        "asset": asset["name"],
        "url": asset["browser_download_url"],
        "digest": asset.get("digest"),
        "pinnedSha256": source.get("sha256") if mode == "pinned" else None,
    }


def verify_package(data: bytes, resolved: dict) -> str:
    digest = hashlib.sha256(data).hexdigest()
    for expected in (resolved.get("pinnedSha256"), (resolved.get("digest") or "").removeprefix("sha256:")):
        if expected and digest != expected:
            raise ValueError(f"APKG SHA-256 mismatch: expected {expected}, received {digest}")
    return digest


def collection_member(archive: zipfile.ZipFile) -> str:
    names = archive.namelist()
    modern = [name for name in ("collection.anki21b", "collection.anki21") if name in names]
    if len(modern) > 1:
        raise ValueError("Ambiguous modern collection members")
    member = modern[0] if modern else ("collection.anki2" if "collection.anki2" in names else None)
    if member is None or names.count(member) != 1:
        raise ValueError("Missing or duplicate collection member")
    return member


def extract_models(data: bytes) -> list[dict]:
    if len(data) > LIMIT:
        raise ValueError("APKG exceeds size limit")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 10000:
            raise ValueError("Too many archive members")
        # Modern exports include a dummy anki2 database. Prefer the real modern
        # collection and never fall back to the dummy when that collection fails.
        member = collection_member(archive)
        if archive.getinfo(member).file_size > LIMIT:
            raise ValueError("Collection exceeds size limit")
        with archive.open(member) as stream:
            collection = read_bounded(stream)
        if member == "collection.anki21b":
            import zstandard

            with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(collection)) as stream:
                collection = read_bounded(stream)
    if not collection.startswith(b"SQLite format 3\0"):
        raise ValueError("Collection is not SQLite")
    with tempfile.TemporaryDirectory(prefix="hachidori-anki-") as folder:
        path = Path(folder) / "collection.sqlite"
        path.write_bytes(collection)
        database = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
        try:
            database.execute("PRAGMA trusted_schema=OFF")
            database.execute("PRAGMA query_only=ON")
            deadline = time.monotonic() + 10
            database.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {"notetypes", "fields"} <= tables:
                models = [
                    {
                        "name": name,
                        "fields": [
                            field[0]
                            for field in database.execute(
                                "SELECT name FROM fields WHERE ntid=? ORDER BY ord", (note_type_id,)
                            )
                        ],
                    }
                    for note_type_id, name in database.execute("SELECT id, name FROM notetypes ORDER BY id")
                ]
            elif "col" in tables:
                row = database.execute("SELECT models FROM col").fetchone()
                if row is None:
                    raise ValueError("Collection has no model metadata")
                models = [
                    {
                        "name": model["name"],
                        "fields": [field["name"] for field in sorted(model["flds"], key=lambda field: field["ord"])],
                    }
                    for model in json.loads(row[0]).values()
                ]
            else:
                raise ValueError("Unsupported collection schema")
        finally:
            database.close()
    if not models:
        raise ValueError("Collection contains no note types")
    for model in models:
        fields = model["fields"]
        if (
            not isinstance(model["name"], str)
            or not model["name"]
            or not fields
            or len(fields) > 256
            or any(not isinstance(field, str) or not field for field in fields)
            or len(set(fields)) != len(fields)
        ):
            raise ValueError("Invalid note type or duplicate field names")
    return models


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("pinned", "latest"), default="pinned")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    contracts = json.loads((ROOT / "test/data/anki-note-types/contracts.json").read_text())
    report = {"mode": args.mode, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": []}
    failed = False
    for contract in contracts:
        result = {"id": contract["id"], "repository": contract["source"]["repository"]}
        try:
            resolved = resolve_source(contract["source"], args.mode)
            result.update(resolved)
            package = download(resolved["url"])
            result["sha256"] = verify_package(package, resolved)
            result["models"] = extract_models(package)
            result["status"] = "downloaded"
        except Exception as error:
            failed = True
            result.update(status="error", error=f"{type(error).__name__}: {error}")
        report["results"].append(result)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
