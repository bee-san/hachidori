#!/usr/bin/env python3
"""Compose labelled side-by-side PNGs for the Geocities Y2K theme evidence (issue #334).

    python3 compose.py <dir with the capture PNGs>

Writes side-by-side-term.png, side-by-side-kanji.png, y2k-overview.png (2 x 2)
and y2k-states.png (interaction states) into the same directory.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 24)
GUTTER, LABEL, BG, INK = 28, 64, (236, 232, 226), (40, 40, 40)


def panel(name, title, subtitle=""):
    image = Image.open(OUT / f"{name}.png").convert("RGB")
    canvas = Image.new("RGB", (image.width, image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 4), title, font=FONT, fill=INK)
    if subtitle:
        draw.text((8 + draw.textlength(title, font=FONT) + 18, 10), subtitle, font=SMALL, fill=(96, 96, 96))
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


def stack(*rows):
    width = max(r.width for r in rows)
    height = sum(r.height for r in rows) + GUTTER * (len(rows) - 1)
    canvas = Image.new("RGB", (width, height), BG)
    y = 0
    for r in rows:
        canvas.paste(r, (0, y))
        y += r.height + GUTTER
    return canvas


term = row(panel("default-term", "Default today", "食べたかった · two dictionaries · Hachidori 0.1.6"),
           panel("y2k-term", "Geocities Y2K", "theme.css + theme.js · same lookup, same data"))
kanji = row(panel("default-kanji", "Default today", "食 kanji view"),
            panel("y2k-kanji", "Geocities Y2K", "今日の漢字 · stickers computed from KANJIDIC stats"))
term.save(OUT / "side-by-side-term.png", optimize=True)
kanji.save(OUT / "side-by-side-kanji.png", optimize=True)
stack(term, kanji).save(OUT / "y2k-overview.png", optimize=True)
states = stack(
    row(panel("y2k-term-scrolled", "Scrolled", "工事中 on an empty sense · rainbow <hr> · WebRing · sticky sidebar"),
        panel("y2k-term-yomu", "First visit", "読む · counter 000001 · NEW! · はじめまして")),
    row(panel("y2k-tab-second-dictionary", "リンク集 tab", "the real dictionary tab, pressed · データ frame under 意味"),
        panel("y2k-guestbook-written", "ゲストブック", "Anki note written through the real mine button")),
    row(panel("y2k-sparkles", "Cursor trail", "pointermove sparkles, fading (motion only)"),
        panel("y2k-bgm-playing", "BGM ♪", "audio button state=playing · kaomoji dances")),
    row(panel("y2k-reduced-motion", "prefers-reduced-motion", "marquee still, no sparkles, reels do not roll"),
        panel("y2k-narrow", "380 px wide", "container query: sidebar drops below")),
)
states.save(OUT / "y2k-states.png", optimize=True)
for name in ["side-by-side-term.png", "side-by-side-kanji.png", "y2k-overview.png", "y2k-states.png"]:
    image = Image.open(OUT / name)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")
