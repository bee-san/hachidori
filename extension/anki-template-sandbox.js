// SPDX-License-Identifier: GPL-3.0-or-later
// Compiling user-entered templates is confined to the dedicated sandbox. This
// module creates no frame until a field explicitly selects Handlebars.
const sandboxes = new WeakMap();
export function renderHandlebars(document, value, context, markers) {
  let sandbox = sandboxes.get(document);
  if (!sandbox) {
    const window = document.defaultView;
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.title = "Anki field template renderer";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = new URL("./anki-template-frame.html", import.meta.url).href;
    const waiting = new Map();
    let nextId = 0, port;
    const ready = new Promise((resolve, reject) => {
      frame.addEventListener("error", () => reject(new Error("The Anki template sandbox could not load.")), { once: true });
      frame.addEventListener("load", () => {
        const channel = new window.MessageChannel();
        port = channel.port1;
        port.onmessage = ({ data }) => {
          if (data.ready === true) { resolve(); return; }
          const request = waiting.get(data.id);
          if (!request) return;
          waiting.delete(data.id);
          if (data.error) request.reject(new Error(data.error));
          else request.resolve(data.html);
        };
        frame.contentWindow.postMessage({ kind: "hd-anki-template-connect" }, "*", [channel.port2]);
      }, { once: true });
    });
    sandbox = async (value, context, markers) => {
      await ready;
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        waiting.set(id, { resolve, reject });
        port.postMessage({ id, value, context, markers });
      });
    };
    window.addEventListener("pagehide", () => {
      for (const request of waiting.values()) request.reject(new Error("The Anki template renderer was closed."));
      waiting.clear();
      port?.close();
      frame.remove();
      sandboxes.delete(document);
    }, { once: true });
    sandboxes.set(document, sandbox);
    document.body.append(frame);
  }
  return sandbox(value, context, markers);
}
