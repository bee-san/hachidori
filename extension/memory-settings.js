// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Advanced → Memory, and the "In memory" line of each Library row's
// Details. Both read the engine's hd_memory reply (docs/memory.md); nothing
// polls: the page asks on a section visit, a dictionary-state change, or a new
// engine generation, and a busy or unreachable engine renders a dash.
import { formatBytes } from "./dictionary-progress.js";

const UNAVAILABLE = "\u2014";

export function createMemorySettings({ document, readMemory, numberFormat = new Intl.NumberFormat() }) {
  const total = document.getElementById("memory-total");
  let latest = null;
  let inFlight = null;

  function renderTotal() {
    if (latest === null) {
      total.textContent = `Engine memory: ${UNAVAILABLE}`;
      return;
    }
    const count = latest.dictionaries.length;
    const subject = count === 1 ? "1 dictionary" : `${numberFormat.format(count)} dictionaries`;
    total.textContent = `Engine memory: ${formatBytes(latest.heapBytes)} across ${subject}`;
  }

  function renderRow(row) {
    const target = row.querySelector(".dict-memory");
    if (!target) return;
    const entry = latest?.dictionaries.find((item) => item.id === row.dataset.dictionaryId);
    const share = typeof entry?.bytes === "number" ? `\u2248 ${formatBytes(entry.bytes)}` : UNAVAILABLE;
    // A paged package keeps only its index in memory: every package in Low
    // memory mode, and one that did not fit otherwise.
    target.textContent = `In memory: ${share}${entry?.paged === true ? " (entries read from disk)" : ""}`;
  }

  function renderRows() {
    for (const row of document.querySelectorAll(".dict-row[data-dictionary-id]")) renderRow(row);
  }

  async function refresh() {
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      let reply = null;
      try {
        reply = await readMemory();
      } catch {
        reply = null;
      }
      latest = reply?.ok === true && Array.isArray(reply.dictionaries) && Number.isFinite(reply.heapBytes) ? reply : null;
      renderTotal();
      renderRows();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  renderTotal();
  return { refresh, renderRow, renderRows };
}
