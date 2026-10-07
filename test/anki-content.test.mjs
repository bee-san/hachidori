// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "../extension/reader-options.js";
import "../extension/anki-content.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));
const configured = { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS, anki: { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki, model: "Basic" } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 100 && !predicate(); n++) await tick();
  assert.ok(predicate(), "mining controller did not reach the expected state");
}
function handlesAnkiView(send) {
  send.handlesAnkiView = true;
  return send;
}
function handlesBatches(send) {
  send.handlesBatches = true;
  return send;
}
// The worker answers a pass's preflights in one batch, entry by entry; most
// tests describe each entry's reply as a single preflight. Other messages pass
// straight through, without an extra asynchronous hop.
function answerBatches(send) {
  async function batch(requests) {
    const replies = [];
    for (const request of requests) {
      try {
        replies.push(await send("hd_anki_preflight", { request }));
      } catch (error) {
        replies.push({ state: "error", canAdd: false, error: error.message });
      }
    }
    return { replies };
  }
  return (type, fields = {}) => type === "hd_anki_preflight_batch" ? batch(fields.requests) : send(type, fields);
}
function buttonState(item) {
  const button = item.add;
  return {
    state: button?.dataset.state ?? null,
    icon: button?.querySelector(".gsm-hoshidicts-mine-icon")?.dataset.icon ?? null,
    disabled: button?.disabled ?? null,
    ariaBusy: button?.getAttribute("aria-busy") ?? null,
    ariaLabel: button?.getAttribute("aria-label") ?? null,
    action: button?.dataset.action ?? null,
  };
}
function assertChecking(item) {
  assert.deepEqual(buttonState(item), {
    state: "checking",
    icon: "arrow-clockwise",
    disabled: true,
    ariaBusy: "true",
    ariaLabel: "Checking Anki card status",
    action: "add",
  });
}
function fixture(t, send, capture = send, wait, conceal, recordNetflixLine) {
  const dom = new JSDOM("<!doctype html><body><section></section></body>");
  t.after(() => dom.window.close());
  const popup = dom.window.document.querySelector("section");
  const owner = {}, request = {};
  const viewOrSend = (type, fields) => type === "hd_anki_view" && send.handlesAnkiView !== true
    ? Promise.resolve({ state: "unknown", canAdd: false, noteIds: [], configKey: "current", cached: false })
    : send(type, fields);
  const controllerSend = send.handlesBatches === true ? viewOrSend : answerBatches(viewOrSend);
  const controller = globalThis.HDAnki.createAnkiController({ send: controllerSend, capture, onChange() {},
    ...(wait ? { wait } : {}), ...(conceal ? { conceal } : {}), ...(recordNetflixLine ? { recordNetflixLine } : {}) });
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
      get output() { return feedback.querySelector("output"); }, result: { term: { expression, reading: "" } } };
  });
  return { controller, context, items };
}

test("Anki stays quiet when unconfigured and preflights a Template's rendered candidates in one batch", async t => {
  const calls = [];
  const held = Promise.withResolvers();
  const f = fixture(t, handlesBatches(async (type, { requests } = {}) => {
    calls.push([type, requests?.map(request => request.term.expression)]);
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    await held.promise;
    return { replies: requests.map(() => ({ state: "addable", canAdd: true })) };
  }));
  f.controller.update(globalThis.HDReaderOptions.DEFAULT_OPTIONS);
  f.controller.bind(f.items, f.context);
  await tick();
  assert.deepEqual(calls, []);
  assert.ok(f.items.every(item => item.add === null && item.control === null),
    "unconfigured mining creates no Anki control DOM");
  f.controller.update(configured);
  await until(() => calls.length === 2);
  assert.deepEqual(calls, [["hd_anki_status", undefined], ["hd_anki_preflight_batch", ["猫", "犬", "鳥"]]]);
  f.items.forEach(assertChecking);
  held.resolve();
  await until(() => f.items.every(item => !item.add.disabled));
  assert.equal(calls.length, 2);
  const before = calls.length;
  f.controller.update({ ...configured });
  f.controller.bind(f.items, f.context);
  await tick();
  assert.equal(calls.length, before, "unchanged bindings do not repeat discovery or preflight");
});

test("unresolved Anki readiness stays visibly busy through cache, status, and live preflight", async t => {
  const cached = Promise.withResolvers();
  const status = Promise.withResolvers();
  const preflight = Promise.withResolvers();
  t.after(() => {
    cached.resolve({ state: "unknown", canAdd: false, noteIds: [], configKey: "current", cached: false });
    status.resolve({ available: true, configKey: "current" });
    preflight.resolve({ state: "addable", canAdd: true });
  });
  const calls = [];
  const f = fixture(t, handlesAnkiView(async type => {
    calls.push(type);
    if (type === "hd_anki_view") return cached.promise;
    if (type === "hd_anki_status") return status.promise;
    if (type === "hd_anki_preflight") return preflight.promise;
    throw new Error(`Unexpected ${type}`);
  }));
  f.controller.update(configured);
  f.controller.bind([f.items[0]], f.context);
  await until(() => calls.includes("hd_anki_view"));
  assertChecking(f.items[0]);

  cached.resolve({ state: "unknown", canAdd: false, noteIds: [], configKey: "current", cached: false });
  await until(() => calls.includes("hd_anki_status"));
  assertChecking(f.items[0]);

  status.resolve({ available: true, configKey: "current" });
  await until(() => calls.includes("hd_anki_preflight"));
  assertChecking(f.items[0]);

  preflight.resolve({ state: "addable", canAdd: true });
  await until(() => f.items[0].add?.dataset.state === "ready");
  assert.deepEqual(buttonState(f.items[0]), {
    state: "ready",
    icon: "add",
    disabled: false,
    ariaBusy: "false",
    ariaLabel: "Mine to Anki",
    action: "add",
  });
});

test("an unknown cache miss falls through to live preflight and keeps its repaired exact IDs", async t => {
  const calls = [];
  const f = fixture(t, handlesAnkiView(async (type, { request } = {}) => {
    calls.push(type);
    if (type === "hd_anki_view") {
      return { state: "unknown", canAdd: false, noteIds: [], configKey: "current", cached: false };
    }
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_preflight") {
      assert.equal(request.term.expression, "猫");
      return { state: "duplicate", canAdd: false, noteIds: [31, 42] };
    }
    throw new Error(`Unexpected ${type}`);
  }));
  f.controller.update(configured);
  f.controller.bind([f.items[0]], f.context);
  await until(() => f.items[0].add?.dataset.state === "view-existing");
  assert.deepEqual(calls, ["hd_anki_view", "hd_anki_status", "hd_anki_preflight"]);
  assert.deepEqual(f.items[0].add.disabled, false);
  assert.equal(f.items[0].add.getAttribute("aria-busy"), "false");
  assert.equal(f.items[0].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon, "book-search");
});

test("a stale View repair updates exact IDs or returns the control to normal addability", async t => {
  const browsed = [];
  let removed = false;
  const f = fixture(t, handlesAnkiView(async (type, { request } = {}) => {
    if (type === "hd_anki_view") {
      return removed
        ? { state: "unknown", canAdd: false, noteIds: [], configKey: "current", cached: false }
        : { state: "duplicate", canAdd: false, noteIds: [7, 8], configKey: "current", cached: true };
    }
    if (type === "hd_anki_browse") {
      browsed.push(request.noteIds);
      if (browsed.length === 1) return { opened: true, noteIds: [8, 9], repaired: true };
      removed = true;
      return { opened: false, noteIds: [], repaired: true };
    }
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_preflight") return { state: "addable", canAdd: true };
    throw new Error(`Unexpected ${type}`);
  }));
  f.controller.update(configured);
  f.controller.bind([f.items[0]], f.context);
  await until(() => f.items[0].add?.dataset.state === "view-existing");
  f.items[0].add.click();
  await until(() => browsed.length === 1);
  f.items[0].add.click();
  await until(() => f.items[0].add.dataset.state === "ready");
  assert.deepEqual(browsed, [[7, 8], [8, 9]]);
  assert.equal(f.items[0].add.dataset.action, "add");
  assert.equal(f.items[0].add.disabled, false);
  assert.equal(f.items[0].add.getAttribute("aria-busy"), "false");
});

test("a ready Anki action works while later rendered results are still checking", async t => {
  const held = Promise.withResolvers();
  t.after(() => held.resolve());
  let writes = 0, laterChecks = 0;
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_submit") { writes++; return { state: "added", noteId: 12 }; }
    if (request.term.expression !== "猫") { laterChecks++; await held.promise; }
    return { state: "addable", canAdd: true };
  });
  f.controller.update(configured);
  // The popup renders its first result before the rest, so their readiness
  // arrives in a later batch.
  f.controller.bind([f.items[0]], f.context);
  await until(() => f.items[0].add?.dataset.state === "ready");
  f.controller.bind(f.items, f.context);
  await until(() => laterChecks === 1);
  assert.equal(f.items[0].add.dataset.state, "ready");
  assert.equal(f.items[0].add.disabled, false, "later results must not block this ready action");
  assert.equal(f.items[1].add.disabled, true);
  assert.equal(f.items[2].add.disabled, true);
  f.items[0].add.click();
  await until(() => writes === 1);
  await until(() => f.items[0].add.dataset.state === "success");
});

test("a warm cached View action skips Anki status and preflight", async t => {
  const calls = [];
  const browse = [];
  const f = fixture(t, handlesAnkiView(async (type, { request } = {}) => {
    calls.push(type);
    if (type === "hd_anki_view") {
      return {
        state: "duplicate",
        canAdd: false,
        noteIds: [22, 23],
        configKey: "current",
        cached: true,
      };
    }
    if (type === "hd_anki_browse") {
      browse.push(request);
      return { opened: true, noteIds: [22, 23] };
    }
    throw new Error(`warm View readiness unexpectedly called ${type}`);
  }));
  f.controller.update(configured);
  f.controller.bind([f.items[1]], f.context);
  await until(() => f.items[1].add?.dataset.state === "view-existing");
  assert.deepEqual(calls, ["hd_anki_view"]);
  assert.equal(f.items[1].add.disabled, false);
  assert.equal(f.items[1].add.dataset.action, "view");
  assert.equal(f.items[1].add.getAttribute("aria-busy"), "false");
  assert.equal(f.items[1].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon, "book-search");
  f.items[1].add.click();
  await until(() => browse.length === 1);
  assert.deepEqual(browse, [{
    noteIds: [22, 23],
    expression: "犬",
    configKey: "current",
    templateId: "default",
  }]);
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
    if (node.classList.contains("gsm-hoshidicts-external-link-button")) return "external";
    return node.className;
  };
  assert.deepEqual([...f.items[0].actions.children].map(actionKind),
    ["add", "audio", "note", "external"]);
  assert.equal(f.items[0].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon, "add");
  assert.ok(f.items[0].add.querySelector(".gsm-hoshidicts-mine-icon").classList.contains("hd-icon"));
  assert.equal(f.items[1].add.dataset.state, "view-existing");
  assert.equal(f.items[1].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon,
    "book-search");
  assert.equal(f.items[1].add.disabled, false);
  assert.equal(f.items[1].add.title, "View existing notes in Anki");
  assert.equal(f.items[1].add.dataset.action, "view");
  assert.equal(f.items[0].actions.querySelectorAll("button").length, 4);
  f.items[1].add.click();
  await until(() => browse.length === 1);
  assert.deepEqual(browse, [{ noteIds: [22, 23], expression: "犬", configKey: "current", templateId: "default" }]);
  assert.equal(writes, 0);
  assert.equal(f.items[2].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon,
    "document-edit");
});

test("failed readiness clears busy state and an explicit retry returns through Arrow Clockwise", async t => {
  const retry = Promise.withResolvers();
  t.after(() => retry.resolve({ state: "addable", canAdd: true }));
  let preflights = 0;
  const f = fixture(t, async type => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_preflight") {
      preflights += 1;
      if (preflights === 1) return { state: "error", canAdd: false, error: "Anki check failed." };
      return retry.promise;
    }
    throw new Error(`Unexpected ${type}`);
  });
  f.controller.update(configured);
  f.controller.bind([f.items[0]], f.context);
  await until(() => f.items[0].add?.dataset.state === "error");
  assert.equal(f.items[0].add.disabled, true);
  assert.equal(f.items[0].add.getAttribute("aria-busy"), "false");
  assert.equal(f.items[0].add.getAttribute("aria-label"), "Anki check failed.");

  f.controller.refresh(f.context.owner);
  await until(() => preflights === 2);
  assertChecking(f.items[0]);
  retry.resolve({ state: "addable", canAdd: true });
  await until(() => f.items[0].add.dataset.state === "ready");
  assert.equal(f.items[0].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon, "add");
  assert.equal(f.items[0].add.getAttribute("aria-busy"), "false");
});

test("parent and nested popup owners keep independent loading and resolved actions", async t => {
  const dom = new JSDOM("<!doctype html><body><section id=\"parent\"></section><section id=\"nested\"></section></body>");
  t.after(() => dom.window.close());
  const childPreflight = Promise.withResolvers();
  t.after(() => childPreflight.resolve({ state: "addable", canAdd: true }));
  const send = handlesAnkiView(async (type, { request } = {}) => {
    if (type === "hd_anki_view") {
      return request.term.expression === "猫"
        ? { state: "duplicate", canAdd: false, noteIds: [7], configKey: "current", cached: true }
        : { state: "unknown", canAdd: false, noteIds: [], configKey: "current", cached: false };
    }
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_preflight") return childPreflight.promise;
    throw new Error(`Unexpected ${type}`);
  });
  const controller = globalThis.HDAnki.createAnkiController({ send: answerBatches(send), onChange() {} });
  const make = (popup, expression, depth) => {
    const actions = dom.window.document.createElement("div");
    actions.className = "gsm-hoshidicts-entry-actions";
    const feedback = dom.window.document.createElement("div");
    feedback.className = "gsm-hoshidicts-mining-feedback";
    popup.append(actions, feedback);
    const item = {
      actions,
      feedback,
      result: { term: { expression, reading: "" } },
      get add() { return actions.querySelector(".gsm-hoshidicts-mine-button"); },
    };
    const context = {
      owner: { depth },
      popup,
      request: { depth },
      isCurrent: () => true,
      getRequest: result => ({ term: result.term }),
    };
    return { item, context };
  };
  const parent = make(dom.window.document.getElementById("parent"), "猫", 0);
  const nested = make(dom.window.document.getElementById("nested"), "犬", 1);
  controller.update(configured);
  controller.bind([parent.item], parent.context);
  controller.bind([nested.item], nested.context);
  await until(() => parent.item.add?.dataset.state === "view-existing"
    && nested.item.add?.dataset.state === "checking");
  assert.equal(parent.item.add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon, "book-search");
  assert.equal(parent.item.add.disabled, false);
  assertChecking(nested.item);

  childPreflight.resolve({ state: "addable", canAdd: true });
  await until(() => nested.item.add.dataset.state === "ready");
  assert.equal(nested.item.add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon, "add");
  assert.equal(parent.item.add.dataset.state, "view-existing");
});

test("successful Add remains successful after a refresh failure and a second click opens the new note", async t => {
  let submitted = 0;
  const browse = [];
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_submit") { submitted++; return { state: "added", noteId: 12, warnings: ["Audio unavailable"] }; }
    if (type === "hd_anki_browse") { browse.push(request); return { opened: true }; }
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
  assert.equal(f.items[0].add.querySelector(".gsm-hoshidicts-mine-icon").dataset.icon, "book-search");
  assert.equal(f.items[0].add.title, "Find added note in Anki");
  assert.equal(f.items[0].add.dataset.action, "view");
  f.items[0].add.click();
  await until(() => browse.length === 1);
  assert.deepEqual(browse, [{ noteIds: [12], expression: "猫", configKey: "current", templateId: "default" }]);
  assert.equal(submitted, 1);
});

test("a host-planned browser-speech request is carried only into the matching submission", async t => {
  const clientSpeech = {
    sourceId: "default-tts",
    sourceKey: "saved-source",
    expression: "猫",
    reading: "",
  };
  let submitted;
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_submit") {
      submitted = request;
      return { state: "added", noteId: 12, warnings: [] };
    }
    return request.term.expression === "猫"
      ? { state: "addable", canAdd: true, clientSpeech }
      : { state: "addable", canAdd: true };
  });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items[2].add && !f.items[2].add.disabled);
  f.items[0].add.click();
  await until(() => f.items[0].add.dataset.state === "success");
  assert.deepEqual(submitted.clientSpeech, clientSpeech);
});

test("late preflight cannot expose retired controls and an uncertain write opens Anki instead of retrying", async t => {
  const held = Promise.withResolvers();
  let pending = true, writes = 0;
  const browse = [];
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") { if (pending) await held.promise; return { available: true, configKey: "current" }; }
    if (type === "hd_anki_submit") { writes++; throw new Error("reply lost"); }
    if (type === "hd_anki_browse") { browse.push(request); return { opened: true }; }
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
  assert.equal(f.items[0].control.hidden, true);
  assert.equal(f.items[0].add.hidden, true);
  assertChecking(f.items[0]);
  f.items[1].add.click();
  await until(() => f.items[1].add.dataset.state === "error");
  assert.equal(f.items[1].add.dataset.action, "view");
  assert.match(f.items[1].output.textContent, /Check Anki before trying again/u);
  f.items[1].add.click();
  await until(() => browse.length === 1);
  assert.deepEqual(browse, [{ noteIds: [], expression: "犬", configKey: "current", templateId: "default" }]);
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
    held.resolve({ state, noteId: 42, warnings: [], error: "Check Anki before trying again." });
    await until(() => !f.items[0].output.textContent.includes("Saving"));
    assert.equal(f.items[0].add.dataset.action, "view", `${state} must remain terminal after configuration changes`);
    f.items[0].add.click();
    assert.equal(writes, 1);
  }
});

test("presentation reprojection ignores detached actions' in-flight replies and drops them from later checks", async t => {
  const held = Promise.withResolvers(), batches = [];
  const f = fixture(t, handlesBatches(async (type, { requests } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    batches.push(requests.map(request => request.term.expression));
    if (batches.length === 1) await held.promise;
    return { replies: requests.map(() => ({ state: "invalid", canAdd: false, error: "This result cannot be added." })) };
  }));
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => batches.length === 1);
  f.items[0].actions.remove();
  f.items[2].actions.remove();
  f.controller.bind([f.items[1]], f.context);
  held.resolve();
  await until(() => f.items[1].add.dataset.state === "error");
  await tick();
  assert.deepEqual(batches, [["猫", "犬", "鳥"]]);
  f.controller.refresh(f.context.owner);
  await until(() => batches.length === 2);
  await tick();
  assert.deepEqual(batches, [["猫", "犬", "鳥"], ["犬"]]);
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

  // A capture that fails is a warning on an otherwise ordinary note.
  capture = async () => { throw new Error("The reading tab is no longer the active tab."); };
  f.items[1].add.click();
  await until(() => f.items[1].add.dataset.state === "success");
  await tick();
  assert.deepEqual(submittedRequest.captureUnavailable, ["screenshot"]);
  assert.equal(submittedRequest.screenshot, undefined);
  assert.match(f.items[1].output.textContent, /Added.*12.*Screenshot: The reading tab is no longer the active tab\./u);
});

test("built-in and custom Anki buttons keep independent Template status, preflight and submission identities", async t => {
  const calls = [];
  const f = fixture(t, handlesBatches(handlesAnkiView(async (type, fields = {}) => {
    calls.push({ type, fields: structuredClone(fields) });
    const templateId = fields.templateId ?? fields.request?.templateId;
    if (type === "hd_anki_view") return { state: "unknown", canAdd: false, noteIds: [],
      configKey: `key-${templateId}`, cached: false };
    if (type === "hd_anki_status") return { available: true, configKey: `key-${templateId}` };
    if (type === "hd_anki_preflight_batch") return { replies: fields.requests.map(() => ({ state: "addable", canAdd: true })) };
    if (type === "hd_anki_submit") return { state: "added", noteId: templateId === "sentence" ? 22 : 11, warnings: [] };
    throw new Error(`Unexpected ${type}`);
  })));
  const custom = f.items[0].actions.ownerDocument.createElement("button");
  custom.type = "button";
  custom.className = "gsm-hoshidicts-custom-anki-button gsm-hoshidicts-text-action-button";
  custom.dataset.customButtonId = "mine-sentence";
  custom.dataset.ankiTemplateId = "sentence";
  custom.dataset.customButtonLabel = "Mine sentence";
  custom.appendChild(f.items[0].actions.ownerDocument.createElement("span")).className = "gsm-hoshidicts-text-action-label";
  custom.firstElementChild.textContent = "Mine sentence";
  f.items[0].actions.append(custom);

  const base = globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE;
  const options = globalThis.HDReaderOptions.normaliseOptions({
    anki: { url: "http://127.0.0.1:8765", apiKey: "", templates: [
      { ...base, id: "default", name: "Word", model: "Basic", fields: { ...base.fields, expression: "Front" } },
      { ...base, id: "sentence", name: "Sentence", model: "Sentence", deck: "Sentences",
        fields: { ...base.fields, sentence: "Front" } },
    ] },
    customButtons: [{ id: "mine-sentence", type: "anki", label: "Mine sentence", templateId: "sentence" }],
  });
  f.controller.update(options);
  f.controller.bind([f.items[0]], f.context);
  await until(() => f.items[0].add?.dataset.state === "ready" && custom.dataset.state === "ready");
  assert.equal(custom.textContent, "Mine sentence");
  assert.equal(custom.disabled, false);
  assert.equal(custom.getAttribute("aria-label"), "Mine sentence: Mine to Anki");
  const batches = calls.filter(call => call.type === "hd_anki_preflight_batch")
    .map(call => call.fields.requests.map(request => [request.templateId, request.configKey]));
  assert.deepEqual(batches, [[["default", "key-default"]], [["sentence", "key-sentence"]]],
    "each Template's readiness is its own batch");

  custom.click();
  await until(() => custom.dataset.state === "success");
  f.items[0].add.click();
  await until(() => f.items[0].add.dataset.state === "success");
  assert.deepEqual(calls.filter(call => call.type === "hd_anki_submit")
    .map(call => call.fields.request.templateId), ["sentence", "default"]);
});

// Issue #488: the Default renderer shows one result's actions in the shared
// lookup toolbar and names that result as the owner of its custom buttons.
test("custom Anki buttons in a shared toolbar mine the item a renderer names as their owner", async t => {
  const calls = [];
  const f = fixture(t, handlesBatches(handlesAnkiView(async (type, fields = {}) => {
    calls.push({ type, fields: structuredClone(fields) });
    const templateId = fields.templateId ?? fields.request?.templateId;
    if (type === "hd_anki_view") return { state: "unknown", canAdd: false, noteIds: [],
      configKey: `key-${templateId}`, cached: false };
    if (type === "hd_anki_status") return { available: true, configKey: `key-${templateId}` };
    if (type === "hd_anki_preflight_batch") return { replies: fields.requests.map(() => ({ state: "addable", canAdd: true })) };
    if (type === "hd_anki_submit") return { state: "added", noteId: 7, warnings: [] };
    throw new Error(`Unexpected ${type}`);
  })));
  const document = f.items[0].actions.ownerDocument;
  const toolbar = document.createElement("div");
  const custom = toolbar.appendChild(document.createElement("button"));
  custom.type = "button";
  custom.className = "gsm-hoshidicts-custom-anki-button gsm-hoshidicts-text-action-button";
  custom.dataset.customButtonId = "mine-sentence";
  custom.dataset.ankiTemplateId = "sentence";
  custom.dataset.customButtonLabel = "Mine sentence";
  f.items[0].actions.after(toolbar);
  const base = globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE;
  f.controller.update(globalThis.HDReaderOptions.normaliseOptions({
    anki: { url: "http://127.0.0.1:8765", apiKey: "", templates: [
      { ...base, id: "default", name: "Word", model: "Basic", fields: { ...base.fields, expression: "Front" } },
      { ...base, id: "sentence", name: "Sentence", model: "Sentence", fields: { ...base.fields, sentence: "Front" } },
    ] },
    customButtons: [{ id: "mine-sentence", type: "anki", label: "Mine sentence", templateId: "sentence" }],
  }));
  // Plain items, as popup.js binds them.
  const items = f.items.slice(0, 2).map(({ actions, feedback, result }) => ({ actions, feedback, result }));
  const add = item => item.actions.querySelector(".gsm-hoshidicts-mine-button");
  const own = index => items.forEach((item, position) => { item.customActions = position === index ? toolbar : null; });
  const submitted = () => calls.filter(call => call.type === "hd_anki_submit")
    .map(call => [call.fields.request.templateId, call.fields.request.term.expression]);
  own(0);
  f.controller.bind(items, f.context);
  await until(() => items.every(item => add(item)?.dataset.state === "ready") && custom.dataset.state === "ready");
  custom.click();
  await until(() => custom.dataset.state === "success");
  // A successful add checks every record again; let that finish first.
  for (let n = 0; n < 20; n++) await tick();
  const builtInChecks = () => calls.filter(call => call.type === "hd_anki_preflight_batch"
    && call.fields.requests.some(request => request.templateId === "default")).length;
  const checksBefore = builtInChecks();
  const firstAdd = add(items[1]);
  own(1);
  f.controller.bind(items, f.context);
  await until(() => custom.dataset.state === "ready");
  for (let n = 0; n < 20; n++) await tick();
  assert.equal(builtInChecks(), checksBefore, "moving the custom buttons does not check the built-in buttons again");
  assert.equal(add(items[1]), firstAdd, "the built-in buttons keep their records");
  custom.click();
  await until(() => custom.dataset.state === "success");
  assert.deepEqual(submitted(), [["sentence", "猫"], ["sentence", "犬"]]);
});

test("a custom Anki button whose Template was removed stays visible and reports the missing identity", async t => {
  const calls = [];
  const f = fixture(t, async (type, fields = {}) => {
    calls.push({ type, fields });
    if (type === "hd_anki_status") return { available: false, configKey: "", error: "Choose an Anki note type in Settings." };
    throw new Error(`Unexpected ${type}`);
  });
  const custom = f.items[0].actions.ownerDocument.createElement("button");
  custom.type = "button";
  custom.className = "gsm-hoshidicts-custom-anki-button gsm-hoshidicts-text-action-button";
  custom.dataset.customButtonId = "missing";
  custom.dataset.ankiTemplateId = "deleted-template";
  custom.dataset.customButtonLabel = "Mine old card";
  custom.appendChild(f.items[0].actions.ownerDocument.createElement("span")).className = "gsm-hoshidicts-text-action-label";
  custom.firstElementChild.textContent = "Mine old card";
  f.items[0].actions.append(custom);
  const options = globalThis.HDReaderOptions.normaliseOptions({
    customButtons: [{ id: "missing", type: "anki", label: "Mine old card", templateId: "deleted-template" }],
  });
  f.controller.update(options);
  f.controller.bind([f.items[0]], f.context);
  await until(() => custom.dataset.state === "unavailable");
  assert.equal(custom.hidden, false);
  assert.equal(custom.disabled, true);
  assert.match(custom.title, /no longer available/u);
  assert.match(f.items[0].feedback.textContent, /no longer available/u);
  assert.equal(calls.some(call => call.fields.templateId === "deleted-template"
    || call.fields.request?.templateId === "deleted-template"), false);
});

test("a submission Anki answers as a duplicate or invalid releases its screenshot and stays retryable", async t => {
  for (const state of ["duplicate", "invalid"]) {
    const calls = [];
    const f = fixture(t, async (type, fields = {}) => {
      calls.push([type, fields.request?.token]);
      if (type === "hd_anki_status") return { available: true, configKey: "current" };
      if (type === "hd_anki_screenshot") return { token: "shot-a", filename: "hachidori-screenshot-a.jpg" };
      if (type === "hd_anki_submit") return { state, noteIds: [31], error: "Anki refused this note." };
      if (type === "hd_anki_screenshot_discard") return { discarded: true };
      return { state: "addable", canAdd: true, screenshot: true };
    });
    f.controller.update(configured);
    f.controller.bind([f.items[0]], f.context);
    await until(() => f.items[0].add && !f.items[0].add.disabled);
    f.items[0].add.click();
    await until(() => calls.some(([type]) => type === "hd_anki_screenshot_discard"));
    await tick();
    assert.deepEqual(calls.filter(([type]) => type === "hd_anki_screenshot_discard"), [["hd_anki_screenshot_discard", "shot-a"]], state);
    // A definitive refusal is not an unconfirmed write.
    assert.doesNotMatch(f.items[0].output.textContent, /could not be confirmed|Check Anki before trying again/u, state);
  }
});

test("a Netflix note records its line concealed after the screenshot, and a missing line is a warning, never a failure", async t => {
  const calls = [], concealed = [], recordings = [];
  let decision = { state: "addable", canAdd: true, screenshot: true, sentenceAudio: true };
  let recorded = async () => ({ audio: { token: "line-a", filename: "hachidori-sentence-audio-a.wav" }, gif: null });
  let netflix = { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } };
  let submittedRequest = null;
  const f = fixture(t, async (type, { request } = {}) => {
    calls.push(type);
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_screenshot") return { token: "shot-a", filename: "hachidori-screenshot-a.jpg" };
    if (type === "hd_anki_submit") { submittedRequest = request; return { state: "added", noteId: 12, warnings: [] }; }
    return decision;
  }, undefined, undefined, async during => {
    concealed.push("hidden");
    const result = await during();
    concealed.push("restored");
    return result;
  }, async (cue, templateId, { conceal }) => {
    // The page conceals the reader with the function it is given, around tab capture.
    recordings.push([cue, templateId, calls.at(-1)]);
    return conceal(() => recorded());
  });
  f.context.getRequest = result => ({ term: result.term, netflix });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items.every(item => item.add && !item.add.disabled));
  const mine = async index => {
    f.items[index].add.click();
    await until(() => f.items[index].add.dataset.state === "success");
    return f.items[index].output.textContent;
  };

  assert.equal(await mine(0), "Added note 12.");
  // The picture first, then the line, each with the reader hidden, then the write.
  assert.deepEqual(recordings, [[netflix.cue, "default", "hd_anki_screenshot"]]);
  assert.deepEqual(concealed, ["hidden", "restored", "hidden", "restored"]);
  assert.deepEqual(calls.filter(type => ["hd_anki_screenshot", "hd_anki_submit"].includes(type)),
    ["hd_anki_screenshot", "hd_anki_submit"]);
  assert.deepEqual(submittedRequest.sentenceAudio, { token: "line-a", filename: "hachidori-sentence-audio-a.wav" });
  assert.equal(submittedRequest.captureUnavailable, undefined);

  // Chrome's missing capture grant explains the one-time invocation.
  recorded = async () => ({ unavailable: "grant" });
  assert.match(await mine(1), /^Added note 12\. Sentence audio: Chrome has not let Hachidori record this tab yet\. Click Hachidori's toolbar button once/u);
  assert.deepEqual(submittedRequest.captureUnavailable, ["sentence-audio"]);
  assert.equal(submittedRequest.sentenceAudio, undefined);

  // A line with no cue says why and records nothing.
  netflix = { unavailable: "no-match" };
  recorded = async () => { throw new Error("must not record without a cue"); };
  f.controller.refresh(f.context.owner);
  await until(() => f.items[2].add && !f.items[2].add.disabled);
  assert.match(await mine(2), /Sentence audio: the hovered subtitle matched no line in Netflix's subtitle file\./u);
  assert.deepEqual(submittedRequest.captureUnavailable, ["sentence-audio"]);
  assert.equal(recordings.length, 2);
});

test("a recording failure, a linked browser and an unmapped marker never fail or record the note", async t => {
  const recordings = [];
  let decision = { state: "addable", canAdd: true, sentenceAudio: true };
  let submittedRequest = null;
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_submit") { submittedRequest = request; return { state: "added", noteId: 7, warnings: [] }; }
    return decision;
  }, undefined, undefined, undefined, async cue => {
    recordings.push(cue);
    throw new Error("The Netflix tab is no longer the active tab.");
  });
  f.context.getRequest = result => ({ term: result.term, netflix: { cue: { movieId: "1", startMs: 0, endMs: 900 } } });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items.every(item => item.add && !item.add.disabled));
  f.items[0].add.click();
  await until(() => f.items[0].add.dataset.state === "success");
  assert.equal(f.items[0].output.textContent, "Added note 7. Sentence audio: The Netflix tab is no longer the active tab.");
  assert.deepEqual(submittedRequest.captureUnavailable, ["sentence-audio"]);

  // A linked preflight is the host's reply plus netflixLinked: the host never
  // sees the cue, so it flags neither sentenceAudio nor gif.
  decision = { state: "addable", canAdd: true, netflixLinked: true };
  f.controller.refresh(f.context.owner);
  await until(() => f.items[1].add && !f.items[1].add.disabled);
  f.items[1].add.click();
  await until(() => f.items[1].add.dataset.state === "success");
  assert.equal(f.items[1].output.textContent,
    "Added note 7. Netflix mining: this browser is linked to another Hachidori, so Netflix lines are not recorded.");

  // Without a mapped {sentence-audio}, or with Netflix mining off, the worker
  // says nothing about sentence audio and the note is exactly as before.
  decision = { state: "addable", canAdd: true };
  f.controller.refresh(f.context.owner);
  await until(() => f.items[2].add && !f.items[2].add.disabled);
  f.items[2].add.click();
  await until(() => f.items[2].add.dataset.state === "success");
  assert.equal(f.items[2].output.textContent, "Added note 7.");
  assert.equal(submittedRequest.captureUnavailable, undefined);
  assert.equal(submittedRequest.sentenceAudio, undefined);
  assert.equal(recordings.length, 1);
});

test("a Netflix note records its line's GIF, and a missing or failed GIF falls back to the screenshot", async t => {
  const recordings = [];
  // The reader asks for both the audio and the GIF; the worker's flags say so.
  let decision = { state: "addable", canAdd: true, screenshot: true, sentenceAudio: true, gif: true };
  let recorded = async () => ({ audio: { token: "line-a", filename: "a.wav" },
    gif: { token: "gif-a", filename: "hachidori-gif-a.gif" } });
  let netflix = { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } };
  let submittedRequest = null;
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_screenshot") return { token: "shot-a", filename: "hachidori-screenshot-a.jpg" };
    if (type === "hd_anki_submit") { submittedRequest = request; return { state: "added", noteId: 21, warnings: [] }; }
    return decision;
  }, undefined, undefined, during => during(), async (cue, templateId, { audio, gif }) => {
    recordings.push([cue, templateId, { audio, gif }]);
    return recorded();
  });
  f.context.getRequest = result => ({ term: result.term, netflix });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items.every(item => item.add && !item.add.disabled));
  const mine = async index => {
    f.items[index].add.click();
    await until(() => f.items[index].add.dataset.state === "success");
    return f.items[index].output.textContent;
  };

  // A GIF is recorded (the recorder is asked for it) and both files are submitted.
  assert.equal(await mine(0), "Added note 21.");
  assert.deepEqual(recordings.at(-1), [netflix.cue, "default", { audio: true, gif: true }]);
  assert.deepEqual(submittedRequest.gif, { token: "gif-a", filename: "hachidori-gif-a.gif" });
  assert.deepEqual(submittedRequest.sentenceAudio, { token: "line-a", filename: "a.wav" });
  assert.equal(submittedRequest.captureUnavailable, undefined);

  // The replay returns no GIF: {gif} falls back to the screenshot, and the note says so.
  recorded = async () => ({ audio: { token: "line-b", filename: "b.wav" }, gif: null });
  assert.equal(await mine(1), "Added note 21. GIF: no GIF could be made of the line.");
  assert.equal(submittedRequest.gif, undefined);
  assert.deepEqual(submittedRequest.captureUnavailable, ["gif"]);
  assert.deepEqual(submittedRequest.sentenceAudio, { token: "line-b", filename: "b.wav" });

  // No cue: one warning names both media, and {gif} still falls back to the screenshot.
  netflix = { unavailable: "no-match" };
  recorded = async () => { throw new Error("must not record without a cue"); };
  f.controller.refresh(f.context.owner);
  await until(() => f.items[2].add && !f.items[2].add.disabled);
  assert.equal(await mine(2),
    "Added note 21. Sentence audio and GIF: the hovered subtitle matched no line in Netflix's subtitle file.");
  assert.deepEqual([...submittedRequest.captureUnavailable].sort(), ["gif", "sentence-audio"]);
});

test("a note whose only Netflix field is {gif} says why it got the screenshot instead", async t => {
  const decision = { state: "addable", canAdd: true, screenshot: true, gif: true };
  const wantedMedia = [];
  let recorded = async () => ({ unavailable: "grant" });
  let submittedRequest = null;
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_screenshot") return { token: "shot-a", filename: "hachidori-screenshot-a.jpg" };
    if (type === "hd_anki_submit") { submittedRequest = request; return { state: "added", noteId: 31, warnings: [] }; }
    return decision;
  }, undefined, undefined, during => during(), async (cue, templateId, { audio, gif }) => {
    wantedMedia.push({ audio, gif });
    return recorded();
  });
  f.context.getRequest = result => ({ term: result.term, netflix: { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } } });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items.every(item => item.add && !item.add.disabled));
  const mine = async index => {
    f.items[index].add.click();
    await until(() => f.items[index].add.dataset.state === "success");
    return f.items[index].output.textContent;
  };

  // Without a grant the warning still explains the one-time click.
  assert.equal(await mine(0), "Added note 31. GIF: Chrome has not let Hachidori record this tab yet. Click Hachidori's "
    + "toolbar button once on this tab, or add notes with the “Add the current popup entry to Anki” shortcut from "
    + "chrome://extensions/shortcuts; later notes in this tab will record the line.");
  assert.deepEqual(submittedRequest.captureUnavailable, ["gif"]);
  assert.deepEqual(submittedRequest.screenshot, { token: "shot-a", filename: "hachidori-screenshot-a.jpg" });

  // A recorded GIF is submitted with no warning and no audio.
  recorded = async () => ({ audio: null, gif: { token: "gif-b", filename: "hachidori-gif-b.gif" } });
  assert.equal(await mine(1), "Added note 31.");
  assert.deepEqual(submittedRequest.gif, { token: "gif-b", filename: "hachidori-gif-b.gif" });
  assert.equal(submittedRequest.sentenceAudio, undefined);
  assert.equal(submittedRequest.captureUnavailable, undefined);

  // A recording that fails is a GIF warning too.
  recorded = async () => { throw new Error("The recording of this line was interrupted."); };
  assert.equal(await mine(2), "Added note 31. GIF: The recording of this line was interrupted.");
  assert.deepEqual(submittedRequest.captureUnavailable, ["gif"]);
  // Each recording asked for the GIF only, so no WAV is made or held.
  assert.deepEqual(wantedMedia, Array(3).fill({ audio: false, gif: true }));
});

test("sentence audio the page cut from what was heard goes in beside a GIF that has its own reason", async t => {
  let submittedRequest = null;
  const f = fixture(t, async (type, { request } = {}) => {
    if (type === "hd_anki_status") return { available: true, configKey: "current" };
    if (type === "hd_anki_screenshot") return { token: "shot-a", filename: "hachidori-screenshot-a.jpg" };
    if (type === "hd_anki_submit") { submittedRequest = request; return { state: "added", noteId: 41, warnings: [] }; }
    return { state: "addable", canAdd: true, screenshot: true, sentenceAudio: true, gif: true };
  }, undefined, undefined, during => during(), async () => ({ audio: { token: "line-a", filename: "a.wav" },
    gif: { unavailable: "grant" } }));
  f.context.getRequest = result => ({ term: result.term, netflix: { cue: { movieId: "81000001", startMs: 1000, endMs: 3500 } } });
  f.controller.update(configured);
  f.controller.bind(f.items, f.context);
  await until(() => f.items[0].add && !f.items[0].add.disabled);
  f.items[0].add.click();
  await until(() => f.items[0].add.dataset.state === "success");
  assert.match(f.items[0].output.textContent, /^Added note 41\. GIF: Chrome has not let Hachidori record this tab yet\./u);
  assert.deepEqual(submittedRequest.captureUnavailable, ["gif"]);
  assert.deepEqual(submittedRequest.sentenceAudio, { token: "line-a", filename: "a.wav" });
  assert.equal(submittedRequest.gif, undefined);
});
