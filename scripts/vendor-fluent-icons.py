# SPDX-License-Identifier: GPL-3.0-or-later
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen
import json

ROOT = Path(__file__).resolve().parents[1]
REVISION = "9cf8af0f95a555918a60b8147a2f33a6a1248442"
NAMES = ["add", "document-add", "document-edit", "book-search", "speaker-2", "edit", "checkmark", "error-circle", "more-horizontal", "arrow-clockwise", "arrow-sync", "subtract", "dismiss", "open", "arrow-up", "arrow-down", "arrow-right", "star", "reorder", "settings", "desktop"]
BASE = f"https://raw.githubusercontent.com/microsoft/fluentui-system-icons/{REVISION}/"
DEST = ROOT / "extension/icons/fluent"
DEST.mkdir(parents=True, exist_ok=True)
for path in DEST.glob("*.svg"):
    if path.stem not in NAMES:
        path.unlink()

def download(name):
    title = " ".join(word.capitalize() for word in name.split("-"))
    path = f"assets/{title}/SVG/ic_fluent_{name.replace('-', '_')}_20_regular.svg"
    svg = urlopen(BASE + quote(path)).read().decode().strip()
    (DEST / f"{name}.svg").write_text(svg + "\n")
    return name, path, svg

icons = list(ThreadPoolExecutor(max_workers=8).map(download, NAMES))
ALIASES = {
    "speaker-2": ['.gsm-hoshidicts-audio-button::before'],
    "more-horizontal": ['.gsm-hoshidicts-audio-button[data-state="loading"]::before', '.operational-status.is-working::before'],
    "error-circle": ['.gsm-hoshidicts-audio-button[data-state="error"]::before', '.operational-status.is-error::before'],
    "checkmark": ['.operational-status.is-ready::before'],
    "subtract": ['.operational-status:not(.is-working):not(.is-ready):not(.is-error)::before'],
    "dismiss": ['.gsm-hoshidicts-popup-close::before'],
    "open": ['.gloss-link-external-icon'],
}
(DEST / "LICENSE").write_bytes(urlopen(BASE + "LICENSE").read())
(DEST / "sources.json").write_text(json.dumps({"repository": "microsoft/fluentui-system-icons", "revision": REVISION, "icons": {name: path for name, path, svg in icons}}, indent=2) + "\n")
css = '/* SPDX-License-Identifier: GPL-3.0-or-later */\n'
css += ',\n'.join(['.hd-icon', '.gsm-hoshidicts-audio-button::before', '.gsm-hoshidicts-popup-close::before', '.gloss-link-external-icon', '.operational-status::before']) + ' {\n  content: "";\n  display: inline-block;\n  flex: 0 0 auto;\n  width: 20px;\n  height: 20px;\n  vertical-align: middle;\n  background: currentColor;\n  mask: var(--hd-icon) center / contain no-repeat;\n}\n.hd-icon[hidden] { display: none; }\n'
css += '@media (forced-colors: active) {\n  ' + ',\n  '.join(['.hd-icon', '.gsm-hoshidicts-audio-button::before', '.gsm-hoshidicts-popup-close::before', '.gloss-link-external-icon', '.operational-status::before']) + ' { forced-color-adjust: none; background: CanvasText; }\n}\n'
for name, path, svg in icons:
    uri = 'url("data:image/svg+xml,' + quote(svg, safe='') + '")'
    selectors = ',\n'.join([f'.hd-icon[data-icon="{name}"]'] + ALIASES.get(name, []))
    css += f'{selectors} {{ --hd-icon: {uri}; }}\n'
(ROOT / "extension/icons.css").write_text(css)
