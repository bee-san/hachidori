const { port1, port2 } = new MessageChannel();
window.parent.postMessage({ type: "offer" }, location.origin, [port2]);
document.addEventListener("change", (event) => { port1.postMessage({ checked: event.target.checked, at: "change" }); });
