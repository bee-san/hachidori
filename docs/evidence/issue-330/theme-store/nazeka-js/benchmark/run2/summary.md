Chrome Chrome/152.0.7977.75, Node v22.23.1, 5 fresh profiles per side, Intel(R) Xeon(R) Platinum 8488C. Times in ms (median / p95).

| Input | Measure | Default | Nazeka (JS) | Δ median |
|---|---|---|---|---|
| short | hover → first correct frame | 16.8 / 17 | 16.8 / 16.9 | 0 |
|  | hover → complete result | 33.2 / 38.6 | 33.3 / 33.4 | +0.1 |
|  | layout time per scan | 0.63 / 0.9 | 0.37 / 0.53 | -0.26 |
|  | style recalc per scan | 0.7 / 0.9 | 0.56 / 0.78 | -0.14 |
|  | script time per scan | 1.19 / 1.56 | 1.07 / 1.42 | -0.12 |
|  | popup DOM nodes | 32 / 32 | 37 / 37 | +5 |
| long | hover → first correct frame | 17.1 / 56.3 | 17 / 51.4 | -0.1 |
|  | hover → complete result | 33.3 / 81.9 | 33.3 / 80 | 0 |
|  | layout time per scan | 1.73 / 2.56 | 1.55 / 2.38 | -0.18 |
|  | style recalc per scan | 1.38 / 2.65 | 1.62 / 2.79 | +0.24 |
|  | script time per scan | 1.35 / 2.2 | 1.22 / 2.1 | -0.13 |
|  | popup DOM nodes | 228 / 228 | 233 / 233 | +5 |
| deep | hover → first correct frame | 16.9 / 85.6 | 16.8 / 85.3 | -0.1 |
|  | hover → complete result | 33.3 / 112.2 | 33.3 / 116.4 | 0 |
|  | layout time per scan | 0.74 / 1.04 | 0.6 / 1.07 | -0.14 |
|  | style recalc per scan | 0.76 / 1.05 | 0.73 / 1.05 | -0.03 |
|  | script time per scan | 1.13 / 2.24 | 1.06 / 2.24 | -0.07 |
|  | popup DOM nodes | 73 / 73 | 78 / 78 | +5 |
| kanji | click → kanji view in DOM | 3.4 / 8.7 | 4.1 / 10.1 | +0.7 |
|  | click → next frame | 8.8 / 17.1 | 10 / 17 | +1.2 |
|  | layout time per open | 0.37 / 2.92 | 0.62 / 2.58 | +0.25 |
| cold | first hover of a fresh profile | 38.5 / 85.1 | 41.1 / 47.5 | +2.6 |
|  | complete | 54.1 / 89.9 | 49.9 / 50.9 | -4.2 |

theme.js `onRender` (Nazeka, all 280 calls): median 0.1 ms, p95 0.3 ms, max 0.6 ms; per kind — term 0.2 ms p95 (short), 0.2 ms p95 (24 senses), 0.2 ms p95 (deep), kanji 0.5 ms p95.
Reading-tab JS heap at session end: default 4.27 MiB, Nazeka 4.6 MiB (Δ 0.33 MiB).

Budget verdict: onRender p95 0.3 ms ≤ 2 ms → pass; hover regressions (> 5 ms and > 10 %): 0 of 6; kanji open regression: none; heap Δ 0.33 MiB ≤ 2 MiB → pass. Overall: PASS.
