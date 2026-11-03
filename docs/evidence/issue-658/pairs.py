# pairs.py: Jiten's (expression, reading) pairs against the term dictionaries
# of Hachidori's recommended set, from the archives the #620 audit downloaded.
import json, sys, zipfile, collections
D = "/local/home/skerraut/herd-synth3/reports/audit-hachi-fix-620-evidence/dicts"
TERM = ["jitendex-yomitan.zip", "JMnedict.zip", "bees-ultimate-kanji-dictionary.zip", "bees-ultimate-grammar-dictionary.zip"]
def rows(name, prefix):
    z = zipfile.ZipFile(f"{D}/{name}")
    for n in sorted(z.namelist()):
        base = n.rsplit("/", 1)[-1]
        if base.startswith(prefix) and base.endswith(".json"):
            yield from json.loads(z.read(n))
readings = collections.defaultdict(set)
for name in TERM:
    for row in rows(name, "term_bank_"):
        readings[row[0]].add(row[1] or row[0])
pairs = collections.OrderedDict()
for row in rows("jiten-frequency.zip", "term_meta_bank_"):
    expr, mode, data = row[0], row[1], row[2]
    if mode != "freq": continue
    reading = data.get("reading") if isinstance(data, dict) else None
    value = None
    if isinstance(data, dict):
        f = data.get("frequency", data)
        value = f.get("value") if isinstance(f, dict) else f
    pairs.setdefault((expr, reading or ""), value)
exprs = {e for e, _ in pairs}
defined_expr = [p for p in pairs if p[0] in readings]
hidden = [p for p in defined_expr if p[1] and p[1] not in readings[p[0]]]
print("jiten pairs", len(pairs), "expressions", len(exprs))
print("pairs whose expression a term dictionary has", len(defined_expr))
print("of those, with a reading no term dictionary gives that expression", len(hidden))
top = sorted(hidden, key=lambda p: pairs[p] if isinstance(pairs[p], (int, float)) else 1e12)
print("in Jiten's top 50,000:", sum(1 for p in hidden if isinstance(pairs[p], (int, float)) and pairs[p] <= 50000))
for p in top[:40]:
    print(" ", p[0], p[1], pairs[p], "term readings:", "/".join(sorted(readings[p[0]]))[:80])
