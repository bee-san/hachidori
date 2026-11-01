#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copies the language packs of third_party/hoshidicts into
// extension/vendor/languages/<code>/ and writes the two classic scripts that
// set globalThis.HDLanguages (docs/languages.md 9.1):
//
//   registry.js         for extension pages, the service worker and the engine
//                       workers: identity, text, capabilities, presentation,
//                       settings, the speech and audio languages, the Anki
//                       note-type families, the warm-up sample and each
//                       pack's personal dictionary;
//   registry-reader.js  for content scripts, within 64 KB for every pack
//                       together: identity, text, capabilities, presentation,
//                       the warm-up sample and the pack settings with a
//                       display or capability effect. It leaves an
//                       HDLanguages that is already set.
//
// Both hold every class field and display-transform step with its class
// references expanded by hoshidicts' tools/lib/classes.mjs. The copy is
// committed with each submodule bump; test/language-packs.test.mjs fails when
// it differs from what the submodule gives.
//
//   node scripts/sync-languages.mjs          write extension/vendor/languages/
//   node scripts/sync-languages.mjs --check  exit 1 when the copy is stale
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOSHIDICTS = join(ROOT, "third_party/hoshidicts");
export const OUTPUT = join(ROOT, "extension/vendor/languages");
export const READER_BUDGET_BYTES = 64 * 1024;

// Japanese keeps today's personal package (docs/languages.md 15).
const JAPANESE_PERSONAL_DICTIONARY = { id: "e4c2e20a1a964b6cbd4ae3f87643c1f0", title: "Hachidori Custom Dictionary" };

export function personalDictionary(pack) {
  if (pack.code === "ja") return JAPANESE_PERSONAL_DICTIONARY;
  const id = createHash("sha256").update(`hachidori-custom-dictionary:${pack.code}`).digest("hex").slice(0, 32);
  return { id, title: `Hachidori Custom Dictionary (${pack.name})` };
}

// Pack directories: a language.json in a directory whose name does not start
// with `_` (engine contract, section 3), in code order.
export function packCodes(hoshidicts = HOSHIDICTS) {
  const languages = join(hoshidicts, "languages");
  if (!existsSync(languages)) return [];
  return readdirSync(languages).filter(name => !name.startsWith("_") && statSync(join(languages, name)).isDirectory()
    && existsSync(join(languages, name, "language.json"))).sort();
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

// The descriptor fields that hold one class, expanded.
function expandText(text, classes) {
  return {
    ...text,
    pattern: classes.source(text.pattern),
    wordCharacters: classes.source(text.wordCharacters),
    wordInternal: typeof text.wordInternal === "string" ? classes.source(text.wordInternal) : null,
  };
}

function expandCapabilities(capabilities, classes) {
  const characterView = capabilities.characterView;
  return {
    ...capabilities,
    characterView: characterView && typeof characterView.pattern === "string"
      ? { ...characterView, pattern: classes.source(characterView.pattern) } : characterView ?? null,
  };
}

function expandPresentation(presentation, classes) {
  const transforms = presentation?.displayTransforms ?? {};
  return {
    ...presentation,
    displayTransforms: Object.fromEntries(Object.entries(transforms).map(([name, steps]) => [name, classes.expandSteps(steps)])),
  };
}

// One pack as each script holds it.
export function registryEntries(pack, ClassSet) {
  const classes = new ClassSet(pack.classes ?? {});
  const identity = pick(pack, ["code", "iso639_3", "name", "nativeName", "bcp47", "scripts", "direction"]);
  const shared = {
    ...identity,
    text: expandText(pack.text, classes),
    capabilities: expandCapabilities(pack.capabilities, classes),
    presentation: expandPresentation(pack.presentation, classes),
  };
  const host = pack.host ?? {};
  const settings = Array.isArray(pack.settings) ? pack.settings : [];
  const registry = {
    ...shared,
    settings,
    host: {
      ttsLanguage: host.ttsLanguage,
      audioLanguage: host.audioLanguage,
      anki: { noteTypeFamilies: host.anki?.noteTypeFamilies ?? [] },
      sample: { warmup: host.sample?.warmup ?? null },
    },
    personalDictionary: personalDictionary(pack),
  };
  const reader = {
    ...shared,
    // Display effects, and capability effects: an optional capability such
    // as Korean's hanja character view decides what the popup links.
    settings: settings.filter(setting => setting?.effect?.display !== undefined || setting?.effect?.capability !== undefined)
      .map(setting => pick(setting, ["id", "type", "default", "effect"])),
    host: { sample: { warmup: host.sample?.warmup ?? null } },
  };
  return { registry, reader };
}

const HEADER = commit => `// Generated by scripts/sync-languages.mjs from third_party/hoshidicts/languages/ at ${commit}.
// Do not edit; run the script after bumping the submodule.
// SPDX-License-Identifier: GPL-3.0-or-later
`;

function registryScript(entries, commit, { keepExisting }) {
  const list = entries.length === 0 ? "[]" : `[\n${entries.map(entry => `    ${JSON.stringify(entry)},`).join("\n")}\n  ]`;
  const set = `  const packs = ${list};
  const byCode = new Map(packs.map(pack => [pack.code, pack]));
  // Read-only descriptors (docs/languages.md 9.1): get(code) is null for a
  // language this build has no pack for.
  globalThis.HDLanguages = {
    version: 1,
    codes: packs.map(pack => pack.code),
    get: code => byCode.get(code) ?? null,
  };`;
  const guarded = keepExisting
    ? `  // A page that already loaded registry.js keeps its fuller copy.\n  if (globalThis.HDLanguages !== undefined) return;\n${set}`
    : set;
  return `${HEADER(commit)}(function () {\n  "use strict";\n\n${guarded}\n}());\n`;
}

function submoduleCommit(hoshidicts) {
  try {
    return execFileSync("git", ["-C", hoshidicts, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

// Every file the copy consists of, by path relative to extension/vendor/languages/.
export async function languageFiles({ hoshidicts = HOSHIDICTS, commit = submoduleCommit(hoshidicts) } = {}) {
  const { ClassSet } = await import(pathToFileURL(join(hoshidicts, "tools/lib/classes.mjs")).href);
  const files = new Map();
  const registry = [];
  const reader = [];
  for (const code of packCodes(hoshidicts)) {
    const directory = join(hoshidicts, "languages", code);
    const languageText = readFileSync(join(directory, "language.json"), "utf8");
    const pack = JSON.parse(languageText);
    if (pack.code !== code) throw new Error(`languages/${code}/language.json names the code ${JSON.stringify(pack.code)}`);
    files.set(`${code}/language.json`, languageText);
    const transforms = pack.lookup?.transforms;
    if (typeof transforms === "string" && transforms !== "") {
      if (transforms.includes("/") || transforms.includes("\\")) throw new Error(`${code}: transforms must be a file of the pack`);
      files.set(`${code}/${transforms}`, readFileSync(join(directory, transforms), "utf8"));
    }
    let entries;
    try {
      entries = registryEntries(pack, ClassSet);
    } catch (error) {
      throw new Error(`languages/${code}: ${error.message}`, { cause: error });
    }
    registry.push(entries.registry);
    reader.push(entries.reader);
  }
  files.set("registry.js", registryScript(registry, commit, { keepExisting: false }));
  files.set("registry-reader.js", registryScript(reader, commit, { keepExisting: true }));
  return files;
}

// The files under extension/vendor/languages/ now, by the same paths.
export function committedLanguageFiles(output = OUTPUT) {
  const files = new Map();
  if (!existsSync(output)) return files;
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else files.set(`${prefix}${name}`, readFileSync(path, "utf8"));
    }
  };
  walk(output, "");
  return files;
}

async function main() {
  const check = process.argv.includes("--check");
  const expected = await languageFiles();
  const reader = Buffer.byteLength(expected.get("registry-reader.js"));
  if (reader > READER_BUDGET_BYTES) {
    throw new Error(`registry-reader.js is ${reader} bytes, over its ${READER_BUDGET_BYTES}-byte budget`);
  }
  const current = committedLanguageFiles();
  const stale = [...new Set([...expected.keys(), ...current.keys()])]
    .filter(path => expected.get(path) !== current.get(path)).sort();
  if (check) {
    if (stale.length > 0) {
      console.error(`extension/vendor/languages/ differs from the submodule: ${stale.join(", ")}`);
      console.error("Run node scripts/sync-languages.mjs and commit the result.");
      process.exitCode = 1;
    }
    return;
  }
  rmSync(OUTPUT, { recursive: true, force: true });
  for (const [path, text] of expected) {
    mkdirSync(dirname(join(OUTPUT, path)), { recursive: true });
    writeFileSync(join(OUTPUT, path), text);
  }
  console.log(`${expected.size} files, ${stale.length} changed; registry-reader.js ${reader} bytes`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
