# Per run: whether the switch region is absent (one colour), drawn but not final (disabled), or final; and the title and box.
import sys, glob, re, collections
from PIL import Image, ImageChops
out = sys.argv[1]
runs = collections.defaultdict(list)
for path in sorted(glob.glob(f"{out}/run*.png")):
    run, index, at = re.search(r"run(\d+)-(\d+)-(\d+)\.png", path).groups()
    runs[int(run)].append((int(at), path))
def region(img, box):
    w, h = img.size
    sx, sy = w / 900, h / 700
    return img.crop(tuple(int(v * s) for v, s in zip(box, (sx, sy, sx, sy))))
SWITCH, TITLE, BOX = (852, 15, 888, 35), (44, 12, 178, 37), (12, 48, 792, 90)
for run, frames in sorted(runs.items()):
    final = Image.open(frames[-1][1]).convert("RGB")
    states = []
    for at, path in frames:
        img = Image.open(path).convert("RGB")
        same = lambda box: ImageChops.difference(region(img, box), region(final, box)).getbbox() is None
        sw = region(img, SWITCH)
        colours = len(set(sw.getdata()))
        switch = "final" if same(SWITCH) else ("absent" if colours == 1 else "drawn")
        states.append((at, f"switch={switch} title={'Y' if same(TITLE) else 'n'} box={'Y' if same(BOX) else 'n'}"))
    timed = []
    for i, (at, state) in enumerate(states):
        if i == 0 or state != states[i - 1][1]:
            timed.append([state, at])
    print(f"run {run}: " + " | ".join(f"{s} {timed[i + 1][1] - at}ms" if i + 1 < len(timed) else f"{s} (end)" for i, (s, at) in enumerate(timed[:6])))
