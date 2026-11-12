// User-script-world and same-world Anki preparation. This factory is also
// serialized into overlay pages by scripting.executeScript.
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  function installAnkiPreparationRuntime() {
    if (globalThis.HDAnkiPreparation) return;
    const packages = new Map();
    let currentPackage = null, native = false, port = null;
    const pending = new Map(), active = new Set();
    let sequence = 0;
    const unavailable = () => new Error("The Anki preparation script is unavailable. Enable user scripts and reload this page.");
    function descriptors() {
      return [...packages].filter(([, entry]) => entry.handlers.size > 0).map(([scriptId, entry]) => ({ scriptId, source: entry.source, handlers: [...entry.handlers.keys()] }));
    }
    function connect() {
      if (!native || port) return;
      const registered = descriptors();
      if (registered.length === 0) return;
      try {
        port = globalThis.chrome.runtime.connect({ name: "hachidori-anki-preparation" });
        port.onDisconnect.addListener(() => {
          port = null;
          active.clear();
          for (const operation of pending.values()) operation.reject(unavailable());
          pending.clear();
        });
        port.onMessage.addListener(async message => {
          if (message?.type === "execute") {
            active.add(message.operationId);
            try {
              const data = await execute(message.script, message.context, (url, options) => new Promise((resolve, reject) => {
                if (!active.has(message.operationId)) { reject(new Error("The Anki preparation was cancelled.")); return; }
                const id = `${++sequence}`;
                pending.set(id, { resolve, reject, operationId: message.operationId });
                port.postMessage({ type: "fetch", id, operationId: message.operationId, url, options });
              }));
              port?.postMessage({ type: "result", operationId: message.operationId, data });
            } catch {
              // Errors can contain prompts, API credentials or returned card
              // text. Only this fixed failure crosses the diagnostics boundary.
              port?.postMessage({ type: "result", operationId: message.operationId, failed: true });
            } finally { active.delete(message.operationId); }
          } else if (message?.type === "cancel") {
            active.delete(message.operationId);
            for (const [id, operation] of pending) if (operation.operationId === message.operationId) {
              pending.delete(id); operation.reject(new Error("The Anki preparation was cancelled."));
            }
          } else if (message?.type === "fetch-result") {
            const operation = pending.get(message.id);
            if (!operation) return;
            pending.delete(message.id);
            if (message.failed) operation.reject(new Error("The preparation request failed."));
            else operation.resolve(message.response);
          }
        });
        port.postMessage({ type: "register", packages: registered });
      } catch {
        port = null;
      }
    }
    function response(value) {
      return { ok: value.ok, status: value.status, headers: value.headers,
        text: async () => value.body, json: async () => JSON.parse(value.body) };
    }
    async function execute(script, context, request) {
      const handler = packages.get(script.scriptId)?.handlers.get(script.handlerId);
      if (!handler) throw unavailable();
      return handler(JSON.parse(JSON.stringify(context)), { request: async (url, options = {}) => response(await request(url, options)) });
    }
    globalThis.HDAnkiPreparation = Object.freeze({
      register(handlerId, prepare) {
        if (!currentPackage || typeof handlerId !== "string" || !handlerId.trim() || typeof prepare !== "function") {
          throw new TypeError("Register an Anki preparation function while its user script loads.");
        }
        currentPackage.handlers.set(handlerId, prepare);
        if (port) port.postMessage({ type: "register", packages: descriptors() });
        else connect();
      },
      runPackage(scriptId, run) {
        const previous = currentPackage;
        const entry = { source: Function.prototype.toString.call(run), handlers: new Map() };
        packages.set(scriptId, entry);
        currentPackage = entry;
        try { return run.call(globalThis); }
        finally { currentPackage = previous; }
      },
      enableNative() {
        if (native) return;
        native = true;
        // Opening the next popup reconnects a script whose worker went idle.
        // Page events can only reconnect; they never start preparation or fetch.
        globalThis.addEventListener("hachidori-popup-shown", connect);
        globalThis.addEventListener("hachidori-anki-preparation-connect", connect);
        connect();
      },
      describe(script) {
        const entry = packages.get(script.scriptId);
        return entry?.handlers.has(script.handlerId) ? { source: entry.source } : null;
      },
      execute,
    });
  }
  globalThis.HDAnkiPreparationFactory = installAnkiPreparationRuntime;
  installAnkiPreparationRuntime();
}());
