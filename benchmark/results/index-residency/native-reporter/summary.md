| Hash storage | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Warm hash-page reads |
| --- | ---: | ---: | ---: | ---: |
| resident (native) | 0.23 / 0.58 | 0.19 / 0.43 | 4,734 | 0 |
| all paged (native) | 0.31 / 0.61 | 0.31 / 0.57 | 3,319 | 15,170 |

Against resident (native):

| Hash storage | Cold p50 | Warm p50 | Warm p95 | Warm throughput |
| --- | ---: | ---: | ---: | ---: |
| all paged (native) | +0.083 ms (+35.7%) | +0.128 ms (+69.0%) | +0.147 ms (+34.5%) | −29.9% |
