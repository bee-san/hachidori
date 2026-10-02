import { readFileSync } from "node:fs";
const css = readFileSync(process.argv[2], "utf8");
const toLinear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = c => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
function parse(value) {
  value = value.trim();
  let m = /^#([\da-f]{6})$/iu.exec(value);
  if (m) return m[1].match(/../gu).map(h => Number.parseInt(h, 16) / 255);
  m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/u.exec(value);
  const L = Number(m[1]) / 100, C = Number(m[2]), h = Number(m[3]) * Math.PI / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * s].map(c => Math.min(1, Math.max(0, toGamma(c))));
}
const lum = rgb => rgb.map(toLinear).reduce((t, c, i) => t + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
const over = (fg, bg, alpha) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);
const dist = (x, y) => Math.hypot(...x.map((c, i) => (c - y[i]) * 255));
const palettes = [...css.matchAll(/((?:html|:host)[^{]*)\{([^}]*--hoshidicts-palette-color-scheme:[^}]*)\}/gu)].map(([, selector, body]) => {
  const get = key => new RegExp(`--hoshidicts-palette-${key}:\\s*([^;]+);`, "u").exec(body)[1];
  const b100 = parse(get("base-100")), b200 = parse(get("base-200"));
  const surfaces = { "base-100": b100, "base-200": b200 };
  for (const [page, rgb] of [["white", [1, 1, 1]], ["black", [0, 0, 0]]]) {
    const body = over(b100, rgb, 0.85);
    surfaces[`body/${page}`] = body;
    surfaces[`header/${page}`] = over(b200, body, 0.85);
  }
  return { name: /data-hoshidicts-theme="([^"]+)"/u.exec(selector)[1], scheme: get("color-scheme").trim(), surfaces };
});
const sets = {
  shipped: { heiban: ["#096abd", "#59b2ff"], atamadaka: ["#bb3a3a", "#ff8686"], nakadaka: ["#a75113", "#ff9b54"],
    odaka: ["#007a16", "#67e47d"], kifuku: ["#7b51c0", "#bc99f6"] },
  issue: { heiban: ["#0a6ec6", "#59b2ff"], atamadaka: ["#c43d3d", "#ff6666"], nakadaka: ["#ae5414", "#ff9b54"],
    odaka: ["#008017", "#67e47d"], kifuku: ["#7e53c4", "#af85f4"] },
  jpmn: { heiban: ["#0a74d0", "#59b2ff"], atamadaka: ["#d74343", "#ff6666"], nakadaka: ["#e8701b", "#ff9b54"],
    odaka: ["#009e1c", "#67e47d"], kifuku: ["#7e53c4", "#af85f4"] },
};
for (const [label, set] of Object.entries(sets)) {
  console.log(`\n## ${label}`);
  console.log("| Group | Light | Worst light (palette, surface) | Light pairs < 3:1 | Dark | Worst dark (palette, surface) | Dark pairs < 3:1 |");
  console.log("|---|---|---|---:|---|---|---:|");
  for (const [group, [light, dark]] of Object.entries(set)) {
    const cells = [];
    for (const [scheme, hex] of [["light", light], ["dark", dark]]) {
      let worst = { ratio: Infinity }, fails = 0;
      for (const palette of palettes.filter(p => p.scheme === scheme)) {
        for (const [surface, bg] of Object.entries(palette.surfaces)) {
          const ratio = contrast(parse(hex), bg);
          if (ratio < 3) fails += 1;
          if (ratio < worst.ratio) worst = { ratio, palette: palette.name, surface };
        }
      }
      cells.push(`\`${hex}\``, `${worst.ratio.toFixed(2)} (${worst.palette}, ${worst.surface})`, String(fails));
    }
    console.log(`| ${group} | ${cells.join(" | ")} |`);
  }
  for (const [index, scheme] of [[0, "light"], [1, "dark"]]) {
    const values = Object.entries(set).map(([g, pair]) => [g, parse(pair[index])]);
    let min = Infinity, pair;
    for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
      const d = dist(values[i][1], values[j][1]);
      if (d < min) { min = d; pair = `${values[i][0]}/${values[j][0]}`; }
    }
    console.log(`${scheme} minimum RGB distance: ${min.toFixed(1)} (${pair})`);
  }
}
