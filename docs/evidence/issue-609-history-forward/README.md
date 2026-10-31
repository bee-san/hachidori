# Evidence for #609: Navigate forward in history

Screenshots for the pull request that adds Yomitan's Navigate forward in
history keybind action ([#609](https://github.com/bee-san/hachidori/issues/609)).
Everything here
was produced by `shots.mjs` and `compose.py` with the repository's own test
fixtures (`node test/make-fixture.mjs`: `hachidori-fixture.zip` and
`hachidori-generic-kanji-fixture.zip`), in headless Chrome for Testing
152.0.7977.75 on Linux, at 900 × 760 CSS px and device scale factor 1.

- `history-forward-default.png`, `history-forward-light.png`: the popup in the
  Hachidori (default) and Light palettes, on `main` (cc2bc3c1) and on the
  branch. The script hovers 食べたかった, clicks the headword's 食, presses Alt+B,
  then Alt+F. On `main`, Alt+F leaves the term view as it was (its frame 4 is
  pixel-identical to frame 3). On the branch, Alt+F reopens the kanji view
  (pixel-identical to the clicked view in frame 2), with Back focused.
- `frames/`: the eight frames of each revision at full size.
- `settings-keybinds.png`: Settings → Keybinds on the branch with the default
  bindings: Keybind 8 is Alt + B, Navigate backward in history, and Keybind 9
  is Alt + F, Navigate forward in history.
- `settings-browser-shortcuts.png`: the Browser shortcuts list on the branch,
  where the new unassigned command "Go forward in the popup's history" follows
  "Go back in the popup's history".

To reproduce from a checkout with `npm ci --prefix test/tooling` and the pinned
Chrome installed:

```sh
node test/make-fixture.mjs
git archive cc2bc3c1 extension | tar -x -C /tmp/main
node docs/evidence/issue-609-history-forward/shots.mjs /tmp/main/extension out main
node docs/evidence/issue-609-history-forward/shots.mjs "$PWD/extension" out branch
python3 docs/evidence/issue-609-history-forward/compose.py out /path/to/NotoSansJP-Regular.ttf
```
