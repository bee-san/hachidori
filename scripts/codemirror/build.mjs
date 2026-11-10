// SPDX-License-Identifier: GPL-3.0-or-later
// Builds extension/vendor/codemirror/codemirror.js, the code editor of
// Settings → Advanced → User scripts, from the CodeMirror releases that
// package-lock.json pins, and LICENSE beside it with the licence of every
// package in the bundle. The same lockfile and esbuild version give the same
// bytes, so `--check` rebuilds in memory and fails when the committed files
// differ (docs/source-build.md):
//
//   npm ci --prefix scripts/codemirror
//   node scripts/codemirror/build.mjs [--check]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "../../extension/vendor/codemirror");
const check = process.argv.includes("--check");

const result = await build({
  absWorkingDir: here,
  entryPoints: ["codemirror.mjs"],
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  legalComments: "none",
  metafile: true,
  write: false,
});

// The packages the bundle kept code from, by their directory in node_modules.
const [{ inputs }] = Object.values(result.metafile.outputs);
const packages = [...new Set(Object.entries(inputs)
  .filter(([, { bytesInOutput }]) => bytesInOutput > 0)
  .map(([input]) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\//u.exec(input)?.[1])
  .filter(Boolean))].sort();
const described = await Promise.all(packages.map(async name => {
  const directory = join(here, "node_modules", name);
  const { version, license } = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const text = await readFile(join(directory, "LICENSE"), "utf8")
    .catch(() => readFile(join(directory, "LICENSE.md"), "utf8"));
  return { name, version, license, text: text.trim() };
}));

const banner = `/* CodeMirror for Hachidori's User scripts editor, built by scripts/codemirror/build.mjs from ${
  described.map(({ name, version }) => `${name} ${version}`).join(", ")}. MIT licence: see LICENSE. */\n`;
const javascript = banner + result.outputFiles[0].text;

// One copy of each licence text, after the packages it covers.
const texts = new Map();
for (const item of described) texts.set(item.text, [...(texts.get(item.text) ?? []), item]);
const license = `The CodeMirror bundle in codemirror.js contains code from these packages, under these licences.\n\n${
  [...texts].map(([text, items]) => `${items.map(({ name, version, license: id }) => `${name} ${version} (${id})`).join("\n")}\n\n${text}\n`)
    .join("\n----\n\n")}`;

const files = { "codemirror.js": javascript, LICENSE: license };
if (check) {
  const stale = [];
  for (const [name, text] of Object.entries(files)) {
    const committed = await readFile(join(output, name), "utf8").catch(() => null);
    if (committed !== text) stale.push(relative(process.cwd(), join(output, name)));
  }
  if (stale.length > 0) {
    console.error(`Rebuild with node scripts/codemirror/build.mjs: ${stale.join(", ")} differ from the pinned build.`);
    process.exit(1);
  }
  console.log("extension/vendor/codemirror matches the pinned build.");
} else {
  await mkdir(output, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(output, name), text);
  console.log(`Wrote extension/vendor/codemirror (${Buffer.byteLength(javascript)} bytes of JavaScript).`);
}
