#!/usr/bin/env python3
"""Measure text/background contrast in the REAL screenshot, per scanline band.

    python3 measure-contrast.py retro-term.png retro-term-reduced-motion.png

The CRT overlay is a 3 px raster (2 px clear, 1 px at 14 % black), so every
pixel in a "dark" row — text and background alike — is scaled by 0.86. For each
band (grouped by the row's background colour) this prints the WCAG ratio of every
solid glyph colour that occurs at least 40 times in the band — the flat interiors
of glyphs, not anti-aliased edges — against that band's background, and names the
palette colour it came from. Reduced motion has one band (the overlay is off).
"""
import sys
from collections import Counter
from pathlib import Path
from PIL import Image

PALETTE = {"#ffb000 text": (255, 176, 0), "#ffd166 bright": (255, 209, 102), "#d09a1e dim": (208, 154, 30)}


def channel(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def ratio(a, b):
    la, lb = sorted([luminance(a), luminance(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def source(rgb, factor):
    """Which palette colour, scaled by the band's factor, this pixel is (within 3/255)."""
    for name, base in PALETTE.items():
        if all(abs(rgb[i] - round(base[i] * factor)) <= 3 for i in range(3)):
            return name
    return None


for name in sys.argv[1:]:
    image = Image.open(name).convert("RGB")
    width, height = image.size
    pixels = image.load()
    bands = {}
    for y in range(height):
        row = [pixels[x, y] for x in range(width)]
        background = Counter(p for p in row if max(p) < 40)
        if sum(background.values()) < width * 0.4:
            continue                                        # page, title bar rules, or the inverse-video status line
        bg = background.most_common(1)[0][0]
        band = bands.setdefault(bg, {"rows": 0, "text": Counter()})
        band["rows"] += 1
        band["text"].update(p for p in row if p[0] > 100 and p[0] > p[2] + 60)   # amber-ish
    # The popup's two bands are the two most populous background colours (the
    # bezel and anti-aliased rule rows contribute a handful of rows each).
    major = sorted(bands.items(), key=lambda item: item[1]["rows"], reverse=True)[:2]
    if len(major) == 2 and major[1][1]["rows"] < major[0][1]["rows"] * 0.1:
        major = major[:1]                                   # reduced motion: one band, the rest is bezel
    major = sorted(major, key=lambda item: luminance(item[0]))
    print(Path(name).name, f"{len(major)} band(s) of {len(bands)} background colours")
    for bg, band in major:
        dark = len(major) == 2 and bg == major[0][0]
        factor = 0.86 if dark else 1.0                      # rgba(0, 0, 0, 0.14) over the row
        label = "scanline rows (x0.86)" if dark else "clear rows"
        print(f"  {label}: background rgb{bg}, {band['rows']} rows")
        for colour, count in band["text"].most_common():
            if count < 40:
                break
            origin = source(colour, factor)
            if origin:
                print(f"    rgb{colour} ({origin}) x {count} px -> {ratio(colour, bg):.2f}:1")
