"""The Firefox build's manifest, derived from the Chrome manifest in extension/manifest.json.

Both builds ship the same extension/ files. Firefox has no extension service
worker, offscreen documents, cross-origin isolation for extension pages or tab
capture, and offers userScripts only as an optional permission, so its manifest
names the background page, adds userScripts to the Chrome manifest's optional
permissions and leaves out what Firefox does not implement. It also serves a
sandboxed page only what a web page could load, so the search page's frame
gets its stylesheets and modules as web-accessible resources.
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
# A sandboxed page may link a stylesheet or import a module in Firefox only if
# a web page could: the search page's frame (#644) uses these, which Chrome
# serves it as extension files. Its classic scripts load either way.
SANDBOX_RESOURCES = ("settings.css", "search.css", "content.css", "search.js", "debug-log.js", "error-text.js",
                     "keybind-settings.js", "reader-options.js", "reader-page.js", "search-lines.js",
                     "search-templates.js", "settings-dom.js")


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
    optional = chrome.get("optional_permissions", []) + [
        permission for permission in OPTIONAL_PERMISSIONS if permission in chrome["permissions"]]
    if optional:
        manifest["optional_permissions"] = optional
    manifest["web_accessible_resources"] = [*manifest["web_accessible_resources"],
                                            {"resources": list(SANDBOX_RESOURCES), "matches": ["<all_urls>"]}]
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": GECKO_ID,
            "strict_min_version": MINIMUM_FIREFOX,
            # Firefox shows these at install. Mozilla counts data that leaves the
            # browser for another program, such as Anki, as transmitted (Add-on
            # Policies, section 6). Anki notes carry the page's sentence,
            # screenshot and title, word highlighting asks Anki about page words,
            # pronunciation sources get the looked-up word and a linked browser
            # sends its lookups to the sharing host (docs/privacy.md).
            "data_collection_permissions": {"required": ["websiteContent", "browsingActivity"]},
        },
    }
    return manifest
