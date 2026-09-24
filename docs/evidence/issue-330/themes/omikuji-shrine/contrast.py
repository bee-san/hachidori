#!/usr/bin/env python3
"""Measure WCAG 2.x contrast for the omikuji-shrine palette against the REAL paper.

    python3 contrast.py <dir with omikuji-term.png and omikuji-kanji.png>

The paper is a textured gradient, so the theme's text colours are checked against
the darkest and lightest paper pixels actually rendered in the screenshots (sampled
in text-free regions: the margin between the frame and the torn edges, and the blank
paper around the fortune), not against the nominal #f3ead6. Writes contrast.json.
"""
import json
import sys
from pathlib import Path
from PIL import Image

OUT = Path(sys.argv[1])


def luminance(rgb):
    def channel(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def sample_paper(image, boxes):
    pixels = []
    for box in boxes:
        region = image.crop(box)
        pixels.extend(region.getdata())
    # Ignore anything that is clearly ink or the vermilion frame: keep pixels within
    # a paper-like band (bright, warm).
    paper = [p for p in pixels if p[0] > 200 and p[1] > 190 and p[2] > 160 and p[0] >= p[2]]
    paper.sort(key=luminance)
    return {"samples": len(paper), "darkest": paper[0][:3], "lightest": paper[-1][:3],
            "median": paper[len(paper) // 2][:3]}


term = Image.open(OUT / "omikuji-term.png").convert("RGB")
# 2× device pixels, regions strictly inside the printed frame with no text: the
# band between the fortune's rule and the furigana (crosses a fold crease), the
# blank paper right of the headword and seal, and right of the summary line.
paper = sample_paper(term, [(130, 505, 770, 528), (640, 540, 780, 640), (560, 720, 780, 745), (130, 780, 300, 800)])

TEXT = {
    "sumi ink (headword, glosses)": "#221c18",
    "sumi soft (furigana, muted)": "#4d423a",
    "faint (rank source line, kanji tags)": "#55483f",
    "vermilion (grade 46px, seal, mini stamps 13px bold)": "#b0261c",
    "deep vermilion (11px labels: shrine title, dictionary names, Meanings)": "#8e1c14",
    "indigo (Kun ribbon text is paper-on-indigo; links)": "#2f4b6b",
}
report = {"paper": paper, "text": {}}
for name, colour in TEXT.items():
    rgb = hex_rgb(colour)
    report["text"][name] = {
        "hex": colour,
        "vs_nominal_paper_#f3ead6": round(contrast(rgb, hex_rgb("#f3ead6")), 2),
        "vs_darkest_paper_pixel": round(contrast(rgb, paper["darkest"]), 2),
        "vs_lightest_paper_pixel": round(contrast(rgb, paper["lightest"]), 2),
    }
# Text printed on coloured surfaces.
report["surfaces"] = {
    "paper text on vermilion (On ribbon, selected tab, seal kanji) #fff6e6 on #b0261c": round(contrast(hex_rgb("#fff6e6"), hex_rgb("#b0261c")), 2),
    "paper text on indigo (Kun ribbon) #fff6e6 on #2f4b6b": round(contrast(hex_rgb("#fff6e6"), hex_rgb("#2f4b6b")), 2),
    "plaque caption/icon #3a2614 on wood #c99a5e": round(contrast(hex_rgb("#3a2614"), hex_rgb("#c99a5e")), 2),
    "plaque caption/icon #3a2614 on the plaque's darkest wood #b07a45": round(contrast(hex_rgb("#3a2614"), hex_rgb("#b07a45")), 2),
    "lid label #f0d9a8 on lacquer #2a1712": round(contrast(hex_rgb("#f0d9a8"), hex_rgb("#2a1712")), 2),
    "kanji glyph #221c18 on ema wood #d5aa6e": round(contrast(hex_rgb("#221c18"), hex_rgb("#d5aa6e")), 2),
}
(OUT / "contrast.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
