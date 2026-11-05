// SPDX-License-Identifier: GPL-3.0-or-later
//
// Experimental YouTube mining, the page's side. youtube.js registers this
// script in the main world of https://www.youtube.com/* at document_start while
// Settings → Advanced → Experimental features → YouTube mining is on, so it is
// in place before YouTube's player loads a caption file. No extension API is
// available here; it talks to youtube-content.js through DOM events whose
// detail is a JSON string, as netflix-page.js does on Netflix.
//
// YouTube's player loads the caption track it shows as json3 from
// /api/timedtext, with a proof-of-origin token that a request of Hachidori's
// own would lack (YouTube then answers with an empty file). So this script
// keeps nothing of its own: it posts the text of each caption file the player
// receives, with the video and language it is for, and which video the player
// plays. It also replays, pauses and resumes the video through the player.
(function () {
  "use strict";

  const PAGE_EVENT = "hachidori-youtube-page";
  const COMMAND_EVENT = "hachidori-youtube-command";
  const VIDEO_ID = /^[\w-]{11}$/u;
  const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z\d]{1,8})*$/u;
  const POLL_MS = 25;
  const SEEK_TIMEOUT_MS = 10_000;
  // Beyond the line itself, a replay has this long to buffer and play.
  const REPLAY_SLACK_MS = 10_000;
  // A seek that lands after the clip's start is retried this much earlier.
  const PREROLL_MS = 2000;
  // The events after which the player may play another video.
  const NAVIGATION_EVENTS = ["yt-navigate-finish", "yt-player-updated"];
  const MEDIA_EVENTS = ["loadstart", "loadedmetadata", "playing"];

  const originalStringify = JSON.stringify;
  const originalParse = JSON.parse;
  const originalOpen = XMLHttpRequest.prototype.open;
  // What was posted, by video, so a reader that missed it can ask again: only
  // the video the player plays and the latest one a caption file came for.
  const posted = new Map();
  // The video the player plays, as last posted.
  let reported = { movieId: null, live: false };
  let replaying = false;

  const post = message => {
    document.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: Reflect.apply(originalStringify, JSON, [message]) }));
  };
  const player = () => document.getElementById("movie_player");
  const mainVideo = () => document.querySelector("#movie_player video.html5-main-video")
    ?? document.querySelector("#movie_player video");
  const adShowing = () => player()?.classList.contains("ad-showing") === true;

  function retain(movieId) {
    for (const id of posted.keys()) if (id !== movieId && id !== reported.movieId) posted.delete(id);
    if (!posted.has(movieId)) posted.set(movieId, new Map());
  }

  function publish(movieId, key, message) {
    retain(movieId);
    posted.get(movieId).set(key, message);
    post(message);
  }

  // The video the player has, from its own data, and whether it is live.
  function playerVideo() {
    try {
      const data = player()?.getVideoData?.();
      const movieId = typeof data?.video_id === "string" && VIDEO_ID.test(data.video_id) ? data.video_id : null;
      return { movieId, live: movieId !== null && data.isLive === true };
    } catch {
      return { movieId: null, live: false };
    }
  }

  // Posts which video the player plays when that changes, or when the reader
  // asks. A live stream's captions are not read: their times are the stream's.
  function report(always = false) {
    const current = playerVideo();
    const changed = current.movieId !== reported.movieId || current.live !== reported.live;
    reported = current;
    if (changed || always) post({ kind: "video", movieId: current.movieId });
    if (changed && current.live) {
      publish(current.movieId, "status", { kind: "status", movieId: current.movieId, subtitles: "live" });
    }
  }

  // A caption file the player asked for: /api/timedtext on this origin, as
  // json3, for one video in one language (a translation's `tlang`).
  function captionFile(url) {
    let address;
    try {
      address = new URL(url, location.href);
    } catch {
      return null;
    }
    if (address.origin !== location.origin || address.pathname !== "/api/timedtext") return null;
    const params = address.searchParams;
    const movieId = params.get("v") ?? "";
    const language = params.get("tlang") || params.get("lang") || "";
    if (!VIDEO_ID.test(movieId) || !LANGUAGE_TAG.test(language) || params.get("fmt") !== "json3") return null;
    return { movieId, language };
  }

  // The player shows one track at a time and loads it again when it is chosen
  // again, so the latest file of a video is the one on screen: it is posted
  // as that video's only track.
  function keep(file, text) {
    report();
    if (file.movieId === reported.movieId && reported.live) return;
    publish(file.movieId, "track", { kind: "subtitle", movieId: file.movieId, trackId: "shown", closedCaptions: false,
      format: "json3", language: file.language, text });
  }

  XMLHttpRequest.prototype.open = function open() {
    try {
      const file = captionFile(String(arguments[1]));
      if (file !== null) {
        this.addEventListener("load", () => {
          try {
            if (this.status === 200 && (this.responseType === "" || this.responseType === "text") && this.responseText) {
              keep(file, this.responseText);
            }
          } catch {
            // The player gets its response whatever this script makes of it.
          }
        });
      }
    } catch {
      // A request Hachidori cannot read is opened exactly as the player asked.
    }
    return Reflect.apply(originalOpen, this, arguments);
  };

  const wallClock = () => performance.timeOrigin + performance.now();

  // YouTube's own player methods keep its controls in step with the video;
  // the element's stand in for any it lacks.
  const play = (api, video) => Promise.resolve(typeof api?.playVideo === "function" ? api.playVideo() : video.play());
  const pause = (api, video) => (typeof api?.pauseVideo === "function" ? api.pauseVideo() : video.pause());
  const rateOf = (api, video) => {
    const rate = typeof api?.getPlaybackRate === "function" ? Number(api.getPlaybackRate()) : Number.NaN;
    return Number.isFinite(rate) && rate > 0 ? rate : video.playbackRate;
  };
  function setRate(api, video, rate) {
    if (typeof api?.setPlaybackRate === "function") api.setPlaybackRate(rate);
    else video.playbackRate = rate;
  }
  function seekTo(api, video, ms) {
    const seconds = Math.max(0, Math.round(ms)) / 1000;
    if (typeof api?.seekTo === "function") api.seekTo(seconds, true);
    else video.currentTime = seconds;
  }

  function seek(api, video, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        video.removeEventListener("seeked", done);
        reject(Object.assign(new Error("seek"), { code: "seek" }));
      }, SEEK_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        resolve(video.currentTime * 1000);
      }
      video.addEventListener("seeked", done, { once: true });
      try {
        seekTo(api, video, ms);
      } catch {
        // The timeout reports it.
      }
    });
  }

  // Each part of the viewer's state is restored on its own, whatever the
  // others do. A line played on stays where it ended.
  function restore(api, video, saved, seekBack) {
    const steps = [
      () => pause(api, video),
      () => { if (seekBack) seekTo(api, video, saved.positionMs); },
      () => setRate(api, video, saved.rate),
      () => { if (!saved.paused) play(api, video).catch(() => {}); },
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        // The remaining steps still run.
      }
    }
  }

  // (wall-clock ms, media ms) pairs while the video plays forward, until media
  // time `to`; a replay that has not got there by `deadline`, or that an ad
  // interrupts, failed.
  function sample(video, to, deadline) {
    return new Promise((resolve, reject) => {
      const anchors = [];
      let previous = null;
      const timer = setInterval(() => {
        if (adShowing()) {
          clearInterval(timer);
          reject(Object.assign(new Error("ad"), { code: "ad" }));
          return;
        }
        const media = video.currentTime * 1000;
        if (!video.paused && !video.seeking && previous !== null && media > previous) anchors.push([wallClock(), media]);
        previous = media;
        if (media >= to || video.ended) {
          clearInterval(timer);
          resolve(anchors);
        } else if (wallClock() > deadline) {
          clearInterval(timer);
          reject(Object.assign(new Error("timeout"), { code: "timeout" }));
        }
      }, POLL_MS);
    });
  }

  // Plays the clip once at 1× from just before the cue to just after it and
  // reports (wall-clock ms, media ms) pairs, as netflix-page.js does: the
  // position, paused state and speed are restored; with `keepPaused` a playing
  // video is restored paused, and with `playOn` it plays from where it stands
  // and stays at the clip's end.
  async function replay({ id, startMs, endMs, padMs, keepPaused, playOn }) {
    const api = player();
    const video = mainVideo();
    if (video === null || replaying || adShowing()) {
      post({ kind: "replay", id, ok: false, error: replaying ? "busy" : (video === null ? "player" : "ad") });
      return;
    }
    replaying = true;
    const reportedMs = typeof api?.getCurrentTime === "function" ? Number(api.getCurrentTime()) * 1000 : Number.NaN;
    const saved = { positionMs: Number.isFinite(reportedMs) ? reportedMs : video.currentTime * 1000,
      paused: video.paused || keepPaused === true, rate: rateOf(api, video) };
    const from = Math.max(0, startMs - padMs);
    const to = endMs + padMs;
    let reply;
    try {
      setRate(api, video, 1);
      if (playOn !== true) {
        const landed = await seek(api, video, from);
        if (landed > from + 50 && from > 0) await seek(api, video, from - PREROLL_MS);
      }
      await play(api, video);
      const anchors = await sample(video, to, wallClock() + (to - from) + REPLAY_SLACK_MS);
      reply = { kind: "replay", id, ok: true, anchors };
    } catch (error) {
      reply = { kind: "replay", id, ok: false, error: error?.code ?? "replay" };
    } finally {
      restore(api, video, saved, playOn !== true);
      replaying = false;
    }
    post(reply);
  }

  // Hovering a caption pauses and resumes like the replay, which owns the
  // player until it has restored the viewer's state.
  function pauseOrResume(type) {
    const video = mainVideo();
    if (replaying || video === null) return;
    try {
      if (type === "pause") pause(player(), video);
      else play(player(), video).catch(() => {});
    } catch {
      // YouTube's player stays as it was.
    }
  }

  document.addEventListener(COMMAND_EVENT, event => {
    let command;
    try {
      command = typeof event.detail === "string" ? Reflect.apply(originalParse, JSON, [event.detail]) : null;
    } catch {
      return;
    }
    if (command?.type === "resend" && typeof command.movieId === "string") {
      for (const message of posted.get(command.movieId)?.values() ?? []) post(message);
    } else if (command?.type === "state") {
      report(true);
    } else if (command?.type === "replay" && typeof command.id === "string"
        && [command.startMs, command.endMs, command.padMs].every(Number.isFinite) && command.startMs <= command.endMs) {
      void replay(command);
    } else if (command?.type === "pause" || command?.type === "resume") {
      pauseOrResume(command.type);
    }
  });
  for (const type of NAVIGATION_EVENTS) document.addEventListener(type, () => report());
  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, event => { if (event.target === mainVideo()) report(); }, true);
  }
  report();
}());
