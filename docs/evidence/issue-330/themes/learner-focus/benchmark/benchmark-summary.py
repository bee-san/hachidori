#!/usr/bin/env python3
"""Summarise two hover-popup harness runs (default vs a theme) for issue #334.

    python3 benchmark-summary.py <default results dir> <theme results dir> > benchmark-summary.json

Reads raw.json, manifest.json and session-*-theme-hook.json written by
benchmark/hover-popup.mjs patched with hover-popup-theme.patch (theme slug from
HACHIDORI_HOVER_THEME, per-call runThemeHook wall time from the probe).
"""
import json
import statistics
import sys
from pathlib import Path


def percentile(values, p):
    values = sorted(values)
    if not values:
        return None
    k = (len(values) - 1) * p
    low = int(k)
    high = min(low + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (k - low)


def group(rows):
    return {
        "cold": [r for r in rows if r["label"] == "cold"],
        "root": [r for r in rows if r["label"].startswith("root-")],
        "deep-nesting": [r for r in rows if r["label"].startswith("deep-nesting-") and "flat" not in r["label"]],
        "deep-nesting-flat": [r for r in rows if r["label"].startswith("deep-nesting-flat")],
    }


def stats(values):
    return None if not values else {
        "n": len(values), "median": round(statistics.median(values), 1), "p95": round(percentile(values, 0.95), 1),
        "min": round(min(values), 1), "max": round(max(values), 1),
    }


def summarise(directory):
    directory = Path(directory)
    rows = json.loads((directory / "raw.json").read_text())
    manifest = json.loads((directory / "manifest.json").read_text())
    hooks = []
    for path in sorted(directory.glob("session-*-theme-hook.json")):
        hooks += json.loads(path.read_text())
    ran = [h["ms"] for h in hooks if h["ran"]]
    steady = ran[1:] if ran else []  # the first call after the module loads is a cold call
    return {
        "revision": manifest["revision"], "chrome": rows[0]["chrome"] if rows else None,
        "load_average_at_start": manifest["load"], "sessions": sorted({r["session"] for r in rows}),
        "settings": manifest["settings"],
        "hover": {name: {metric: stats([r[metric] for r in rs]) for metric in ("firstMs", "completeMs", "blankMs")}
                  for name, rs in group(rows).items()},
        "theme_hook": {
            "calls": len(hooks), "ran": len(ran), "skipped_before_module_loaded": len(hooks) - len(ran),
            "ran_ms": stats(ran) if ran else None,
            "steady_ms": stats(steady) if steady else None,
            "first_call_ms": [round(h["ms"], 2) for h in hooks if h["ran"]][:1],
        },
    }


default, theme = summarise(sys.argv[1]), summarise(sys.argv[2])
print(json.dumps({
    "harness": "benchmark/hover-popup.mjs + hover-popup-theme.patch, HACHIDORI_HOVER_SAMPLES=2, benchmark/hover-popup-fixture.mjs fixture (3 terms)",
    "boundary": "firstMs/completeMs: real pointer move to first correct frame / to a complete, 2-frame-stable popup, page clock; theme_hook: wall time of runThemeHook (host view/api construction + onRender)",
    "default": default, "theme": theme,
}, indent=2, ensure_ascii=False))
