| Hash storage | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Warm hash-page reads |
| --- | ---: | ---: | ---: | ---: |
| resident (native) | 0.48 / 0.79 | 0.47 / 0.52 | 2,309 | 0 |
| all paged (native) | 0.61 / 0.89 | 0.63 / 0.76 | 1,692 | 31,494 |

Against resident (native):

| Hash storage | Cold p50 | Warm p50 | Warm p95 | Warm throughput |
| --- | ---: | ---: | ---: | ---: |
| all paged (native) | +0.129 ms (+26.8%) | +0.160 ms (+33.9%) | +0.239 ms (+45.9%) | −26.7% |
