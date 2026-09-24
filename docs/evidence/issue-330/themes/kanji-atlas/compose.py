#!/usr/bin/env python3
"""Compose the Kanji Atlas evidence sheets (issue #334) from the capture's PNGs.

    python3 compose.py <dir with default-*.png and atlas-*.png>

Writes side-by-side-term.png, side-by-side-kanji.png, side-by-side-long.png,
fills-in.png (図書館 before / 書 card / after), interaction-states.png (hover, focus,
drawer, forced colours) and kanji-cards.png (KANJIDIC / Bee's) into the same directory.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 24)
GUTTER, LABEL, BG, INK, MUTED = 28, 64, (236, 232, 226), (40, 40, 40), (96, 96, 96)


def panel(name, title, subtitle=""):
    image = Image.open(OUT / f"{name}.png").convert("RGB")
    canvas = Image.new("RGB", (image.width, image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 4), title, font=FONT, fill=INK)
    if subtitle:
        draw.text((8 + draw.textlength(title, font=FONT) + 18, 10), subtitle, font=SMALL, fill=MUTED)
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


save(row(panel("default-term", "Default today", "食べたかった · 560 × 420 · Hachidori 0.1.6 + host prototype"),
         panel("atlas-term", "Kanji Atlas", "theme.css + theme.js · rail built by onRender")), "side-by-side-term.png")
save(row(panel("default-kanji", "Default today", "食 kanji view (KANJIDIC)"),
         panel("atlas-kanji", "Kanji Atlas", "atlas card · arrived from 食べる")), "side-by-side-kanji.png")
save(row(panel("default-long", "Default today", "掛ける · 20+ senses"),
         panel("atlas-long", "Kanji Atlas", "same entry, compact glosses")), "side-by-side-long.png")
save(row(panel("atlas-toshokan-before", "1 · 図書館 on hover", "図 known (Bee's card in the results), 書·館 inferred"),
         panel("atlas-kanji-sho", "2 · click 書", "KANJIDIC card, ショ marked as the reading you came from"),
         panel("atlas-toshokan-after", "3 · Back", "書 filled in: ring, 音 しょ, JLPT · grade · strokes, meaning")), "fills-in.png")
save(row(panel("atlas-benkyou-before", "勉強 on hover", "勉 from Bee's card · 強 inferred (italic)"),
         panel("atlas-benkyou-after", "after visiting 強", "both readings matched to 音")), "fills-in-benkyou.png")
save(row(panel("atlas-term-hover", "Hover", "ring turns vermilion, turns half a tick"),
         panel("atlas-term-focus", "Keyboard focus", "Tab reaches the glyph button; focus ring"),
         panel("atlas-term-drawer", "Drawer open", "Bee's full card folded under its tile")), "interaction-states.png")
save(row(panel("atlas-kanji-bees", "Bee's as clicked-kanji dictionary", "real KanjiVG stroke diagram beside the ring"),
         panel("atlas-kanji-forced-colors", "forced-colors: active", "ring and chips drawn in CanvasText")), "kanji-cards.png")
save(row(panel("atlas-term-forced-colors", "forced-colors: active", "term view, dark system palette"),
         panel("atlas-kanji-forced-colors", "forced-colors: active", "kanji view")), "forced-colors.png")
