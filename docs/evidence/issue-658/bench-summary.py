import statistics, collections, sys
t = collections.defaultdict(list)
for line in open(sys.argv[1]):
    _, r, v, ms = line.split(); t[v].append(float(ms.rstrip('ms')))
base = statistics.median(t['base-off'])
for v in ('base-off', 'fix-off', 'base-on', 'fix-on'):
    m = statistics.median(t[v])
    print(f"{v}: median {m:.0f} ms ({100*(m/base-1):+.1f}% vs base-off), min {min(t[v]):.0f}, max {max(t[v]):.0f}")
on = statistics.median(t['fix-on']) / statistics.median(t['base-on']) - 1
print(f"fix-on vs base-on: {100*on:+.1f}%")
