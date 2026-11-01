import { writeFileSync } from "node:fs";
const m = await import(process.argv[2] + "/test/segmentation-reference.mjs");
const windows = [];
for (const { text } of m.REFERENCE_LINES) {
  const cps = Array.from(text);
  for (let i = 0; i < cps.length; i++) windows.push(cps.slice(i, i + 16).join(""));
}
writeFileSync(process.argv[3], windows.join("\n") + "\n");
console.log("windows", windows.length);
