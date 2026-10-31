#!/usr/bin/env python3
# Compose the PR's and docs' search page picture from the e2e screenshots:
# the search page, the toolbar menu and the popup window, side by side.
import sys
from pathlib import Path
from PIL import Image

shots = Path(sys.argv[1])
out = Path(sys.argv[2])
page = Image.open(shots / "search-page.png").convert("RGB")
menu = Image.open(shots / "toolbar-menu.png").convert("RGB")
window = Image.open(shots / "popup-window.png").convert("RGB")

gap, margin = 16, 16
height = page.height
scale = (height - menu.height - gap) / window.height
window = window.resize((round(window.width * scale), round(window.height * scale)), Image.LANCZOS)
right = max(menu.width, window.width)
canvas = Image.new("RGB", (margin * 2 + page.width + gap + right, margin * 2 + height), (229, 231, 235))
canvas.paste(page, (margin, margin))
x = margin + page.width + gap
canvas.paste(menu, (x, margin))
canvas.paste(window, (x, margin + menu.height + gap))
canvas.save(out, optimize=True)
print(out, canvas.size, out.stat().st_size)
