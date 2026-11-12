# Anki definition group Settings rendering

The production Settings controller was measured with 50 mapped fields and 20
dictionary groups. Each process performs 25 warm-up renders, then 20 samples of
25 unchanged renders. The driver excludes discovery, initial DOM construction,
browser layout, lookup and Anki traffic.

```sh
node benchmark/anki-group-settings.mjs --runs 20 --source BASELINE
node benchmark/anki-group-settings.mjs --runs 20
```

`BASELINE` is a checkout of `8f2ddb184b019f21814f39145a4d2afbe05ba5e8`.
The first three pairs measured `3f20c2fcb8ca3bc0acec3a5b70d4d1e9da52104d`;
later pairs measured `22cd68dd`. The production Settings files are identical
between these group revisions. Each pair alternates process order. The raw
report includes exact revisions, Node version, CPU, every sample and commands:
[`anki-group-settings-benchmark.json`](../assets/anki-group-settings-benchmark.json).

| Conditions | Baseline median, ms | Groups median, ms |
| --- | --- | --- |
| Earlier shared desktop, pair 1 | 0.741 | 0.797 |
| Earlier shared desktop, pair 2 | 0.819 | 0.836 |
| Earlier shared desktop, pair 3 | 0.801 | 0.775 |
| Concurrent browser checks, pair 1 | 0.950 | 1.733 |
| Concurrent browser checks, pair 2 | 1.505 | 1.638 |
| Concurrent browser checks, pair 3 | 1.620 | 3.108 |
| Concurrent checks, CPU 2 affinity, pair 1 | 1.041 | 1.062 |
| Concurrent checks, CPU 2 affinity, pair 2 | 1.110 | 1.184 |
| Concurrent checks, CPU 2 affinity, pair 3 | 1.064 | 1.208 |

The shared desktop produces substantial scheduling noise; CPU affinity is
`taskset -c 2` for the driver and its children, not exclusive CPU ownership.
The affinity repetitions show 0.02–0.14 ms additional median controller work
per render, including the two new group selectors. Their p95 values remain
noisy (baseline 3.92–4.05 ms, groups 4.13–5.06 ms). These measurements establish
neither an end-to-end regression estimate nor a speedup.

An initial implementation serialized the complete marker catalogue separately
for every field on every render. Review removed that unnecessary work: the
controller now computes one group name/ID key per render and shares stable
marker options until that key changes. Existing editors and their drafts stay
in place. The production browser harness separately verifies group policy,
saved selectors and an unchanged dictionary generation after group-only edits.
