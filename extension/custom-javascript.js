// SPDX-License-Identifier: GPL-3.0-or-later

export const SCRIPT_ID = "hachidori-custom-javascript";
let application = Promise.resolve();

// One package's JavaScript as a user-script source: inside a function of its
// own, so `return` works at its top level (docs/search-history.md) and two
// packages' top-level names cannot collide. The source URL names the package
// in the console's errors and stack traces.
export function userScriptSource(script) {
  return `(function () {\n${script.javascript}\n}).call(globalThis);\n//# sourceURL=hachidori-user-script/${encodeURIComponent(script.name)}.js`;
}

// Chrome MV3 `userScripts` registration (Advanced → User scripts): the bridge,
// then each switched-on package's JavaScript in list order, one source each,
// so a package that throws does not stop the next. Hosts without a
// USER_SCRIPT world leave saved code inert and hide the section through host
// capabilities. The bridge runs first in the same world, so the packages reach
// the popup's closed root through host.shadowRoot (custom-javascript-bridge.js).
async function apply(browser, scripts) {
  let api;
  try {
    api = browser.userScripts;
    await api.getScripts({ ids: [SCRIPT_ID] });
  } catch {
    return { supported: false, registered: false };
  }
  await api.unregister({ ids: [SCRIPT_ID] }).catch(() => {});
  const sources = globalThis.HDReaderOptions.javaScriptUserScripts(scripts).map(script => ({ code: userScriptSource(script) }));
  if (sources.length === 0) return { supported: true, registered: false };
  await api.register([{
    id: SCRIPT_ID,
    matches: ["<all_urls>"],
    js: [{ file: "custom-javascript-bridge.js" }, ...sources],
    runAt: "document_idle",
    world: "USER_SCRIPT",
  }]);
  return { supported: true, registered: true };
}

export function applyCustomJavaScript(browser, scripts) {
  application = application.catch(() => {}).then(() => apply(browser, scripts));
  return application;
}
