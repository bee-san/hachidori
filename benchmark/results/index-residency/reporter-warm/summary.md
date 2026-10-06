| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 249.3 | 2.06 / 4.30 | 1.93 / 4.00 | 467 | 29.10 / 52.20 |
| PR, resident | 249.3 | 2.08 / 4.30 | 1.94 / 3.97 | 464 | 28.90 / 52.00 |
| PR, 16 MiB budget | 15.7 | 2.63 / 5.09 | 2.44 / 4.58 | 389 | 29.00 / 52.30 |
| PR, 32 MiB budget (default) | 32.0 | 2.46 / 4.74 | 2.35 / 4.41 | 404 | 30.20 / 53.90 |
| PR, 64 MiB budget | 60.2 | 2.34 / 4.51 | 2.23 / 4.31 | 420 | 30.00 / 51.90 |
| PR, all paged | 0.0 | 2.96 / 5.21 | 2.91 / 5.10 | 347 | 30.10 / 52.10 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 342.2 | 342.2 | – | 819.6 | 819.6 |
| PR, resident | 342.2 | 342.2 | 318.9 | 820.1 | 819.2 |
| PR, 16 MiB budget | 69.2 | 99.7 | 85.4 | 589.9 | 585.2 |
| PR, 32 MiB budget (default) | 99.7 | 119.6 | 101.7 | 601.7 | 601.3 |
| PR, 64 MiB budget | 119.6 | 143.6 | 129.8 | 630.5 | 630.2 |
| PR, all paged | 57.6 | 83.1 | 69.7 | 573.0 | 572.7 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 3,993 | 2,865 | 3,882 | 5,156 |
| PR, resident | 3,976 | 2,902 | 3,816 | 5,255 |
| PR, 16 MiB budget | 3,812 | 2,891 | 3,608 | 5,006 |
| PR, 32 MiB budget (default) | 3,794 | 2,828 | 3,720 | 4,955 |
| PR, 64 MiB budget | 3,877 | 2,856 | 3,572 | 5,056 |
| PR, all paged | 3,633 | 2,835 | 3,564 | 4,906 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | +0.03 ms (+1.2%) | +0.00 ms (+0.1%) | +0.02 ms (+0.8%) | −0.03 ms (−0.9%) | −0.6% | +0.0 MiB (+0.0%) | +0.5 MiB (+0.1%) | −0.4 MiB (−0.0%) |
| PR, 16 MiB budget | +0.57 ms (+27.7%) | +0.80 ms (+18.6%) | +0.52 ms (+26.7%) | +0.58 ms (+14.5%) | −16.7% | −242.5 MiB (−70.9%) | −229.7 MiB (−28.0%) | −234.4 MiB (−28.6%) |
| PR, 32 MiB budget (default) | +0.40 ms (+19.5%) | +0.44 ms (+10.2%) | +0.42 ms (+21.8%) | +0.41 ms (+10.1%) | −13.5% | −222.6 MiB (−65.0%) | −217.9 MiB (−26.6%) | −218.2 MiB (−26.6%) |
| PR, 64 MiB budget | +0.28 ms (+13.9%) | +0.21 ms (+4.9%) | +0.30 ms (+15.5%) | +0.31 ms (+7.8%) | −10.1% | −198.6 MiB (−58.0%) | −189.1 MiB (−23.1%) | −189.4 MiB (−23.1%) |
| PR, all paged | +0.90 ms (+43.8%) | +0.91 ms (+21.2%) | +0.98 ms (+50.8%) | +1.10 ms (+27.5%) | −25.7% | −259.1 MiB (−75.7%) | −246.6 MiB (−30.1%) | −246.9 MiB (−30.1%) |
