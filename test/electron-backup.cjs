/*
 * Real Electron overlay backup regression; no API mocks or privileged renderer IPC.
 * NODE_PATH=$PWD/test/tmp/electron/node_modules xvfb-run -a node \
 *   test/tmp/electron/node_modules/electron/cli.js test/electron-backup.cjs .
 * HACHIDORI_BACKUP_BASELINE=HEAD runs the same enabled-button assertion against
 * the original Settings files, replaced only in the disposable extension copy.
 * Electron sendInputEvent exercises Chromium pointer routing, not OS mouse input.
 * setSavePath/cancel exercise DownloadItem, not the native save-dialog UI; CDP
 * selects the restore file, not the OS file chooser. This is not a packaged GSM test.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const baseline = process.env.HACHIDORI_BACKUP_BASELINE;
const artifacts = path.join(root, "test/tmp/electron-backup", baseline ? "red" : "green");
fs.mkdirSync(artifacts, { recursive: true });
const temporary = fs.mkdtempSync(path.join(artifacts, "isolated-"));
app.setPath("userData", path.join(temporary, "profile"));
app.commandLine.appendSwitch("disable-gpu");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const planned = ["Electron overlay and enabled export", "saved ZIP contains complete state and native payloads",
  "download cancellation leaves data unchanged", "restore preview cancellation leaves data unchanged",
  "restore replaces deleted dictionaries and edited settings", "second saved ZIP matches every original payload"];
let passed = 0;
function pass(detail) { console.log(`PASS ${++passed}/${planned.length} ${planned[passed - 1]}: ${JSON.stringify(detail)}`); }
const deadline = setTimeout(() => { console.error("FAIL global 180s deadline"); app.exit(1); }, 180_000);

async function run() {
  const extension = path.join(temporary, "extension");
  fs.cpSync(path.join(root, "extension"), extension, { recursive: true });
  if (baseline) {
    for (const file of ["settings.js", "settings.html", "backup-settings.js", "overlay-mode.js"]) {
      fs.writeFileSync(path.join(extension, file), execFileSync("git", ["show", `${baseline}:extension/${file}`], { cwd: root }));
    }
  }
  const flag = path.join(extension, "overlay-mode.js");
  fs.writeFileSync(flag, fs.readFileSync(flag, "utf8").replace("OVERLAY_MODE = false", "OVERLAY_MODE = true"));
  const ses = session.defaultSession;
  const loaded = await ses.extensions.loadExtension(extension, { allowFileAccess: true });
  const origin = `chrome-extension://${loaded.id}`;
  const preferences = { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false };
  const window = new BrowserWindow({ width: 1200, height: 900, webPreferences: preferences });
  const js = code => window.webContents.executeJavaScript(code, true);
  async function until(expression, label) {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if (await js(expression)) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${label}; ${await js("document.querySelector('#backup-status')?.textContent")}`);
  }
  const request = (type, payload = {}, target = "hoshidicts-offscreen") => js(`(async () => {
    const reply = await chrome.runtime.sendMessage(${JSON.stringify({ target, type, requestId: `electron-backup-${crypto.randomUUID()}`, ...payload })});
    if (!reply?.ok) throw Error(${JSON.stringify(type)} + ': ' + reply?.error);
    return reply;
  })()`);
  const read = async () => (await request("hd_backup_read", {}, "hoshidicts-worker")).snapshot;
  async function ready() {
    await until("document.querySelector('#engine-status')?.textContent.includes('Ready')", "engine ready");
    await until("document.querySelector('#backup-export').getBoundingClientRect().width > 0", "backup section visible");
    await until("(async () => { const status = await chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_status', requestId: crypto.randomUUID() }); return status.ok && status.ready && !status.loading; })()", "engine idle");
  }
  async function pointer(selector) {
    const point = await js(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), disabled: element.disabled };
    })()`);
    assert.equal(point.disabled, false, `${selector} must be enabled`);
    window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
  const screenshot = async name => fs.writeFileSync(path.join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  await window.loadURL(`${origin}/settings.html#backup`);
  await ready();
  await screenshot("before.png");
  const environment = await js(`({ downloads: typeof chrome.downloads, node: typeof process,
    disabled: document.querySelector('#backup-export').disabled, status: document.querySelector('#engine-status').textContent })`);
  console.log("ENVIRONMENT", JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, ...environment }));
  assert.equal(environment.downloads, "undefined");
  assert.equal(environment.node, "undefined");
  assert.equal(environment.disabled, false, "Electron Settings Export backup must be enabled (original overlay regression)");
  pass(environment);

  const fixture = await import(pathToFileURL(path.join(root, "test/make-fixture.mjs")).href);
  const { openBackupArchive } = await import(pathToFileURL(path.join(root, "extension/backup-archive.js")).href);
  const source = "# Electron backup notes\n食べる, たべる, personal backup definition\n";
  await request("hd_custom_save", { baseDocumentRevision: (await read()).document.revision, text: source });

  const zip = fixture.buildFixtureZip();
  await js(`(async () => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(zip.toString("base64"))}), c => c.charCodeAt(0))]));
    try {
      const reply = await chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_import', requestId: 'electron-backup-fixture', blobUrl, fileName: 'fixture.zip' });
      if (!reply.ok || !reply.report?.success) throw Error(JSON.stringify(reply));
    } finally { URL.revokeObjectURL(blobUrl); }
  })()`);
  let state = (await read()).state;

  await request("hd_state_cas", { baseRevision: state.revision,
    dictionaries: state.dictionaries.map(entry => entry.title === fixture.TITLE ? { ...entry, enabled: true, displayName: "Electron fixture alias", favorite: true } : entry),
    groups: [{ id: "electron-backup-group", name: "Backup study", dictionaryIds: state.dictionaries.map(entry => entry.id) }],
  }, "hoshidicts-worker");
  await request("hd_options_write", { baseRevision: (await read()).options.revision, options: { scanLength: 17 } }, "hoshidicts-worker");

  await window.loadURL(`${origin}/settings.html#backup`);
  await ready();
  await request("hd_reload");
  const before = await read();

  const mediaBefore = await request("hd_media", { dictionary: fixture.TITLE, path: fixture.MEDIA_PATH, generation: (await request("hd_status")).generation });
  const stylesBefore = await request("hd_styles");
  assert.ok(before.state.dictionaries.length >= 2);
  assert.equal(before.document.text, source);
  assert.equal(before.state.groups.length, 1);
  assert.equal(before.options.scanLength, 17);

  async function save(name, cancel = false) {
    const destination = path.join(artifacts, name);
    fs.rmSync(destination, { force: true });
    const download = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ses.removeListener("will-download", listener); reject(new Error("No completed DownloadItem")); }, 30_000);
      function listener(event, item) {
        item.once("done", (event, state) => { clearTimeout(timer); resolve({ state, filename: item.getFilename(), url: item.getURL() }); });
        item.setSavePath(destination);
        if (cancel) item.cancel();
      }
      ses.once("will-download", listener);
    });
    await pointer("#backup-export");
    const result = await download.catch(async error => { throw new Error(`${error.message}; status=${await js("document.querySelector('#backup-status').textContent")}; ${JSON.stringify(await request('hd_status'))}`); });
    assert.equal(result.state, cancel ? "cancelled" : "completed");
    assert.match(result.filename, /^hachidori-backup-.*\.zip$/u);
    assert.match(result.url, /^blob:chrome-extension:/u);
    await until("!document.querySelector('#backup-export').disabled", "export idle");
    const notice = await js("document.querySelector('#backup-status').textContent");
    assert.match(notice, /Save requested/u);
    if (cancel) {
      assert.equal(fs.existsSync(destination), false);
      return result;
    }
    const bytes = fs.readFileSync(destination);
    const archive = await openBackupArchive(new Blob([bytes]));
    console.log("DOWNLOAD", JSON.stringify({ ...result, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), destination }));
    return { destination, bytes, archive };
  }
  const first = await save("first.zip");
  assert.deepEqual(first.archive.snapshot, before);
  assert.ok(first.archive.files.some(file => file.path.endsWith("/media.bin")));
  assert.ok(stylesBefore.styles.length > 0);
  pass({ bytes: first.bytes.length, files: first.archive.files.map(file => file.path) });
  const cancelled = await save("cancelled.zip", true);
  assert.deepEqual(await read(), before);
  pass(cancelled);

  window.webContents.debugger.attach("1.3");
  async function choose() {
    const { root: document } = await window.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: document.nodeId, selector: "#backup-file" });
    await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [first.destination] });
    await until("!document.querySelector('#backup-preview').hidden || document.querySelector('#backup-status').classList.contains('is-error')", "restore preview");
    assert.equal(await js("document.querySelector('#backup-preview').hidden"), false);
    assert.equal(await js("document.querySelector('#backup-restore').disabled"), true);
  }
  const generation = (await request("hd_status")).generation;
  await choose();
  assert.deepEqual(await read(), before);
  await pointer("#backup-cancel");
  await until("document.querySelector('#backup-preview').hidden && !document.querySelector('#backup-export').disabled", "cancel preview");
  assert.match(await js("document.querySelector('#backup-status').textContent"), /Restore cancelled/u);
  assert.deepEqual(await read(), before);
  assert.equal((await request("hd_status")).generation, generation);
  pass({ generation });

  await request("hd_remove", { title: fixture.TITLE });
  await request("hd_custom_save", { baseDocumentRevision: (await read()).document.revision, text: "" });
  state = (await read()).state;
  await request("hd_state_cas", { baseRevision: state.revision, dictionaries: state.dictionaries, groups: [] }, "hoshidicts-worker");
  await request("hd_options_write", { baseRevision: (await read()).options.revision, options: { scanLength: 9 } }, "hoshidicts-worker");
  const edited = await read();
  assert.equal(edited.state.dictionaries.length, 0);
  assert.equal(edited.document.text, "");
  assert.equal(edited.state.groups.length, 0);
  assert.equal(edited.options.scanLength, 9);
  await window.loadURL(`${origin}/settings.html#backup`);
  await ready();
  await choose();
  await pointer("#backup-confirm");
  await pointer("#backup-restore");
  await until("!document.querySelector('#backup-export').disabled", "restore complete");
  assert.match(await js("document.querySelector('#backup-status').textContent"), /Restored successfully/u);
  const restored = await read();
  const comparable = snapshot => Object.fromEntries(Object.entries(snapshot).map(([key, value]) => {
    const { revision, ...rest } = value;
    if (key === "state") rest.dictionaries = rest.dictionaries.map(({ path, ...entry }) => entry);
    if (key === "lookupStats") delete rest.generation;
    return [key, rest];
  }));
  assert.deepEqual(comparable(restored), comparable(before));
  for (const key of Object.keys(restored)) assert.equal(restored[key].revision, edited[key].revision + 1);
  for (let i = 0; i < restored.state.dictionaries.length; i++) assert.notEqual(restored.state.dictionaries[i].path, before.state.dictionaries[i].path);
  const mediaAfter = await request("hd_media", { dictionary: fixture.TITLE, path: fixture.MEDIA_PATH, generation: (await request("hd_status")).generation });
  assert.equal(mediaAfter.dataUrl, mediaBefore.dataUrl);
  assert.ok(mediaAfter.dataUrl?.startsWith("data:image/png;base64,"));
  assert.deepEqual((await request("hd_styles")).styles, stylesBefore.styles);
  assert.ok((await request("hd_lookup", { text: "食べたかった" })).results.length > 0);
  await screenshot("after.png");
  pass({ dictionaries: restored.state.dictionaries.length, groups: restored.state.groups.length, mediaBytes: mediaAfter.dataUrl.length });

  const second = await save("restored.zip");
  assert.deepEqual(comparable(second.archive.snapshot), comparable(first.archive.snapshot));
  assert.deepEqual(second.archive.lookupStatsRows, first.archive.lookupStatsRows);
  assert.deepEqual(second.archive.files.map(file => file.path), first.archive.files.map(file => file.path));
  for (let i = 0; i < first.archive.files.length; i++) {
    assert.deepEqual(Buffer.from(await second.archive.files[i].data.arrayBuffer()), Buffer.from(await first.archive.files[i].data.arrayBuffer()), first.archive.files[i].path);
  }
  pass({ files: second.archive.files.length, bytes: second.bytes.length });
  window.webContents.debugger.detach();
  window.destroy();

  ses.extensions.removeExtension(loaded.id);
}
app.whenReady().then(run).then(() => {
  clearTimeout(deadline);
  console.log(`RESULT ${passed}/${planned.length} passed; artifacts: ${artifacts}`);
  app.exit(0);
}).catch(error => {
  clearTimeout(deadline);
  console.error(`RESULT ${passed}/${planned.length} passed`, error);
  console.error(`Failure profile and artifacts retained: ${temporary}`);
  app.exit(1);
});
