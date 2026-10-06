| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 34.9 | 0.84 / 1.24 | 0.78 / 1.03 | 1,239 | 17.10 / 50.10 |
| PR, resident | 34.9 | 0.84 / 1.15 | 0.79 / 1.05 | 1,213 | 17.10 / 50.10 |
| PR, 16 MiB budget | 0.0 | 0.91 / 1.23 | 0.78 / 1.06 | 1,220 | 17.10 / 50.10 |
| PR, 32 MiB budget (default) | 0.0 | 0.84 / 1.23 | 0.76 / 1.03 | 1,250 | 17.10 / 50.10 |
| PR, 64 MiB budget | 34.9 | 1.03 / 1.53 | 0.81 / 1.13 | 1,181 | 17.10 / 50.10 |
| PR, all paged | 0.0 | 0.91 / 1.28 | 0.82 / 1.07 | 1,174 | 17.10 / 50.10 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 62.5 | 62.5 | – | 422.8 | 422.8 |
| PR, resident | 62.5 | 62.5 | 51.4 | 426.6 | 426.6 |
| PR, 16 MiB budget | 23.1 | 27.8 | 18.8 | 390.8 | 390.8 |
| PR, 32 MiB budget (default) | 23.1 | 27.8 | 18.8 | 391.7 | 391.7 |
| PR, 64 MiB budget | 62.5 | 62.5 | 51.4 | 424.0 | 424.0 |
| PR, all paged | 23.1 | 27.8 | 18.8 | 393.4 | 393.4 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 842 | 4,805 | 829 | 2,206 |
| PR, resident | 779 | 4,974 | 799 | 2,205 |
| PR, 16 MiB budget | 790 | 4,767 | 734 | 2,156 |
| PR, 32 MiB budget (default) | 825 | 4,830 | 721 | 2,155 |
| PR, 64 MiB budget | 841 | 5,042 | 781 | 2,155 |
| PR, all paged | 796 | 4,944 | 744 | 2,155 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | −0.01 ms (−1.2%) | −0.09 ms (−6.9%) | +0.01 ms (+1.3%) | +0.01 ms (+1.0%) | −2.2% | +0.0 MiB (+0.0%) | +3.8 MiB (+0.9%) | +3.8 MiB (+0.9%) |
| PR, 16 MiB budget | +0.06 ms (+7.7%) | −0.01 ms (−0.4%) | +0.00 ms (+0.0%) | +0.03 ms (+2.4%) | −1.5% | −34.8 MiB (−55.6%) | −32.0 MiB (−7.6%) | −32.0 MiB (−7.6%) |
| PR, 32 MiB budget (default) | +0.00 ms (+0.0%) | −0.01 ms (−0.8%) | −0.02 ms (−1.9%) | −0.01 ms (−1.0%) | +0.9% | −34.8 MiB (−55.6%) | −31.1 MiB (−7.4%) | −31.1 MiB (−7.4%) |
| PR, 64 MiB budget | +0.18 ms (+21.3%) | +0.29 ms (+23.9%) | +0.03 ms (+3.8%) | +0.09 ms (+8.7%) | −4.7% | +0.0 MiB (+0.0%) | +1.2 MiB (+0.3%) | +1.2 MiB (+0.3%) |
| PR, all paged | +0.06 ms (+7.7%) | +0.04 ms (+3.6%) | +0.04 ms (+5.1%) | +0.03 ms (+3.4%) | −5.2% | −34.8 MiB (−55.6%) | −29.4 MiB (−7.0%) | −29.4 MiB (−7.0%) |
