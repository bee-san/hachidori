#!/usr/bin/env python3
"""WCAG 2.x contrast ratios for the manga-vertical palettes (issue #334).

    python3 contrast.py <evidence dir>

Reads the live computed colours the capture stored in evidence.json
(checks.computedColors / checks.nightColors — colour-mix results included) and
the two palettes' hex values, and writes contrast.json + a Markdown table.
"""
import json
import re
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
evidence = json.loads((OUT / "evidence.json").read_text())


def parse(color):
    color = color.strip()
    if color.startswith("#"):
        return tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    m = re.match(r"rgba?\(([^)]+)\)", color)
    if m:
        parts = [float(p) for p in re.split(r"[,\s/]+", m.group(1).strip()) if p]
        return tuple(p / 255 for p in parts[:3])
    m = re.match(r"color\(srgb ([^)]+)\)", color)
    if m:
        parts = [float(p) for p in m.group(1).split()[:3]]
        return tuple(parts)
    raise ValueError(color)


def luminance(rgb):
    def channel(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg, bg):
    l1, l2 = luminance(parse(fg)), luminance(parse(bg))
    hi, lo = max(l1, l2), min(l1, l2)
    return round((hi + 0.05) / (lo + 0.05), 2)


def grade(value, large=False):
    aa, aaa = (3.0, 4.5) if large else (4.5, 7.0)
    return "AAA" if value >= aaa else "AA" if value >= aa else "fail"


rows = []
for mode, key in (("light", "computedColors"), ("night", "nightColors")):
    c = evidence["checks"][key]
    paper = c["paper"]
    pairs = [
        ("ink on paper (headword, glosses)", c["ink"], paper, False),
        ("朱 furigana / sense numbers on paper (12 px rt)", c["furigana"], paper, False),
        ("藍 inflected tail on paper (15 px)", c["surfaceRest"], paper, False),
        ("muted text: 活用 steps, page memory, lookup count (11–12 px)", c["steps"], paper, False),
        ("faint text: dictionary name (10 px)", c["cardTitle"], paper, False),
        ("frequency seal text/border on paper (10.5 px)", c["frequencyTag"], paper, False),
        ("selected thumb tab: paper on ink", c["tabSelectedText"], c["tabSelectedBackground"], False),
        ("unselected thumb tab text on paper", c["tabText"], paper, False),
        ("toolbar button ink on its paper disc", c["toolbarButton"], c["toolbarButtonBackground"], False),
        ("toolbar strip (screentone base) vs paper — decorative, no text", c["toolbarBackground"], paper, False),
    ]
    if c.get("historyCount"):
        pairs.append(("朱 ×n repeat mark on paper (10 px)", c["historyCount"], paper, False))
    for label, fg, bg, large in pairs:
        if fg is None or bg is None:
            continue
        value = ratio(fg, bg)
        rows.append({"mode": mode, "pair": label, "foreground": fg, "background": bg, "ratio": value, "wcag": grade(value, large)})

# Palette values as written in theme.yaml, against their paper.
palettes = {
    "light": {"paper": "#f7f2e8", "ink": "#1d1b18", "primary": "#b8321f", "secondary": "#2f4f7f", "accent": "#7d6218", "neutral": "#5b5650", "info": "#3b5b8c"},
    "night": {"paper": "#16171b", "ink": "#ece6d8", "primary": "#e8836b", "secondary": "#93b4e6", "accent": "#d1b45a", "neutral": "#aaa59b", "info": "#8fb0e0"},
}
for mode, p in palettes.items():
    for name in ("ink", "primary", "secondary", "accent", "neutral", "info"):
        value = ratio(p[name], p["paper"])
        rows.append({"mode": mode, "pair": f"palette {name} on base-100", "foreground": p[name], "background": p["paper"], "ratio": value, "wcag": grade(value)})

(OUT / "contrast.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False))
lines = ["| Mode | Pair | Foreground | Background | Ratio | WCAG (normal text) |", "| --- | --- | --- | --- | --- | --- |"]
for r in rows:
    lines.append(f"| {r['mode']} | {r['pair']} | `{r['foreground']}` | `{r['background']}` | {r['ratio']} | {r['wcag']} |")
(OUT / "contrast.md").write_text("\n".join(lines) + "\n")
print("\n".join(lines))
