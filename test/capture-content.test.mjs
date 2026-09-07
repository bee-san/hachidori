// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createCaptureTimeline, resolveCaptureInterval } from "../extension/capture-timeline.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));
const extension = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function timingBoundary() {
  const source = extension("background.js");
  const names = ["finiteCaptureTime", "shortCaptureString", "captureDocumentKey",
    "authoritativeCaptureRecord", "authoritativeCaptureIdentity"];
  const definitions = names.map(name => {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "mu"));
    assert.ok(match, `production timing boundary ${name} exists`);
    return match[0];
  }).join("\n");
  return vm.runInNewContext(`${definitions}\n({authoritativeCaptureRecord, authoritativeCaptureIdentity})`);
}

function fixture(t, {
  html = "<!doctype html><body><div id='area'><span id='line'>猫</span></div></body>",
  timingMode = "auto",
  autoLearnArea = true,
  setup = () => {},
  transport = () => {},
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
      // Opacity, visibility and aria-hidden do not remove browser layout boxes.
      if (node.hidden || style.display === "none") return true;
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
        message = JSON.parse(JSON.stringify(message));
        sent.push(message);
        const transported = transport(message);
        if (transported !== undefined) return transported;
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
  };
  window.eval(extension("reader-options.js"));
  window.eval(extension("capture-content.js"));

  function command(type, fields = {}) {
    if (type === "hd_capture_link" && !fields.mediaCapture) {
      fields = {
        ...fields,
        mediaCapture: {
          ...structuredClone(storedOptions.mediaCapture),
          texthooker: {
            enabled: storedOptions.mediaCapture.texthooker.enabled,
            format: storedOptions.mediaCapture.texthooker.format,
          },
        },
      };
    }
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
  let gameMoves = 0;
  let gameKeys = 0;
  target.addEventListener("click", () => { gameClicks++; });
  target.addEventListener("pointermove", () => { gameMoves++; });
  target.addEventListener("keydown", () => { gameKeys++; });
  await picker.command("hd_capture_track_area");
  const move = new picker.window.MouseEvent("pointermove", {
    bubbles: true, cancelable: true, clientX: 1, clientY: 1,
  });
  target.dispatchEvent(move);
  const key = new picker.window.KeyboardEvent("keydown", {
    bubbles: true, cancelable: true, key: "Enter",
  });
  target.dispatchEvent(key);
  const click = new picker.window.MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(click);
  await flush();
  assert.equal(move.defaultPrevented, true);
  assert.equal(key.defaultPrevented, true);
  assert.equal(click.defaultPrevented, true);
  assert.equal(gameMoves, 0);
  assert.equal(gameKeys, 0);
  assert.equal(gameClicks, 0);
  assert.ok(picker.sent.some(message => message.type === "hd_capture_text_begin"
    && message.record.onsetKnown === false));

  const editor = fixture(t, {
    autoLearnArea: false,
    html: "<!doctype html><body><div contenteditable><span id='line'>猫</span></div></body>",
  });
  await editor.command("hd_capture_link");
  const editableLine = editor.window.document.getElementById("line");
  editor.window.document.elementFromPoint = () => editableLine;
  await editor.command("hd_capture_track_area");
  editableLine.dispatchEvent(new editor.window.MouseEvent("pointermove", {
    bubbles: true, cancelable: true, clientX: 1, clientY: 1,
  }));
  editableLine.dispatchEvent(new editor.window.MouseEvent("click", {
    bubbles: true, cancelable: true,
  }));
  await flush();
  assert.equal(editor.sent.some(message => message.type === "hd_capture_text_begin"), false,
    "manual tracking does not collect text nested inside an editable control");
});

test("native cues observe actual transitions without changing track mode and reset epochs across pause", async t => {
  const boundary = timingBoundary();
  const timeline = createCaptureTimeline();
  const sender = { tab: { id: 7 }, documentId: "document-1" };
  let track;
  const f = fixture(t, {
    html: "<!doctype html><body><video id='video'></video></body>",
    transport(message) {
      if (message.type === "hd_capture_text_begin") {
        timeline.begin(boundary.authoritativeCaptureRecord(message, sender));
      } else if (message.type === "hd_capture_text_close") {
        timeline.close(boundary.authoritativeCaptureIdentity(message, sender), message.endMs);
      }
    },
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
  for (const [event, state, resumeEvent] of [
    ["pause", "paused", "play"], ["seeking", "seeking", "seeked"], ["ended", "ended", "play"],
  ]) {
    const active = timeline.snapshot().at(-1);
    video[state] = true;
    video.dispatchEvent(new f.window.Event(event));
    await flush();
    const closed = timeline.snapshot().at(-1);
    assert.equal(Number.isFinite(closed.endMs), true, `${event} crosses the production message validator`);
    assert.ok(closed.endMs >= active.startMs);
    const resolved = resolveCaptureInterval({ records: [{ ...closed, onsetKnown: true }],
      lookupText: closed.text, lookupTimeMs: closed.startMs, availableStartMs: closed.startMs - 1000 });
    assert.equal(resolved.pendingTail, false, `${event} cannot leave a cue tail open`);
    video[state] = false;
    video.dispatchEvent(new f.window.Event(resumeEvent));
    await flush();
    const resumed = f.sent.filter(message => message.type === "hd_capture_text_begin").at(-1);
    assert.equal(resumed.record.onsetKnown, false);
    assert.notEqual(`document-1:${resumed.record.sourceEpoch}`, active.sourceEpoch);
  }
  assert.equal(track.mode, "showing");
});

test("DOM ranges associate sentence lookups with their paragraph and reject ranges spanning occurrences", async t => {
  const f = fixture(t);
  await f.command("hd_capture_link");
  const area = f.window.document.getElementById("area");
  await f.window.HDCapture.rootLookup({ anchor: area.firstChild.firstChild, sentence: "猫", query: "猫" });
  area.innerHTML = "<p>犬。<em>鳥。</em></p><p>犬。鳥。</p>";
  await flush();
  const begins = f.sent.filter(message => message.type === "hd_capture_text_begin"
    && message.record.text === "犬。鳥。");
  assert.equal(begins.length, 2);
  assert.equal(begins.every(message => message.record.onsetKnown), true);
  const paragraphs = [...area.children];
  for (const [index, paragraph] of paragraphs.entries()) {
    const range = f.window.document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, 2);
    await f.window.HDCapture.rootLookup({ anchor: paragraph, anchorRange: range, sentence: "犬。", query: "犬" });
    const pin = f.sent.findLast(message => message.type === "hd_capture_pin");
    assert.equal(pin.lookup.occurrenceId, begins[index].record.occurrenceId);
    assert.equal(pin.lookup.occurrenceSourceKind, "dom");
    assert.deepEqual(Object.keys(pin.lookup).sort(),
      ["lookupText", "lookupTimeMs", "occurrenceId", "occurrenceSourceKind"]);
  }
  const spanning = f.window.document.createRange();
  spanning.setStart(paragraphs[0].firstChild, 0);
  spanning.setEnd(paragraphs[1].firstChild, 2);
  await f.window.HDCapture.rootLookup({ anchor: area, anchorRange: spanning, sentence: "犬。鳥。犬。", query: "犬" });
  assert.equal(f.sent.findLast(message => message.type === "hd_capture_pin").lookup.occurrenceId, "");

  const previousId = begins[0].record.occurrenceId;
  paragraphs[0].innerHTML = "犬。<span>鳥。</span>";
  await flush();
  const freshRange = f.window.document.createRange();
  freshRange.selectNodeContents(paragraphs[0].lastChild.firstChild);
  await f.window.HDCapture.rootLookup({ anchor: paragraphs[0], anchorRange: freshRange, sentence: "鳥。", query: "鳥" });
  assert.equal(f.sent.findLast(message => message.type === "hd_capture_pin").lookup.occurrenceId, previousId,
    "unchanged text refreshes its local range after node replacement");
});

test("transparent ancestors close watched text while browser-like layout boxes remain", async t => {
  const f = fixture(t, { autoLearnArea: false,
    html: "<!doctype html><body><main id='ancestor'><section><p id='line'>猫</p></section></main></body>" });
  await f.command("hd_capture_link");
  const line = f.window.document.getElementById("line");
  f.window.document.elementFromPoint = () => line;
  await f.command("hd_capture_track_area");
  line.dispatchEvent(new f.window.MouseEvent("pointermove", { bubbles: true, cancelable: true }));
  line.dispatchEvent(new f.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await f.window.HDCapture.rootLookup({ anchor: line.firstChild, sentence: "猫", query: "猫" });
  const before = f.sent.findLast(message => message.type === "hd_capture_text_begin");
  f.window.document.getElementById("ancestor").style.opacity = "0";
  assert.equal(line.getClientRects().length, 1);
  await flush();
  assert.ok(f.sent.some(message => message.type === "hd_capture_text_close"
    && message.identity.occurrenceId === before.record.occurrenceId && Number.isFinite(message.endMs)));
  f.window.document.getElementById("ancestor").style.opacity = "1";
  await flush();
  const shown = f.sent.findLast(message => message.type === "hd_capture_text_begin");
  assert.notEqual(shown.record.occurrenceId, before.record.occurrenceId);
  assert.equal(shown.record.onsetKnown, true);
});

test("worker recovery reports the surviving link without restarting timing or releasing pins", async t => {
  const f = fixture(t);
  assert.deepEqual(JSON.parse(JSON.stringify(await f.command("hd_capture_recover"))),
    { linked: false, documentId: null });
  await f.command("hd_capture_link");
  const line = f.window.document.getElementById("line");
  await f.window.HDCapture.rootLookup({ anchor: line.firstChild, sentence: "猫", query: "猫" });
  const before = f.sent.length;
  assert.deepEqual(JSON.parse(JSON.stringify(await f.command("hd_capture_recover"))),
    { linked: true, documentId: "document-1" });
  assert.equal(f.sent.length, before);
  await f.command("hd_capture_unlink");
  assert.deepEqual(JSON.parse(JSON.stringify(await f.command("hd_capture_recover"))),
    { linked: false, documentId: null });
});

test("root lookup freezes its timestamp and text before waiting for the previous pin release", async t => {
  let at = 1000;
  let releasePrevious, sawRelease;
  const releaseGate = new Promise(resolve => { releasePrevious = resolve; });
  const released = new Promise(resolve => { sawRelease = resolve; });
  const f = fixture(t, { timingMode: "recent",
    setup(window) { Object.defineProperty(window.performance, "now", { value: () => at }); },
    transport(message) {
      if (message.type === "hd_capture_release") { sawRelease(); return releaseGate; }
      return undefined;
    },
  });
  await f.command("hd_capture_link");
  const candidate = { anchor: f.window.document.getElementById("line").firstChild, sentence: "猫", query: "猫" };
  await f.window.HDCapture.rootLookup(candidate);
  at = 2000;
  const next = f.window.HDCapture.rootLookup(candidate);
  await released;
  at = 5000;
  candidate.sentence = "犬";
  releasePrevious({ ok: true });
  await next;
  const admitted = f.sent.findLast(message => message.type === "hd_capture_pin");
  assert.equal(admitted.lookup.lookupTimeMs, f.window.performance.timeOrigin + 2000);
  assert.equal(admitted.lookup.lookupText, "猫");
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

test("rolling unique lines retain identity while collapsed duplicate lines become unknown-onset baselines", async t => {
  const rolling = fixture(t, {
    html: `<!doctype html><body><section id="area">
      <p id="first">一行目</p><p id="second">二行目</p>
    </section></body>`,
  });
  await rolling.command("hd_capture_link");
  const second = rolling.window.document.getElementById("second");
  await rolling.window.HDCapture.rootLookup({
    anchor: second.firstChild,
    sentence: "二行目",
    query: "二行目",
  });
  await flush();
  const secondBaseline = rolling.sent.find(message =>
    message.type === "hd_capture_text_begin" && message.record.text === "二行目");
  rolling.window.document.getElementById("first").remove();
  const third = rolling.window.document.createElement("p");
  third.textContent = "三行目";
  rolling.window.document.getElementById("area").append(third);
  await flush();
  const rollingBegins = rolling.sent.filter(message => message.type === "hd_capture_text_begin");
  assert.equal(rollingBegins.filter(message =>
    message.record.occurrenceId === secondBaseline.record.occurrenceId).length, 1);
  assert.equal(rollingBegins.find(message => message.record.text === "三行目").record.onsetKnown, true);

  const duplicate = fixture(t, {
    html: `<!doctype html><body><section id="area">
      <p id="first">同じ行</p><p id="second">同じ行</p>
    </section></body>`,
  });
  await duplicate.command("hd_capture_link");
  const duplicateSecond = duplicate.window.document.getElementById("second");
  await duplicate.window.HDCapture.rootLookup({
    anchor: duplicateSecond.firstChild,
    sentence: "同じ行",
    query: "同じ行",
  });
  await flush();
  const baselineCount = duplicate.sent.filter(message =>
    message.type === "hd_capture_text_begin" && message.record.text === "同じ行").length;
  duplicate.window.document.getElementById("first").remove();
  await flush();
  const duplicateBegins = duplicate.sent.filter(message =>
    message.type === "hd_capture_text_begin" && message.record.text === "同じ行");
  assert.equal(duplicateBegins.length, baselineCount + 1);
  assert.equal(duplicateBegins.at(-1).record.onsetKnown, false);

  const ambiguousTypewriter = fixture(t, {
    html: `<!doctype html><body><section id="area">
      <p>同じ行</p><p id="second">同じ行</p>
    </section></body>`,
  });
  await ambiguousTypewriter.command("hd_capture_link");
  const ambiguousSecond = ambiguousTypewriter.window.document.getElementById("second");
  await ambiguousTypewriter.window.HDCapture.rootLookup({
    anchor: ambiguousSecond.firstChild,
    sentence: "同じ行",
    query: "同じ行",
  });
  await flush();
  const ambiguousIds = new Set(ambiguousTypewriter.sent
    .filter(message => message.type === "hd_capture_text_begin" && message.record.text === "同じ行")
    .map(message => message.record.occurrenceId));
  ambiguousSecond.textContent = "同じ行の続き";
  await flush();
  const extended = ambiguousTypewriter.sent.findLast(message =>
    message.type === "hd_capture_text_begin" && message.record.text === "同じ行の続き");
  assert.equal(extended.record.onsetKnown, true,
    "the observed edit has a known onset");
  assert.equal(ambiguousIds.has(extended.record.occurrenceId), false,
    "a typewriter edit does not inherit an ambiguous duplicate occurrence");
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
  const beforeReselect = f.sent.findLast(message => message.type === "hd_capture_text_begin");
  await f.command("hd_capture_video_select", { videoId: linked.videos[1].id });
  await flush();
  const reselected = f.sent.findLast(message => message.type === "hd_capture_text_begin");
  assert.notEqual(reselected.record.sourceEpoch, beforeReselect.record.sourceEpoch,
    "reselecting the same video cannot reuse an earlier playback epoch");
  assert.equal(firstTrack.mode, "showing");
  assert.equal(secondTrack.mode, "showing");
});
