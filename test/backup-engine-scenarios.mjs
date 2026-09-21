// Focused complete-restore scenarios through the real engine and background.
import assert from "node:assert/strict";
import { TRAINED_TERMS, buildRecommendedZip, buildTitledZip, makePng } from "./make-fixture.mjs";
import {
  AUTOMATIC_BACKUP_INTERVAL_MS,
  automaticBackupJsonBytes,
} from "../extension/backup-automatic.js";
import { createBackupArchive, openBackupArchive } from "../extension/backup-archive.js";
import { backupRevisions } from "../extension/backup-state.js";
import { emptyCustomDictionaryDocument } from "../extension/custom-dictionary.js";
import { managedDictionarySource } from "../extension/managed-dictionary-source.js";
import { emptyLookupStats, lookupStatsKey, lookupStatsPrefix, LOOKUP_STATS_ROW_PREFIX } from "../extension/lookup-stats.js";

export async function backupEngineScenarios({
  request,
  pageChrome,
  hostChrome,
  workerChrome,
  storage,
  engine,
  transactionCounts,
  reconcileAutomatic,
  check,
}) {
  const sendWorker = (type, fields = {}) => pageChrome.runtime.sendMessage({ target: "hoshidicts-worker", type, ...fields });
  const read = async () => structuredClone((await sendWorker("hd_backup_read")).snapshot);
  const readRows = async () => structuredClone((await sendWorker("hd_backup_read")).lookupStatsRows);
  const accepted = async (type, fields) => {
    const reply = await request(type, fields);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply;
  };
  const roots = () => engine.FS.readdir("/dicts").filter(name => name.startsWith(".hdw-generation-")).sort();
  const automaticStore = () => structuredClone(storage.raw.get("automaticBackups"));
  const automaticWrites = () => storage.sets.filter(keys =>
    keys.length === 1 && keys[0] === "automaticBackups").length;
  const snapshotRoots = snapshot => new Set(snapshot.state.dictionaries.map(dictionary =>
    dictionary.path.slice(0, dictionary.path.lastIndexOf("/"))));
  const treeStats = path => {
    const stat = engine.FS.stat(path);
    const directory = typeof engine.FS.isDir === "function"
      ? engine.FS.isDir(stat.mode)
      : (stat.mode & 0o170000) === 0o040000;
    if (!directory) return { bytes: Number(stat.size) || 0, files: 1 };
    return engine.FS.readdir(path).filter(name => name !== "." && name !== "..")
      .map(name => treeStats(`${path}/${name}`))
      .reduce((total, next) => ({
        bytes: total.bytes + next.bytes,
        files: total.files + next.files,
      }), { bytes: 0, files: 0 });
  };
  const makeAutomaticDue = async () => {
    const store = automaticStore();
    const base = Date.now() - AUTOMATIC_BACKUP_INTERVAL_MS - 1000;
    store.backups = store.backups.map((record, index) => ({
      ...record,
      createdAt: new Date(base - index * 1000).toISOString(),
    }));
    await pageChrome.storage.local.set({ automaticBackups: store });
    return store;
  };
  const prepare = blobUrl => accepted("hd_backup_prepare", { blobUrl, token: crypto.randomUUID() });
  const restore = async blobUrl => accepted("hd_backup_restore", { token: (await prepare(blobUrl)).token });
  const initial = await accepted("hd_backup_export");
  let initialSnapshot = await read();

  assert.equal(typeof reconcileAutomatic, "function");
  await pageChrome.storage.local.set({ automaticBackups: { schemaVersion: 1, backups: [] } });
  await accepted("hd_reload");
  const automaticBaseline = await read();
  const automaticBaselineRows = await readRows();
  const baselineRoots = snapshotRoots(automaticBaseline);
  assert.ok(baselineRoots.size > 0, "the automatic-backup fixture needs a real dictionary generation");
  assert.deepEqual(new Set(roots().map(root => `/dicts/${root}`)), baselineRoots);

  const writesBeforeFirstAutomatic = automaticWrites();
  const durableWritesBeforeAutomatic = transactionCounts.durableFilesystemWrites;
  const firstAutomaticResult = await reconcileAutomatic();
  const firstAutomatic = automaticStore();
  assert.equal(firstAutomaticResult.created, true);
  assert.equal(automaticWrites(), writesBeforeFirstAutomatic + 1);
  assert.equal(firstAutomatic.backups.length, 1);
  assert.deepEqual(firstAutomatic.backups[0].snapshot, automaticBaseline);
  assert.deepEqual(firstAutomatic.backups[0].lookupStatsRows, automaticBaselineRows);
  assert.deepEqual(new Set(roots().map(root => `/dicts/${root}`)), baselineRoots);

  await makeAutomaticDue();
  const writesBeforeSecondAutomatic = automaticWrites();
  await reconcileAutomatic();
  const sharedAutomatic = automaticStore();
  const sharedRootSets = sharedAutomatic.backups.map(record => snapshotRoots(record.snapshot));
  assert.equal(automaticWrites(), writesBeforeSecondAutomatic + 1);
  assert.equal(sharedAutomatic.backups.length, 2);
  assert.deepEqual(sharedRootSets[0], baselineRoots);
  assert.deepEqual(sharedRootSets[1], baselineRoots);
  assert.equal(transactionCounts.durableFilesystemWrites, durableWritesBeforeAutomatic);
  assert.deepEqual(new Set(roots().map(root => `/dicts/${root}`)), baselineRoots);

  const uniqueRetainedRoots = new Set(sharedRootSets.flatMap(set => [...set]));
  const uniqueRetainedStats = [...uniqueRetainedRoots].map(root => treeStats(root))
    .reduce((total, next) => ({
      bytes: total.bytes + next.bytes,
      files: total.files + next.files,
    }), { bytes: 0, files: 0 });
  const perSnapshotRawBytes = sharedRootSets.reduce((bytes, set) =>
    bytes + [...set].reduce((sum, root) => sum + treeStats(root).bytes, 0), 0);
  const automaticBackupBenchmark = {
    fixture: {
      dictionaries: automaticBaseline.state.dictionaries.map(dictionary => ({
        title: dictionary.title,
        revision: dictionary.revision,
        path: dictionary.path,
      })),
      lookupRows: automaticBaselineRows.length,
      manualArchiveBytes: initial.size,
    },
    firstSnapshot: {
      recordBytes: automaticBackupJsonBytes(firstAutomatic.backups[0]),
      storeBytes: automaticBackupJsonBytes(firstAutomatic),
      applicationWrites: 1,
      dictionaryFilesystemWrites: 0,
    },
    retainedTwo: {
      recordBytes: sharedAutomatic.backups.map(automaticBackupJsonBytes),
      storeBytes: automaticBackupJsonBytes(sharedAutomatic),
      applicationWrites: 1,
      dictionaryFilesystemWrites: 0,
      snapshotRootReferences: sharedRootSets.reduce((count, set) => count + set.size, 0),
      uniqueRetainedRoots: uniqueRetainedRoots.size,
      rawRetainedFiles: uniqueRetainedStats.files,
      rawRetainedBytes: uniqueRetainedStats.bytes,
      rawBytesIfRootsWereCopiedPerSnapshot: perSnapshotRawBytes,
      rawBytesAvoidedBySharing: perSnapshotRawBytes - uniqueRetainedStats.bytes,
    },
  };
  check("two automatic snapshots share real dictionary generations without blob copies or filesystem writes",
    uniqueRetainedRoots.size === baselineRoots.size
      && sharedRootSets.reduce((count, set) => count + set.size, 0) === baselineRoots.size * 2
      && perSnapshotRawBytes === uniqueRetainedStats.bytes * 2
      && automaticBackupBenchmark.retainedTwo.rawBytesAvoidedBySharing === uniqueRetainedStats.bytes,
    JSON.stringify(automaticBackupBenchmark));

  const tamperedStore = structuredClone(sharedAutomatic);
  const tamperedDictionary = tamperedStore.backups[0].snapshot.state.dictionaries[0];
  tamperedDictionary.path =
    `${tamperedDictionary.path.slice(0, tamperedDictionary.path.lastIndexOf("/"))}/nested/${tamperedDictionary.title}`;
  storage.raw.set("automaticBackups", tamperedStore);
  const filesystemReads = [];
  const wrappedFilesystemMethods = new Map();
  for (const name of ["readFile", "stat", "readdir", "analyzePath"]) {
    if (typeof engine.FS[name] !== "function") continue;
    const original = engine.FS[name];
    wrappedFilesystemMethods.set(name, original);
    engine.FS[name] = function (...args) {
      filesystemReads.push({ name, path: args[0] });
      return original.apply(this, args);
    };
  }
  let tamperedPreparation;
  try {
    tamperedPreparation = await request("hd_backup_auto_prepare", {
      id: tamperedStore.backups[0].id,
      token: crypto.randomUUID(),
    });
  } finally {
    for (const [name, original] of wrappedFilesystemMethods) engine.FS[name] = original;
    storage.raw.set("automaticBackups", structuredClone(sharedAutomatic));
  }
  check("automatic restore rejects a tampered dictionary path before any filesystem read",
    tamperedPreparation.ok === false
      && /invalid dictionary path/u.test(tamperedPreparation.error ?? "")
      && filesystemReads.length === 0,
    JSON.stringify({ tamperedPreparation, filesystemReads }));

  await restore(initial.blobUrl);
  const replacementRoots = snapshotRoots(await read());
  assert.equal([...replacementRoots].some(root => baselineRoots.has(root)), false);
  assert.deepEqual(new Set(roots().map(root => `/dicts/${root}`)), new Set([...baselineRoots, ...replacementRoots]));
  check("ordinary generation cleanup retains every root referenced by both automatic snapshots",
    sharedAutomatic.backups.every(record =>
      [...snapshotRoots(record.snapshot)].every(root => engine.FS.analyzePath(root).exists)));

  await makeAutomaticDue();
  await reconcileAutomatic();
  const mixedAutomatic = automaticStore();
  assert.deepEqual(snapshotRoots(mixedAutomatic.backups[0].snapshot), replacementRoots);
  assert.deepEqual(snapshotRoots(mixedAutomatic.backups[1].snapshot), baselineRoots);
  const mixedRoots = new Set([...baselineRoots, ...replacementRoots]);
  assert.deepEqual(new Set(roots().map(root => `/dicts/${root}`)), mixedRoots);

  await makeAutomaticDue();
  const authoritativeBeforeRefusal = automaticStore();
  const rootsBeforeRefusal = roots();
  const durableWritesBeforeRefusal = transactionCounts.durableFilesystemWrites;
  storage.failNextSet("injected retained-root metadata refusal");
  let automaticRefusal = null;
  try { await reconcileAutomatic(); }
  catch (error) { automaticRefusal = error; }
  assert.match(automaticRefusal?.message ?? "", /injected retained-root metadata refusal/u);
  assert.deepEqual(automaticStore(), authoritativeBeforeRefusal);
  assert.deepEqual(roots(), rootsBeforeRefusal);
  assert.equal(transactionCounts.durableFilesystemWrites, durableWritesBeforeRefusal);
  check("a refused automatic metadata replacement keeps both real generation roots and performs no cleanup write", true);

  const writesBeforeLostReply = automaticWrites();
  storage.loseNextSetReply("lost retained-root metadata reply");
  await reconcileAutomatic();
  const recoveredAutomatic = automaticStore();
  assert.equal(automaticWrites(), writesBeforeLostReply + 1);
  assert.equal(new Set(recoveredAutomatic.backups.map(record => record.id)).size, 2);
  assert.ok(recoveredAutomatic.backups.every(record => {
    const rootsForRecord = snapshotRoots(record.snapshot);
    return rootsForRecord.size === replacementRoots.size
      && [...rootsForRecord].every(root => replacementRoots.has(root));
  }));
  assert.deepEqual(new Set(roots().map(root => `/dicts/${root}`)), replacementRoots);
  check("lost automatic metadata reply uses exact readback before retiring the newly unreferenced generation", true);

  await restore(initial.blobUrl);
  const corruptNewestRoots = snapshotRoots(await read());
  assert.equal([...corruptNewestRoots].some(root => replacementRoots.has(root)), false);
  assert.deepEqual(new Set(roots().map(root => `/dicts/${root}`)),
    new Set([...replacementRoots, ...corruptNewestRoots]));
  await makeAutomaticDue();
  await reconcileAutomatic();
  const fallbackStore = automaticStore();
  const newest = fallbackStore.backups[0];
  const older = fallbackStore.backups[1];
  assert.deepEqual(snapshotRoots(newest.snapshot), corruptNewestRoots);
  assert.deepEqual(snapshotRoots(older.snapshot), replacementRoots);
  const damagedDictionary = newest.snapshot.state.dictionaries.find(dictionary =>
    engine.FS.analyzePath(`${dictionary.path}/hash.table`).exists);
  assert.ok(damagedDictionary);
  engine.FS.unlink(`${damagedDictionary.path}/hash.table`);

  const visibleFallbacks = await sendWorker("hd_backup_auto_list");
  const rootsBeforeFallback = roots();
  const newestToken = crypto.randomUUID();
  const newestPreparation = await request("hd_backup_auto_prepare", { id: newest.id, token: newestToken });
  assert.equal(newestPreparation.ok, false);
  assert.deepEqual(roots(), rootsBeforeFallback);
  const olderToken = crypto.randomUUID();
  const olderPreparation = await accepted("hd_backup_auto_prepare", { id: older.id, token: olderToken });
  assert.deepEqual(roots(), rootsBeforeFallback);
  const beforeAutomaticRestore = await read();
  const writesBeforeAutomaticRestore = storage.sets.length;
  await accepted("hd_backup_restore", { token: olderPreparation.token });
  const fallbackRestored = await read();
  assert.equal(storage.sets.length, writesBeforeAutomaticRestore + 1);
  assert.deepEqual(fallbackRestored.state.dictionaries.map(dictionary => dictionary.path),
    older.snapshot.state.dictionaries.map(dictionary => dictionary.path));
  assert.equal(fallbackRestored.document.text, older.snapshot.document.text);
  assert.deepEqual(await readRows(), older.lookupStatsRows);
  assert.ok(Object.keys(backupRevisions(fallbackRestored)).every(key =>
    fallbackRestored[key].revision === beforeAutomaticRestore[key].revision + 1));
  const restoredTrainedLookup = await accepted("hd_lookup", { text: TRAINED_TERMS.at(-1)[0] });
  assert.ok(restoredTrainedLookup.results.length > 0);
  check("a corrupt newest automatic backup leaves the valid older snapshot selectable and restorable in place",
    visibleFallbacks.ok === true
      && visibleFallbacks.backups.map(record => record.id).includes(newest.id)
      && visibleFallbacks.backups.map(record => record.id).includes(older.id)
      && /missing|metadata|dictionary/iu.test(newestPreparation.error ?? "")
      && roots().length === rootsBeforeFallback.length,
    JSON.stringify({ visibleFallbacks, newestPreparation, olderPreparation }));

  await makeAutomaticDue();
  await reconcileAutomatic();
  await makeAutomaticDue();
  const originalWorkerSend = workerChrome.runtime.sendMessage;
  workerChrome.runtime.sendMessage = message => message.type === "hd_backup_auto_cleanup"
    ? Promise.resolve({
        type: "hd_backup_auto_cleanup_result",
        requestId: message.requestId,
        ok: false,
        error: "injected interrupted automatic cleanup",
      })
    : originalWorkerSend(message);
  try {
    await reconcileAutomatic();
  } finally {
    workerChrome.runtime.sendMessage = originalWorkerSend;
  }
  const authoritativeAfterInterruptedCleanup = automaticStore();
  assert.ok(authoritativeAfterInterruptedCleanup.backups.every(record =>
    [...snapshotRoots(record.snapshot)].every(root => replacementRoots.has(root))));
  assert.ok([...corruptNewestRoots].every(root => engine.FS.analyzePath(root).exists));
  await accepted("hd_reload");
  assert.deepEqual(new Set(roots().map(root => `/dicts/${root}`)), replacementRoots);
  check("a later reload reconciles interrupted cleanup from both retained snapshot roots", true);

  await pageChrome.storage.local.set({ automaticBackups: { schemaVersion: 1, backups: [] } });
  await accepted("hd_reload");
  initialSnapshot = await read();

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
  for (const reading of ["ねこ", "ねこ", ""]) {
    assert.equal((await sendWorker("hd_lookup_stats_record", { term: "猫", reading })).ok, true);
  }
  const archived = await read(), archivedRows = await readRows();
  const exported = await accepted("hd_backup_export");
  const archive = await (await fetch(exported.blobUrl)).blob();
  const parsed = await openBackupArchive(archive);
  assert.deepEqual(parsed.snapshot, archived);
  assert.deepEqual(parsed.lookupStatsRows, archivedRows);
  assert.deepEqual(archivedRows.map(row => row.lookupCount), [2, 1]);
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
  for (const key of Object.keys(backupRevisions(restored))) {
    assert.equal(restored[key].revision, beforeRestore[key].revision + 1);
    const original = { ...archived[key] }, actual = { ...restored[key] };
    delete original.revision; delete actual.revision;
    if (key === "lookupStats") {
      assert.notEqual(actual.generation, original.generation);
      delete original.generation; delete actual.generation;
    }
    if (key === "state") {
      const withoutPath = entry => { const next = { ...entry }; delete next.path; return next; };
      original.dictionaries = original.dictionaries.map(withoutPath);
      actual.dictionaries = actual.dictionaries.map(withoutPath);
    }
    assert.deepEqual(actual, original);
  }
  assert.deepEqual(await readRows(), archivedRows);
  assert.deepEqual(storage.sets.slice(writes), [["customDictionarySource", "dictionaryState", "dictionaryUpdates", "lookupStats", "options",
    ...archivedRows.map(row => lookupStatsKey(restored.lookupStats, row))].sort()]);
  assert.ok(roots().every(root => !oldRoots.includes(root)));
  const customLookup = await accepted("hd_lookup", { text: "猫" });
  assert.ok(customLookup.results.length > 0);
  check("restore publishes all five values and statistics rows once before superseded-generation cleanup", true);

  for (const edit of ["options", "document", "updates", "state", "lookupStats"]) {
    const pending = await prepare(exported.blobUrl);
    const base = await read();
    if (edit === "options") await sendWorker("hd_options_write", { baseRevision: base.options.revision, options: { scanLength: base.options.scanLength + 1 } });
    if (edit === "document") await accepted("hd_custom_append", { entry: { term: "犬", reading: "いぬ", definition: "dog" } });
    if (edit === "updates") await pageChrome.runtime.sendMessage({ target: "hachidori-updates", type: "hd_updates_schedule",
      baseRevision: base.updates.revision, schedule: "off" });
    if (edit === "state") await sendWorker("hd_state_cas", { baseRevision: base.state.revision,
      dictionaries: base.state.dictionaries, groups: [] });
    if (edit === "lookupStats") await sendWorker("hd_lookup_stats_record", { term: "猫", reading: "ねこ" });
    const changed = await read();
    assert.notDeepEqual(backupRevisions(changed), backupRevisions(base));
    const refused = await request("hd_backup_restore", { token: pending.token });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /changed/u);
    assert.deepEqual(await read(), changed);
    assert.equal(roots().length, changed.state.dictionaries.length);
  }
  check("restore refuses concurrent options, source, schedule, dictionary and statistics edits without leaking staging", true);

  const corruptFiles = parsed.files.map(file => file.path.endsWith("/hash.table") && file.path.startsWith("dictionaries/2/")
    ? { ...file, data: new Blob([new Uint8Array([0])]) } : file);
  const corruptUrl = URL.createObjectURL(await createBackupArchive(parsed.snapshot, corruptFiles, parsed.lookupStatsRows));
  const beforeCorrupt = await read();
  const corruptRoots = roots();
  try {
    const invalid = await request("hd_backup_prepare", { blobUrl: corruptUrl, token: crypto.randomUUID() });
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
    assert.deepEqual(await readRows(), archivedRows);
    assert.equal(roots().length, (await read()).state.dictionaries.length);
  } finally { hostChrome.runtime.sendMessage = originalSend; }
  check("lost complete-restore CAS reply is recovered by exact five-value readback without a duplicate commit", true);

  const beforeFailure = await read();
  const rowsBeforeFailure = await readRows();
  const failureRoots = roots();
  const refusedWrite = await prepare(exported.blobUrl);
  storage.failNextSet(new Error("injected restore storage failure"));
  assert.equal((await request("hd_backup_restore", { token: refusedWrite.token })).ok, false);
  assert.deepEqual(await read(), beforeFailure);
  assert.deepEqual(await readRows(), rowsBeforeFailure);
  assert.deepEqual(roots(), failureRoots);
  assert.ok((await accepted("hd_lookup", { text: "猫" })).results.length > 0);
  check("a refused complete-state write preserves the working lookup and removes all prepared generations", true);

  const uncertain = await prepare(exported.blobUrl);
  let committed = false, statsCleanups = 0;
  hostChrome.runtime.sendMessage = async message => {
    if (message.type === "hd_lookup_stats_cleanup") statsCleanups += 1;
    if (message.type === "hd_backup_base_read" && committed) throw new Error("backup readback unavailable");
    const reply = await originalSend(message);
    if (message.type === "hd_backup_cas") { committed = true; throw new Error("lost committed restore reply"); }
    return reply;
  };
  try {
    const reply = await request("hd_backup_restore", { token: uncertain.token });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /readback unavailable/u);
    assert.equal(statsCleanups, 0, "unknown publication retains both statistics namespaces");
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
  assert.deepEqual((await request("hd_status")).failedDictionaries.map(({ id }) => id), [live.id],
    "status still reports the damaged live generation during preview");
  assert.deepEqual(roots(), recoveryRoots, "status must not clean a prepared recovery generation");
  await accepted("hd_backup_restore", { token: recovery.token });
  assert.equal((await read()).document.revision, damaged.document.revision + 11);
  assert.ok((await accepted("hd_lookup", { text: "猫" })).results.length > 0);
  check("a validated backup repairs missing live files and malformed source without requiring the broken generation to load", true);

  const beforeCleanup = await read();
  await storage.api().local.set({ unrelatedLookupData: "keep" });
  hostChrome.runtime.sendMessage = message => message.type === "hd_lookup_stats_cleanup"
    ? Promise.resolve({ ok: false, error: "injected statistics cleanup failure" }) : originalSend(message);
  try {
    const reply = await restore(exported.blobUrl);
    assert.equal(reply.restored, true);
    assert.match(reply.warning, /statistics.*cleaned up/u);
    assert.ok([...storage.raw.keys()].some(key => key.startsWith(lookupStatsPrefix(beforeCleanup.lookupStats))));
    assert.deepEqual(await readRows(), archivedRows);
  } finally { hostChrome.runtime.sendMessage = originalSend; }
  await restore(exported.blobUrl);
  const activePrefix = lookupStatsPrefix((await read()).lookupStats);
  assert.ok([...storage.raw.keys()].filter(key => key.startsWith(LOOKUP_STATS_ROW_PREFIX)).every(key => key.startsWith(activePrefix)));
  assert.equal(storage.raw.get("unrelatedLookupData"), "keep");
  check("statistics cleanup is best effort and later confirmed restore prunes only inactive owned namespaces", true);

  const emptyUrl = URL.createObjectURL(await createBackupArchive({
    state: { schemaVersion: 1, revision: 0, dictionaries: [], groups: [] },
    options: { revision: 0 }, document: emptyCustomDictionaryDocument(),
    updates: { revision: 0, schedule: "off", lastCheckedAt: null },
    lookupStats: emptyLookupStats(),
  }, [], []));
  try {
    await restore(emptyUrl);
    const empty = await read();
    assert.deepEqual(empty.state.dictionaries, []);
    assert.deepEqual(empty.state.groups, []);
    assert.deepEqual(Object.keys(empty.options), ["revision"]);
    assert.equal(empty.document.text, "");
    assert.equal(empty.updates.schedule, "off");
    assert.deepEqual(await readRows(), []);
    assert.equal(roots().length, 0);
  } finally { URL.revokeObjectURL(emptyUrl); }
  check("an empty backup resets settings, custom source and schedule rather than retaining unrelated live values", true);

  // Yomitan's isUpdatable flag alone is not a managed source. Local imports
  // with incomplete/non-HTTPS descriptors remain valid and not checkable.
  for (const downloadUrl of [undefined, "http://example.com/local.zip", "https://example.com/managed.zip"]) {
    const localUrl = URL.createObjectURL(new Blob([buildRecommendedZip({ title: "Backup source contract",
      revision: "1", indexUrl: "https://example.com/index.json", downloadUrl, capabilities: ["term"] })]));
    let saved;
    try {
      await accepted("hd_import", { blobUrl: localUrl, fileName: "source-contract.zip" });
      if (downloadUrl?.startsWith("http:")) {
        const replacement = URL.createObjectURL(new Blob([buildRecommendedZip({ title: "Backup source contract",
          revision: "2", indexUrl: "https://example.com/index.json", downloadUrl: "https://example.com/updated.zip",
          capabilities: ["term"] })]));
        try { await accepted("hd_import", { blobUrl: replacement, fileName: "source-reimport.zip" }); }
        finally { URL.revokeObjectURL(replacement); }
      }
      const before = (await read()).state.dictionaries.find(dictionary => dictionary.title === "Backup source contract");
      assert.equal(before.isUpdatable, true);
      assert.equal(managedDictionarySource(before)?.kind ?? null, downloadUrl?.startsWith("https:") ? "generic" : null);
      saved = await accepted("hd_backup_export");
      await restore(saved.blobUrl);
      const after = (await read()).state.dictionaries.find(dictionary => dictionary.id === before.id);
      const { path: beforePath, ...beforeMetadata } = before;
      const { path: afterPath, ...afterMetadata } = after;
      assert.notEqual(afterPath, beforePath);
      assert.deepEqual(afterMetadata, beforeMetadata);
      assert.deepEqual(managedDictionarySource(after), managedDictionarySource(before));
    } finally {
      URL.revokeObjectURL(localUrl);
      if (saved) await accepted("hd_backup_release", { blobUrl: saved.blobUrl });
      // Start each descriptor case from an empty library, not a reimport that
      // deliberately preserves the earlier source metadata.
      const state = (await read()).state;
      const dictionary = state.dictionaries.find(entry => entry.title === "Backup source contract");
      if (dictionary) await accepted("hd_remove", { id: dictionary.id, title: dictionary.title });
    }
  }
  check("backup preserves local-only source descriptors and complete managed sources without changing update eligibility", true);

  await restore(initial.blobUrl);
  await accepted("hd_backup_release", { blobUrl: exported.blobUrl });
  await accepted("hd_backup_release", { blobUrl: initial.blobUrl });
  return { automaticBackupBenchmark };
}
