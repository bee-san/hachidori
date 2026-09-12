// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import "../extension/reader-options.js";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

function worker(stored) {
  const writes = [], queued = [], errors = [];
  let onCommand = null, openedSettings = 0;
  const context = vm.createContext({
    readDictionaryStorage: async () => ({ state: null, options: stored }),
    optionsRevision: options => Number.isInteger(options?.revision) ? options.revision : 0,
    normaliseOptions: globalThis.HDReaderOptions.normaliseOptions,
    WORKER_HANDLERS: { hd_options_write: async message => { writes.push(message); return { options: {} }; } },
    serialiseStorage: job => { const run = job(); queued.push(run); return run; },
    describe: String,
    console: { error: (...args) => errors.push(args.join(" ")) },
    chrome: {
      commands: { onCommand: { addListener(listener) { onCommand = listener; } } },
      runtime: { openOptionsPage: async () => { openedSettings += 1; } },
    },
  });
  vm.runInContext(background.slice(background.indexOf("// Yomitan's native browser shortcuts"),
    background.indexOf("// Alarms may be cleared across browser restarts")), context);
  return { writes, queued, errors, command: name => onCommand(name), openedSettings: () => openedSettings };
}

test("browser commands toggle lookups through the queued revisioned write and open Settings", async () => {
  assert.equal(manifest.commands.toggleTextScanning.suggested_key.default, "Alt+Delete");
  assert.equal(typeof manifest.commands.openSettingsPage.description, "string");

  const enabled = worker({ revision: 7, hoverEnabled: true });
  enabled.command("toggleTextScanning");
  await Promise.all(enabled.queued);
  assert.deepEqual(JSON.parse(JSON.stringify(enabled.writes)), [{ type: "hd_options_write", requestId: null,
    baseRevision: 7, options: { hoverEnabled: false } }]);

  const legacy = worker(undefined);
  legacy.command("toggleTextScanning");
  await Promise.all(legacy.queued);
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.writes[0].options)), { hoverEnabled: false }, "missing options toggle the default");
  assert.equal(legacy.writes[0].baseRevision, 0);

  const other = worker({ revision: 1, hoverEnabled: false });
  other.command("openSettingsPage");
  other.command("openSearchPage");
  await new Promise(resolveDone => setImmediate(resolveDone));
  assert.equal(other.openedSettings(), 1);
  assert.equal(other.queued.length, 0, "only the toggle writes options");
  assert.deepEqual(other.errors, []);
});
