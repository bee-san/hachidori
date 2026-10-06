| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 252.9 | 4.47 / 5.53 | 4.41 / 5.56 | 234 | 30.00 / 54.20 |
| PR, resident | 252.9 | 4.69 / 5.81 | 4.45 / 5.51 | 237 | 30.00 / 52.90 |
| PR, 16 MiB budget | 13.1 | 5.66 / 6.89 | 5.48 / 6.79 | 192 | 29.30 / 51.90 |
| PR, 32 MiB budget (default) | 30.5 | 5.53 / 6.81 | 5.36 / 6.45 | 197 | 28.40 / 51.60 |
| PR, 64 MiB budget | 61.0 | 5.43 / 6.77 | 5.27 / 6.32 | 199 | 29.80 / 53.20 |
| PR, all paged | 0.0 | 5.68 / 7.03 | 5.49 / 6.66 | 190 | 29.00 / 52.40 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 357.5 | 357.5 | – | 819.4 | 813.3 |
| PR, resident | 357.5 | 357.5 | 316.7 | 814.8 | 807.1 |
| PR, 16 MiB budget | 69.2 | 99.7 | 76.9 | 567.0 | 567.0 |
| PR, 32 MiB budget (default) | 83.1 | 119.6 | 94.3 | 589.3 | 589.3 |
| PR, 64 MiB budget | 119.6 | 143.6 | 124.9 | 626.0 | 613.8 |
| PR, all paged | 48.0 | 83.1 | 63.8 | 565.4 | 564.1 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 3,959 | 1,155 | 3,857 | 5,105 |
| PR, resident | 3,958 | 1,185 | 3,917 | 5,406 |
| PR, 16 MiB budget | 3,624 | 1,171 | 3,670 | 4,955 |
| PR, 32 MiB budget (default) | 3,657 | 1,177 | 3,615 | 5,055 |
| PR, 64 MiB budget | 3,728 | 1,214 | 3,695 | 4,955 |
| PR, all paged | 3,596 | 1,194 | 3,505 | 4,956 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | +0.23 ms (+5.2%) | +0.29 ms (+5.2%) | +0.04 ms (+0.9%) | −0.05 ms (−1.0%) | +1.2% | +0.0 MiB (+0.0%) | −4.6 MiB (−0.6%) | −6.2 MiB (−0.8%) |
| PR, 16 MiB budget | +1.19 ms (+26.7%) | +1.36 ms (+24.7%) | +1.08 ms (+24.5%) | +1.23 ms (+22.0%) | −18.2% | −257.8 MiB (−72.1%) | −252.5 MiB (−30.8%) | −246.3 MiB (−30.3%) |
| PR, 32 MiB budget (default) | +1.06 ms (+23.7%) | +1.28 ms (+23.2%) | +0.95 ms (+21.6%) | +0.89 ms (+16.0%) | −15.8% | −237.9 MiB (−66.5%) | −230.2 MiB (−28.1%) | −224.1 MiB (−27.5%) |
| PR, 64 MiB budget | +0.97 ms (+21.6%) | +1.24 ms (+22.4%) | +0.86 ms (+19.5%) | +0.76 ms (+13.7%) | −15.1% | −213.9 MiB (−59.8%) | −193.5 MiB (−23.6%) | −199.6 MiB (−24.5%) |
| PR, all paged | +1.22 ms (+27.2%) | +1.51 ms (+27.3%) | +1.09 ms (+24.6%) | +1.10 ms (+19.8%) | −18.9% | −274.4 MiB (−76.8%) | −254.1 MiB (−31.0%) | −249.2 MiB (−30.6%) |
