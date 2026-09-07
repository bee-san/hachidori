// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';

// Browser-scoped CPU accounting plus summed Linux process RSS. RSS includes
// shared pages in each process; it is not unique physical memory or WASM heap.
export async function captureResourceMonitor(browser) {
  const client = await browser.target().createCDPSession();
  const samples = [];
  const lastCpu = new Map();
  let cpuSeconds = 0, phase = 'capture-off', pending = Promise.resolve();
  async function sample() {
    const { processInfo } = await client.send('SystemInfo.getProcessInfo');
    let rssBytes = 0;
    for (const process of processInfo) {
      cpuSeconds += Math.max(0, process.cpuTime - (lastCpu.get(process.id) ?? process.cpuTime));
      lastCpu.set(process.id, process.cpuTime);
      try {
        const status = readFileSync(`/proc/${process.id}/status`, 'utf8');
        const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu);
        if (rss) rssBytes += Number(rss[1]) * 1024;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
      }
    }
    samples.push({ at: performance.now(), phase, cpuSeconds, rssBytes, processes: processInfo.length });
  }
  await sample();
  const timer = setInterval(() => { pending = pending.then(sample); }, 1000);
  return {
    phase(value) { phase = value; },
    async stop() {
      clearInterval(timer);
      await pending;
      await sample();
      await client.detach();
      const phases = {};
      for (const name of new Set(samples.map(value => value.phase))) {
        const rows = samples.filter(value => value.phase === name);
        const first = rows[0], last = rows.at(-1);
        // Repeated soak phases are discontinuous. Sum only adjacent intervals
        // within this phase, excluding both other modes and phase transitions.
        let seconds = 0, measuredCpuSeconds = 0;
        for (let index = 1; index < samples.length; index += 1) {
          const before = samples[index - 1], after = samples[index];
          if (before.phase !== name || after.phase !== name) continue;
          seconds += (after.at - before.at) / 1000;
          measuredCpuSeconds += after.cpuSeconds - before.cpuSeconds;
        }
        phases[name] = { samples: rows.length, seconds,
          cpuPercentOfOneCore: seconds > 0 ? measuredCpuSeconds / seconds * 100 : null,
          initialRssMiB: first.rssBytes / 1024 ** 2, finalRssMiB: last.rssBytes / 1024 ** 2,
          peakRssMiB: Math.max(...rows.map(value => value.rssBytes)) / 1024 ** 2 };
      }
      return { phases, samples };
    },
  };
}
