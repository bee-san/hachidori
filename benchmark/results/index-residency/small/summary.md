| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 0.0 | 1.06 / 2.47 | 0.94 / 1.83 | 995 | 17.20 / 50.10 |
| PR, resident | 0.0 | 1.01 / 2.92 | 1.07 / 1.62 | 963 | 17.20 / 50.10 |
| PR, 16 MiB budget | 0.0 | 1.05 / 1.91 | 0.95 / 1.53 | 1,012 | 17.20 / 50.10 |
| PR, 32 MiB budget (default) | 0.0 | 1.06 / 1.84 | 1.03 / 1.73 | 812 | 17.10 / 50.10 |
| PR, 64 MiB budget | 0.0 | 1.11 / 1.72 | 1.09 / 1.87 | 880 | 17.20 / 50.10 |
| PR, all paged | 0.0 | 1.53 / 3.44 | 1.23 / 1.82 | 711 | 17.30 / 50.10 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 19.3 | 19.3 | – | 368.6 | 358.9 |
| PR, resident | 19.3 | 19.3 | 8.3 | 360.3 | 356.9 |
| PR, 16 MiB budget | 19.3 | 19.3 | 8.3 | 357.3 | 357.3 |
| PR, 32 MiB budget (default) | 19.3 | 19.3 | 8.3 | 367.0 | 357.2 |
| PR, 64 MiB budget | 19.3 | 19.3 | 8.3 | 361.5 | 355.5 |
| PR, all paged | 19.3 | 19.3 | 8.3 | 365.3 | 355.4 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 789 | 160 | 800 | 2,155 |
| PR, resident | 799 | 158 | 740 | 2,156 |
| PR, 16 MiB budget | 807 | 173 | 819 | 2,156 |
| PR, 32 MiB budget (default) | 792 | 150 | 755 | 2,155 |
| PR, 64 MiB budget | 806 | 156 | 814 | 2,155 |
| PR, all paged | 989 | 200 | 914 | 2,156 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | −0.05 ms (−4.7%) | +0.46 ms (+18.7%) | +0.13 ms (+14.4%) | −0.21 ms (−11.5%) | −3.2% | +0.0 MiB (+0.0%) | −8.4 MiB (−2.3%) | −2.0 MiB (−0.6%) |
| PR, 16 MiB budget | −0.01 ms (−0.9%) | −0.55 ms (−22.3%) | +0.02 ms (+1.6%) | −0.29 ms (−16.1%) | +1.7% | +0.0 MiB (+0.0%) | −11.3 MiB (−3.1%) | −1.6 MiB (−0.5%) |
| PR, 32 MiB budget (default) | −0.00 ms (−0.5%) | −0.62 ms (−25.2%) | +0.10 ms (+10.7%) | −0.10 ms (−5.5%) | −18.4% | +0.0 MiB (+0.0%) | −1.6 MiB (−0.4%) | −1.7 MiB (−0.5%) |
| PR, 64 MiB budget | +0.05 ms (+4.2%) | −0.74 ms (−30.0%) | +0.16 ms (+16.6%) | +0.04 ms (+2.2%) | −11.5% | +0.0 MiB (+0.0%) | −7.2 MiB (−1.9%) | −3.4 MiB (−1.0%) |
| PR, all paged | +0.47 ms (+44.3%) | +0.97 ms (+39.4%) | +0.29 ms (+31.6%) | −0.00 ms (−0.3%) | −28.5% | +0.0 MiB (+0.0%) | −3.3 MiB (−0.9%) | −3.5 MiB (−1.0%) |
