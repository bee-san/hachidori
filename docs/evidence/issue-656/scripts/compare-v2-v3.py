# Compares audit-hachi-issue-656-c's sweeps of 94d43a93 (v2-*) with the same
# probe on the head with the title rule (v3-*): the widths where any measure
# differs, and v3's own summary per name set.
import json, os, sys
A = "/local/home/skerraut/herd-synth3/reports/audit-hachi-issue-656-c-evidence/probes"
B = "/local/home/skerraut/herd-synth3/tmp-hachi656/probe3/out"
KEYS = ("geometry", "rows", "overflow", "startOverflow", "switchInside", "titleAtStart", "labelAtEnd", "menuAtEnd", "lines", "menu")
for name in sys.argv[1:]:
    a = json.load(open(f"{A}/v2-{name}.json")); b = json.load(open(f"{B}/v3-{name}.json"))
    print(f"== {name}")
    for s in b["sets"]:
        pa = {p["width"]: p for p in (a["sets"].get(s, {}).get("sweep") or {}).get("points", [])}
        sb = b["sets"][s].get("sweep") or {}
        pb = {p["width"]: p for p in sb.get("points", [])}
        differ = [w for w in sorted(pb, reverse=True) if w in pa and any(pa[w].get(k) != pb[w].get(k) for k in KEYS)]
        summary = {k: sb.get(k) for k in ("firstOverflow", "firstStartOverflow", "firstSwitchOutside", "firstUnreachable", "notTitleAtStart", "notLabelAtEnd", "notMenuAtEnd", "anyBelowMin", "maxDelta")}
        summary["anyBelowMin"] = len(summary["anyBelowMin"] or [])
        print(f"  {s}: {len(pb)} widths, differ from 94d43a93 at {differ if len(differ) < 30 else str(len(differ)) + ' widths'}")
        print(f"    {json.dumps(summary)}")
        print(f"    layouts {[(r['from'], r['to'], r['layout']) for r in sb.get('layoutRanges', [])]}")
