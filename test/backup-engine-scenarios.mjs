// Focused complete-restore scenarios through the real engine and background.
import assert from "node:assert/strict";
import { buildTitledZip, makePng } from "./make-fixture.mjs";
import { createBackupArchive, openBackupArchive } from "../extension/backup-archive.js";
import { backupRevisions } from "../extension/backup-state.js";
import { emptyCustomDictionaryDocument } from "../extension/custom-dictionary.js";

export async function backupEngineScenarios({ request, pageChrome, hostChrome, storage, engine, check }) {
  const sendWorker = (type, fields = {}) => pageChrome.runtime.sendMessage({ target: "hoshidicts-worker", type, ...fields });
  const read = async () => structuredClone((await sendWorker("hd_backup_read")).snapshot);
  const accepted = async (type, fields) => {
    const reply = await request(type, fields);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply;
  };
  const roots = () => engine.FS.readdir("/dicts").filter(name => name.startsWith(".hdw-generation-")).sort();
  const prepare = blobUrl => accepted("hd_backup_prepare", { blobUrl });
  const restore = async blobUrl => accepted("hd_backup_restore", { token: (await prepare(blobUrl)).token });
  const initial = await accepted("hd_backup_export");
  const initialSnapshot = await read();

  const disabledTitle = "Backup disabled media";
  const importUrl = URL.createObjectURL(new Blob([buildTitledZip(disabledTitle, { mediaEntries: [["media/kanji.png", makePng()]] })]));
  try { await accepted("hd_import", { blobUrl: importUrl, fileName: "backup-media.zip" }); }
  finally { URL.revokeObjectURL(importUrl); }
  await accepted("hd_custom_save", { baseDocumentRevision: initialSnapshot.document.revision,
    text: "# preserve comments\r\n猫,ねこ,cat\\nsecond line\r\nmalformed\r\n" });
  let current = await read();
  const disabled = current.state.dictionaries.find(entry => entry.title === disabledTitle);
  await accepted("hd_apply_state", { baseRevision: current.state.revision,
    dictionaries: current.state.dictionaries.map(entry => entry.id === disabled.id
      ? { ...entry, enabled: false, displayName: "My media", favorite: true } : entry) });
  current = await read();
  assert.equal((await sendWorker("hd_state_cas", { baseRevision: current.state.revision,
    dictionaries: current.state.dictionaries, groups: [{ id: "backup-group", name: "Saved", dictionaryIds: [disabled.id] }] })).ok, true);
  assert.equal((await sendWorker("hd_options_write", { baseRevision: current.options.revision,
    options: { popupTheme: "dark", scanLength: 19 } })).ok, true);
  current = await read();
  assert.equal((await pageChrome.runtime.sendMessage({ target: "hachidori-updates", type: "hd_updates_schedule",
    baseRevision: current.updates.revision, schedule: "weekly" })).ok, true);
  const archived = await read();
  const exported = await accepted("hd_backup_export");
  const archive = await (await fetch(exported.blobUrl)).blob();
  const parsed = await openBackupArchive(archive);
  assert.deepEqual(parsed.snapshot, archived);
  assert.ok(parsed.files.some(file => file.path.endsWith("/dict.zstd")));
  assert.ok(parsed.files.some(file => file.path.endsWith("/media.bin")));
  check("complete backup captures disabled files, trained data, custom source and one coherent settings snapshot", true);

  await restore(initial.blobUrl);
  const beforeRestore = await read();
  const oldRoots = roots();
  const oldGeneration = (await accepted("hd_status")).generation;
  const prepared = await prepare(exported.blobUrl);
  assert.equal((await accepted("hd_status")).generation, oldGeneration, "preview must not invalidate an existing popup generation");
  assert.deepEqual(await read(), beforeRestore, "prepare must not publish storage");
  const writes = storage.sets.length;
  await accepted("hd_backup_restore", { token: prepared.token });
  const restored = await read();
  for (const key of ["state", "options", "document", "updates"]) {
    assert.equal(restored[key].revision, beforeRestore[key].revision + 1);
    const original = { ...archived[key] }, actual = { ...restored[key] };
    delete original.revision; delete actual.revision;
    if (key === "state") {
      const withoutPath = entry => { const next = { ...entry }; delete next.path; return next; };
      original.dictionaries = original.dictionaries.map(withoutPath);
      actual.dictionaries = actual.dictionaries.map(withoutPath);
    }
    assert.deepEqual(actual, original);
  }
  assert.deepEqual(storage.sets.slice(writes), [["customDictionarySource", "dictionaryState", "dictionaryUpdates", "options"]]);
  assert.ok(roots().every(root => !oldRoots.includes(root)));
  const customLookup = await accepted("hd_lookup", { text: "猫" });
  assert.ok(customLookup.results.length > 0);
  check("restore publishes all four values once with newer revisions and fresh generations before old-file cleanup", true);

  for (const edit of ["options", "document", "updates", "state"]) {
    const pending = await prepare(exported.blobUrl);
    const base = await read();
    if (edit === "options") await sendWorker("hd_options_write", { baseRevision: base.options.revision, options: { scanLength: base.options.scanLength + 1 } });
    if (edit === "document") await accepted("hd_custom_append", { entry: { term: "犬", reading: "いぬ", definition: "dog" } });
    if (edit === "updates") await pageChrome.runtime.sendMessage({ target: "hachidori-updates", type: "hd_updates_schedule",
      baseRevision: base.updates.revision, schedule: "off" });
    if (edit === "state") await sendWorker("hd_state_cas", { baseRevision: base.state.revision,
      dictionaries: base.state.dictionaries, groups: [] });
    const changed = await read();
    assert.notDeepEqual(backupRevisions(changed), backupRevisions(base));
    const refused = await request("hd_backup_restore", { token: pending.token });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /changed/u);
    assert.deepEqual(await read(), changed);
    assert.equal(roots().length, changed.state.dictionaries.length);
  }
  check("restore refuses concurrent options, source, schedule and dictionary edits without overwriting them or leaking staging", true);

  const corruptFiles = parsed.files.map(file => file.path.endsWith("/hash.table") && file.path.startsWith("dictionaries/2/")
    ? { ...file, data: new Blob([new Uint8Array([0])]) } : file);
  const corruptUrl = URL.createObjectURL(await createBackupArchive(parsed.snapshot, corruptFiles));
  const beforeCorrupt = await read();
  const corruptRoots = roots();
  try {
    const invalid = await request("hd_backup_prepare", { blobUrl: corruptUrl });
    assert.equal(invalid.ok, false, "a corrupt disabled dictionary must be strictly loaded during prepare");
    assert.deepEqual(await read(), beforeCorrupt);
    assert.deepEqual(roots(), corruptRoots);
  } finally { URL.revokeObjectURL(corruptUrl); }
  check("a corrupt disabled restore generation is rejected before publication and leaves no staging debris", true);

  const pending = await prepare(exported.blobUrl);
  const originalSend = hostChrome.runtime.sendMessage;
  let loseReply = true;
  hostChrome.runtime.sendMessage = async message => {
    const reply = await originalSend(message);
    if (message.type === "hd_backup_cas" && loseReply) { loseReply = false; throw new Error("lost backup CAS reply"); }
    return reply;
  };
  try {
    const before = storage.sets.length;
    await accepted("hd_backup_restore", { token: pending.token });
    assert.equal(storage.sets.length, before + 1);
    assert.equal(roots().length, (await read()).state.dictionaries.length);
  } finally { hostChrome.runtime.sendMessage = originalSend; }
  check("lost complete-restore CAS reply is recovered by exact four-value readback without a duplicate commit", true);

  const beforeFailure = await read();
  const failureRoots = roots();
  const refusedWrite = await prepare(exported.blobUrl);
  storage.failNextSet(new Error("injected restore storage failure"));
  assert.equal((await request("hd_backup_restore", { token: refusedWrite.token })).ok, false);
  assert.deepEqual(await read(), beforeFailure);
  assert.deepEqual(roots(), failureRoots);
  assert.ok((await accepted("hd_lookup", { text: "猫" })).results.length > 0);
  check("a refused complete-state write preserves the working lookup and removes all prepared generations", true);

  const uncertain = await prepare(exported.blobUrl);
  let committed = false;
  hostChrome.runtime.sendMessage = async message => {
    if (message.type === "hd_backup_base_read" && committed) throw new Error("backup readback unavailable");
    const reply = await originalSend(message);
    if (message.type === "hd_backup_cas") { committed = true; throw new Error("lost committed restore reply"); }
    return reply;
  };
  try {
    const reply = await request("hd_backup_restore", { token: uncertain.token });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /readback unavailable/u);
    assert.equal(roots().length, failureRoots.length * 2, "retain both generations until a confirmed recovery read");
  } finally { hostChrome.runtime.sendMessage = originalSend; }
  await accepted("hd_reload");
  assert.equal(roots().length, (await read()).state.dictionaries.length);
  check("an uncertain restore retains both generation sets until authoritative reload recovery", true);

  const damaged = await read();
  const live = damaged.state.dictionaries.find(entry => entry.enabled && entry.id !== damaged.state.dictionaries[0].id);
  engine.FS.unlink(`${live.path}/hash.table`);
  await storage.api().local.set({ customDictionarySource: { schemaVersion: 99, revision: damaged.document.revision + 10 } });
  const recovery = await prepare(exported.blobUrl);
  assert.ok(recovery.warning);
  const recoveryRoots = roots();
  assert.equal((await request("hd_status")).ok, false, "status still reports the damaged live generation during preview");
  assert.deepEqual(roots(), recoveryRoots, "status must not clean a prepared recovery generation");
  await accepted("hd_backup_restore", { token: recovery.token });
  assert.equal((await read()).document.revision, damaged.document.revision + 11);
  assert.ok((await accepted("hd_lookup", { text: "猫" })).results.length > 0);
  check("a validated backup repairs missing live files and malformed source without requiring the broken generation to load", true);

  const emptyUrl = URL.createObjectURL(await createBackupArchive({
    state: { schemaVersion: 1, revision: 0, dictionaries: [], groups: [] },
    options: { revision: 0 }, document: emptyCustomDictionaryDocument(),
    updates: { revision: 0, schedule: "off", lastCheckedAt: null },
  }, []));
  try {
    await restore(emptyUrl);
    const empty = await read();
    assert.deepEqual(empty.state.dictionaries, []);
    assert.deepEqual(empty.state.groups, []);
    assert.deepEqual(Object.keys(empty.options), ["revision"]);
    assert.equal(empty.document.text, "");
    assert.equal(empty.updates.schedule, "off");
    assert.equal(roots().length, 0);
  } finally { URL.revokeObjectURL(emptyUrl); }
  check("an empty backup resets settings, custom source and schedule rather than retaining unrelated live values", true);

  await restore(initial.blobUrl);
  await accepted("hd_backup_release", { blobUrl: exported.blobUrl });
  await accepted("hd_backup_release", { blobUrl: initial.blobUrl });
}
