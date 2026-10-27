#!/usr/bin/env python3
# Lays out shots.mjs's captures as one labelled before/after grid per palette.
import re
from PIL import Image, ImageDraw, ImageFont

import glob
JAPANESE = ImageFont.truetype('/usr/share/fonts/google-droid-sans-fonts/DroidSansFallbackFull.ttf', 28)
LATIN = ImageFont.truetype((glob.glob('/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf') or glob.glob('/usr/share/fonts/**/DejaVuSans*.ttf', recursive=True))[0], 26)


def label(draw, position, text, fill):
    # Droid Sans Fallback has no Latin glyphs here and DejaVu has no kana.
    x, y = position
    for run in re.findall(r'[\u3000-\u9fff]+|[^\u3000-\u9fff]+', text):
        font = JAPANESE if '\u3000' <= run[0] <= '\u9fff' else LATIN
        draw.text((x, y), run, fill=fill, font=font)
        x += draw.textlength(run, font=font)
TITLES = ['自由 じゆう [2] · adj-i n', '料理 りょうり [1] · vs', '高い たかい [2] · adj-i']
for theme in ['light', 'default']:
    cells = [[Image.open(f'{side}-{theme}-{index}.png').convert('RGB') for index in range(3)] for side in ['before', 'after']]
    width, height = cells[0][0].size
    left, gap, top = 200, 16, 56
    background = (255, 255, 255) if theme == 'light' else (17, 17, 17)
    text = (20, 20, 20) if theme == 'light' else (235, 235, 235)
    grid = Image.new('RGB', (left + 3 * width + 2 * gap, top + 2 * height + gap), background)
    draw = ImageDraw.Draw(grid)
    for column, title in enumerate(TITLES):
        label(draw, (left + column * (width + gap) + 12, 12), title, text)
    for row, side in enumerate(['main', 'this PR']):
        label(draw, (14, top + row * (height + gap) + height // 2 - 16), side, text)
        for column in range(3):
            grid.paste(cells[row][column], (left + column * (width + gap), top + row * (height + gap)))
    grid.save(f'issue-608-{theme}.png', optimize=True)
    preview = grid.copy()
    preview.thumbnail((1280, 1280))
    preview.save(f'view-{theme}.png')
    print(theme, grid.size)
