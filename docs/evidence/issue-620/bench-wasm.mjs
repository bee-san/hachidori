// hdw_lookup over 40,000 hovers of 吾輩は猫である with the five recommended
// dictionaries (bee-san/hachidori#620, not committed). The natively imported
// directories are copied into MEMFS and loaded as the engine service loads
// them. Usage: node bench-wasm.mjs <bundle dir> <imported dir> <windows> <label> <options json>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [bundleDir, importedDir, windowsPath, label, optionsJson] = process.argv.slice(2);
const { default: create } = await import(pathToFileURL(join(bundleDir, "hoshidicts-threaded.mjs")).href);
const M = await create();
const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
if (call("hdw_init_storage", "number", ["number"], [0]) !== 1) throw new Error("storage");
// [folder, kinds]: 0 term, 1 frequency.
const dictionaries = [
  ["Jitendex.org [2026-10-03]", [0]],
  ["JMnedict [2026-10-31]", [0]],
  ["Bee's Ultimate Kanji Dictionary", [0, 1]],
  ["Jiten", [1]],
  ["Bee's Ultimate Grammar Dictionary", [0]],
];
for (const [name, kinds] of dictionaries) {
  const target = `/dicts/${name}`;
  M.FS.mkdir(target);
  for (const file of readdirSync(join(importedDir, name))) {
    M.FS.writeFile(`${target}/${file}`, readFileSync(join(importedDir, name, file)));
  }
  for (const kind of kinds) {
    if (call("hdw_add_dict", "number", ["string", "number", "number", "number"], [target, kind, 0, 0]) !== 1) {
      throw new Error(call("hdw_last_error", "string", [], []));
    }
  }
}
call("hdw_set_dict_order", "number", ["string"], [JSON.stringify(dictionaries.map(([name]) => `/dicts/${name}`))]);
const windows = readFileSync(windowsPath, "utf8").split("\n").filter(Boolean);
for (let pass = 1; pass <= 2; pass += 1) {
  let bytes = 0;
  const start = performance.now();
  for (const text of windows) {
    bytes += call("hdw_lookup", "string", ["string", "number", "number", "string"], [text, 32, 16, optionsJson]).length;
  }
  console.log(`${label} pass ${pass}: ${(performance.now() - start).toFixed(1)} ms, ${bytes} reply characters`);
}
process.exit(0);
