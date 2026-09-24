#!/usr/bin/env python3
"""Compose the evidence PNGs for the tamagotchi-lcd theme proposal (issue #334).

    python3 compose.py <dir with the capture output>

Writes side-by-side-term.png, side-by-side-kanji.png, states.png and
walk-frames.png into the same directory. Pillow only; no other assets.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 24)
GUTTER, LABEL, BG, INK, MUTED = 28, 64, (236, 232, 226), (40, 40, 40), (96, 96, 96)


def panel(name, title, subtitle="", scale=1.0):
    image = Image.open(OUT / f"{name}.png").convert("RGB")
    if scale != 1.0:
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
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


row(panel("default-term", "Default today", "食べたかった · 560 × 420"),
    panel("theme-term-560x420", "Tango Pet LCD", "same 560 × 420"),
    panel("theme-term", "Tango Pet LCD", "theme-suggested 520 × 560")).save(OUT / "side-by-side-term.png", optimize=True)
row(panel("default-kanji", "Default today", "食 kanji view"),
    panel("theme-kanji", "Tango Pet LCD", "食 as a real 24-dot bitmap + glyph")).save(OUT / "side-by-side-kanji.png", optimize=True)
row(panel("theme-before-feed", "B pressed…", "mine button ready", 0.5),
    panel("theme-feeding", "…Tango eats the word", "AnkiConnect addNote → chomp, heart, FED 01", 0.5),
    panel("theme-stage2", "Three words later", "two hearts, second leaf (stage 2)", 0.5),
    panel("theme-sleepy", "Looked up 7 times", "Tango dozes off", 0.5)).save(OUT / "states.png", optimize=True)
row(panel("theme-audio-playing", "A: audio playing", "sings, note bubble", 0.5),
    panel("theme-no-anki", "B without Anki", "NO ANKI caption, ! bubble, dim cap", 0.5),
    panel("theme-key-focus", "Keyboard focus on B", "plum + white ring", 0.5),
    panel("theme-reduced-motion", "prefers-reduced-motion", "no walk, no blink, still frame", 0.5)).save(OUT / "interaction.png", optimize=True)
row(panel("theme-long-page1", "掛ける page 1", "gauge at start, C = next", 0.5),
    panel("theme-long-page2", "after one C press", "gauge moved, arrow still on", 0.5),
    panel("theme-kanji-end", "kanji view, scrolled to end", "gauge full, C = back", 0.5)).save(OUT / "pager.png", optimize=True)
frames = [Image.open(OUT / f"theme-walk-{i}.png").convert("RGB") for i in range(3)]
strip = Image.new("RGB", (frames[0].width, sum(f.height for f in frames) + 8 * 2), BG)
y = 0
for f in frames:
    strip.paste(f, (0, y))
    y += f.height + 8
strip.save(OUT / "walk-frames.png", optimize=True)
for name in ["side-by-side-term.png", "side-by-side-kanji.png", "states.png", "interaction.png", "pager.png", "walk-frames.png"]:
    image = Image.open(OUT / name)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")
