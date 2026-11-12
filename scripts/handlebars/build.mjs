// SPDX-License-Identifier: GPL-3.0-or-later
// npm ci --prefix scripts/handlebars && node scripts/handlebars/build.mjs [--check]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "../../extension/vendor/handlebars");
const { version } = JSON.parse(await readFile(join(here, "node_modules/handlebars/package.json"), "utf8"));
const files = { LICENSE: await readFile(join(here, "node_modules/handlebars/LICENSE"), "utf8") };
for (const [name, format] of [["parser", "esm"], ["compiler", "iife"]]) {
  const result = await build({ absWorkingDir: here, entryPoints: [`${name}.mjs`],
    bundle: true, format, minify: true, target: "es2022", legalComments: "none", write: false });
  files[`${name}.js`] = `/* Handlebars ${version} (${name}). MIT license: see LICENSE. Built by scripts/handlebars/build.mjs. */\n${result.outputFiles[0].text}`;
}
await mkdir(output, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  if (process.argv.includes("--check")) {
    if (await readFile(join(output, name), "utf8") !== content) throw new Error(`Rebuild ${name} with scripts/handlebars/build.mjs`);
  } else await writeFile(join(output, name), content);
}
console.log(`Handlebars ${version}: ${process.argv.includes("--check") ? "matches pinned build" : "built parser and sandbox compiler"}.`);
