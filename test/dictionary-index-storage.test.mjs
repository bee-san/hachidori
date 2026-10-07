import assert from "node:assert/strict";
import test from "node:test";
import { actualIndexPolicy, planIndexStorage, residentHashBudgetBytes } from "../extension/dictionary-index-storage.js";

test("the shared budget pages medium indexes without excluding packages or counting kinds twice", () => {
  const entries = ["b", "a", "c"].map(id => ({ id, path: `/dicts/${id}` }));
  const sizes = path => path.endsWith("c") ? 5 : 8;
  assert.deepEqual([...planIndexStorage([...entries, entries[1]], "budget", sizes, 16)], ["/dicts/b"]);
  assert.deepEqual([...planIndexStorage([...entries].reverse(), "budget", sizes, 16)], ["/dicts/b"]);
  assert.deepEqual([...planIndexStorage(entries, "resident", sizes, 0)], []);
  assert.equal(planIndexStorage(entries, "paged", sizes).size, 3);
  assert.deepEqual([...planIndexStorage(entries.map(item => ({ ...item, enabled: false })), "budget", sizes)], []);
});

test("Automatic budgets OPFS hashes by default while explicit policies and other backends remain independent", () => {
  assert.equal(actualIndexPolicy("auto", "opfs", true), "budget");
  assert.equal(actualIndexPolicy("auto", "opfs", false), "budget");
  assert.equal(actualIndexPolicy("auto", "opfs", false, false), "resident");
  assert.equal(actualIndexPolicy("auto", "opfs", true, false), "budget");
  assert.equal(actualIndexPolicy("paged", "idbfs", true), "resident");
  assert.equal(actualIndexPolicy("auto", "idbfs", false), "resident");
  assert.equal(actualIndexPolicy("resident", "opfs", true), "resident");
  assert.equal(actualIndexPolicy("resident", "opfs", false), "resident");
  assert.equal(actualIndexPolicy("paged", "opfs", false), "paged");
});

test("normal mode has exactly 65 MiB for resident hashes and Low memory mode retains 32 MiB", () => {
  const mib = 1024 * 1024;
  assert.equal(residentHashBudgetBytes(false), 65 * mib);
  assert.equal(residentHashBudgetBytes(true), 32 * mib);
  const entries = [20, 30, 40].map((size, i) => ({ id: String(i), path: `/dicts/${size}` }));
  const size = path => Number(path.split("/").at(-1)) * mib;
  assert.deepEqual([...planIndexStorage(entries, "budget", size, residentHashBudgetBytes(false))], ["/dicts/40"]);
  assert.deepEqual([...planIndexStorage(entries, "budget", size, residentHashBudgetBytes(true))], ["/dicts/30", "/dicts/40"]);
  assert.equal(planIndexStorage([{ id: "edge", path: "/dicts/65" }], "budget", size, residentHashBudgetBytes(false)).size, 0);
});
