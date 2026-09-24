#!/usr/bin/env python3
"""Compose the Learner Focus evidence PNGs (issue #334).

    python3 compose.py <dir with the capture-learner-focus.mjs output>

Writes side-by-side-term.png (default vs Learner Focus, 食べたかった),
side-by-side-kanji.png (the 食 kanji view), layers.png (the five layers of
食べたかった as one strip) and known.png (the "knew it" flow) into the same
directory. Labels only; every panel is an untouched capture.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 24)
GUTTER, LABEL, BG, INK, SUB = 28, 64, (236, 232, 226), (40, 40, 40), (96, 96, 96)


def panel(name, title, subtitle="", width=None):
    image = Image.open(OUT / f"{name}.png").convert("RGB")
    if width and image.width != width:
        image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
    canvas = Image.new("RGB", (image.width, image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 4), title, font=FONT, fill=INK)
    if subtitle:
        draw.text((8 + draw.textlength(title, font=FONT) + 18, 10), subtitle, font=SMALL, fill=SUB)
    canvas.paste(image, (0, LABEL))
    return canvas


def row(*panels):
    height = max(p.height for p in panels)
    width = sum(p.width for p in panels) + GUTTER * (len(panels) - 1)
    canvas = Image.new("RGB", (width, height), BG)
    x = 0
    for p in panels:
        canvas.paste(p, (x, 0))
        x += p.width + GUTTER
    return canvas


def column(*panels):
    width = max(p.width for p in panels)
    height = sum(p.height for p in panels) + GUTTER * (len(panels) - 1)
    canvas = Image.new("RGB", (width, height), BG)
    y = 0
    for p in panels:
        canvas.paste(p, (0, y))
        y += p.height + GUTTER
    return canvas


row(panel("default-term", "Default today", "食べたかった · Hachidori 0.1.6"),
    panel("lf-0-focus", "Learner Focus", "layer 0 · theme.css + theme.js")).save(OUT / "side-by-side-term.png", optimize=True)
row(panel("default-kanji", "Default today", "食 kanji view"),
    panel("lf-kanji-view", "Learner Focus", "食 kanji view · KANJIDIC")).save(OUT / "side-by-side-kanji.png", optimize=True)
W = 820
column(
    row(panel("lf-0-focus", "0 · Focus", "one gloss", W), panel("lf-1-senses", "1 · Senses", "every sense", W), panel("lf-2-details", "2 · Details", "examples, frequency, tags", W)),
    row(panel("lf-3-dictionaries", "3 · Dictionaries", "shorter matches, other dictionaries", W), panel("lf-4-kanji", "4 · Kanji", "the kanji of this word", W), panel("lf-kanji-view", "→ kanji view", "from a table row", W)),
).save(OUT / "layers.png", optimize=True)
column(panel("lf-known-just-marked", "After “1 · Knew it”", "the whole popup is one line"),
       panel("lf-known-again", "Next hover of the same word", "remembered for the page (API gap: no storage)")).save(OUT / "known.png", optimize=True)
for name in ["side-by-side-term.png", "side-by-side-kanji.png", "layers.png", "known.png"]:
    image = Image.open(OUT / name)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")
