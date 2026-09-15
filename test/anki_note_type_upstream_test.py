#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Regression tests for the bounded schema-only APKG reader.

Adapted from Manabitan's GPL-3.0-or-later reader tests at commit
81b149f44426dbfa8bca6af57f3bef9a3af02620.
"""
from contextlib import closing
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import Request
import warnings
import zipfile

SPEC = importlib.util.spec_from_file_location(
    "anki_upstream", Path(__file__).resolve().parents[1] / "scripts/anki-note-type-upstream.py"
)
upstream = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upstream)
HAS_ZSTD = importlib.util.find_spec("zstandard") is not None


def database(schema="legacy", fields=("Word", "Reading")):
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "test.sqlite"
        with closing(sqlite3.connect(path)) as connection, connection:
            if schema == "modern":
                connection.execute("CREATE TABLE notetypes (id INTEGER PRIMARY KEY, name TEXT)")
                connection.execute("CREATE TABLE fields (ntid INTEGER, ord INTEGER, name TEXT)")
                connection.execute("INSERT INTO notetypes VALUES (1, 'Example')")
                connection.executemany("INSERT INTO fields VALUES (1, ?, ?)", list(enumerate(fields))[::-1])
            elif schema == "legacy":
                connection.execute("CREATE TABLE col (models TEXT)")
                connection.execute(
                    "INSERT INTO col VALUES (?)",
                    (
                        json.dumps(
                            {
                                "1": {
                                    "name": "Example",
                                    "flds": [
                                        {"ord": index, "name": name}
                                        for index, name in reversed(list(enumerate(fields)))
                                    ],
                                }
                            }
                        ),
                    ),
                )
            else:
                connection.execute("CREATE TABLE unsupported (value TEXT)")
        return path.read_bytes()


def package(*members):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in members:
            archive.writestr(name, data)
    return output.getvalue()


class PackageReaderTests(unittest.TestCase):
    def test_legacy(self):
        self.assertEqual(
            upstream.extract_models(package(("collection.anki2", database()))),
            [{"name": "Example", "fields": ["Word", "Reading"]}],
        )

    def test_modern_and_field_order(self):
        self.assertEqual(
            upstream.extract_models(package(("collection.anki21", database("modern")))),
            [{"name": "Example", "fields": ["Word", "Reading"]}],
        )

    def test_modern_preferred_over_dummy_legacy(self):
        models = upstream.extract_models(
            package(
                ("collection.anki2", database(fields=("Dummy",))),
                ("collection.anki21", database("modern")),
            )
        )
        self.assertEqual(models[0]["fields"], ["Word", "Reading"])

    @unittest.skipUnless(HAS_ZSTD, "zstandard is required; installed by compatibility CI")
    def test_zstandard_preferred_over_dummy_legacy(self):
        import zstandard

        compressed = zstandard.ZstdCompressor().compress(database("modern"))
        models = upstream.extract_models(
            package(("collection.anki2", database(fields=("Dummy",))), ("collection.anki21b", compressed))
        )
        self.assertEqual(models[0]["fields"], ["Word", "Reading"])

    @unittest.skipUnless(HAS_ZSTD, "zstandard is required; installed by compatibility CI")
    def test_corrupt_zstandard_does_not_fall_back_to_dummy(self):
        with self.assertRaises(Exception):
            upstream.extract_models(
                package(("collection.anki2", database()), ("collection.anki21b", b"corrupt"))
            )

    def test_corrupt_modern_does_not_fall_back(self):
        with self.assertRaisesRegex(ValueError, "not SQLite"):
            upstream.extract_models(
                package(("collection.anki2", database()), ("collection.anki21", b"corrupt"))
            )

    def test_missing_duplicate_and_ambiguous_members_fail(self):
        with self.assertRaisesRegex(ValueError, "Missing or duplicate"):
            upstream.extract_models(package(("../collection.anki2", database())))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            duplicate = package(("collection.anki2", database()), ("collection.anki2", database()))
        with self.assertRaisesRegex(ValueError, "Missing or duplicate"):
            upstream.extract_models(duplicate)
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            upstream.extract_models(
                package(
                    ("collection.anki21", database("modern")),
                    ("collection.anki21b", b"not inspected"),
                )
            )

    def test_unsupported_schema_and_invalid_fields_fail(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            upstream.extract_models(package(("collection.anki21", database("unsupported"))))
        for fields in [("Word", "Word"), (), ("",)]:
            for schema in ("legacy", "modern"):
                with self.subTest(fields=fields, schema=schema):
                    with self.assertRaisesRegex(ValueError, "Invalid note type"):
                        upstream.extract_models(package(("collection.anki2", database(schema, fields))))

    def test_bounds(self):
        with self.assertRaisesRegex(ValueError, "exceeds"):
            upstream.read_bounded(io.BytesIO(b"12345"), 4)
        with patch.object(upstream, "LIMIT", 32):
            with self.assertRaisesRegex(ValueError, "size limit"):
                upstream.extract_models(b"x" * 33)

    def test_checksums(self):
        data = b"package"
        digest = hashlib.sha256(data).hexdigest()
        self.assertEqual(
            upstream.verify_package(data, {"pinnedSha256": digest, "digest": f"sha256:{digest}"}),
            digest,
        )
        for key in ("pinnedSha256", "digest"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "mismatch"):
                upstream.verify_package(data, {key: "invalid"})

    def test_url_allowlist(self):
        for url in [
            "http://github.com/x",
            "https://github.com.evil.example/x",
            "https://localhost/x",
            "file:///etc/passwd",
            "https://u:p@github.com/x",
            "https://github.com:444/x",
        ]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                upstream.validate_url(url)
        upstream.validate_url("https://raw.githubusercontent.com/owner/repo/commit/file.apkg")

    def test_cross_host_redirect_drops_authorization(self):
        request = Request("https://api.github.com/start", headers={"Authorization": "Bearer fake"})
        redirected = upstream.SafeRedirect().redirect_request(
            request, None, 302, "", {}, "https://release-assets.githubusercontent.com/file"
        )
        self.assertFalse(redirected.has_header("Authorization"))

    def test_release_selection_fails_closed(self):
        source = {
            "repository": "owner/repo",
            "kind": "release",
            "revision": "v1",
            "asset": "Model.apkg",
        }
        for assets in [[], [{"name": "a.apkg"}, {"name": "b.apkg"}]]:
            with patch.object(
                upstream,
                "api",
                return_value={"draft": False, "prerelease": False, "assets": assets},
            ):
                with self.assertRaisesRegex(ValueError, "Expected one APKG"):
                    upstream.resolve_source(source, "latest")
        with patch.object(
            upstream,
            "api",
            return_value={"draft": False, "prerelease": True},
        ):
            with self.assertRaisesRegex(ValueError, "stable release"):
                upstream.resolve_source(source, "latest")


if __name__ == "__main__":
    unittest.main()
