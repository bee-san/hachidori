import json, glob, statistics as st
def q(xs, p):
    xs = sorted(xs)
    if not xs: return None
    k = min(len(xs)-1, int(round(p*(len(xs)-1))))
    return xs[k]
out = {}
for v in ["default", "sentence-context"]:
    rows = []
    for d in sorted(glob.glob(f"{v}-*/")):
        try: rows += json.load(open(d + "raw.json"))
        except Exception as e: print("skip", d, e)
    groups = {"root (warm, 8/session)": [r for r in rows if r["label"].startswith("root-")],
              "deep-nesting (depth-40 gloss)": [r for r in rows if r["label"].startswith("deep-nesting-") and "flat" not in r["label"]],
              "deep-nesting-flat": [r for r in rows if r["label"].startswith("deep-nesting-flat")],
              "child (nested popup)": [r for r in rows if r["label"].startswith("child-")],
              "cold (first open)": [r for r in rows if r["label"] == "cold"]}
    out[v] = {}
    for g, rs in groups.items():
        f = [r["firstMs"] for r in rs]; c = [r["completeMs"] for r in rs]; b = [r["blankMs"] for r in rs]
        out[v][g] = dict(n=len(rs), first_med=st.median(f) if f else None, first_p95=q(f,.95), complete_med=st.median(c) if c else None, complete_p95=q(c,.95), blank_med=st.median(b) if b else None, blank_p95=q(b,.95))
    print(v, "sessions:", len(glob.glob(f"{v}-*/")), "rows:", len(rows))
for g in out["default"]:
    print(f"\n{g}")
    for v in out:
        m = out[v][g]
        print(f"  {v:17s} n={m['n']:2d} first med {m['first_med']:.1f} p95 {m['first_p95']:.1f} | complete med {m['complete_med']:.1f} p95 {m['complete_p95']:.1f} | blank med {m['blank_med']:.1f} p95 {m['blank_p95']:.1f}")
json.dump(out, open("summary.json","w"), indent=1)
