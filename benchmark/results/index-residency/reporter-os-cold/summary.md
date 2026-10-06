| Variant | Resident hashes (MiB) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Hover first / complete (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 249.3 | 12.34 / 57.38 | 1.89 / 3.84 | 468 | 29.80 / 51.90 |
| PR, resident | 249.3 | 11.72 / 57.82 | 1.91 / 3.94 | 472 | 31.00 / 52.40 |
| PR, 16 MiB budget | 15.7 | 22.88 / 74.34 | 2.47 / 4.74 | 385 | 30.30 / 53.70 |
| PR, 32 MiB budget (default) | 32.0 | 21.54 / 69.98 | 2.59 / 5.18 | 364 | 29.80 / 52.40 |
| PR, 64 MiB budget | 60.2 | 18.71 / 65.46 | 2.23 / 4.45 | 406 | 29.60 / 52.80 |
| PR, all paged | 0.0 | 23.18 / 75.35 | 2.75 / 4.94 | 366 | 29.20 / 53.80 |

| Variant | WASM heap after load (MiB) | WASM heap peak (MiB) | Live allocations (MiB) | Extension RSS peak (MiB) | Extension RSS steady (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| main (all resident) | 342.2 | 342.2 | – | 790.9 | 789.4 |
| PR, resident | 342.2 | 342.2 | 318.9 | 786.2 | 786.2 |
| PR, 16 MiB budget | 69.2 | 99.7 | 85.4 | 540.7 | 540.7 |
| PR, 32 MiB budget (default) | 99.7 | 119.6 | 101.7 | 557.9 | 557.9 |
| PR, 64 MiB budget | 119.6 | 143.6 | 129.8 | 594.7 | 594.7 |
| PR, all paged | 57.6 | 83.1 | 69.7 | 528.0 | 528.0 |

| Variant | Startup (ms) | Reimport (ms) | Restart with half disabled (ms) | Idle recycle (ms) |
| --- | ---: | ---: | ---: | ---: |
| main (all resident) | 5,821 | 3,024 | 4,350 | 5,760 |
| PR, resident | 5,885 | 3,098 | 4,492 | 5,907 |
| PR, 16 MiB budget | 5,149 | 2,992 | 4,271 | 5,556 |
| PR, 32 MiB budget (default) | 4,998 | 2,915 | 4,202 | 5,466 |
| PR, 64 MiB budget | 5,045 | 2,936 | 4,273 | 5,505 |
| PR, all paged | 4,815 | 3,099 | 4,088 | 5,556 |

Against main (all resident):

| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | WASM heap peak | Extension RSS peak | Extension RSS steady |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR, resident | −0.62 ms (−5.0%) | +0.44 ms (+0.8%) | +0.01 ms (+0.5%) | +0.09 ms (+2.5%) | +0.9% | +0.0 MiB (+0.0%) | −4.7 MiB (−0.6%) | −3.2 MiB (−0.4%) |
| PR, 16 MiB budget | +10.54 ms (+85.5%) | +16.97 ms (+29.6%) | +0.58 ms (+30.6%) | +0.89 ms (+23.1%) | −17.9% | −242.5 MiB (−70.9%) | −250.2 MiB (−31.6%) | −248.7 MiB (−31.5%) |
| PR, 32 MiB budget (default) | +9.20 ms (+74.6%) | +12.61 ms (+22.0%) | +0.70 ms (+36.9%) | +1.34 ms (+34.9%) | −22.4% | −222.6 MiB (−65.0%) | −233.1 MiB (−29.5%) | −231.5 MiB (−29.3%) |
| PR, 64 MiB budget | +6.37 ms (+51.6%) | +8.08 ms (+14.1%) | +0.34 ms (+17.9%) | +0.61 ms (+15.7%) | −13.2% | −198.6 MiB (−58.0%) | −196.3 MiB (−24.8%) | −194.7 MiB (−24.7%) |
| PR, all paged | +10.84 ms (+87.9%) | +17.97 ms (+31.3%) | +0.85 ms (+44.9%) | +1.09 ms (+28.3%) | −21.9% | −259.1 MiB (−75.7%) | −262.9 MiB (−33.2%) | −261.4 MiB (−33.1%) |
