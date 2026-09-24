// Contrast ratios (WCAG 2.x relative luminance) for the retro-terminal palette,
// plain and through the darkest CRT scanline band (rgba(0,0,0,ALPHA) composited
// over both text and background). Evidence for issue #334.
const ALPHA = Number(process.env.RT_SCANLINE_ALPHA ?? 0.14);
const hex = value => value.replace("#", "").match(/../g).map(part => parseInt(part, 16) / 255);
const channel = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (fg, bg) => {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
};
const band = rgb => rgb.map(c => c * (1 - ALPHA)); // black at ALPHA over the colour
const round = n => Math.round(n * 100) / 100;

const palette = {
  bg: "#0b0a06", fg: "#ffb000", bright: "#ffd166", dim: "#d09a1e", line: "#5c4409", error: "#ff9f1c",
  soft: "#241c08",
};
const pairs = [
  ["fg on bg (glosses, list rows)", palette.fg, palette.bg],
  ["bright on bg (headword, kanji glyph)", palette.bright, palette.bg],
  ["dim on bg (readings, rules, key hints, tags)", palette.dim, palette.bg],
  ["error on bg (audio/anki error state)", palette.error, palette.bg],
  ["bg on fg (inverse video: selected row, status line)", palette.bg, palette.fg],
  ["dim on soft (hovered row)", palette.dim, palette.soft],
  ["fg on soft (hovered row)", palette.fg, palette.soft],
  ["line on bg (decorative rules only, not text)", palette.line, palette.bg],
];
const rows = pairs.map(([label, f, b]) => ({
  pair: label, fg: f, bg: b,
  plain: round(ratio(hex(f), hex(b))),
  [`through scanline band (alpha ${ALPHA})`]: round(ratio(band(hex(f)), band(hex(b)))),
}));
console.table(rows);
console.log(JSON.stringify({ alpha: ALPHA, palette, rows }, null, 2));
