// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInContext } from 'node:vm';
import '../extension/vendor/languages/registry.js';
import '../extension/reader-options.js';
import { createMcpHost, mergeMcpPatch } from '../extension/mcp-host.js';
import { forwardableRequest, mutatingForwardedRequest } from '../extension/sharing-protocol.js';
import { loadBackgroundScript, makeBus, makeChrome, makeStorage } from './extension-smoke/fakes.mjs';

const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const plain = value => JSON.parse(JSON.stringify(value));

function host(stored = {}) {
  const storage = makeStorage();
  for (const [key, value] of Object.entries(stored)) storage.raw.set(key, structuredClone(value));
  const chrome = makeChrome('mcp-worker', makeBus(), storage);
  const context = loadBackgroundScript({ chrome, console: quiet, Promise, Error,
    HDLanguages: globalThis.HDLanguages,
    fetch: async () => ({ json: async () => ({ themes: [] }) }),
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout });
  const send = (type, fields = {}) => runInContext(`dispatchSharedRequest(${JSON.stringify({ target: 'hachidori-mcp', type, ...fields })}, 'mcp-client')`, context).then(plain);
  return { send, storage: chrome.storage };
}

test('MCP uses the ordinary serialized options writer, preserving nested credentials and refusing stale revisions', async () => {
  const env = host({ options: { revision: 4, anki: { apiKey: 'keep-secret' } } });
  const first = await env.send('hd_mcp_options_write', { baseRevision: 4, options: { anki: { url: "http://localhost:8765" } } });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.options.revision, 5);
  assert.notEqual(first.options.anki.apiKey, 'keep-secret');
  const actual = await env.storage.local.get('options');
  assert.equal(actual.options.anki.apiKey, 'keep-secret');
  const ankiEdit = await env.send('hd_mcp_options_write', { baseRevision: 5, options: { anki: { deck: 'French' } } });
  assert.equal(ankiEdit.ok, true, ankiEdit.error);
  assert.equal(ankiEdit.options.anki.templates[0].deck, 'French');
  assert.equal((await env.storage.local.get('options')).options.anki.apiKey, 'keep-secret');
  const conflict = await env.send('hd_mcp_options_write', { baseRevision: 4, options: { scanLength: 22 } });
  assert.equal(conflict.conflict, true);
  const invalid = await env.send('hd_mcp_options_write', { baseRevision: 6, options: { inventedOption: true } });
  assert.equal(invalid.ok, false);
});

test('editing one script preserves the others and toggling keeps store metadata', async () => {
  const scripts = [{ id: 'a', name: 'A', enabled: true, javascript: 'const apiKey = "secret";', css: '', store: { slug: 'a', version: '1' } },
    { id: 'b', name: 'B', enabled: true, javascript: '', css: '.b{}' }];
  const env = host({ options: { revision: 0, userScripts: scripts } });
  const toggle = await env.send('hd_mcp_user_script_write', { baseRevision: 0, id: 'a', script: { enabled: false } });
  assert.equal(toggle.ok, true, toggle.error);
  let stored = (await env.storage.local.get('options')).options;
  assert.deepEqual(stored.userScripts[0].store, scripts[0].store);
  assert.equal(stored.userScripts[0].javascript, scripts[0].javascript);
  const edit = await env.send('hd_mcp_user_script_write', { baseRevision: 1, id: 'a', script: { css: '.a{}' } });
  assert.equal(edit.ok, true, edit.error);
  stored = (await env.storage.local.get('options')).options;
  assert.equal(stored.userScripts[0].store, undefined);
  assert.deepEqual(stored.userScripts[1], scripts[1]);
  const invalid = await env.send('hd_mcp_user_script_write', { baseRevision: 2, id: 'c', script: { javascript: 'return;' } });
  assert.equal(invalid.ok, false, 'a new script needs a name');
});

test('description uses the production language/options registries and survives unavailable script permission', async () => {
  const invoke = createMcpHost({ read: async () => ({ options: { revision: 8, anki: { apiKey: 'hidden' } } }),
    userScripts: async () => { throw new Error('permission denied'); }, themes: async () => [], version: 'test' });
  const result = await invoke({ type: 'hd_mcp_describe' });
  assert.equal(result.profileId, 'ja');
  assert.ok(result.languages.some(pack => pack.code === 'fr'));
  assert.deepEqual(result.defaults, globalThis.HDReaderOptions.DEFAULT_OPTIONS);
  assert.equal(result.userScriptRuntime.available, false);
  assert.doesNotMatch(JSON.stringify(result), /hidden/u);
});

test('host language selection uses its revision and cannot silently succeed with multiple languages off', async () => {
  const env = host({ options: { revision: 3, experimental: { multipleLanguages: true },
    profiles: [{ id: 'ja', language: 'ja', settings: {}, packSettings: {} }, { id: 'fr', language: 'fr', settings: {}, packSettings: {} }] } });
  const selected = await env.send('hd_mcp_select_profile', { profileId: 'fr', baseRevision: 0, autoSwitch: false });
  assert.equal(selected.ok, true, selected.error);
  assert.equal(selected.selection.activeProfileId, 'fr');
  const conflict = await env.send('hd_mcp_select_profile', { profileId: 'ja', baseRevision: 0 });
  assert.equal(conflict.conflict, true);
  const disabled = host();
  assert.equal((await disabled.send('hd_mcp_select_profile', { profileId: 'ja', baseRevision: 0 })).ok, false);
});

test('MCP protocol marks mutations and recursive merge treats prototype keys as data', () => {
  assert.equal(forwardableRequest({ target: 'hachidori-mcp', type: 'hd_mcp_describe' }), true);
  assert.equal(mutatingForwardedRequest({ target: 'hachidori-mcp', type: 'hd_mcp_describe' }), false);
  assert.equal(mutatingForwardedRequest({ target: 'hachidori-mcp', type: 'hd_mcp_select_profile' }), true);
  mergeMcpPatch({}, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined);
});
