// SPDX-License-Identifier: GPL-3.0-or-later
// Issue #604: definition tags, and each card's dictionary tag, take Yomitan's
// tag colours, its light theme's in a light palette and its dark theme's in a
// dark one, each darkened only where its label would be below 4.5:1.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8");

// display.css at yomidevs/yomitan@d3c54c1: --tag-text-color and each
// --tag-*-background-color in its light (:root, L140-L152) and dark
// (:root[data-theme=dark], L208-L220) themes, with the data-category that
// paints it (L857-L886; "default" is every other category). Yomitan's
// "search" is for its own headword search tags, hidden by default
// (L2043-L2045), so it is not ported; a definition tag in that category is
// drawn as "default", Yomitan's colour for it too.
const YOMITAN_TEXT = ["#ffffff", "#f1f1f1"];
const YOMITAN_COLOURS = [
  ["default", null, "#8a8a91", "#69696e"],
  ["name", "name", "#b6327a", "#992a67"],
  ["expression", "expression", "#f0ad4e", "#b07f39"],
  ["popular", "popular", "#0275d8", "#025caa"],
  ["frequent", "frequent", "#5bc0de", "#4490a7"],
  ["archaism", "archaism", "#d9534f", "#b04340"],
  ["dictionary", "dictionary", "#aa66cc", "#9057ad"],
  ["frequency", "frequency", "#5cb85c", "#489148"],
  ["part-of-speech", "partOfSpeech", "#565656", "#565656"],
  ["pronunciation-dictionary", "pronunciation-dictionary", "#6640be", "#6640be"],
];
const SCHEMES = ["light", "dark"];

const channels = value => value.slice(1).match(/../gu).map(pair => Number.parseInt(pair, 16) / 255);
const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const luminance = value => channels(value).map(linear).reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (first, second) => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};
// OKLCH hue in degrees, through CSS Color 4's OKLab matrices.
function hue(value) {
  const [r, g, b] = channels(value).map(linear);
  const [l, m, s] = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005]].map(([x, y, z]) => Math.cbrt(x * r + y * g + z * b));
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bValue = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return (Math.atan2(bValue, a) * 180 / Math.PI + 360) % 360;
}

// [light, dark] from a light-dark() pair or one colour for both.
function declared(name) {
  const match = new RegExp(`${name}: (?:light-dark\\((#[\\da-f]{6}), (#[\\da-f]{6})\\)|(#[\\da-f]{6}));`, "u").exec(css);
  assert.ok(match, `${name} is a hex colour or a light-dark() pair of them`);
  return match[3] ? [match[3], match[3]] : [match[1], match[2]];
}

// Ours is Yomitan's colour when its label reaches the target there, and
// otherwise Yomitan's colour darkened, keeping its hue, only as far as the
// target needs.
function assertAdjusted(label, ours, yomitan, text, target) {
  const ratio = contrast(ours, text);
  assert.ok(ratio >= target, `${label} ${ours}: ${ratio.toFixed(3)} is below ${target}:1`);
  if (contrast(yomitan, text) >= target) {
    assert.equal(ours, yomitan, `${label} is Yomitan's colour`);
    return;
  }
  assert.ok(luminance(ours) < luminance(yomitan), `${label} is darker than Yomitan's`);
  assert.ok(ratio < target + 0.1, `${label} is darkened past ${target}:1: ${ratio.toFixed(3)}`);
  const shift = Math.abs(hue(ours) - hue(yomitan));
  assert.ok(Math.min(shift, 360 - shift) <= 1.5, `${label} keeps Yomitan's hue: ${shift.toFixed(2)}°`);
}

test("each of Yomitan's tag colours keeps 4.5:1 for its label, changed only where Yomitan's own does not reach it", () => {
  assert.deepEqual(declared("--tag-text-color"), YOMITAN_TEXT);
  for (const [token, , ...yomitan] of YOMITAN_COLOURS) {
    const ours = declared(`--tag-${token}-background-color`);
    SCHEMES.forEach((scheme, index) =>
      assertAdjusted(`${scheme} ${token}`, ours[index], yomitan[index], YOMITAN_TEXT[index], 4.5));
  }
});

test("the High contrast palette's tags reach 7:1 on Yomitan's dark colours under a white label", () => {
  const block = /^:host\(\[data-hoshidicts-theme="high-contrast"\]\) \.gsm-hoshidicts-popup \{([^}]*)\}/mu.exec(css)?.[1] ?? "";
  const value = name => new RegExp(`${name}: (#[\\da-f]{6});`, "u").exec(block)?.[1];
  assert.equal(value("--tag-text-color"), "#ffffff");
  for (const [token, , , yomitan] of YOMITAN_COLOURS) {
    assertAdjusted(`high-contrast ${token}`, value(`--tag-${token}-background-color`), yomitan, "#ffffff", 7);
  }
});

test("a definition tag paints its category's colour under Yomitan's label, and grammar pills keep their palette pairs", () => {
  const rule = selector => new RegExp(`^${selector.replace(/[.[\]]/gu, "\\$&")} \\{([^}]+)\\}`, "mu").exec(css)?.[1] ?? "";
  const tag = rule(".gsm-hoshidicts-tag-definition");
  for (const declaration of ["--tag-color: var(--tag-default-background-color);", "background: var(--tag-color);",
    "color: var(--tag-text-color);", "font-weight: bold;"]) {
    assert.ok(tag.includes(declaration), `.gsm-hoshidicts-tag-definition has ${declaration}`);
  }
  for (const [token, category] of YOMITAN_COLOURS.filter(([, category]) => category)) {
    assert.equal(rule(`.gsm-hoshidicts-tag-definition[data-category="${category}"]`).trim(),
      `--tag-color: var(--tag-${token}-background-color);`, category);
  }
  // The grammar row and kanji tags are not Yomitan's tags, and keep their
  // palette's colour and content pair.
  for (const [kind, role] of [["deinflection", "secondary"], ["term", "accent"]]) {
    assert.match(rule(`.gsm-hoshidicts-tag-${kind}`),
      new RegExp(`^\\s*background: var\\(--hoshidicts-palette-${role}\\);\\s*color: var\\(--hoshidicts-palette-${role}-content\\);\\s*$`, "u"));
  }
  // Forced colours replace the fill, so each tag keeps an outline.
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.gsm-hoshidicts-tag-definition \{\s*outline: 1px solid CanvasText;\s*outline-offset: -1px;\s*\}\s*\}/u);
});
