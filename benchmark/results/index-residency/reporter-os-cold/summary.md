| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 249.3 | 11.77 / 58.06 | 1.86 / 3.96 | 483 | 28.30 / 53.40 |
| PR, resident | 249.3 | 11.90 / 57.95 | 1.86 / 4.18 | 468 | 28.10 / 53.20 |
| PR, 16 MiB budget | 15.7 | 23.01 / 71.79 | 2.42 / 4.71 | 391 | 27.70 / 53.40 |
| PR, 32 MiB budget (default) | 32.0 | 21.34 / 69.36 | 2.43 / 4.72 | 391 | 28.20 / 52.50 |
| PR, 64 MiB budget | 60.2 | 18.63 / 64.52 | 2.16 / 4.40 | 426 | 28.60 / 53.50 |
| PR, all paged | 0.0 | 23.29 / 75.21 | 2.84 / 5.12 | 357 | 28.70 / 53.30 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 342.2 | 342.2 | – | 788.8 | 788.8 |
| PR, resident | 342.2 | 342.2 | 318.9 | 797.3 | 795.8 |
| PR, 16 MiB budget | 69.2 | 99.7 | 85.4 | 543.1 | 543.1 |
| PR, 32 MiB budget (default) | 99.7 | 119.6 | 101.7 | 578.3 | 578.3 |
| PR, 64 MiB budget | 119.6 | 143.6 | 129.8 | 607.2 | 597.7 |
| PR, all paged | 57.6 | 83.1 | 69.7 | 528.4 | 528.4 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 5,562 | 4,251 | 4,246 | 5,455 |
| PR, resident | 5,541 | 4,355 | 4,699 | 5,505 |
| PR, 16 MiB budget | 4,807 | 4,266 | 4,016 | 5,306 |
| PR, 32 MiB budget (default) | 4,719 | 4,185 | 3,971 | 5,255 |
| PR, 64 MiB budget | 5,187 | 4,511 | 3,961 | 5,305 |
| PR, all paged | 4,619 | 4,209 | 3,860 | 5,105 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | +0.13 ms (+1.1%) | −0.11 ms (−0.2%) | +0.00 ms (+0.3%) | +0.22 ms (+5.6%) | −3.2% | +0.0 MiB (+0.0%) | +8.5 MiB (+1.1%) | +7.0 MiB (+0.9%) |
| PR, 16 MiB budget | +11.24 ms (+95.4%) | +13.73 ms (+23.6%) | +0.56 ms (+30.5%) | +0.75 ms (+18.8%) | −19.1% | −242.5 MiB (−70.9%) | −245.8 MiB (−31.2%) | −245.8 MiB (−31.2%) |
| PR, 32 MiB budget (default) | +9.56 ms (+81.2%) | +11.30 ms (+19.5%) | +0.57 ms (+31.0%) | +0.77 ms (+19.3%) | −19.2% | −222.6 MiB (−65.0%) | −210.5 MiB (−26.7%) | −210.5 MiB (−26.7%) |
| PR, 64 MiB budget | +6.86 ms (+58.3%) | +6.46 ms (+11.1%) | +0.30 ms (+16.4%) | +0.44 ms (+11.1%) | −11.8% | −198.6 MiB (−58.0%) | −181.6 MiB (−23.0%) | −191.1 MiB (−24.2%) |
| PR, all paged | +11.52 ms (+97.8%) | +17.15 ms (+29.5%) | +0.99 ms (+53.4%) | +1.16 ms (+29.2%) | −26.2% | −259.1 MiB (−75.7%) | −260.4 MiB (−33.0%) | −260.4 MiB (−33.0%) |
