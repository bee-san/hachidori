// SPDX-License-Identifier: GPL-3.0-or-later
//
// Three rules for the repository's JavaScript: an identifier nothing declares
// (no-undef), a binding nothing reads (no-unused-vars) and a name declared
// twice (no-redeclare). Each file gets the globals of the context it runs in.
// `npm --prefix test/tooling run lint` runs it from the repository root.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, globalIgnores, includeIgnoreFile } from "eslint/config";
import globals from "globals";

const root = path => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const manifest = JSON.parse(readFileSync(root("extension/manifest.json"), "utf8"));
const extension = files => files.map(file => `extension/${file}`);
const readonly = names => Object.fromEntries(names.map(name => [name, "readonly"]));
const chrome = readonly(["chrome"]);

// The namespace each classic script publishes on the global object for the
// scripts loaded after it.
const published = readonly([
  "HDAnki", "HDAudio", "HDContent", "HDDesignPreview", "HDDictionaryGroups", "HDExternalLinkHost", "HDExternalLinks",
  "HDGlossary", "HDLookupStats", "HDMessageTypes", "HDNetflix", "HDNetflixAudio", "HDNetflixSubtitles", "HDPopup",
  "HDReaderOptions", "HDReaderReady", "HDSentence", "HDThemeHost", "HDVisualNovel", "HDWordHighlights",
  "HDWordStatusOverrides",
]);

// Classic scripts sharing their world's global object: the manifest's content
// scripts, the three netflix.js registers beside them while Netflix mining is
// on, and the classic <script> files of extension pages.
const CLASSIC = [
  ...manifest.content_scripts.flatMap(({ js }) => js), "netflix-subtitles.js", "netflix-audio.js", "netflix-content.js",
  "design-preview.js", "settings-theme.js", "visual-novel.js",
];
// Classic scripts injected into a web page's own main world, without
// extension APIs.
const MAIN_WORLD = ["google-docs-flag.js", "netflix-page.js"];
// The service worker serializes this module's function into Netflix's page.
const NETFLIX_PREVIEW = "netflix-preview.js";
// The MV3 service worker module and the modules only it loads.
const SERVICE_WORKER = [
  manifest.background.service_worker, "anki-client-media.js", "anki-duplicates.js", "anki-enrichment.js",
  "anki-media.js", "anki-mining.js", "anki-worker.js", "api-host.js", "backup-downloads.js", "chrome-offscreen.js",
  "custom-javascript.js", "google-docs.js", "media-limits.js", "netflix.js", "sharing-client.js", "sharing-host.js",
  "background-anki.js", "background-backup.js", "background-core.js", "background-netflix.js",
  "background-requests.js", "background-sharing.js", "background-updates.js",
];
// Dedicated module workers and the modules only they load.
const WORKERS = [
  "anki-index-worker.js", "engine-worker.js", "engine-worker-idbfs.js", "engine-worker-local.js",
  "engine-worker-runtime.js", "import-worker.js", "opfs-capability-worker.js",
];

// Benchmark helpers copied into the extension: the probe is spliced into
// content.js before its closing start(), the seed starts as a classic worker.
const PROBE = "benchmark/hover-popup-probe.js";
const SEED = "benchmark/index-residency-seed.js";

export default defineConfig([
  includeIgnoreFile([root(".gitignore"), root("media/promo-video/.gitignore")], { gitignoreResolution: true }),
  globalIgnores(["extension/vendor/", "third_party/"]),
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-undef": "error",
      // Naming a key beside `...rest` is how the code leaves it out of a copy.
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
      "no-redeclare": "error",
    },
  },

  // Extension pages, and the modules several contexts share.
  {
    files: ["extension/**"],
    ignores: extension([...MAIN_WORLD, NETFLIX_PREVIEW, ...SERVICE_WORKER, ...WORKERS]),
    languageOptions: { globals: { ...globals.browser, ...chrome } },
  },
  { files: extension(CLASSIC), languageOptions: { sourceType: "script", globals: published } },
  { files: extension(MAIN_WORLD), languageOptions: { sourceType: "script", globals: globals.browser } },
  { files: extension([NETFLIX_PREVIEW]), languageOptions: { globals: globals.browser } },
  { files: extension(SERVICE_WORKER), languageOptions: { globals: { ...globals.serviceworker, ...chrome } } },
  { files: extension(WORKERS), languageOptions: { globals: globals.worker } },
  // Also runs in the engine workers, where the IDBFS mirror reads with
  // FileReaderSync once it has checked that it exists.
  { files: ["extension/engine-service.js"], languageOptions: { globals: readonly(["FileReaderSync"]) } },
  // The renderer also exports itself to the Node tests that require() it.
  { files: extension(["render/glossary.js", "render/popup.js"]), languageOptions: { globals: readonly(["module"]) } },

  // Node tests, benchmarks and scripts.
  {
    files: ["test/**", "benchmark/**", "scripts/**", ".github/**", "media/**"],
    ignores: [PROBE, SEED],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  { files: ["**/*.cjs", "benchmark/electron-host/**"], languageOptions: { sourceType: "commonjs", globals: globals.node } },
  // Puppeteer runs their evaluate() callbacks in extension pages, the service
  // worker and content-script worlds.
  {
    files: ["test/chrome-*.mjs", "test/chrome-e2e/*.mjs", "benchmark/*.mjs", "scripts/capture-store-assets.mjs", "media/**"],
    ignores: ["**/*.test.mjs"],
    languageOptions: { globals: { ...globals.browser, ...chrome, ...published } },
  },
  {
    files: [PROBE],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser, ...chrome, ...published,
        // content.js's own bindings around the splice point.
        ...readonly(["buildLevelUi", "hide", "levels", "options", "releaseFieldImposter", "resolveCandidate",
          "sendRequest", "shadow"]),
      },
    },
  },
  { files: [SEED], languageOptions: { sourceType: "script", globals: globals.worker } },
  // Page globals an earlier evaluate() callback defines for later ones.
  { files: ["test/chrome-dictionary-management-scenarios.mjs"], languageOptions: { globals: readonly(["reorderProbe"]) } },
  { files: ["test/chrome-glossary-layout.mjs"], languageOptions: { globals: readonly(["layoutView", "setLayout", "shadowQuery"]) } },
  { files: ["test/chrome-structured-table.mjs"], languageOptions: { globals: readonly(["tableAppearance"]) } },
]);
