// SPDX-License-Identifier: GPL-3.0-or-later
import { createCaptureSession } from "./capture-session.js";
import { MAX_FRAME_BYTES } from "./capture-buffer.js";
import {
  MAX_TEXTHOOKER_FRAME_LENGTH,
  MAX_TEXTHOOKER_TEXT_LENGTH,
  parseTexthookerMessage,
} from "./texthooker-protocol.js";

const CAPTURE_TARGET = "hachidori-capture";
const PAGE_TARGET = "hachidori-capture-page";
const CONTENT_TARGET = "hachidori-capture-content";
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
const session = createCaptureSession();
let config;
let captureDocumentId = "";
let stream = null;
let frameTimer = null;
let frameCallbackId = null;
let frameBusy = false;
let mediaClockReady = Promise.resolve(null);
let resolveMediaClock = null;
let mediaClockOriginMs = null;
let frameClockOriginMs = null;
let videoReader = null;
let processedVideoTrack = null;
let audioReader = null;
let audioTrack = null;
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

function resetMediaClock() {
  mediaClockOriginMs = null;
  mediaClockReady = new Promise(resolve => { resolveMediaClock = resolve; });
}

function establishMediaClock(metadata, now) {
  if (Number.isFinite(mediaClockOriginMs) || !Number.isFinite(metadata?.mediaTime)) return;
  const frameTime = Number.isFinite(metadata.captureTime) ? metadata.captureTime
    : Number.isFinite(metadata.presentationTime) ? metadata.presentationTime : now;
  mediaClockOriginMs = performance.timeOrigin + frameTime - metadata.mediaTime * 1000;
  resolveMediaClock?.(mediaClockOriginMs);
  resolveMediaClock = null;
}

function establishTrackMediaClock(mediaTimeMs, observedAtMs = timestamp()) {
  if (Number.isFinite(frameClockOriginMs)) return;
  if (!Number.isFinite(mediaTimeMs)) throw new Error("The captured video did not provide media timestamps.");
  frameClockOriginMs = observedAtMs - mediaTimeMs;
}

function clearMediaClock() {
  resolveMediaClock?.(null);
  resolveMediaClock = null;
  mediaClockOriginMs = null;
  frameClockOriginMs = null;
}

async function captureFrame(canvas, context, source, at, ownedStream) {
  if (!stream || stream !== ownedStream) return;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  let blob = await canvasBlob(canvas, 0.72);
  if (blob.size > MAX_FRAME_BYTES) blob = await canvasBlob(canvas, 0.5);
  if (blob.size > MAX_FRAME_BYTES || stream !== ownedStream) return;
  const data = new Uint8Array(await blob.arrayBuffer());
  if (stream !== ownedStream) return;
  session.addFrame({
    timestampMs: at,
    width: canvas.width,
    height: canvas.height,
    data,
  });
}

function frameCanvas(videoWidth, videoHeight) {
  const { width, height } = captureDimensions(videoWidth, videoHeight);
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(width, height) : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not create the capture frame canvas.");
  return { canvas, context };
}

function startTimestampedFrames(sharedStream, sourceTrack) {
  if (typeof MediaStreamTrackProcessor !== "function") return false;
  let ownedTrack;
  let reader;
  try {
    ownedTrack = sourceTrack.clone();
    reader = new MediaStreamTrackProcessor({ track: ownedTrack }).readable.getReader();
  } catch {
    ownedTrack?.stop();
    return false;
  }
  const ownedStream = sharedStream;
  const fps = config.videoPreset === "compact" ? 6 : 8;
  const intervalMs = 1000 / fps;
  let canvas = null;
  let context = null;
  let lastTimestamp = -Infinity;
  videoReader = reader;
  processedVideoTrack = ownedTrack;
  void (async () => {
    while (stream === ownedStream && videoReader === reader) {
      const { done, value } = await reader.read();
      if (done || !value) return;
      try {
        const mediaTimeMs = value.timestamp / 1000;
        establishTrackMediaClock(mediaTimeMs);
        const frameTimestamp = frameClockOriginMs + mediaTimeMs;
        if (frameTimestamp - lastTimestamp < intervalMs * 0.9) continue;
        if (!canvas) {
          ({ canvas, context } = frameCanvas(
            value.displayWidth || value.codedWidth,
            value.displayHeight || value.codedHeight,
          ));
        }
        lastTimestamp = frameTimestamp;
        await captureFrame(canvas, context, value, frameTimestamp, ownedStream);
      } finally {
        value.close();
      }
    }
  })().catch(error => {
    if (stream === ownedStream && videoReader === reader) {
      stopCapture(`Video capture stopped: ${describe(error)}`);
    }
  });
  return true;
}

function startFallbackFrames() {
  const video = elements["capture-preview"];
  const { canvas, context } = frameCanvas(video.videoWidth, video.videoHeight);
  const ownedStream = stream;
  const fps = config.videoPreset === "compact" ? 6 : 8;
  const intervalMs = 1000 / fps;
  let lastStartedAt = -Infinity;
  let lastTimestamp = -Infinity;
  const sample = (at, now) => {
    if (frameBusy || now - lastStartedAt < intervalMs * 0.9) return;
    lastStartedAt = now;
    const frameTimestamp = Math.max(at, lastTimestamp + 0.001);
    lastTimestamp = frameTimestamp;
    frameBusy = true;
    void captureFrame(canvas, context, video, frameTimestamp, ownedStream)
      .catch(error => stopCapture(`Video capture stopped: ${describe(error)}`))
      .finally(() => { frameBusy = false; });
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    const onFrame = (now, metadata) => {
      frameCallbackId = video.requestVideoFrameCallback(onFrame);
      establishMediaClock(metadata, now);
      const at = Number.isFinite(mediaClockOriginMs) && Number.isFinite(metadata.mediaTime)
        ? mediaClockOriginMs + metadata.mediaTime * 1000
        : performance.timeOrigin
          + (Number.isFinite(metadata.captureTime) ? metadata.captureTime : now);
      sample(at, now);
    };
    frameCallbackId = video.requestVideoFrameCallback(onFrame);
  }
  frameTimer = setInterval(() => {
    sample(timestamp(), performance.now());
  }, Math.round(1000 / fps));
}

function startFrames(sharedStream, sourceTrack) {
  if (!startTimestampedFrames(sharedStream, sourceTrack)) {
    startFallbackFrames();
    return;
  }
  const video = elements["capture-preview"];
  if (typeof video.requestVideoFrameCallback === "function") {
    frameCallbackId = video.requestVideoFrameCallback((now, metadata) => {
      frameCallbackId = null;
      establishMediaClock(metadata, now);
    });
  }
}

function startTimestampedAudio(sharedStream, sourceTrack) {
  const ownedStream = sharedStream;
  const ownedTrack = sourceTrack.clone();
  const reader = new MediaStreamTrackProcessor({ track: ownedTrack }).readable.getReader();
  audioReader = reader;
  audioTrack = ownedTrack;
  void (async () => {
    const originMs = await mediaClockReady;
    if (!Number.isFinite(originMs) || stream !== ownedStream || audioReader !== reader) return;
    let mono = new Float32Array(0);
    let plane = new Float32Array(0);
    while (stream === ownedStream && audioReader === reader) {
      const { done, value } = await reader.read();
      if (done || !value) return;
      try {
        if (mono.length !== value.numberOfFrames) {
          mono = new Float32Array(value.numberOfFrames);
          plane = new Float32Array(value.numberOfFrames);
        } else {
          mono.fill(0);
        }
        for (let channel = 0; channel < value.numberOfChannels; channel += 1) {
          value.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
          for (let frame = 0; frame < mono.length; frame += 1) mono[frame] += plane[frame];
        }
        if (value.numberOfChannels > 1) {
          for (let frame = 0; frame < mono.length; frame += 1) {
            mono[frame] /= value.numberOfChannels;
          }
        }
        session.addAudio({
          startMs: originMs + value.timestamp / 1000,
          sampleRate: value.sampleRate,
          samples: mono,
        });
      } finally {
        value.close();
      }
    }
  })().catch(error => {
    if (stream === ownedStream && audioReader === reader) {
      stopCapture(`Audio capture stopped: ${describe(error)}`);
    }
  });
}

async function startWorkletAudio(sharedStream, sourceTrack) {
  audioContext = new AudioContext({ sampleRate: 48_000, latencyHint: "playback" });
  await audioContext.audioWorklet.addModule("capture-audio-worklet.js");
  const source = audioContext.createMediaStreamSource(new MediaStream([sourceTrack]));
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

async function startAudio(sharedStream) {
  const sourceTrack = sharedStream.getAudioTracks()[0];
  if (!sourceTrack) return;
  if (!globalThis.__hachidoriForceAudioWorklet
      && config.includeAnimation && videoReader
      && typeof MediaStreamTrackProcessor === "function"
      && typeof elements["capture-preview"].requestVideoFrameCallback === "function") {
    startTimestampedAudio(sharedStream, sourceTrack);
    return;
  }
  await startWorkletAudio(sharedStream, sourceTrack);
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
      surfaceSwitching: "exclude",
    });
    const videoTrack = requested.getVideoTracks()[0];
    if (!videoTrack) {
      requested.getTracks().forEach(track => track.stop());
      throw new Error("The selected source did not provide video.");
    }
    if (!config.includeAnimation && config.includeCapturedAudio
        && requested.getAudioTracks().length === 0) {
      requested.getTracks().forEach(track => track.stop());
      throw new Error("The selected source did not provide audio for media capture.");
    }
    const settings = videoTrack.getSettings();
    if (settings.displaySurface === "monitor") {
      requested.getTracks().forEach(track => track.stop());
      throw new Error("Choose a browser tab or application window, not an entire screen.");
    }
    stream = requested;
    resetMediaClock();
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
    if (config.includeAnimation) startFrames(requested, videoTrack);
    if (config.includeCapturedAudio) await startAudio(requested);
    if (config.timingMode === "auto" && config.texthooker.enabled) texthooker = createTexthooker();
  } catch (error) {
    stopCapture(describe(error));
  }
  render();
}

function stopCapture(error = "") {
  if (frameCallbackId !== null) {
    elements["capture-preview"].cancelVideoFrameCallback(frameCallbackId);
    frameCallbackId = null;
  }
  clearInterval(frameTimer);
  frameTimer = null;
  frameBusy = false;
  const frames = videoReader;
  videoReader = null;
  void frames?.cancel().catch(() => {});
  processedVideoTrack?.stop();
  processedVideoTrack = null;
  stopTexthooker();
  const reader = audioReader;
  audioReader = null;
  void reader?.cancel().catch(() => {});
  audioTrack?.stop();
  audioTrack = null;
  audioNode?.disconnect();
  audioNode = null;
  void audioContext?.close();
  audioContext = null;
  clearMediaClock();
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
      case "hd_capture_unlinked":
        if (!linked(message)) return { ignored: true };
        selectedTabId = null;
        linkedDocumentId = "";
        session.setLinkedPage(null);
        elements["page-status"].textContent = message.reason || "The reading page navigated. Link it again.";
        elements["video-row"].hidden = true;
        elements["reading-video"].replaceChildren();
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
