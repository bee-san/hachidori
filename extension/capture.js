// SPDX-License-Identifier: GPL-3.0-or-later
import { createCaptureSession } from "./capture-session.js";
import {
  MAX_TEXTHOOKER_FRAME_LENGTH,
  MAX_TEXTHOOKER_TEXT_LENGTH,
  parseTexthookerMessage,
} from "./texthooker-protocol.js";

const CAPTURE_TARGET = "hachidori-capture";
const PAGE_TARGET = "hachidori-capture-page";
const CONTENT_TARGET = "hachidori-capture-content";
const MAX_FRAME_BYTES = 256 * 1024;
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
const session = createCaptureSession();
let config;
let captureDocumentId = "";
let stream = null;
let frameTimer = null;
let frameBusy = false;
let audioContext = null;
let audioNode = null;
let texthooker = null;
let selectedTabId = null;
let linkedDocumentId = "";
let requestCounter = 0;

const timestamp = () => performance.timeOrigin + performance.now();
const describe = error => error instanceof Error ? error.message || String(error) : String(error);

async function send(type, fields = {}) {
  const reply = await chrome.runtime.sendMessage({
    target: CAPTURE_TARGET,
    type,
    requestId: `capture-${++requestCounter}`,
    ...fields,
  });
  if (!reply?.ok) throw new Error(reply?.error || "The capture service did not reply.");
  return reply;
}

async function register() {
  try {
    const reply = await send("hd_capture_register");
    captureDocumentId = reply.documentId;
  } catch (error) {
    elements["capture-error"].textContent = describe(error);
  }
}

function render() {
  const status = session.status();
  const recording = status.state === "recording";
  const linkedPage = Boolean(status.linkedPage);
  const duration = (oldest, newest) => Number.isFinite(oldest) && Number.isFinite(newest)
    ? `${Math.max(0, (newest - oldest) / 1000).toFixed(1)} s` : "0.0 s";
  elements["capture-state"].textContent = recording ? "Recording" : status.state === "disabled" ? "Disabled" : "Stopped";
  elements["capture-state"].classList.toggle("recording", recording);
  elements["capture-start"].disabled = recording || !config?.enabled;
  elements["capture-stop"].disabled = !recording;
  elements["link-page"].disabled = !recording;
  elements["select-video"].disabled = !recording || !linkedPage
    || config?.timingMode === "recent" || !config?.page.nativeCues;
  elements["track-area"].disabled = !recording || !linkedPage
    || config?.timingMode === "recent" || !config?.page.domText;
  elements["clear-area"].disabled = !recording || !linkedPage;
  elements["media-source"].textContent = status.mediaSource
    ? `${status.mediaSource.name} (${status.mediaSource.displaySurface})`
    : "No tab or window is being captured.";
  elements["capture-error"].textContent = status.error || "";
  elements["texthooker-status"].textContent = status.texthookerStatus;
  elements["video-history"].textContent = config?.includeAnimation
    ? `${duration(status.history.frameOldestMs, status.history.frameNewestMs)} · ${status.history.frameCount} frames · ${Math.round(status.history.frameBytes / 1024)} KiB`
    : "Disabled";
  elements["audio-history"].textContent = status.mediaSource && !status.mediaSource.audioAvailable
    ? "Source audio unavailable"
    : config?.includeCapturedAudio
      ? `${duration(status.history.audioOldestMs, status.history.audioNewestMs)} · ${status.history.audioSamples.toLocaleString()} samples`
      : "Disabled";
  elements["pin-status"].textContent = status.pinActive ? "Pinned" : "None";
  elements["linked-page"].textContent = status.linkedPage?.title || "No reading page is linked.";
}

function canvasBlob(canvas, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not compress a capture frame.")),
      "image/jpeg", quality);
  });
}

function captureDimensions(videoWidth, videoHeight) {
  const [maxWidth, maxHeight] = config.videoPreset === "compact" ? [480, 270] : [640, 360];
  const scale = Math.min(1, maxWidth / videoWidth, maxHeight / videoHeight);
  const width = Math.max(2, Math.floor(videoWidth * scale / 2) * 2);
  const height = Math.max(2, Math.floor(videoHeight * scale / 2) * 2);
  return { width, height };
}

async function captureFrame(canvas, context) {
  if (!stream || elements["capture-preview"].readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const ownedStream = stream;
  const at = timestamp();
  context.drawImage(elements["capture-preview"], 0, 0, canvas.width, canvas.height);
  let blob = await canvasBlob(canvas, 0.72);
  if (blob.size > MAX_FRAME_BYTES) blob = await canvasBlob(canvas, 0.5);
  if (blob.size > MAX_FRAME_BYTES || stream !== ownedStream) return;
  session.addFrame({
    timestampMs: at,
    width: canvas.width,
    height: canvas.height,
    data: new Uint8Array(await blob.arrayBuffer()),
  });
}

function startFrames() {
  const video = elements["capture-preview"];
  const { width, height } = captureDimensions(video.videoWidth, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  const fps = config.videoPreset === "compact" ? 6 : 8;
  frameTimer = setInterval(() => {
    if (frameBusy) return;
    frameBusy = true;
    void captureFrame(canvas, context)
      .catch(error => stopCapture(`Video capture stopped: ${describe(error)}`))
      .finally(() => { frameBusy = false; });
  }, Math.round(1000 / fps));
}

async function startAudio(sharedStream) {
  if (!sharedStream.getAudioTracks().length) return;
  audioContext = new AudioContext({ sampleRate: 48_000, latencyHint: "playback" });
  await audioContext.audioWorklet.addModule("capture-audio-worklet.js");
  const source = audioContext.createMediaStreamSource(new MediaStream(sharedStream.getAudioTracks()));
  audioNode = new AudioWorkletNode(audioContext, "hachidori-capture-audio");
  const silence = audioContext.createGain();
  silence.gain.value = 0;
  const originMs = timestamp() - audioContext.currentTime * 1000;
  audioNode.port.addEventListener("message", event => {
    if (!stream) return;
    const samples = new Float32Array(event.data.samples);
    session.addAudio({
      startMs: originMs + event.data.startFrame * 1000 / audioContext.sampleRate,
      sampleRate: audioContext.sampleRate,
      samples,
    });
  });
  audioNode.port.start();
  source.connect(audioNode).connect(silence).connect(audioContext.destination);
  await audioContext.resume();
}

function stopTexthooker() {
  texthooker?.stop();
  texthooker = null;
}

function createTexthooker() {
  let socket = null;
  let retryTimer = null;
  let stopped = false;
  let attempt = 0;
  let sequence = 0;
  let connectionEpoch = "";
  let sourceEpoch = "";
  let currentSession = "";
  const open = new Map();

  function closeOpen(at = timestamp()) {
    for (const record of open.values()) session.textClose(record, at);
    open.clear();
  }

  function schedule() {
    if (stopped) return;
    session.setTexthooker("Disconnected", false);
    render();
    const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    connectionEpoch = crypto.randomUUID();
    sourceEpoch = connectionEpoch;
    currentSession = "";
    sequence = 0;
    session.setTexthooker("Connecting", false);
    render();
    try {
      socket = new WebSocket(config.texthooker.url);
    } catch {
      schedule();
      return;
    }
    const owned = socket;
    owned.addEventListener("open", () => {
      if (socket !== owned) return;
      attempt = 0;
      session.setTexthooker("Connected — waiting for live text", false);
      render();
    });
    owned.addEventListener("message", event => {
      if (socket !== owned) return;
      if (typeof event.data !== "string" || event.data.length > MAX_TEXTHOOKER_FRAME_LENGTH) return;
      const parsed = parseTexthookerMessage(config.texthooker.format, event.data);
      if (!parsed || (parsed.type === "line" && parsed.text.length > MAX_TEXTHOOKER_TEXT_LENGTH)) return;
      const at = timestamp();
      if (parsed.type === "reset") {
        closeOpen(at);
        sourceEpoch = `${connectionEpoch}:reset:${++sequence}`;
        session.setTexthooker("Connected — waiting for live text", false);
        render();
        return;
      }
      if (parsed.sessionId && parsed.sessionId !== currentSession) {
        closeOpen(at);
        currentSession = parsed.sessionId;
        sourceEpoch = `${connectionEpoch}:${currentSession}`;
      }
      const occurrenceId = parsed.id || `${connectionEpoch}:${++sequence}`;
      if (!open.has(occurrenceId)) closeOpen(at);
      const record = {
        sourceKind: "texthooker",
        sourceId: "loopback-websocket",
        sourceEpoch,
        occurrenceId,
        text: parsed.text,
        startMs: at,
      };
      session.textBegin(record);
      open.set(occurrenceId, record);
      session.setTexthooker("Active", true);
      render();
    });
    owned.addEventListener("close", () => {
      if (socket !== owned) return;
      socket = null;
      closeOpen();
      schedule();
      render();
    });
    owned.addEventListener("error", () => owned.close());
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      closeOpen();
      const active = socket;
      socket = null;
      active?.close(1000, "Capture stopped");
      session.setTexthooker("Disconnected", false);
    },
  };
}

async function startCapture() {
  elements["capture-error"].textContent = "";
  try {
    const requested = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: config.videoPreset === "compact" ? 6 : 8,
          max: config.videoPreset === "compact" ? 6 : 8 },
      },
      audio: config.includeCapturedAudio,
      monitorTypeSurfaces: "exclude",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    });
    const videoTrack = requested.getVideoTracks()[0];
    if (!videoTrack) throw new Error("The selected source did not provide video.");
    const settings = videoTrack.getSettings();
    if (settings.displaySurface === "monitor") {
      requested.getTracks().forEach(track => track.stop());
      throw new Error("Choose a browser tab or application window, not an entire screen.");
    }
    stream = requested;
    session.start({
      sourceName: videoTrack.label || "Shared media",
      displaySurface: settings.displaySurface || "browser",
      audioAvailable: requested.getAudioTracks().length > 0,
    });
    videoTrack.addEventListener("ended", () => stopCapture("The shared source ended."));
    const preview = elements["capture-preview"];
    preview.srcObject = requested;
    preview.hidden = false;
    await preview.play();
    if (config.includeAnimation) startFrames();
    if (config.includeCapturedAudio) await startAudio(requested);
    if (config.timingMode === "auto" && config.texthooker.enabled) texthooker = createTexthooker();
  } catch (error) {
    stopCapture(describe(error));
  }
  render();
}

function stopCapture(error = "") {
  clearInterval(frameTimer);
  frameTimer = null;
  frameBusy = false;
  stopTexthooker();
  audioNode?.disconnect();
  audioNode = null;
  void audioContext?.close();
  audioContext = null;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  elements["capture-preview"].srcObject = null;
  elements["capture-preview"].hidden = true;
  if (Number.isInteger(selectedTabId)) {
    void send("hd_capture_unlink", { tabId: selectedTabId }).catch(() => {});
  }
  selectedTabId = null;
  linkedDocumentId = "";
  session.stop(error);
  render();
}

function linked(message) {
  return selectedTabId === message.tabId && linkedDocumentId === message.documentId;
}

function bytesToBase64(data) {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== PAGE_TARGET || message.relayed !== true
      || message.captureDocumentId !== captureDocumentId) return false;
  Promise.resolve().then(async () => {
    switch (message.type) {
      case "hd_capture_status": return session.status();
      case "hd_capture_linked":
        selectedTabId = message.page.tabId;
        linkedDocumentId = message.page.documentId;
        session.setLinkedPage(message.page);
        elements["page-status"].textContent = message.page.message || "Reading page linked.";
        elements["video-row"].hidden = message.page.videos.length < 2;
        elements["reading-video"].replaceChildren(...message.page.videos.map(video =>
          new Option(video.label, video.id)));
        render();
        return session.status();
      case "hd_capture_text_begin":
        if (!linked(message)) return { ignored: true };
        return session.textBegin(message.record);
      case "hd_capture_text_close":
        if (!linked(message)) return { ignored: true };
        return session.textClose(message.identity, message.endMs);
      case "hd_capture_text_source_close":
        if (!linked(message)) return { ignored: true };
        return session.closeTextSource(message.sourceKind, message.sourceId, message.sourceEpoch, message.endMs);
      case "hd_capture_page_status":
        if (!linked(message)) return { ignored: true };
        elements["page-status"].textContent = String(message.message || "").slice(0, 500);
        return { displayed: true };
      case "hd_capture_pin":
        if (!linked(message)) throw new Error("This lookup is not from the linked reading page.");
        return session.pinLookup(message.lookup);
      case "hd_capture_release": return { released: session.releasePin(message.token) };
      case "hd_capture_export": return session.beginExport(message.token, message.requirements);
      case "hd_capture_job_status": return session.jobStatus(message.jobId);
      case "hd_capture_asset": {
        const asset = session.jobAsset(message.jobId, message.kind);
        return { filename: asset.filename, data: bytesToBase64(asset.data) };
      }
      case "hd_capture_complete": return { completed: session.completeExport(message.jobId) };
      case "hd_capture_cancel": return { cancelled: session.cancelExport(message.jobId) };
      default: throw new Error("Unknown capture page request.");
    }
  }).then(result => sendResponse({ type: `${message.type}_result`, requestId: message.requestId,
    ok: true, ...result }), error => sendResponse({ type: `${message.type}_result`, requestId: message.requestId,
    ok: false, error: describe(error) }));
  return true;
});

async function refreshTabs() {
  try {
    const reply = await send("hd_capture_tabs");
    elements["reading-tab"].replaceChildren(...reply.tabs.map(tab => new Option(tab.title || tab.url, String(tab.id))));
    if (reply.tabs.some(tab => tab.id === selectedTabId)) elements["reading-tab"].value = String(selectedTabId);
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
}

elements["capture-start"].addEventListener("click", () => { void startCapture(); });
elements["capture-stop"].addEventListener("click", () => stopCapture());
elements["reading-tab"].addEventListener("focus", () => { void refreshTabs(); });
elements["link-page"].addEventListener("click", async () => {
  try {
    const tabId = Number(elements["reading-tab"].value);
    const reply = await send("hd_capture_link", { tabId });
    selectedTabId = reply.page.tabId;
    linkedDocumentId = reply.page.documentId;
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
});
elements["select-video"].addEventListener("click", async () => {
  try {
    await send("hd_capture_video_select", {
      tabId: selectedTabId,
      videoId: elements["reading-video"].value,
    });
    elements["page-status"].textContent = "Video source selected.";
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
});
elements["track-area"].addEventListener("click", async () => {
  try {
    await send("hd_capture_track_area", { tabId: selectedTabId });
    elements["page-status"].textContent = "Choose an area on the linked page; press Escape to cancel.";
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
});
elements["clear-area"].addEventListener("click", async () => {
  try {
    await send("hd_capture_clear_area", { tabId: selectedTabId });
    elements["page-status"].textContent = "Tracked text area cleared.";
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.options) return;
  const next = globalThis.HDReaderOptions.normaliseOptions(changes.options.newValue).mediaCapture;
  if (JSON.stringify(next) === JSON.stringify(config)) return;
  if (stream) stopCapture("Capture settings changed. Start capture again to use them.");
  config = next;
  session.configure(config);
  render();
});

async function initialise() {
  const stored = await chrome.storage.local.get("options");
  config = globalThis.HDReaderOptions.normaliseOptions(stored.options).mediaCapture;
  session.configure(config);
  await register();
  await refreshTabs();
  render();
  setInterval(() => { void register(); render(); }, 20_000);
}

window.addEventListener("pagehide", () => stopCapture());
void initialise();
