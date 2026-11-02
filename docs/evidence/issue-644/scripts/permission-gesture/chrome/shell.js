const api = globalThis.chrome;
window.results = [];
const frame = document.createElement("iframe");
frame.style.cssText = "width:400px;height:200px;border:0";
const attempt = async (why) => {
  const entry = { why, active: navigator.userActivation?.isActive ?? null };
  const settled = api.permissions.request({ permissions: ["clipboardRead"] }).then(r => ({ result: r }), e => ({ error: String(e?.message ?? e) }));
  entry.outcome = await Promise.race([settled, new Promise(r => setTimeout(() => r({ pending: true }), 1500))]);
  window.results.push(entry);
};
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || !event.ports[0]) return;
  event.ports[0].onmessage = () => { void attempt("after a click in the frame"); };
});
frame.src = "frame.html";
document.body.append(frame);
setTimeout(() => { void attempt("no click"); }, 300);
