| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 249.3 | 2.17 / 4.81 | 2.04 / 4.33 | 440 | 28.70 / 52.60 |
| PR, resident | 249.3 | 2.03 / 4.49 | 1.91 / 4.17 | 470 | 28.80 / 52.90 |
| PR, 16 MiB budget | 15.7 | 2.70 / 5.17 | 2.59 / 4.87 | 369 | 29.30 / 53.30 |
| PR, 32 MiB budget (default) | 32.0 | 2.62 / 5.32 | 2.64 / 5.15 | 356 | 30.10 / 54.10 |
| PR, 64 MiB budget | 60.2 | 2.48 / 4.94 | 2.47 / 4.97 | 378 | 29.90 / 53.90 |
| PR, all paged | 0.0 | 3.06 / 5.64 | 2.98 / 5.34 | 341 | 29.00 / 56.20 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 342.2 | 342.2 | – | 821.2 | 813.2 |
| PR, resident | 342.2 | 342.2 | 318.9 | 821.5 | 821.5 |
| PR, 16 MiB budget | 69.2 | 99.7 | 85.4 | 593.5 | 590.1 |
| PR, 32 MiB budget (default) | 99.7 | 119.6 | 101.7 | 604.9 | 594.1 |
| PR, 64 MiB budget | 119.6 | 143.6 | 129.8 | 647.5 | 635.9 |
| PR, all paged | 57.6 | 83.1 | 69.7 | 572.4 | 572.4 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 4,314 | 4,269 | 3,805 | 5,059 |
| PR, resident | 4,007 | 4,156 | 3,830 | 5,164 |
| PR, 16 MiB budget | 3,703 | 4,152 | 3,762 | 5,005 |
| PR, 32 MiB budget (default) | 3,849 | 4,243 | 3,597 | 4,905 |
| PR, 64 MiB budget | 3,940 | 4,268 | 3,873 | 4,905 |
| PR, all paged | 3,673 | 4,236 | 3,488 | 5,061 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | −0.14 ms (−6.7%) | −0.31 ms (−6.6%) | −0.14 ms (−6.6%) | −0.16 ms (−3.7%) | +6.8% | +0.0 MiB (+0.0%) | +0.3 MiB (+0.0%) | +8.3 MiB (+1.0%) |
| PR, 16 MiB budget | +0.53 ms (+24.4%) | +0.37 ms (+7.6%) | +0.55 ms (+27.2%) | +0.54 ms (+12.3%) | −16.2% | −242.5 MiB (−70.9%) | −227.7 MiB (−27.7%) | −223.2 MiB (−27.4%) |
| PR, 32 MiB budget (default) | +0.45 ms (+20.7%) | +0.51 ms (+10.7%) | +0.60 ms (+29.4%) | +0.82 ms (+18.8%) | −19.0% | −222.6 MiB (−65.0%) | −216.3 MiB (−26.3%) | −219.2 MiB (−27.0%) |
| PR, 64 MiB budget | +0.31 ms (+14.3%) | +0.13 ms (+2.8%) | +0.43 ms (+21.1%) | +0.64 ms (+14.6%) | −14.0% | −198.6 MiB (−58.0%) | −173.7 MiB (−21.2%) | −177.4 MiB (−21.8%) |
| PR, all paged | +0.90 ms (+41.2%) | +0.84 ms (+17.4%) | +0.94 ms (+46.1%) | +1.01 ms (+23.3%) | −22.6% | −259.1 MiB (−75.7%) | −248.8 MiB (−30.3%) | −240.8 MiB (−29.6%) |

Retried after a failed attempt: main (all resident) #3 (Error: Waiting failed: 180000ms exceeded).
