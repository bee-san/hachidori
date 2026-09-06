// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function disabled(record) {
    if (!record.add) return;
    record.add.disabled = record.busy || record.terminal || record.group.checking || !record.decision?.canAdd;
  }
  function payload(record) {
    return { ...record.group.getRequest(record.result), configKey: record.group.configKey };
  }
  function decisionLabel(value) {
    if (value.action === "overwrite" && value.canAdd) return "Overwrite";
    if (value.state === "duplicate" && !value.canAdd) return "In Anki";
    if (value.state === "invalid" || value.state === "error") return "Cannot add";
    return "Add to Anki";
  }
  function decision(record, value) {
    record.decision = value;
    if (!record.terminal && !record.busy) {
      record.add.dataset.state = value.state;
      text(record.add, decisionLabel(value));
      text(record.output, value.error || "");
    }
    disabled(record);
  }
  function uncertain(record, error) {
    record.terminal = true;
    record.add.dataset.state = "uncertain";
    text(record.add, "Check Anki");
    text(record.output, error);
  }
  function createAnkiController({ send, onChange }) {
    const owners = new Map(), bound = new WeakMap();
    let enabled = false, settingsKey = "", checks = Promise.resolve();
    const live = group => enabled && owners.get(group.owner) === group && !group.popup.hidden && group.isCurrent();
    const current = record => live(record.group) && record.actions.isConnected;
    const needsCheck = record => record.actions.isConnected && record.needsCheck && !record.busy && !record.terminal;
    function available(group, value) {
      for (const record of group.records) {
        if (value && record.actions.isConnected) controls(record);
        if (record.control) record.control.hidden = !value;
        if (!value) record.needsCheck = false;
      }
    }
    async function checkRecords(group, owns) {
      for (const record of group.records) {
        if (!owns()) return;
        if (!needsCheck(record)) continue;
        record.needsCheck = false;
        try {
          const result = await send("hd_anki_preflight", { request: payload(record) });
          if (owns() && record.actions.isConnected) decision(record, result);
        } catch (error) {
          if (owns() && record.actions.isConnected) decision(record, { state: "error", canAdd: false, error: error.message });
        }
      }
    }
    async function checkGroup(group) {
      const epoch = group.epoch;
      const owns = () => live(group) && epoch === group.epoch;
      try {
        if (!owns()) return;
        const status = await send("hd_anki_status", {});
        if (!owns()) return;
        group.configKey = status.configKey;
        available(group, status.available);
        if (!status.available) return;
        onChange(group.owner);
        await checkRecords(group, owns);
      } catch {
        if (owns()) available(group, false);
      } finally {
        group.queued = group.checking = false;
        if (live(group)) {
          group.records.forEach(disabled);
          onChange(group.owner);
          refresh(group);
        }
      }
    }
    function refresh(group, all = false) {
      if (all) for (const record of group.records) record.needsCheck = !record.terminal;
      if (!live(group) || group.queued || !group.records.some(needsCheck)) return;
      group.queued = group.checking = true;
      group.records.forEach(disabled);
      const operation = () => checkGroup(group);
      checks = checks.then(operation, operation);
    }
    function refreshAll() {
      for (const group of owners.values()) refresh(group, true);
    }
    function submitted(record, result) {
      if (result.state === "uncertain") { uncertain(record, result.error); return true; }
      if (result.state !== "added" && result.state !== "updated") return false;
      // A configuration epoch can change while Anki commits. The submitted
      // record still owns its outcome; never turn a known write into a retry.
      record.terminal = true;
      record.add.dataset.state = "success";
      const label = result.state === "added" ? "Added" : "Updated";
      text(record.add, label);
      text(record.output, `${label} note ${result.noteId}. ${result.warnings.join(" ")}`.trim());
      refreshAll(); // Best-effort checks cannot turn a confirmed write into a retry.
      return true;
    }
    async function submit(record, fromPointer) {
      if (!current(record) || record.add.disabled || record.busy || record.terminal) return;
      const group = record.group, epoch = group.epoch;
      const owns = () => current(record) && record.group === group && group.epoch === epoch;
      const request = (fromPointer && record.pointerRequest) || payload(record);
      record.pointerRequest = null;
      record.busy = true;
      disabled(record);
      text(record.output, "Saving to Anki…");
      try {
        const result = await send("hd_anki_submit", { request });
        if (!submitted(record, result) && owns()) { decision(record, { ...result, canAdd: false }); refreshAll(); }
      } catch (error) {
        if (!error.responseReceived) uncertain(record, `The write could not be confirmed. Use View in Anki before trying again. ${error.message}`);
        else if (owns()) text(record.output, `Could not add: ${error.message}`);
      } finally {
        record.busy = false;
        if (current(record)) { disabled(record); onChange(record.group.owner); refresh(record.group); }
      }
    }
    async function browse(record) {
      if (!current(record) || record.view.disabled) return;
      record.view.disabled = true;
      try { await send("hd_anki_browse", { expression: record.result.term.expression }); }
      catch (error) { if (current(record)) text(record.output, `Could not open Anki: ${error.message}`); }
      finally { if (current(record)) { record.view.disabled = false; onChange(record.group.owner); } }
    }
    function controls(record) {
      if (record.control) return;
      const document = record.actions.ownerDocument;
      const control = document.createElement("div");
      control.className = "gsm-hoshidicts-anki-control";
      const add = document.createElement("button"), view = document.createElement("button");
      add.type = view.type = "button";
      add.className = "gsm-hoshidicts-mine-button";
      view.className = "gsm-hoshidicts-anki-view";
      add.textContent = "Add to Anki";
      view.textContent = "View";
      add.setAttribute("aria-label", `Add ${record.result.term.expression} to Anki`);
      view.setAttribute("aria-label", `View ${record.result.term.expression} in Anki`);
      const output = document.createElement("output");
      output.className = "gsm-hoshidicts-anki-status";
      output.setAttribute("aria-live", "polite");
      control.append(add, view, output);
      record.actions.prepend(control);
      Object.assign(record, { control, add, view, output });
      add.addEventListener("mousedown", event => { if (event.button === 0 && current(record)) record.pointerRequest = payload(record); });
      add.addEventListener("click", event => { void submit(record, event.detail > 0); });
      view.addEventListener("click", () => { void browse(record); });
      disabled(record);
    }
    function bind(items, context) {
      let group = owners.get(context.owner);
      if (!group) { group = { ...context, records: [], epoch: 0, checking: false, queued: false }; owners.set(context.owner, group); }
      group.records = group.records.filter(record => record.actions.isConnected);
      for (const item of items) {
        let record = bound.get(item.actions);
        if (record?.group === group) continue;
        record?.control?.remove();
        record = { ...item, group, busy: false, terminal: false, decision: null, needsCheck: true };
        bound.set(item.actions, record);
        group.records.push(record);
        disabled(record);
      }
      refresh(group);
    }
    function retire(owner) {
      for (const [key, group] of owners) {
        if (owner !== undefined && owner !== key) continue;
        owners.delete(key);
        for (const record of group.records) if (record.control) record.control.hidden = true;
      }
    }
    return { bind, retire,
      refresh(owner) { const group = owners.get(owner); if (group) refresh(group, true); },
      update(options, ready = true) {
        const key = JSON.stringify([ready, options.anki, options.audioSources]);
        if (key === settingsKey) return;
        settingsKey = key;
        enabled = ready && Boolean(options.anki.model);
        for (const group of owners.values()) {
          group.epoch++;
          for (const record of group.records) if (record.control) record.control.hidden = true;
          refresh(group, true);
        }
      },
    };
  }
  globalThis.HDAnki = { createAnkiController };
}());
