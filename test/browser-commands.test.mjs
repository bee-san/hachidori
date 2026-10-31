// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import "../extension/reader-options.js";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

function worker(stored) {
  const writes = [], queued = [], errors = [], tabMessages = [], searches = [];
  let onCommand = null, openedSettings = 0;
  const context = vm.createContext({
    openSearchPage: async (api, mode, tab) => { searches.push({ mode, tab }); },
    sharingReady: Promise.resolve(),
    sharingLinked: false,
    WORKER_TARGET: "hoshidicts-worker",
    readDictionaryStorage: async () => ({ state: null, options: stored }),
    optionsRevision: options => Number.isInteger(options?.revision) ? options.revision : 0,
    normaliseOptions: globalThis.HDReaderOptions.normaliseOptions,
    WORKER_HANDLERS: { hd_options_write: async message => { writes.push(message); return { options: {} }; } },
    serialiseStorage: job => { const run = job(); queued.push(run); return run; },
    describeErrorOrJson: String,
    console: { error: (...args) => errors.push(args.join(" ")) },
    chrome: {
      commands: { onCommand: { addListener(listener) { onCommand = listener; } } },
      runtime: { openOptionsPage: async () => { openedSettings += 1; } },
      tabs: { sendMessage: async (tabId, message) => { tabMessages.push({ tabId, message }); } },
    },
  });
  vm.runInContext(background.slice(background.indexOf("// Yomitan's native browser shortcuts"),
    background.indexOf("// Alarms may be cleared across browser restarts")), context);
  return { writes, queued, errors, tabMessages, searches, command: (name, tab) => onCommand(name, tab),
    settle: async () => {
      // The toggle first waits for sharing initialization before joining the queue.
      await new Promise(resolveDone => setImmediate(resolveDone));
      await Promise.all(queued);
      assert.deepEqual(errors, []);
    },
    openedSettings: () => openedSettings };
}

test("browser commands toggle lookups through the queued revisioned write and open Settings", async () => {
  assert.equal(manifest.commands.toggleTextScanning.suggested_key.default, "Alt+Delete");
  assert.equal(typeof manifest.commands.openSettingsPage.description, "string");

  const enabled = worker({ revision: 7, hoverEnabled: true });
  enabled.command("toggleTextScanning");
  await enabled.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(enabled.writes)), [{ target: "hoshidicts-worker", type: "hd_options_write", requestId: null,
    baseRevision: 7, options: { hoverEnabled: false } }]);

  const legacy = worker(undefined);
  legacy.command("toggleTextScanning");
  await legacy.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.writes[0].options)), { hoverEnabled: false }, "missing options toggle the default");
  assert.equal(legacy.writes[0].baseRevision, 0);

  const other = worker({ revision: 1, hoverEnabled: false });
  other.command("openSettingsPage");
  other.command("openPreferences");
  await new Promise(resolveDone => setImmediate(resolveDone));
  assert.equal(other.openedSettings(), 1);
  assert.equal(other.queued.length, 0, "only the toggle writes options");
  assert.deepEqual(other.errors, []);
});

// Issue #610: Yomitan's three search page shortcuts, with its suggested Alt+Insert.
const SEARCH_COMMANDS = { openSearchPage: "existingOrNewTab", openSearchPageCurrentTab: "existingOrCurrentTab",
  openPopupWindow: "popup" };

test("search page browser commands open the search page in a new tab, the current tab or a popup window", async () => {
  assert.equal(manifest.commands.openSearchPage.suggested_key.default, "Alt+Insert");
  for (const name of ["openSearchPageCurrentTab", "openPopupWindow"]) {
    assert.equal(manifest.commands[name].suggested_key, undefined, `${name} has no suggested key, as in Yomitan`);
  }
  const commands = worker({ revision: 1 });
  for (const name of Object.keys(SEARCH_COMMANDS)) commands.command(name, { id: 9 });
  await new Promise(resolveDone => setImmediate(resolveDone));
  assert.deepEqual(JSON.parse(JSON.stringify(commands.searches)),
    Object.values(SEARCH_COMMANDS).map(mode => ({ mode, tab: { id: 9 } })));
  assert.deepEqual(commands.tabMessages, [], "no search command reaches the reader");
  assert.equal(commands.queued.length, 0);
  assert.deepEqual(commands.errors, []);
});

test("popup-action browser commands reach the active tab's reader as keybind actions", () => {
  const argumentFree = globalThis.HDReaderOptions.KEYBIND_ACTIONS
    .filter(({ id, argument }) => id !== "" && id !== "toggleOption" && !["audioSource", "option"].includes(argument))
    .map(({ id }) => id);
  const readerCommands = Object.keys(manifest.commands)
    .filter(name => !["toggleTextScanning", "openSettingsPage", ...Object.keys(SEARCH_COMMANDS)].includes(name));
  assert.deepEqual([...readerCommands].sort(), argumentFree.sort(), "every keybind action without a chosen argument is a browser command");

  const commands = worker({ revision: 1 });
  for (const name of readerCommands) commands.command(name, { id: 4 });
  commands.command("addNote", undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(commands.tabMessages)), readerCommands.map(action => ({ tabId: 4,
    message: { target: "hachidori-reader", type: "hd_reader_command", action } })));
  assert.equal(commands.queued.length, 0);
});
