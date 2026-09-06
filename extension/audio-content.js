// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";

  function createAudioController({ window, send, onMenuChange }) {
    const document = window.document;
    const bound = new WeakMap(), visited = new WeakMap(), feedback = new WeakMap();
    let selections = new WeakMap();
    let options = window.HDReaderOptions.DEFAULT_OPTIONS;
    let sourceKey = JSON.stringify(options.audioSources);
    let active = null, menu = null;

    function current(record) {
      return record.button.isConnected && !record.popup.hidden && record.isCurrent();
    }

    function setBusy(record, busy) {
      record.button.textContent = busy ? "Stop" : "Audio";
      record.button.setAttribute("aria-busy", String(busy));
    }

    function setStatus(record, text) {
      let output = feedback.get(record.button) || record.status;
      if (!output) {
        output = document.createElement("output");
        output.className = "gsm-hoshidicts-audio-status";
        output.setAttribute("aria-live", "polite");
        record.button.after(output);
      }
      feedback.set(record.button, output);
      output.textContent = text;
    }

    function stop() {
      if (!active) return;
      const previous = active;
      active = null;
      setBusy(previous.record, false);
      setStatus(previous.record, "Stopped.");
      void send("hd_audio_stop", { playRequestId: previous.requestId }).catch(() => {});
    }

    function closeMenu(restoreFocus = true) {
      if (!menu) return false;
      const previous = menu;
      menu = null;
      if (active?.type === "hd_audio_candidates" && active.record === previous.record) stop();
      previous.element.remove();
      previous.record.button.setAttribute("aria-expanded", "false");
      if (restoreFocus && current(previous.record)) previous.record.button.focus({ preventScroll: true });
      onMenuChange(previous.record.owner);
      return true;
    }

    function retire(owner) {
      if (menu && (owner === undefined || menu.record.owner === owner)) closeMenu(false);
      if (active && (owner === undefined || active.record.owner === owner)) stop();
    }

    async function request(record, type, fields, accept) {
      stop();
      if (!current(record)) return;
      const operation = { record, type, requestId: window.crypto.randomUUID() };
      active = operation;
      setBusy(record, true);
      setStatus(record, type === "hd_audio_play" ? "Finding pronunciation…" : "Finding choices…");
      try {
        const reply = await send(type, { term: record.term, requestId: operation.requestId, ...fields });
        if (active !== operation || !current(record)) return;
        if (!reply.ok) throw new Error(reply.error);
        accept(reply);
      } catch (error) {
        if (active === operation && current(record)) {
          if (type === "hd_audio_play" && selections.get(record.result) === fields.selection) selections.delete(record.result);
          setStatus(record, `Could not play: ${error.message}`);
          if (menu?.record === record) menu.output.textContent = error.message;
        }
      } finally {
        if (active === operation) { active = null; setBusy(record, false); }
      }
    }

    function play(record, selection = selections.get(record.result)) {
      closeMenu();
      return request(record, "hd_audio_play", selection ? { selection } : {}, reply => {
        setStatus(record, reply.status === "success"
          ? `Played${reply.candidate?.name ? ` — ${reply.candidate.name}` : ""}.`
          : reply.status === "no-result" ? "No pronunciation was returned. Check Audio Settings." : "Stopped.");
      });
    }

    function choices(record) {
      closeMenu(false);
      if (!current(record)) return;
      const element = document.createElement("section");
      element.className = "gsm-hoshidicts-audio-menu gsm-hoshidicts-audio-choices";
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-label", `Pronunciation for ${record.term.expression}`);
      const heading = document.createElement("strong");
      heading.className = "gsm-hoshidicts-audio-menu-heading";
      heading.textContent = `Pronunciation · ${record.term.expression}`;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "gsm-hoshidicts-audio-menu-item gsm-hoshidicts-audio-menu-close";
      close.textContent = "Close";
      close.addEventListener("click", () => closeMenu());
      const output = document.createElement("p");
      output.className = "gsm-hoshidicts-audio-menu-status";
      output.setAttribute("role", "status");
      output.textContent = "Finding choices…";
      element.append(heading, close, output);
      record.popup.append(element);
      menu = { element, output, record };
      record.button.setAttribute("aria-expanded", "true");
      onMenuChange(record.owner);
      close.focus({ preventScroll: true });
      void request(record, "hd_audio_candidates", {}, reply => {
        let count = 0;
        for (const [sourceIndex, group] of reply.groups.entries()) {
          const section = document.createElement("div");
          const title = document.createElement("h4");
          title.className = "gsm-hoshidicts-audio-menu-heading";
          title.textContent = `${sourceIndex + 1}. ${window.HDReaderOptions.AUDIO_SOURCE_LABELS[group.type]}`;
          section.append(title);
          if (group.error) {
            const error = document.createElement("p");
            error.textContent = group.error;
            section.append(error);
          }
          for (const [index, candidate] of (group.candidates || []).entries()) {
            count += 1;
            const button = document.createElement("button");
            button.className = "gsm-hoshidicts-audio-menu-item";
            button.type = "button";
            button.textContent = candidate.name || `Pronunciation ${index + 1}`;
            button.addEventListener("click", () => {
              const selection = { sourceId: group.sourceId, sourceKey: group.sourceKey, ...record.term,
                index, url: candidate.url ?? null, name: candidate.name };
              selections.set(record.result, selection);
              void play(record, selection);
            });
            section.append(button);
          }
          element.append(section);
        }
        setStatus(record, "");
        output.textContent = count ? "Choose a pronunciation to play." : "No pronunciations found. Check Audio Settings.";
        onMenuChange(record.owner);
      });
    }

    function bind(items, context) {
      if (active?.record.owner === context.owner && !current(active.record)) stop();
      if (menu?.record.owner === context.owner && !current(menu.record)) closeMenu(false);
      for (const item of items) {
        if (bound.has(item.button)) continue;
        const record = { ...item, ...context,
          term: { expression: item.result.term.expression, reading: item.result.term.reading || "" } };
        bound.set(item.button, record);
        item.button.addEventListener("click", event => {
          if (event.shiftKey) choices(record);
          else if (active?.record.button === item.button) stop();
          else void play(record);
        });
        item.button.addEventListener("contextmenu", event => { event.preventDefault(); choices(record); });
        item.button.addEventListener("keydown", event => {
          if (event.key === "ArrowDown") { event.preventDefault(); choices(record); }
        });
      }
      const first = items[0];
      if (!first || !context.request) return;
      let keys = visited.get(context.request);
      if (!keys) { keys = new Set(); visited.set(context.request, keys); }
      const key = JSON.stringify([context.request.selectedDictionaryTab, first.result.term.expression, first.result.term.reading]);
      if (keys.has(key)) return;
      keys.add(key);
      if (options.audioAutoplay && current({ ...first, ...context })) {
        void play(bound.get(first.button));
      }
    }

    const listener = message => {
      if (message?.target !== "hachidori-audio-content" || message.type !== "hd_audio_playing"
          || message.requestId !== active?.requestId || !current(active.record)) return;
      setStatus(active.record, `Playing${message.candidate?.name ? ` — ${message.candidate.name}` : ""}…`);
    };
    window.chrome.runtime.onMessage.addListener(listener);
    return {
      bind, retire, closeMenu,
      hasMenu: owner => Boolean(menu && (owner === undefined || menu.record.owner === owner)),
      selectionFor: result => selections.get(result) ?? null,
      update(next) {
        const nextKey = JSON.stringify(next.audioSources);
        if (nextKey !== sourceKey) { retire(); selections = new WeakMap(); }
        else if (options.audioAutoplay && !next.audioAutoplay) retire();
        sourceKey = nextKey;
        options = next;
      },
      dispose() { retire(); window.chrome.runtime.onMessage.removeListener(listener); },
    };
  }
  globalThis.HDAudio = { createAudioController };
}());
