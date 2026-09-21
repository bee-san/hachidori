// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildAnkiFields } from "../extension/anki-values.js";
import { ANKI_TEMPLATE_MARKER_OPTIONS, ankiTemplateMarkerNames } from "../extension/anki-templates.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));

const pitch = (position, pattern = "") => ({ position, pattern, nasal: [], devoice: [] });
const group = (pitches, dictionary = "Pitch") => ({ dictionary, pitches, transcriptions: [] });
async function render(reading, pitches, marker = "pitch-accent-graphs") {
  const fields = await buildAnkiFields({ term: { expression: reading, reading, pitches } }, {
    Graph: { value: `{${marker}}`, overwriteMode: "overwrite" },
  }, {});
  return JSDOM.fragment(fields.Graph);
}

test("graph markers are distinct from legacy pitch text in planning and discovery", () => {
  assert.deepEqual(ankiTemplateMarkerNames("{pitch-accent}{pitch-accents}{pitch-accent-graphs}{PITCH-ACCENT-GRAPHS-JJ}"),
    ["pitch", "pitch", "pitch-accent-graphs", "pitch-accent-graphs-jj"]);
  for (const marker of ["pitch-accent-graphs", "pitch-accent-graphs-jj"]) {
    const option = ANKI_TEMPLATE_MARKER_OPTIONS.find(option => option.marker === marker);
    assert.match(option.description, /Japanese.*SVG/u);
  }
});

for (const marker of ["pitch-accent-graphs", "pitch-accent-graphs-jj"]) {
  test(`${marker} distinguishes flat, head, middle and tail accents including the following particle`, async () => {
    const root = await render("かたな", [group([pitch(0), pitch(1), pitch(2), pitch(3)])], marker);
    const graphs = [...root.querySelectorAll("svg")];
    assert.equal(graphs.length, 4);
    const high = marker.endsWith("-jj") ? "10" : "25";
    assert.deepEqual(graphs.map(svg => [...svg.querySelectorAll(".pronunciation-graph-dot")]
      .map(dot => dot.getAttribute("cy") === high ? "H" : "L").join("")), ["LHH", "HLL", "LHL", "LHH"]);
    assert.deepEqual(graphs.map(svg => svg.querySelector(".pronunciation-graph-tail").getAttribute("data-pitch")),
      ["high", "low", "low", "low"]);
    for (const svg of graphs) {
      assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
      assert.equal(svg.getAttribute("role"), "img");
      assert.match(svg.querySelector("title").textContent, /かたな/u);
      assert.equal(svg.querySelector("script, style, use, image"), null);
      assert.equal(svg.querySelector("[id]"), null, "repeated fields need no shared SVG definitions");
      assert.ok(svg.getAttribute("style").includes("em"));
    }
  });
}

test("kana graph counts contracted kana, long vowels, small tsu and n as morae", async () => {
  const root = await render("キョーっとん", [group([pitch(4)])], "pitch-accent-graphs-jj");
  assert.deepEqual([...root.querySelectorAll("text")].map(node => node.textContent), ["キョ", "ー", "っ", "と", "ん"]);
  assert.equal(root.querySelectorAll(".pronunciation-graph-dot").length, 5);
  const single = await render("き", [group([pitch(0), pitch(1)])]);
  assert.deepEqual([...single.querySelectorAll(".pronunciation-graph-tail")].map(node => node.dataset.pitch), ["high", "low"]);
  const combined = await render("か\u3099", [group([pitch(1)])], "pitch-accent-graphs-jj");
  assert.equal(combined.querySelector("text").textContent, "が");
});

test("explicit patterns take precedence over the native placeholder position and retain an explicit particle", async () => {
  const root = await render("たべる", [group([pitch(0, "HLL"), pitch(0, "LHH"), pitch(0, "LHHL")])]);
  assert.deepEqual([...root.querySelectorAll("svg")].map(svg => [...svg.querySelectorAll(".pronunciation-graph-dot")]
    .map(dot => dot.getAttribute("cy"))), [["25", "75", "75"], ["75", "25", "25"], ["75", "25", "25"]]);
  assert.deepEqual([...root.querySelectorAll(".pronunciation-graph-tail")].map(node => node.dataset.pitch), ["low", "high", "low"]);
});

test("absent, transcription-only, empty and invalid pitch data leave graph fields empty", async () => {
  for (const [reading, pitches] of [["たべる", []], ["たべる", [{ ...group([]), transcriptions: ["tabeɾɯ"] }]],
    ["", [group([pitch(0)])]], ["たべる", [group([pitch(-1), pitch(4), pitch(1.5), pitch(0, "HL"), pitch(0, "HXL"), pitch(0, "LHHHH")])]]]) {
    assert.equal((await render(reading, pitches)).childNodes.length, 0);
  }
});

test("graphs retain dictionary order and variants, escape labels and can repeat safely across fields", async () => {
  const reading = '<&"';
  const root = await render(reading, [group([pitch(1), pitch(2)], '<Pitch & "A">'), group([pitch(0)], "B")], "pitch-accent-graphs-jj");
  assert.deepEqual([...root.querySelectorAll("b")].map(node => node.textContent), ['<Pitch & "A">', "B"]);
  assert.equal(root.querySelectorAll("svg").length, 3);
  assert.equal(root.querySelector("svg").querySelector("title").textContent, `${reading}: pitch accent 1`);
  assert.deepEqual([...root.querySelector("svg").querySelectorAll("text")].map(node => node.textContent), [...reading]);
  const term = { expression: "たべる", reading: "", pitches: [group([pitch(2)])] };
  const template = { value: "{pitch-accent-graphs}", overwriteMode: "overwrite" };
  const fields = await buildAnkiFields({ term }, { A: template, B: template, Text: { ...template, value: "{pitch}|{pitch-accent}|{pitch-position}" } }, {});
  assert.equal(fields.A, fields.B);
  assert.match(fields.A, /<svg/u);
  assert.equal(fields.Text, "<b>Pitch</b>: position 2|<b>Pitch</b>: position 2|2");
});

test("ordinary templates do not read pitch data", async () => {
  const term = { expression: "食べる", get pitches() { throw new Error("Unexpected pitch work"); } };
  assert.deepEqual(await buildAnkiFields({ term }, { Front: { value: "{expression}" } }, {}), { Front: "食べる" });
});
