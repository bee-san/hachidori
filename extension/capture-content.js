// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";

  const CAPTURE_TARGET = "hachidori-capture";
  const CONTENT_TARGET = "hachidori-capture-content";
  const MAX_TEXT_LENGTH = 4096;
  const MAX_LINES = 1000;
  const TYPEWRITER_GAP_MS = 750;
  const TYPEWRITER_GROWTH_LIMIT = 12;
  const INLINE_DISPLAY_PATTERN = /^(?:inline|ruby|contents)/u;
  const OMIT_TEXT_SELECTOR = [
    "button", "input", "select", "textarea", "[contenteditable]",
    "rt", "rp", "script", "style", "noscript", "hachidori-host",
  ].join(",");
  const videoIds = new WeakMap();
  const trackIds = new WeakMap();
  const cueIds = new WeakMap();
  let nextVideoId = 0;
  let nextTrackId = 0;
  let nextCueId = 0;
  let nextRequestId = 0;
  let nextLineId = 0;
  let linked = false;
  let options = null;
  let documentEpoch = crypto.randomUUID();
  let selectedVideo = null;
  let selectedVideoCleanup = null;
  let trackedElement = null;
  let trackedEpoch = "";
  let trackedLines = [];
  let trackedObserver = null;
  let trackedVisibilityObserver = null;
  let trackedMountObserver = null;
  let trackedQueued = false;
  let pickerCleanup = null;
  let rootPin = null;
  let rootPinTail = Promise.resolve();

  const now = () => performance.timeOrigin + performance.now();
  const normalize = value => typeof value === "string"
    ? value.normalize("NFC").replace(/\s+/gu, " ").trim() : "";

  async function send(type, fields = {}) {
    const reply = await chrome.runtime.sendMessage({
      target: CAPTURE_TARGET,
      type,
      requestId: `capture-content-${++nextRequestId}`,
      ...fields,
    });
    if (!reply?.ok) throw new Error(reply?.error || "The capture service did not reply.");
    return reply;
  }

  async function identify() {
    return send("hd_capture_content_identify");
  }

  function report(message, fields = {}) {
    void send("hd_capture_page_status", { message, ...fields }).catch(() => {});
  }

  function videoId(video) {
    let id = videoIds.get(video);
    if (!id) {
      id = `video-${++nextVideoId}`;
      videoIds.set(video, id);
    }
    return id;
  }

  function videoTracks(video) {
    const tracks = [];
    try {
      for (const track of video.textTracks ?? []) {
        if (track.mode !== "disabled") tracks.push(track);
      }
    } catch {
      return [];
    }
    return tracks;
  }

  function trackId(track) {
    let id = trackIds.get(track);
    if (!id) {
      id = `track-${++nextTrackId}`;
      trackIds.set(track, id);
    }
    return id;
  }

  function videos() {
    return [...document.querySelectorAll("video")].map((video, index) => ({
      id: videoId(video),
      label: String(video.getAttribute("aria-label") || video.title
        || `Video ${index + 1} (${video.videoWidth || "?"}×${video.videoHeight || "?"})`).slice(0, 200),
      trackCount: videoTracks(video).length,
    }));
  }

  function cueId(cue) {
    if (cue.id) return String(cue.id).slice(0, 160);
    let id = cueIds.get(cue);
    if (!id) {
      id = `cue-${++nextCueId}`;
      cueIds.set(cue, id);
    }
    return id;
  }

  function emitBegin(record) {
    void send("hd_capture_text_begin", { record }).catch(() => {});
  }

  function emitClose(identity, endMs = now()) {
    void send("hd_capture_text_close", { identity, endMs }).catch(() => {});
  }

  function attachVideo(video) {
    selectedVideoCleanup?.();
    selectedVideoCleanup = null;
    selectedVideo = video;
    if (!video) return;
    let epochCounter = 0;
    let sourceEpoch = "";
    let interrupted = true;
    const active = new Map();
    const cleanups = [];
    const trackCleanups = new Map();

    function identity(id) {
      return { sourceKind: "cue", sourceEpoch, occurrenceId: id };
    }

    function closeAll(at = now()) {
      for (const id of active.keys()) emitClose(identity(id), at);
      active.clear();
    }

    function resetEpoch(at = now()) {
      closeAll(at);
      sourceEpoch = `video:${videoId(video)}:${++epochCounter}`;
    }

    function sync(onsetKnown) {
      const at = now();
      if (video.paused || video.seeking || video.ended || !video.isConnected) {
        closeAll(at);
        return;
      }
      const next = new Map();
      for (const track of videoTracks(video)) {
        let cues;
        try {
          cues = [...(track.activeCues ?? [])];
        } catch {
          continue;
        }
        for (const cue of cues) {
          const text = String(cue.text ?? "");
          if (!normalize(text) || text.length > MAX_TEXT_LENGTH) continue;
          const id = `${trackId(track)}:${cueId(cue)}`;
          next.set(id, text);
          if (!active.has(id)) {
            emitBegin({
              sourceKind: "cue",
              sourceEpoch,
              occurrenceId: id,
              text,
              startMs: at,
              onsetKnown,
            });
          } else if (active.get(id) !== text) {
            emitBegin({
              sourceKind: "cue",
              sourceEpoch,
              occurrenceId: id,
              text,
              startMs: at,
              onsetKnown,
            });
          }
        }
      }
      for (const id of active.keys()) if (!next.has(id)) emitClose(identity(id), at);
      active.clear();
      for (const entry of next) active.set(...entry);
    }

    function listen(target, type, listener) {
      target.addEventListener(type, listener);
      cleanups.push(() => target.removeEventListener(type, listener));
    }

    function bindTracks() {
      const available = new Set(videoTracks(video));
      for (const [track, cleanup] of trackCleanups) {
        if (available.has(track)) continue;
        cleanup();
        trackCleanups.delete(track);
      }
      for (const track of available) {
        if (trackCleanups.has(track)) continue;
        const listener = () => sync(true);
        track.addEventListener("cuechange", listener);
        trackCleanups.set(track, () => track.removeEventListener("cuechange", listener));
      }
    }

    function interrupt(at = now()) {
      closeAll(at);
      interrupted = true;
    }

    function resume() {
      if (video.paused || video.seeking || video.ended || !video.isConnected) return;
      if (interrupted) resetEpoch();
      interrupted = false;
      sync(false);
    }

    function resetAndSync() {
      resetEpoch();
      bindTracks();
      interrupted = video.paused || video.seeking || video.ended;
      if (!interrupted) sync(false);
    }

    resetEpoch();
    bindTracks();
    listen(video, "play", resume);
    listen(video, "pause", interrupt);
    listen(video, "seeking", interrupt);
    listen(video, "seeked", resetAndSync);
    listen(video, "ended", interrupt);
    listen(video, "emptied", () => { resetEpoch(); interrupted = true; });
    listen(video, "loadedmetadata", resetAndSync);
    if (video.textTracks?.addEventListener) {
      listen(video.textTracks, "addtrack", resetAndSync);
      listen(video.textTracks, "removetrack", resetAndSync);
      listen(video.textTracks, "change", resetAndSync);
    }
    resume();
    selectedVideoCleanup = () => {
      closeAll();
      for (const cleanup of trackCleanups.values()) cleanup();
      trackCleanups.clear();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      selectedVideo = null;
    };
  }

  function renderedElement(element, requireLayout = false) {
    if (!element?.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true"
        || element.closest("hachidori-host")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && Number(style.opacity) !== 0 && (!requireLayout || element.getClientRects().length > 0);
  }

  function visible(element) {
    return renderedElement(element, true);
  }

  function validTrackedElement(element) {
    return element instanceof Element && !["HTML", "BODY"].includes(element.tagName)
      && !element.matches("input, textarea, select, button, [contenteditable], hachidori-host")
      && !element.closest("hachidori-host");
  }

  function extractLines(element) {
    if (!visible(element)) return [];
    const pieces = [];
    const lineBreak = () => {
      if (pieces.at(-1) !== "\n") pieces.push("\n");
    };
    function visit(node, root = false) {
      if (node.nodeType === Node.TEXT_NODE) {
        pieces.push(node.nodeValue || "");
        return;
      }
      if (!(node instanceof Element) || (!root && node.matches(OMIT_TEXT_SELECTOR))
          || !renderedElement(node)) return;
      if (node.tagName === "BR") {
        lineBreak();
        return;
      }
      const block = !root && !INLINE_DISPLAY_PATTERN.test(getComputedStyle(node).display);
      if (block) lineBreak();
      for (const child of node.childNodes) visit(child);
      if (block) lineBreak();
    }
    visit(element, true);
    return pieces.join("").split(/\r?\n/gu).map(normalize).filter(Boolean).slice(0, MAX_LINES)
      .map(value => value.slice(0, MAX_TEXT_LENGTH));
  }

  function domIdentity(line) {
    return { sourceKind: "dom", sourceEpoch: trackedEpoch, occurrenceId: line.id };
  }

  function closeTrackedLines(at = now()) {
    for (const line of trackedLines) emitClose(domIdentity(line), at);
    trackedLines = [];
  }

  function reconcileTracked(initial = false) {
    trackedQueued = false;
    if (!trackedElement) return;
    if (!trackedElement.isConnected) {
      clearTrackedArea(false);
      report("The tracked text area was replaced. Select it again or use the next lookup to relearn it.",
        { tracked: false });
      return;
    }
    const at = now();
    const values = extractLines(trackedElement);
    const next = [];
    const count = Math.max(trackedLines.length, values.length);
    for (let index = 0; index < count; index += 1) {
      const previous = trackedLines[index];
      const text = values[index];
      if (previous && text === previous.text) {
        next.push(previous);
        continue;
      }
      if (previous && text && index === trackedLines.length - 1 && index === values.length - 1
          && normalize(text).startsWith(normalize(previous.text))
          && Array.from(normalize(text).slice(normalize(previous.text).length)).length <= TYPEWRITER_GROWTH_LIMIT
          && at - previous.updatedMs <= TYPEWRITER_GAP_MS) {
        emitBegin({ sourceKind: "dom", sourceEpoch: trackedEpoch, occurrenceId: previous.id,
          text, startMs: at, onsetKnown: !initial });
        next.push({ ...previous, text, updatedMs: at });
        continue;
      }
      if (previous) emitClose(domIdentity(previous), at);
      if (text) {
        const line = { id: `line-${++nextLineId}`, text, updatedMs: at };
        emitBegin({ sourceKind: "dom", sourceEpoch: trackedEpoch, occurrenceId: line.id,
          text, startMs: at, onsetKnown: !initial });
        next.push(line);
      }
    }
    trackedLines = next;
  }

  function queueTrackedReconcile() {
    if (trackedQueued) return;
    trackedQueued = true;
    queueMicrotask(() => reconcileTracked(false));
  }

  function clearTrackedArea(reportChange = true) {
    trackedObserver?.disconnect();
    trackedObserver = null;
    trackedVisibilityObserver?.disconnect();
    trackedVisibilityObserver = null;
    trackedMountObserver?.disconnect();
    trackedMountObserver = null;
    closeTrackedLines();
    trackedElement = null;
    trackedEpoch = "";
    if (reportChange) report("Tracked text area cleared.", { tracked: false });
  }

  function trackArea(element, manual = false) {
    if (!validTrackedElement(element)) throw new Error("Choose a bounded, non-editable text area.");
    clearTrackedArea(false);
    trackedElement = element;
    trackedEpoch = `dom:${documentEpoch}:${crypto.randomUUID()}`;
    reconcileTracked(true);
    trackedObserver = new MutationObserver(queueTrackedReconcile);
    trackedObserver.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden"],
    });
    trackedVisibilityObserver = new MutationObserver(queueTrackedReconcile);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      trackedVisibilityObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
      });
    }
    trackedMountObserver = new MutationObserver(queueTrackedReconcile);
    for (let node = element; node.parentElement; node = node.parentElement) {
      trackedMountObserver.observe(node.parentElement, { childList: true });
    }
    report(manual ? "Text area selected." : "Text area learned from the first lookup.", { tracked: true });
  }

  function learnArea(candidate) {
    if (trackedElement || !linked || !options?.mediaCapture.page.domText
        || !options.mediaCapture.page.autoLearnArea) return;
    let element = candidate?.anchor instanceof Element ? candidate.anchor : candidate?.anchor?.parentElement;
    if (!validTrackedElement(element)) return;
    let selected = element;
    for (let depth = 0; depth < 3; depth += 1) {
      const parent = selected.parentElement;
      if (!validTrackedElement(parent)) break;
      const textLength = (parent.textContent || "").length;
      if (textLength > MAX_TEXT_LENGTH || parent.querySelectorAll("*").length > 100) break;
      selected = parent;
    }
    try { trackArea(selected, false); } catch { /* Conservative auto-learning may decline the page. */ }
  }

  function occurrenceFor(candidate) {
    if (!trackedElement || !candidate?.anchor || !trackedElement.contains(candidate.anchor)) return null;
    const text = normalize(candidate.sentence);
    const matches = trackedLines.filter(line => normalize(line.text) === text);
    return matches.length === 1 ? { occurrenceId: matches[0].id, occurrenceSourceKind: "dom" } : null;
  }

  function picker() {
    pickerCleanup?.();
    let candidate = null;
    const outline = document.createElement("div");
    outline.setAttribute("aria-hidden", "true");
    outline.style.cssText = [
      "all: initial !important", "position: fixed !important", "pointer-events: none !important",
      "z-index: 2147483647 !important", "border: 3px solid #36d399 !important",
      "background: rgba(54,211,153,.12) !important", "box-sizing: border-box !important",
    ].join(";");
    document.documentElement.append(outline);

    function paint(element) {
      candidate = validTrackedElement(element) ? element : null;
      if (!candidate) {
        outline.style.display = "none";
        return;
      }
      const rect = candidate.getBoundingClientRect();
      outline.style.display = "block";
      outline.style.left = `${rect.left}px`;
      outline.style.top = `${rect.top}px`;
      outline.style.width = `${rect.width}px`;
      outline.style.height = `${rect.height}px`;
    }

    function block(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function finish(element = null) {
      pickerCleanup?.();
      if (element) {
        try { trackArea(element, true); }
        catch (error) { report(error.message, { tracked: false }); }
      } else {
        report("Text area selection cancelled.", { tracked: Boolean(trackedElement) });
      }
    }

    const listeners = [
      ["pointermove", event => paint(document.elementFromPoint(event.clientX, event.clientY)), true],
      ["pointerdown", block, true],
      ["pointerup", block, true],
      ["mousedown", block, true],
      ["mouseup", block, true],
      ["auxclick", block, true],
      ["click", event => { block(event); finish(candidate); }, true],
      ["keydown", event => {
        if (event.key === "Escape") { block(event); finish(); }
        else if (event.key === "ArrowUp" && candidate?.parentElement) {
          block(event);
          paint(candidate.parentElement);
        }
      }, true],
    ];
    for (const [type, listener, capture] of listeners) window.addEventListener(type, listener, capture);
    pickerCleanup = () => {
      for (const [type, listener, capture] of listeners) window.removeEventListener(type, listener, capture);
      outline.remove();
      pickerCleanup = null;
    };
    report("Choose a bounded text area. Arrow Up selects its parent; Escape cancels.", { picking: true });
  }

  async function link() {
    await identify();
    const stored = await chrome.storage.local.get("options");
    options = globalThis.HDReaderOptions.normaliseOptions(stored.options);
    linked = true;
    documentEpoch = crypto.randomUUID();
    const available = videos();
    if (options.mediaCapture.timingMode !== "recent"
        && available.length === 1 && available[0].trackCount > 0
        && options.mediaCapture.page.nativeCues) {
      attachVideo([...document.querySelectorAll("video")][0]);
    } else {
      attachVideo(null);
    }
    return {
      videos: available,
      message: available.length > 1
        ? "Choose which video supplies native subtitle cues."
        : available.length === 0 ? "No native video cues found; page text and recent timing remain available."
          : "Reading page linked.",
    };
  }

  async function pinLookup(candidate) {
    if (!linked || !options?.mediaCapture.enabled) return null;
    const pageTiming = options.mediaCapture.timingMode !== "recent";
    if (pageTiming) learnArea(candidate);
    const occurrence = pageTiming
      ? occurrenceFor(candidate) ?? { occurrenceId: "", occurrenceSourceKind: "" }
      : { occurrenceId: "", occurrenceSourceKind: "" };
    try {
      return await send("hd_capture_pin", {
        lookup: {
          lookupText: String(candidate.sentence || candidate.query || "").slice(0, MAX_TEXT_LENGTH),
          lookupTimeMs: now(),
          ...occurrence,
        },
      });
    } catch {
      return null;
    }
  }

  async function releaseToken(pin) {
    if (pin?.token) {
      try { await send("hd_capture_release", { token: pin.token }); } catch { /* Expired pins need no cleanup. */ }
    }
  }

  function rootLookup(candidate) {
    const operation = rootPinTail.then(async () => {
      const previous = rootPin;
      rootPin = null;
      await releaseToken(previous);
      const pin = await pinLookup(candidate);
      rootPin = pin;
      return pin;
    });
    rootPinTail = operation.catch(() => {});
    return operation;
  }

  function release(pin = rootPin) {
    const operation = rootPinTail.then(async () => {
      if (!pin?.token || rootPin?.token !== pin.token) return;
      rootPin = null;
      await releaseToken(pin);
    });
    rootPinTail = operation.catch(() => {});
    return operation;
  }

  async function unlink() {
    await release();
    pickerCleanup?.();
    selectedVideoCleanup?.();
    clearTrackedArea(false);
    linked = false;
    options = null;
    return { linked: false };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== CONTENT_TARGET) return false;
    Promise.resolve().then(async () => {
      switch (message.type) {
        case "hd_capture_link": return link();
        case "hd_capture_video_select": {
          if (options?.mediaCapture.timingMode === "recent"
              || !options?.mediaCapture.page.nativeCues) {
            throw new Error("Native cue timing is disabled for this capture session.");
          }
          const video = [...document.querySelectorAll("video")].find(item => videoId(item) === message.videoId);
          if (!video) throw new Error("That video is no longer available.");
          attachVideo(video);
          return { selected: message.videoId };
        }
        case "hd_capture_track_area":
          if (options?.mediaCapture.timingMode === "recent"
              || !options?.mediaCapture.page.domText) {
            throw new Error("Enable webpage timing and watched page text in Media capture settings first.");
          }
          picker();
          return { picking: true };
        case "hd_capture_clear_area":
          clearTrackedArea();
          return { tracked: false };
        case "hd_capture_unlink": return unlink();
        default: throw new Error("Unknown capture command.");
      }
    }).then(result => sendResponse(result), error => sendResponse({ error: error.message || String(error) }));
    return true;
  });

  window.addEventListener("pagehide", () => {
    void unlink();
  });

  globalThis.HDCapture = { rootLookup, release };
}());
