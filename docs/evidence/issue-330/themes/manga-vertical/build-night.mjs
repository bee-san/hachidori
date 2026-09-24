// Evidence for issue #334 (manga-vertical theme): derives the dark-page variant
// `manga-vertical-night` from `manga-vertical`. The two share theme.css and
// theme.js; only the slug and the palette block differ. hachidori-themes has no
// way yet for a child theme to inherit a parent's css/js (see the proposal's
// API gaps), so this copies the files with the slug and palette replaced.
//
//   node build-night.mjs <extension/vendor/themes>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const THEMES = resolve(process.argv[2]);
const LIGHT = resolve(THEMES, "manga-vertical");
const NIGHT = resolve(THEMES, "manga-vertical-night");
mkdirSync(NIGHT, { recursive: true });

export const NIGHT_PALETTE = {          // a dark page for reading in bed: near-black stock, warm off-white ink
  "color-scheme": "dark",
  "base-100": "#16171b",
  "base-200": "#1e2026",
  "base-300": "#2a2d35",
  "base-content": "#ece6d8",
  "primary": "#e8836b",                 // lighter 朱 for contrast on the dark page
  "primary-content": "#16171b",
  "secondary": "#93b4e6",
  "secondary-content": "#16171b",
  "accent": "#d1b45a",
  "accent-content": "#16171b",
  "neutral": "#aaa59b",                 // grammar tags are outlined text on the dark page
  "neutral-content": "#16171b",
  "info": "#8fb0e0",                    // frequency seals, likewise
  "info-content": "#16171b",
  "success": "#7fbf7a",
  "warning": "#e0a94a",
  "error": "#ef6b5c",
};

const slugged = text => text.replaceAll('data-hoshidicts-theme="manga-vertical"', 'data-hoshidicts-theme="manga-vertical-night"')
  .replaceAll('slug: "manga-vertical"', 'slug: "manga-vertical-night"')
  .replaceAll("themes/manga-vertical/", "themes/manga-vertical-night/");

let css = slugged(readFileSync(resolve(LIGHT, "theme.css"), "utf8"));
for (const [key, value] of Object.entries(NIGHT_PALETTE)) {
  const pattern = new RegExp(`(--hoshidicts-palette-${key}: )[^;]+;`, "u");
  if (!pattern.test(css)) throw new Error(`palette key ${key} not found`);
  css = css.replace(pattern, `$1${value};`);
}
writeFileSync(resolve(NIGHT, "theme.css"), css);
writeFileSync(resolve(NIGHT, "theme.js"), slugged(readFileSync(resolve(LIGHT, "theme.js"), "utf8")));

const paletteYaml = Object.entries(NIGHT_PALETTE).map(([key, value]) => `  ${key}: "${value}"`).join("\n");
writeFileSync(resolve(NIGHT, "theme.yaml"), `# themes/manga-vertical-night/theme.yaml — Hachidori theme manifest, schema 1
schema: 1
slug: manga-vertical-night
name: Tategaki (manga, night)
version: 1.0.0
author: bee-san
link: https://github.com/bee-san/hachidori/issues/334
description: The Tategaki vertical margin note on a dark page for reading manga at night. Same vertical-rl layout, ruby furigana, tail and toolbar as manga-vertical; near-black stock with warm off-white ink.
tags: [dark, manga, compact, classic, js]
license: GPL-3.0-or-later
minHachidoriVersion: 0.1.7
mode: dark
extends: manga-vertical        # proposal: inherit theme.css + theme.js from the parent, override only the palette
palette:
${paletteYaml}
css: theme.css                 # today: a copy of manga-vertical/theme.css with this slug and palette
js:
  file: theme.js               # today: a copy of manga-vertical/theme.js with this slug
  hooks: [onRender]
  summary: Adds furigana to the word as written in the bubble, moves the buttons into a vertical toolbar, rebuilds the kanji view as a colophon, points the tail at the word, lists the words looked up on this page.
options:
  popupWidthPx: 320
  popupHeightPx: 560
  popupOpacityPercent: 100
  popupColumns: 1
  popupToolbarPosition: top
  showCompactDefinitionSummary: true
  compactDefinitionSummaryCount: 3
  showPitchAccentBadge: false
screenshot: screenshot.png
preview:
  swatches: ["#16171b", "#ece6d8", "#e8836b", "#93b4e6"]
`);
console.log(`wrote ${NIGHT}`);
