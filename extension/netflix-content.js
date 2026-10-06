// SPDX-License-Identifier: GPL-3.0-or-later

// Experimental Netflix mining, the reader's side. netflix.js registers this
// classic script after netflix-subtitles.js in the content scripts' world on
// https://www.netflix.com/* (top frame, document_start) while Settings →
// Advanced → Experimental features → Netflix mining is on. It keeps the
// subtitle timelines netflix-page.js posts from the page, pins the cue of a
// hovered `.player-timedtext` line, and drives one replay while the extension
// records that line for Anki.
(function () {
  "use strict";

  const PAGE_EVENT = "hachidori-netflix-page";
  const COMMAND_EVENT = "hachidori-netflix-command";
  const WATCH_PATH = /^\/watch\/(\d+)/u;
  const MOVIE_ID = /^\d+$/u;
  const STATUSES = new Set(["image", "none", "failed"]);
  const FORMATS = new Set(["webvtt", "ttml"]);
  // The page gives up on a replay after its two bounded seeks (10 s each) and
  // REPLAY_SLACK_MS in netflix-page.js; the reader waits a little longer for
  // that answer.
  const REPLAY_SLACK_MS = 35_000;
  const SHOW_TEXT = 4;

  function createNetflix(window, subtitles = window.HDNetflixSubtitles) {
    const { document, location } = window;
    // movieId → { tracks: Map(trackId → { id, closedCaptions, cues }), status, chosen }
    const movies = new Map();
    // Movies this page has moved away from: their late posts are not wanted.
    const retired = new Set();
    const resent = new Set();
    const replays = new Map();
    let watched = null;

    const command = message => {
      document.dispatchEvent(new window.CustomEvent(COMMAND_EVENT, { detail: JSON.stringify(message) }));
    };

    // A new /watch/<id> drops the previous movie's timeline.
    function sync() {
      const movieId = WATCH_PATH.exec(location.pathname)?.[1] ?? null;
      if (movieId === watched) return movieId;
      if (watched !== null) {
        retired.add(watched);
        movies.delete(watched);
      }
      if (movieId !== null) retired.delete(movieId);
      resent.clear();
      watched = movieId;
      return movieId;
    }

    function movie(movieId) {
      if (!movies.has(movieId)) movies.set(movieId, { tracks: new Map(), status: null, chosen: null });
      return movies.get(movieId);
    }

    function settleReplay(message) {
      const pending = typeof message.id === "string" ? replays.get(message.id) : undefined;
      if (pending === undefined) return;
      replays.delete(message.id);
      window.clearTimeout(pending.timer);
      if (message.ok === true && Array.isArray(message.anchors)) {
        pending.resolve(message.anchors.filter(pair => Array.isArray(pair) && pair.length === 2
          && pair.every(Number.isFinite)));
      } else {
        pending.reject(Object.assign(new Error(`Netflix's player could not replay the line (${message.error}).`),
          { code: message.error === "player" ? "player" : "replay" }));
      }
    }

    // Everything the page posts is checked before it is used: any script on
    // the page can dispatch these events.
    function accept(detail) {
      let message;
      try {
        message = JSON.parse(detail);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      sync();
      if (message.kind === "replay") {
        settleReplay(message);
        return;
      }
      if (typeof message.movieId !== "string" || !MOVIE_ID.test(message.movieId) || retired.has(message.movieId)) return;
      if (message.kind === "status" && STATUSES.has(message.subtitles)) {
        movie(message.movieId).status ??= message.subtitles;
        return;
      }
      if (message.kind !== "subtitle" || typeof message.trackId !== "string" || message.trackId === ""
          || typeof message.closedCaptions !== "boolean" || !FORMATS.has(message.format)
          || typeof message.text !== "string") return;
      let cues;
      try {
        cues = subtitles.parseSubtitles(message.format, message.text, { DOMParser: window.DOMParser });
      } catch {
        movie(message.movieId).status ??= "failed";
        return;
      }
      movie(message.movieId).tracks.set(message.trackId, { id: message.trackId, closedCaptions: message.closedCaptions,
        cues: cues.map(cue => ({ ...cue, key: subtitles.normaliseCueText(cue.text) })) });
    }

    function visibleText(element) {
      const walker = document.createTreeWalker(element, SHOW_TEXT);
      let text = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest("rt, rp")) text += node.nodeValue;
      }
      return text;
    }

    function mediaTimeMs() {
      const video = document.querySelector(".watch-video video") ?? document.querySelector("video");
      return video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : null;
    }

    // What the reader saw when the popup opened: the subtitle line under the
    // pointer and the video's time. Null for anything but Netflix's subtitles.
    function observe(element) {
      const subtitle = element?.closest?.(".player-timedtext");
      if (!subtitle) return null;
      const container = element.closest(".player-timedtext-text-container") ?? subtitle;
      return { movieId: sync(), mediaTimeMs: mediaTimeMs(), lineText: visibleText(container),
        hoveredText: visibleText(element) };
    }

    function askAgain(movieId) {
      if (resent.has(movieId)) return;
      resent.add(movieId);
      command({ type: "resend", movieId });
    }

    // The cue an observation belongs to, or the reason there is none. With
    // Japanese and Japanese [CC] tracks, the first line that matches in only
    // one of them chooses that track for the episode.
    function resolve(observation) {
      sync();
      const movieId = observation?.movieId;
      const entry = typeof movieId === "string" ? movies.get(movieId) : undefined;
      if (entry === undefined || entry.tracks.size === 0) {
        if (typeof movieId === "string" && !entry?.status) askAgain(movieId);
        return { reason: entry?.status ?? "no-timeline" };
      }
      const tracks = entry.chosen ? [entry.chosen]
        : [...entry.tracks.values()].sort((left, right) => left.closedCaptions - right.closedCaptions);
      let ambiguous = false;
      for (const text of new Set([observation.lineText, observation.hoveredText])) {
        const found = tracks.map(track => ({ track, cues: subtitles.matchingCues(track.cues, observation.mediaTimeMs, text) }));
        const unique = found.find(candidate => candidate.cues.length === 1);
        if (unique !== undefined) {
          if (entry.chosen === null && entry.tracks.size > 1 && found.filter(candidate => candidate.cues.length > 0).length === 1) {
            entry.chosen = unique.track;
          }
          const [cue] = unique.cues;
          return { cue: { movieId, trackId: unique.track.id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text } };
        }
        if (found.some(candidate => candidate.cues.length > 1)) ambiguous = true;
      }
      return { reason: ambiguous ? "ambiguous" : "no-match" };
    }

    // The mining request's Netflix fields. `sentence` is the root lookup's
    // candidate, whose sentence becomes the whole cue; nested lookups keep
    // their own sentence and inherit only the cue.
    function miningFields(observation, sentence = null) {
      if (!observation) return {};
      const resolved = resolve(observation);
      if (!resolved.cue) return { netflix: { unavailable: resolved.reason } };
      const { movieId, startMs, endMs, text } = resolved.cue;
      const whole = sentence ? subtitles.cueSentence(text, sentence.sentence, sentence.matchOffset) : null;
      return { netflix: { cue: { movieId, startMs, endMs } }, ...(whole ?? {}) };
    }

    function replay(cue, padMs) {
      const id = window.crypto.randomUUID();
      return new Promise((resolveReplay, rejectReplay) => {
        const timer = window.setTimeout(() => {
          replays.delete(id);
          rejectReplay(Object.assign(new Error("Netflix's player did not finish replaying the line."), { code: "replay" }));
        }, cue.endMs - cue.startMs + 2 * padMs + REPLAY_SLACK_MS);
        replays.set(id, { resolve: resolveReplay, reject: rejectReplay, timer });
        command({ type: "replay", id, startMs: cue.startMs, endMs: cue.endMs, padMs });
      });
    }

    // The hidden extension frame that records the tab (netflix-capture.js).
    function recorderFrame() {
      const frame = document.createElement("iframe");
      frame.src = window.chrome.runtime.getURL("netflix-recorder.html");
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.setProperty("display", "none", "important");
      // Outside Netflix's own app root, so its rendering cannot remove it.
      document.documentElement.append(frame);
      return frame;
    }

    // Records the cue's line: a recorder frame opens the tab's stream, the page
    // replays the line, then the frame cuts the clip and the worker holds its
    // WAV for the note. Resolves with the held file or with why there is none.
    async function record(cue, { send, templateId }) {
      const frame = recorderFrame();
      try {
        const started = await send("hd_netflix_capture_start", { cue });
        if (typeof started.unavailable === "string") return { unavailable: started.unavailable };
        if (typeof started.sessionId !== "string" || !Number.isFinite(started.padMs)) {
          throw new Error("the recording did not start.");
        }
        let anchors;
        try {
          anchors = await replay(cue, started.padMs);
        } catch (error) {
          await send("hd_netflix_capture_cancel", { sessionId: started.sessionId }).catch(() => {});
          return { unavailable: error.code === "player" ? "player" : "replay" };
        }
        return await send("hd_netflix_capture_finish", { sessionId: started.sessionId, anchors, templateId });
      } finally {
        frame.remove();
      }
    }

    document.addEventListener(PAGE_EVENT, event => {
      if (typeof event.detail === "string") accept(event.detail);
    });

    return { observe, resolve, miningFields, record };
  }

  globalThis.HDNetflix = { ...createNetflix(globalThis), createNetflix };
}());
