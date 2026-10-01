#!/usr/bin/env bash
# Rebuild the woff2 subsets in video/assets/fonts from the upstream releases:
# Inter 4.1 (rsms/inter) and Noto Sans JP 2.004 (notofonts/noto-cjk), both SIL OFL 1.1.
# The Japanese subset keeps only the characters video/index.html uses, so run this
# again after adding Japanese text to a caption.
#
# Needs: curl, unzip, Python 3 with fontTools 4.60.1 and brotli.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIDEO="$HERE/../video"
OUT="$VIDEO/assets/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

curl -fsSL -o "$TMP/inter.zip" https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
unzip -q "$TMP/inter.zip" -d "$TMP/inter"
cp "$TMP/inter/LICENSE.txt" "$OUT/LICENSE-Inter-OFL.txt"
curl -fsSL -o "$TMP/NotoSansJP-Bold.otf" \
  https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/SubsetOTF/JP/NotoSansJP-Bold.otf
curl -fsSL -o "$OUT/LICENSE-NotoSansJP-OFL.txt" https://github.com/notofonts/noto-cjk/raw/Sans2.004/LICENSE

# Latin, the punctuation the captions use, and arrows.
LATIN="U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-2019,U+201C-201D,U+2022,U+2026,U+2190-2193,U+2212"
for face in Inter-Medium Inter-SemiBold InterDisplay-Bold InterDisplay-ExtraBold; do
  python3 -m fontTools.subset "$TMP/inter/extras/ttf/$face.ttf" --unicodes="$LATIN" \
    --layout-features="kern,liga,calt" --flavor=woff2 --output-file="$OUT/$face.woff2"
done

# Every kana, kanji and full-width character in the composition.
python3 - "$VIDEO/index.html" > "$TMP/ja.txt" <<'EOF'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
print("".join(sorted(set(re.findall(r"[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]", text)))))
EOF
echo "Japanese subset: $(cat "$TMP/ja.txt")"
python3 -m fontTools.subset "$TMP/NotoSansJP-Bold.otf" --text-file="$TMP/ja.txt" \
  --layout-features="*" --flavor=woff2 --output-file="$OUT/NotoSansJP-Bold-subset.woff2"
ls -l "$OUT"
