window.results = [];
const frame = document.createElement("iframe");
window.addEventListener("message", (event) => { if (event.source === frame.contentWindow) window.results.push(event.data); });
frame.src = "frame.html";
document.body.append(frame);
