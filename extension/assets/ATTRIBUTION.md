# Practice street illustration

`practice-street.webp` was generated for Hachidori with OpenAI's built-in
`image_gen` tool on 2026-09-08, without reference images. No third-party artwork
was supplied as input.

The asset is distributed with Hachidori under the repository's
[GPL-3.0-or-later license](../../LICENSE).

The generated PNG was 1672 × 941 pixels. ImageMagick resized it to cover a
1080 × 607 frame, center-cropped the excess, stripped metadata and encoded WebP
at quality 76. The illustration was inspected after processing.

```sh
magick generated-practice-street.png -resize '1080x607^' -gravity center \
  -extent 1080x607 -strip -quality 76 practice-street.webp
```

- Dimensions: 1080 × 607 pixels.
- Size: 120,310 bytes.
- SHA-256: `ee575e44887fc1dc5d821e14ae01684b0590e8fc83f4e30916b7aa64f7bb3efe`.

## Generation prompt

> Use case: illustration-story. Asset type: original background illustration for a Japanese-learning browser extension's visual-novel-style reading practice panel. Create an original hand-painted anime background of a quiet Japanese residential street on a clear late-summer afternoon, with modest two-storey houses, a low garden wall, green roadside trees, a few utility poles, distant low hills and soft clouds. Eye-level perspective looking down the gently receding street. Warm natural daylight, calm atmosphere, clean detailed linework with soft painted surfaces and restrained colors. Wide landscape composition, approximately 16:9, with useful street space through the lower center where the app will overlay its own reading panel. Background scenery only. No people, characters, logos, signatures, credits, watermark, readable signage, dialogue boxes, UI, or text. Do not copy any particular existing artwork, visual novel, screenshot, identifiable fictional location, or artist's composition. Produce the scenery itself edge to edge.
