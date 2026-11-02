// The search page's clipboard monitor (#639), after Yomitan's
// (yomidevs/yomitan@ac1d839 ext/js/comm/clipboard-monitor.js and
// clipboard-reader.js). The search page polls; the offscreen document, or the
// frame in Firefox's background page, reads the clipboard for it.
// SPDX-License-Identifier: GPL-3.0-or-later

// The runtime message target the search page asks the worker, and the worker
// asks the offscreen document, to read the clipboard with.
export const CLIPBOARD_TARGET = "hachidori-clipboard";

// Yomitan's interval: the next read starts this long after the last one ended.
export const CLIPBOARD_POLL_MS = 250;

// Reads the clipboard through `read` until stopped and calls `change` with
// each new text, trimmed. The first read is where it starts, so text that was
// on the clipboard before is not reported; a failed or empty read reports
// nothing.
export function createClipboardMonitor({ read, change, interval = CLIPBOARD_POLL_MS, scope = globalThis }) {
  let token = null;
  let timer = null;
  let previous = null;

  function stop() {
    token = null;
    previous = null;
    if (timer !== null) scope.clearTimeout(timer);
    timer = null;
  }

  function start() {
    stop();
    // A read that ends after stop() or another start() is dropped.
    const own = {};
    let canChange = false;
    token = own;
    const tick = async () => {
      timer = null;
      let text = null;
      try {
        text = await read();
      } catch {
        // As in Yomitan: a read that fails is no text.
      }
      if (token !== own) return;
      if (typeof text === "string" && (text = text.trim()) !== "" && text !== previous) {
        previous = text;
        if (canChange) change(text);
      }
      canChange = true;
      timer = scope.setTimeout(tick, interval);
    };
    void tick();
  }

  return { start, stop, get running() { return token !== null; } };
}

// Yomitan's ClipboardReader.getText. Chrome reads by pasting into a text area
// of this document, which needs neither focus nor a prompt once Hachidori has
// the clipboardRead permission, where navigator.clipboard.readText() needs
// both. Firefox's paste command sometimes fails (Mozilla bug 1603985), so it
// reads with navigator.clipboard.readText().
export async function readClipboardText({ document, navigator, firefox }) {
  if (firefox) return navigator.clipboard.readText();
  const target = document.body.appendChild(document.createElement("textarea"));
  try {
    target.focus();
    document.execCommand("paste");
    return target.value;
  } finally {
    target.remove();
  }
}
