// WCAG 2.x contrast ratios for the denshi-jisho palette (issue #334 evidence).
//   node contrast.mjs
const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
const pairs = [
  ["LCD ink on backlit LCD (body text, headwords)", "#1a2414", "#cbdc9d"],
  ["muted ink on backlit LCD (dictionary names, hints, POS)", "#33402c", "#cbdc9d"],
  ["LCD colour on ink (inverted cursor line, title band, labels)", "#cbdc9d", "#1a2414"],
  ["ink on backlit LCD-deep (glyph box)", "#1a2414", "#bccf8a"],
  ["LCD ink on reflective LCD (backlight off)", "#1a2414", "#adb59a"],
  ["muted ink on reflective LCD (backlight off)", "#33402c", "#adb59a"],
  ["key label on light key cap (top of gradient)", "#1f2320", "#eceee9"],
  ["key label on light key cap (bottom of gradient)", "#1f2320", "#cfd2cb"],
  ["key sub-label on light key cap (bottom of gradient)", "#4a4f4b", "#cfd2cb"],
  ["決定 label on blue key (bottom of gradient)", "#f4f6f8", "#445872"],
  ["決定 sub-label on blue key (bottom of gradient)", "#d8e0ea", "#445872"],
  ["メニュー label on charcoal key (bottom of gradient)", "#f0f1ee", "#343735"],
  ["メニュー sub-label on charcoal key (bottom of gradient)", "#c9ccc7", "#343735"],
  ["model badge on bezel (decorative)", "#6f736c", "#d4d6d0"],
];
const rows = pairs.map(([what, fg, bg]) => ({ what, fg, bg, ratio: Math.round(ratio(fg, bg) * 100) / 100 }));
for (const row of rows) console.log(`${row.ratio.toFixed(2).padStart(6)}:1  ${row.fg} on ${row.bg}  ${row.what}`);
console.log(JSON.stringify(rows));
