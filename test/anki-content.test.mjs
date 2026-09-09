// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/reader-options.js";
import "../extension/anki-content.js";
import { createCaptureSession } from "../extension/capture-session.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));
const configured = { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS, anki: { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki, model: "Basic" } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 100 && !predicate(); n++) await tick();
  assert.ok(predicate(), "mining controller did not reach the expected state");
}
function fixture(t, send, capture = send, wait, conceal) {
  const dom = new JSDOM("<!doctype html><body><section></section></body>");
  t.after(() => dom.window.close());
  const popup = dom.window.document.querySelector("section");
  const owner = {}, request = {};
  const controller = globalThis.HDAnki.createAnkiController({ send, capture, onChange() {},
    ...(wait ? { wait } : {}), ...(conceal ? { conceal } : {}) });
  const context = { owner, popup, request, isCurrent: () => true,
    getRequest: result => ({ term: result.term }) };
  const items = ["猫", "犬", "鳥"].map(expression => {
    const actions = dom.window.document.createElement("div");
    actions.className = "gsm-hoshidicts-entry-actions";
    const audio = dom.window.document.createElement("div");
    audio.className = "gsm-hoshidicts-audio-control";
    audio.appendChild(dom.window.document.createElement("button")).className = "gsm-hoshidicts-audio-button";
    const note = dom.window.document.createElement("button");
    note.className = "gsm-hoshidicts-note-button";
    const link = dom.window.document.createElement("button");
    link.className = "gsm-hoshidicts-external-link-button";
    actions.append(audio, note, link);
    const feedback = dom.window.document.createElement("div");
    feedback.className = "gsm-hoshidicts-mining-feedback";
    feedback.hidden = true;
    popup.append(actions, feedback);
    return { actions, feedback, get control() { return feedback.querySelector(".gsm-hoshidicts-anki-control"); },
      get add() { return actions.querySelector(".gsm-hoshidicts-mine-button"); },
      get view() { return actions.querySelector(".gsm-hoshidicts-anki-view"); },
      get output() { return feedback.querySelector("output"); }, result: { term: { expression, reading: "" } } };
  });
  return { controller, context, items };
}

test("Anki stays quiet when unconfigured and preflights all rendered candidates sequentially", async t => {
  const calls = [];
  const held = Promise.withResolvers();
  const f = fixture(t, async (type, { request } = {}) => {
    calls.push([type, request?.term.expression]);
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (request.term.expression === "猫") await held.promise;
    return { state: "addable", canAdd: true };
  });
  f.controller.update(globalThis.HDReaderOptions.DEFAULT_OPTIONS);
  f.controller.bind(f.items, f.context);
  await tick();
  assert.deepEqual(calls, []);
  assert.ok(f.items.every(item => item.add === null && item.view === null && item.control === null),
    "unconfigured mining creates no Anki control DOM");
  f.controller.update(configured);
  await until(() => calls.length === 2);
  assert.deepEqual(calls.map(call => call[1]), [undefined, "猫"]);
  held.resolve();
  await until(() => f.items[2].add && !f.items[2].add.disabled);
  assert.deepEqual(calls.map(call => call[1]), [undefined, "猫", "犬", "鳥"]);
  const before = calls.length;
  f.controller.update({ ...configured });
  f.controller.bind(f.items, f.context);
  await tick();
  assert.equal(calls.length, before, "unchanged bindings do not repeat discovery or preflight");
});

test("Anki actions match the GSM toolbar order and use its add, duplicate, overwrite, and view icons", async t => {
  const browse = [];
  let writes = 0;
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_browse") { browse.push(request); return { opened: true }; }
    if (type === "hd_anki_submit") { writes++; return { state: "added", noteId: 1, warnings: [] }; }
    if (request.term.expression === "犬") return { state: "duplicate", canAdd: false, noteIds: [22, 23] };
    if (request.term.expression === "鳥") return { state: "duplicate", canAdd: true, action: "overwrite" };
    return { state: "addable", canAdd: true };
  });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items[2].add?.dataset.state === "overwrite");
  const actionKind = node => {
    if (node.classList.contains("gsm-hoshidicts-mine-button")) return "add";
    if (node.classList.contains("gsm-hoshidicts-audio-control")) return "audio";
    if (node.classList.contains("gsm-hoshidicts-note-button")) return "note";
    if (node.classList.contains("gsm-hoshidicts-anki-view")) return "view";
    if (node.classList.contains("gsm-hoshidicts-external-link-button")) return "external";
    return node.className;
  };
  assert.deepEqual([...f.items[0].actions.children].map(actionKind),
    ["add", "audio", "note", "view", "external"]);
  assert.equal(f.items[0].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon, "big-circle");
  assert.match(f.items[0].add.querySelector(".gsm-hoshidicts-mine-icon").getAttribute("src"),
    /render\/icons\/big-circle\.svg$/u);
  assert.equal(f.items[1].add.dataset.state, "view-existing");
  assert.equal(f.items[1].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon,
    "view-note");
  assert.equal(f.items[1].add.disabled, false);
  assert.equal(f.items[1].add.title, "View existing notes in Anki");
  assert.equal(f.items[1].view.hidden, true);
  f.items[1].add.click();
  await until(() => browse.length === 1);
  assert.deepEqual(browse, [{ noteIds: [22, 23], expression: "犬" }]);
  assert.equal(writes, 0);
  assert.equal(f.items[2].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon,
    "overwrite-big-circle");
  assert.ok(f.items[0].view.classList.contains("gsm-hoshidicts-view-in-anki-button"));
  assert.match(f.items[0].view.querySelector(".gsm-hoshidicts-view-in-anki-icon").getAttribute("src"),
    /render\/icons\/view-note\.svg$/u);
});

test("successful Add remains successful after a refresh failure and cannot invite a second click", async t => {
  let submitted = 0;
  const f = fixture(t, async type => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_submit") { submitted++; return { state: "added", noteId: 12, warnings: ["Audio unavailable"] }; }
    if (submitted) throw new Error("refresh offline");
    return { state: "addable", canAdd: true };
  });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items[2].add && !f.items[2].add.disabled);
  f.items[0].add.click();
  f.items[0].add.click();
  await until(() => f.items[0].add.dataset.state === "success");
  await tick();
  assert.match(f.items[0].output.textContent, /Added.*12.*Audio unavailable/u);
  assert.equal(f.items[0].add.disabled, true);
  assert.equal(submitted, 1);
});

test("late preflight cannot expose retired controls and an uncertain write stays disabled with View available", async t => {
  const held = Promise.withResolvers();
  let pending = true, writes = 0;
  const f = fixture(t, async type => {
    if (type === "hd_anki_status") { if (pending) await held.promise; return { available: true, configKey: "current" }; }
    if (type === "hd_anki_submit") { writes++; throw new Error("reply lost"); }
    return { state: "addable", canAdd: true };
  });
  f.controller.update(configured);
  f.controller.bind([f.items[0]], f.context);
  await tick();
  f.controller.retire(f.context.owner);
  pending = false;
  f.controller.bind([f.items[1]], f.context);
  held.resolve();
  await until(() => f.items[1].add && !f.items[1].add.disabled);
  assert.equal(f.items[0].control, null);
  f.items[1].add.click();
  await until(() => f.items[1].add.dataset.state === "error");
  assert.equal(f.items[1].add.disabled, true);
  assert.equal(f.items[1].view.disabled, false);
  assert.match(f.items[1].output.textContent, /View in Anki/u);
  f.items[1].add.click();
  assert.equal(writes, 1);
});

test("refresh waits for a second pending submission without spinning on its busy record", async t => {
  const held = Promise.withResolvers();
  let writes = 0, statuses = 0;
  const f = fixture(t, async type => {
    if (type === "hd_anki_status") {
      if (++statuses > 10) throw new Error("unexpected refresh loop");
      return { available: true, configKey: "current" };
    }
    if (type === "hd_anki_submit") {
      if (++writes === 2) await held.promise;
      return { state: "added", noteId: writes, warnings: [] };
    }
    return { state: "addable", canAdd: true };
  });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items[2].add && !f.items[2].add.disabled);
  f.items[0].add.click();
  f.items[1].add.click();
  await until(() => f.items[0].add.dataset.state === "success");
  const before = statuses;
  held.resolve();
  await until(() => f.items[1].add.dataset.state === "success");
  assert.ok(before <= 2, `pending write caused ${before} status requests`);
});

test("settings changes during submission preserve confirmed and uncertain outcomes without allowing a retry", async t => {
  for (const state of ["added", "updated", "uncertain"]) {
    const held = Promise.withResolvers();
    let writes = 0;
    const f = fixture(t, async type => {
      if (type === "hd_anki_status") return { available: true, configKey: "current" };
      if (type === "hd_anki_submit") { writes++; return held.promise; }
      return { state: "addable", canAdd: true };
    });
    f.controller.update(configured);
    f.controller.bind([f.items[0]], f.context);
    await until(() => f.items[0].add && !f.items[0].add.disabled);
    f.items[0].add.click();
    f.controller.update({ ...configured, anki: { ...configured.anki, duplicateBehavior: "new" } });
    held.resolve({ state, noteId: 42, warnings: [], error: "Use View in Anki before trying again." });
    await until(() => !f.items[0].output.textContent.includes("Saving"));
    assert.equal(f.items[0].add.disabled, true, `${state} must remain terminal after configuration changes`);
    f.items[0].add.click();
    assert.equal(writes, 1);
  }
});

test("presentation reprojection drops detached actions before queued checks and later refreshes", async t => {
  const held = Promise.withResolvers(), terms = [];
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    terms.push(request.term.expression);
    if (terms.length === 1) await held.promise;
    return { state: "invalid", canAdd: false, error: "This result cannot be added." };
  });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => terms.length === 1);
  f.items[0].actions.remove();
  f.items[2].actions.remove();
  f.controller.bind([f.items[1]], f.context);
  held.resolve();
  await until(() => terms.includes("犬"));
  await tick();
  assert.deepEqual(terms, ["猫", "犬"]);
  f.controller.refresh(f.context.owner);
  await until(() => terms.length >= 3);
  await tick();
  assert.deepEqual(terms, ["猫", "犬", "犬"]);
  assert.equal(f.items[1].add.dataset.state, "error");
  assert.equal(f.items[1].add.title, "This result cannot be added.");
});

test("a reused primary action anchor binds the newly projected result and ignores its old preflight", async t => {
  for (const expression of ["犬", "猫"]) {
    const held = Promise.withResolvers(), checked = [], submitted = [];
    const f = fixture(t, async (type, { request } = {}) => {
      if (type === "hd_anki_status") return { available: true, configKey: "current" };
      if (type === "hd_anki_submit") { submitted.push(request.term); return { state: "added", noteId: 42, warnings: [] }; }
      checked.push(request.term);
      if (checked.length === 1) { await held.promise; return { state: "duplicate", canAdd: false }; }
      return { state: "addable", canAdd: true };
    });
    f.controller.update(configured);
    f.controller.bind([f.items[0]], f.context);
    await until(() => checked.length === 1);
    const previousButton = f.items[0].add;
    const term = { expression, reading: "", glossaries: [{ dictionary: "New projection" }] };
    f.controller.bind([{ actions: f.items[0].actions, feedback: f.items[0].feedback, result: { term } }], f.context);
    held.resolve();
    await until(() => f.items[0].add && !f.items[0].add.disabled);
    assert.equal(previousButton.isConnected, false);
    assert.equal(f.items[0].feedback.querySelectorAll(".gsm-hoshidicts-anki-control").length, 1);
    assert.equal(f.items[0].add.getAttribute("aria-label"), "Mine to Anki");
    assert.deepEqual(checked, [f.items[0].result.term, term]);
    f.items[0].add.click();
    await until(() => f.items[0].add.dataset.state === "success");
    assert.deepEqual(submitted, [term]);
  }
});

test("captured media polls its job and preserves an unavailable screenshot when encoding is ready", async t => {
  const captureCalls = [];
  const statuses = [
    { state: "finishing", partial: true, assets: {} },
    { state: "encoding", progress: 2, total: 4, partial: true, assets: {} },
    { state: "ready", partial: true, assets: {
      animation: { filename: "hachidori-abc.avif", byteLength: 2 },
    } },
  ];
  let submitted;
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_screenshot") throw new Error("page capture unavailable");
    if (type === "hd_anki_preflight") return { state: "addable", canAdd: true, screenshot: true, capture: {
      requirements: { includeAnimation: true, includeAudio: false },
      sourceLabel: "Video cue",
      partial: true,
    } };
    if (type === "hd_anki_submit") {
      submitted = request;
      return { state: "added", noteId: 73, warnings: [] };
    }
    throw new Error(`Unexpected ${type}`);
  }, async (type, fields) => {
    captureCalls.push([type, fields]);
    if (type === "hd_capture_export") return { jobId: "job-1", state: "finishing" };
    if (type === "hd_capture_job_status") return statuses.shift();
    throw new Error(`Unexpected ${type}`);
  }, async () => {});
  f.context.getRequest = result => ({ term: result.term, capturePin: {
    token: "pin-1",
    animationFilename: "hachidori-abc.avif",
    audioFilename: "hachidori-abc.wav",
  } });
  f.controller.update({ ...configured, mediaCapture: {
    ...globalThis.HDReaderOptions.DEFAULT_MEDIA_CAPTURE,
    enabled: true,
  } });
  f.controller.bind([f.items[0]], f.context);
  await until(() => f.items[0].add && !f.items[0].add.disabled);
  assert.equal(f.items[0].control.querySelector(".gsm-hoshidicts-capture-badge").textContent,
    "Video cue · Partial");
  f.items[0].add.click();
  await until(() => f.items[0].add.dataset.state === "success");
  assert.equal(submitted.captureJobId, "job-1");
  assert.deepEqual(submitted.captureUnavailable, ["screenshot"]);
  assert.match(f.items[0].output.textContent, /Added.*Screenshot: page capture unavailable/u);
  assert.deepEqual(captureCalls.map(([type]) => type),
    ["hd_capture_export", "hd_capture_job_status", "hd_capture_job_status", "hd_capture_job_status"]);
});

test("capture encoding failure is safely retryable and never becomes an uncertain Anki write", async t => {
  let writes = 0;
  const f = fixture(t, async (type) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_preflight") return { state: "addable", canAdd: true, capture: {
      requirements: { includeAnimation: true, includeAudio: false },
      sourceLabel: "Recent clip",
      partial: false,
    } };
    if (type === "hd_anki_submit") { writes++; return { state: "added", noteId: 1, warnings: [] }; }
    throw new Error(`Unexpected ${type}`);
  }, async type => {
    if (type === "hd_capture_export") return { jobId: "job-error" };
    if (type === "hd_capture_job_status") return { state: "error", error: "encoder failed" };
    if (type === "hd_capture_cancel") return { cancelled: true };
    throw new Error(`Unexpected ${type}`);
  }, async () => {});
  f.context.getRequest = result => ({ term: result.term, capturePin: {
    token: "pin-1",
    animationFilename: "hachidori-abc.avif",
    audioFilename: "hachidori-abc.wav",
  } });
  f.controller.update({ ...configured, mediaCapture: {
    ...globalThis.HDReaderOptions.DEFAULT_MEDIA_CAPTURE,
    enabled: true,
  } });
  f.controller.bind([f.items[0]], f.context);
  await until(() => f.items[0].add && !f.items[0].add.disabled);
  f.items[0].add.click();
  await until(() => f.items[0].output.textContent.includes("encoder failed"));
  assert.equal(f.items[0].add.dataset.state, "ready");
  assert.equal(f.items[0].add.disabled, false);
  assert.equal(writes, 0);
});

function preparedCaptureFixture(t, submit) {
  const owner = { tabId: 7, documentId: "original-reader" };
  const mediaCapture = { ...globalThis.HDReaderOptions.DEFAULT_MEDIA_CAPTURE,
    enabled: true, timingMode: "recent", includeCapturedAudio: false, clipSeconds: 5 };
  let id = 0;
  const session = createCaptureSession({ now: () => 10_000, wallNow: () => 1000,
    randomId: () => `capture${++id}`, encodeAnimation: async () => new Uint8Array([1, 2, 3]) });
  t.after(() => session.stop());
  session.configure(mediaCapture);
  session.start({ sourceName: "Shared tab", displaySurface: "browser", audioAvailable: false });
  session.setLinkedPage(owner);
  for (const timestampMs of [5000, 10_000]) {
    session.addFrame({ timestampMs, width: 2, height: 2, data: new Uint8Array([1]) });
  }
  let pin = session.pinLookup({ lookupText: "猫" });
  const captureCalls = [], jobs = [];
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_preflight") return { state: "addable", canAdd: true, capture: {
      requirements: { includeAnimation: true, includeAudio: false }, sourceLabel: "Recent clip", partial: false,
    } };
    if (type === "hd_anki_submit") return submit(request);
    throw new Error(`Unexpected ${type}`);
  }, async (type, fields) => {
    captureCalls.push(type);
    if (type === "hd_capture_export") {
      const job = session.beginExport(fields.token, fields.requirements, owner);
      jobs.push(job.jobId);
      return job;
    }
    if (type === "hd_capture_job_status") return session.jobStatus(fields.jobId, owner);
    if (type === "hd_capture_cancel") return { cancelled: session.cancelExport(fields.jobId, owner) };
    throw new Error(`Unexpected ${type}`);
  }, tick);
  f.context.getRequest = result => ({ term: result.term, capturePin: pin });
  f.controller.update({ ...configured, mediaCapture });
  f.controller.bind([f.items[0]], f.context);
  return { ...f, session, captureCalls, jobs,
    nextPin() { pin = session.pinLookup({ lookupText: "犬" }); return pin; } };
}

test("definitive duplicate and invalid submissions release ready capture jobs for the next lookup", async t => {
  for (const state of ["duplicate", "invalid"]) {
    await t.test(state, async t => {
      let submissions = 0;
      const f = preparedCaptureFixture(t, async () => { submissions++; return { state, error: state }; });
      await until(() => f.items[0].add && !f.items[0].add.disabled);
      f.items[0].add.click();
      await until(() => submissions === 1 && !f.items[0].add.disabled);
      assert.doesNotThrow(() => f.nextPin(), "a definitive rejection must not block every later captured lookup");
      assert.throws(() => f.session.jobStatus(f.jobs[0]), /expired/u);
      f.items[0].add.click();
      await until(() => submissions === 2 && !f.items[0].add.disabled);
      assert.equal(f.jobs.length, 2, "retrying with a new pin must create a fresh job");
      assert.equal(f.captureCalls.filter(type => type === "hd_capture_cancel").length, 2);
    });
  }
});

test("a definitive rejection releases its admitted job after the popup retires and the reader relinks", async t => {
  const held = Promise.withResolvers();
  let sent = false;
  const f = preparedCaptureFixture(t, async () => { sent = true; return held.promise; });
  await until(() => f.items[0].add && !f.items[0].add.disabled);
  f.items[0].add.click();
  await until(() => sent);
  f.controller.retire(f.context.owner);
  f.session.setLinkedPage({ tabId: 8, documentId: "new-reader" });
  held.resolve({ state: "duplicate" });
  await until(() => f.captureCalls.includes("hd_capture_cancel"));
  assert.doesNotThrow(() => f.nextPin());
});

test("uncertain replies and lost submission responses retain the prepared job and terminal write state", async t => {
  for (const transportLost of [false, true]) {
    await t.test(transportLost ? "lost response" : "uncertain reply", async t => {
      const f = preparedCaptureFixture(t, async () => {
        if (transportLost) throw new Error("response lost");
        return { state: "uncertain", error: "Check Anki" };
      });
      await until(() => f.items[0].add && !f.items[0].add.disabled);
      f.items[0].add.click();
      await until(() => f.items[0].add.dataset.state === "error");
      assert.equal(f.items[0].add.disabled, true);
      assert.equal(f.session.jobStatus(f.jobs[0]).state, "ready");
      assert.equal(f.captureCalls.includes("hd_capture_cancel"), false);
    });
  }
});

test("a note that maps a screenshot captures one with the reader concealed and never fails the note for it", async t => {
  const calls = [];
  const concealed = [];
  let capture = async () => ({ token: "token-a", filename: "hachidori-screenshot-a.jpg" });
  let submittedRequest = null;
  const f = fixture(t, async (type, { request } = {}) => {
    calls.push(type);
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_screenshot") return capture();
    if (type === "hd_anki_submit") { submittedRequest = request; return { state: "added", noteId: 12, warnings: [] }; }
    return { state: "addable", canAdd: true, screenshot: true };
  }, undefined, undefined, async during => {
    concealed.push("hidden");
    const result = await during();
    concealed.push("restored");
    return result;
  });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items[0].add && !f.items[0].add.disabled);
  f.items[0].add.click();
  await until(() => f.items[0].add.dataset.state === "success");
  // The picture is taken while the popup is hidden, before the note is written.
  assert.deepEqual(concealed, ["hidden", "restored"]);
  // The picture is requested once, between the preflights and the write.
  assert.deepEqual(calls.filter(type => ["hd_anki_screenshot", "hd_anki_submit"].includes(type)),
    ["hd_anki_screenshot", "hd_anki_submit"]);
  assert.deepEqual(submittedRequest.screenshot, { token: "token-a", filename: "hachidori-screenshot-a.jpg" });
  assert.equal(submittedRequest.captureUnavailable, undefined);

  // A submission abandoned before it is sent — here because the clip pin it also
  // needs has expired — releases the picture it already took.
  const discards = [];
  let submits = 0;
  const abandoned = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_screenshot") return { token: "token-b", filename: "hachidori-screenshot-b.jpg" };
    if (type === "hd_anki_screenshot_discard") { discards.push(request.token); return { discarded: true }; }
    if (type === "hd_anki_submit") { submits += 1; return { state: "added", noteId: 13, warnings: [] }; }
    return { state: "addable", canAdd: true, screenshot: true,
      capture: { requirements: { includeAnimation: true, includeAudio: false } } };
  });
  abandoned.controller.update(configured);
  abandoned.controller.bind(abandoned.items, abandoned.context);
  await until(() => abandoned.items[0].add && !abandoned.items[0].add.disabled);
  abandoned.items[0].add.click();
  await until(() => abandoned.items[0].output.textContent.includes("Could not add"));
  await tick();
  assert.deepEqual(discards, ["token-b"]);
  assert.equal(submits, 0);

  // A capture that fails is a warning on an otherwise ordinary note.
  capture = async () => { throw new Error("The reading tab is no longer the active tab."); };
  f.items[1].add.click();
  await until(() => f.items[1].add.dataset.state === "success");
  await tick();
  assert.deepEqual(submittedRequest.captureUnavailable, ["screenshot"]);
  assert.equal(submittedRequest.screenshot, undefined);
  assert.match(f.items[1].output.textContent, /Added.*12.*Screenshot: The reading tab is no longer the active tab\./u);
});
