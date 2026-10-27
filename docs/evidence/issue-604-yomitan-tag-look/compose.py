"""Compose labelled comparison images for the #604 PR from the harness shots."""
from PIL import Image, ImageDraw, ImageFont

SHOTS = "/tmp/hachi-604/shots"
OUT = "/tmp/hachi-604/evidence"
FONT = ImageFont.truetype("/tmp/hachi-604/fonts/NotoSansCJKjp-Bold.otf", 26)
SMALL = ImageFont.truetype("/tmp/hachi-604/fonts/NotoSansCJKjp-Bold.otf", 22)


def load(name, scale=1.0):
    image = Image.open(f"{SHOTS}/{name}.png").convert("RGB")
    if scale != 1.0:
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    return image


def labelled(image, label, background, foreground, font=FONT):
    height = font.size + 18
    canvas = Image.new("RGB", (image.width, image.height + height), background)
    ImageDraw.Draw(canvas).text((10, 6), label, fill=foreground, font=font)
    canvas.paste(image, (0, height))
    return canvas


def row(images, gap, background):
    width = sum(image.width for image in images) + gap * (len(images) - 1)
    height = max(image.height for image in images)
    canvas = Image.new("RGB", (width, height), background)
    x = 0
    for image in images:
        canvas.paste(image, (x, 0))
        x += image.width + gap
    return canvas


def column(images, gap, background):
    width = max(image.width for image in images)
    height = sum(image.height for image in images) + gap * (len(images) - 1)
    canvas = Image.new("RGB", (width, height), background)
    y = 0
    for image in images:
        canvas.paste(image, (0, y))
        y += image.height + gap
    return canvas


def save(image, name, limit=2400):
    if max(image.size) > limit:
        factor = limit / max(image.size)
        image = image.resize((round(image.width * factor), round(image.height * factor)), Image.LANCZOS)
    image.save(f"{OUT}/{name}.png", optimize=True)
    print(name, image.size)


import os
os.makedirs(OUT, exist_ok=True)

for scheme, palette, background, foreground in [("light", "light", "#ffffff", "#202020"),
                                                 ("dark", "default", "#1e1e1e", "#e8e8e8")]:
    save(row([
        labelled(load(f"yomitan-{scheme}"), f"Yomitan d3c54c1 ({scheme})", background, foreground),
        labelled(load(f"base-{palette}"), f"Hachidori main ({palette})", background, foreground),
        labelled(load(f"branch-{palette}"), f"This PR ({palette})", background, foreground),
    ], 24, background), f"yomitan-main-pr-{palette}")

palettes = ["girlypop", "solarized-light", "cupcake", "retro", "dracula", "catppuccin-mocha", "nord", "high-contrast"]
cells = []
for palette in palettes:
    background = "#ffffff" if palette in ("girlypop", "solarized-light", "cupcake", "retro", "nord") else "#1e1e1e"
    foreground = "#202020" if background == "#ffffff" else "#e8e8e8"
    cells.append(row([
        labelled(load(f"base-{palette}", 0.5), f"{palette}: main", background, foreground, SMALL),
        labelled(load(f"branch-{palette}", 0.5), f"{palette}: this PR", background, foreground, SMALL),
    ], 12, background))
save(column(cells[:4], 16, "#808080"), "palettes-light")
save(column(cells[4:], 16, "#808080"), "palettes-dark")

save(row([
    labelled(load("base-compact-light"), "Compact glossaries: main", "#ffffff", "#202020"),
    labelled(load("branch-compact-light"), "Compact glossaries: this PR", "#ffffff", "#202020"),
], 24, "#ffffff"), "compact-light")

save(row([
    labelled(load("base-forced-dark-default"), "Forced colours (dark): main", "#000000", "#ffffff"),
    labelled(load("branch-forced-dark-default"), "Forced colours (dark): this PR", "#000000", "#ffffff"),
    labelled(load("branch-forced-light-light"), "Forced colours (light): this PR", "#ffffff", "#000000"),
], 24, "#808080"), "forced-colors")
