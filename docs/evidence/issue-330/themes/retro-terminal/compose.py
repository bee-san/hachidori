#!/usr/bin/env python3
"""Compose side-by-side PNGs for the Retro Terminal theme evidence (issue #334).

    python3 compose.py <dir with default-*.png and retro-*.png>

Writes side-by-side-term.png (食べたかった: default | retro-terminal),
side-by-side-kanji.png (食 kanji view), keyboard-states.png (row 1 | row 2 after j),
and long-entry.png (掛けたかった: default | retro-terminal) when those shots exist.
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


def save(image, name):
    image.save(OUT / name, optimize=True)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")


pairs = [
    ("side-by-side-term.png", ("default-term", "Default", "食べたかった · fixture dictionary"),
     ("retro-term", "Retro Terminal", "theme.css + theme.js · same lookup")),
    ("side-by-side-kanji.png", ("default-kanji", "Default", "食 kanji view"),
     ("retro-kanji", "Retro Terminal", "食 kanji view")),
    ("keyboard-states.png", ("retro-term", "Row 1 selected", "hover opens the popup"),
     ("retro-term-keyboard", "After j", "click a row (focus), j → row 2, body follows")),
    ("long-entry.png", ("default-long", "Default", "掛けたかった · JMdict + kanjium + JPDB"),
     ("retro-long", "Retro Terminal", "same lookup · 6 candidates, 26 senses")),
    ("candidate-list.png", ("retro-list", "Candidate list", "日本語 · every match the reader found"),
     ("retro-list-keyboard", "After 3", "digit keys pick a candidate directly")),
    ("kanji-real.png", ("default-kanji-real", "Default", "分 · KANJIDIC"),
     ("retro-kanji-real", "Retro Terminal", "分 · KANJIDIC stats as one line")),
]
for name, left, right in pairs:
    if (OUT / f"{left[0]}.png").exists() and (OUT / f"{right[0]}.png").exists():
        save(row(panel(*left), panel(*right)), name)
