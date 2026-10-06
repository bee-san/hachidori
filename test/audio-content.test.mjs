// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

function fixture(t, { popupRect } = {}) {
  const dom = new JSDOM("<body><div id='host'></div></body>", { pretendToBeVisual: true, runScripts: "outside-only", url: "https://example.test" });
  const { window } = dom;
  let listener;
  const sent = [];
  window.chrome = { runtime: { onMessage: { addListener(value) { listener = value; }, removeListener() { listener = null; } } } };
  for (const file of ["reader-options.js", "render/popup.js", "audio-content.js"]) window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  const controller = window.HDAudio.createAudioController({ window, onMenuChange() {}, popupRect,
    send(type, fields) {
      if (type === "hd_audio_stop") { sent.push({ type, ...fields }); return Promise.resolve({ ok: true }); }
      return new Promise(resolveReply => sent.push({ type, ...fields, resolveReply }));
    },
  });
  const shadow = window.document.getElementById("host").attachShadow({ mode: "open" });
  function view(expression = "聞く", request = {}) {
    const popup = window.document.createElement("div");
    const button = window.document.createElement("button"), status = window.document.createElement("output");
    const control = window.document.createElement("div");
    control.className = "gsm-hoshidicts-audio-control";
    control.append(button, status);
    popup.append(control);
    shadow.append(popup);
    const result = { term: { expression, reading: "きく" } };
    const item = { button, status, result };
    const context = { owner: {}, popup, request, isCurrent: () => true };
    return { item, context, bind: () => controller.bind([item], context) };
  }
  t.after(() => { controller.dispose(); window.close(); });
  return { controller, window, sent, view, shadow, event: value => listener(value) };
}

const settle = () => new Promise(resolveDone => setImmediate(resolveDone));
const frame = window => new Promise(resolveDone => window.requestAnimationFrame(() => resolveDone()));
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
// Page rectangles at twice popup pixels, as Chrome reports them at a 200% popup scale.
const halve = rect => Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value / 2]));

// jsdom has no layout, so the popup, its button and the chooser get Chrome's
// boxes: a 398×298 popup interior at page (100, 40) behind a 1px border.
function layout(f, v, menuSize = { width: 200, height: 120 }) {
  const { popup } = v.context;
  popup.getBoundingClientRect = () => box(100, 40, 800, 600);
  for (const [name, value] of Object.entries({ clientLeft: 1, clientTop: 1, clientWidth: 398, clientHeight: 298 })) {
    Object.defineProperty(popup, name, { configurable: true, value });
  }
  for (const [name, key] of [["offsetWidth", "width"], ["offsetHeight", "height"]]) {
    Object.defineProperty(f.window.HTMLElement.prototype, name, { configurable: true,
      get() { return this.classList.contains("gsm-hoshidicts-audio-menu") ? menuSize[key] : 0; } });
  }
  const anchor = { left: 760, top: 100 };
  v.item.button.getBoundingClientRect = () => box(anchor.left, anchor.top, 64, 64);
  return anchor;
}

const chooser = f => f.shadow.querySelector('[role="dialog"]');
const placed = f => ({ inset: chooser(f)?.style.inset, maxHeight: chooser(f)?.style.maxHeight });

test("default-off popup binding is silent; only the newest owned play updates controls", async t => {
  const f = fixture(t);
  const parent = f.view(), child = f.view("食べる");
  parent.item.status.remove();
  delete parent.item.status;
  parent.bind(); child.bind();
  assert.equal(f.sent.length, 0);
  f.event({ target: "hachidori-audio-content", type: "hd_audio_playing" });
  parent.item.button.click();
  assert.equal(parent.item.button.getAttribute("aria-label"), "Stop pronunciation for 聞く");
  assert.equal(parent.item.button.textContent, "", "playing keeps the speaker button icon-only");
  assert.match(parent.item.button.title, /^Stop pronunciation;/u);
  assert.equal(parent.item.button.dataset.state, "loading");
  assert.equal(parent.context.popup.querySelector(".gsm-hoshidicts-audio-status"), null, "ordinary playback adds no prose");
  const first = f.sent[0];
  f.controller.retire(child.context.owner);
  assert.equal(f.sent.length, 1, "pruning a child preserves a parent's manual play");
  child.item.button.click();
  assert.equal(parent.item.button.getAttribute("aria-label"), "Play pronunciation for 聞く");
  assert.equal(parent.item.button.textContent, "", "stopping keeps the speaker button icon-only");
  assert.match(parent.item.button.title, /^Play pronunciation;/u);
  const second = f.sent.at(-1);
  assert.equal(f.sent[1].playRequestId, first.requestId);
  f.event({ target: "hachidori-audio-content", type: "hd_audio_playing", requestId: first.requestId, candidate: { name: "old" } });
  assert.equal(parent.context.popup.querySelector(".gsm-hoshidicts-audio-status"), null);
  f.event({ target: "hachidori-audio-content", type: "hd_audio_playing", requestId: second.requestId, candidate: { name: "new" } });
  assert.equal(child.item.button.dataset.state, "playing");
  assert.equal(child.item.status.textContent, "");
  first.resolveReply({ ok: true, status: "success", candidate: { name: "old" } });
  await settle();
  assert.equal(child.item.button.dataset.state, "playing");
  f.controller.retire(child.context.owner);
  second.resolveReply({ ok: true, status: "success" });
  await settle();
  assert.equal(child.item.status.textContent, "");
  assert.equal(child.item.button.dataset.state, undefined);
});

test("candidate choice carries exact identity and closes with focus restoration", async t => {
  const f = fixture(t), v = f.view();
  v.bind();
  v.item.button.dispatchEvent(new f.window.MouseEvent("click", { shiftKey: true }));
  assert.equal(f.controller.hasMenu(), true);
  const request = f.sent[0];
  request.resolveReply({ ok: true, groups: [{ sourceId: "json", sourceKey: "source descriptor", type: "custom-json",
    candidates: [{ url: "https://example.test/1", name: "Tokyo" }, { url: "https://example.test/2", name: "Osaka" }] }] });
  await settle();
  const buttons = [...f.shadow.querySelectorAll('[role="dialog"] div button')];
  assert.deepEqual(buttons.map(button => button.textContent), ["Tokyo", "Osaka"]);
  buttons[1].click();
  const play = f.sent.at(-1);
  assert.equal(play.type, "hd_audio_play");
  assert.deepEqual(JSON.parse(JSON.stringify(play.selection)), {
    sourceId: "json", sourceKey: "source descriptor", expression: "聞く", reading: "きく",
    index: 1, url: "https://example.test/2", name: "Osaka",
  });
  assert.equal(f.controller.selectionFor(v.item.result), play.selection);
  assert.equal(f.controller.hasMenu(), false);
  assert.equal(f.shadow.activeElement, v.item.button, "choosing returns keyboard focus to Stop/replay");
  v.item.button.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowDown" }));
  const pending = f.sent.at(-1);
  assert.equal(f.controller.closeMenu(), true);
  assert.equal(f.shadow.activeElement, v.item.button);
  pending.resolveReply({ ok: true, groups: [] });
  play.resolveReply({ ok: true, status: "success" });
  await settle();
  assert.equal(f.controller.hasMenu(), false);
  f.controller.update({ ...f.window.HDReaderOptions.DEFAULT_OPTIONS, audioSources: [] });
  assert.equal(f.controller.selectionFor(v.item.result), null);
});

test("every gesture opens the chooser beside its button in popup pixels, above it only when that side has the room", async t => {
  const f = fixture(t, { popupRect: halve }), v = f.view();
  const size = { width: 200, height: 120 };
  const anchor = layout(f, v, size);
  v.bind();
  const gestures = [
    () => v.item.button.dispatchEvent(new f.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    () => v.item.button.dispatchEvent(new f.window.MouseEvent("click", { bubbles: true, shiftKey: true })),
    () => v.item.button.dispatchEvent(new f.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })),
  ];
  for (const open of gestures) {
    open();
    // In popup pixels the button is (329, 29)–(361, 61) inside the border. The
    // chooser hangs 4px below it, moved left to keep 6px from the right edge.
    assert.equal(chooser(f).parentElement, v.context.popup, "the chooser is the popup's own child, outside every scroller");
    assert.deepEqual(placed(f), { inset: "65px auto auto 192px", maxHeight: "120px" });
    assert.equal(v.item.button.getAttribute("aria-expanded"), "true");
    assert.equal(f.shadow.activeElement, chooser(f).querySelector(".gsm-hoshidicts-audio-menu-close"));
    f.controller.closeMenu();
  }
  // Near the popup's bottom only the room above fits it.
  anchor.top = 520;
  gestures[0]();
  assert.deepEqual(placed(f), { inset: "115px auto auto 192px", maxHeight: "120px" });
  f.controller.closeMenu();
  // A list taller than the room below is shortened to it and scrolls inside.
  anchor.top = 100;
  gestures[2]();
  size.height = 400;
  f.sent.at(-1).resolveReply({ ok: true, groups: [{ sourceId: "json", sourceKey: "key", type: "custom-json",
    candidates: Array.from({ length: 20 }, (_, index) => ({ url: `https://example.test/${index}`, name: `Speaker ${index}` })) }] });
  await settle();
  assert.equal(chooser(f).querySelectorAll(".gsm-hoshidicts-audio-menu-item:not(.gsm-hoshidicts-audio-menu-close)").length, 20);
  assert.deepEqual(placed(f), { inset: "65px auto auto 192px", maxHeight: "227px" });
});

test("presses elsewhere and retirement close the chooser, and its late candidates populate nothing", async t => {
  const f = fixture(t), v = f.view();
  const definitions = f.window.document.createElement("p");
  v.context.popup.prepend(definitions);
  v.bind();
  const press = target => target.dispatchEvent(new f.window.MouseEvent("mousedown", { bubbles: true, composed: true }));
  const candidates = { ok: true, groups: [{ sourceId: "json", sourceKey: "key", type: "custom-json",
    candidates: [{ url: "https://example.test/late", name: "Late" }] }] };
  v.item.button.dispatchEvent(new f.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
  const dismissed = f.sent.at(-1);
  press(chooser(f).querySelector(".gsm-hoshidicts-audio-menu-status"));
  assert.equal(f.controller.hasMenu(), true, "a press inside the chooser keeps it");
  press(definitions);
  assert.equal(chooser(f), null);
  assert.equal(v.item.button.getAttribute("aria-expanded"), "false");
  assert.notEqual(f.shadow.activeElement, v.item.button, "an outside press keeps the focus it gives");
  assert.deepEqual([f.sent.at(-1).type, f.sent.at(-1).playRequestId], ["hd_audio_stop", dismissed.requestId]);
  dismissed.resolveReply(candidates);
  await settle();
  assert.equal(chooser(f), null, "a dismissed chooser's late candidates populate nothing");

  v.item.button.dispatchEvent(new f.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const retired = f.sent.at(-1);
  f.controller.retire(v.context.owner);
  assert.equal(chooser(f), null);
  retired.resolveReply(candidates);
  await settle();
  assert.equal(chooser(f), null, "a retired owner's late candidates populate nothing");
  assert.equal(f.controller.hasMenu(), false);
});

test("the chooser follows its button through scrolling and popup placement, and closes once the button is scrolled away", async t => {
  const f = fixture(t, { popupRect: halve }), v = f.view();
  const anchor = layout(f, v);
  // The button scrolls with the definitions; the scroller shows page y 80–480.
  const scroller = f.window.document.createElement("div");
  scroller.style.overflow = "auto";
  Object.defineProperty(scroller, "scrollHeight", { value: 900 });
  Object.defineProperty(scroller, "clientHeight", { value: 200 });
  scroller.getBoundingClientRect = () => box(100, 80, 800, 400);
  v.context.popup.append(scroller);
  scroller.append(v.item.button.parentElement);
  v.bind();
  v.item.button.dispatchEvent(new f.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.deepEqual(placed(f), { inset: "65px auto auto 192px", maxHeight: "120px" });
  anchor.top = 160;
  scroller.dispatchEvent(new f.window.Event("scroll"));
  assert.equal(placed(f).inset, "65px auto auto 192px", "scrolling places the chooser on the next frame");
  await frame(f.window);
  assert.equal(placed(f).inset, "95px auto auto 192px");
  anchor.top = 200;
  chooser(f).dispatchEvent(new f.window.Event("scroll"));
  await frame(f.window);
  assert.equal(placed(f).inset, "95px auto auto 192px", "the list's own scrolling moves nothing");
  f.controller.positionMenu({});
  assert.equal(placed(f).inset, "95px auto auto 192px", "another popup's placement leaves it alone");
  f.controller.positionMenu(v.context.owner);
  assert.equal(placed(f).inset, "115px auto auto 192px", "its own popup's placement places it at once");
  // Above the scroller's top edge the button is hidden.
  anchor.top = 10;
  scroller.dispatchEvent(new f.window.Event("scroll"));
  await frame(f.window);
  assert.equal(chooser(f), null);
  assert.equal(v.item.button.getAttribute("aria-expanded"), "false");
  assert.equal(f.shadow.activeElement, v.item.button, "focus inside the closed chooser returns to its button");
});

test("the pronunciation that played becomes the Anki selection, unless it was browser speech", async t => {
  const f = fixture(t), v = f.view();
  const changes = [];
  const controller = f.window.HDAudio.createAudioController({ window: f.window, onMenuChange() {},
    onSelectionChange: owner => changes.push(owner),
    send(type, fields) { return new Promise(resolveReply => f.sent.push({ type, ...fields, resolveReply })); } });
  t.after(() => controller.dispose());
  controller.bind([v.item], v.context);
  v.item.button.click();
  const speech = f.sent.at(-1);
  assert.equal(speech.selection, undefined);
  speech.resolveReply({ ok: true, status: "success", sourceId: "tts", sourceKey: "speech descriptor", candidate: { name: "Automatic Japanese", index: 0 } });
  await settle();
  assert.equal(controller.selectionFor(v.item.result), null, "browser speech leaves the selection open to fallback");
  assert.deepEqual(changes, []);
  v.item.button.click();
  const recording = f.sent.at(-1);
  recording.resolveReply({ ok: true, status: "success", sourceId: "json", sourceKey: "source descriptor",
    candidate: { url: "https://example.test/2", name: "Osaka", index: 1 } });
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(controller.selectionFor(v.item.result))), {
    sourceId: "json", sourceKey: "source descriptor", expression: "聞く", reading: "きく",
    index: 1, url: "https://example.test/2", name: "Osaka",
  });
  assert.deepEqual(changes, [v.context.owner]);
  v.item.button.click();
  const replay = f.sent.at(-1);
  assert.equal(replay.selection, controller.selectionFor(v.item.result), "replay keeps playing the pinned recording");
  replay.resolveReply({ ok: true, status: "success", sourceId: "json", sourceKey: "source descriptor",
    candidate: { url: "https://example.test/2", name: "Osaka", index: 1 } });
  await settle();
  assert.deepEqual(changes, [v.context.owner], "an already pinned recording does not re-run Anki preflight");
});

test("pagehide retires active playback while runtime messaging is still available", async t => {
  const f = fixture(t), v = f.view();
  v.bind();
  v.item.button.click();
  const play = f.sent.at(-1);
  f.window.dispatchEvent(new f.window.Event("pagehide"));
  assert.equal(f.sent.at(-1).type, "hd_audio_stop");
  assert.equal(f.sent.at(-1).playRequestId, play.requestId);
  play.resolveReply({ ok: true, status: "success" });
  await settle();
  assert.equal(v.item.button.getAttribute("aria-busy"), "false");
});

test("a failed explicit pronunciation is forgotten so normal Audio can try ordered fallback", async t => {
  const f = fixture(t), v = f.view();
  v.bind();
  v.item.button.dispatchEvent(new f.window.MouseEvent("click", { shiftKey: true }));
  f.sent[0].resolveReply({ ok: true, groups: [{ sourceId: "json", sourceKey: "source descriptor", type: "custom-json",
    candidates: [{ url: "https://example.test/bad", name: "Broken" }, { url: "https://example.test/good", name: "Good" }] }] });
  await settle();
  f.shadow.querySelector('[role="dialog"] div button').click();
  f.sent.at(-1).resolveReply({ ok: false, error: "Cannot decode" });
  await settle();
  assert.equal(v.item.status.textContent, "", "Audio Settings → Test explains a failure; the popup stays quiet");
  assert.equal(v.item.button.dataset.state, undefined);
  assert.equal(f.controller.selectionFor(v.item.result), null);
  v.item.button.click();
  assert.equal(f.sent.at(-1).selection, undefined);
  f.sent.at(-1).resolveReply({ ok: true, status: "success" });
  await settle();
  assert.equal(v.item.status.textContent, "");
  assert.equal(v.item.button.dataset.state, undefined);
});

test("audio controls disappear for no enabled configured source and return on live settings changes", async t => {
  const f = fixture(t), v = f.view();
  const defaults = f.window.HDReaderOptions.DEFAULT_OPTIONS;
  v.bind();
  for (const audioSources of [[], defaults.audioSources.map(source => ({ ...source, enabled: false })),
    [{ id: "blank", type: "custom", enabled: true, url: "", voice: "" }]]) {
    f.controller.update({ ...defaults, audioSources, audioAutoplay: true });
    assert.equal(v.item.button.hidden, true);
    assert.equal(v.item.button.parentElement.hidden, true);
    v.item.button.click();
    assert.equal(f.sent.length, 0, "hidden audio neither autoplays nor accepts a stale click");
  }
  f.controller.update(defaults);
  assert.equal(v.item.button.hidden, false);
  assert.equal(v.item.button.parentElement.hidden, false);
  v.item.button.click();
  assert.equal(f.sent[0].type, "hd_audio_play");
  f.sent[0].resolveReply({ ok: true, status: "success", candidate: { name: "Google 日本語" } });
  await settle();
  assert.equal(v.item.status.textContent, "");
});

test("autoplay runs once per logical first result and tab, not expansion, Back or option echoes", async t => {
  const f = fixture(t), v = f.view();
  const options = { ...f.window.HDReaderOptions.DEFAULT_OPTIONS, audioAutoplay: true };
  f.controller.update(options);
  v.bind();
  assert.equal(f.sent.length, 1);
  f.sent[0].resolveReply({ ok: true, status: "success" });
  await settle();
  v.bind(); f.controller.update(options); v.bind();
  const back = f.view("聞く", v.context.request);
  back.bind();
  assert.equal(f.sent.length, 1);
  v.context.request.selectedDictionaryTab = { dictionary: "Second" };
  v.bind();
  assert.equal(f.sent.length, 2);
  f.controller.update({ ...options, audioAutoplay: false });
  assert.equal(f.sent.at(-1).type, "hd_audio_stop");
  f.sent[1].resolveReply({ ok: true, status: "success" });
  await settle();
  assert.equal(v.item.status.textContent, "");
});

test("a hidden popup audio button still autoplays the first result", async t => {
  const f = fixture(t), v = f.view();
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    f.window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  const host = f.window.document.getElementById("host");
  const appearance = f.window.HDPopup.createPopupAppearance(host);
  const options = { ...f.window.HDReaderOptions.DEFAULT_OPTIONS, audioAutoplay: true, showPopupAudioButton: false };
  assert.equal(f.window.HDReaderOptions.normaliseOptions({}).showPopupAudioButton, true);
  assert.equal(f.window.HDReaderOptions.normaliseOptions({ showPopupAudioButton: false }).showPopupAudioButton, false);
  appearance.update(options);
  assert.equal(host.dataset.hoshidictsAudioButton, "hidden");
  assert.match(readFileSync(new URL("../extension/render/reader.css", import.meta.url), "utf8"),
    /:host\(\[data-hoshidicts-audio-button="hidden"\]\) \.gsm-hoshidicts-audio-control \{ display: none; \}/u);
  f.controller.update(options);
  v.bind();
  assert.equal(v.item.button.hidden, false, "only the host attribute hides the button");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "hd_audio_play");
  f.sent[0].resolveReply({ ok: true, status: "success" });
  await settle();
  appearance.update({ ...options, showPopupAudioButton: true });
  assert.equal(host.dataset.hoshidictsAudioButton, undefined);
  appearance.destroy();
});

test("late initial options play the still-current first result without replaying a manual pronunciation", async t => {
  for (const manual of [false, true]) {
    const f = fixture(t), v = f.view();
    f.controller.update(f.window.HDReaderOptions.DEFAULT_OPTIONS, false);
    v.bind();
    assert.equal(f.sent.length, 0);
    if (manual) {
      v.item.button.click();
      f.sent[0].resolveReply({ ok: true, status: "success" });
      await settle();
    }
    f.controller.update({ ...f.window.HDReaderOptions.DEFAULT_OPTIONS, audioAutoplay: true,
      audioSources: [{ id: "saved", type: "custom", enabled: true, url: "https://example.test/audio", voice: "" }],
    });
    await settle();
    assert.equal(f.sent.filter(request => request.type === "hd_audio_play").length, 1);
    v.bind();
    const plays = f.sent.filter(request => request.type === "hd_audio_play");
    assert.equal(plays.length, 1, manual ? "late options do not repeat manual playback" : "late options retry the first result");
    plays[0].resolveReply({ ok: true, status: "success" });
    await settle();
  }
});

test("keybind playback restarts the entry's pronunciation and can play one source's first choice", async t => {
  const f = fixture(t);
  const v = f.view();
  v.bind();
  const plays = () => f.sent.filter(message => message.type === "hd_audio_play");
  assert.equal(f.controller.playButton(f.window.document.createElement("button")), false, "an unbound button has nothing to play");
  assert.equal(f.controller.playButton(v.item.button), true);
  assert.equal(f.controller.playButton(v.item.button), true);
  assert.equal(plays().length, 2, "a repeated keybind replays where a second click would stop");
  assert.equal(plays()[1].selection, undefined);

  assert.equal(f.controller.playButton(v.item.button, "second"), true);
  const candidates = f.sent.at(-1);
  assert.equal(candidates.type, "hd_audio_candidates");
  candidates.resolveReply({ ok: true, groups: [
    { sourceId: "first", sourceKey: "first-key", type: "custom", candidates: [{ url: "https://first.test/a.mp3", name: "" }] },
    { sourceId: "second", sourceKey: "second-key", type: "custom-json",
      candidates: [{ url: "https://second.test/a.mp3", name: "Speaker A" }, { url: "https://second.test/b.mp3", name: "Speaker B" }] },
  ] });
  await settle();
  assert.equal(plays().length, 3);
  assert.deepEqual({ ...plays()[2].selection }, { sourceId: "second", sourceKey: "second-key", expression: "聞く", reading: "きく",
    index: 0, url: "https://second.test/a.mp3", name: "Speaker A" });

  assert.equal(f.controller.playButton(v.item.button, "removed"), true);
  f.sent.at(-1).resolveReply({ ok: true, groups: [{ sourceId: "first", sourceKey: "first-key", type: "custom", candidates: [] }] });
  await settle();
  assert.equal(plays().length, 3, "a source without choices plays nothing");
  assert.equal(v.item.status.textContent, "");
  assert.equal(v.item.button.dataset.state, undefined);
});

// #501: a missing or failed pronunciation is no error beside the headword.
// Settings → Audio → Test and the chooser keep the details.
test("missing and failed pronunciations leave the headword quiet, autoplayed or played by hand; the chooser keeps details", async t => {
  const f = fixture(t), v = f.view();
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    f.window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  // The renderer's own control, which has no status slot.
  const { element, button } = f.window.HDPopup.createAudioControl(f.window.document, "聞く");
  v.context.popup.replaceChildren(element);
  const item = { button, result: v.item.result };
  const quiet = what => {
    assert.equal(v.context.popup.querySelector(".gsm-hoshidicts-audio-status"), null, `${what}: no status prose`);
    assert.equal(element.textContent, "", `${what}: the control holds only its icon button`);
    assert.equal(button.dataset.state, undefined, `${what}: no error state`);
    assert.equal(button.getAttribute("aria-busy"), "false");
    assert.equal(button.getAttribute("aria-label"), "Play pronunciation for 聞く");
  };
  f.controller.update({ ...f.window.HDReaderOptions.DEFAULT_OPTIONS, audioAutoplay: true });
  f.controller.bind([item], v.context);
  assert.equal(f.sent[0].type, "hd_audio_play", "autoplay ran");
  f.sent[0].resolveReply({ ok: true, status: "no-result" });
  await settle();
  quiet("autoplay with no recording");
  for (const reply of [{ ok: true, status: "no-result" }, { ok: false, error: "The recording returned HTTP 404." },
    { ok: true, status: "cancelled" }]) {
    button.click();
    f.sent.at(-1).resolveReply(reply);
    await settle();
    quiet(`manual ${reply.status ?? "failure"}`);
  }
  button.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowDown" }));
  f.sent.at(-1).resolveReply({ ok: true, groups: [{ sourceId: "json", sourceKey: "key", type: "custom-json",
    error: "The pronunciation list returned HTTP 403." }] });
  await settle();
  const menu = () => v.context.popup.querySelector('[role="dialog"]');
  assert.match(menu().textContent, /1\. Yomitan JSON/u);
  assert.match(menu().textContent, /The pronunciation list returned HTTP 403\./u, "the chooser names the failing source");
  assert.equal(menu().querySelector('[role="status"]').textContent, "No pronunciations found. Check Audio Settings.");
  f.controller.closeMenu();
  button.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowDown" }));
  f.sent.at(-1).resolveReply({ ok: false, error: "Pronunciation discovery timed out after 12 seconds." });
  await settle();
  assert.equal(menu().querySelector('[role="status"]').textContent, "Pronunciation discovery timed out after 12 seconds.");
  quiet("a failed chooser request");
});
