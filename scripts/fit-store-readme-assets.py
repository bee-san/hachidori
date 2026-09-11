#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fit existing project artwork to opaque Chrome Web Store PNG canvases.

Requires Pillow 11.3.0. Run from any directory; --check-only needs no network.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs/store/readme'
BACKGROUND = '#faf8ff'
INK = '#332449'
MUTED = '#685c7a'
# Preserve the README artwork, including its wording. No new benchmark is run.
SCREENSHOTS = [
    ('01-japanese-lookup-1280x800.png', 'Japanese lookup',
     'docs/assets/install-in-60-seconds.gif', 1.0),
    ('02-dictionary-import-1280x800.png', 'Dictionary import benchmark',
     'https://github.com/user-attachments/assets/c507c940-f61e-4063-8d2c-9e43184cd7d3', None),
    ('03-word-lookup-1280x800.png', 'Word lookup benchmark',
     'https://github.com/user-attachments/assets/1236ca54-394e-403e-84d8-9441b31b4786', None),
    ('04-custom-dictionary-1280x800.png', 'Custom dictionary',
     'docs/assets/custom-dictionary.gif', 1.0),
    ('05-lookup-blur-1280x800.png', 'Lookup blur',
     'docs/assets/lookup-blur.gif', 0.35),
]


def read_source(source: str) -> bytes:
    if source.startswith('https://'):
        request = Request(source, headers={'User-Agent': 'hachidori-store-assets/1.0'})
        with urlopen(request, timeout=60) as response:
            return response.read()
    return (ROOT / source).read_bytes()


def opaque(image: Image.Image, background: str = BACKGROUND) -> Image.Image:
    rgba = image.convert('RGBA')
    canvas = Image.new('RGBA', rgba.size, background)
    return Image.alpha_composite(canvas, rgba).convert('RGB')


def fit(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Letterbox the complete source: never stretch it or crop its content."""
    source = opaque(image)
    corners = [source.getpixel(p) for p in (
        (0, 0), (source.width - 1, 0),
        (0, source.height - 1), (source.width - 1, source.height - 1))]
    background = tuple(sorted(pixel[channel] for pixel in corners)[2]
                       for channel in range(3))
    canvas = Image.new('RGB', size, background)
    scaled = ImageOps.contain(source, size, Image.Resampling.LANCZOS)
    canvas.paste(scaled, ((size[0] - scaled.width) // 2,
                          (size[1] - scaled.height) // 2))
    return canvas


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf'
    return ImageFont.truetype(name, size)


def promo(logo: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Lay out the existing hummingbird logo and plain type, without AI art."""
    canvas = Image.new('RGB', size, BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    if size == (440, 280):
        scaled = ImageOps.contain(logo, (160, 160), Image.Resampling.LANCZOS)
        canvas.paste(scaled, ((440 - scaled.width) // 2, 12), scaled)
        draw.text((220, 180), 'Hachidori', font=font(34, True), fill=INK, anchor='mt')
        draw.text((220, 228), 'Japanese dictionary', font=font(18), fill=MUTED, anchor='mt')
    else:
        scaled = ImageOps.contain(logo, (390, 390), Image.Resampling.LANCZOS)
        canvas.paste(scaled, (55 + (390 - scaled.width) // 2,
                              (560 - scaled.height) // 2), scaled)
        draw.text((505, 142), 'Hachidori', font=font(88, True), fill=INK)
        draw.text((510, 263), 'Japanese dictionary for your browser', font=font(35), fill=INK)
        draw.text((510, 346), 'Local lookup  ·  Pronunciation  ·  Anki', font=font(26), fill=MUTED)
    return canvas


def validate(path: Path, size: tuple[int, int]) -> None:
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise ValueError(f'{path.name}: not a PNG')
    width, height, depth, colour = struct.unpack('>IIBB', data[16:26])
    if (width, height) != size or (depth, colour) != (8, 2):
        raise ValueError(f'{path.name}: expected {size}, 8-bit RGB PNG without alpha')
    with Image.open(path) as image:
        image.load()
        if image.mode != 'RGB' or 'transparency' in image.info:
            raise ValueError(f'{path.name}: unexpected transparency')


def build() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    records = []

    def save(image: Image.Image, name: str, title: str, source: str,
             source_bytes: bytes, frame: int | None = None) -> None:
        path = OUTPUT / name
        image.convert('RGB').save(path, format='PNG', optimize=True)
        validate(path, image.size)
        records.append({'file': name, 'title': title, 'width': image.width,
                        'height': image.height, 'mode': 'RGB', 'bits_per_pixel': 24,
                        'source': source, 'source_sha256': hashlib.sha256(source_bytes).hexdigest(),
                        'frame': frame, 'bytes': path.stat().st_size,
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        print(f'{name}: {image.width} x {image.height}, RGB, {path.stat().st_size:,} bytes', flush=True)

    for name, title, source, position in SCREENSHOTS:
        data = read_source(source)
        with Image.open(io.BytesIO(data)) as image:
            frame = None
            if position is not None:
                frame = round((image.n_frames - 1) * position)
                image.seek(frame)
            print(f'Source {source}: {image.size}, frame={frame}', flush=True)
            save(fit(image, (1280, 800)), name, title, source, data, frame)

    logo_source = 'docs/assets/hachidori.png'
    logo_bytes = read_source(logo_source)
    with Image.open(io.BytesIO(logo_bytes)) as original:
        logo = original.convert('RGBA')
        for name, title, size in [
            ('small-promo-440x280.png', 'Small promo tile', (440, 280)),
            ('marquee-promo-1400x560.png', 'Marquee promo tile', (1400, 560)),
        ]:
            save(promo(logo, size), name, title, logo_source, logo_bytes)

    (OUTPUT / 'manifest.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    rows = ['| Upload field | File | Canvas |', '| --- | --- | --- |']
    for index, record in enumerate(records):
        field = f'Screenshot {index + 1}' if index < 5 else record['title']
        rows.append(f"| {field} | [{record['file']}]({record['file']}) | {record['width']} × {record['height']} |")
    readme = '''# README artwork fitted for the Chrome Web Store

Upload the PNGs individually to the matching dashboard fields. All seven files
are **24-bit RGB PNGs without alpha**, at the exact sizes below.

''' + '\n'.join(rows) + '''

The five screenshots reuse the README's setup/lookup, import benchmark, lookup
benchmark, custom-dictionary and lookup-blur artwork. GIFs are exported as a
single static frame. Images are resized proportionally with matching edge-color
padding; their content is neither cropped nor stretched. The two promo tiles
reuse the existing high-resolution hummingbird logo with plain typography.

The original artwork and extension runtime are unchanged. These files are
outside `extension/` and are not part of the Chrome extension upload package.
The existing [native Chrome screenshots](../README.md) remain available too.
Benchmark claims are preserved from the supplied artwork, not newly measured
or independently verified by this conversion.

## Regenerate

From the repository root, with Python 3.10+ and DejaVu Sans installed:

```sh
python3 -m pip install Pillow==11.3.0
python3 scripts/fit-store-readme-assets.py
python3 scripts/fit-store-readme-assets.py --check-only
```

Generation downloads the two image attachments linked in the README. All other
sources are already in the repository. No browser, dictionary import, Anki
instance or image-generation service is required. Fonts are read from the
system and are not copied into this folder.

[manifest.json](manifest.json) records source URLs/paths, source checksums,
selected GIF frames, output sizes and output checksums. `--check-only` verifies
the seven files, dimensions, PNG bit depth/color type, lack of transparency and
checksums without accessing the network. Source artwork retains its existing
project attribution and licensing; see [asset rights](../../asset-rights.md).
'''
    (OUTPUT / 'README.md').write_text(readme, encoding='utf-8')


def check() -> None:
    records = json.loads((OUTPUT / 'manifest.json').read_text(encoding='utf-8'))
    expected = {entry[0]: (1280, 800) for entry in SCREENSHOTS}
    expected.update({'small-promo-440x280.png': (440, 280),
                     'marquee-promo-1400x560.png': (1400, 560)})
    if len(records) != 7 or {record['file'] for record in records} != set(expected):
        raise ValueError('Expected exactly five screenshots and two promotional tiles')
    for record in records:
        path = OUTPUT / record['file']
        validate(path, expected[path.name])
        if hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError(f'{path.name}: checksum mismatch')
    print('PASS: all 7 outputs have exact dimensions, 24-bit RGB PNG encoding, no alpha, and matching checksums.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-only', action='store_true')
    arguments = parser.parse_args()
    if not arguments.check_only:
        build()
    check()
