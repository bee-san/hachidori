| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 34.9 | 0.86 / 1.23 | 0.77 / 0.99 | 1,266 | 17.10 / 50.10 |
| PR, resident | 34.9 | 0.81 / 1.14 | 0.75 / 0.99 | 1,296 | 17.10 / 50.10 |
| PR, 16 MiB budget | 0.0 | 0.85 / 1.14 | 0.75 / 0.97 | 1,282 | 17.10 / 50.10 |
| PR, 32 MiB budget (default) | 0.0 | 0.85 / 1.17 | 0.73 / 1.00 | 1,275 | 17.10 / 50.10 |
| PR, 64 MiB budget | 34.9 | 0.88 / 1.24 | 0.75 / 1.01 | 1,296 | 17.00 / 50.10 |
| PR, all paged | 0.0 | 0.92 / 1.17 | 0.80 / 1.05 | 1,212 | 17.10 / 50.10 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 62.5 | 62.5 | – | 422.5 | 422.5 |
| PR, resident | 62.5 | 62.5 | 51.4 | 421.9 | 421.9 |
| PR, 16 MiB budget | 23.1 | 33.3 | 18.8 | 388.4 | 388.4 |
| PR, 32 MiB budget (default) | 23.1 | 33.3 | 18.8 | 389.6 | 389.6 |
| PR, 64 MiB budget | 62.5 | 62.5 | 51.4 | 421.0 | 421.0 |
| PR, all paged | 23.1 | 33.3 | 18.8 | 388.9 | 388.9 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 844 | 3,220 | 802 | 2,155 |
| PR, resident | 769 | 3,066 | 779 | 2,156 |
| PR, 16 MiB budget | 808 | 3,076 | 729 | 2,155 |
| PR, 32 MiB budget (default) | 769 | 3,073 | 760 | 2,155 |
| PR, 64 MiB budget | 848 | 3,075 | 765 | 2,206 |
| PR, all paged | 765 | 3,142 | 784 | 2,155 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | −0.05 ms (−5.3%) | −0.09 ms (−7.7%) | −0.02 ms (−2.0%) | −0.00 ms (−0.5%) | +2.4% | +0.0 MiB (+0.0%) | −0.6 MiB (−0.1%) | −0.6 MiB (−0.1%) |
| PR, 16 MiB budget | −0.01 ms (−0.6%) | −0.09 ms (−7.7%) | −0.01 ms (−1.3%) | −0.03 ms (−3.0%) | +1.2% | −29.2 MiB (−46.7%) | −34.2 MiB (−8.1%) | −34.2 MiB (−8.1%) |
| PR, 32 MiB budget (default) | −0.01 ms (−1.2%) | −0.06 ms (−4.9%) | −0.03 ms (−3.9%) | +0.01 ms (+0.5%) | +0.7% | −29.2 MiB (−46.7%) | −32.9 MiB (−7.8%) | −32.9 MiB (−7.8%) |
| PR, 64 MiB budget | +0.03 ms (+3.5%) | +0.01 ms (+0.8%) | −0.02 ms (−2.6%) | +0.02 ms (+2.0%) | +2.4% | +0.0 MiB (+0.0%) | −1.5 MiB (−0.4%) | −1.5 MiB (−0.4%) |
| PR, all paged | +0.06 ms (+7.0%) | −0.06 ms (−4.9%) | +0.03 ms (+4.6%) | +0.06 ms (+5.5%) | −4.3% | −29.2 MiB (−46.7%) | −33.6 MiB (−7.9%) | −33.6 MiB (−7.9%) |

Retried after a failed attempt: PR, 64 MiB budget #3 (ProtocolError: Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a hi).
