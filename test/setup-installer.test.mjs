import assert from "node:assert/strict";
import test from "node:test";
import { RECOMMENDED_DICTIONARIES } from "../extension/recommended-dictionaries.js";
import { SETUP_EVENTS_TARGET, createSetupInstaller, requestedSetupSources } from "../extension/setup-installer.js";

const BUSY = "the dictionary engine is busy mutating";

function harness({ installed = [], statuses = null, imports = {}, recordFailures = 0 } = {}) {
  const log = { dispatched: [], asked: [], recorded: [], broadcast: [] };
  let failingRecords = recordFailures;
  let clock = 1000;
  let statusIndex = 0;
  let ids = 0;
  const releases = new Map();
  const installer = createSetupInstaller({
    now: () => clock,
    randomId: () => `run-${++ids}`,
    async dispatch(message) {
      log.dispatched.push(message);
      if (message.type === "hd_status") {
        const status = statuses === null ? { ok: true, ready: true, loading: false } : statuses[Math.min(statusIndex++, statuses.length - 1)];
        return { type: "hd_status_result", requestId: message.requestId, ...status };
      }
      const behaviour = imports[message.sourceId] ?? { seconds: 2 };
      if (behaviour.hold) await new Promise((resolve) => releases.set(message.sourceId, resolve));
      clock += (behaviour.seconds ?? 2) * 1000;
      if (behaviour.busy && behaviour.busy-- > 0) return { type: "hd_import_result", requestId: message.requestId, ok: false, error: BUSY };
      if (behaviour.error) return { type: "hd_import_result", requestId: message.requestId, ok: false, error: behaviour.error };
      installed.push({ sourceId: message.sourceId });
      return { type: "hd_import_result", requestId: message.requestId, ok: true, report: { success: true } };
    },
    async ask(message) {
      log.asked.push(message);
      return { ok: true, state: { dictionaries: installed.map((entry) => ({ ...entry })) } };
    },
    async notify(message) {
      log.recorded.push(message);
      if (failingRecords > 0) {
        failingRecords -= 1;
        if (failingRecords % 2 === 0) throw new Error("Could not establish connection");
        return undefined;
      }
      return { ok: true };
    },
    broadcast(event) {
      log.broadcast.push(structuredClone(event));
    },
  });
  return { installer, log, releases, tick: (seconds) => { clock += seconds * 1000; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
async function untilFinished(installer) {
  for (let attempt = 0; attempt < 200 && !installer.snapshot().finished; attempt += 1) await settle();
  assert.equal(installer.snapshot().finished, true);
}

test("a run installs requested sources in catalogue order, skips installed ones and continues after a failure", async () => {
  const behaviours = { jmnedict: { error: "could not read JMnedict.zip: HTTP 503", seconds: 1 }, jitendex: { seconds: 3 } };
  const { installer, log } = harness({ installed: [{ sourceId: "bees-ultimate-kanji-dictionary" }], imports: behaviours });
  const first = installer.attach(["jiten", "jitendex", "jmnedict", "bees-ultimate-kanji-dictionary", "unknown"]);
  assert.equal(first.runId, "run-1");
  assert.equal(first.finished, false);
  assert.deepEqual(first.entries.map((entry) => [entry.sourceId, entry.phase]),
    [["jitendex", "waiting"], ["jmnedict", "waiting"], ["bees-ultimate-kanji-dictionary", "waiting"], ["jiten", "waiting"]]);
  // A second attach while running observes the same run and never restarts it.
  assert.equal(installer.attach(["jitendex"]).runId, "run-1");
  await untilFinished(installer);
  const final = installer.snapshot();
  assert.deepEqual(final.entries.map((entry) => [entry.sourceId, entry.phase, entry.seconds, entry.error]), [
    ["jitendex", "installed", 3, null],
    ["jmnedict", "failed", 1, "could not read JMnedict.zip: HTTP 503"],
    ["bees-ultimate-kanji-dictionary", "already-installed", null, null],
    ["jiten", "installed", 2, null],
  ]);
  const imports = log.dispatched.filter((message) => message.type === "hd_import");
  assert.deepEqual(imports.map((message) => [message.sourceId, message.archiveUrl, message.fileName, message.blobUrl]),
    ["jitendex", "jmnedict", "jiten"].map((sourceId) => {
      const entry = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.sourceId === sourceId);
      return [sourceId, entry.downloadUrl, entry.archiveName, undefined];
    }));
  assert.ok(imports.every((message) => message.requestId.startsWith("setup:run-1:import:")));
  // The inventory is rechecked before every import and again after waiting for the idle engine.
  assert.equal(log.asked.length, 7);
  assert.ok(log.dispatched.filter((message) => message.type === "hd_status").length >= 3);
  // One durable record per outcome; the last one also carries the run duration,
  // so outcomes can never be settled with the run accounting still missing.
  assert.deepEqual(log.recorded.map((message) => [message.type, message.runId, Object.keys(message.outcomes ?? {})[0] ?? null, message.runSeconds ?? null]), [
    ["hd_setup_record", "run-1", "jitendex", null],
    ["hd_setup_record", "run-1", "jmnedict", null],
    ["hd_setup_record", "run-1", "bees-ultimate-kanji-dictionary", null],
    ["hd_setup_record", "run-1", "jiten", 6],
  ]);
  assert.deepEqual(log.recorded[1].outcomes.jmnedict, { status: "failed", seconds: 1, error: "could not read JMnedict.zip: HTTP 503" });
  assert.deepEqual(log.recorded[2].outcomes["bees-ultimate-kanji-dictionary"], { status: "already-installed" });
  // Every broadcast names the run and increases its sequence; the last one is the finished snapshot.
  assert.ok(log.broadcast.length >= 8);
  assert.ok(log.broadcast.every((event) => event.target === SETUP_EVENTS_TARGET && event.type === "hd_setup_progress" && event.runId === "run-1"));
  assert.ok(log.broadcast.every((event, index) => index === 0 || event.sequence > log.broadcast[index - 1].sequence));
  assert.equal(log.broadcast.at(-1).finished, true);
  // A finished run lets a new request start a new run for only what it names.
  delete behaviours.jmnedict.error;
  const retry = installer.attach(["jmnedict"]);
  assert.equal(retry.runId, "run-2");
  assert.deepEqual(retry.entries.map((entry) => entry.sourceId), ["jmnedict"]);
  await untilFinished(installer);
  assert.equal(installer.snapshot().entries[0].phase, "installed");
  assert.equal(installer.attach([]).runId, "run-2");
});

test("download and installation phases are mirrored only for this run's own import requests", async () => {
  const { installer, log, releases } = harness({ imports: { jitendex: { hold: true, seconds: 4 } } });
  installer.attach(["jitendex"]);
  for (let attempt = 0; attempt < 100 && !releases.has("jitendex"); attempt += 1) await settle();
  const importRequest = log.dispatched.find((message) => message.type === "hd_import");
  assert.equal(installer.snapshot().entries[0].phase, "downloading");
  installer.progress({ requestId: importRequest.requestId, phase: "downloading", receivedBytes: 1024, totalBytes: 4096 });
  assert.deepEqual(installer.snapshot().entries[0], { sourceId: "jitendex", phase: "downloading", receivedBytes: 1024, totalBytes: 4096, seconds: null, error: null });
  installer.progress({ requestId: importRequest.requestId, phase: "downloading", receivedBytes: 4096, totalBytes: null });
  assert.equal(installer.snapshot().entries[0].totalBytes, null);
  // Other requests, other runs and unknown phases cannot touch the rows.
  const before = installer.snapshot().sequence;
  installer.progress({ requestId: "managed-update-3", phase: "downloading", receivedBytes: 9, totalBytes: 9 });
  installer.progress({ requestId: importRequest.requestId.replace("run-1", "run-0"), phase: "installing" });
  installer.progress({ requestId: importRequest.requestId, phase: "verifying" });
  assert.equal(installer.snapshot().sequence, before);
  installer.progress({ requestId: importRequest.requestId, phase: "installing", receivedBytes: 4096, totalBytes: 4096 });
  assert.equal(installer.snapshot().entries[0].phase, "installing");
  releases.get("jitendex")();
  await untilFinished(installer);
  assert.deepEqual(installer.snapshot().entries[0], { sourceId: "jitendex", phase: "installed", receivedBytes: 4096, totalBytes: null, seconds: 4, error: null });
  // Late progress for a settled entry is ignored.
  installer.progress({ requestId: importRequest.requestId, phase: "downloading", receivedBytes: 1, totalBytes: 1 });
  assert.equal(installer.snapshot().entries[0].receivedBytes, 4096);
});

test("a source committed elsewhere while the installer waited is settled as already installed, not reimported", async () => {
  const installed = [];
  const statuses = [{ ok: true, ready: true, loading: true }, { ok: true, ready: true, loading: false }];
  const { installer, log } = harness({ installed, statuses });
  installer.attach(["jiten"]);
  // Settings commits Jiten while the engine reports loading.
  for (let attempt = 0; attempt < 100 && log.dispatched.filter((message) => message.type === "hd_status").length < 1; attempt += 1) await settle();
  installed.push({ sourceId: "jiten" });
  await untilFinished(installer);
  assert.equal(installer.snapshot().entries[0].phase, "already-installed");
  assert.equal(log.dispatched.filter((message) => message.type === "hd_import").length, 0);
  assert.deepEqual(log.recorded[0].outcomes.jiten, { status: "already-installed" });
});

test("the installer waits for a ready, idle engine and queues behind another mutation without failing the row", async () => {
  const statuses = [
    { ok: true, ready: false, loading: true },
    { ok: true, ready: true, loading: true },
    { ok: true, ready: true, loading: false },
    { ok: true, ready: true, loading: false },
  ];
  const { installer, log } = harness({ statuses, imports: { jiten: { busy: 1, seconds: 1 } } });
  installer.attach(["jiten"]);
  await untilFinished(installer);
  const imports = log.dispatched.filter((message) => message.type === "hd_import");
  assert.equal(imports.length, 2);
  assert.equal(installer.snapshot().entries[0].phase, "installed");
  assert.equal(log.recorded[0].outcomes.jiten.status, "installed");
  assert.ok(log.dispatched.filter((message) => message.type === "hd_status").length >= 4);
});

test("an outcome record is resent until the worker answers, and the entry settles only then", async () => {
  const { installer, log } = harness({ recordFailures: 2, imports: { jiten: { seconds: 1 } } });
  installer.attach(["jiten"]);
  // Two failed attempts (a lost reply and a thrown send) keep the entry unsettled.
  for (let attempt = 0; attempt < 100 && log.recorded.length < 2; attempt += 1) await settle();
  assert.equal(log.recorded.length, 2);
  assert.equal(installer.snapshot().entries[0].phase, "downloading");
  assert.equal(log.broadcast.some((event) => event.entries[0].phase === "installed"), false);
  await untilFinished(installer);
  const outcomeRecords = log.recorded.filter((message) => message.outcomes?.jiten);
  assert.equal(outcomeRecords.length, 3);
  assert.ok(outcomeRecords.every((message) => message.runId === "run-1" && message.outcomes.jiten.status === "installed"));
  assert.equal(installer.snapshot().entries[0].phase, "installed");
  assert.equal(log.recorded.at(-1).runSeconds > 0, true);
});

test("an unavailable engine or inventory fails the row with its reason and the run still finishes", async () => {
  const { installer, log } = harness({ statuses: [{ ok: false, error: "the Hoshidicts engine stopped" }] });
  installer.attach(["jitendex", "jiten"]);
  await untilFinished(installer);
  assert.deepEqual(installer.snapshot().entries.map((entry) => [entry.phase, entry.error]),
    [["failed", "the Hoshidicts engine stopped"], ["failed", "the Hoshidicts engine stopped"]]);
  assert.equal(log.recorded.at(-1).runSeconds, 0);
  assert.throws(() => requestedSetupSources("jitendex"), TypeError);
  assert.throws(() => requestedSetupSources([1]), TypeError);
  assert.deepEqual(requestedSetupSources(["jiten", "jiten", "nope"]).map((entry) => entry.sourceId), ["jiten"]);
});
