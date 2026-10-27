// Contrast of each definition-tag category's label on its fill, on main
// (palette colour/content pairs, archaism tinted) and on this branch
// (Yomitan's colours, light-dark()). node contrast-table.mjs <mainCss> <branchCss>
import { readFileSync } from "node:fs";

const [mainPath, branchPath] = process.argv.slice(2);
const mainCss = readFileSync(mainPath, "utf8");
const branchCss = readFileSync(branchPath, "utf8");

function channels(value) {
  const hex = /^#([\da-f]{6})$/iu.exec(value);
  if (hex) return hex[1].match(/../gu).map(pair => Number.parseInt(pair, 16) / 255);
  const oklch = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/u.exec(value);
  if (!oklch) throw new Error(value);
  const [lightness, chroma, hue] = [Number(oklch[1]) / 100, Number(oklch[2]), Number(oklch[3]) * Math.PI / 180];
  const [a, b] = [chroma * Math.cos(hue), chroma * Math.sin(hue)];
  const [l, m, s] = [[0.3963377774, 0.2158037573], [-0.1055613458, -0.0638541728], [-0.0894841775, -1.291485548]]
    .map(([x, y]) => (lightness + x * a + y * b) ** 3);
  return [[4.0767416621, -3.3077115913, 0.2309699292], [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.707614701]]
    .map(([x, y, z]) => Math.min(1, Math.max(0, x * l + y * m + z * s)))
    .map(linear => linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
}
const luminance = rgb => rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (first, second) => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};
const mix = (top, bottom, alpha) => top.map((value, index) => alpha * value + (1 - alpha) * bottom[index]);

const palettes = [...mainCss.matchAll(/((?:html|:host)[^{]*)\{([^}]*--hoshidicts-palette-color-scheme:[^}]*)\}/gu)]
  .map(([, selector, body]) => {
    const value = name => new RegExp(`--hoshidicts-palette-${name}:\\s*([^;]+);`, "u").exec(body)?.[1].trim();
    const theme = /data-hoshidicts-theme="([^"]+)"/u.exec(selector)[1];
    const get = name => channels(value(name));
    return { theme, scheme: value("color-scheme"), get };
  });

const MAIN_PAIRS = {
  default: ["neutral", "neutral-content"], expression: ["secondary", "secondary-content"],
  partOfSpeech: ["accent", "accent-content"], popular: ["primary", "primary-content"],
  frequent: ["info", "info-content"], dictionary: ["neutral", "neutral-content"], name: ["neutral", "neutral-content"],
};
const categories = ["default", "name", "expression", "popular", "frequent", "archaism", "dictionary", "partOfSpeech"];
const token = { partOfSpeech: "part-of-speech" };
const declared = (css, name) => {
  const match = new RegExp(`${name}: (?:light-dark\\((#[\\da-f]{6}), (#[\\da-f]{6})\\)|(#[\\da-f]{6}));`, "u").exec(css);
  return match[3] ? [match[3], match[3]] : [match[1], match[2]];
};
const high = name => new RegExp(`${name}: (#[\\da-f]{6});`, "u")
  .exec(/^:host\(\[data-hoshidicts-theme="high-contrast"\]\) \.gsm-hoshidicts-popup \{([^}]*)\}/mu.exec(branchCss)[1])[1];
const text = declared(branchCss, "--tag-text-color");

console.log("| Category | main: lowest of 42 palettes (palettes below 4.5:1) | this PR: light / dark / High contrast |");
console.log("|---|---|---|");
for (const category of categories) {
  const ratios = palettes.map(({ theme, get }) => {
    if (category === "archaism") {
      const background = mix(get("error"), get("base-100"), 0.12);
      return [theme, contrast(get("base-content"), background)];
    }
    const [fill, label] = MAIN_PAIRS[category];
    return [theme, contrast(get(label), get(fill))];
  });
  const low = ratios.filter(([, ratio]) => ratio < 4.5);
  const minimum = Math.min(...ratios.map(([, ratio]) => ratio));
  const name = `--tag-${token[category] ?? category}-background-color`;
  const [light, dark] = declared(branchCss, name);
  const ours = [contrast(channels(light), channels(text[0])), contrast(channels(dark), channels(text[1])),
    contrast(channels(high(name)), channels("#ffffff"))];
  console.log(`| \`${category}\` | ${minimum.toFixed(2)} (${low.length}${low.length ? `: ${low.map(([theme, ratio]) => `${theme} ${ratio.toFixed(2)}`).join(", ")}` : ""}) | ${ours.map(ratio => ratio.toFixed(2)).join(" / ")} |`);
}
