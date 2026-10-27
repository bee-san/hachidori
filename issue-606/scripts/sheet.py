"""Compose labelled before/after screenshot sheets (scratch, not committed).

python3 sheet.py <output.png> <max-width> <column-label>... -- <row-label> <png>... [-- <row-label> <png>...]
"""
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = "/tmp/hachi-606/fonts/NotoSansJP[wght].ttf"


def main():
    output, max_width, *rest = sys.argv[1:]
    groups = []
    current = []
    for item in rest:
        if item == "--":
            groups.append(current)
            current = []
        else:
            current.append(item)
    groups.append(current)
    columns, rows = groups[0], groups[1:]
    images = [[Image.open(path).convert("RGB") for path in row[1:]] for row in rows]
    font = ImageFont.truetype(FONT, 26)
    label_width = max(ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(row[0], font=font) for row in rows) + 24
    cell_width = max(image.width for row in images for image in row)
    cell_heights = [max(image.height for image in row) for row in images]
    header = 44
    gap = 12
    width = int(label_width + len(columns) * (cell_width + gap))
    height = header + sum(cell_heights) + gap * len(rows)
    sheet = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(sheet)
    for index, column in enumerate(columns):
        draw.text((label_width + index * (cell_width + gap), 6), column, fill="black", font=font)
    y = header
    for row, row_images, cell_height in zip(rows, images, cell_heights):
        draw.text((8, y + 8), row[0], fill="black", font=font)
        for index, image in enumerate(row_images):
            sheet.paste(image, (int(label_width + index * (cell_width + gap)), y))
        y += cell_height + gap
    limit = int(max_width)
    if sheet.width > limit:
        sheet = sheet.resize((limit, round(sheet.height * limit / sheet.width)), Image.LANCZOS)
    sheet.save(output)
    print(output, sheet.size)


main()
