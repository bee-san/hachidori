# hd_lookup with a large clipboard (audit-hachi-issue-639 FIX1)

`scripts/bench-lookup-tail.mjs` (audit-hachi-issue-639's variant of `bench-lookup.mjs`: `BENCH_CLIP_LEN` sets the clipboard's length, the stalled phase is dropped, and each phase records lookups over 10, 50 and 100 ms) on Chrome 152.0.7977.75, run in this order: main-1M-1, before-1M-1, after-1M-1, after-1M-2, before-1M-2, main-1M-2, before-300k-1, after-300k-1, after-100k-1, after-1k-1. Each run is 3 rounds of 5 s of back-to-back `hd_lookup` from Settings with no search page open, then 5 s with one polling (on `main` the page has no monitor). `before` is `9e7f0cc0`, `after` is `c4c20ba7` (the fix, on `main` `3b7730f1`; rebased unchanged as `a9e8ac88`..`59abf2c5`). Raw results: `fix1-<revision>-<size>-<run>.txt`.

| clipboard | revision | runs × rounds | lookups per 5 s, no search page / polling | polling: lookups over 100 ms per round | polling: slowest lookup (ms) | polling: median (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000,000 | `main` `3b7730f1` (no monitor) | 2 × 3 | 4,561-5,582 / 4,403-5,196 | 0, 0, 0, 0, 0, 0 | 13.9-19.7 | 0.820-0.935 |
| 1,000,000 | `9e7f0cc0` (before) | 2 × 3 | 4,550-5,795 / 2,513-3,379 | 12, 12, 12, 12, 12, 13 | 152.8-174.1 | 0.825-0.985 |
| 1,000,000 | `c4c20ba7` (after) | 2 × 3 | 4,960-5,689 / 3,661-4,743 | 0, 0, 0, 0, 0, 0 | 22.6-33.7 | 0.835-0.990 |
| 300,000 | `9e7f0cc0` (before) | 1 × 3 | 4,762-5,600 / 4,708-4,987 | 0, 0, 0 | 32.2-33.5 | 0.795-0.815 |
| 300,000 | `c4c20ba7` (after) | 1 × 3 | 4,440-5,692 / 4,148-4,681 | 0, 0, 0 | 13.6-21.7 | 0.865-0.940 |
| 100,000 | `c4c20ba7` (after) | 1 × 3 | 4,665-4,914 / 4,014-4,324 | 0, 0, 0 | 13.6-16.3 | 0.905-0.965 |
| 1,000 | `c4c20ba7` (after) | 1 × 3 | 4,825-5,170 / 3,971-5,275 | 0, 0, 0 | 16.6-20.8 | 0.820-0.960 |

An undefined `hd_lookup` reply happens now and then on `main` too (`oddReplies` in each result; 3 in main-1M-1); those lookups are left out of the timings.
