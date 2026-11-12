// Explicit Add owns each preparation and every privileged script fetch. A
// browser page cannot obtain a user-script port or a reader's operation token.
// SPDX-License-Identifier: GPL-3.0-or-later

export function preparationData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Preparation must return an object of JSON values.");
  const encoded = JSON.stringify(value, (_key, item) => {
    if (["undefined", "function", "symbol", "bigint"].includes(typeof item)
        || (typeof item === "number" && !Number.isFinite(item))) throw new TypeError("Preparation must return JSON values.");
    return item;
  });
  return JSON.parse(encoded);
}

const sameDocument = (left, right) => left?.id === right?.id && left?.tab?.id === right?.tab?.id
  && (left?.documentId || right?.documentId ? left?.documentId === right?.documentId : left?.frameId === right?.frameId);
const scriptSource = script => `function () {\n${script.javascript}\n}`;

export function createAnkiPreparationService({ readScripts, fetch: fetchRequest = globalThis.fetch }) {
  const connections = new Set(), documents = new Set(), operations = new Map();
  let lastFailure = null;
  async function available(script, source) {
    const saved = (await readScripts()).find(entry => entry.id === script?.scriptId && entry.enabled && entry.javascript.trim());
    if (!saved) throw new Error("The preparation script is disabled or unavailable.");
    if (scriptSource(saved) !== source) throw new Error("The preparation script changed. Reload this page before adding a note.");
    return saved;
  }
  async function begin(sender, script, source, connection = null) {
    await available(script, source);
    const operationId = crypto.randomUUID();
    operations.set(operationId, { sender, script, source, connection, controllers: new Set() });
    return operationId;
  }
  function owned(sender, operationId) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error("No active Anki preparation owns this request.");
    if (!sameDocument(operation.sender, sender)) throw new Error("The preparation belongs to another document.");
    return operation;
  }
  function cancel(sender, operationId) {
    const operation = owned(sender, operationId);
    operations.delete(operationId);
    for (const controller of operation.controllers) controller.abort();
  }
  async function finish(sender, operationId, data) {
    const operation = owned(sender, operationId);
    try {
      await available(operation.script, operation.source);
      owned(sender, operationId);
      return preparationData(data);
    } finally { if (operations.has(operationId)) cancel(sender, operationId); }
  }
  async function request(sender, operationId, address, options = {}) {
    const operation = owned(sender, operationId);
    await available(operation.script, operation.source);
    owned(sender, operationId); // A navigation may have cancelled it during the storage read.
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Preparation requests require an HTTP or HTTPS address.");
    const controller = new AbortController();
    operation.controllers.add(controller);
    try {
      const result = await fetchRequest(url.href, { method: options.method ?? "GET", headers: options.headers,
        body: options.body, credentials: "omit", signal: controller.signal });
      return { ok: result.ok, status: result.status, headers: Object.fromEntries(result.headers), body: await result.text() };
    } finally { operation.controllers.delete(controller); }
  }
  function disconnect(connection) {
    for (const [operationId, operation] of operations) {
      if (operation.connection !== connection) continue;
      operation.reject?.(new Error("The preparation document disconnected. No note was sent."));
      cancel(operation.sender, operationId);
    }
  }
  function connectLifecycle(port) {
    if (port.name !== "hachidori-anki-preparation-document") return;
    const connection = { port };
    documents.add(connection);
    port.onDisconnect.addListener(() => { documents.delete(connection); disconnect(connection); });
  }
  async function beginDocument(sender, script, source) {
    const connection = [...documents].find(item => sameDocument(item.port.sender, sender));
    if (!connection) throw new Error("The preparation document disconnected. Reload this page before adding a note.");
    const operationId = await begin(sender, script, source, connection);
    if (!documents.has(connection)) {
      cancel(sender, operationId);
      throw new Error("The preparation document disconnected. No note was sent.");
    }
    return operationId;
  }
  function connect(port) {
    if (port.name !== "hachidori-anki-preparation") return;
    const connection = { port, packages: [] };
    connections.add(connection);
    port.onDisconnect.addListener(() => {
      connections.delete(connection);
      disconnect(connection);
    });
    port.onMessage.addListener(message => {
      if (message?.type === "register" && Array.isArray(message.packages)) {
        connection.packages = message.packages.filter(entry => typeof entry?.scriptId === "string"
          && typeof entry.source === "string" && Array.isArray(entry.handlers) && entry.handlers.every(id => typeof id === "string"));
      } else if (message?.type === "fetch") {
        const operation = operations.get(message.operationId);
        if (operation?.connection !== connection) return;
        void request(port.sender, message.operationId, message.url, message.options).then(response => {
          if (operations.has(message.operationId)) port.postMessage({ type: "fetch-result", id: message.id, response });
        }, () => {
          lastFailure = "request";
          if (operations.has(message.operationId)) port.postMessage({ type: "fetch-result", id: message.id, failed: true });
        });
      } else if (message?.type === "result") {
        const operation = operations.get(message.operationId);
        if (operation?.connection !== connection) return;
        if (message.failed) {
          lastFailure = "script";
          operation.reject(new Error("The preparation script failed. No note was sent."));
          cancel(port.sender, message.operationId);
        } else {
          void finish(port.sender, message.operationId, message.data).then(operation.resolve, operation.reject);
        }
      }
    });
  }
  async function execute(sender, script, context) {
    const connection = [...connections].find(entry => sameDocument(entry.port.sender, sender)
      && entry.packages.some(item => item.scriptId === script.scriptId && item.handlers.includes(script.handlerId)));
    if (!connection) throw new Error("The preparation script is unavailable in this document. Enable user scripts and reload this page.");
    const entry = connection.packages.find(item => item.scriptId === script.scriptId);
    const operationId = await begin(sender, script, entry.source, connection);
    return new Promise((resolve, reject) => {
      Object.assign(operations.get(operationId), { resolve, reject });
      try { connection.port.postMessage({ type: "execute", operationId, script, context }); }
      catch (error) { cancel(sender, operationId); reject(error); }
    });
  }
  function diagnostics() {
    return { registeredDocuments: connections.size + documents.size,
      registeredHandlers: [...connections].reduce((sum, item) => sum + item.packages.reduce((n, entry) => n + entry.handlers.length, 0), 0),
      activePreparations: operations.size, lastFailure };
  }
  return { connect, connectLifecycle, execute, begin, beginDocument, finish, cancel, request, diagnostics };
}
