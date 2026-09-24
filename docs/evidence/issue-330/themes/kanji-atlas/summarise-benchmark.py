#!/usr/bin/env python3
"""Summarise the hover-popup A/B runs for the Kanji Atlas proposal (issue #334).

    python3 summarise-benchmark.py <out.json> <label>=<dir> [<label>=<dir> ...]

Each dir is one run of benchmark/hover-popup.mjs (the A/B copy with the hook-timing
probe). Rows are grouped by theme label; medians and p95 of input→first result and
input→complete result are reported for the warm root scans, the deep-nesting scans and
the cold first open, plus the per-call runThemeHook duration from the probe.
"""
import glob
import json
import statistics
import sys
from collections import defaultdict


def quantile(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


def summary(values):
    return {"n": len(values), "median": round(statistics.median(values), 2), "p95": round(quantile(values, 0.95), 2),
            "min": round(min(values), 2), "max": round(max(values), 2)}


out = sys.argv[1]
groups = defaultdict(lambda: {"rows": [], "hooks": [], "runs": []})
for spec in sys.argv[2:]:
    label, directory = spec.split("=", 1)
    group = groups[label]
    group["runs"].append(directory)
    group["rows"] += json.load(open(f"{directory}/raw.json"))
    for path in glob.glob(f"{directory}/session-*-hook-times.json"):
        group["hooks"] += json.load(open(path))["hookTimes"]

report = {}
for label, group in groups.items():
    rows = group["rows"]
    pick = lambda prefixes: [r for r in rows if any(r["label"].startswith(p) for p in prefixes)]
    sections = {}
    for name, prefixes in {"root": ["root-"], "deep-nesting": ["deep-nesting-"], "cold": ["cold"], "child": ["child-"]}.items():
        chosen = pick(prefixes)
        if not chosen:
            continue
        sections[name] = {"firstMs": summary([r["firstMs"] for r in chosen]), "completeMs": summary([r["completeMs"] for r in chosen]),
                          "blankMs": summary([r["blankMs"] for r in chosen])}
    hooks = group["hooks"]
    report[label] = {"runs": group["runs"], "sessions": len({(r["session"], r.get("chrome")) for r in rows}) if rows else 0,
                     "rows": len(rows), "scans": sections,
                     "hook": {"calls": len(hooks), "ms": summary([h["ms"] for h in hooks]) if hooks else None,
                              "byKind": {kind: summary([h["ms"] for h in hooks if h["kind"] == kind])
                                         for kind in sorted({h["kind"] for h in hooks})}},
                     "signatures": sorted({r["resultSignature"] for r in rows})}
json.dump(report, open(out, "w"), indent=2, ensure_ascii=False)
for label, data in report.items():
    print(f"== {label}: {data['rows']} rows from {len(data['runs'])} runs")
    for name, section in data["scans"].items():
        print(f"  {name:13} first  med {section['firstMs']['median']:>6} p95 {section['firstMs']['p95']:>6}   "
              f"complete med {section['completeMs']['median']:>6} p95 {section['completeMs']['p95']:>6}   n={section['firstMs']['n']}")
    hook = data["hook"]
    if hook["ms"]:
        print(f"  runThemeHook  {hook['calls']} calls  med {hook['ms']['median']} p95 {hook['ms']['p95']} max {hook['ms']['max']} ms  "
              + " ".join(f"{k}:med {v['median']}/p95 {v['p95']}" for k, v in hook["byKind"].items()))
