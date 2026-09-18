import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createBackupSettingsController } from "../extension/backup-settings.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { chromeDownloads = true, automaticReply = null } = {}) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"));
  const { window } = dom;
  const sent = [], statuses = [], revoked = [], tracked = [], cancelled = [], intervals = [], clearedIntervals = [];
  let blocked = false, downloads = 0;
  window.URL.createObjectURL = () => "blob:selected-backup";
  window.URL.revokeObjectURL = url => revoked.push(url);
  window.crypto.randomUUID = () => "prepared-token";
  window.setInterval = callback => {
    const id = intervals.length + 1;
    intervals.push({ id, callback });
    return id;
  };
  window.clearInterval = id => { clearedIntervals.push(id); };
  const el = id => window.document.getElementById(id);
  const controller = createBackupSettingsController({ document: window.document,
    send: (type, fields) => new Promise(resolve => sent.push({ type, ...fields, resolve })),
    download: chromeDownloads ? async () => { downloads += 1; return { ok: true, downloadId: 7 }; } : null,
    listAutomatic: automaticReply === null ? null : async () => ({
      ok: true,
      ...(typeof automaticReply === "function" ? await automaticReply() : automaticReply),
    }),
    trackPreparation: (token, active) => tracked.push({ token, active }),
    cancelPreparation: token => cancelled.push(token),
    checkReady() { if (blocked) throw new Error("Save your changes first"); },
    setBusy() {}, status: (...args) => statuses.push(args),
    refresh: async () => { throw new Error("refresh failed after commit"); },
  });
  t.after(() => window.close());
  async function prepare(beforeReply = () => {}) {
    Object.defineProperty(el("backup-file"), "files", { configurable: true,
      value: [new window.File(["backup"], "my-backup.zip")] });
    el("backup-file").dispatchEvent(new window.Event("change"));
    await tick();
    const request = sent.at(-1);
    assert.equal(request.type, "hd_backup_prepare");
    beforeReply();
    request.resolve({ ok: true, token: "prepared-token", createdAt: "2026-09-07T00:00:00.000Z",
      dictionaries: [{ title: "<b>private dictionary</b>", enabled: false }], customEntryCount: 2 });
    await tick();
  }
  return { el, window, controller, sent, statuses, revoked, tracked, cancelled, intervals, clearedIntervals,
    prepare, block() { blocked = true; },
    get downloads() { return downloads; } };
}

test("automatic backups show actual ages, preserve an older fallback and require restore confirmation", async t => {
  const now = Date.now();
  const f = fixture(t, { automaticReply: {
    corruptCount: 1,
    backups: [
      { id: "recent", createdAt: new Date(now - 3 * 60 * 60_000).toISOString(),
        dictionaries: [{ title: "<b>recent</b>", enabled: true }], customEntryCount: 2 },
      { id: "older", createdAt: new Date(now - 24 * 60 * 60_000).toISOString(),
        dictionaries: [{ title: "older", enabled: false }], customEntryCount: 1 },
    ],
  } });
  await tick();
  const buttons = [...f.el("automatic-backup-list").querySelectorAll("button")];
  assert.equal(buttons.length, 2);
  assert.match(buttons[0].textContent, /3 hours ago/u);
  assert.match(buttons[1].textContent, /1 day ago/u);
  assert.match(f.el("automatic-backup-status").textContent, /damaged.*valid older/u);
  buttons[1].click();
  await tick();
  assert.equal(f.sent[0].type, "hd_backup_auto_prepare");
  assert.equal(f.sent[0].id, "older");
  f.sent[0].resolve({ ok: true, token: "prepared-token", createdAt: new Date(now - 24 * 60 * 60_000).toISOString(),
    dictionaries: [{ title: "<b>older</b>", enabled: false }], customEntryCount: 1 });
  await tick();
  assert.equal(f.el("backup-dictionaries").querySelector("b"), null);
  assert.match(f.el("backup-file-name").textContent, /Automatic backup from 1 day ago/u);
  assert.equal(f.el("backup-restore").disabled, true);
  f.el("backup-restore").click();
  assert.equal(f.sent.length, 1);
  f.el("backup-confirm").checked = true;
  f.el("backup-confirm").dispatchEvent(new f.window.Event("change"));
  f.el("backup-restore").click();
  assert.equal(f.sent[1].type, "hd_backup_restore");
  f.sent[1].resolve({ ok: true, restored: true });
  await tick();
});

test("automatic backup refresh ignores a stale pre-commit reply and resumes after bfcache restoration", async t => {
  const pending = [];
  const f = fixture(t, { automaticReply: () => new Promise(resolve => pending.push(resolve)) });
  await tick();
  assert.equal(pending.length, 1);
  void f.controller.refreshAutomaticBackups();
  await tick();
  assert.equal(pending.length, 2);
  const backup = id => ({
    id,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    dictionaries: [],
    customEntryCount: 0,
  });
  pending[1]({ backups: [backup("committed")], corruptCount: 0 });
  await tick();
  pending[0]({ backups: [], corruptCount: 0 });
  await tick();
  assert.equal(f.el("automatic-backup-list").children.length, 1);
  assert.equal(f.el("automatic-backup-list").firstElementChild.dataset.backupId, "committed");

  f.window.dispatchEvent(new f.window.Event("pagehide"));
  assert.deepEqual(f.clearedIntervals, [1]);
  const pageshow = new f.window.Event("pageshow");
  Object.defineProperty(pageshow, "persisted", { value: true });
  f.window.dispatchEvent(pageshow);
  await tick();
  assert.equal(pending.length, 3);
  assert.equal(f.intervals.length, 2);
  pending[2]({ backups: [backup("restored")], corruptCount: 0 });
  await tick();
  assert.equal(f.el("automatic-backup-list").firstElementChild.dataset.backupId, "restored");
});

test("backup Settings previews safe text and requires explicit confirmation for one restore", async t => {
  const f = fixture(t);
  await f.prepare();
  assert.deepEqual(f.revoked, ["blob:selected-backup"]);
  assert.equal(f.el("backup-preview").hidden, false);
  assert.equal(f.el("backup-dictionaries").querySelector("b"), null);
  assert.equal(f.el("backup-restore").disabled, true);
  f.el("backup-restore").click();
  assert.equal(f.sent.length, 1);
  f.el("backup-confirm").checked = true;
  f.el("backup-confirm").dispatchEvent(new f.window.Event("change"));
  f.el("backup-restore").click();
  f.el("backup-restore").click();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].token, "prepared-token");
  assert.deepEqual(f.tracked, [
    { token: "prepared-token", active: true },
    { token: "prepared-token", active: false },
  ]);
  f.sent[1].resolve({ ok: true, restored: true });
  await tick();
  assert.equal(f.el("backup-preview").hidden, true);
  assert.match(f.statuses.at(-1)[0], /Restored successfully/u);
  assert.equal(f.el("backup-restore").disabled, true, "refresh failure must not invite a repeated destructive restore");
});

test("cancelling a prepared restore remains possible with unrelated unsaved edits", async t => {
  const f = fixture(t);
  await f.prepare();
  f.block();
  f.el("backup-cancel").click();
  assert.equal(f.sent.at(-1).type, "hd_backup_cancel");
  f.sent.at(-1).resolve({ ok: true });
  await tick();
  assert.deepEqual(f.tracked.at(-1), { token: "prepared-token", active: false });
  assert.equal(f.el("backup-preview").hidden, true);
  assert.match(f.statuses.at(-1)[0], /not changed/u);
});

test("replacement archive URLs are revoked when early cancellation fails or the page epoch changes", async t => {
  for (const mode of ["cancel-failure", "pagehide"]) {
    const f = fixture(t);
    let created = 0;
    f.window.URL.createObjectURL = () => `blob:${mode}-${++created}`;
    await f.prepare();
    Object.defineProperty(f.el("backup-file"), "files", { configurable: true,
      value: [new f.window.File(["replacement"], "replacement.zip")] });
    f.el("backup-file").dispatchEvent(new f.window.Event("change"));
    await tick();
    const earlyCancel = f.sent.at(-1);
    assert.equal(earlyCancel.type, "hd_backup_cancel");
    if (mode === "cancel-failure") {
      earlyCancel.resolve({ ok: false, error: "injected cancellation failure" });
    } else {
      f.window.dispatchEvent(new f.window.Event("pagehide"));
      const pagehideCancel = f.sent.at(-1);
      assert.equal(pagehideCancel.type, "hd_backup_cancel");
      earlyCancel.resolve({ ok: true });
      pagehideCancel.resolve({ ok: true });
    }
    await tick();
    await tick();
    assert.deepEqual(f.revoked, [`blob:${mode}-1`, `blob:${mode}-2`]);
    assert.equal(f.sent.filter(request => request.type === "hd_backup_prepare").length, 1);
  }
});

test("leaving Settings cancels late preparation and does not revive a preview on Back", async t => {
  for (const late of [false, true]) {
    const f = fixture(t);
    const leave = () => f.window.dispatchEvent(new f.window.Event("pagehide"));
    if (late) await f.prepare(() => {
      leave();
      assert.equal(f.sent.at(-1).type, "hd_backup_cancel", "cancel must be sent before the prepare reply, while the page still exists");
      assert.equal(f.sent.at(-1).token, "prepared-token");
      f.window.dispatchEvent(new f.window.Event("pageshow"));
    });
    else { await f.prepare(); leave(); }
    assert.equal(f.sent.at(-1).type, "hd_backup_cancel");
    assert.equal(f.sent.at(-1).token, "prepared-token");
    assert.equal(f.cancelled.at(-1), "prepared-token");
    f.sent.at(-1).resolve({ ok: true });
    await tick();
    assert.deepEqual(f.tracked.at(-1), { token: "prepared-token", active: false });
    assert.equal(f.el("backup-preview").hidden, true);
    assert.equal(f.el("backup-restore").disabled, true);
    assert.equal(f.el("backup-confirm").checked, false);
  }
});

test("backup export remains available without Chrome downloads while preserving restore", async t => {
  const f = fixture(t, { chromeDownloads: false });
  const blob = new Blob(["backup archive bytes"]);
  const clicked = [];
  f.window.fetch = async url => {
    assert.equal(url, "blob:engine-backup");
    return { ok: true, blob: async () => blob };
  };
  f.window.URL.createObjectURL = value => {
    assert.equal(value, blob);
    return "blob:settings-backup";
  };
  f.window.HTMLAnchorElement.prototype.click = function () {
    clicked.push({ href: this.href, download: this.download });
  };
  assert.equal(f.el("backup-export").disabled, false);
  assert.equal(f.el("backup-file").disabled, false);
  f.el("backup-export").click();
  f.el("backup-export").click();
  await tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "hd_backup_export");
  f.sent[0].resolve({ ok: true, blobUrl: "blob:engine-backup" });
  await tick();
  assert.equal(f.sent[1].type, "hd_backup_release");
  assert.equal(f.sent[1].blobUrl, "blob:engine-backup");
  f.sent[1].resolve({ ok: true });
  await tick();
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0].href, "blob:settings-backup");
  assert.match(clicked[0].download, /^hachidori-backup-\d{4}-\d{2}-\d{2}\.zip$/u);
  assert.match(f.statuses.at(-1)[0], /Save requested/u);
  assert.equal(f.downloads, 0);
  f.window.URL.createObjectURL = () => "blob:selected-backup";
  await f.prepare();
  assert.equal(f.el("backup-preview").hidden, false);
});

test("a failed archive release is retried before the next export and on leaving Settings", async t => {
  const f = fixture(t, { chromeDownloads: false });
  f.window.fetch = async () => ({ ok: true, blob: async () => new Blob(["bytes"]) });
  f.window.HTMLAnchorElement.prototype.click = function () {};
  f.el("backup-export").click();
  await tick();
  assert.equal(f.sent[0].type, "hd_backup_export");
  f.sent[0].resolve({ ok: true, blobUrl: "blob:first-backup" });
  await tick();
  assert.equal(f.sent[1].type, "hd_backup_release");
  assert.equal(f.sent[1].blobUrl, "blob:first-backup");
  f.sent[1].resolve({ ok: false, error: "engine unreachable" });
  await tick();
  assert.match(f.statuses.at(-1)[0], /engine unreachable/u);

  f.el("backup-export").click();
  await tick();
  assert.equal(f.sent[2].type, "hd_backup_release");
  assert.equal(f.sent[2].blobUrl, "blob:first-backup", "the unreleased archive from the failed attempt must be retried first");
  f.sent[2].resolve({ ok: true });
  await tick();
  assert.equal(f.sent[3].type, "hd_backup_export");
  f.sent[3].resolve({ ok: true, blobUrl: "blob:second-backup" });
  await tick();
  assert.equal(f.sent[4].type, "hd_backup_release");
  assert.equal(f.sent[4].blobUrl, "blob:second-backup");
  f.sent[4].resolve({ ok: false, error: "engine unreachable" });
  await tick();

  f.window.dispatchEvent(new f.window.Event("pagehide"));
  await tick();
  assert.equal(f.sent.at(-1).type, "hd_backup_release");
  assert.equal(f.sent.at(-1).blobUrl, "blob:second-backup");
});
