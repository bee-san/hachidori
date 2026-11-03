// SPDX-License-Identifier: GPL-3.0-or-later
//
// Texthooker view for Hachidori's search page (docs/search-history.md).
//
// Turns the search page into a texthooker: the lines it keeps, newest at the
// bottom, scrolling along as they arrive, with the number of lines and of
// Japanese characters, their times when you want them, a pause for the
// Clipboard monitor, and an Edit and a Delete button on each line. Hover a
// word with Hachidori's activation key to look it up as on any page, or click
// it. The results show beside the lines, in the search page's results area.
//
// Install: paste this whole file into Settings → Design → Custom JavaScript,
// and let Hachidori run user scripts (Chrome: Allow User Scripts on the
// extension's details page; Firefox: Settings asks). Open the search page and
// switch on its Clipboard monitor; a program that copies each new line, such
// as Textractor with its clipboard extension, then fills the list.
//
// It uses only HDSearchHistory, the search page's public history API, and
// does nothing on other pages, where Custom JavaScript runs too. Inspired by
// texthooker-ui (https://github.com/Renji-XD/texthooker-ui, MIT, Copyright (c)
// 2023 Renji-xD); no code is taken from it. It has no websocket client, as
// texthooker-ui has for Textractor's and mpv's plugins: the lines come from the
// search page's history, which the Clipboard monitor fills with what those
// programs copy, and the search page opens no connection of its own.
(function () {
  "use strict";
  const history = globalThis.HDSearchHistory;
  if (!history || document.getElementById("hd-texthooker")) return;

  // Han, Hiragana and Katakana that are not punctuation or symbols, as the
  // search page's cursor stops on them.
  const JAPANESE = /(?=[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])[^\p{P}\p{S}]/gu;
  const characters = text => text.match(JAPANESE)?.length ?? 0;
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const style = document.createElement("style");
  style.textContent = `
    #hd-texthooker { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
    body.search-page:has(#hd-texthooker) .search-results { flex: 1 1 0; }
    #hd-texthooker .hd-th-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
      color: var(--text-dim); font-size: var(--font-caption); }
    #hd-texthooker .hd-th-bar label { display: inline-flex; align-items: center; gap: 4px; }
    #hd-texthooker .hd-th-stats { margin-right: auto; }
    #hd-texthooker ol { flex: 1 1 auto; min-height: 0; margin: 0; padding: 4px 0; overflow-y: auto; list-style: none;
      border: 1px solid var(--border); border-radius: var(--radius-surface); background: var(--surface); }
    #hd-texthooker li { display: flex; align-items: baseline; gap: 8px; padding: 4px 10px; }
    #hd-texthooker li + li { border-top: 1px solid var(--border); }
    #hd-texthooker time { display: none; flex: none; color: var(--text-dim); font-size: var(--font-caption);
      font-variant-numeric: tabular-nums; }
    #hd-texthooker.hd-th-times time { display: inline; }
    #hd-texthooker .hd-th-text { flex: 1; margin: 0; font-size: 20px; line-height: 1.6; white-space: pre-wrap;
      overflow-wrap: anywhere; cursor: text; }
    #hd-texthooker .hd-th-text[contenteditable] { outline: 2px solid var(--accent); outline-offset: 2px; cursor: auto; }
    #hd-texthooker .hd-th-actions { flex: none; display: flex; gap: 4px; visibility: hidden; }
    #hd-texthooker li:is(:hover, :focus-within) .hd-th-actions { visibility: visible; }
    #hd-texthooker .hd-th-actions button, #hd-texthooker .hd-th-bar button { min-height: 28px; padding: 2px 8px; }
  `;
  document.head.append(style);

  const panel = document.createElement("section");
  panel.id = "hd-texthooker";
  panel.setAttribute("aria-label", "Texthooker");
  const bar = document.createElement("div");
  bar.className = "hd-th-bar";
  const stats = document.createElement("span");
  stats.className = "hd-th-stats";
  const timesLabel = document.createElement("label");
  const times = document.createElement("input");
  times.type = "checkbox";
  timesLabel.append(times, "Times");
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "ghost hd-th-pause";
  bar.append(stats, timesLabel, pause);
  const list = document.createElement("ol");
  list.setAttribute("aria-label", "Kept lines");
  panel.append(bar, list);
  document.getElementById("search-results").before(panel);

  const items = new Map();
  function renderStats() {
    let count = 0;
    for (const { line } of items.values()) count += characters(line.text);
    stats.textContent = `${items.size} ${items.size === 1 ? "line" : "lines"} · ${count} characters`;
  }
  function renderPause() {
    pause.textContent = history.clipboardPaused ? "Resume clipboard" : "Pause clipboard";
    pause.setAttribute("aria-pressed", String(history.clipboardPaused));
  }

  // One line: its time, its text, and its Edit and Delete buttons. A line
  // break after each item ends a lookup there, so a word never runs on into
  // the next line.
  function item(line) {
    const entry = document.createElement("li");
    const stamp = document.createElement("time");
    const text = document.createElement("p");
    text.className = "hd-th-text";
    text.lang = "ja";
    const actions = document.createElement("span");
    actions.className = "hd-th-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ghost";
    edit.textContent = "Edit";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Delete";
    actions.append(edit, remove);
    entry.append(stamp, text, actions);
    const kept = { entry, stamp, text, line };
    edit.addEventListener("click", () => startEdit(kept));
    text.addEventListener("dblclick", () => startEdit(kept));
    remove.addEventListener("click", () => { history.remove(line.id).catch(failed); });
    text.addEventListener("click", event => lookUpAt(kept, event));
    show(kept, line);
    return kept;
  }

  function show(kept, line) {
    kept.line = line;
    kept.entry.dataset.id = String(line.id);
    kept.stamp.dateTime = new Date(line.at).toISOString();
    kept.stamp.textContent = time.format(line.at);
    kept.text.textContent = line.text;
    kept.entry.querySelector("button").setAttribute("aria-label", `Edit: ${line.text}`);
    kept.entry.querySelector("button:last-child").setAttribute("aria-label", `Delete: ${line.text}`);
  }

  // Lines stay in the order they were kept, newest at the bottom, whichever
  // arrives first: the list read at the start or a line kept meanwhile. While
  // the list is scrolled to its end it stays there, as lines arrive and as the
  // page around it changes size (the searched text appears after a search).
  // Only the reader's own scrolling unpins it: a scroll event for the position
  // follow() set can arrive after the list has shrunk, when it no longer looks
  // like the end.
  let pinned = true;
  let followed = null;
  const follow = () => {
    if (!pinned) return;
    list.scrollTop = list.scrollHeight;
    followed = list.scrollTop;
  };
  list.addEventListener("scroll", () => {
    if (list.scrollTop !== followed) pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  });
  new ResizeObserver(follow).observe(list);
  function add(line, newest) {
    if (items.has(line.id)) return;
    const kept = item(line);
    const later = [...items.values()].find(other => other.line.id > line.id);
    items.set(line.id, kept);
    if (later) later.entry.before(kept.entry, "\n");
    else list.append(kept.entry, "\n");
    if (newest) follow();
  }

  function drop(id) {
    const kept = items.get(id);
    if (!kept) return;
    kept.entry.nextSibling?.remove();
    kept.entry.remove();
    items.delete(id);
  }

  const failed = (error) => { console.warn("texthooker: the search history refused the change:", error); };

  // Editing: Enter or leaving the line saves it, Escape gives up, and a line
  // left empty is deleted.
  function startEdit(kept) {
    if (kept.text.isContentEditable) return;
    const editing = new AbortController();
    kept.text.contentEditable = "plaintext-only";
    kept.text.focus();
    getSelection().selectAllChildren(kept.text);
    const finish = (save) => {
      editing.abort();
      kept.text.removeAttribute("contenteditable");
      const edited = kept.text.textContent.trim();
      kept.text.textContent = kept.line.text;
      if (!save || edited === kept.line.text) return;
      (edited ? history.edit(kept.line.id, edited) : history.remove(kept.line.id)).catch(failed);
    };
    kept.text.addEventListener("keydown", (event) => {
      if (event.isComposing || !["Enter", "Escape"].includes(event.key) || event.shiftKey) return;
      event.preventDefault();
      finish(event.key === "Enter");
      kept.text.blur();
    }, { signal: editing.signal });
    kept.text.addEventListener("blur", () => finish(true), { signal: editing.signal });
  }

  // A click on a word looks it up, unless it ends a selection or an edit.
  function lookUpAt(kept, { clientX, clientY }) {
    if (kept.text.isContentEditable || getSelection()?.isCollapsed === false) return;
    const caret = document.caretPositionFromPoint?.(clientX, clientY);
    const range = caret ? null : document.caretRangeFromPoint?.(clientX, clientY);
    const node = caret?.offsetNode ?? range?.startContainer;
    if (node?.nodeType !== Node.TEXT_NODE || !kept.text.contains(node) || node.length === 0) return;
    // The caret falls between two characters: a click on a glyph's right
    // half reports the one after it.
    let at = Math.min(caret?.offset ?? range.startOffset, node.length - 1);
    const glyph = document.createRange();
    glyph.setStart(node, at);
    glyph.setEnd(node, at + 1);
    if (at > 0 && glyph.getBoundingClientRect().left > clientX) at -= 1;
    void history.lookUp(node, at);
  }

  times.addEventListener("change", () => { panel.classList.toggle("hd-th-times", times.checked); });
  pause.addEventListener("click", () => {
    history.clipboardPaused = !history.clipboardPaused;
    renderPause();
  });
  history.addEventListener("line", (event) => {
    add(event.detail, true);
    renderStats();
  });
  history.addEventListener("change", ({ detail: change }) => {
    if (change.type === "edit") {
      const kept = items.get(change.line.id);
      if (kept) show(kept, change.line);
    } else if (change.type === "remove") {
      drop(change.id);
    } else if (change.type === "clear") {
      for (const id of [...items.keys()]) drop(id);
    } else if (change.type === "prune") {
      for (const id of [...items.keys()]) if (id < change.before) drop(id);
    }
    renderStats();
  });

  renderPause();
  renderStats();
  void history.list().then((lines) => {
    for (const line of lines) add(line, false);
    follow();
    renderStats();
  });
}());
