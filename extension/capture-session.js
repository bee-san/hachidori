// SPDX-License-Identifier: GPL-3.0-or-later
import {
  createAudioRing,
  createCapturePinStore,
  createFrameRing,
  encodeMonoWav,
} from "./capture-buffer.js";
import { encodeCapturedAnimation } from "./capture-encoder-client.js";
import { MAX_ANIMATED_AVIF_BYTES } from "./avif-sequence.js";
import { createCaptureTimeline, resolveCaptureInterval } from "./capture-timeline.js";

const JOB_LIFETIME_MS = 2 * 60 * 1000;

function safeAssetId(value = crypto.randomUUID()) {
  const id = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!id) throw new Error("Could not allocate a media asset identity.");
  return id;
}

function waitUntil(deadline, now, setTimer) {
  const remaining = Math.max(0, deadline - now());
  if (remaining === 0) return Promise.resolve();
  return new Promise(resolve => setTimer(resolve, remaining));
}

export function createCaptureSession({
  now = () => performance.timeOrigin + performance.now(),
  wallNow = Date.now,
  setTimer = setTimeout,
  encodeAnimation = encodeCapturedAnimation,
  randomId = () => crypto.randomUUID(),
} = {}) {
  let config = null;
  let captureSessionId = "";
  let state = "disabled";
  let statusError = "";
  let mediaSource = null;
  let capturedAudioAvailable = false;
  let linkedPage = null;
  let texthookerStatus = "Disabled";
  let texthookerActive = false;
  const timeline = createCaptureTimeline();
  let frameRing = null;
  let audioRing = null;
  let pins = createCapturePinStore({ now: wallNow });
  const jobs = new Map();
  let activeJobId = null;

  function status() {
    const frameSize = frameRing?.size() ?? { count: 0, bytes: 0 };
    const audioSize = audioRing?.size() ?? { blocks: 0, samples: 0 };
    return {
      state,
      error: statusError,
      captureSessionId,
      mediaSource,
      linkedPage,
      texthookerStatus,
      texthookerActive,
      history: {
        frameCount: frameSize.count,
        frameBytes: frameSize.bytes,
        audioBlocks: audioSize.blocks,
        audioSamples: audioSize.samples,
        frameOldestMs: frameRing?.oldestTimestamp() ?? null,
        frameNewestMs: frameRing?.newestTimestamp() ?? null,
        audioOldestMs: audioRing?.oldestTimestamp() ?? null,
        audioNewestMs: audioRing?.newestTimestamp() ?? null,
        oldestMs: oldestRequiredTimestamp(),
        newestMs: (() => {
          const newest = Math.max(frameRing?.newestTimestamp() ?? -Infinity, audioRing?.newestTimestamp() ?? -Infinity);
          return Number.isFinite(newest) ? newest : null;
        })(),
      },
      pinActive: pins.active() || activeJobId !== null,
    };
  }

  function oldestRequiredTimestamp() {
    if (!config) return null;
    const values = [];
    if (config.includeAnimation) values.push(frameRing?.oldestTimestamp());
    if (config.includeCapturedAudio && capturedAudioAvailable) values.push(audioRing?.oldestTimestamp());
    const available = values.filter(Number.isFinite);
    return available.length ? Math.max(...available) : null;
  }

  function configure(value) {
    cancelOwnedCapture("Capture settings changed.");
    config = structuredClone(value);
    frameRing = createFrameRing({ maxAgeMs: config.historySeconds * 1000 });
    audioRing = createAudioRing({ maxAgeMs: config.historySeconds * 1000 });
    pins = createCapturePinStore({ now: wallNow });
    timeline.reset();
    jobs.clear();
    activeJobId = null;
    texthookerActive = false;
    texthookerStatus = config.timingMode === "auto" && config.texthooker.enabled
      ? "Disconnected" : "Disabled";
    state = config.enabled ? "stopped" : "disabled";
    statusError = "";
  }

  function start({ sourceName = "Shared tab", displaySurface = "browser", audioAvailable = true } = {}) {
    if (!config?.enabled) throw new Error("Enable media capture in Settings first.");
    if (displaySurface === "monitor") throw new Error("Whole-screen capture is not supported. Choose a tab or window.");
    captureSessionId = randomId();
    capturedAudioAvailable = audioAvailable === true;
    mediaSource = {
      name: String(sourceName).slice(0, 200),
      displaySurface,
      audioAvailable: capturedAudioAvailable,
    };
    state = "recording";
    statusError = "";
    return status();
  }

  function stop(error = "") {
    cancelOwnedCapture(error || "Capture stopped.");
    state = config ? "stopped" : "disabled";
    statusError = error;
    captureSessionId = "";
    mediaSource = null;
    capturedAudioAvailable = false;
    linkedPage = null;
    texthookerActive = false;
    texthookerStatus = config?.timingMode === "auto" && config.texthooker.enabled
      ? "Disconnected" : "Disabled";
    frameRing?.clear();
    audioRing?.clear();
    timeline.reset();
    pins.clear();
    jobs.clear();
    activeJobId = null;
  }

  function requireRecording() {
    if (state !== "recording" || !captureSessionId) throw new Error("Start capture before looking up text.");
  }

  function addFrame(frame) {
    requireRecording();
    return frameRing.append(frame);
  }

  function addAudio(block) {
    requireRecording();
    return audioRing.append(block);
  }

  function setLinkedPage(page) {
    const previous = linkedPage;
    if (previous) {
      const sourceId = `tab:${previous.tabId}`;
      timeline.closeSource("cue", sourceId, undefined, now());
      timeline.closeSource("dom", sourceId, undefined, now());
    }
    linkedPage = page ? {
      tabId: page.tabId,
      documentId: page.documentId,
      title: String(page.title || "").slice(0, 200),
      url: String(page.url || "").slice(0, 2048),
    } : null;
  }

  function textBegin(record) {
    requireRecording();
    return timeline.begin(record);
  }

  function textClose(identity, endMs = now()) {
    const closed = timeline.close(identity, endMs);
    if (closed) adjustOpenPin(closed);
    return closed;
  }

  function closeTextSource(sourceKind, sourceId, sourceEpoch, endMs = now()) {
    const closed = timeline.closeSource(sourceKind, sourceId, sourceEpoch, endMs);
    for (const record of closed) adjustOpenPin(record);
    return closed;
  }

  function setTexthooker(nextStatus, active = false) {
    texthookerStatus = nextStatus;
    texthookerActive = active;
  }

  function adjustOpenPin(closed) {
    const active = currentPin();
    if (!active || active.finalized || active.sourceKind !== closed.sourceKind
        || active.sourceId !== closed.sourceId || active.sourceEpoch !== closed.sourceEpoch
        || active.occurrenceId !== closed.occurrenceId) return;
    const offset = closed.sourceKind === "cue" ? 0 : config.estimatedOffsetMs;
    const closedEnd = closed.endMs + offset;
    if (closedEnd > active.startMs && closedEnd < active.endMs) {
      active.endMs = closedEnd;
      active.deadlineVersion += 1;
      void finalizeAtDeadline(active, active.deadlineVersion);
    }
  }

  function currentPin() {
    return activePin ?? (activeJobId ? jobs.get(activeJobId)?.pin ?? null : null);
  }

  let activePin = null;

  function cancelOwnedCapture(message) {
    const error = new Error(message);
    if (activePin && !activePin.finalized) activePin.rejectReady(error);
    activePin = null;
    for (const job of jobs.values()) {
      job.controller.abort();
      if (!job.pin.finalized) job.pin.rejectReady(error);
    }
  }

  async function finalizeAtDeadline(pin, version) {
    await waitUntil(pin.endMs, now, setTimer);
    if (currentPin() !== pin || pin.deadlineVersion !== version || pin.finalized) return;
    try {
      pin.frames = config.includeAnimation ? frameRing.select(pin.startMs, pin.endMs) : [];
      pin.audio = config.includeCapturedAudio && pin.audioAvailable
        ? audioRing.select(pin.startMs, pin.endMs) : null;
      if (config.includeCapturedAudio && !pin.audioAvailable) pin.partial = true;
      pin.partial ||= pin.audio?.partial === true;
      pin.finalized = true;
      pin.resolveReady(pin);
    } catch (error) {
      pin.rejectReady(error);
      pins.release(pin.token);
      activePin = null;
    }
  }

  function pinLookup({ lookupText, occurrenceId = "", occurrenceSourceKind = "", lookupTimeMs = now() }) {
    requireRecording();
    pruneJobs();
    if (activeJobId !== null) throw new Error("Another captured clip is still exporting. Finish or cancel it first.");
    const availableStartMs = oldestRequiredTimestamp();
    if (!Number.isFinite(availableStartMs)) throw new Error("Capture history is still warming up.");
    const interval = resolveCaptureInterval({
      records: timeline.snapshot(),
      lookupText,
      occurrenceId,
      occurrenceSourceKind,
      lookupTimeMs,
      availableStartMs,
      timingMode: config.timingMode,
      clipSeconds: config.clipSeconds,
      estimatedOffsetMs: config.estimatedOffsetMs,
      texthookerActive,
    });
    if (!interval) throw new Error("No retained capture interval is available for this lookup.");
    const assetId = safeAssetId(randomId());
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const created = pins.create({
      ...interval,
      captureSessionId,
      assetId,
      animationFilename: `hachidori-${assetId}.avif`,
      audioFilename: `hachidori-${assetId}.wav`,
      audioAvailable: capturedAudioAvailable,
      deadlineVersion: 1,
      finalized: false,
      frames: null,
      audio: null,
      ready,
      resolveReady,
      rejectReady,
    });
    activePin = pins.get(created.token);
    void finalizeAtDeadline(activePin, activePin.deadlineVersion);
    return {
      token: created.token,
      captureSessionId,
      sourceKind: interval.sourceKind,
      sourceLabel: interval.sourceLabel,
      partial: interval.partial === true,
      animationFilename: created.animationFilename,
      audioFilename: created.audioFilename,
      readyAtMs: interval.endMs,
    };
  }

  function releasePin(token) {
    const released = pins.release(token);
    if (released && activePin?.token === token) {
      activePin.rejectReady(new Error("The capture pin was released."));
      activePin = null;
    }
    return released;
  }

  function pruneJobs() {
    const cutoff = wallNow() - JOB_LIFETIME_MS;
    for (const [id, job] of jobs) {
      if (job.updatedAt >= cutoff) continue;
      job.controller.abort();
      if (!job.pin.finalized) job.pin.rejectReady(new Error("The media export job expired."));
      jobs.delete(id);
      if (activeJobId === id) activeJobId = null;
    }
  }

  function beginExport(token, requirements) {
    pruneJobs();
    if (activeJobId !== null) {
      const existing = jobs.get(activeJobId);
      if (existing?.token === token) {
        return { jobId: existing.id, state: existing.state,
          sourceLabel: existing.sourceLabel, partial: existing.partial };
      }
      throw new Error("Another captured clip is still exporting.");
    }
    const pin = pins.get(token);
    if (!pin || pin.captureSessionId !== captureSessionId) throw new Error("The capture pin expired. Look up the text again.");
    const includeAnimation = requirements?.includeAnimation === true && config.includeAnimation;
    const includeAudio = requirements?.includeAudio === true && config.includeCapturedAudio && pin.audioAvailable;
    if (!includeAnimation && requirements?.includeAudio === true
        && config.includeCapturedAudio && !pin.audioAvailable) {
      throw new Error("The shared source did not provide audio for the mapped captured-audio field.");
    }
    if (!includeAnimation && !includeAudio) throw new Error("The selected Anki fields do not reference captured media.");
    const id = randomId();
    const controller = new AbortController();
    const job = { id, token, state: "finishing", error: "", progress: 0, total: 0,
      sourceLabel: pin.sourceLabel, partial: pin.partial === true, assets: {}, updatedAt: wallNow(),
      controller, pin,
      warnings: requirements?.includeAudio === true && !pin.audioAvailable
        ? ["The shared source did not provide audio; this note will use animation only."] : [] };
    jobs.set(id, job);
    activeJobId = id;
    pins.release(token);
    if (activePin === pin) activePin = null;
    void (async () => {
      try {
        await pin.ready;
        if (controller.signal.aborted) throw new Error("Media encoding was cancelled.");
        job.state = "encoding";
        job.updatedAt = wallNow();
        if (includeAnimation) {
          job.assets.animation = {
            filename: pin.animationFilename,
            data: await encodeAnimation(pin.frames, { endMs: pin.endMs, videoPreset: config.videoPreset }, {
              signal: controller.signal,
              onProgress(completed, total) {
                job.progress = completed;
                job.total = total;
                job.updatedAt = wallNow();
              },
            }),
          };
          if (job.assets.animation.data.byteLength > MAX_ANIMATED_AVIF_BYTES) {
            throw new Error("Animated AVIF exceeds its 4 MiB output limit.");
          }
        }
        if (includeAudio) {
          job.assets.audio = {
            filename: pin.audioFilename,
            data: encodeMonoWav(pin.audio.samples, pin.audio.sampleRate),
          };
        }
        job.partial ||= pin.partial || pin.audio?.partial === true;
        job.state = "ready";
      } catch (error) {
        job.state = "error";
        job.error = error instanceof Error ? error.message : String(error);
      }
      job.updatedAt = wallNow();
    })();
    return { jobId: id, state: job.state, sourceLabel: job.sourceLabel, partial: job.partial };
  }

  function jobStatus(id) {
    pruneJobs();
    const job = jobs.get(id);
    if (!job) throw new Error("The media export job expired.");
    return {
      jobId: id,
      state: job.state,
      error: job.error,
      progress: job.progress,
      total: job.total,
      sourceLabel: job.sourceLabel,
      partial: job.partial,
      warnings: [...job.warnings],
      assets: Object.fromEntries(Object.entries(job.assets).map(([kind, asset]) =>
        [kind, { filename: asset.filename, byteLength: asset.data.byteLength }])),
    };
  }

  function jobAsset(id, kind) {
    const job = jobs.get(id);
    if (!job || job.state !== "ready" || !["animation", "audio"].includes(kind) || !job.assets[kind]) {
      throw new Error("The requested captured media asset is unavailable.");
    }
    const asset = job.assets[kind];
    return { filename: asset.filename, data: asset.data.slice() };
  }

  function completeExport(id) {
    const job = jobs.get(id);
    if (!job) return false;
    jobs.delete(id);
    if (activeJobId === id) activeJobId = null;
    return true;
  }

  function cancelExport(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.controller.abort();
    if (!job.pin.finalized) job.pin.rejectReady(new Error("The media export job was cancelled."));
    jobs.delete(id);
    if (activeJobId === id) activeJobId = null;
    return true;
  }

  return {
    configure,
    start,
    stop,
    status,
    addFrame,
    addAudio,
    setLinkedPage,
    textBegin,
    textClose,
    closeTextSource,
    setTexthooker,
    pinLookup,
    releasePin,
    beginExport,
    jobStatus,
    jobAsset,
    completeExport,
    cancelExport,
  };
}
