# check.py <base-on dump> <fix-on dump>: ordering properties of the fix (option on).
import sys, collections
def load(path):
    out = collections.OrderedDict(); cur = None
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("= "):
            cur = line[2:]; out[cur] = []
        else:
            out[cur].append(line)
    return out
def defined(l): return l.split("|G", 1)[1].split("|F", 1)[0] != ""
def mlen(l): return len(l.split("|", 1)[0].encode())
base, fix = load(sys.argv[1]), load(sys.argv[2])
assert list(base) == list(fix)
stats = collections.Counter()
for text in base:
    b, f = base[text], fix[text]
    stats["inputs"] += 1
    if (b[:1] != f[:1]): stats["first result differs"] += 1
    bd = [l for l in b if defined(l)]; fd = [l for l in f if defined(l)]
    if fd != bd[:len(fd)]: stats["defined order differs"] += 1
    if len(fd) < len(bd): stats["defined cut by max_results"] += 1
    bm = [l for l in b if not defined(l)]; fm = [l for l in f if not defined(l)]
    if len(f) < 32 and not set(bm) <= set(fm): stats["base metadata result missing"] += 1
    extra = len(fm) - len(bm)
    if extra > 0: stats["inputs with extra metadata-only results"] += 1; stats["extra metadata-only results"] += extra
    if bm: stats["inputs with leading (longer) metadata-only results, base"] += 1
    for x, y in zip(f, f[1:]):
        if mlen(x) < mlen(y): stats["length order broken"] += 1; break
        if mlen(x) == mlen(y) and not defined(x) and defined(y): stats["metadata before defined at equal length"] += 1; break
    lead_b = [l for l in b[:next((i for i, l in enumerate(b) if defined(l)), len(b))]]
    lead_f = [l for l in f[:next((i for i, l in enumerate(f) if defined(l)), len(f))]]
    if lead_b != lead_f: stats["leading metadata-only results differ"] += 1
for k in ["inputs", "first result differs", "leading metadata-only results differ", "defined order differs",
          "defined cut by max_results", "base metadata result missing", "length order broken",
          "metadata before defined at equal length", "inputs with leading (longer) metadata-only results, base",
          "inputs with extra metadata-only results", "extra metadata-only results"]:
    print(f"{k}: {stats[k]}")
