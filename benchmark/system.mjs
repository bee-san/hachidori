// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, relative } from "node:path";

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeAllSync(descriptor, input, writer = writeSync) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let offset = 0;
  while (offset < buffer.length) {
    const written = writer(descriptor, buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(`write made no progress at byte ${offset}`);
    }
    offset += written;
  }
  return offset;
}

export function persistThenCleanup({ persist, cleanup = null, onCleanupError = () => {} }) {
  persist();
  if (!cleanup) return true;
  try {
    cleanup();
    return true;
  } catch (error) {
    try {
      onCleanupError(error);
    } catch {}
    return false;
  }
}

export function appendJsonlDurable(path, value) {
  const created = !existsSync(path);
  const descriptor = openSync(path, "a", 0o600);
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (serialized.includes("\n")) throw new Error("JSONL record must occupy one line");
    writeAllSync(descriptor, Buffer.from(`${serialized}\n`));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (created) fsyncDirectory(dirname(path));
}

export function readJsonlRecoveringTail(path, { onTailRecovered } = {}) {
  if (!existsSync(path)) return [];
  let bytes = readFileSync(path);
  const finalNewline = bytes.lastIndexOf(0x0a);
  if (finalNewline !== bytes.length - 1) {
    const discardedBytes = bytes.length - (finalNewline + 1);
    const descriptor = openSync(path, "r+");
    try {
      ftruncateSync(descriptor, finalNewline + 1);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    bytes = bytes.subarray(0, finalNewline + 1);
    onTailRecovered?.({ path, discardedBytes });
  }
  const records = [];
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`complete JSONL bytes are not valid UTF-8: ${error.message}`, { cause: error });
  }
  const lines = decoded.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "" && index === lines.length - 1) continue;
    if (lines[index] === "") throw new Error(`blank complete JSONL record ${index + 1}`);
    try {
      records.push(JSON.parse(lines[index]));
    } catch (error) {
      throw new Error(`invalid complete JSONL record ${index + 1}: ${error.message}`, { cause: error });
    }
  }
  return records;
}

export function acquireFileLock(path, owner) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`benchmark output is already locked: ${path}`);
    throw error;
  }
  try {
    writeAllSync(descriptor, Buffer.from(`${JSON.stringify(owner)}\n`));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(path); } catch {}
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  };
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function stableFileStat(path) {
  const before = statSync(path, { bigint: true });
  if (!before.isFile()) throw new Error(`${path} is not a regular file`);
  const sha256 = sha256File(path);
  const after = statSync(path, { bigint: true });
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    if (before[key] !== after[key]) throw new Error(`${path} changed while its identity was computed`);
  }
  return { path, bytes: Number(after.size), sha256 };
}

export function assertFileIdentity(path, expected) {
  const observed = stableFileStat(path);
  if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) {
    throw new Error(
      `${path} changed identity: expected ${expected.bytes} bytes/${expected.sha256}, `
      + `got ${observed.bytes} bytes/${observed.sha256}`,
    );
  }
  return observed;
}

export function createContentAddressedSnapshot(source, destination) {
  const sourceIdentity = stableFileStat(source);
  mkdirSync(destination, { recursive: true });
  const snapshotPath = join(destination, `${sourceIdentity.sha256}.zip`);
  if (!existsSync(snapshotPath)) {
    const temporary = `${snapshotPath}.tmp-${process.pid}`;
    try {
      copyFileSync(source, temporary);
      assertFileIdentity(temporary, sourceIdentity);
      const descriptor = openSync(temporary, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(temporary, 0o444);
      renameSync(temporary, snapshotPath);
      fsyncDirectory(destination);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  assertFileIdentity(snapshotPath, sourceIdentity);
  assertFileIdentity(source, sourceIdentity);
  return { ...sourceIdentity, sourcePath: source, path: snapshotPath };
}

export function directoryContentSha256(root, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const files = [];
  const visit = (path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    const name = relative(root, path).split("/")[0];
    if (name && excluded.has(name)) return;
    if (info.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (info.isFile()) {
      files.push(path);
    }
  };
  visit(root);
  const hash = createHash("sha256");
  for (const path of files) {
    const name = relative(root, path).replaceAll("\\", "/");
    hash.update(`file\u0000${name}\u0000${sha256File(path)}\u0000`);
  }
  return hash.digest("hex");
}

export function treeUsage(root) {
  let logicalBytes = 0;
  let allocatedBytes = 0;
  let fileCount = 0;

  const visit = (path) => {
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    if (!info.isFile()) return;
    logicalBytes += info.size;
    allocatedBytes += Number.isFinite(info.blocks) ? info.blocks * 512 : info.size;
    fileCount += 1;
  };

  visit(root);
  return { logicalBytes, allocatedBytes, fileCount };
}

function readTextIfPresent(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export function hostSnapshot() {
  const load = readTextIfPresent("/proc/loadavg")?.split(/\s+/).slice(0, 3).map(Number) ?? null;
  const pressure = {};
  for (const resource of ["cpu", "memory", "io"]) {
    const value = readTextIfPresent(`/proc/pressure/${resource}`);
    if (value !== null) pressure[resource] = value;
  }
  const models = [...new Set(cpus().map((cpu) => cpu.model))];
  return {
    utc: new Date().toISOString(),
    hostname: hostname(),
    platform: platform(),
    release: release(),
    cpuCount: cpus().length,
    cpuModels: models,
    loadAverage: load,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    pressure,
  };
}

function readProcRows() {
  const rows = new Map();
  if (!existsSync("/proc")) return rows;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const fields = stat.slice(closeParen + 2).split(" ");
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
      rows.set(Number(name), {
        parent: Number(fields[1]),
        cpuTicks: Number(fields[11]) + Number(fields[12]),
        startTicks: Number(fields[19]),
        rssBytes: rssKiB * 1024,
      });
    } catch {
      // A process can disappear between listing /proc and reading it.
    }
  }
  return rows;
}

function sampleProcessTree(rootPid, known) {
  const rows = readProcRows();
  const ids = new Set([Number(rootPid)]);
  for (const [pid, startTicks] of known) {
    if (rows.get(pid)?.startTicks === startTicks) ids.add(pid);
  }
  for (;;) {
    const before = ids.size;
    for (const [pid, row] of rows) {
      if (ids.has(row.parent)) ids.add(pid);
    }
    if (ids.size === before) break;
  }
  let rssBytes = 0;
  let cpuTicks = 0;
  const identities = [];
  for (const pid of ids) {
    const row = rows.get(pid);
    if (!row) continue;
    known.set(pid, row.startTicks);
    rssBytes += row.rssBytes;
    cpuTicks += row.cpuTicks;
    identities.push({ pid, startTicks: row.startTicks, cpuTicks: row.cpuTicks, rssBytes: row.rssBytes });
  }
  return { rssBytes, cpuTicks, processCount: identities.length, identities };
}

export function processTreeSample(rootPid) {
  const { identities: _, ...sample } = sampleProcessTree(rootPid, new Map());
  return sample;
}

export function startProcessSampler(rootPid, intervalMs = 50, { excludeInitialTree = false } = {}) {
  let peakRssBytes = 0;
  let peakProcessCount = 0;
  let samples = 0;
  const known = new Map();
  const excludedIdentities = new Set();
  const baselineTicksByIdentity = new Map();
  const cpuDeltaTicksByIdentity = new Map();
  let initialCapture = true;
  const capture = () => {
    const sample = sampleProcessTree(rootPid, known);
    if (initialCapture && excludeInitialTree) {
      for (const row of sample.identities) excludedIdentities.add(`${row.pid}:${row.startTicks}`);
    }
    const identities = sample.identities.filter((row) =>
      !excludedIdentities.has(`${row.pid}:${row.startTicks}`));
    const rssBytes = identities.reduce((sum, row) => sum + row.rssBytes, 0);
    peakRssBytes = Math.max(peakRssBytes, rssBytes);
    peakProcessCount = Math.max(peakProcessCount, identities.length);
    for (const row of identities) {
      const identity = `${row.pid}:${row.startTicks}`;
      if (!baselineTicksByIdentity.has(identity)) {
        baselineTicksByIdentity.set(identity, initialCapture && !excludeInitialTree ? row.cpuTicks : 0);
      }
      const delta = Math.max(0, row.cpuTicks - baselineTicksByIdentity.get(identity));
      cpuDeltaTicksByIdentity.set(identity, Math.max(cpuDeltaTicksByIdentity.get(identity) ?? 0, delta));
    }
    initialCapture = false;
    samples += 1;
  };
  capture();
  const timer = setInterval(capture, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      capture();
      return {
        peakRssBytes,
        peakProcessCount,
        processTreeCpuTicks: [...cpuDeltaTicksByIdentity.values()].reduce((sum, ticks) => sum + ticks, 0),
        sampleIntervalMs: intervalMs,
        samples,
      };
    },
  };
}

export function startDescendantProcessSampler(rootPid, intervalMs = 50) {
  return startProcessSampler(rootPid, intervalMs, { excludeInitialTree: true });
}
