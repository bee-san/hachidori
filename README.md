# Keyboard Add in the popup, before and after the focus fix

These captures support the PR "Keep the popup and keyboard focus when an Anki action disables itself". They live on this branch so the feature branch doesn't carry them (#533).

`keyboard-add-palettes.png` shows the reading tab right after pressing Enter on the popup's Anki Add, one row per palette:

- **Left column, `main` (0a00a389):** the popup has closed, so only the page is visible where it was.
- **Right column, the fix (fix/keyboard-anki-focus):** the popup stays open with "Added note N.", and the View in Anki action has keyboard focus.

`capture-keyboard-add.mjs` produced both columns with the real extension loaded unpacked into Chrome for Testing 152.0.7977.75 (headless, reduced motion). For each palette it:

1. imports the test fixture;
2. answers AnkiConnect with an in-memory fake on the worker and offscreen targets;
3. hovers 食べたかった, moves the pointer off the popup, focuses Add from the keyboard and presses Enter;
4. captures the area where the popup was.

The hide delay is the default 160 ms. Forced colours are Chrome's emulation through `Emulation.setEmulatedMedia`, not a real Windows contrast theme. `before.json` and `after.json` record, per palette, whether the popup was hidden, the action's state, whether it had focus, and its status text.

| Palette | `main` | With the fix |
| --- | --- | --- |
| Hachidori (dark) | popup hidden | open, "Added note 1.", action focused |
| Light | popup hidden | open, "Added note 2.", action focused |
| High contrast | popup hidden | open, "Added note 3.", action focused |
| Forced colours, dark | popup hidden | open, "Added note 4.", action focused |
| Forced colours, light | popup hidden | open, "Added note 5.", action focused |
