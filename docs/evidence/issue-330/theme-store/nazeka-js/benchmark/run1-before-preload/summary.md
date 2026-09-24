Chrome Chrome/152.0.7977.75, Node v22.23.1, 5 fresh profiles per side, Intel(R) Xeon(R) Platinum 8488C. Times in ms (median / p95).

| Input | Measure | Default | Nazeka (JS) | Δ median |
|---|---|---|---|---|
| short | hover → first correct frame | 16.8 / 21.9 | 16.8 / 17.2 | 0 |
|  | hover → complete result | 33.2 / 39.2 | 33.3 / 42.5 | +0.1 |
|  | layout time per scan | 0.59 / 0.85 | 0.39 / 0.58 | -0.2 |
|  | style recalc per scan | 0.6 / 0.92 | 0.58 / 0.84 | -0.02 |
|  | script time per scan | 1.16 / 3.24 | 1.12 / 2.46 | -0.04 |
|  | popup DOM nodes | 32 / 32 | 37 / 37 | +5 |
| long | hover → first correct frame | 17.1 / 58.2 | 17.1 / 64.4 | 0 |
|  | hover → complete result | 33.3 / 82.5 | 33.3 / 80.3 | 0 |
|  | layout time per scan | 1.67 / 3.47 | 1.57 / 2.69 | -0.1 |
|  | style recalc per scan | 1.35 / 4.51 | 1.64 / 3.35 | +0.29 |
|  | script time per scan | 1.29 / 2.36 | 1.33 / 2.98 | +0.04 |
|  | popup DOM nodes | 228 / 228 | 233 / 233 | +5 |
| deep | hover → first correct frame | 16.9 / 85.8 | 16.8 / 85.5 | -0.1 |
|  | hover → complete result | 33.3 / 109.5 | 33.3 / 116.4 | 0 |
|  | layout time per scan | 0.72 / 1.13 | 0.6 / 1.14 | -0.12 |
|  | style recalc per scan | 0.74 / 1.32 | 0.73 / 1.11 | -0.01 |
|  | script time per scan | 1.12 / 3.23 | 1.12 / 2.45 | 0 |
|  | popup DOM nodes | 73 / 73 | 78 / 78 | +5 |
| kanji | click → kanji view in DOM | 3.3 / 9.2 | 4.1 / 11.7 | +0.8 |
|  | click → next frame | 10.2 / 17.6 | 9.4 / 18.2 | -0.8 |
|  | layout time per open | 0.35 / 2.98 | 0.63 / 3.31 | +0.28 |
| cold | first hover of a fresh profile | 38.5 / 49.2 | 58.2 / 99.9 | +19.7 |
|  | complete | 54.6 / 79.6 | 88.9 / 168.1 | +34.3 |

theme.js `onRender` (Nazeka, all 280 calls): median 0.1 ms, p95 0.3 ms, max 0.7 ms; per kind — term 0.2 ms p95 (short), 0.2 ms p95 (24 senses), 0.2 ms p95 (deep), kanji 0.6 ms p95.
Reading-tab JS heap at session end: default 4.26 MiB, Nazeka 4.62 MiB (Δ 0.36 MiB).

Budget verdict: onRender p95 0.3 ms ≤ 2 ms → pass; hover regressions (> 5 ms and > 10 %): 0 of 6; kanji open regression: none; heap Δ 0.36 MiB ≤ 2 MiB → pass. Overall: PASS.
