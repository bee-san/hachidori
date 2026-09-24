#!/usr/bin/env python3
"""Compose side-by-side PNGs for the Nazeka (JS) prototype evidence (issue #334).

    python3 compose.py <dir>

<dir> holds default-*.png and nazeka-*.png (capture-nazeka-js.mjs),
nazeka-reference-*.png (nazeka-reference.mjs: Nazeka's own texthook.js popup
builder rendered in the same Chrome) and nazeka-tutorial-z7Yjj1w.png (the
popup screenshot from wareya/nazeka's tutorial, Nazeka in Firefox). Writes
side-by-side-term.png, side-by-side-kanji.png and nazeka-js-side-by-side.png
(rows 食べたかった / 食 / real screenshot; columns default / Nazeka JS / Nazeka itself).
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 24)
GUTTER, LABEL, BG, INK = 28, 64, (236, 232, 226), (40, 40, 40)


def panel(image, title, subtitle):
    image = image.convert("RGB")
    canvas = Image.new("RGB", (max(image.width, 560), image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 4), title, font=FONT, fill=INK)
    draw.text((8 + draw.textlength(title, font=FONT) + 18, 10), subtitle, font=SMALL, fill=(96, 96, 96))
    canvas.paste(image, (0, LABEL))
    return canvas


def shot(name):
    return Image.open(OUT / f"{name}.png")


def row(*panels):
    height = max(p.height for p in panels)
    canvas = Image.new("RGB", (sum(p.width for p in panels) + GUTTER * (len(panels) - 1), height), BG)
    x = 0
    for p in panels:
        canvas.paste(p, (x, 0))
        x += p.width + GUTTER
    return canvas


def stack(*rows):
    canvas = Image.new("RGB", (max(r.width for r in rows), sum(r.height for r in rows) + GUTTER * (len(rows) - 1)), BG)
    y = 0
    for r in rows:
        canvas.paste(r, (0, y))
        y += r.height + GUTTER
    return canvas


# The tutorial screenshot is 1x; the captures are 2x. Crop its popup and scale it to match.
tutorial = Image.open(OUT / "nazeka-tutorial-z7Yjj1w.png").crop((500, 0, 1111, 222))
tutorial = tutorial.resize((tutorial.width * 2, tutorial.height * 2), Image.LANCZOS)

term = row(panel(shot("default-term"), "Default today", "食べたかった · fresh install (AUTO → light)"),
           panel(shot("nazeka-term"), "Nazeka theme (CSS + JS)", "Hachidori popup · Anki + audio kept, nothing else"),
           panel(shot("nazeka-reference-term"), "Nazeka itself", "wareya/nazeka texthook.js build_div, same Chrome 152"))
kanji = row(panel(shot("default-kanji"), "Default today", "食 kanji view"),
            panel(shot("nazeka-kanji"), "Nazeka theme (CSS + JS)", "食 kanji view"),
            panel(shot("nazeka-reference-kanji"), "Nazeka itself", "texthook.js build_div_kanji, same Chrome 152"))
real = row(panel(tutorial, "Nazeka in Firefox", "screenshot from the wareya/nazeka tutorial (mining UI), 2× scaled"))
term.save(OUT / "side-by-side-term.png", optimize=True)
kanji.save(OUT / "side-by-side-kanji.png", optimize=True)
stack(term, kanji, real).save(OUT / "nazeka-js-side-by-side.png", optimize=True)
for name in ["side-by-side-term.png", "side-by-side-kanji.png", "nazeka-js-side-by-side.png"]:
    image = Image.open(OUT / name)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")
