// Validates every schema in ../schemas (Ajv 2020, strict) and every example in ../examples, plus negative cases.
// Usage (ESM resolves packages next to the script, so run it from a scratch folder):
//   mkdir -p /tmp/v && cp scripts/validate-examples.mjs /tmp/v/ && cd /tmp/v && npm init -y >/dev/null
//   npm i ajv@8.17.1 ajv-formats@3.0.1 yaml@2.8.1 && node validate-examples.mjs <path to docs/plans/issue-334>
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
const root = process.argv[2];
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const load = f => JSON.parse(readFileSync(`${root}/schemas/${f}`, "utf8"));
const v = {
  manifest: ajv.compile(load("theme-manifest.v2.schema.json")),
  model: ajv.compile(load("result-model.v1.schema.json")),
  storage: ajv.compile(load("themes-storage.v1.schema.json")),
  index: ajv.compile(load("theme-index.v1.schema.json")),
  bench: ajv.compile(load("theme-benchmark.v1.schema.json")),
};
let failed = 0;
const check = (name, fn, data) => { const ok = fn(data); console.log(ok ? "OK  " : "FAIL", name); if (!ok) { failed++; console.log(JSON.stringify(fn.errors, null, 1)); } };
for (const d of readdirSync(`${root}/examples/themes`)) check(`manifest ${d}`, v.manifest, parse(readFileSync(`${root}/examples/themes/${d}/theme.yaml`, "utf8"), { schema: "core" }));
for (const f of ["model-term.json", "model-kanji.json", "model-state.json"]) check(f, v.model, JSON.parse(readFileSync(`${root}/examples/${f}`, "utf8")));
check("themes-storage.json", v.storage, JSON.parse(readFileSync(`${root}/examples/themes-storage.json`, "utf8")));
check("index.json", v.index, JSON.parse(readFileSync(`${root}/examples/index.json`, "utf8")));
check("benchmark-nazeka-prototype.json", v.bench, JSON.parse(readFileSync(`${root}/examples/benchmark-nazeka-prototype.json`, "utf8")));
// negative cases the schema must reject
const nz = parse(readFileSync(`${root}/examples/themes/nazeka/theme.yaml`, "utf8"), { schema: "core" });
const neg = (name, fn, data) => { const ok = fn(data); console.log(!ok ? "OK  " : "FAIL", "rejects", name); if (ok) failed++; };
neg("js + renderer key", v.manifest, { ...nz, renderer: "default" });
neg("js without screenshot", v.manifest, (({ screenshot, ...r }) => r)(nz));
neg("css layered over Default (style kind is gone)", v.manifest, { ...nz, css: "theme.css" });
neg("schema 1", v.manifest, { ...nz, schema: 1 });
neg("unknown tag", v.manifest, { ...nz, tags: ["dark", "js"] });
neg("apiVersion 2", v.manifest, { ...nz, js: { ...nz.js, apiVersion: 2 } });
neg("benchmark block (schema-1 field)", v.manifest, { ...nz, benchmark: { onRenderP95Ms: 0.3 } });
neg("suggested option out of range", v.manifest, { ...nz, suggestedOptions: { popupColumns: 9 } });
neg("unknown suggested option", v.manifest, { ...nz, suggestedOptions: { lookupMode: "hover" } });
const idx = JSON.parse(readFileSync(`${root}/examples/index.json`, "utf8"));
neg("index path traversal", v.index, { ...idx, themes: [{ ...idx.themes[0], css: { ...idx.themes[0].css, path: "dist/../../x.css" } }] });
neg("index absolute url", v.index, { ...idx, themes: [{ ...idx.themes[0], css: { ...idx.themes[0].css, path: "https://evil.example/x.css" } }] });
neg("index renderer theme installable at runtime", v.index, { ...idx, themes: [{ ...idx.themes[1], installable: "runtime" }] });
neg("index style kind", v.index, { ...idx, themes: [{ ...idx.themes[0], kind: "style" }] });
const stor = JSON.parse(readFileSync(`${root}/examples/themes-storage.json`, "utf8"));
neg("stored palette value that could inject CSS", v.storage, { ...stor, installed: { x1: { ...stor.installed["sentence-context-dark"], palette: { ...stor.installed["sentence-context-dark"].palette, "base-100": "red; } * { background: url(//x)" } } } });
process.exit(failed ? 1 : 0);
