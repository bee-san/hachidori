// SPDX-License-Identifier: GPL-3.0-or-later
(() => {
  const events = [];
  const ids = new WeakMap();
  let nextId = 0, active = null, observer = null;
  const identity = value => {
    if (!value) return null;
    if (!ids.has(value)) ids.set(value, ++nextId);
    return ids.get(value);
  };
  const state = () => levels.map(level => {
    const popup = level.popup;
    const expressions = [...(popup?.querySelectorAll('.gsm-hoshidicts-expression') ?? [])].map(node => {
      const clone = node.cloneNode(true);
      for (const ruby of clone.querySelectorAll('rt, rp')) ruby.remove();
      return clone.textContent.trim();
    });
    return { depth: level.depth, popup: identity(popup), view: identity(level.view),
      connected: popup?.isConnected === true, hidden: popup?.hidden !== false, expressions,
      more: Boolean(popup?.querySelector('.gsm-hoshidicts-show-more')),
      text: popup?.textContent ?? '', nodes: popup?.querySelectorAll('*').length ?? 0 };
  });
  const sample = kind => {
    if (!active?.start) return;
    const sampleStart = performance.now();
    const snapshot = state(), now = performance.now();
    const signature = JSON.stringify(snapshot);
    if (signature !== active.lastSignature) {
      active.states.push({ at: now, kind, levels: snapshot });
      active.lastSignature = signature;
    }
    const current = snapshot[active.depth];
    const reply = active.replies.at(-1);
    const correct = active.rendered && reply && current && !current.hidden && current.connected
      && current.expressions[0] === active.expected;
    if (correct && kind === 'frame' && active.first === null) active.first = now;
    if (correct && !current.more && JSON.stringify(current.expressions)
        === JSON.stringify(reply.results.map(result => result.term.expression))) {
      if (signature === active.completeSignature) active.stableFrames += kind === 'frame' ? 1 : 0;
      else { active.completeSignature = signature; active.stableFrames = 0; }
      if (active.stableFrames >= 2 && active.complete === null) active.complete = now;
    }
    active.probeMs += performance.now() - sampleStart;
  };
  const originalBuild = buildLevelUi;
  buildLevelUi = level => {
    originalBuild(level);
    events.push({ at: performance.now(), kind: 'create', depth: level.depth,
      popup: identity(level.popup), view: identity(level.view) });
    const originalRender = level.view.renderResults;
    level.view.renderResults = (...args) => {
      const result = originalRender(...args);
      if (active?.depth === level.depth) active.rendered = true;
      return result;
    };
    observer ??= new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node.matches?.('.gsm-hoshidicts-popup')) {
            events.push({ at: performance.now(), kind: 'remove', popup: identity(node) });
          }
        }
      }
      sample('mutation');
    });
    observer.observe(shadow, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  const originalSend = sendRequest;
  sendRequest = async (type, fields, ...rest) => {
    const owner = active;
    const sent = performance.now();
    const reply = await originalSend(type, fields, ...rest);
    if (type === 'hd_lookup') {
      const received = performance.now();
      if (owner?.delay) await new Promise(resolve => setTimeout(resolve, owner.delay));
      const record = { query: fields.text, sent, received, delivered: performance.now(),
        count: reply.results?.length ?? 0, results: reply.results };
      owner?.replies.push(record);
      events.push({ kind: 'reply', ...record });
    }
    return reply;
  };
  document.addEventListener('mousemove', () => {
    if (active && active.start === null) { active.start = performance.now(); sample('input'); }
  }, true);
  const longTasks = [];
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    new PerformanceObserver(list => longTasks.push(...list.getEntries().map(({ startTime, duration }) =>
      ({ startTime, duration })))).observe({ type: 'longtask', buffered: true });
  }
  const frame = () => { sample('frame'); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  globalThis.__hoverProbe = {
    arm(expected, depth = 0, delay = 0) {
      active = { expected, depth, delay, start: null, first: null, complete: null,
        states: [], replies: [], rendered: false, probeMs: 0, stableFrames: 0, before: state(), eventStart: events.length };
    },
    read() { return { ...active, now: performance.now(), events: events.slice(active?.eventStart), longTasks }; },
    state,
    events: () => events,
    point(query, depth = 0) {
      const popup = levels[depth].popup;
      const walker = document.createTreeWalker(popup.querySelector('.gsm-hoshidicts-definitions'), NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const offset = walker.currentNode.textContent.indexOf(query);
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(walker.currentNode, offset); range.setEnd(walker.currentNode, offset + 1);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width * .2, y: box.y + box.height / 2 };
      }
      return null;
    }
  };
})();
