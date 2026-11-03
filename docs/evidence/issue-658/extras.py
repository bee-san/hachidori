# extras.py <base-on dump> <fix-on dump>: which metadata-only entries the fix adds.
import sys, collections, re
def load(path):
    out = collections.OrderedDict(); cur = None
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("= "): cur = line[2:]; out[cur] = []
        else: out[cur].append(line)
    return out
def defined(l): return l.split("|G", 1)[1].split("|F", 1)[0] != ""
base, fix = load(sys.argv[1]), load(sys.argv[2])
kana = re.compile(r"^[\u3040-\u309fー]+$"); kata = re.compile(r"[\u30a0-\u30ff]")
pairs = collections.Counter(); kinds = collections.Counter(); positions = collections.Counter()
lost = 0
for text in base:
    b, f = base[text], fix[text]
    bm = set(l for l in b if not defined(l))
    bd = [l for l in b if defined(l)]; fd = [l for l in f if defined(l)]
    lost += len(bd) - len(fd)
    for i, l in enumerate(f):
        if defined(l) or l in bm: continue
        fields = l.split("|")
        expr, reading = fields[4], fields[5]
        pairs[(expr, reading)] += 1
        positions[min(i, 10)] += 1
        has_defined_expr = any(x.split("|")[4] == expr for x in fd)
        if reading == expr: kind = "reads as itself (rows without a reading)"
        elif kata.search(reading) and not kata.search(expr): kind = "katakana reading of a kanji/hiragana word"
        elif has_defined_expr: kind = "other reading of a defined expression"
        else: kind = "expression only a frequency/pitch row has"
        kinds[kind] += 1
print("defined results lost to the max_results cut:", lost)
print("by kind:"); [print(f"  {k}: {v}") for k, v in kinds.most_common()]
print("by position in the list (10 = 10 or later):", dict(sorted(positions.items())))
print("most frequent:"); [print(f"  {e}/{r}: {n}") for (e, r), n in pairs.most_common(40)]
