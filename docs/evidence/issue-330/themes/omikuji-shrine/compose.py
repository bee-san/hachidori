#!/usr/bin/env python3
"""Compose the evidence PNGs for the omikuji-shrine theme proposal (issue #334).

    python3 compose.py <dir with the capture PNGs>

Writes into the same directory:
  side-by-side-term.png    default vs omikuji-shrine, 食べたかった
  side-by-side-kanji.png   default vs omikuji-shrine, 食 kanji view
  grades-strip.png         大吉 · 小吉 · 末吉 · 凶 · 大凶 from real Jiten ranks
  states-strip.png         slide frames, ema hover, keyboard focus, reduced motion
  entries-strip.png        long multi-sense entry, secondary entries with mini fortunes
All labels are drawn with Noto Sans CJK JP; the screenshots are untouched.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 22)
GUTTER, LABEL, BG, INK, MUTED = 28, 72, (236, 232, 226), (40, 40, 40), (96, 96, 96)


def panel(name, title, subtitle, height=None):
    image = Image.open(OUT / f"{name}.png").convert("RGB")
    if height and image.height > height:
        image = image.crop((0, 0, image.width, height))
    canvas = Image.new("RGB", (image.width, image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 4), title, font=FONT, fill=INK)
    draw.text((8, 40), subtitle, font=SMALL, fill=MUTED)
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


def save(image, name):
    image.save(OUT / name, optimize=True)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")


save(row(panel("default-term", "Default today", "食べたかった · Jitendex + Jiten + KANJIDIC · 560×420"),
         panel("omikuji-term", "Omikuji Shrine (JS)", "rank 190 → 大吉 · seal · verses · ema shelf · 400×640")),
     "side-by-side-term.png")
save(row(panel("default-kanji", "Default today", "食 kanji view"),
         panel("omikuji-kanji", "Omikuji Shrine (JS)", "ema board · readings on ribbons · newspaper rank 328 → 中吉")),
     "side-by-side-kanji.png")
H = 1100
save(row(panel("omikuji-term", "大吉", "食べる · Jiten rank 190", H),
         panel("omikuji-long", "小吉", "掛ける · rank 3,464 · many senses", H),
         panel("omikuji-slide-3", "末吉", "鳥居 · rank 19,820", H),
         panel("omikuji-kyo", "凶", "参拝 · rank 28,383 · printed in sumi", H),
         panel("omikuji-daikyo", "大凶", "御籤 · rank 178,352", H)),
     "grades-strip.png")
save(row(panel("omikuji-slide-1", "Slide, frame 1", "new word · slip leaving the box (slowed 12.5×)", H),
         panel("omikuji-slide-2", "Slide, frame 2", "translateY −12 px · opacity 0.72", H),
         panel("omikuji-ema-hover", "Hover", "the 音 plaque swings on its cord", H),
         panel("omikuji-ema-focus", "Keyboard", "Tab reaches the 筆 plaque · unclipped focus ring", H),
         panel("omikuji-reduced-motion", "prefers-reduced-motion", "no slide · transform none, opacity 1 at frame 0", H)),
     "states-strip.png")
save(row(panel("omikuji-long", "Long multi-sense entry", "掛ける · Jitendex · glosses as verses, 一、二、三"),
         panel("omikuji-secondary-scrolled", "Further entries", "each carries its own miniature fortune from its rank"),
         panel("omikuji-word-daikichi", "The word 大吉", "rank 28,027 → 凶")),
     "entries-strip.png")
