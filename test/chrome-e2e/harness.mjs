/*
 * The real-Chrome suite's checks on node:test.
 *
 * Every assertion has a fixed name, declared up front in PLANNED: the denominator
 * is that list, not the number of checks that happened to run. Each step of the
 * scenario is one node:test test that fails once any of its checks has failed,
 * and a step that throws fails alone while the run goes on. When a name pattern
 * leaves out the earlier steps a selected step depends on, it runs them first.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION_ROW_CHECK } from "../chrome-action-row.mjs";
import { AUDIO_CHOOSER_CHECK } from "../chrome-audio-chooser.mjs";
import { BACKUP_CHROME_CHECKS } from "../chrome-backup-scenarios.mjs";
import { REORDER_CHECKS } from "../chrome-dictionary-management-scenarios.mjs";
import { DICTIONARY_RANK_CHECK } from "../chrome-dictionary-rank-scenarios.mjs";
import { DYNAMIC_HEADWORD_CHECK } from "../chrome-dynamic-headword.mjs";
import { COMPACT_GLOSSARIES_CHECK } from "../chrome-glossary-layout.mjs";
import {
  LIBRARY_NAVIGATION_CHECK,
  LIBRARY_TAB_GEOMETRY_CHECK,
  SETTINGS_NAVIGATION_CHECK,
} from "../chrome-library-navigation.mjs";
import { LOOKUP_COUNT_LAYOUT_CHECK } from "../chrome-lookup-count-layout.mjs";
import { SETTINGS_FEEDBACK_CHECK } from "../chrome-settings-feedback-scenarios.mjs";
import { SETTINGS_FIRST_FRAME_THEME_CHECK } from "../chrome-settings-first-frame.mjs";
import { STRUCTURED_TABLE_CHECK } from "../chrome-structured-table.mjs";

let current = null;
let completeSuite = false;
const steps = [];

// Called by check(): a failed check fails the step that made it.
function attribute(name) {
  current?.failures.push(name);
}

// A run that leaves steps out (one file on its own, or a name pattern) can account only
// for the checks that ran; test/chrome-e2e.mjs without a pattern accounts for all of them.
const NAME_FILTERED = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/u)]
  .some((argument) => /^--test-(?:name-pattern|skip-pattern|only)\b/u.test(argument));

function markCompleteSuite() {
  completeSuite = true;
}

function completeRun() {
  return completeSuite && !NAME_FILTERED;
}

// One step of the scenario. Steps share one browser and run in order; when a name
// pattern leaves out earlier steps, the selected step runs them first.
function step(name, fn) {
  const entry = { name, fn, ran: false };
  steps.push(entry);
  return nodeTest(name, async (context) => {
    const record = { failures: [] };
    current = record;
    console.log(`\n=== ${context.fullName}`);
    try {
      for (const earlier of steps.slice(0, steps.indexOf(entry))) {
        if (earlier.ran) continue;
        earlier.ran = true;
        console.log(`\n=== ${context.fullName}: first the earlier step "${earlier.name}"`);
        try {
          await earlier.fn();
        } catch (error) {
          const name = `${context.fullName}: the earlier step "${earlier.name}" finished without throwing`;
          results.push({ name, ok: false, detail: error?.stack || String(error) });
          failed++;
          record.failures.push(name);
          console.log(`FAIL ${name}\n       ${error?.stack || error}`);
        }
      }
      entry.ran = true;
      await fn();
    } catch (error) {
      results.push({ name: `${context.fullName} finished without throwing`, ok: false, detail: error?.stack || String(error) });
      failed++;
      console.log(`FAIL ${context.fullName} finished without throwing\n       ${error?.stack || error}`);
      throw error;
    } finally {
      current = null;
    }
    if (record.failures.length) throw new Error(`failed: ${record.failures.join("; ")}`);
  });
}

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(HERE, "..");
const EXTENSION = resolve(REPO, "extension");
// Per-pid by default. Two runs sharing one profile fight over the extension's
// leveldb: the second Chrome cannot open chrome.storage.local at all
// ("IO error: .../LOCK ... LockFile"), which showed up here as a pass-2 failure
// that looked like an IDBFS regression. Kept after a failing run so the profile
// can be inspected, removed after a green one.
const PROFILE = process.env.HACHIDORI_PROFILE || `/tmp/hachidori-e2e-profile-${process.pid}`;

// The name the content script registers its Custom Highlight under, read out of
// the source instead of copied: a copy would keep passing after a rename, which
// is exactly the regression the highlight assertions exist to catch.
const HIGHLIGHT_NAME = (readFileSync(resolve(EXTENSION, "content.js"), "utf8")
  .match(/HIGHLIGHT_NAME\s*=\s*"([^"]+)"/) || [])[1];

// Word highlighting (#520): the real content script segments a page through
// the engine and paints each word's Anki status with the Highlight API.
const WORD_HIGHLIGHT_CHECKS = [
  "word highlights mark visible words by Anki status, and text scrolled to or added later, without changing the page's DOM",
  "adding a word to Anki from the popup moves its marks from unknown to learning",
  "Ignore and Mark as known in the popup, and the Mark as known keybind, set a word's status over Anki's, re-mark the page and clear again",
  "turning word highlighting off removes every mark and keeps its settings",
];

const PLANNED = [
  DICTIONARY_RANK_CHECK,
  "dictionary pointer reorder and confirmed bulk removal persist across reload",
  ...REORDER_CHECKS,
  ...BACKUP_CHROME_CHECKS,
  "extension loads and its service worker starts",
  "offscreen document compiles the wasm under the extension CSP",
  "extension pages expose pthread prerequisites",
  "chrome.offscreen.createDocument produced exactly one offscreen document",
  "manifest and settings page are branded as Hachidori",
  "a fresh profile shares by default and waits for dictionaries before it takes the host slot",
  "Chrome registers Hachidori's browser shortcuts and Keybinds lists them",
  "a fresh install uses AUTO in startup and Settings before Start setup and waits for work",
  "Start setup begins automatic dictionary installation with first-install preferences",
  "Settings shows Resume setup while first-run setup is incomplete",
  "a reconnecting startup page rejoins the running installer whose held download stays indeterminate",
  "the automatic installer continues after a mocked failure through real download and installation phases",
  "Retry installs only the missing dictionary and the committed entries settle their selections once",
  "the all-installed result advances immediately before setup checks for Anki",
  "startup practice immediately demonstrates the installed dictionaries and retains keyboard and hover lookup",
  "startup screenshot capture resolves its own live extension document",
  "startup practice waits for reader storage before its automatic lookup",
  "the startup reader exception keeps Settings and the static preview excluded",
  "saved-page setup rechecks Chrome file access and a local HTML file uses the real reader",
  "startup practice without a usable dictionary retains recovery and completion controls",
  "the practice visual novel scene fits narrow screens and looks a word up through the real reader and installed dictionaries",
  "the reader refuses to run on Settings even when its own scripts are loaded there",
  "Remove all imported dictionaries clears disabled and search-hidden packages through the real engine after one confirmation",
  "an absent Anki settles by itself and the startup page finishes setup, closes its tab and hides Resume setup",
  "first-run detection configures an existing Kiku mining setup read-only from the startup page",
  "first-run setup automatically prepends detected local audio as source 1",
  "Settings recovers Anki setup after onboarding and preserves a verified saved mapping",
  "a browser restart keeps completed setup closed and the edited first-install preference",
  "Settings puts the library first and supports keyboard navigation at 320px",
  "the Google Docs flag registers its document_start MAIN-world script only while on",
  LIBRARY_NAVIGATION_CHECK,
  LIBRARY_TAB_GEOMETRY_CHECK,
  SETTINGS_NAVIGATION_CHECK,
  "Settings follows every popup theme and keeps each task view readable without horizontal overflow",
  "Design names pitch dictionaries at 4.5:1 text contrast in every popup theme",
  SETTINGS_FIRST_FRAME_THEME_CHECK,
  "Settings autosaves one revisioned patch and surfaces cross-page conflicts without losing drafts",
  SETTINGS_FEEDBACK_CHECK,
  "Settings rejects malformed and oversized option frames before commit and still autosaves without reload",
  "Design lazily renders local sample terms, kanji and images over a visual novel scene through the production popup",
  "Design live edits preserve popup cards and Notes while sample appends cannot mutate dictionaries",
  "Design fits the popup without changing its actual dimensions and keeps narrow Settings scrollable",
  "Design exposes AUTO plus 42 grouped palettes and applies live browser preference changes",
  "Design previews opacity and dimensions immediately and resets only Design settings",
  "live appearance changes preserve reader Notes and resources while applying the selected page highlight",
  "toolbar preferences persist and move the preview without detaching focused Notes or rebuilding cards",
  "low-opacity popup content scrolls in a clipped viewport without overlapping either toolbar position",
  "live toolbar overrides apply to root and child and survive resize without focus or resource loss",
  "custom CSS editor previews unsaved text, persists its count and resets only its stylesheet",
  "custom CSS overrides built-in and late dictionary styles only inside the popup shadow tree and tolerates invalid CSS",
  "live custom CSS updates root and child without losing Notes, Back or making engine requests",
  "Audio Settings preserve ordered source edits and disabled rows through revisioned save and reload",
  "Audio source Tests use encoded URLs and ordered JSON candidates with quiet success and visible errors",
  "Audio Tests cancel stale playback and preserve the dictionary engine after audio becomes idle",
  "Anki discovery is lazy and refresh recovers an offline connection through the real service worker",
  "Anki Settings reject stale model replies and preserve unavailable mappings without discovery writes",
  "Anki configuration persists through reload without reloading the dictionary engine",
  "Anki field mappings expose accessible editable combobox behavior without replacing free-form text",
  "Anki presets expose editable field templates and persist overwrite modes with visible marker errors",
  "Anki templates survive refresh and reload while disabled values stay disabled and lookup generation stays unchanged",
  "Anki glossary export preserves native scoped styles and image proportions without loading media or allowing CSS markup escape",
  "Smaller Anki cards export resolves scoped CSS into compact glossary HTML without styles, internal markup or media loads",
  "Anki worker preflight is read-only and submission verifies a real-WASM result with scoped dictionary media",
  "Smaller Anki cards mines compact glossary HTML through the real offscreen path and uploads only the images it keeps",
  "Anki stable single-glossary aliases and package IDs render through the real offscreen path without rewriting mappings",
  "Anki pitch dictionary variants export as self-contained SVG graphs in light, dark and styled cards",
  "Anki first-field audio is checked without uploads or playback and the exact chosen recording survives submission",
  "Anki {audio} in a non-first field uploads the selected pronunciation after the note is added",
  "Anki readiness uses a disabled accessible Arrow Clockwise before Add and View resolve",
  "Anki reader controls stay absent until configured and keep ruby context without its reading through one confirmed Add and View",
  "a mined screenshot is the reading page without Hachidori's overlays and its upload cannot fail the note",
  "Anki screenshot mining works after history.pushState and history.replaceState change the reading page URL",
  "a mined screenshot of a page with a paused MSE video contains that video's frame instead of a black region",
  "a screenshot upload that Anki refuses is a warning on a note that is still added",
  "a note mined from a texthooker line carries that one line as its sentence and its full page address, and highlights only the word",
  "a note mined from a selection takes the hover's sentence without the hidden text inside it",
  "Popup audio is silent by default and manually falls back through enabled sources and playable candidates",
  "Popup pronunciation choices open beside Audio from a right-click and Down, preserve source identity and warm replay reuses native cached media",
  "Popup autoplay is optional and does not replay after presentation updates or Back",
  "Popup audio cancels obsolete discovery and playback on dismissal, source changes and navigation",
  "accepted reader lookups persist canonical counts without delaying definitions",
  "live lookup-count Settings pause recording and preserve the displayed reader view",
  "local count and blur settings belong to Reading without external corpus controls",
  "Reset lookup counts refreshes the open popup to zero without recording and the next lookup counts 1",
  "definition blur follows real lookup counts and settings and holds autoplay until blurred results are revealed",
  "frequency blur uses native fixture values without recording counts or waiting for another signal",
  "blurred definitions reveal on hover, at the timed deadline and at once when blur is disabled",
  "the Anki maturity blur condition persists independently of lookup counts",
  "a cold Anki duplicate index leaves the popup responsive while its first refresh is held",
  "cached mature definitions hold pronunciation until revealed and repeated lookups make no Anki requests",
  "a scheduled index refresh preserves the current popup and updates only new lookups",
  "the duplicate index keeps refreshing while maturity blur is disabled and re-enabling uses it without Anki",
  "an unavailable Anki refresh retains cached maturity and independent count blur",
  "worker restart restores indexed maturity and the missing thirty-minute alarm without fetching",
  ...WORD_HIGHLIGHT_CHECKS,
  "lookup counts survive a full browser restart",
  "reader settings and their revision survive a full browser restart",
  "hover enablement closes active popups and changes already-open tabs without reloading the engine",
  "configured activation keys open stationary lookups and release them using the saved delays",
  "No key looks up on hover and keeps the remembered key, which returns with the popup staying open",
  "a hover scan delay keeps a quick pass across a word from looking anything up and looks up the word the pointer rests on once",
  "hide popup on cursor exit hides a sticky popup the pointer left despite mouse focus, but not keyboard focus",
  "Press to set records the middle button, which opens a stationary lookup and releases it like a key",
  "a middle scan press on a Japanese link looks it up without a new tab while other links still open",
  "a Back scan press on a word, in page text or a text field, looks it up without going back, while one on an empty field still does",
  "Settings persists frequency directions and applies them to real-WASM lookup results",
  "Japanese-only selections leave English text alone and the notice setting propagates to open readers",
  "turning off the personal dictionary stops highlight lookups, the pencil and personal entries until it is on",
  "plain selections cannot lookup, highlight or open personal definitions when Shift is required",
  "ordinary selections follow hover and both activation modes for all four modifiers",
  "matching activation preserves exact selections, cross-inline highlights and personal definitions",
  "source highlights reconcile selected text mutations without changing selection",
  "hover popups stay open while a drag selects text, prefill the highlight and close on a plain click",
  "nested source highlights retain ancestor ownership when children close in native and fallback modes",
  "plain definition text opens nested child lookups with native hover, activation, miss and depth behavior",
  "definition text can wait for the activation key or a click in Hover mode",
  "fallback source paint stays exact through clipping, scrolling, visibility and cleanup",
  "fallback source paint tracks CSS transitions and animated ancestors",
  "fallback source paint follows sibling layout changes inside fixed-size ancestors",
  "fallback source paint stays beneath page headers and overlays",
  "fallback source paint refreshes after stylesheet loading and CSSOM edits",
  "text fields look up their words without disturbing editing, while other editors suppress pointer and selection lookups",
  "autofocused search fields allow hover and stationary Shift lookup of their own words and Japanese example links",
  "Japanese-only preferences change automatic scanning in an already-open tab",
  "Japanese-only mixed numeral lookups retain native matches and exact source highlights",
  "dictionary CSS stays scoped with malformed braces, escaped titles, and nested rules",
  "dictionary CSS keeps its own custom properties, so grammar card disclosures draw their chevron",
  "dictionary CSS cannot load remote resources or inherit resource-valued variables",
  "dictionary CSS cannot paint or intercept input outside its glossary card",
  "settings page renders exactly five safe recommended dictionary links",
  "recommended dictionaries form a readable list on desktop",
  "recommended dictionaries stack without overflow on narrow screens",
  "a clean profile shows one recommended install action beside local import",
  "the recommended installer continues after a mocked download failure",
  "a Settings-started recommended batch survives reloading its page without duplicate downloads",
  "missing recommended dictionaries stay available after a settings reload",
  "recommended retry downloads only the missing trusted dictionary",
  "settings page exposes a .zip file input",
  "the .zip file input accepts multiple .zip files",
  "importing a Yomitan .zip from the settings page succeeds",
  "the imported dictionary is persisted in OPFS",
  "the imported dictionary is recorded in chrome.storage.local",
  "matching local imports show an accessible named revision decision before engine mutation",
  "Escape and explicit Cancel leave the package untouched and continue a multi-file batch",
  "keyboard Replace preserves package identity and excludes dialog dwell from import timing",
  "metadata mismatch and corrupt replacement leave no OPFS generation roots",
  "same, lower, missing, malformed, and nonnumeric revisions are described without automatic replacement",
  "Add separately persists a collision-safe title that native lookup reports",
  "separate copies survive a browser restart, stay retained by automatic backups, and retire after release",
  "the import batch continues after failure and retains every archive outcome",
  "batch re-import preserves presentation, source, and order while clearing stale check state",
  "the dictionary list renders its alias, metadata, and five capability badges",
  "the dictionary position input stays compact on a narrow Settings page",
  "the Settings enabled control re-enables the preserved package",
  "Check now checks every managed dictionary including disabled packages without downloading",
  "a row check fetches only its managed index and reports availability without installing",
  "a row Update installs only the checked package",
  "managed update controls render persisted availability and last-checked state",
  "lookups stay available while a managed archive download is held",
  "Update all atomically replaces a managed generation and preserves presentation",
  "one aggregate browser alarm follows the next dictionary due time",
  "per-dictionary schedules persist without engine reload and override global Off",
  "Settings schedule drafts preserve newer commits and retry lost replies without duplicate writes or alarms",
  "Settings name autosave merges unrelated edits, rejects external renames and paints one completion",
  "a real browser alarm installs updates for disabled managed dictionaries",
  "a failed scheduled update preserves the working generation without OPFS debris",
  "hovering through a scheduled update never sees an update notice and ends on the new revision",
  "worker restart recreates the configured managed-update alarm",
  "importing a term-only single-kanji dictionary succeeds",
  "dictionary management filters and bulk-updates visible stable selections",
  "drag and keyboard position controls share the persisted lookup order",
  "a delayed alias blur-then-click queues both dictionary edits",
  "named groups normalize unique names and keep stable dictionary memberships",
  "group and member order controls persist their shared state order",
  "a real blur-then-click queues both group edits and retains focus",
  "a newer external focus survives a group rerender",
  "the kanji dictionary chooser lists imported term and kanji dictionaries",
  "a combined archive exposes separate term and native kanji choices",
  "stale title-only kanji selections are pruned",
  "a legacy title-only kanji selection migrates to and persists its native capability",
  "the selected kanji dictionary is saved",
  "custom Settings lazily saves a source through the real WASM importer",
  "a multiline match anchors the popup to the scanned line fragment",
  "browser zoom keeps the popup at its configured on-screen size inside the viewport",
  "hovering positioned per-glyph boxes looks up and highlights the whole word",
  "hover hits glyphs and rejects padded tiles and transparent covering elements",
  "vertical hover hits glyphs and rejects the surrounding padding",
  "mouse resizing retains session dimensions without changing Design settings",
  "wheel over the popup scrolls neither the page nor its body wheel listeners",
  "Alt+wheel over the popup moves one entry per step without scrolling the pane or the page",
  "hovering an inflected verb shows a popup",
  "the reader opens a popup for Japanese text inside a same-origin iframe",
  "the popup paints above a fullscreen player and returns to body on exit",
  "the popup stays in place while a chat feed or the page scrolls and after its source is removed",
  "switching to another tab and back keeps the popup, its Note draft and keyboard focus until Escape",
  "a click into one of the page's frames, same-origin or cross-site, still closes the popup",
  "the content script attached its open-shadow host to the page",
  "the popup deinflects 食べたかった to 食べる",
  "deinflection disclosure exposes the real ordered trace and remains keyboard reachable",
  "dictionary cards render open under a plain title with no disclosure control",
  "nested definition lookups use an accessible close control that dismisses the child popup",
  "nested kanji navigation keeps Back and restores the term lookup close control",
  "repeated keyboard activation returns focus to an existing child lookup close control",
  "focused popup controls allow inherited definition pointer lookups",
  "internal links open a positioned popup chain with level-local Note and Back and live depth limits",
  "hide popup on cursor exit closes a sticky child after its own delay once the pointer returns to the parent",
  "linked and hovered children open beside their source text and follow parent scroll, popup scale and narrow viewports",
  "a child too tall for either side of its link hangs from it shortened, and sticky lookups keep it through a return to its parent until a parent click",
  "a primary click in an ancestor popup dismisses focused, hovered and pending descendants at once while keeping the ancestor and protected drafts",
  "Popup tabs project ordered groups and ungrouped favourites without another lookup",
  "Live dictionary presentation preserves pending replies, focused Note drafts and child anchors",
  "Saved popup columns reflow complete cards after expansion, media load and resize",
  "a clicked-kanji group shows each member with an entry as its own tab in group order",
  "the clicked-kanji chooser saves a group by its stable ID and resets when the group is removed",
  "a clicked-kanji group's native kanji card keeps a ready Anki mining control and mines as the character",
  "Compact summaries persist Settings, share leading media and update live without replacing definitions or Note drafts",
  "Compact summaries wrap without clipping and retain narrow toolbar access",
  COMPACT_GLOSSARIES_CHECK,
  STRUCTURED_TABLE_CHECK,
  ACTION_ROW_CHECK,
  DYNAMIC_HEADWORD_CHECK,
  LOOKUP_COUNT_LAYOUT_CHECK,
  AUDIO_CHOOSER_CHECK,
  "compact definition text opens a nested lookup with the same close contract",
  "Live image sources recover missing thumbnails, preserve owners and resolve groups per path with accurate aliases",
  "Live metadata Settings preserve Note and dictionary content while independently controlling frequency pitch grammar and IPA",
  "external dictionary Enter activation creates one safe browser tab through the extension",
  "a custom link's %s is the hovered or selected word's sentence without ruby readings",
  "an ambiguous headword's furigana is split by its kanji's KANJIDIC readings in the engine worker and the popup",
  "the popup renders the glossary",
  "the popup renders the frequency tag from term_meta_bank",
  "a grouped favourite uses only its group tab",
  "selected term dictionary wins even when maximum results is one",
  "Back preserves the complete clicked-kanji drill-down history",
  "Back restores complete linked results, exact tab, scroll, highlight and toolbar without lookup",
  "Back restores the term results after a generic kanji lookup",
  "clicked-kanji navigation moves and restores keyboard focus",
  "Back restores focus to the exact clicked duplicate kanji",
  "the Settings enabled control disables one logical package",
  "a disabled selected term dictionary falls back to native kanji",
  "a combined archive can use its term entries for clicked kanji",
  "selecting a kanji-bank dictionary keeps the native kanji view",
  `the hovered word is highlighted under CSS.highlights["${HIGHLIGHT_NAME}"]`,
  "Escape hides the popup",
  "dismissing the popup clears the extension's highlight",
  "hovering 漢字 shows a popup",
  "structured content renders a bold span element",
  "structured content renders a ul with its two li",
  "structured content renders a table with the on and kun rows",
  "a structured-content image resolves through hd_media to a data: URL",
  "the popup is showing immediately before the non-Japanese hover",
  "hovering non-Japanese text shows no popup",
  "the same hover shows a popup again after the non-Japanese one",
  "an open Note draft survives hover and consumes Escape before popup dismissal",
  "term and kanji Note forms append and refresh the managed custom dictionary",
  "the settings page lists the dictionary again after a restart",
  "local-only libraries can install recommended dictionaries after a browser restart",
  "the dictionary survives a browser restart via OPFS",
  "lookups work after a restart with no re-import",
  "removing the dictionary clears its settings rows",
  "removing the dictionary deletes its OPFS directory",
  "lookups miss after the dictionary is removed",
  "low memory mode recycles the engine worker and reports memory in Settings",
  "low memory mode imports single-threaded and recycles the import high-water mark",
  "low memory mode keeps only each dictionary's index in the heap",
  "turning low memory mode off restarts the full-pool worker",
  "Use less ram by default applies a 65 MiB hash budget with the full import pool",
  "changing the RAM default restarts the idle engine and preserves lookups and entry storage",
  "resident entry storage restores mapped entries independently of low memory mode",
  "paged hash storage uses the shared cache independently of entry residency",
  "resident hash storage returns after an idle policy restart",
  "real-WASM lookup bounds fail one request without poisoning the OPFS engine",
  "an oversized hover clears the previous popup and the next healthy hover recovers",
  "deep structured content renders while node-limit failures omit only their definition",
  "a 大辞泉-shaped entry nested beyond the former depth limit renders with a real compact summary",
  "large media imports through OPFS while oversized and malformed fetches fail without poisoning the engine",
  "a late real media reply cannot replace a current generation image",
  "failed media exposes its failure state and text while a later hover retries",
  "media cache deduplicates and bounds a real browser image burst",
  "obsolete queued images never dispatch while started images stay reusable",
  "dictionary AVIF and SVG decode through real WASM without extra preview fetches",
  "image hover and keyboard previews stay larger, viewport-clamped and motion-aware",
  "image previews close on leave, blur, scrolling and pending navigation",
  "dictionary image sizing preserves ordinary geometry and enforces its existing aspect bound",
  "Meikyo-compatible gaiji use natural inline geometry and dictionary CSS hooks without overflow",
  "monochrome dictionary images paint in the palette text colour in the card and its preview",
  "dictionary CSS hides a converter head tail through a Japanese-keyed data attribute",
];

const results = [];
let failed = 0;
// Module scope, not a local of main(): an exception anywhere in the run still has
// to reach report(), and the offscreen document's console is the only place a boot
// failure shows up at all -- throwing it away in exactly the case where something
// crashed is how a 90 s "never settled" stays unexplained.
const diagnostics = [];

function check(name, ok, detail = "") {
  if (!PLANNED.includes(name)) fatal(`check("${name}") is not in PLANNED`);
  if (results.some(r => r.name === name)) fatal(`check("${name}") ran twice`);
  results.push({ name, ok, detail });
  if (!ok) failed++;
  if (!ok) attribute(name);
  const mark = ok ? "ok  " : "FAIL";
  console.log(`${mark} ${name}${detail && !ok ? `\n       ${detail}` : ""}`);
}

function fatal(message) {
  console.error(`\nfatal: ${message}`);
  process.exit(1);
}

function report(exit = true) {
  // An assertion that did not run is a failed assertion. Anything else lets a
  // regression shrink the denominator, and "25/25 checks passed" printed by a
  // run that abandoned half of them is worse than a plain failure.
  for (const name of completeRun() ? PLANNED : []) {
    if (!results.some(r => r.name === name)) {
      results.push({ name, ok: false, detail: "check never ran" });
      failed++;
      console.log(`FAIL ${name}\n       check never ran`);
    }
  }
  console.log(`\n${results.length - failed}/${completeRun() ? PLANNED.length : results.length} checks passed`);
  if (failed) {
    console.log(`profile kept for inspection: ${PROFILE}`);
    console.log("\nfailures:");
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  - ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
    }
    if (diagnostics.length) {
      console.log("\nbrowser diagnostics (last 60):");
      for (const d of diagnostics.slice(-60)) console.log(`  ${d}`);
    }
  } else if (!process.env.HACHIDORI_PROFILE) {
    rmSync(PROFILE, { recursive: true, force: true });
  }
  if (exit) process.exit(failed ? 1 : 0);
  if (failed) throw new Error(`${failed} check(s) failed`);
}

export {
  check, diagnostics, EXTENSION, failed, fatal, HERE, HIGHLIGHT_NAME, markCompleteSuite, PROFILE,
  report, step, WORD_HIGHLIGHT_CHECKS,
};
