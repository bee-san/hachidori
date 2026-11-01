# Issue #610 evidence: the search page

Screenshots from the real-Chrome suite's search page step (`test/chrome-e2e/search.mjs`) on PR head
`e903b4c3`, Chrome for Testing 152.0.7977.75, with the suite's fixture dictionaries only:

```sh
HACHIDORI_SEARCH_SCREENSHOTS=docs/evidence/issue-610 node test/run.mjs chrome-e2e
python3 docs/evidence/issue-610/compose.py docs/evidence/issue-610 composite.png
```

| file | what it shows |
| --- | --- |
| `search-page.png` | 食べたかった searched in AUTO (a light browser), the result docked under the box |
| `search-page-dracula.png`, `search-page-default.png`, `search-page-high-contrast.png` | 食べる after a live theme change to Dracula, Default and High contrast |
| `popup-window.png` | 読む in the popup window (600 × 640) |
| `toolbar-menu.png` | the toolbar menu with Search beside Settings |
| `settings-search-page.png` | Settings → Reading → Search page |
| `composite.png` | the search page, the toolbar menu and the popup window side by side (`docs/assets/search-page.png`) |
