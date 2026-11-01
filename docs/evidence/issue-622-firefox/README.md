# Evidence for issue #622: Hachidori for Firefox

Screenshots of the Firefox build of `issue-622-firefox` at 744c6961, in Firefox
159.0 on Linux, taken through the real-Firefox suite's session helpers with the
synthetic test fixture (`test/make-fixture.mjs`). No real dictionary data.

- `firefox-popup.png`: a Shift-hover lookup of 食べたかった on the suite's page:
  the deinflected headword with furigana, frequency, pitch accents, lookup count
  and structured definitions, as in Chrome.
- `firefox-shortcuts.png`: Settings → Keybinds → browser shortcuts, whose
  button opens Firefox's add-on shortcut manager.
- `firefox-user-scripts.png`: Settings → Design → Custom JavaScript before the
  optional `userScripts` permission is granted, with the Allow user scripts
  button.
- `firefox-local-files.png`: Settings → Lookup → Read saved pages too, with
  Firefox's about:addons instructions and no button, since extensions cannot
  open that page.
