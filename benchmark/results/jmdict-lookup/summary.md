# JMdict lookup: Hachidori vs Yomitan

Hachidori 4653b838, Yomitan 26.10.12.0, JMdict [2026-11-01] (527628 terms), Chromium 156.0.8078.79 Arch Linux.
5 measured installs per reader, 5 passes of 337 lookups each.

| Metric | Hachidori | Yomitan | Ratio |
| --- | ---: | ---: | ---: |
| Lookup p50 | 2.71 ms | 7.30 ms | 2.7× |
| Lookup p90 | 5.29 ms | 13.90 ms | 2.6× |
| Lookup p95 | 6.14 ms | 17.20 ms | 2.8× |
| Lookup p99 | 7.84 ms | 26.25 ms | 3.3× |
| Mean lookup | 3.11 ms | 8.53 ms | 2.7× |
| Lookups per second | 321 | 117 | 2.7× |
| Import to first lookup (median) | 1.3 s | 46.3 s | 36× |
| Per-install lookup p50 | 2.74, 2.62, 2.43, 3.46, 2.37 | 7.50, 7.20, 7.40, 6.80, 7.60 |  |
