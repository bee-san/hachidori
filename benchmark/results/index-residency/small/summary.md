| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 0.0 | 1.03 / 2.42 | 0.97 / 1.59 | 970 | 17.20 / 50.10 |
| PR, resident | 0.0 | 1.14 / 2.06 | 0.99 / 1.78 | 856 | 17.30 / 50.10 |
| PR, 16 MiB budget | 0.0 | 1.07 / 2.98 | 0.99 / 1.56 | 922 | 17.10 / 50.10 |
| PR, 32 MiB budget (default) | 0.0 | 0.95 / 2.17 | 0.92 / 1.33 | 1,054 | 17.20 / 50.10 |
| PR, 64 MiB budget | 0.0 | 0.98 / 1.86 | 0.92 / 1.47 | 1,040 | 17.20 / 50.10 |
| PR, all paged | 0.0 | 0.95 / 2.17 | 0.97 / 1.44 | 1,028 | 17.10 / 50.10 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 19.3 | 19.3 | – | 353.3 | 353.3 |
| PR, resident | 19.3 | 19.3 | 8.3 | 352.4 | 352.4 |
| PR, 16 MiB budget | 19.3 | 19.3 | 8.3 | 355.2 | 355.2 |
| PR, 32 MiB budget (default) | 19.3 | 19.3 | 8.3 | 356.3 | 354.8 |
| PR, 64 MiB budget | 19.3 | 19.3 | 8.3 | 359.3 | 355.4 |
| PR, all paged | 19.3 | 19.3 | 8.3 | 355.6 | 355.0 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 820 | 147 | 771 | 2,155 |
| PR, resident | 805 | 145 | 737 | 2,156 |
| PR, 16 MiB budget | 786 | 154 | 743 | 2,156 |
| PR, 32 MiB budget (default) | 788 | 156 | 800 | 2,155 |
| PR, 64 MiB budget | 802 | 159 | 793 | 2,156 |
| PR, all paged | 741 | 147 | 770 | 2,155 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | +0.11 ms (+10.7%) | −0.36 ms (−14.8%) | +0.03 ms (+2.6%) | +0.19 ms (+11.9%) | −11.8% | +0.0 MiB (+0.0%) | −1.0 MiB (−0.3%) | −1.0 MiB (−0.3%) |
| PR, 16 MiB budget | +0.04 ms (+4.4%) | +0.56 ms (+22.9%) | +0.02 ms (+2.6%) | −0.04 ms (−2.5%) | −5.0% | +0.0 MiB (+0.0%) | +1.9 MiB (+0.5%) | +1.9 MiB (+0.5%) |
| PR, 32 MiB budget (default) | −0.08 ms (−7.8%) | −0.26 ms (−10.7%) | −0.05 ms (−4.7%) | −0.26 ms (−16.3%) | +8.6% | +0.0 MiB (+0.0%) | +3.0 MiB (+0.9%) | +1.5 MiB (+0.4%) |
| PR, 64 MiB budget | −0.04 ms (−3.9%) | −0.56 ms (−23.3%) | −0.04 ms (−4.7%) | −0.12 ms (−7.5%) | +7.1% | +0.0 MiB (+0.0%) | +6.0 MiB (+1.7%) | +2.1 MiB (+0.6%) |
| PR, all paged | −0.07 ms (−6.8%) | −0.25 ms (−10.3%) | +0.00 ms (+0.5%) | −0.15 ms (−9.4%) | +5.9% | +0.0 MiB (+0.0%) | +2.3 MiB (+0.6%) | +1.7 MiB (+0.5%) |
