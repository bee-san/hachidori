#!/usr/bin/env python3
"""Compose the RPG Dialogue evidence images from the capture output (issue #334).

    python3 compose.py <EVIDENCE_OUT dir>

Writes, in that dir:
  side-by-side-term.png    default vs RPG term view of 食べたかった
  side-by-side-kanji.png   default vs RPG 食 kanji / item view
  pages.png                RPG pages 1 · 2 · 3 (typewriter, sense paging)
  screenshot.png           the store card image, 1120×840 (RPG term view)
All labels are drawn here with a bundled CJK font; no product logos are used.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT_DIR = Path.home() / ".fonts"
BOLD = ImageFont.truetype(str(FONT_DIR / "NotoSansCJKjp-Bold.otf"), 30)
SMALL = ImageFont.truetype(str(FONT_DIR / "NotoSansCJKjp-Regular.otf"), 22)
GUTTER, LABEL, BG, INK, DIM = 26, 62, (12, 14, 40), (240, 240, 255), (150, 156, 210)


def load(name):
    return Image.open(OUT / f"{name}.png").convert("RGB")


def panel(name, title, subtitle=""):
    image = load(name)
    canvas = Image.new("RGB", (image.width, image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 6), title, font=BOLD, fill=INK)
    if subtitle:
        draw.text((12 + draw.textlength(title, font=BOLD) + 16, 14), subtitle, font=SMALL, fill=DIM)
    canvas.paste(image, (0, LABEL))
    return canvas


def row(panels, gutter=GUTTER):
    height = max(p.height for p in panels)
    width = sum(p.width for p in panels) + gutter * (len(panels) - 1)
    canvas = Image.new("RGB", (width, height), BG)
    x = 0
    for p in panels:
        canvas.paste(p, (x, 0))
        x += p.width + gutter
    return canvas


def save(image, name):
    image.save(OUT / name, optimize=True)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")


save(row([panel("default-term", "Default", "食べたかった"),
         panel("rpg-term", "RPG Dialogue", "食べたかった · theme.css + theme.js")]), "side-by-side-term.png")
save(row([panel("default-kanji", "Default", "食 kanji view"),
         panel("rpg-kanji", "RPG Dialogue", "食 as an item window")]), "side-by-side-kanji.png")
save(row([panel("rpg-term", "Page 1", "食べる · sense 1, typed"),
         panel("rpg-term-page2", "Page 2", "Space →"),
         panel("rpg-term-page3", "Page 3", "next dictionary")]), "pages.png")

# Store card image: 1120×840, the RPG term view centred on the theme's own stage.
card = Image.new("RGB", (1120, 840), (8, 8, 18))
draw = ImageDraw.Draw(card)
for y in range(840):  # vertical stage gradient
    t = y / 840
    draw.line([(0, y), (1120, y)], fill=(int(40 - 26 * t), int(26 - 14 * t), int(70 - 44 * t)))
shot = load("rpg-term")
scale = min((1120 - 80) / shot.width, (840 - 80) / shot.height)
shot = shot.resize((int(shot.width * scale), int(shot.height * scale)), Image.NEAREST)
card.paste(shot, ((1120 - shot.width) // 2, (840 - shot.height) // 2))
save(card, "screenshot.png")
