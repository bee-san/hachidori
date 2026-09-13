// Settings → Sharing: turn this Hachidori into a host for other browsers on
// this computer, or use another Hachidori instead of this one.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_SHARING_PORT, formatLinkAddress } from "./sharing-protocol.js";

const POLL_MS = 2000;

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

export function createSharingSettingsController({
  document, send, setStatus, reload = () => document.defaultView.location.reload(),
}) {
  const element = id => document.getElementById(id);
  let sharing = null;
  let pending = false;
  let timer = null;
  let sequence = 0;
  // A port typed while sharing is off survives status polls until the switch is used.
  let portDraft = null;
  let found = null;

  function client() {
    return sharing?.client ?? null;
  }

  function linked() {
    return client()?.linked === true;
  }

  function hostSummary(host, address) {
    const dictionaries = host?.dictionaryCount === 1 ? "1 dictionary" : `${host?.dictionaryCount ?? 0} dictionaries`;
    return `Hachidori ${host?.version || "?"} with ${dictionaries} at ${address}`;
  }

  function renderStatus() {
    if (sharing === null) return;
    if (linked()) {
      const link = client();
      if (link.connected) setStatus(`Using the ${hostSummary(link.host, link.address)}.`, "ready");
      else setStatus(`Linked to ${link.address}, but it is not reachable: ${link.error ?? "waiting for it to answer"}.`, "error");
      return;
    }
    if (!sharing.enabled) setStatus("Not sharing.", undefined);
    else if (sharing.error !== null) setStatus(`Sharing is on, but ${sharing.error}`, "error");
    else if (!sharing.connected) setStatus("Sharing is on. Waiting for GameSentenceMiner or the Anki add-on to start.", undefined);
    else setStatus(`Sharing through ${sharing.relay} on port ${sharing.port}.`, "ready");
  }

  function renderHost() {
    const enabled = sharing?.enabled === true;
    const toggle = element("sharing-host-enabled");
    if (toggle.checked !== enabled) toggle.checked = enabled;
    toggle.disabled = pending || sharing === null;
    const port = element("sharing-host-port");
    if (portDraft === null && sharing !== null && port.value !== String(sharing.port)) port.value = String(sharing.port);
    port.disabled = pending || enabled;
    element("sharing-host-address").value = enabled ? sharing.address : formatLinkAddress({ port: Number(port.value) || DEFAULT_SHARING_PORT });
    const clients = sharing?.clients ?? [];
    element("sharing-host-clients").textContent = !enabled || !sharing.connected ? ""
      : clients.length === 0 ? "No other browser is linked yet."
        : `Linked: ${clients.map(entry => entry.name || "another browser").join(", ")}.`;
    // One install is either a host or a client, never both.
    element("sharing-host").disabled = linked();
  }

  function renderClient() {
    const link = client();
    const isLinked = linked();
    element("sharing-client").disabled = sharing?.enabled === true;
    element("sharing-client-find").hidden = isLinked;
    element("sharing-client-find").disabled = pending;
    element("sharing-client-use").hidden = isLinked || found === null;
    element("sharing-client-use").disabled = pending;
    element("sharing-client-found").textContent = isLinked || found === null ? "" : `Found ${hostSummary(found.host, found.address)}.`;
    element("sharing-client-address").parentElement.hidden = isLinked;
    element("sharing-client-address").disabled = pending;
    element("sharing-client-link").hidden = isLinked;
    element("sharing-client-link").disabled = pending;
    element("sharing-client-unlink").hidden = !isLinked;
    element("sharing-client-unlink").disabled = pending;
    element("sharing-client-status").textContent = !isLinked ? ""
      : link.connected ? `Linked to ${link.address}: ${hostSummary(link.host, link.address)}.`
        : `Linked to ${link.address}. Not reachable: ${link.error ?? "waiting"}.`;
  }

  function render() {
    renderHost();
    renderClient();
    renderStatus();
  }

  async function refresh() {
    const current = ++sequence;
    try {
      const reply = await send("hd_sharing_status");
      if (current !== sequence) return;
      if (!reply.ok) throw new Error(reply.error || "The sharing status could not be read.");
      sharing = reply.sharing;
    } catch (error) {
      if (current !== sequence) return;
      setStatus(`Cannot read the sharing status: ${describe(error)}`, "error");
      return;
    }
    render();
  }

  // `action` runs synchronously so a permission request keeps its user gesture.
  async function run(action, onReply = null) {
    const operation = action();
    pending = true;
    sequence += 1;
    render();
    let failure = null;
    try {
      const reply = await operation;
      if (!reply.ok) throw new Error(reply.error || "The request did not complete.");
      if (reply.sharing) sharing = reply.sharing;
      portDraft = null;
      onReply?.(reply);
    } catch (error) {
      failure = error;
    } finally {
      pending = false;
      render();
    }
    // The failure outranks the rendered status until the next poll.
    if (failure !== null) setStatus(describe(failure), "error");
  }

  // Revision comparisons in every reader only adopt newer values, so a page
  // that just swapped its whole shared state starts over.
  function link(address) {
    void run(() => send("hd_sharing_client_link", { address }), () => reload());
  }

  element("sharing-host-enabled").addEventListener("change", (event) => {
    if (event.target.checked) {
      const portValue = Number(element("sharing-host-port").value) || DEFAULT_SHARING_PORT;
      void run(() => send("hd_sharing_host_enable", { port: portValue }));
    } else {
      void run(() => send("hd_sharing_host_disable"));
    }
  });
  element("sharing-host-port").addEventListener("input", () => {
    portDraft = element("sharing-host-port").value;
    render();
  });
  element("sharing-host-copy").addEventListener("click", () => {
    const address = element("sharing-host-address").value;
    document.defaultView.navigator.clipboard.writeText(address).then(
      () => setStatus(`Copied ${address}.`, "ready"),
      error => setStatus(`Could not copy the address: ${describe(error)}`, "error"),
    );
  });
  element("sharing-client-find").addEventListener("click", () => {
    found = null;
    void run(() => send("hd_sharing_client_probe", { address: element("sharing-client-address").value }), (reply) => {
      found = { address: reply.address, host: reply.host };
    });
  });
  element("sharing-client-use").addEventListener("click", () => {
    if (found !== null) link(found.address);
  });
  element("sharing-client-link").addEventListener("click", () => link(element("sharing-client-address").value));
  element("sharing-client-unlink").addEventListener("click", () => {
    void run(() => send("hd_sharing_client_unlink"), () => reload());
  });

  return {
    start() {
      if (timer !== null) return;
      void refresh();
      timer = document.defaultView.setInterval(() => { void refresh(); }, POLL_MS);
    },
    stop() {
      if (timer === null) return;
      document.defaultView.clearInterval(timer);
      timer = null;
    },
    render,
  };
}
