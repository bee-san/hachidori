import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const zip = "/tmp/335-dicts/jitendex-yomitan.zip";
const list = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(n => /^term_bank_\d+\.json$/.test(n));
const wanted = new Set(["食べる", "見る", "掛ける"]);
const rows = [];
for (const name of list) {
  const data = JSON.parse(execFileSync("unzip", ["-p", zip, name], { encoding: "utf8", maxBuffer: 1 << 28 }));
  for (const row of data) if (wanted.has(row[0])) rows.push(row);
}
writeFileSync("jitendex-rows.json", JSON.stringify(rows));
console.log(list.length, rows.length, rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[6], r[7]].join("|")).join("\n"));
