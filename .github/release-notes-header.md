## Packages

- `*-chrome.zip`: the Chrome package, also submitted to the Chrome Web Store.
- `*-firefox-unsigned.xpi`: the Firefox 153+ desktop package. It is unsigned and
  not on addons.mozilla.org yet: open `about:debugging#/runtime/this-firefox`,
  choose **Load Temporary Add-on**, and select the `.xpi`. Firefox removes
  temporary add-ons when it closes. Media capture is not available in Firefox.
- `*-source.zip` and `*-SHA256SUMS.txt`: the matching complete source and the
  checksums of every package above.
