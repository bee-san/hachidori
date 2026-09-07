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

function fixture(t) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"));
  const { window } = dom;
  const sent = [], statuses = [], revoked = [];
  let blocked = false;
  window.URL.createObjectURL = () => "blob:selected-backup";
  window.URL.revokeObjectURL = url => revoked.push(url);
  const el = id => window.document.getElementById(id);
  createBackupSettingsController({ document: window.document,
    send: (type, fields) => new Promise(resolve => sent.push({ type, ...fields, resolve })),
    download: async () => ({ ok: true, downloadId: 7 }),
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
  return { el, window, sent, statuses, revoked, prepare, block() { blocked = true; } };
}

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
  assert.equal(f.el("backup-preview").hidden, true);
  assert.match(f.statuses.at(-1)[0], /not changed/u);
});

test("leaving Settings cancels late preparation and does not revive a preview on Back", async t => {
  for (const late of [false, true]) {
    const f = fixture(t);
    const leave = () => f.window.dispatchEvent(new f.window.Event("pagehide"));
    if (late) await f.prepare(() => {
      leave();
      f.window.dispatchEvent(new f.window.Event("pageshow"));
    });
    else { await f.prepare(); leave(); }
    assert.equal(f.sent.at(-1).type, "hd_backup_cancel");
    assert.equal(f.sent.at(-1).token, "prepared-token");
    f.sent.at(-1).resolve({ ok: true });
    await tick();
    assert.equal(f.el("backup-preview").hidden, true);
    assert.equal(f.el("backup-restore").disabled, true);
    assert.equal(f.el("backup-confirm").checked, false);
  }
});
