#!/usr/bin/env python3
"""Write the working tree's extension/ with the Firefox manifest, to load in Firefox or lint.

Release packages come from scripts/package-store.py, which reads committed files.
"""

import argparse
import json
from pathlib import Path
import shutil

from firefox_manifest import GECKO_ID, firefox_manifest

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"


def previous_build(directory):
    try:
        manifest = json.loads((directory / "manifest.json").read_text())
    except (OSError, ValueError):
        return False
    return manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id") == GECKO_ID


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="New or empty directory, or an earlier output of this script, to write the build to")
    args = parser.parse_args()
    output = args.output_dir.resolve()
    if output.is_relative_to(EXTENSION) or EXTENSION.is_relative_to(output):
        parser.error("Choose an output directory outside extension/.")
    if output.exists() and any(output.iterdir()) and not previous_build(output):
        parser.error(f"{output} is not empty and is not an earlier Firefox build.")
    manifest = firefox_manifest(json.loads((EXTENSION / "manifest.json").read_text()))
    shutil.rmtree(output, ignore_errors=True)
    shutil.copytree(EXTENSION, output)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(output)


if __name__ == "__main__":
    main()
