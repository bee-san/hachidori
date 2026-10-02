// Scratch (not committed): a pitch-only archive for benchmark/hover-popup.mjs,
// so the hovered words carry pitch badges and a headword pitch category.
// Usage: node pitch-fixture.mjs <repo> <out.zip>
import { writeFileSync } from "node:fs";
const [repo, out] = process.argv.slice(2);
const { buildTitledZip } = await import(`${repo}/test/make-fixture.mjs`);
writeFileSync(out, buildTitledZip("hover-pitch-fixture", { banks: false, termMeta: [
  // 食べる v1 [2] (kifuku), plus an LHL pattern; 漢字 [0] (heiban); 深層 [0] and [1].
  ["食べる", "pitch", { reading: "たべる", pitches: [{ position: 2 }, { position: "LHL" }] }],
  ["漢字", "pitch", { reading: "かんじ", pitches: [{ position: 0 }] }],
  ["深層", "pitch", { reading: "しんそう", pitches: [{ position: 0 }, { position: 1 }] }],
] }));
