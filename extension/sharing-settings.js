// Settings → Sharing: turn this Hachidori into a host for other browsers on
// this computer, or use another Hachidori instead of this one.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_BRIDGE_PORT, formatLinkAddress } from "./sharing-protocol.js";

const POLL_MS = 2000;

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

export function createSharingSettingsController({ document, chrome, send, setStatus }) {
  const element = id => document.getElementById(id);
  let sharing = null;
  let pending = false;
  let timer = null;
  let sequence = 0;
  // A port typed while sharing is off survives status polls until the switch is used.
  let portDraft = null;

  function installCommand() {
    return `node bridge/install.mjs --extension-id ${chrome.runtime.id}`;
  }

  function renderStatus() {
    if (sharing === null) return;
    if (!sharing.enabled) setStatus("Not sharing.", undefined);
    else if (sharing.error !== null) setStatus(`Sharing is on, but the bridge is not running: ${sharing.error}`, "error");
    else if (!sharing.connected) setStatus("Starting the bridge…", undefined);
    else setStatus(`Sharing on port ${sharing.port}.`, "ready");
  }

  function render() {
    const enabled = sharing?.enabled === true;
    const toggle = element("sharing-host-enabled");
    if (toggle.checked !== enabled) toggle.checked = enabled;
    toggle.disabled = pending || sharing === null;
    const port = element("sharing-host-port");
    if (portDraft === null && sharing !== null && port.value !== String(sharing.port)) port.value = String(sharing.port);
    port.disabled = pending || enabled;
    element("sharing-host-address").value = enabled ? sharing.address : formatLinkAddress({ port: Number(port.value) || DEFAULT_BRIDGE_PORT });
    const clients = sharing?.clients ?? [];
    element("sharing-host-clients").textContent = !enabled || !sharing.connected ? ""
      : clients.length === 0 ? "No other browser is linked yet."
        : `Linked: ${clients.map(client => client.name || "another browser").join(", ")}.`;
    element("sharing-install-command").textContent = installCommand();
    if (sharing?.error !== null && sharing?.error !== undefined) element("sharing-install").open = true;
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
  async function run(action) {
    const operation = action();
    pending = true;
    sequence += 1;
    render();
    let failure = null;
    try {
      const reply = await operation;
      if (!reply.ok) throw new Error(reply.error || "The request did not complete.");
      sharing = reply.sharing;
      portDraft = null;
    } catch (error) {
      failure = error;
    } finally {
      pending = false;
      render();
    }
    // The failure outranks the rendered status until the next poll.
    if (failure !== null) setStatus(describe(failure), "error");
  }

  element("sharing-host-enabled").addEventListener("change", (event) => {
    if (event.target.checked) {
      const portValue = Number(element("sharing-host-port").value) || DEFAULT_BRIDGE_PORT;
      void run(async () => {
        const granted = chrome.permissions ? await chrome.permissions.request({ permissions: ["nativeMessaging"] }) : true;
        if (!granted) throw new Error("Chrome did not allow Hachidori to start the bridge.");
        return send("hd_sharing_host_enable", { port: portValue });
      });
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
