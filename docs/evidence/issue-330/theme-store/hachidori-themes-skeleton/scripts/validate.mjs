#!/usr/bin/env node
// hachidori-themes/scripts/validate.mjs — skeleton (issue #334).
// Every themes/<slug>/ folder must have a theme.yaml that matches the schema,
// a sanitised theme.css, a linted theme.js when `js:` is declared, and a
// 1120×840 screenshot when either is present. Dev-only dependencies:
// yaml, ajv + ajv-formats, pngjs, eslint. None of them enter Hachidori.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { PNG } from "pngjs";
import { ESLint } from "eslint";
import { sanitizeThemeCss } from "./sanitize-css.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const validate = addFormats(new Ajv2020({ allErrors: true, strict: true }))
  .compile(JSON.parse(readFileSync(resolve(ROOT, "schema/theme.schema.json"), "utf8")));
const MAX_CSS_BYTES = 256 * 1024;                // Hachidori's MAX_DICTIONARY_STYLE_BYTES
const MAX_JS_BYTES = 64 * 1024;
const SCREENSHOT = { width: 1120, height: 840 }; // 2× the 560×420 default popup
const eslint = new ESLint({ overrideConfigFile: resolve(ROOT, "scripts/theme-js.eslint.config.mjs") });
const problems = [];
const slugs = new Set();

for (const folder of readdirSync(resolve(ROOT, "themes"))) {
  const dir = resolve(ROOT, "themes", folder);
  if (!statSync(dir).isDirectory()) continue;
  const fail = message => problems.push(`${folder}: ${message}`);
  if (!existsSync(resolve(dir, "theme.yaml"))) { fail("theme.yaml is missing"); continue; }
  let theme;
  try { theme = parseYaml(readFileSync(resolve(dir, "theme.yaml"), "utf8"), { schema: "core" }); } // core: no !!js tags
  catch (error) { fail(`theme.yaml does not parse: ${error.message}`); continue; }
  if (!validate(theme)) { for (const e of validate.errors) fail(`${e.instancePath || "/"} ${e.message}`); continue; }
  if (theme.slug !== folder) fail(`slug "${theme.slug}" must equal the folder name`);
  if (slugs.has(theme.slug)) fail("duplicate slug");
  slugs.add(theme.slug);
  if (theme.extends && !existsSync(resolve(ROOT, "themes", theme.extends, "theme.yaml"))) fail(`extends unknown theme "${theme.extends}"`);

  if (theme.css) {
    if (!existsSync(resolve(dir, theme.css))) fail("theme.css is declared but missing");
    else {
      const css = readFileSync(resolve(dir, theme.css), "utf8");
      if (Buffer.byteLength(css) > MAX_CSS_BYTES) fail(`theme.css exceeds ${MAX_CSS_BYTES} bytes`);
      const { css: clean, dropped } = sanitizeThemeCss(css, theme.slug);
      for (const reason of dropped) fail(`theme.css rule rejected: ${reason}`);
      if (!clean.trim()) fail("theme.css has no rules left after sanitising");
    }
  }

  if (theme.js) {
    const path = resolve(dir, theme.js.file);
    if (!existsSync(path)) fail("theme.js is declared but missing");
    else {
      const source = readFileSync(path, "utf8");
      if (Buffer.byteLength(source) > MAX_JS_BYTES) fail(`theme.js exceeds ${MAX_JS_BYTES} bytes`);
      // Lint: module with one default export; no imports, no globals, no network, no timers.
      for (const result of await eslint.lintText(source, { filePath: path })) {
        for (const m of result.messages) fail(`theme.js ${m.line}:${m.column} ${m.ruleId ?? "parse"}: ${m.message}`);
      }
      // Contract: the module object names the slug and schema and only the declared hooks.
      const module = (await import(`${path}?v=${Date.now()}`)).default;
      if (module?.schema !== 1) fail("theme.js default export must have schema: 1");
      if (module?.slug !== theme.slug) fail("theme.js slug must equal theme.yaml slug");
      const hooks = Object.keys(module ?? {}).filter(key => typeof module[key] === "function");
      for (const hook of hooks) if (!theme.js.hooks.includes(hook)) fail(`theme.js defines ${hook} but theme.yaml does not declare it`);
      for (const hook of theme.js.hooks) if (!hooks.includes(hook)) fail(`theme.yaml declares ${hook} but theme.js does not define it`);
    }
  }

  if (theme.css || theme.js) {
    const shot = resolve(dir, theme.screenshot);
    if (!existsSync(shot)) { fail("screenshot.png is required when theme.css or theme.js is present"); continue; }
    const { width, height } = PNG.sync.read(readFileSync(shot));
    if (width !== SCREENSHOT.width || height !== SCREENSHOT.height) fail(`screenshot.png is ${width}×${height}, expected ${SCREENSHOT.width}×${SCREENSHOT.height}`);
  }
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`${slugs.size} themes valid`);
