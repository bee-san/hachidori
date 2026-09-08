// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiMaturitySource, ankiMaturityWordKey, fetchAnkiMatureWords } from "./anki-maturity.js";

export const ANKI_MATURITY_CACHE_KEY = "ankiMaturityCache";
export const ANKI_MATURITY_ALARM = "hachidori-anki-maturity";
export const ANKI_MATURITY_REFRESH_MS = 30 * 60 * 1000;

function cacheState(value) {
  const state = value?.version === 1 ? value : {};
  const snapshot = state.snapshot;
  const attempt = state.attempt;
  return { version: 1,
    snapshot: typeof snapshot?.sourceKey === "string" && Number.isFinite(snapshot.refreshedAt)
      && Array.isArray(snapshot.words) && snapshot.words.every(word => typeof word === "string") ? snapshot : null,
    attempt: typeof attempt?.sourceKey === "string" && Number.isFinite(attempt.startedAt) ? attempt : null,
  };
}

async function enabledSource(options) {
  return options.definitionBlurAnkiMature === true ? ankiMaturitySource(options.anki) : null;
}

// The background supplies serialized storage updates. The control queue owns
// scheduling/configuration transitions, but never waits for Anki's full pull.
export function createAnkiMaturityCache({ gateway, readOptions, readState, updateState, alarms,
  now = Date.now, reportError = error => console.warn("hachidori: Anki maturity refresh failed:", error) }) {
  let snapshot = null, words = new Set(), epoch = 0, active = null;
  let controlTail = Promise.resolve();
  const hydrate = readState().then(value => {
    snapshot = cacheState(value).snapshot;
    words = new Set(snapshot?.words);
  }).catch(reportError);

  function control(job) {
    const run = controlTail.then(job);
    controlTail = run.catch(() => {});
    return run;
  }

  async function schedule(when) {
    const existing = await alarms.get(ANKI_MATURITY_ALARM);
    if (when === null) {
      if (existing) await alarms.clear(ANKI_MATURITY_ALARM);
    } else if (!existing || existing.scheduledTime !== when || existing.periodInMinutes !== undefined) {
      await alarms.create(ANKI_MATURITY_ALARM, { when });
    }
  }

  async function pull(source, token) {
    try {
      const nextWords = await fetchAnkiMatureWords(gateway, source);
      await control(async () => {
        if (token.epoch !== epoch) return;
        let committed = false;
        const saved = await updateState(async ({ options, state }) => {
          const current = cacheState(state), currentSource = await enabledSource(options);
          if (token.epoch !== epoch || currentSource?.key !== source.key
              || current.attempt?.sourceKey !== source.key || current.attempt.startedAt !== token.startedAt) return;
          committed = true;
          return { ...current, snapshot: { sourceKey: source.key, refreshedAt: now(), words: nextWords } };
        });
        if (committed) {
          snapshot = saved.snapshot;
          words = new Set(snapshot.words);
        }
      });
    } catch (error) {
      reportError(error);
    } finally {
      await control(() => { if (active?.token === token) active = null; });
      // A configuration change during the pull may need its own first snapshot.
      void reconcile();
    }
  }

  async function startDueRefresh() {
    await hydrate;
    const source = await enabledSource(await readOptions());
    if (!source) { await schedule(null); return null; }
    if (active) return { promise: active.promise };
    const state = cacheState(await readState());
    const due = state.attempt?.sourceKey === source.key
      ? state.attempt.startedAt + ANKI_MATURITY_REFRESH_MS : now();
    if (due > now()) { await schedule(due); return null; }

    const token = { epoch, startedAt: now() };
    let reserved = false;
    await updateState(async ({ options, state: value }) => {
      const current = cacheState(value), currentSource = await enabledSource(options);
      if (token.epoch !== epoch || currentSource?.key !== source.key) return;
      if (current.attempt?.sourceKey === source.key
          && current.attempt.startedAt + ANKI_MATURITY_REFRESH_MS > now()) return;
      reserved = true;
      return { ...current, attempt: { sourceKey: source.key, startedAt: token.startedAt } };
    });
    if (!reserved) return null;
    // Record the attempt and next alarm before I/O so worker termination or
    // unavailable Anki cannot cause a fresh full pull on every subsequent visit.
    await schedule(token.startedAt + ANKI_MATURITY_REFRESH_MS);
    const promise = pull(source, token);
    active = { token, promise };
    return { promise };
  }

  function reconcile() {
    return control(startDueRefresh).then(job => job?.promise).catch(reportError);
  }

  function optionsChanged(previous, next) {
    return control(async () => {
      const [before, after] = await Promise.all([enabledSource(previous), enabledSource(next)]);
      if (before?.key === after?.key) return false;
      epoch++;
      await updateState(({ state }) => ({ ...cacheState(state), attempt: null }));
      return true;
    }).then(changed => changed ? reconcile() : undefined).catch(reportError);
  }

  return { reconcile, optionsChanged, async has(config, expression) {
    const key = ankiMaturityWordKey(expression);
    if (key === null) return false;
    await hydrate;
    const source = await ankiMaturitySource(config);
    return source !== null && snapshot?.sourceKey === source.key && words.has(key);
  } };
}
