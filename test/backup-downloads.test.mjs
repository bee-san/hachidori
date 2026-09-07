import assert from "node:assert/strict";
import test from "node:test";
import { createBackupDownloads } from "../extension/backup-downloads.js";

function fixture(state = "in_progress") {
  let saved = {}, downloadState = state;
  const calls = [];
  const chrome = {
    storage: { session: {
      async get() { return structuredClone(saved); },
      async set(value) { saved = structuredClone(value); },
    } },
    downloads: {
      async download(options) { calls.push(options); return 7; },
      async search() { return [{ state: downloadState }]; },
    },
  };
  const relay = async message => {
    calls.push(message.type);
    return { ok: true, ...(message.type === "hd_backup_export" ? { blobUrl: "blob:owned-backup" } : {}) };
  };
  return { chrome, relay, calls, service: createBackupDownloads(chrome, relay),
    finish() { downloadState = "complete"; }, saved: () => saved };
}

test("backup download retains its URL through service-worker restart and releases exactly once", async () => {
  const f = fixture();
  assert.equal((await f.service.download()).downloadId, 7);
  assert.deepEqual(f.saved(), { backupDownloads: { 7: "blob:owned-backup" } });
  assert.equal(f.calls[1].saveAs, true);
  assert.equal(f.calls.includes("hd_backup_release"), false);
  f.finish();
  const restarted = createBackupDownloads(f.chrome, f.relay);
  await Promise.all([restarted.changed(7), restarted.changed(7)]);
  assert.deepEqual(f.saved(), { backupDownloads: {} });
  assert.equal(f.calls.filter(call => call === "hd_backup_release").length, 1);
});

test("a download completed before tracking and a cancelled save both release the owned URL", async () => {
  const complete = fixture("complete");
  await complete.service.download();
  assert.deepEqual(complete.saved(), { backupDownloads: {} });
  assert.equal(complete.calls.filter(call => call === "hd_backup_release").length, 1);
  const cancelled = fixture();
  cancelled.chrome.downloads.download = async () => { throw new Error("User cancelled"); };
  await assert.rejects(cancelled.service.download(), /cancelled/u);
  assert.equal(cancelled.calls.filter(call => call === "hd_backup_release").length, 1);
});

test("a tracking failure does not falsely report an already-started download as failed", async () => {
  const f = fixture();
  f.chrome.storage.session.set = async () => { throw new Error("session unavailable"); };
  const reply = await f.service.download();
  assert.equal(reply.downloadId, 7);
  assert.match(reply.warning, /Download started/u);
  assert.equal(f.calls.includes("hd_backup_release"), false, "do not revoke a download still in progress");
});
