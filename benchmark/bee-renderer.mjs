// Production Bee rendering and presentation updates, with forced layout.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, loadavg, platform, release, tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { directoryContentSha256 } from "./system.mjs";

const [destination, ...checkouts] = process.argv.slice(2);
assert.ok(destination && checkouts.length, "usage: bee-renderer.mjs OUTPUT BEFORE_CHECKOUT [AFTER_CHECKOUT]");
const output = resolve(destination), roots = checkouts.map(path => resolve(path));
const profiles = Number(process.env.HACHIDORI_BEE_PROFILES ?? 3);
const measurements = Number(process.env.HACHIDORI_BEE_SAMPLES ?? 100), warmups = 20;
assert.ok([profiles, measurements].every(value => Number.isSafeInteger(value) && value > 0));
mkdirSync(output, { recursive: true });
const sha256 = data => createHash("sha256").update(data).digest("hex");
const distribution = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { n: sorted.length, median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};
const pageHtml = '<!doctype html><meta charset="utf-8"><script src="/reader-options.js"></script>'
  + '<script src="/external-links.js"></script><script src="/render/glossary.js"></script><script src="/render/popup.js"></script>';
const puppeteer = await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href);
const server = createServer((request, response) => {
  const [index, ...parts] = new URL(request.url, "http://localhost").pathname.split("/").filter(Boolean);
  if (!parts.length) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(pageHtml.replaceAll('src="/', `src="/${index}/`)); return; }
  try {
    const path = resolve(roots[Number(index)], "extension", ...parts);
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
    response.end(readFileSync(path));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const raw = { environment: { startedAt: new Date().toISOString(), platform: platform(), release: release(),
  node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, load: loadavg(),
  profiles, measurements, warmups, theme: "bee", boundary: "Production renderer plus forced synchronous layout; excludes engine, transport, runtime action binding, paint and asynchronous media.",
  order: "fresh browser per checkout/profile; reverse checkout and scenario order in odd profiles" },
  harnessSha256: sha256(readFileSync(new URL(import.meta.url))),
  checkouts: roots.map(root => ({ path: root, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    extensionSha256: directoryContentSha256(resolve(root, "extension")) })), cells: [] };
const signatures = new Map();
try {
  for (let profile = 0; profile < profiles; profile++) {
    const order = roots.map((_, index) => index);
    if (profile % 2) order.reverse();
    for (const checkout of order) {
      const directory = mkdtempSync(resolve(tmpdir(), "hachidori-bee-renderer-"));
      let browser;
      try {
        browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
          userDataDir: directory, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
        raw.environment.chrome = await browser.version();
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 900 });
        await page.goto(`http://127.0.0.1:${server.address().port}/${checkout}/`);
        const scenarios = [{ results: 1, grouped: false }, { results: 12, grouped: false }, { results: 12, grouped: true }];
        if (profile % 2) scenarios.reverse();
        for (const scenario of scenarios) {
          const cell = await page.evaluate(async ({ scenario, measurements, warmups, checkout }) => {
            const base = `/${checkout}/`;
            const [{ default: bee }, css, icons] = await Promise.all([import(`${base}vendor/themes/bee/theme.js`),
              fetch(`${base}vendor/themes/bee/theme.css`).then(response => response.text()), fetch(`${base}icons.css`).then(response => response.text())]);
            const host = document.createElement("div"), shadow = host.attachShadow({ mode: "open" });
            document.body.append(host);
            const style = document.createElement("style"); style.textContent = `${css}\n${icons}`;
            const popup = document.createElement("div"); popup.className = "gsm-hoshidicts-popup";
            popup.style.cssText = "left:20px;top:20px;width:560px;height:420px;--gsm-hoshidicts-popup-opacity:100%";
            shadow.append(style, popup);
            const dictionaries = ["JMdict", "Jitendex", "Grammar dictionary"];
            const frequencies = ["Anime", "Novels", "Wikipedia"].map((dictionary, index) => ({ dictionary,
              frequencies: [{ value: [142, 982, 321][index], displayValue: null }] }));
            const glossaries = dictionaries.flatMap((dictionary, index) => index === 1
              ? [{ dictionary, glossary: JSON.stringify([{ type: "structured-content", content: { tag: "div", content:
                Array.from({ length: 8 }, (_, sense) => ({ tag: "p", content: [{ tag: "b", content: `Sense ${sense + 1}: ` }, "to eat a meal; 食事をする。"] })) } }]) }]
              : Array.from({ length: 8 }, (_, sense) => ({ dictionary, glossary: JSON.stringify([`Definition ${sense + 1}: to eat a meal; 食事をする。`]) })));
            const results = Array.from({ length: scenario.results }, (_, index) => ({ matched: "食べる", trace: [], term: {
              expression: "食べる", reading: "たべる", frequencies, pitches: [{ dictionary: "Pitch", pitches: [{ position: 2 }] }],
              glossaries, sequence: index } }));
            const context = { dictionaryPresentation: [...dictionaries, ...frequencies.map(group => group.dictionary)].map(title => ({ title, frequencyMode: "rank-based" })),
              dictionaryTabGroups: scenario.grouped ? [{ id: "first", name: "Words", dictionaries: [dictionaries[0]] },
                { id: "other", name: "Other", dictionaries: dictionaries.slice(1) }] : [],
              selectedDictionaryTab: scenario.grouped ? { groupId: "first" } : null,
              showFrequencyDictionaryNames: true, showPitchAccentFurigana: true, pitchAccentFuriganaStyle: "contour" };
            let counts = null;
            const components = { ...window.HDPopup, ...window.HDGlossary };
            for (const [method, counter] of [["createFrequencyTags", "frequencyCalls"], ["buildPitchAccentMorae", "pitchCalls"],
              ["createLookupActions", "actionCalls"], ["createDictionaryTabs", "groupCalls"]]) {
              const original = components[method];
              components[method] = (...args) => { if (counts) counts[counter] = (counts[counter] || 0) + 1; return original(...args); };
            }
            const originalGlossary = window.HDGlossary.appendTextOnlyGlossary;
            const view = bee.createView({ document, window, popup, components, positionPopup() {}, getImageHoverPreview: () => "off",
              appendTextOnlyGlossary(...args) { if (counts) counts.glossaryCalls = (counts.glossaryCalls || 0) + 1; return originalGlossary(...args); },
              customButtons: ["Search", "Sentence", "More"].map((label, index) => ({ id: `action-${index}`, type: "link", label, url: "https://example.test/%w" })) });
            const layout = () => { popup.getBoundingClientRect(); view.scrollElement.scrollHeight; };
            const render = () => { view.renderResults(results, { query: "食べる" }, context); layout(); };
            counts = {}; render(); const buildCounts = counts;
            const chips = [...popup.querySelectorAll(".gsm-hoshidicts-tag-frequency")];
            counts = {}; view.updateDictionaryPresentation({ ...context }); layout(); const unchangedCounts = counts;
            const retainedFrequency = chips.every((chip, index) => chip === popup.querySelectorAll(".gsm-hoshidicts-tag-frequency")[index]);
            counts = {}; view.updateDictionaryPresentation({ ...context, pitchAccentFuriganaStyle: "overline" }); layout(); const pitchCounts = counts;
            const pitchRetainedFrequency = chips.every((chip, index) => chip === popup.querySelectorAll(".gsm-hoshidicts-tag-frequency")[index]);
            counts = null;
            const signature = JSON.stringify([...popup.querySelectorAll(".jl-entry")].map(entry => [entry.dataset.dictionary,
              entry.hidden, entry.querySelector(".gsm-hoshidicts-definitions").textContent,
              [...entry.querySelectorAll(".gsm-hoshidicts-tag-frequency")].map(chip => [chip.textContent, chip.getAttribute("aria-label")]),
              [...entry.querySelectorAll(".jl-mora")].map(mora => [mora.textContent, mora.dataset.pitch, mora.dataset.transition])]));
            const blocks = popup.querySelectorAll(".jl-entry").length, visibleBlocks = popup.querySelectorAll(".jl-entry:not([hidden])").length;
            if (blocks !== scenario.results * 3 || visibleBlocks !== scenario.results * (scenario.grouped ? 1 : 3)
                || chips.length !== blocks * 3) throw new Error("Fixture was not completely rendered");
            const cell = { ...scenario, blocks, visibleBlocks, nodes: popup.querySelectorAll("*").length, frequencyChips: chips.length,
              fixtureCharacters: JSON.stringify(results).length, signature, buildCounts, unchangedCounts, pitchCounts, retainedFrequency, pitchRetainedFrequency };
            const updates = {
              unchanged: () => ({ ...context }),
              groupRename: index => ({ ...context, dictionaryTabGroups: context.dictionaryTabGroups.map(group => ({ ...group, name: `${group.name} ${index % 2}` })) }),
              pitchChange: index => ({ ...context, pitchAccentFuriganaStyle: index % 2 ? "contour" : "overline" }),
            };
            function perform(metric, index) {
              if (metric === "render") render();
              else { view.updateDictionaryPresentation(updates[metric](index)); layout(); }
            }
            for (const metric of ["render", "unchanged", "groupRename", "pitchChange"]) {
              if (metric !== "render") render();
              const values = [];
              for (let index = 0; index < warmups + measurements; index++) {
                const start = performance.now();
                perform(metric, index);
                if (index >= warmups) values.push(performance.now() - start);
              }
              cell[metric] = values;
            }
            view.destroy(); host.remove();
            return cell;
          }, { scenario, measurements, warmups, checkout });
          const key = JSON.stringify(scenario), signature = sha256(cell.signature); delete cell.signature;
          if (signatures.has(key)) assert.equal(signature, signatures.get(key), "dictionary, glossary, visibility, frequency and pitch signatures match across profiles and revisions");
          else signatures.set(key, signature);
          raw.cells.push({ profile, checkout, signature, load: loadavg(), ...cell });
          writeFileSync(resolve(output, "raw.json"), JSON.stringify(raw, null, 2) + "\n");
          console.log(JSON.stringify({ profile, checkout, ...scenario, render: distribution(cell.render), unchanged: distribution(cell.unchanged) }));
        }
      } finally { await browser?.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  }
  const summary = raw.checkouts.map((checkout, index) => ({ ...checkout, scenarios: ["1:false", "12:false", "12:true"].map(key => {
    const cells = raw.cells.filter(cell => cell.checkout === index && `${cell.results}:${cell.grouped}` === key);
    const first = cells[0];
    return { results: first.results, grouped: first.grouped, blocks: first.blocks, visibleBlocks: first.visibleBlocks,
      nodes: first.nodes, frequencyChips: first.frequencyChips, fixtureCharacters: first.fixtureCharacters, signature: first.signature,
      buildCounts: first.buildCounts, unchangedCounts: first.unchangedCounts, pitchCounts: first.pitchCounts,
      retainedFrequency: cells.every(cell => cell.retainedFrequency), pitchRetainedFrequency: cells.every(cell => cell.pitchRetainedFrequency),
      ...Object.fromEntries(["render", "unchanged", "groupRename", "pitchChange"].map(metric => [metric, distribution(cells.flatMap(cell => cell[metric]))])),
      profileMedians: cells.map(cell => ({ profile: cell.profile,
        ...Object.fromEntries(["render", "unchanged", "groupRename", "pitchChange"].map(metric => [metric, distribution(cell[metric]).median])) })) };
  }) }));
  writeFileSync(resolve(output, "summary.json"), JSON.stringify({ environment: raw.environment, checkouts: summary }, null, 2) + "\n");
} finally { await new Promise(done => server.close(done)); }
