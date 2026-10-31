# Composes shots.mjs output into one main-versus-branch filmstrip per palette.
# Usage: python3 compose.py <out dir> <font with Latin and CJK glyphs, e.g. NotoSansJP-Regular.ttf>
import sys
from PIL import Image, ImageDraw, ImageFont

out, font_path = sys.argv[1:3]
font = ImageFont.truetype(font_path, 19)
steps = ["1-term", "2-kanji", "3-alt-b", "4-alt-f"]
captions = ["1. Hover 食べたかった", "2. Click 食", "3. Alt+B (Back)", "4. Alt+F"]
scale = 0.6
for theme in ["default", "light"]:
    frames = {rev: [Image.open(f"{out}/{rev}-{theme}-{s}.png").convert("RGB") for s in steps] for rev in ["main", "branch"]}
    w, h = frames["main"][0].size
    fw, fh = int(w * scale), int(h * scale)
    label_w, top, gap = 120, 40, 12
    sheet = Image.new("RGB", (label_w + 4 * (fw + gap) + gap, top + 2 * (fh + gap) + gap), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for column, caption in enumerate(captions):
        draw.text((label_w + gap + column * (fw + gap), 6), caption, fill=(20, 20, 20), font=font)
    for row, (rev, name) in enumerate([("main", "main\ncc2bc3c1"), ("branch", "this PR")]):
        y = top + row * (fh + gap)
        draw.multiline_text((10, y + fh // 2 - 24), name, fill=(20, 20, 20), font=font, spacing=4)
        for column, frame in enumerate(frames[rev]):
            x = label_w + gap + column * (fw + gap)
            sheet.paste(frame.resize((fw, fh), Image.LANCZOS), (x, y))
            draw.rectangle([x - 1, y - 1, x + fw, y + fh], outline=(160, 160, 160))
    sheet.save(f"{out}/history-forward-{theme}.png", optimize=True)
