// SPDX-License-Identifier: GPL-3.0-or-later
// This frame has an opaque origin, no extension API, and no network. Its one
// parent-owned port carries only template source/data and rendered strings.
(() => {
  let connected = false;
  globalThis.addEventListener("message", event => {
    if (connected || event.source !== globalThis.parent || event.data?.kind !== "hd-anki-template-connect"
        || event.ports.length !== 1) return;
    connected = true;
    const port = event.ports[0];
    const handlebars = globalThis.HDHandlebars.create();
    const escape = handlebars.Utils.escapeExpression;
    // Escaped data keeps literal cloze examples as text. Authored template
    // braces and deliberately raw triple-brace HTML retain their own meaning.
    handlebars.Utils.escapeExpression = value => escape(value).replaceAll("{", "&#123;").replaceAll("}", "&#125;");
    port.onmessage = ({ data }) => {
      try {
        const render = handlebars.compile(data.value);
        const html = render(data.context, {
          allowProtoMethodsByDefault: false, allowProtoPropertiesByDefault: false,
          helpers: { marker: name => new handlebars.SafeString(Object.hasOwn(data.markers, name.toLowerCase())
            ? data.markers[name.toLowerCase()] : "") },
        });
        port.postMessage({ id: data.id, html });
      } catch (error) {
        port.postMessage({ id: data.id, error: String(error.message || "The Handlebars template could not be rendered.") });
      }
    };
    port.postMessage({ ready: true });
  });
})();
