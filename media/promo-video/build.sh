#!/usr/bin/env bash
# Rebuild the Hachidori promo video:
#   1. record the screenshots from the real extension in headless Chrome (capture/capture.mjs),
#   2. hyperframes lint + check,
#   3. render a near-lossless master and compress it into the GitHub-sized MP4,
#   4. render the cut-only preview variant and turn it into the README GIF,
#   5. extract the poster frame and a 2x2 contact sheet.
#
# Needs: Node.js 22 or newer and ffmpeg + ffprobe (with libx264) on PATH. A fresh capture also
# needs the test tooling (npm ci --prefix test/tooling && npm --prefix test/tooling run install:chrome)
# and PROMO_DICTIONARIES pointing at the five dictionaries listed in README.md.
# Usage: media/promo-video/build.sh [--skip-capture]
#   --skip-capture  reuse video/captures.js and video/assets/captures/; missing screenshots are
#                   fetched from the media/promo-video branch
#   OUT_DIR=...     write the outputs somewhere other than media/promo-video/out
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HF="hyperframes@0.8.104"
OUT="${OUT_DIR:-$HERE/out}"
MP4="$OUT/hachidori-promo.mp4"
GIF="$OUT/hachidori-promo.gif"
# Anonymous HyperFrames usage telemetry stays off unless you opt back in.
export HYPERFRAMES_NO_TELEMETRY="${HYPERFRAMES_NO_TELEMETRY:-1}"

if [[ "${1:-}" == "--skip-capture" ]]; then
  if [[ ! -d "$HERE/video/assets/captures" ]]; then
    git -C "$ROOT" fetch --depth 1 origin media/promo-video
    git -C "$ROOT" archive FETCH_HEAD media/promo-video/video/assets/captures | tar -x -C "$ROOT"
  fi
else
  node "$HERE/capture/capture.mjs"
fi

mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$HERE/video"
npx --yes "$HF" browser ensure
npx --yes "$HF" lint
npx --yes "$HF" check

# HyperFrames encodes H.264 without B-frames. Render a near-lossless master and let x264's
# veryslow preset make the final file: about 8 MB, against 13 MB for a direct --crf 20 render.
npx --yes "$HF" render --crf 10 --output "$TMP/master.mp4"
ffmpeg -v error -y -i "$TMP/master.mp4" -c:v libx264 -preset veryslow -crf 20 -pix_fmt yuv420p \
  -profile:v high -movflags +faststart -an "$MP4"

# README GIF: the preview variant cuts instead of zooming or crossfading, which keeps the
# whole minute under 4 MB at 720 px and 10 fps.
npx --yes "$HF" render --variables '{"preview":true}' --strict-variables --crf 10 --output "$TMP/preview.mp4"
ffmpeg -v error -y -i "$TMP/preview.mp4" \
  -vf "fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "$GIF"

# Poster (the lookup popup) and four stills for the pull request.
ffmpeg -v error -y -ss 15.7 -i "$MP4" -frames:v 1 -q:v 3 "$OUT/poster.jpg"
ffmpeg -v error -y -ss 7.9 -i "$MP4" -ss 15.7 -i "$MP4" -ss 30.6 -i "$MP4" -ss 52.9 -i "$MP4" \
  -filter_complex "[0]scale=960:540[a];[1]scale=960:540[b];[2]scale=960:540[c];[3]scale=960:540[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack" \
  -frames:v 1 -q:v 3 "$OUT/stills.jpg"

ffprobe -v error -show_entries format=duration,size:stream=codec_name,profile,width,height,r_frame_rate -of compact "$MP4"
ls -l "$OUT"
