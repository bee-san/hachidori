# bench-wasm-summary.py <bench-wasm.log>: medians of each variant's passes.
import collections, re, statistics, sys
t = collections.defaultdict(lambda: collections.defaultdict(list)); chars = collections.defaultdict(set)
for line in open(sys.argv[1]):
    m = re.match(r"(\S+) round (\d+) pass (\d): ([\d.]+) ms, (\d+) reply characters", line)
    if m:
        v, r, p, ms, c = m.groups(); t[v][int(p)].append(float(ms)); chars[v].add(int(c))
base = statistics.median(t["main-off"][2])
for v in ("main-off", "fix-off", "main-on", "fix-on"):
    p2, p1 = t[v][2], t[v][1]
    print(f"{v}: pass-2 median {statistics.median(p2):,.0f} ms ({100*(statistics.median(p2)/base-1):+.1f}% vs main off), "
          f"range {min(p2):,.0f}-{max(p2):,.0f}, n={len(p2)}; pass-1 median {statistics.median(p1):,.0f} ms; "
          f"reply characters {sorted(chars[v])}")
on = statistics.median(t["fix-on"][2]) / statistics.median(t["main-on"][2]) - 1
off = statistics.median(t["fix-off"][2]) / statistics.median(t["main-off"][2]) - 1
print(f"fix-off vs main-off: {100*off:+.1f}%; fix-on vs main-on: {100*on:+.1f}%")
