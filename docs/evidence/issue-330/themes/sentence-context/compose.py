#!/usr/bin/env python3
"""Compose side-by-side PNGs for the Sentence Context theme evidence (issue #334).

    python3 compose.py <dir with the capture's PNGs>

Writes side-by-side-term.png (default vs theme, 食べたかった on the plain page),
side-by-side-hooker.png (default vs theme, 会った on the texthooker page) and
interaction-states.png (2 x 2: step note, mark words, copied, nested) into the
same directory. Needs Pillow and the Noto Sans CJK JP fonts under ~/.fonts.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 20)
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


row(panel("default-term", "Default today", "食べたかった · 0.1.6"),
    panel("sc-term", "Sentence Context", "masthead · trail · tools")
    ).save(OUT / "side-by-side-term.png", optimize=True)
row(panel("default-hooker", "Default today", "会った · texthooker"),
    panel("sc-light-hooker", "Sentence Context", "sentence kept")
    ).save(OUT / "side-by-side-hooker.png", optimize=True)
stack(row(panel("sc-term-step-note", "Tap a step chip", "-た grammar note"),
          panel("sc-term-marked", "Mark words", "dotted underlines")),
      row(panel("sc-term-copied", "Copy sentence", "api.copyText → Copied"),
          panel("sc-term-nested", "Hover the sentence", "child popup: 朝ごはん"))
      ).save(OUT / "interaction-states.png", optimize=True)
row(panel("default-kanji", "Default today", "食 kanji view"),
    panel("sc-kanji", "Sentence Context", "word › lemma › kanji")
    ).save(OUT / "side-by-side-kanji.png", optimize=True)
for name in ["side-by-side-term.png", "side-by-side-hooker.png", "interaction-states.png", "side-by-side-kanji.png"]:
    image = Image.open(OUT / name)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")
