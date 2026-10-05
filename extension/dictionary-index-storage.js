// SPDX-License-Identifier: GPL-3.0-or-later

// A residency budget, never a limit on the packages or results we load.
// Chosen from the OPFS comparisons in docs/benchmarks/index-residency.md.
export const RESIDENT_HASH_BUDGET_BYTES = 32 * 1024 * 1024;

export function planIndexStorage(dictionaries, storage, hashBytes, budget = RESIDENT_HASH_BUDGET_BYTES) {
  const paged = new Set();
  if (storage === "resident") return paged;
  const unique = new Map(dictionaries.filter(item => item.enabled !== false).map(item => [item.path, item]));
  const candidates = [...unique.values()].map(item => ({ ...item, bytes: hashBytes(item.path) }));
  candidates.sort((a, b) => a.bytes - b.bytes || String(a.id).localeCompare(String(b.id), "en"));
  let remaining = storage === "paged" ? 0 : budget;
  for (const item of candidates) {
    if (storage !== "paged" && item.bytes <= remaining) remaining -= item.bytes;
    else paged.add(item.path);
  }
  return paged;
}

// Only threaded OPFS is measured. Automatic starts with Low memory mode;
// the other runtimes retain resident indexes, including explicit requests.
export function actualIndexPolicy(requested, storageBackend, lowMemory) {
  if (storageBackend !== "opfs") return "resident";
  return requested === "auto" ? (lowMemory ? "budget" : "resident") : requested;
}
