// SPDX-License-Identifier: GPL-3.0-or-later
// Issue #458: each pitch accent group colour keeps 3:1 on every popup palette
// and stays distinct from the other groups in its colour scheme.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const read = path => readFileSync(new URL(`../extension/${path}`, import.meta.url), "utf8");
const css = read("render/reader.css");
const GROUPS = ["heiban", "atamadaka", "nakadaka", "odaka", "kifuku"];

// sRGB channels (0–1) of a palette value: hex, or oklch() through CSS Color 4's
// OKLab matrices, clipped to the gamut as Chrome paints it.
function channels(value) {
  const hex = /^#([\da-f]{6})$/iu.exec(value);
  if (hex) return hex[1].match(/../gu).map(pair => Number.parseInt(pair, 16) / 255);
  const oklch = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/u.exec(value);
  assert.ok(oklch, `${value} is a hex or oklch() colour`);
  const [lightness, chroma, hue] = [Number(oklch[1]) / 100, Number(oklch[2]), Number(oklch[3]) * Math.PI / 180];
  const [a, b] = [chroma * Math.cos(hue), chroma * Math.sin(hue)];
  const [l, m, s] = [[0.3963377774, 0.2158037573], [-0.1055613458, -0.0638541728], [-0.0894841775, -1.291485548]]
    .map(([x, y]) => (lightness + x * a + y * b) ** 3);
  return [[4.0767416621, -3.3077115913, 0.2309699292], [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.707614701]]
    .map(([x, y, z]) => Math.min(1, Math.max(0, x * l + y * m + z * s)))
    .map(linear => linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
}

const over = (top, bottom, alpha) => top.map((value, index) => alpha * value + (1 - alpha) * bottom[index]);
const luminance = rgb => rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (first, second) => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};
const distance = (first, second) => Math.hypot(...first.map((value, index) => (value - second[index]) * 255));

// Every palette block, keyed by theme. The default palette's block also
// carries the bare html and :host selectors.
const palettes = new Map([...css.matchAll(/((?:html|:host)[^{]*)\{([^}]*--hoshidicts-palette-color-scheme:[^}]*)\}/gu)]
  .map(([, selector, body]) => {
    const value = name => new RegExp(`--hoshidicts-palette-${name}:\\s*([^;]+);`, "u").exec(body)?.[1].trim();
    return [/data-hoshidicts-theme="([^"]+)"/u.exec(selector)[1],
      { scheme: value("color-scheme"), base100: channels(value("base-100")), base200: channels(value("base-200")) }];
  }));
const colours = Object.fromEntries(GROUPS.map(group => {
  const pair = new RegExp(`--hoshidicts-pitch-${group}: light-dark\\((#[\\da-f]{6}), (#[\\da-f]{6})\\);`, "u").exec(css);
  assert.ok(pair, `--hoshidicts-pitch-${group} is a light-dark() pair of hex colours`);
  return [group, { light: channels(pair[1]), dark: channels(pair[2]) }];
}));

test("every pitch accent colour keeps 3:1 on the cards, header and popup body of every palette", () => {
  const context = createContext({});
  runInContext(read("reader-options.js"), context);
  // Spread into this realm's arrays: the vm context has its own Array prototype.
  const registered = [...context.HDReaderOptions.POPUP_THEME_GROUPS.flatMap(group => group.themes.map(theme => theme.id))]
    .filter(id => id !== "auto");
  assert.deepEqual([...palettes.keys()].sort(), registered.sort(), "every registered palette is checked");
  const failures = [];
  for (const [theme, { scheme, base100, base200 }] of palettes) {
    // The opaque palette surfaces, then the default 85% background opacity
    // over a white or a black page: the popup body, where badges and later
    // headwords sit, and the header chrome over it, where the first one sits.
    const surfaces = { "base-100": base100, "base-200": base200 };
    for (const [page, rgb] of [["white", [1, 1, 1]], ["black", [0, 0, 0]]]) {
      const body = over(base100, rgb, 0.85);
      surfaces[`body over ${page}`] = body;
      surfaces[`header over ${page}`] = over(base200, body, 0.85);
    }
    for (const group of GROUPS) {
      for (const [surface, background] of Object.entries(surfaces)) {
        const ratio = contrast(colours[group][scheme], background);
        if (ratio < 3) failures.push(`${theme} ${group} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the five groups stay apart in each colour scheme, focus shows and forced colours are unchanged", () => {
  for (const scheme of ["light", "dark"]) {
    for (const [index, first] of GROUPS.entries()) {
      for (const second of GROUPS.slice(index + 1)) {
        assert.ok(distance(colours[first][scheme], colours[second][scheme]) >= 45, `${scheme} ${first} and ${second}`);
      }
    }
  }
  const focus = /:host\(\[data-hoshidicts-pitch-colors\]\) \.gsm-hoshidicts-expression\[data-pitch-category\] \.gsm-hoshidicts-kanji-link:focus-visible \{([^}]*)\}/u
    .exec(css)?.[1] ?? "";
  assert.match(focus, /outline: 2px solid currentColor;/u);
  // Forced colours do not repaint SVG strokes, so each group falls back to the
  // text colour a badge graph uses today.
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.gsm-hoshidicts-popup \[data-pitch-category\] \{\s*--hoshidicts-pitch-category: var\(--text-color\);\s*\}\s*\}/u);
});
