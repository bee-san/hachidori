// Classify the branch splits that disagree with JmdictFurigana.
// node classify.mjs <out.disagree.tsv> [examples per class]
// Each row: rank, expression, reading, main split, branch split, reference ranges, verdict.
import { readFileSync } from "node:fs";

const [file, perClass = "15"] = process.argv.slice(2);
const KANA = /[\u3040-\u30ff]/u;
// The branch split as character ranges with readings, from "日(に)本(ほん)" text.
const parseSplit = (text) => {
  const ranges = [];
  let position = 0;
  for (const match of text.matchAll(/([^()]+?)\(([^()]*)\)|([^()])/gu)) {
    if (match[3] !== undefined) { position += Array.from(match[3]).length; continue; }
    const characters = Array.from(match[1]);
    // Leading kana before a ruby base belong to no ruby (the base is the non-kana tail).
    let start = 0;
    while (start < characters.length - 1 && KANA.test(characters[start])) start += 1;
    ranges.push({ start: position + start, end: position + characters.length - 1, reading: match[2] });
    position += characters.length;
  }
  return ranges;
};
const parseReference = (text) => text.split(";").filter(Boolean).map((part) => {
  const [span, reading] = part.split(":");
  const [start, end = start] = span.split("-").map(Number);
  return { start, end, reading };
});
const key = ({ start, end }) => `${start}-${end}`;
const classes = new Map();
for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
  const [rank, expression, reading, before, after, reference] = line.split("\t");
  const branch = parseSplit(after);
  const ref = parseReference(reference);
  const branchStarts = new Set(branch.flatMap(r => [r.start, r.end + 1]));
  const refStarts = new Set(ref.flatMap(r => [r.start, r.end + 1]));
  const finer = [...refStarts].every(s => branchStarts.has(s));
  const coarser = [...branchStarts].every(s => refStarts.has(s));
  const refByKey = new Map(ref.map(r => [key(r), r.reading]));
  const readingDiffers = branch.some(r => refByKey.has(key(r)) && refByKey.get(key(r)) !== r.reading);
  const kind = readingDiffers ? "reading differs" : finer && coarser ? "same bounds" : finer ? "finer than JmdictFurigana"
    : coarser ? "coarser than JmdictFurigana" : "crossing";
  if (!classes.has(kind)) classes.set(kind, []);
  classes.get(kind).push([rank, expression, reading, before, after, reference].join("  "));
}
for (const [kind, rows] of classes) {
  console.log(`== ${kind}: ${rows.length}`);
  for (const row of rows.slice(0, Number(perClass))) console.log(`  ${row}`);
}
