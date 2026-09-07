// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));
const extension = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, {
  html = "<!doctype html><body><div id='area'><span id='line'>猫</span></div></body>",
  timingMode = "auto",
  autoLearnArea = true,
  setup = () => {},
} = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://reader.example/game" });
  t.after(() => dom.window.close());
  const { window } = dom;
  if (typeof window.crypto.randomUUID !== "function") {
    let uuid = 0;
    Object.defineProperty(window.crypto, "randomUUID", { value: () => `uuid-${++uuid}` });
  }
  const hidden = element => {
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || node.getAttribute("aria-hidden") === "true"
          || style.display === "none" || style.visibility === "hidden"
          || style.visibility === "collapse" || Number(style.opacity) === 0) return true;
    }
    return false;
  };
  window.Element.prototype.getClientRects = function getClientRects() {
    return hidden(this) ? [] : [{ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }];
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return this.getClientRects()[0] ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  setup(window);

  const sent = [];
  let listener;
  let pinSequence = 0;
  const storedOptions = {
    mediaCapture: {
      enabled: true,
      timingMode,
      includeAnimation: true,
      includeCapturedAudio: true,
      historySeconds: 60,
      clipSeconds: 10,
      videoPreset: "standard",
      estimatedOffsetMs: -500,
      texthooker: { enabled: false, url: "", format: "plain" },
      page: { nativeCues: true, domText: true, autoLearnArea },
    },
  };
  window.chrome = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        if (message.type === "hd_capture_content_identify") {
          return { ok: true, documentId: "document-1", tabId: 7 };
        }
        if (message.type === "hd_capture_pin") {
          const id = ++pinSequence;
          return {
            ok: true,
            token: `pin-${id}`,
            captureSessionId: "capture-1",
            sourceKind: message.lookup.occurrenceSourceKind || "recent",
            sourceLabel: message.lookup.occurrenceSourceKind === "dom" ? "Page-text estimate" : "Recent clip",
            partial: false,
            animationFilename: `hachidori-pin${id}.avif`,
            audioFilename: `hachidori-pin${id}.wav`,
            readyAtMs: message.lookup.lookupTimeMs,
          };
        }
        return { ok: true };
      },
      onMessage: {
        addListener(value) { listener = value; },
      },
    },
    storage: {
      local: {
        async get() { return { options: storedOptions }; },
      },
    },
  };
  window.eval(extension("reader-options.js"));
  window.eval(extension("capture-content.js"));

  function command(type, fields = {}) {
    return new Promise((resolve, reject) => {
      const handled = listener({ target: "hachidori-capture-content", type, ...fields }, {}, reply => {
        if (reply?.error) reject(new Error(reply.error));
        else resolve(reply);
      });
      if (!handled) reject(new Error(`Command ${type} was not handled`));
    });
  }
  return { window, sent, command };
}

test("root pins replace one another while DOM baseline, typewriter, replacement, hide and remount stay conservative", async t => {
  const f = fixture(t);
  await f.command("hd_capture_link");
  const line = f.window.document.getElementById("line");
  const candidate = sentence => ({ anchor: line.firstChild, sentence, query: sentence });
  const first = await f.window.HDCapture.rootLookup(candidate("猫"));
  await flush();
  const baseline = f.sent.find(message => message.type === "hd_capture_text_begin");
  assert.equal(baseline.record.text, "猫");
  assert.equal(baseline.record.onsetKnown, false);
  const firstPin = f.sent.find(message => message.type === "hd_capture_pin");
  assert.equal(firstPin.lookup.occurrenceId, baseline.record.occurrenceId);
  assert.equal(firstPin.lookup.occurrenceSourceKind, "dom");

  line.firstChild.nodeValue = "猫が";
  await flush();
  const revisions = f.sent.filter(message => message.type === "hd_capture_text_begin");
  assert.equal(revisions.at(-1).record.occurrenceId, baseline.record.occurrenceId);
  assert.equal(revisions.at(-1).record.text, "猫が");

  const second = await f.window.HDCapture.rootLookup(candidate("猫が"));
  assert.equal(second.token, "pin-2");
  assert.ok(f.sent.some(message => message.type === "hd_capture_release" && message.token === first.token));

  line.firstChild.nodeValue = "犬";
  await flush();
  const replacement = f.sent.filter(message => message.type === "hd_capture_text_begin").at(-1);
  assert.notEqual(replacement.record.occurrenceId, baseline.record.occurrenceId);
  assert.ok(f.sent.some(message => message.type === "hd_capture_text_close"
    && message.identity.occurrenceId === baseline.record.occurrenceId));

  const added = f.window.document.createElement("div");
  added.textContent = "鳥";
  f.window.document.getElementById("area").append(added);
  await flush();
  assert.ok(f.sent.some(message => message.type === "hd_capture_text_begin" && message.record.text === "鳥"));

  f.window.document.getElementById("area").style.display = "none";
  await flush();
  const closeCount = f.sent.filter(message => message.type === "hd_capture_text_close").length;
  assert.ok(closeCount >= 3);

  f.window.document.getElementById("area").remove();
  await flush();
  assert.ok(f.sent.some(message => message.type === "hd_capture_page_status"
    && /replaced/u.test(message.message)));
});

test("Recent mode emits no page timing and the area picker consumes game input", async t => {
  const recent = fixture(t, { timingMode: "recent" });
  await recent.command("hd_capture_link");
  const line = recent.window.document.getElementById("line");
  await recent.window.HDCapture.rootLookup({ anchor: line.firstChild, sentence: "猫", query: "猫" });
  await flush();
  assert.equal(recent.sent.some(message => message.type === "hd_capture_text_begin"), false);
  await assert.rejects(recent.command("hd_capture_track_area"), /webpage timing/u);

  const picker = fixture(t, { autoLearnArea: false });
  await picker.command("hd_capture_link");
  const target = picker.window.document.getElementById("line");
  picker.window.document.elementFromPoint = () => target;
  let gameClicks = 0;
  target.addEventListener("click", () => { gameClicks++; });
  await picker.command("hd_capture_track_area");
  picker.window.dispatchEvent(new picker.window.MouseEvent("pointermove", {
    bubbles: true, cancelable: true, clientX: 1, clientY: 1,
  }));
  const click = new picker.window.MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(click);
  await flush();
  assert.equal(click.defaultPrevented, true);
  assert.equal(gameClicks, 0);
  assert.ok(picker.sent.some(message => message.type === "hd_capture_text_begin"
    && message.record.onsetKnown === false));
});

test("native cues observe actual transitions without changing track mode and reset epochs across pause", async t => {
  let track;
  const f = fixture(t, {
    html: "<!doctype html><body><video id='video'></video></body>",
    setup(window) {
      const video = window.document.getElementById("video");
      for (const [name, value] of [["paused", false], ["seeking", false], ["ended", false],
        ["videoWidth", 640], ["videoHeight", 360]]) {
        Object.defineProperty(video, name, { configurable: true, writable: true, value });
      }
      track = new window.EventTarget();
      track.mode = "showing";
      track.activeCues = [{ id: "cue-1", text: "猫" }];
      const tracks = new window.EventTarget();
      tracks[Symbol.iterator] = function* iterator() { yield track; };
      Object.defineProperty(video, "textTracks", { configurable: true, value: tracks });
    },
  });
  await f.command("hd_capture_link");
  await flush();
  const initial = f.sent.find(message => message.type === "hd_capture_text_begin");
  assert.equal(initial.record.text, "猫");
  assert.equal(initial.record.onsetKnown, false);
  assert.equal(track.mode, "showing");

  track.activeCues = [{ id: "cue-2", text: "犬" }];
  track.dispatchEvent(new f.window.Event("cuechange"));
  await flush();
  const witnessed = f.sent.filter(message => message.type === "hd_capture_text_begin").at(-1);
  assert.equal(witnessed.record.text, "犬");
  assert.equal(witnessed.record.onsetKnown, true);
  assert.ok(f.sent.some(message => message.type === "hd_capture_text_close"
    && message.identity.occurrenceId === initial.record.occurrenceId));

  const video = f.window.document.getElementById("video");
  video.paused = true;
  video.dispatchEvent(new f.window.Event("pause"));
  await flush();
  video.paused = false;
  video.dispatchEvent(new f.window.Event("play"));
  await flush();
  const resumed = f.sent.filter(message => message.type === "hd_capture_text_begin").at(-1);
  assert.equal(resumed.record.onsetKnown, false);
  assert.notEqual(resumed.record.sourceEpoch, witnessed.record.sourceEpoch);
  assert.equal(track.mode, "showing");
});

test("Tsukiweb-style accumulating text retains older line onsets through typewriter and style updates", async t => {
  const f = fixture(t, {
    html: `<!doctype html><body>
      <section id="text-layer">
        <p id="previous">前の行</p>
        <p id="newest"><span id="typewriter">猫</span></p>
      </section>
    </body>`,
  });
  await f.command("hd_capture_link");
  const newest = f.window.document.getElementById("typewriter");
  await f.window.HDCapture.rootLookup({ anchor: newest.firstChild, sentence: "猫", query: "猫" });
  await flush();
  const baseline = f.sent.filter(message => message.type === "hd_capture_text_begin");
  const previous = baseline.find(message => message.record.text === "前の行");
  const latest = baseline.find(message => message.record.text === "猫");
  assert.ok(previous);
  assert.ok(latest);
  assert.equal(previous.record.onsetKnown, false);
  assert.equal(latest.record.onsetKnown, false);

  newest.firstChild.nodeValue = "猫がいる";
  await flush();
  const afterTyping = f.sent.filter(message => message.type === "hd_capture_text_begin");
  assert.equal(afterTyping.filter(message => message.record.occurrenceId === previous.record.occurrenceId).length, 1);
  const typed = afterTyping.at(-1);
  assert.equal(typed.record.occurrenceId, latest.record.occurrenceId);
  assert.equal(typed.record.text, "猫がいる");

  f.window.document.getElementById("text-layer").style.color = "rgb(1, 2, 3)";
  await flush();
  assert.equal(f.sent.filter(message => message.type === "hd_capture_text_begin").length, afterTyping.length);

  const next = f.window.document.createElement("p");
  next.textContent = "次の行";
  f.window.document.getElementById("text-layer").append(next);
  await flush();
  const accumulated = f.sent.filter(message => message.type === "hd_capture_text_begin");
  assert.equal(accumulated.filter(message => message.record.occurrenceId === previous.record.occurrenceId).length, 1);
  assert.equal(accumulated.filter(message => message.record.text === "次の行").length, 1);
});

test("multiple videos require an explicit cue source and ignore the unselected video", async t => {
  let firstTrack, secondTrack;
  const f = fixture(t, {
    html: "<!doctype html><body><video id='first'></video><video id='second'></video></body>",
    setup(window) {
      for (const [index, id] of ["first", "second"].entries()) {
        const video = window.document.getElementById(id);
        for (const [name, value] of [["paused", false], ["seeking", false], ["ended", false],
          ["videoWidth", 640 - index * 160], ["videoHeight", 360 - index * 90]]) {
          Object.defineProperty(video, name, { configurable: true, writable: true, value });
        }
        video.title = `${id} video`;
        const track = new window.EventTarget();
        track.mode = "showing";
        track.activeCues = [{ id: `${id}-cue`, text: index === 0 ? "一" : "二" }];
        const tracks = new window.EventTarget();
        tracks[Symbol.iterator] = function* iterator() { yield track; };
        Object.defineProperty(video, "textTracks", { configurable: true, value: tracks });
        if (index === 0) firstTrack = track;
        else secondTrack = track;
      }
    },
  });
  const linked = await f.command("hd_capture_link");
  assert.equal(linked.videos.length, 2);
  assert.equal(f.sent.some(message => message.type === "hd_capture_text_begin"), false);

  await f.command("hd_capture_video_select", { videoId: linked.videos[1].id });
  await flush();
  assert.ok(f.sent.some(message => message.type === "hd_capture_text_begin" && message.record.text === "二"));
  const count = f.sent.filter(message => message.type === "hd_capture_text_begin").length;
  firstTrack.activeCues = [{ id: "first-new", text: "無視" }];
  firstTrack.dispatchEvent(new f.window.Event("cuechange"));
  await flush();
  assert.equal(f.sent.filter(message => message.type === "hd_capture_text_begin").length, count);

  secondTrack.activeCues = [{ id: "second-new", text: "選択済み" }];
  secondTrack.dispatchEvent(new f.window.Event("cuechange"));
  await flush();
  assert.ok(f.sent.some(message => message.type === "hd_capture_text_begin"
    && message.record.text === "選択済み"));
  assert.equal(firstTrack.mode, "showing");
  assert.equal(secondTrack.mode, "showing");
});
