# names.py: expressions only JMnedict defines (names) for which Jiten names a
# reading that no term dictionary gives the expression: the case in #658.
import json, zipfile, collections, re
D = "/local/home/skerraut/herd-synth3/reports/audit-hachi-fix-620-evidence/dicts"
def rows(name, prefix):
    z = zipfile.ZipFile(f"{D}/{name}")
    for n in sorted(z.namelist()):
        base = n.rsplit("/", 1)[-1]
        if base.startswith(prefix) and base.endswith(".json"):
            yield from json.loads(z.read(n))
src = collections.defaultdict(lambda: collections.defaultdict(set))
for name in ["jitendex-yomitan.zip", "JMnedict.zip", "bees-ultimate-kanji-dictionary.zip", "bees-ultimate-grammar-dictionary.zip"]:
    for row in rows(name, "term_bank_"):
        src[row[0]][name].add(row[1] or row[0])
kata = re.compile(r"^[\u30a0-\u30ffー]+$")
def hira(s): return "".join(chr(ord(c) - 0x60) if "\u30a1" <= c <= "\u30f6" else c for c in s)
out = []
for row in rows("jiten-frequency.zip", "term_meta_bank_"):
    expr, mode, data = row[0], row[1], row[2]
    if mode != "freq" or not isinstance(data, dict) or "reading" not in data: continue
    if set(src[expr]) != {"JMnedict.zip"}: continue
    readings = set().union(*src[expr].values())
    r = data["reading"]
    if r in readings or hira(r) in {hira(x) for x in readings}: continue
    f = data.get("frequency"); v = f.get("value") if isinstance(f, dict) else f
    out.append((v, expr, r, "/".join(sorted(readings))))
out.sort()
print("JMnedict-only expressions with a Jiten reading JMnedict lacks (not just katakana/hiragana):", len(out))
for v, e, r, rs in out[:30]: print(f"  {e} {r} (Jiten {v}); JMnedict: {rs[:60]}")
