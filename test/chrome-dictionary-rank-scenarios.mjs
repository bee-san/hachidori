// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";

export const DICTIONARY_RANK_CHECK = "three-digit dictionary ranks keep an aligned title gutter after row reuse";

export async function checkDictionaryRankLayout(page, observe) {
  const viewport = page.viewport();
  const hash = await page.evaluate(() => location.hash);
  const initial = await page.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_read" });
    if (!reply.ok) throw new Error(reply.error);
    return reply.state;
  });
  const write = dictionaries => page.evaluate(async dictionaries => {
    const current = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_read" });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: current.state?.revision ?? 0, dictionaries });
    if (!reply.ok) throw new Error(reply.error);
  }, dictionaries);
  const originals = initial?.dictionaries ?? [];
  const dictionaries = [...originals, ...Array.from({ length: 120 - originals.length }, (_, index) => ({
    id: `rank-layout-${index}`, title: `辞書 ${index + 1}`, path: `/dicts/辞書 ${index + 1}`,
    enabled: false,
  }))];
  const measureLayout = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll("#dict-list .dict-row")];
    return {
      viewportWidth: innerWidth,
      count: rows.length,
      lastRank: rows.at(-1).querySelector(".dict-rank").textContent,
      samples: [9, 99, 120].map(position => {
        const row = rows[position - 1];
        const rank = row.querySelector(".dict-rank");
        const title = row.querySelector(".dict-title");
        const text = document.createRange();
        text.selectNodeContents(rank);
        const style = getComputedStyle(rank);
        return {
          position, rank: rank.textContent,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          minWidth: style.minWidth,
          width: style.width,
          rankWidth: rank.getBoundingClientRect().width,
          textWidth: text.getBoundingClientRect().width,
          columns: getComputedStyle(row).gridTemplateColumns,
          rankRight: rank.getBoundingClientRect().right,
          textRight: text.getBoundingClientRect().right,
          titleLeft: title.getBoundingClientRect().left,
        };
      }),
    };
  });
  const measure = async stage => {
    const layouts = [];
    for (const width of [1280, 320]) {
      await page.setViewport({ width, height: 900 });
      const geometry = await measureLayout();
      layouts.push(geometry);
      await observe?.(`${stage}-${width}`, geometry);
    }
    return layouts;
  };
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await write(dictionaries);
    await page.reload();
    await page.evaluate(() => { location.hash = "dictionaries"; });
    await page.waitForFunction(() => document.querySelectorAll("#dict-list .dict-row").length === 120
      && !document.querySelector("#dict-list .dict-down").disabled);
    const before = await measure("before-reorder");
    const rows = await page.evaluateHandle(() => [...document.querySelectorAll("#dict-list .dict-row")]);
    const movedId = dictionaries[8].id;
    const selector = `.dict-row[data-dictionary-id="${movedId}"]`;
    await page.$eval(`${selector} .dict-details-toggle`, button => button.click());
    await page.$eval(`${selector} .dict-position-input`, input => { input.value = "120"; });
    await page.$eval(`${selector} .dict-move`, button => button.click());
    await page.waitForFunction(async movedId => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const last = document.querySelector("#dict-list .dict-row:last-child");
      return dictionaryState.dictionaries.at(-1).id === movedId
        && last.dataset.dictionaryId === movedId && !last.querySelector(".dict-up").disabled;
    }, { timeout: 10000 }, movedId);
    const after = await measure("after-reorder");
    const reused = await page.evaluate(rows => rows.every(row =>
      document.querySelector(`#dict-list [data-dictionary-id="${row.dataset.dictionaryId}"]`) === row), rows);
    await rows.dispose();
    assert.equal(reused, true, "reordering must exercise the existing row reuse path");
    for (const geometry of [...before, ...after]) {
      assert.equal(geometry.count, 120);
      assert.equal(geometry.lastRank, "120");
      for (const sample of geometry.samples) {
        assert.equal(sample.rank, String(sample.position));
        assert.ok(Math.max(sample.rankRight, sample.textRight) + 4 <= sample.titleLeft,
          `rank ${sample.position} needs at least 4px before its title: ${JSON.stringify(sample)}`);
      }
      // The ch minimum and intrinsic text round 1/64px apart with CI's system font.
      for (const [key, label] of [["titleLeft", "titles must share one gutter"], ["textRight", "rank digits must align at the end"]]) {
        const coordinates = geometry.samples.map(sample => sample[key]);
        const spread = Math.max(...coordinates) - Math.min(...coordinates);
        assert.ok(spread <= 1 / 64, `${label} (spread ${spread}px): ${JSON.stringify(geometry)}`);
      }
    }
    console.log("PASS dictionary rank geometry", JSON.stringify({ before, after, reused }));
    return { before, after, reused };
  } finally {
    await write(originals);
    await page.evaluate(async () => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_reload" });
      if (!reply.ok) throw new Error(reply.error);
    });
    await page.reload();
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await page.setViewport(viewport);
  }
}
