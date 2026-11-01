"""The Firefox build's manifest, derived from the Chrome manifest in extension/manifest.json.

Both builds ship the same extension/ files. Firefox has no extension service
worker, offscreen documents, cross-origin isolation for extension pages or tab
capture, and offers userScripts only as an optional permission, so its manifest
names the background page and leaves out what Firefox does not implement.
"""

import copy

GECKO_ID = "hachidori@bee-san"
MINIMUM_FIREFOX = "153.0"
# Only the Firefox build loads these; the Chrome ZIP leaves them out.
FIREFOX_ONLY_FILES = ("background.html", "event-page.js")
CHROME_BACKGROUND = {"service_worker": "background.js", "type": "module"}
UNSUPPORTED_PERMISSIONS = ("offscreen", "tabCapture")
OPTIONAL_PERMISSIONS = ("userScripts",)
CHROME_ONLY_KEYS = ("minimum_chrome_version", "cross_origin_embedder_policy", "cross_origin_opener_policy")


def firefox_manifest(chrome):
    # background.html loads background.js, the script the Chrome service worker runs.
    if chrome.get("background") != CHROME_BACKGROUND:
        raise ValueError(f"background.html runs {CHROME_BACKGROUND}; update it for {chrome.get('background')}")
    manifest = copy.deepcopy(chrome)
    for key in CHROME_ONLY_KEYS:
        manifest.pop(key, None)
    manifest["background"] = {"page": "background.html"}
    manifest["permissions"] = [permission for permission in chrome["permissions"]
                               if permission not in UNSUPPORTED_PERMISSIONS + OPTIONAL_PERMISSIONS]
    optional = [permission for permission in OPTIONAL_PERMISSIONS if permission in chrome["permissions"]]
    if optional:
        manifest["optional_permissions"] = optional
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": GECKO_ID,
            "strict_min_version": MINIMUM_FIREFOX,
            # Hachidori sends nothing to its publisher; it contacts dictionary
            # publishers and the services the user configures (docs/privacy.md).
            "data_collection_permissions": {"required": ["none"]},
        },
    }
    return manifest
