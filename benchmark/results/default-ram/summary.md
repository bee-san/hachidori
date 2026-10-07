| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 249.3 | 2.13 / 4.73 | 1.99 / 4.40 | 434 | 25.70 / 53.00 |
| PR, 65 MiB budget (default) | 60.2 | 2.44 / 5.13 | 2.31 / 4.88 | 385 | 26.50 / 55.80 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 342.2 | 342.2 | 318.9 | 827.9 | 826.0 |
| PR, 65 MiB budget (default) | 119.6 | 143.6 | 129.8 | 635.9 | 633.8 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 5,668 | 2,873 | 4,776 | – |
| PR, 65 MiB budget (default) | 5,620 | 2,805 | 5,127 | – |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, 65 MiB budget (default) | +0.31 ms (+14.3%) | +0.40 ms (+8.6%) | +0.32 ms (+15.8%) | +0.48 ms (+10.9%) | −11.2% | −198.6 MiB (−58.0%) | −192.0 MiB (−23.2%) | −192.2 MiB (−23.3%) |

Retried after a failed attempt: PR, 65 MiB budget #3 (ProtocolError: Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a hi).
