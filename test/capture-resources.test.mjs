// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureResourceMonitor } from './capture-resources.mjs';

async function fixture(t, snapshots) {
  let tick, index = 0, detachCount = 0;
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const browser = { target: () => ({ createCDPSession: async () => ({
    async send(method) {
      assert.equal(method, 'SystemInfo.getProcessInfo');
      const next = snapshots[index++];
      if (next instanceof Error) throw next;
      assert.ok(next, 'the monitor requested an unexpected extra sample');
      return { processInfo: next };
    },
    async detach() { detachCount += 1; },
  }) }) };
  return {
    browser,
    monitor: await captureResourceMonitor(browser),
    async tick() { tick(); await new Promise(resolve => setImmediate(resolve)); },
    detachCount: () => detachCount,
  };
}

const existing = cpuTime => ({ id: process.pid, cpuTime });
// Deliberately absent from /proc: RSS collection must tolerate an exited process
// while accounting for the CPU counter returned in the browser's last snapshot.
const newcomer = cpuTime => ({ id: 99_999_999, cpuTime });

test('resource CPU accounting includes newborn processes and forgets vanished PID baselines', async t => {
  const f = await fixture(t, [
    [existing(100)],
    [existing(100), newcomer(2)],
    [existing(100)],
    [existing(100), newcomer(1)],
    [existing(100), newcomer(2)],
  ]);
  await f.tick();
  await f.tick();
  await f.tick();
  const report = await f.monitor.stop();
  assert.deepEqual(report.samples.map(sample => sample.cpuSeconds), [0, 2, 2, 3, 4]);
  assert.equal(f.detachCount(), 1);
  assert.match(report.scope, /synthetic fixture/);
  assert.match(report.rssMeasurement, /duplicated shared pages/);
  assert.ok(report.phases['capture-off'].sampledPeakRssMiB > 0);
});

test('awaited phase boundaries measure an export shorter than the periodic sampling interval', async t => {
  const f = await fixture(t, [100, 101, 102, 104, 105, 106].map(cpu => [existing(cpu)]));
  await f.monitor.phase('export');
  await f.monitor.phase('capture-off');
  const report = await f.monitor.stop();
  assert.equal(report.phases.export.samples, 2);
  assert.ok(report.phases.export.seconds > 0);
  assert.ok(Math.abs(report.phases.export.cpuPercentOfOneCore * report.phases.export.seconds / 100 - 2) < 1e-9);
  assert.equal(f.detachCount(), 1);
});

test('a periodic sample failure is retained and stop always detaches the browser client', async t => {
  const failure = new Error('browser accounting became unavailable');
  const f = await fixture(t, [[existing(100)], failure]);
  await f.tick();
  await assert.rejects(f.monitor.stop(), error => error === failure);
  await assert.rejects(f.monitor.stop(), error => error === failure);
  assert.equal(f.detachCount(), 1);
});

test('a failed first sample also detaches its browser client', async () => {
  let detached = false;
  const failure = new Error('initial accounting unavailable');
  await assert.rejects(captureResourceMonitor({ target: () => ({ createCDPSession: async () => ({
    async send() { throw failure; },
    async detach() { detached = true; },
  }) }) }), error => error === failure);
  assert.equal(detached, true);
});
