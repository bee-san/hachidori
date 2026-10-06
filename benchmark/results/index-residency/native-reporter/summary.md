| Hash storage | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Warm hash-page reads |
| --- | ---: | ---: | ---: | ---: |
| resident (native) | 0.22 / 0.55 | 0.18 / 0.41 | 4,894 | 0 |
| all paged (native) | 0.31 / 0.59 | 0.30 / 0.55 | 3,452 | 15,170 |

Against resident (native):

| Hash storage | Cold p50 | Warm p50 | Warm p95 | Warm throughput |
| --- | ---: | ---: | ---: | ---: |
| all paged (native) | +0.089 ms (+40.2%) | +0.120 ms (+65.2%) | +0.134 ms (+32.2%) | −29.5% |
