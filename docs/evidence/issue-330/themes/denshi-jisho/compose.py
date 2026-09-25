#!/usr/bin/env python3
"""Compose the denshi-jisho evidence sheets (issue #334).

    python3 compose.py <dir with default-*.png and dj-*.png>

Writes side-by-side-term.png (default vs 電子辞書, 食べたかった), side-by-side-kanji.png
(食 kanji view), keyboard-flow.png (↓ → 決定 → 訳 → ジャンプ) and menu-backlight.png
into the same directory. Labels use Noto Sans CJK JP from ~/.fonts.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
FONT = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Bold.otf"), 28)
SMALL = ImageFont.truetype(str(Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"), 22)
GUTTER, LABEL, BG, INK, MUTED = 26, 66, (236, 232, 226), (40, 40, 40), (96, 96, 96)


def panel(name, title, subtitle, width=None):
    image = Image.open(OUT / f"{name}.png").convert("RGB")
    if width and image.width != width:
        image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
    canvas = Image.new("RGB", (image.width, image.height + LABEL), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 4), title, font=FONT, fill=INK)
    draw.text((8, 36), subtitle, font=SMALL, fill=MUTED)
    canvas.paste(image, (0, LABEL))
    return canvas


def row(*panels):
    height = max(p.height for p in panels)
    canvas = Image.new("RGB", (sum(p.width for p in panels) + GUTTER * (len(panels) - 1), height), BG)
    x = 0
    for p in panels:
        canvas.paste(p, (x, 0))
        x += p.width + GUTTER
    return canvas


def grid(rows):
    width = max(r.width for r in rows)
    canvas = Image.new("RGB", (width, sum(r.height for r in rows) + GUTTER * (len(rows) - 1)), BG)
    y = 0
    for r in rows:
        canvas.paste(r, (0, y))
        y += r.height + GUTTER
    return canvas


def save(image, name):
    image.save(OUT / name, optimize=True)
    print(name, image.size, (OUT / name).stat().st_size, "bytes")


save(row(panel("default-term", "Default today", "食べたかった · JMdict + fixture · Hachidori 0.1.6"),
         panel("dj-term-list", "電子辞書 (denshi-jisho)", "same lookup · candidate list + preview · theme.css + theme.js")),
     "side-by-side-term.png")
save(row(panel("default-kanji", "Default today", "食 kanji view"),
         panel("dj-kanji", "電子辞書 — 漢字辞典 screen", "ジャンプ → 決定 on 食 · readings table · fixture + KANJIDIC")),
     "side-by-side-kanji.png")
half = 640
save(grid([
    row(panel("dj-term-down", "↓ (cursor pad / ArrowDown)", "the cursor moves to candidate 2, the preview follows", half),
        panel("dj-term-detail", "決定 (Enter)", "詳細: the list folds away, the entry gets the whole screen", half)),
    row(panel("dj-term-yaku-off", "訳 (DEF) off", "senses blanked to dashes for recall; the LED goes dark", half),
        panel("dj-term-jump", "ジャンプ (JUMP)", "the kanji cursor boxes 食; ←→ move it, 決定 opens 漢字辞典", half)),
]), "keyboard-flow.png")
save(row(panel("dj-menu", "メニュー (MENU)", "Anki · Note · 訳 · backlight switches · last 5 lookups of this page", half),
         panel("dj-kanji-backlight-off", "バックライト OFF", "reflective LCD; ink stays 7.5:1", half)),
     "menu-backlight.png")
if (OUT / "dj-long-list.png").exists():
    save(grid([
        row(panel("default-long", "Default today", "取った → 取る · JMdict (many senses)", half),
            panel("dj-long-list", "電子辞書 list", "5 candidates, first preview", half)),
        row(panel("dj-long-detail", "決定 → 詳細", "numbered senses ❶❷❸ on the whole screen", half),
            panel("dj-long-detail-scrolled", "PageDown", "the LCD scrolls; the title band and keys stay put", half)),
    ]), "long-entry.png")
