#!/usr/bin/env python3
"""Crop and compose the manga-vertical evidence PNGs (issue #334).

    python3 compose.py <dir with the capture's full-viewport PNGs and evidence.json>

The capture script screenshots the whole viewport (a CDP clip moves the visual
viewport and the reader hides its popup on that scroll), recording the clip it
wants per shot in evidence.json. This applies those clips in place, then writes
the side-by-side composites used in the issue comment.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
SCALE = 2  # deviceScaleFactor of the capture
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 22)
GUTTER, LABEL, BG, INK, GREY = 28, 66, (236, 232, 226), (40, 40, 40), (96, 96, 96)

evidence = json.loads((OUT / "evidence.json").read_text())
for name, shot in evidence["shots"].items():
    clip = shot and shot.get("clip")
    path = OUT / f"{name}.png"
    if not clip or not path.exists():
        continue
    image = Image.open(path)
    box = (round(clip["x"] * SCALE), round(clip["y"] * SCALE),
           round((clip["x"] + clip["width"]) * SCALE), round((clip["y"] + clip["height"]) * SCALE))
    image.crop(box).save(path, optimize=True)


def panel(name, title, subtitle):
    image = Image.open(OUT / f"{name}.png").convert("RGB")
    canvas = Image.new("RGB", (image.width, image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 4), title, font=FONT, fill=INK)
    draw.text((8 + draw.textlength(title, font=FONT) + 18, 12), subtitle, font=SMALL, fill=GREY)
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


# The headline: the same page, default vs Tategaki, whole viewport.
save(row(panel("default-term-page", "Default today", "食べたかった on a mokuro-style page · fresh install (AUTO → light)"),
         panel("theme-term-page", "Tategaki (manga-vertical)", "theme.css + theme.js · tail on the word · vertical toolbar")),
     "side-by-side-term-page.png")
save(row(panel("default-term", "Default today", "食べたかった"),
         panel("theme-term", "Tategaki", "食べたかった · 食(た)べたかった · 活用 た・たい · gist 一二三")),
     "side-by-side-term.png")
save(row(panel("default-kanji", "Default today", "食 kanji view"),
         panel("theme-kanji", "Tategaki", "食 · 音訓 · 画数 学年 頻度 旧JLPT")),
     "side-by-side-kanji.png")
save(row(panel("default-long", "Default today", "掛けてみる → 掛ける (Jitendex, two dozen senses)"),
         panel("theme-long", "Tategaki", "same entry; the columns continue to the left")),
     "side-by-side-long.png")
save(row(panel("theme-term-popup", "Term", "食べたかった"),
         panel("theme-hover-kanji", "Hover 食", "the kanji link turns 朱"),
         panel("theme-term-scrolled", "Scrolled left", "the Jitendex card: tags, ① to eat, example")),
     "states-term.png")
save(row(panel("theme-focus-toolbar", "Keyboard", "Tab → tabs → audio → note (focus ring)"),
         panel("theme-note-form", "Note", "the form as a 付箋 slip"),
         panel("theme-tab-switched", "Thumb index", "Jitendex tab selected")),
     "states-controls.png")
save(row(panel("theme-te-form", "読んでみよう → 読む", "読(よ)んでみよう · 活用 volitional・みる・て"),
         panel("theme-term-no-anchor", "Without view.anchor", "today's API: no tail, plain bubble")),
     "states-surface.png")
save(row(panel("night-term", "Tategaki (night)", "manga-vertical-night on a dark page"),
         panel("night-kanji", "Tategaki (night)", "食 kanji view")),
     "night.png")
save(row(panel("theme-term-left-page", "Popup left of the word", "860 px window: tail on the right edge"),
         panel("theme-horizontal-page", "Horizontal text", "a VN-style line: popup below, tail on top")),
     "placements.png")
