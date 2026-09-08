// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiMaturitySource, ankiMaturityWordKey } from "./anki-maturity.js";

export const ANKI_MATURITY_CACHE_KEY = "ankiMaturityCache";
export const ANKI_MATURITY_ALARM = "hachidori-anki-maturity";
export const ANKI_MATURITY_REFRESH_MS = 30 * 60 * 1000;

function cacheState(value) {
  const state = value?.version === 1 ? value : {};
  const snapshot = state.snapshot;
  const attempt = state.attempt;
  return { version: 1,
    configurationRevision: Number.isInteger(state.configurationRevision) ? state.configurationRevision : 0,
    snapshot: typeof snapshot?.sourceKey === "string" && Number.isFinite(snapshot.refreshedAt)
      && Array.isArray(snapshot.words) && snapshot.words.every(word => typeof word === "string") ? snapshot : null,
    attempt: typeof attempt?.sourceKey === "string" && Number.isFinite(attempt.startedAt) ? attempt : null,
  };
}

async function enabledSource(options) {
  return options.definitionBlurAnkiMature === true ? ankiMaturitySource(options.anki) : null;
}

// Commit this invalidation alongside options, before their onChanged event.
// Otherwise delayed events can discard a new pull or allow an old off/on pull.
export async function ankiMaturityConfigurationChange(previous, next, value) {
  const [before, after] = await Promise.all([enabledSource(previous), enabledSource(next)]);
  if (before?.key === after?.key) return undefined;
  const state = cacheState(value);
  return { ...state, configurationRevision: state.configurationRevision + 1, attempt: null };
}

// The background supplies serialized storage updates. The control queue owns
// scheduling/configuration transitions, but never waits for Anki's full pull.
export function createAnkiMaturityCache({ fetchWords, readOptions, readState, updateState, alarms,
  now = Date.now, reportError = error => console.warn("hachidori: Anki maturity refresh failed:", error) }) {
  let snapshot = null, words = new Set(), active = null;
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
      const nextWords = await fetchWords(source);
      await control(async () => {
        let committed = false;
        const saved = await updateState(async ({ options, state }) => {
          const current = cacheState(state), currentSource = await enabledSource(options);
          if (current.configurationRevision !== token.configurationRevision || currentSource?.key !== source.key
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

    const token = { startedAt: now() };
    let reserved = false;
    await updateState(async ({ options, state: value }) => {
      const current = cacheState(value), currentSource = await enabledSource(options);
      if (currentSource?.key !== source.key) return;
      if (current.attempt?.sourceKey === source.key
          && current.attempt.startedAt + ANKI_MATURITY_REFRESH_MS > now()) return;
      reserved = true;
      token.configurationRevision = current.configurationRevision;
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

  return { reconcile, async has(config, expression) {
    const key = ankiMaturityWordKey(expression);
    if (key === null) return false;
    await hydrate;
    const source = await ankiMaturitySource(config);
    return source !== null && snapshot?.sourceKey === source.key && words.has(key);
  } };
}
