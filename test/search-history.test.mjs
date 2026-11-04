// SPDX-License-Identifier: GPL-3.0-or-later
// The search page's line history (extension/search-history.js): lines with
// their time, source and page, a repeat of the newest line kept once, the
// newest lines kept up to the limit, lists from either side of a line, and
// every change told to the other open pages.
import assert from "node:assert/strict";
import test from "node:test";
import { openSearchHistory } from "../extension/search-history.js";
import { fakeIndexedDB, KeyRange } from "./indexeddb-fake.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const texts = lines => lines.map(line => line.text);
// A store on `indexedDB` whose clock ticks once per line, with the changes it hears.
function history(t, indexedDB, name = `history-${Math.random()}`) {
  let time = 1_000;
  const store = openSearchHistory({ indexedDB, IDBKeyRange: KeyRange, name, now: () => (time += 1) });
  const changes = [];
  store.onChange(change => changes.push(plain(change)));
  t.after(() => store.close());
  return { store, changes, name };
}
const typed = text => ({ text, source: "typed", page: "tab" });

test("a line is kept with its time, source and page; a repeat of the newest is not, and only the newest lines are kept", async (t) => {
  const { store, changes } = history(t, fakeIndexedDB());
  assert.deepEqual(plain(await store.add(typed("  食べたかった\n"), { limit: 3 })),
    { line: { text: "食べたかった", at: 1_001, source: "typed", page: "tab", id: 1 }, added: true });
  const repeated = await store.add({ text: "食べたかった", source: "clipboard", page: "popup" }, { limit: 3 });
  assert.deepEqual(plain(repeated), { line: { text: "食べたかった", at: 1_001, source: "typed", page: "tab", id: 1 }, added: false });
  await store.add({ text: "読む", source: "paste", page: "popup" }, { limit: 3 });
  // A line again after another one is a new line.
  await store.add({ text: "食べたかった", source: "clipboard", page: "tab" }, { limit: 3 });
  assert.deepEqual(texts(await store.list()), ["食べたかった", "読む", "食べたかった"]);
  await store.add(typed("漢字"), { limit: 3 });
  assert.deepEqual(plain(await store.list()).map(({ id, text, source, page }) => [id, text, source, page]),
    [[2, "読む", "paste", "popup"], [3, "食べたかった", "clipboard", "tab"], [4, "漢字", "typed", "tab"]]);
  assert.equal(await store.count(), 3);
  assert.deepEqual(changes.map(change => [change.type, change.line?.id ?? change.before]),
    [["add", 1], ["add", 2], ["add", 3], ["add", 4], ["prune", 2]]);

  for (const [line, limit] of [[typed(" \n"), 3], [{ ...typed("x"), source: "dragged" }, 3],
    [{ ...typed("x"), page: "window" }, 3], [typed("x"), 0], [typed("x"), 1.5], [null, 3]]) {
    await assert.rejects(store.add(line, { limit }), TypeError, JSON.stringify([line, limit]));
  }
  assert.equal(await store.count(), 3);
});

test("lists run from the oldest line, or page back and forward from a line", async (t) => {
  const { store } = history(t, fakeIndexedDB());
  for (const text of ["一", "二", "三", "四", "五"]) await store.add(typed(text), { limit: 100 });
  assert.deepEqual(texts(await store.list()), ["一", "二", "三", "四", "五"]);
  assert.deepEqual(texts(await store.list({ limit: 2 })), ["四", "五"]);
  assert.deepEqual(texts(await store.list({ before: 4, limit: 2 })), ["二", "三"]);
  assert.deepEqual(texts(await store.list({ before: 4 })), ["一", "二", "三"]);
  assert.deepEqual(texts(await store.list({ after: 2, limit: 2 })), ["三", "四"]);
  assert.deepEqual(texts(await store.list({ after: 2 })), ["三", "四", "五"]);
  assert.deepEqual(await store.list({ after: 5, limit: 1 }), []);
  assert.deepEqual(await store.list({ before: 1, limit: 1 }), []);
  for (const bad of [{ before: 0 }, { after: "2" }, { limit: -1 }, { before: 3, after: 1 }]) {
    assert.throws(() => store.list(bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(await store.prune(2), true);
  assert.deepEqual(texts(await store.list()), ["四", "五"], "a prune of several lines keeps the newest, as many as the limit");
});

test("lines are edited, removed, pruned and cleared, and every open page hears of it", async (t) => {
  const indexedDB = fakeIndexedDB();
  const first = history(t, indexedDB, "shared-history");
  const second = history(t, indexedDB, "shared-history");
  for (const text of ["一", "二", "三", "四"]) await first.store.add(typed(text), { limit: 100 });
  assert.deepEqual(plain(await second.store.edit(2, " 弐 ")), { text: "弐", at: 1_002, source: "typed", page: "tab", id: 2 });
  assert.deepEqual(plain(await second.store.edit(2, "弐")), { text: "弐", at: 1_002, source: "typed", page: "tab", id: 2 },
    "an unchanged text is no change");
  assert.equal(await second.store.edit(9, "九"), null);
  await assert.rejects(second.store.edit(2, " "), TypeError);
  assert.equal(await second.store.remove(3), true);
  assert.equal(await second.store.remove(3), false);
  assert.deepEqual(texts(await first.store.list()), ["一", "弐", "四"]);
  assert.equal(await first.store.prune(2), true);
  assert.equal(await first.store.prune(2), false);
  assert.deepEqual(texts(await second.store.list()), ["弐", "四"]);
  assert.equal(await second.store.clear(), 2);
  assert.deepEqual(await first.store.list(), []);
  await first.store.add(typed("五"), { limit: 100 });
  assert.deepEqual(texts(await second.store.list()), ["五"], "ids go on after a clear");
  assert.equal((await second.store.list())[0].id, 5);
  // The channel delivers on a later turn, so a page hears another's changes
  // after its own of the same moment.
  await new Promise(resolve => setTimeout(resolve, 50));
  const heard = [["add", 1], ["add", 2], ["add", 3], ["add", 4], ["edit", 2], ["remove", 3], ["prune", 2], ["clear", null],
    ["add", 5]];
  const summary = changes => changes.map(change => [change.type, change.line?.id ?? change.id ?? change.before ?? null])
    .sort((left, right) => heard.findIndex(each => JSON.stringify(each) === JSON.stringify(left))
      - heard.findIndex(each => JSON.stringify(each) === JSON.stringify(right)));
  assert.deepEqual(summary(first.changes), heard);
  assert.deepEqual(summary(second.changes), heard);
  assert.equal(first.changes.find(change => change.type === "edit").line.text, "弐");
});
