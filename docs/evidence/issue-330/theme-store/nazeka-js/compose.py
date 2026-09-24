#!/usr/bin/env python3
"""Compose side-by-side PNGs for the Nazeka (JS) prototype evidence (issue #334).

    python3 compose.py <dir with default-*.png and nazeka-*.png>

Writes side-by-side-term.png, side-by-side-kanji.png and nazeka-js-side-by-side.png
(2 x 2: rows 食べたかった / 食, columns default / Nazeka JS) into the same directory.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 24)
GUTTER, LABEL, BG, INK = 28, 64, (236, 232, 226), (40, 40, 40)


def panel(name, title, subtitle):
    image = Image.open(OUT / f"{name}.png").convert("RGB")
    canvas = Image.new("RGB", (image.width, image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 4), title, font=FONT, fill=INK)
    draw.text((8 + draw.textlength(title, font=FONT) + 18, 10), subtitle, font=SMALL, fill=(96, 96, 96))
    canvas.paste(image, (0, LABEL))
    return canvas


def row(left, right):
    height = max(left.height, right.height)
    canvas = Image.new("RGB", (left.width + GUTTER + right.width, height), BG)
    canvas.paste(left, (0, 0))
    canvas.paste(right, (left.width + GUTTER, 0))
    return canvas


def stack(top, bottom):
    canvas = Image.new("RGB", (max(top.width, bottom.width), top.height + GUTTER + bottom.height), BG)
    canvas.paste(top, (0, 0))
    canvas.paste(bottom, (0, top.height + GUTTER))
    return canvas


term = row(panel("default-term", "Default today", "食べたかった · fresh install (AUTO → light) · Hachidori 0.1.6"),
           panel("nazeka-term", "Nazeka (JS prototype)", "theme.css + theme.js · top bar removed by onRender"))
kanji = row(panel("default-kanji", "Default today", "食 kanji view"),
            panel("nazeka-kanji", "Nazeka (JS prototype)", "食 kanji view"))
term.save(OUT / "side-by-side-term.png", optimize=True)
kanji.save(OUT / "side-by-side-kanji.png", optimize=True)
stack(term, kanji).save(OUT / "nazeka-js-side-by-side.png", optimize=True)
for name in ["side-by-side-term.png", "side-by-side-kanji.png", "nazeka-js-side-by-side.png"]:
    image = Image.open(OUT / name)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")
