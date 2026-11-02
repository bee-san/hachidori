const api = globalThis.browser ?? globalThis.chrome;
window.results = [];
const frame = document.createElement("iframe");
frame.style.cssText = "width:400px;height:200px;border:0";
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || !event.ports[0]) return;
  const [port] = event.ports;
  port.onmessage = async ({ data }) => {
    const entry = { asked: data, activeBefore: navigator.userActivation?.isActive ?? null };
    try {
      entry.result = await api.permissions.request({ permissions: ["clipboardRead"] });
    } catch (error) {
      entry.error = String(error?.message ?? error);
    }
    window.results.push(entry);
  };
});
frame.src = "frame.html";
document.body.append(frame);
