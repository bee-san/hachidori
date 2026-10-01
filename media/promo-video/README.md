# Hachidori promo video

A 59-second tour of Hachidori's best features, made with [HyperFrames](https://hyperframes.heygen.com/). Every
window in the video is a real screenshot of the extension, recorded in headless Chrome by
`capture/capture.mjs`; the composition only frames, zooms and captions them.

▶ [Watch the MP4](https://cdn.jsdelivr.net/gh/bee-san/hachidori@27ac4da45bf6c63f07f16108af386a941b3972b9/media/promo-video/out/hachidori-promo.mp4)
(1920×1080, H.264 High, 30 fps, 8.4 MB) ·
[README GIF](https://cdn.jsdelivr.net/gh/bee-san/hachidori@27ac4da45bf6c63f07f16108af386a941b3972b9/media/promo-video/out/hachidori-promo.gif)
(720 px, 10 fps, 3.9 MB) ·
[stills](https://cdn.jsdelivr.net/gh/bee-san/hachidori@27ac4da45bf6c63f07f16108af386a941b3972b9/media/promo-video/out/stills.jpg)

The rendered files and the screenshots are kept off `main`, on the
[`media/promo-video`](https://github.com/bee-san/hachidori/tree/media/promo-video) branch. The links above go
through jsDelivr, pinned to that branch's commit, because jsDelivr serves the MP4 as `video/mp4` and browsers
play it inline.

| Time | Scene | What the screenshots show |
| --- | --- | --- |
| 0:00 | Title | Logo, name and tagline |
| 0:03 | Speed | Settings → Add dictionaries importing five real dictionaries; the Jitendex row and its time |
| 0:10 | Lookups | Hovering 食べたかった: conjugation, pitch accent, frequency and lookup count; clicking 食 for its kanji entry; a lookup inside a comment text area |
| 0:23 | Anki | Settings → Anki finding a Kiku note type, its field mapping, then + adding a card from the popup |
| 0:31 | Personal dictionary | Selecting 千景, which no dictionary has, writing a reading and a definition, and the saved entry |
| 0:40 | Lookup blur | The third lookup of 相変わらず blurs its definitions, then they clear |
| 0:47 | Themes | Design with the Theme Store and live preview, then the same popup in ten themes |
| 0:54 | End card | Chrome Web Store and GitHub links |

## How it is made

1. `capture/capture.mjs` loads `extension/` unpacked in Chrome for Testing 152.0.7977.75 (the build
   `test/tooling` pins) with a throw-away profile. It chooses manual setup, imports the dictionaries through
   Settings, then uses real mouse and keyboard input on `capture/reading.html`, an original short story served
   from `127.0.0.1`. Every request other than that page and a fake AnkiConnect fails, so nothing leaves the
   machine. Each step is saved as a 2560×1440 JPEG (a 1280×720 viewport at 2×) in `video/assets/captures/`;
   `video/captures.js` records the pointer position, popup and element boxes, their text, the import results,
   the note sent to AnkiConnect and the theme names.
2. `video/index.html` is the composition: one paused GSAP 3.14.2 timeline registered as
   `window.__timelines.main`. The `SC` table at the top of its script holds the scene windows (keep the
   `data-start`/`data-duration` attributes in step; the script checks). Each scene lists its beats: which
   screenshot to show, where the camera looks, rings, the cursor and the caption. Boxes and figures (import
   time, term count, lookup count, the fields of the Anki note, theme names) come from `captures.js`, so a new
   capture updates them.
3. `build.sh` renders a near-lossless master with `hyperframes render --crf 10`, then x264 `veryslow`
   (CRF 20, with B-frames, which HyperFrames turns off) makes the final MP4. A direct `--crf 20` render was
   13.1 MB; this one is 8.4 MB.
4. The GIF is rendered from the `preview` variant (`--variables '{"preview":true}'`), which cuts instead of
   zooming the camera or crossfading screenshots. Blended frames are what make a GIF large: with the same
   settings (720 px, 10 fps, one 256-colour palette) the full-motion version is 8.3 MB and the preview 3.9 MB.

What is staged for the recording:

- Anki is a local fake AnkiConnect inside `capture.mjs`. It reports a Kiku note type with three notes in a
  Mining deck, accepts the note and returns its fields. Settings' detection, the field mapping and the
  popup's + button run unchanged against it.
- Settings → Reading → Activation uses No key, so pointing at a word looks it up. Definition blur is on with a
  threshold of 3 lookups and a 3-second reveal. The MDX import and Theme Store experimental features are on.
- The kanji and compact-summary dictionaries are set the way first-run setup sets them for these dictionaries.

## Regenerate

Requirements: Node.js 22 or newer and `ffmpeg`/`ffprobe` with libx264 on `PATH`. A new capture also needs the
test tooling and its Chrome (`npm ci --prefix test/tooling && npm --prefix test/tooling run install:chrome`)
and the five dictionaries below in one directory.

```bash
PROMO_DICTIONARIES=/path/to/dictionaries media/promo-video/build.sh   # capture, check, render, GIF, stills
media/promo-video/build.sh --skip-capture   # reuse video/captures.js and the screenshots
```

`--skip-capture` fetches the screenshots from the `media/promo-video` branch when
`video/assets/captures/` is missing. To preview or render by hand:

```bash
cd media/promo-video/video
npx --yes hyperframes@0.8.104 preview   # live preview in the browser
npx --yes hyperframes@0.8.104 check
npx --yes hyperframes@0.8.104 render --crf 10 --output /tmp/master.mp4
```

Re-rendering from the same screenshots gives the same picture but not the same bytes (against the published
MP4: SSIM 0.9997, PSNR 58 dB), and a new capture records new import times. After a new render, commit the
outputs (and new screenshots) to the `media/promo-video` branch, then update the pinned commit in the links
here and in the top-level `README.md`. `hyperframes lint` reports four warnings
that suggest splitting the single-file composition into sub-compositions; they do not affect the render.

The dictionaries the capture imports, in order (`captures.js` records the hashes of each run):

| File | Source | SHA-256 |
| --- | --- | --- |
| `jitendex-yomitan.zip` (Jitendex.org [2026-08-11]) | [jitendex.org](https://jitendex.org/) | `8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc` |
| `bees-ultimate-kanji-dictionary.zip` | [bee-san/bees-ultimate-kanji-dictionary](https://github.com/bee-san/bees-ultimate-kanji-dictionary) | `e7a75ebdbb8125c71bfda98e3050ba38b00749252e0832a9cc5566a64a260341` |
| `bees-ultimate-grammar-dictionary.zip` | [bee-san/bees-ultimate-grammar-dictionary](https://github.com/bee-san/bees-ultimate-grammar-dictionary) | `089f496d16549a0392ac46aa4b3192bc77319442cfa102dbcf6b86894e4f58a7` |
| `JPDB_v2.2_Frequency_Kana_2024-10-13.zip` | [Kuuuube/yomitan-dictionaries](https://github.com/Kuuuube/yomitan-dictionaries) | `4fa06c784155ea0ea0953740b99d421296c775ee0d035cfe1ff65a40d7d3e685` |
| `kanjium_pitch_accents.zip` | the Yomitan build of [Kanjium](https://github.com/mifunetoshiro/kanjium)'s pitch accents | `90d05ad6efc6f44a495bcc01db6b9d3a0f2f1c42ba38adcbefda0ddfaec8b8c2` |

## Pinned versions

- HyperFrames CLI 0.8.104 and the Chrome build it pins (`npx hyperframes browser ensure`); GSAP 3.14.2 from
  jsDelivr.
- Fonts in `video/assets/fonts`, all SIL OFL 1.1 with their licences: Inter 4.1 (Medium, SemiBold, Display
  Bold and ExtraBold) subset to Latin, and Noto Sans JP 2.004 Bold subset to the Japanese characters in
  `index.html`. `tools/fonts.sh` downloads and subsets them again; run it after adding Japanese to a caption.
- Rendered with FFmpeg 8.1.3.
