// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';

// Browser-scoped CPU accounting plus summed Linux process RSS. RSS includes
// shared pages in each process; it is not unique physical memory or WASM heap.
export async function captureResourceMonitor(browser) {
  const client = await browser.target().createCDPSession();
  const samples = [];
  const lastCpu = new Map();
  let cpuSeconds = 0, phase = 'capture-off', pending = Promise.resolve();
  let timer = null, failure = null, stopping = null;
  async function sample() {
    const { processInfo } = await client.send('SystemInfo.getProcessInfo');
    let rssBytes = 0;
    const present = new Set(processInfo.map(process => process.id));
    for (const id of lastCpu.keys()) if (!present.has(id)) lastCpu.delete(id);
    for (const process of processInfo) {
      // Only the initial browser snapshot establishes a baseline. A process
      // first observed later has spent all of its CPU time during this run.
      const previous = lastCpu.get(process.id) ?? (samples.length === 0 ? process.cpuTime : 0);
      cpuSeconds += Math.max(0, process.cpuTime - previous);
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
  function enqueue(operation) {
    const result = pending.then(() => {
      if (failure) throw failure;
      return operation();
    });
    pending = result.catch(error => {
      failure ??= error;
      clearInterval(timer);
    });
    return result;
  }
  try { await sample(); }
  catch (error) {
    await client.detach().catch(() => {});
    throw error;
  }
  timer = setInterval(() => { void enqueue(sample); }, 1000);
  return {
    phase(value) {
      if (stopping) return Promise.reject(new Error('The capture resource monitor has stopped.'));
      return enqueue(async () => {
        if (phase === value) return;
        await sample();
        phase = value;
        await sample();
      });
    },
    stop() {
      if (stopping) return stopping;
      clearInterval(timer);
      stopping = (async () => {
        try {
          await pending;
          if (failure) throw failure;
          await sample();
        } finally {
          await client.detach().catch(() => {});
        }
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
            sampledPeakRssMiB: Math.max(...rows.map(value => value.rssBytes)) / 1024 ** 2 };
        }
        return {
          scope: 'Entire Chrome browser, including the extension and synthetic fixture tabs.',
          cpuMeasurement: 'Observed process CPU time; processes that start and exit between samples are not measured.',
          rssMeasurement: 'Sampled sum of process RSS, including duplicated shared pages; not unique memory or WASM heap.',
          phases, samples,
        };
      })();
      return stopping;
    },
  };
}
