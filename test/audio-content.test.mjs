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

function fixture(t) {
  const dom = new JSDOM("<body><div id='host'></div></body>", { runScripts: "outside-only", url: "https://example.test" });
  const { window } = dom;
  let listener;
  const sent = [];
  window.chrome = { runtime: { onMessage: { addListener(value) { listener = value; }, removeListener() { listener = null; } } } };
  for (const file of ["reader-options.js", "audio-content.js"]) window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  const controller = window.HDAudio.createAudioController({ window, onMenuChange() {},
    send(type, fields) {
      if (type === "hd_audio_stop") { sent.push({ type, ...fields }); return Promise.resolve({ ok: true }); }
      return new Promise(resolveReply => sent.push({ type, ...fields, resolveReply }));
    },
  });
  const shadow = window.document.getElementById("host").attachShadow({ mode: "open" });
  function view(expression = "聞く", request = {}) {
    const popup = window.document.createElement("div");
    const button = window.document.createElement("button"), status = window.document.createElement("output");
    popup.append(button, status);
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
  parent.item.status = parent.context.popup.querySelector(".gsm-hoshidicts-audio-status");
  assert.ok(parent.item.status, "play lazily creates its feedback");
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
  assert.doesNotMatch(parent.item.status.textContent, /old/u);
  f.event({ target: "hachidori-audio-content", type: "hd_audio_playing", requestId: second.requestId, candidate: { name: "new" } });
  assert.match(child.item.status.textContent, /Playing — new/u);
  first.resolveReply({ ok: true, status: "success", candidate: { name: "old" } });
  await settle();
  assert.match(child.item.status.textContent, /Playing — new/u);
  f.controller.retire(child.context.owner);
  second.resolveReply({ ok: true, status: "success" });
  await settle();
  assert.equal(child.item.status.textContent, "Stopped.");
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
  assert.match(v.item.status.textContent, /Cannot decode/u);
  assert.equal(f.controller.selectionFor(v.item.result), null);
  v.item.button.click();
  assert.equal(f.sent.at(-1).selection, undefined);
  f.sent.at(-1).resolveReply({ ok: true, status: "success" });
  await settle();
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
  assert.equal(v.item.status.textContent, "Stopped.");
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
