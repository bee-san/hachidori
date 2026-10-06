| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 249.3 | 2.05 / 4.37 | 1.94 / 4.03 | 463 | 27.80 / 53.20 |
| PR, resident | 249.3 | 2.10 / 4.52 | 2.13 / 4.42 | 422 | 28.70 / 53.70 |
| PR, 16 MiB budget | 15.7 | 2.72 / 5.13 | 2.65 / 5.03 | 364 | 28.00 / 52.90 |
| PR, 32 MiB budget (default) | 32.0 | 2.54 / 5.03 | 2.41 / 4.68 | 395 | 29.20 / 52.80 |
| PR, 64 MiB budget | 60.2 | 2.31 / 4.73 | 2.25 / 4.44 | 414 | 27.70 / 54.10 |
| PR, all paged | 0.0 | 3.00 / 5.42 | 2.89 / 5.10 | 353 | 28.60 / 53.30 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 342.2 | 342.2 | – | 821.1 | 821.1 |
| PR, resident | 342.2 | 342.2 | 318.9 | 820.4 | 819.6 |
| PR, 16 MiB budget | 69.2 | 99.7 | 85.4 | 589.0 | 585.9 |
| PR, 32 MiB budget (default) | 99.7 | 119.6 | 101.7 | 602.8 | 599.5 |
| PR, 64 MiB budget | 119.6 | 143.6 | 129.8 | 633.2 | 630.8 |
| PR, all paged | 57.6 | 83.1 | 69.7 | 575.4 | 564.6 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 4,179 | 4,081 | 3,722 | 5,105 |
| PR, resident | 3,868 | 4,214 | 3,718 | 5,005 |
| PR, 16 MiB budget | 3,730 | 4,118 | 3,463 | 4,956 |
| PR, 32 MiB budget (default) | 3,810 | 4,413 | 3,559 | 5,056 |
| PR, 64 MiB budget | 3,700 | 4,106 | 3,770 | 4,811 |
| PR, all paged | 3,464 | 4,078 | 3,522 | 4,756 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | +0.06 ms (+2.7%) | +0.15 ms (+3.4%) | +0.19 ms (+9.5%) | +0.39 ms (+9.8%) | −8.8% | +0.0 MiB (+0.0%) | −0.7 MiB (−0.1%) | −1.4 MiB (−0.2%) |
| PR, 16 MiB budget | +0.67 ms (+32.7%) | +0.75 ms (+17.3%) | +0.70 ms (+36.0%) | +1.00 ms (+24.9%) | −21.4% | −242.5 MiB (−70.9%) | −232.1 MiB (−28.3%) | −235.2 MiB (−28.6%) |
| PR, 32 MiB budget (default) | +0.49 ms (+23.9%) | +0.66 ms (+15.2%) | +0.47 ms (+23.9%) | +0.65 ms (+16.1%) | −14.7% | −222.6 MiB (−65.0%) | −218.2 MiB (−26.6%) | −221.6 MiB (−27.0%) |
| PR, 64 MiB budget | +0.26 ms (+12.4%) | +0.36 ms (+8.1%) | +0.31 ms (+15.7%) | +0.41 ms (+10.2%) | −10.4% | −198.6 MiB (−58.0%) | −187.8 MiB (−22.9%) | −190.2 MiB (−23.2%) |
| PR, all paged | +0.96 ms (+46.6%) | +1.05 ms (+24.0%) | +0.94 ms (+48.6%) | +1.07 ms (+26.6%) | −23.7% | −259.1 MiB (−75.7%) | −245.7 MiB (−29.9%) | −256.5 MiB (−31.2%) |
