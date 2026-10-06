| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 252.9 | 4.84 / 5.97 | 4.69 / 6.06 | 221 | 28.70 / 54.60 |
| PR, resident | 252.9 | 4.86 / 6.47 | 4.75 / 6.04 | 219 | 29.10 / 52.20 |
| PR, 16 MiB budget | 13.1 | 6.08 / 7.60 | 6.09 / 8.34 | 167 | 28.10 / 52.20 |
| PR, 32 MiB budget (default) | 30.5 | 6.05 / 7.55 | 5.82 / 7.36 | 179 | 29.30 / 53.20 |
| PR, 64 MiB budget | 61.0 | 5.99 / 7.81 | 5.63 / 6.93 | 187 | 27.80 / 54.50 |
| PR, all paged | 0.0 | 6.21 / 8.13 | 6.12 / 8.38 | 166 | 30.50 / 53.80 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 357.5 | 357.5 | – | 812.0 | 812.0 |
| PR, resident | 357.5 | 357.5 | 316.7 | 812.8 | 810.4 |
| PR, 16 MiB budget | 69.2 | 99.7 | 76.9 | 564.8 | 556.5 |
| PR, 32 MiB budget (default) | 83.1 | 119.6 | 94.3 | 578.5 | 564.0 |
| PR, 64 MiB budget | 119.6 | 143.6 | 124.8 | 626.5 | 612.8 |
| PR, all paged | 48.0 | 83.1 | 63.8 | 552.6 | 535.0 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 4,052 | 1,499 | 4,055 | 5,357 |
| PR, resident | 3,933 | 1,430 | 3,820 | 5,155 |
| PR, 16 MiB budget | 3,708 | 1,519 | 3,704 | 5,206 |
| PR, 32 MiB budget (default) | 3,808 | 1,488 | 3,730 | 4,805 |
| PR, 64 MiB budget | 4,301 | 1,355 | 3,547 | 4,760 |
| PR, all paged | 3,833 | 1,834 | 3,747 | 6,307 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | +0.02 ms (+0.5%) | +0.50 ms (+8.3%) | +0.06 ms (+1.3%) | −0.02 ms (−0.2%) | −1.3% | +0.0 MiB (+0.0%) | +0.8 MiB (+0.1%) | −1.6 MiB (−0.2%) |
| PR, 16 MiB budget | +1.25 ms (+25.7%) | +1.63 ms (+27.3%) | +1.39 ms (+29.6%) | +2.28 ms (+37.7%) | −24.7% | −257.8 MiB (−72.1%) | −247.2 MiB (−30.4%) | −255.5 MiB (−31.5%) |
| PR, 32 MiB budget (default) | +1.21 ms (+25.1%) | +1.58 ms (+26.5%) | +1.12 ms (+23.9%) | +1.30 ms (+21.4%) | −19.2% | −237.9 MiB (−66.5%) | −233.5 MiB (−28.8%) | −248.0 MiB (−30.5%) |
| PR, 64 MiB budget | +1.15 ms (+23.8%) | +1.84 ms (+30.8%) | +0.94 ms (+19.9%) | +0.87 ms (+14.3%) | −15.7% | −213.9 MiB (−59.8%) | −185.5 MiB (−22.8%) | −199.2 MiB (−24.5%) |
| PR, all paged | +1.37 ms (+28.4%) | +2.16 ms (+36.1%) | +1.42 ms (+30.2%) | +2.32 ms (+38.3%) | −24.8% | −274.4 MiB (−76.8%) | −259.4 MiB (−32.0%) | −277.0 MiB (−34.1%) |
