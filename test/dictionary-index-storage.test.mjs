import assert from "node:assert/strict";
import test from "node:test";
import { actualIndexPolicy, planIndexStorage } from "../extension/dictionary-index-storage.js";

test("the shared budget pages medium indexes without excluding packages or counting kinds twice", () => {
  const entries = ["b", "a", "c"].map(id => ({ id, path: `/dicts/${id}` }));
  const sizes = path => path.endsWith("c") ? 5 : 8;
  assert.deepEqual([...planIndexStorage([...entries, entries[1]], "budget", sizes, 16)], ["b"]);
  assert.deepEqual([...planIndexStorage([...entries].reverse(), "budget", sizes, 16)], ["b"]);
  assert.deepEqual([...planIndexStorage(entries, "resident", sizes, 0)], []);
  assert.equal(planIndexStorage(entries, "paged", sizes).size, 3);
  assert.deepEqual([...planIndexStorage(entries.map(item => ({ ...item, enabled: false })), "budget", sizes)], []);
});

test("Automatic only changes index residency on low-memory direct OPFS", () => {
  assert.equal(actualIndexPolicy("auto", "opfs", true), "budget");
  assert.equal(actualIndexPolicy("auto", "opfs", false), "resident");
  assert.equal(actualIndexPolicy("paged", "idbfs", true), "resident");
  assert.equal(actualIndexPolicy("resident", "opfs", true), "resident");
});
