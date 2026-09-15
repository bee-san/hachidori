import assert from "node:assert/strict";
import { buildTitledZip } from "./make-fixture.mjs";

export async function dictionaryManagementScenarios(page) {
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
