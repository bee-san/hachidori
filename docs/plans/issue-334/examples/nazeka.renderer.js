// SPDX-License-Identifier: GPL-3.0-or-later
// examples/nazeka.renderer.js — ILLUSTRATIVE sketch of a renderer on the v1
// contract (renderer-api.md). The real file is card T-32 in hachidori-theme-store
// (themes/nazeka/renderer.js); values follow the schema-1 prototype's fidelity
// notes (wareya/nazeka texthook.js at 8b220fb). Rules this shows:
// - one classic script, one top-level statement: HDRenderers.register({...});
// - no Default DOM is built or scraped: everything comes from the model;
// - glossary text mode only (no structured DOM, images, links, dictionary CSS);
// - buttons call ctx.actions, so keybinds, autoplay and mining work without them;
// - listeners and timers only through ctx.on / ctx.schedule (host-owned, guarded).
HDRenderers.register({
  id: "nazeka",
  apiVersion: 1,
  version: "2.0.0",
  glossary: ["text"],
  components: ["kanjiLink"],
  layout: { size: "content" },
  createView(ctx) {
    const { el, text, actions, glossary, components } = ctx;

    function lookedUpRow(model) {
      const row = el("div", { className: "nz-original" });
      const source = model.source;
      if (source) {
        const before = source.sentence.slice(Math.max(0, source.offset - 3), source.offset);
        const match = source.sentence.slice(source.offset, source.offset + source.length);
        row.append(text(before), el("b", { className: "nz-match" }, match));
      }
      const tools = el("span", { className: "nz-tools" });
      const primary = model.kind === "terms" ? model.results[0] : null;
      if (primary) {
        const audio = el("button", { type: "button", className: "nz-audio", "aria-label": `Play audio for ${primary.expression}` }, "🔊");
        ctx.on(audio, "click", () => actions.playAudio(primary.index));
        const mine = el("button", { type: "button", className: "nz-mine", "aria-label": `Add ${primary.expression} to Anki`, "data-hd-role": "mine" }, "+");
        ctx.on(mine, "click", () => actions.mine(primary.index, "add"));
        tools.append(audio, mine);
      }
      row.append(tools);
      return row;
    }

    function wordRow(result) {
      const row = el("div", { className: "nz-word" });
      // Headword characters stay kanji links so a click opens the kanji view and
      // Back restores focus (roles are set by the component).
      const headword = el("span", { className: "nz-keb", "data-hd-scan": "" });
      for (const character of result.expression) {
        headword.append(/\p{Script=Han}/u.test(character) ? components.kanjiLink(character) : text(character));
      }
      row.append(headword, el("span", { className: "nz-reb" }, `《${result.reading}》`));
      if (result.trace.length) row.append(text(`～${result.trace.map(step => step.name).join("→")}`));
      const rank = result.frequencies.find(frequency => frequency.mode !== "occurrence-based");
      if (rank) row.append(el("span", { className: "nz-freq" }, ` #${rank.displayValue} (${result.expression}:${result.reading})`));
      return row;
    }

    function senses(result) {
      // One paragraph: "(vt) (1) to eat; to live on; (2) ..." built from data.
      const paragraph = el("p", { className: "nz-senses", "data-hd-scan": "", "data-hd-blur": "" });
      result.definitions.forEach((definition, index) => {
        const tags = definition.tags.map(tag => `(${tag.name}) `).join("");
        paragraph.append(text(`${tags}(${index + 1}) ${glossary.toPlainText(definition.glossary, { separator: "; " })} `));
      });
      return paragraph;
    }

    return {
      renderTerms(model) {
        const box = el("div", { className: "nz-box" }, lookedUpRow(model));
        for (const result of model.results) {
          box.append(el("article", { className: "nz-entry", "data-hd-role": "entry", "data-hd-entry": String(result.index) },
            wordRow(result), senses(result)));
        }
        ctx.root.replaceChildren(box);
        ctx.reportRendered({ complete: true });
        ctx.requestLayout();
      },
      renderKanji(model) {
        const lines = [el("div", {}, "Currently in individual kanji mode. Press [Back] to cancel.")];
        for (const entry of model.entries) {
          for (const stat of entry.stats) lines.push(el("div", {}, `${stat.name}: ${stat.value}`));
          lines.push(el("div", {}, `On'yomi: ${entry.onyomi.join("、")}`), el("div", {}, `Kun'yomi: ${entry.kunyomi.join("、")}`));
        }
        const back = el("button", { type: "button", className: "nz-back", "data-hd-role": "back" }, "[k]");
        ctx.on(back, "click", () => actions.back());
        ctx.root.replaceChildren(el("div", { className: "nz-box nz-kanji", "data-hd-role": "entry", "data-hd-entry": "0" }, back, ...lines));
        ctx.reportRendered({ complete: true });
        ctx.requestLayout();
      },
      renderState(state) {
        const box = el("div", { className: "nz-box nz-state" }, state.message);
        if (state.retryable) {
          const retry = el("button", { type: "button" }, "Try again");
          ctx.on(retry, "click", () => actions.retry());
          box.append(retry);
        }
        ctx.root.replaceChildren(box);
        ctx.reportRendered({ complete: true });
      },
      update(event) {
        if (event.type === "options" || event.type === "env") ctx.requestLayout();
      },
      destroy() {
        // Nothing to undo: ctx.on listeners and ctx.schedule callbacks are released by the host.
      },
    };
  },
});
