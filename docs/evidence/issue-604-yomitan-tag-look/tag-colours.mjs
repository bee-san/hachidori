// Scratch: Yomitan's tag colours (display.css at d3c54c1), each darkened in
// OKLCH lightness only as far as 4.5:1 against Yomitan's tag text needs.
const LIGHT = {
  default: "#8a8a91", name: "#b6327a", expression: "#f0ad4e", popular: "#0275d8", frequent: "#5bc0de",
  archaism: "#d9534f", dictionary: "#aa66cc", frequency: "#5cb85c", partOfSpeech: "#565656",
  search: "#8a8a91", "pronunciation-dictionary": "#6640be",
};
const DARK = {
  default: "#69696e", name: "#992a67", expression: "#b07f39", popular: "#025caa", frequent: "#4490a7",
  archaism: "#b04340", dictionary: "#9057ad", frequency: "#489148", partOfSpeech: "#565656",
  search: "#69696e", "pronunciation-dictionary": "#6640be",
};
const TEXT = { light: "#ffffff", dark: "#f1f1f1" };

const hex = value => value.slice(1).match(/../gu).map(pair => Number.parseInt(pair, 16) / 255);
const toHex = rgb => `#${rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const lin = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const gam = v => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
const luminance = rgb => rgb.map(lin).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function toOklch(rgb) {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}
function fromOklch([L, C, H]) {
  const [A, B] = [C * Math.cos(H), C * Math.sin(H)];
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  const lr = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return lr;
}
function inGamut(linear) { return linear.every(v => v >= -1e-6 && v <= 1 + 1e-6); }
function darken(value, text) {
  const rgb = hex(value);
  if (contrast(rgb, hex(text)) >= 4.5) return { hex: value, ratio: contrast(rgb, hex(text)), change: 0 };
  const [L0, C0, H] = toOklch(rgb);
  for (let L = L0; L > 0; L -= 0.0005) {
    let C = C0;
    let linear = fromOklch([L, C, H]);
    while (!inGamut(linear) && C > 0) { C -= 0.0005; linear = fromOklch([L, C, H]); }
    const candidate = toHex(linear.map(v => gam(Math.min(1, Math.max(0, v)))));
    const ratio = contrast(hex(candidate), hex(text));
    if (ratio >= 4.5) return { hex: candidate, ratio, change: (L0 - L) / L0, lightness: L, chroma: C };
  }
  throw new Error(value);
}
for (const [scheme, set] of [["light", LIGHT], ["dark", DARK]]) {
  console.log(`== ${scheme} (text ${TEXT[scheme]})`);
  const result = {};
  for (const [category, value] of Object.entries(set)) {
    const original = contrast(hex(value), hex(TEXT[scheme]));
    const adjusted = darken(value, TEXT[scheme]);
    result[category] = adjusted.hex;
    console.log(category.padEnd(26), value, original.toFixed(2).padStart(5), "->", adjusted.hex, adjusted.ratio.toFixed(2),
      adjusted.change ? `L -${(adjusted.change * 100).toFixed(1)}%` : "unchanged");
  }
  const entries = Object.entries(result);
  const distances = [];
  for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) {
    const d = Math.hypot(...hex(entries[i][1]).map((v, k) => (v - hex(entries[j][1])[k]) * 255));
    distances.push([d, entries[i][0], entries[j][0]]);
  }
  distances.sort((a, b) => a[0] - b[0]);
  console.log("closest pairs:", distances.slice(0, 6).map(([d, a, b]) => `${a}/${b} ${d.toFixed(1)}`).join(", "));
}
