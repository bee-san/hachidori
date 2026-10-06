| Hash storage | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Warm hash-page reads |
| --- | ---: | ---: | ---: | ---: |
| resident (native) | 0.50 / 0.79 | 0.49 / 0.63 | 2,216 | 0 |
| all paged (native) | 0.63 / 0.89 | 0.66 / 0.88 | 1,571 | 31,494 |

Against resident (native):

| Hash storage | Cold p50 | Warm p50 | Warm p95 | Warm throughput |
| --- | ---: | ---: | ---: | ---: |
| all paged (native) | +0.128 ms (+25.4%) | +0.168 ms (+34.1%) | +0.247 ms (+39.1%) | −29.1% |
