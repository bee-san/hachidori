// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoricalKanaZip, HISTORICAL_KANA_CASES, HISTORICAL_KANA_TITLE } from "./historical-kana-fixture.mjs";

for (const variant of ["hoshidicts-threaded", "hoshidicts-threaded-idbfs", "hoshidicts"]) {
  test(`${variant}: Yomitan historical conjugations and kanji variants`, async t => {
    const { default: createHoshidicts } = await import(`../extension/vendor/${variant}.mjs`);
    const runtime = await createHoshidicts();
    t.after(() => runtime.PThread?.terminateAllThreads());
    const call = (name, ret, types, args) => runtime.ccall(name, ret, types, args);
    call("hdw_init_storage", "number", ["number"], [0]);
    runtime.FS.writeFile("/historical.zip", buildHistoricalKanaZip());
    const report = JSON.parse(call("hdw_import", "string", ["string", "string", "number"], ["/historical.zip", "/dicts", 0]));
    assert.equal(report.success, true, JSON.stringify(report));
    const path = `/dicts/${HISTORICAL_KANA_TITLE}`;
    assert.equal(call("hdw_add_dict", "number", ["string", "number", "number", "number"], [path, 0, 0, 0]), 1);

    function lookup(text, dictionary = false) {
      return JSON.parse(dictionary
        ? call("hdw_lookup_dictionary", "string", ["string", "string", "number", "number", "string"],
          [text, path, 32, 32, ""])
        : call("hdw_lookup", "string", ["string", "number", "number", "string"], [text, 32, 32, ""])).results;
    }
    for (const [source, term, rule, trace] of HISTORICAL_KANA_CASES) {
      const match = lookup(source).find(result => result.matched === source && result.term.expression === term);
      assert.ok(match, `${source} → ${term} (${rule})`);
      assert.equal(match.deinflected, term, source);
      assert.deepEqual(match.trace.map(step => step.name), trace, source);
      assert.ok(match.trace.every(step => step.description.length > 0), source);
    }
    for (const [source, term] of [["思います", "思う"], ["思いたくなかった", "思う"],
      ["食べている", "食べる"], ["讀みませう", "読む"], ["讀んでゐる", "読む"]]) {
      for (const dictionary of [false, true]) {
        assert.ok(lookup(source, dictionary).some(result => result.matched === source && result.term.expression === term),
          `${source} → ${term}, selected dictionary: ${dictionary}`);
      }
    }
    // Upstream explicitly excludes these spellings. A shorter prefix may
    // still be a valid lookup, but it must not match the whole scanned form.
    for (const source of ["思へる", "思ほう"]) {
      assert.ok(!lookup(source).some(result => result.matched === source && result.term.expression === "思う"), source);
    }
  });
}
