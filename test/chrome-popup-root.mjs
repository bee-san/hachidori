// Inspect the production popup through CDP without opening its shadow root to
// page scripts or other extensions. Callbacks receive the root, then their args.
// SPDX-License-Identifier: GPL-3.0-or-later
const sessions = new WeakMap();

export function popupRoot(page, documentUrl = page.url()) {
  if (!sessions.has(page)) sessions.set(page, page.createCDPSession());
  async function evaluate(callback, ...args) {
    const cdp = await sessions.get(page);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    function find(node, url) {
      const currentUrl = node.documentURL ?? url;
      if (currentUrl === documentUrl && node.nodeName === "HACHIDORI-HOST") return node.shadowRoots?.[0];
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
        const found = find(child, currentUrl);
        if (found) return found;
      }
      return null;
    }
    const shadow = find(root, root.documentURL);
    if (!shadow) return null;
    const { object } = await cdp.send("DOM.resolveNode", { nodeId: shadow.nodeId });
    try {
      const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function (...args) { return (${callback.toString()})(this, ...args); }`,
        arguments: args.map(value => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
    }
  }
  async function waitFor(callback, { timeout = 30_000 } = {}, ...args) {
    const deadline = Date.now() + timeout;
    do {
      const value = await evaluate(callback, ...args);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`Popup condition timed out: ${callback.toString()}`);
  }
  return { evaluate, waitFor };
}

// Benchmarks and the promo capture read the popup from the page's own code: an
// animation-frame loop, a MutationObserver. Once the content script has built
// its host, this hands that code the root as `window.__popupRoot`. Detaching
// the session then turns off the DOM agent DOM.getDocument enabled, which would
// otherwise report every later popup mutation over CDP during a measurement.
export async function exposePopupRoot(page, options) {
  try {
    await popupRoot(page).waitFor(root => { window.__popupRoot = root; return true; }, options);
  } finally {
    const session = sessions.get(page);
    sessions.delete(page);
    await (await session).detach();
  }
}
