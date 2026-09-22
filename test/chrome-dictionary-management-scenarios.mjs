import assert from "node:assert/strict";
import { buildTitledZip } from "./make-fixture.mjs";

export const REORDER_CHECKS = [
  "dictionary moves render before the engine reply and coalesce across rapid and in-flight edits",
  "concurrent Settings reorders reject the stale CAS and restore the authoritative list",
];

async function optimisticReorderScenarios(page, { gamma, beta, prefix, readState, waitOrder, check }) {
  const initial = await readState();
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const probe = { requests: [], delivered: false, original };
    globalThis.reorderProbe = probe;
    chrome.runtime.sendMessage = async (...args) => {
      if (args[0]?.type !== "hd_apply_state") return original(...args);
      probe.requests.push(args[0]);
      const reply = await original(...args);
      if (probe.requests.length === 1) await new Promise(done => { probe.release = done; });
      probe.delivered = true;
      return reply;
    };
  });
  const immediate = await page.evaluate(({ id, rank }) => {
    const row = document.querySelector(`[data-dictionary-id="${id}"]`);
    const before = performance.now();
    for (const direction of ["up", "down", "up", "down", "up"]) row.querySelector(`.dict-${direction}`).click();
    return { rank: row.querySelector(".dict-rank").textContent,
      position: [...row.parentElement.children].indexOf(row) + 1,
      enabled: !row.querySelector(".dict-up").disabled, delivered: reorderProbe.delivered,
      milliseconds: performance.now() - before, expected: rank };
  }, { id: gamma.id, rank: prefix.length + 2 });
  assert.equal(immediate.rank, String(immediate.expected), JSON.stringify(immediate));
  assert.equal(immediate.position, immediate.expected);
  assert.equal(immediate.enabled, true);
  assert.equal(immediate.delivered, false);
  await page.waitForFunction(() => typeof reorderProbe.release === "function");
  assert.equal(await page.evaluate(() => reorderProbe.requests.length), 1, "five rapid moves send one final order");
  // The storage event already arrived, but its older order must not replace a
  // newer optimistic move while the first acknowledgement is held.
  await page.evaluate(id => document.querySelector(`[data-dictionary-id="${id}"] .dict-up`).click(), gamma.id);
  assert.equal(await page.$eval(`[data-dictionary-id="${gamma.id}"] .dict-rank`, el => el.textContent), String(prefix.length + 1));
  if (process.env.HACHIDORI_REORDER_SCREENSHOT) await page.screenshot({ path: process.env.HACHIDORI_REORDER_SCREENSHOT });
  await page.evaluate(() => reorderProbe.release());
  const firstTwo = initial.dictionaries.slice(prefix.length, prefix.length + 2).map(entry => entry.id);
  await waitOrder([...prefix, gamma.id, ...firstTwo]);
  assert.equal(await page.evaluate(() => reorderProbe.requests.length), 2, "an in-flight move follows the first commit exactly once");
  check(REORDER_CHECKS[0], true);

  const other = await page.browser().newPage();
  try {
    await other.goto(page.url());
    await other.waitForSelector(`[data-dictionary-id="${beta.id}"] .dict-up`);
    await page.bringToFront();
    await page.evaluate(() => {
      const original = reorderProbe.original;
      chrome.runtime.sendMessage = async (...args) => {
        if (args[0]?.type === "hd_apply_state") await new Promise(done => { reorderProbe.send = done; });
        return original(...args);
      };
    });
    await page.evaluate(id => document.querySelector(`[data-dictionary-id="${id}"] .dict-down`).click(), gamma.id);
    await page.waitForFunction(() => typeof reorderProbe.send === "function");
    await other.bringToFront();
    await other.evaluate(id => document.querySelector(`[data-dictionary-id="${id}"] .dict-up`).click(), beta.id);
    await other.waitForFunction(async id => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      return dictionaryState.dictionaries.at(-2).id === id;
    }, {}, beta.id);
    const winner = await readState();
    await page.bringToFront();
    await page.evaluate(() => reorderProbe.send());
    await page.waitForFunction(() => document.getElementById("engine-status").textContent.includes("Dictionary change was not saved"));
    await waitOrder(winner.dictionaries.map(entry => entry.id));
    assert.deepEqual((await readState()).dictionaries, winner.dictionaries);
    check(REORDER_CHECKS[1], true);
  } finally {
    await other.close();
    await page.evaluate(() => { chrome.runtime.sendMessage = reorderProbe.original; });
  }
  const restored = await page.evaluate(async dictionaries => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_apply_state",
      baseRevision: dictionaryState.revision, dictionaries });
  }, initial.dictionaries);
  assert.equal(restored.ok, true);
  await page.reload();
  await waitOrder(initial.dictionaries.map(entry => entry.id));
}

export async function dictionaryManagementScenarios(page, check = () => {}) {
  const click = async selector => {
    const point = await page.$eval(selector, element => {
      element.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
  };
  const readState = () => page.evaluate(async () =>
    (await chrome.storage.local.get("dictionaryState")).dictionaryState);
  const initial = await readState();
  const titles = ["management-alpha", "management-beta", "management-gamma"];
  for (const title of titles) {
    const reply = await page.evaluate(async ({ bytes, title }) => {
      const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
      try {
        return await chrome.runtime.sendMessage({
          target: "hoshidicts-offscreen", type: "hd_import", requestId: crypto.randomUUID(),
          blobUrl, fileName: `${title}.zip`,
        });
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }, { bytes: [...buildTitledZip(title)], title });
    assert.equal(reply.ok, true, JSON.stringify(reply));
  }
  await page.reload();
  await page.evaluate(() => { location.hash = "dictionaries"; });
  const imported = (await readState()).dictionaries.filter(entry => titles.includes(entry.title));
  assert.equal(imported.length, 3);
  const row = entry => `.dict-row[data-dictionary-id="${entry.id}"]`;
  const visibleOrder = () => page.$$eval("#dict-list .dict-row", rows => rows.map(entry => entry.dataset.dictionaryId));
  const waitOrder = async expected => {
    await page.waitForFunction(async ids => {
      const state = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
      const rows = [...document.querySelectorAll("#dict-list .dict-row")];
      return JSON.stringify(state.dictionaries.map(entry => entry.id)) === JSON.stringify(ids)
        && JSON.stringify(rows.map(entry => entry.dataset.dictionaryId)) === JSON.stringify(ids);
    }, { timeout: 10000 }, expected);
  };
  const prefix = initial.dictionaries.map(entry => entry.id);
  const [alpha, beta, gamma] = imported;
  await waitOrder([...prefix, alpha.id, beta.id, gamma.id]);
  await optimisticReorderScenarios(page, { gamma, beta, prefix, readState, waitOrder, check });
  await click(`${row(alpha)} .dict-details-toggle`);
  await click(`${row(alpha)} .dict-selected`);
  await click(`${row(alpha)} .dict-down`);
  await waitOrder([...prefix, beta.id, alpha.id, gamma.id]);
  await click(`${row(alpha)} .dict-down`);
  await waitOrder([...prefix, beta.id, gamma.id, alpha.id]);
  assert.equal(await page.$eval(`${row(alpha)} .dict-down`, button => button.disabled), true);
  assert.equal(await page.$eval(`${row(alpha)} .dict-details`, details => details.open), true);
  assert.equal(await page.$eval(`${row(alpha)} .dict-selected`, input => input.checked), true);
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".dict-row")?.dataset.dictionaryId), alpha.id);
  await click(`${row(alpha)} .dict-up`);
  await waitOrder([...prefix, beta.id, alpha.id, gamma.id]);
  await click(`${row(alpha)} .dict-up`);
  await waitOrder([...prefix, alpha.id, beta.id, gamma.id]);
  await page.reload();
  await waitOrder([...prefix, alpha.id, beta.id, gamma.id]);
  assert.deepEqual(await visibleOrder(), [...prefix, alpha.id, beta.id, gamma.id]);
  for (const entry of imported) await click(`${row(entry)} .dict-selected`);
  assert.equal(await page.$eval("#dict-bulk-actions", toolbar =>
    [...toolbar.querySelectorAll("button")].some(button => button.textContent.trim() === "Remove")), true,
  "selected dictionaries must offer bulk removal");
  let dialogs = 0;
  const cancel = async dialog => { dialogs += 1; await dialog.dismiss(); };
  page.once("dialog", cancel);
  await click("#dict-bulk-remove");
  assert.deepEqual((await readState()).dictionaries.map(entry => entry.id), [...prefix, alpha.id, beta.id, gamma.id]);
  page.once("dialog", async dialog => { dialogs += 1; await dialog.accept(); });
  await click("#dict-bulk-remove");
  await waitOrder(prefix);
  assert.equal(dialogs, 2, "one confirmation per batch, not per dictionary");
  assert.equal(await page.$eval("#dict-selection-count", element => element.textContent), "0 selected");
  await page.reload();
  await waitOrder(prefix);
  assert.deepEqual((await readState()).dictionaries, initial.dictionaries);
  assert.deepEqual((await readState()).groups, initial.groups);
  console.log("PASS dictionary pointer reorder, boundaries, focus, selection, reload and confirmed bulk removal");
}
