// SPDX-License-Identifier: GPL-3.0-or-later
//
// The part of IndexedDB the search history uses (extension/search-history.js),
// for the Node tests: databases of object stores with an in-line
// auto-increment key, add, put, get, count, clear, getAll and delete over key
// ranges, and cursors in either direction that continue or advance over the
// live store. Each request answers on a later turn, a transaction completes
// once no request is waiting, and a database runs one transaction at a time,
// as a browser does for transactions whose stores overlap. The real thing
// runs in the Chrome and Firefox suites.

export const KeyRange = {
  lowerBound: (lower, open = false) => ({ includes: key => (open ? key > lower : key >= lower) }),
  upperBound: (upper, open = false) => ({ includes: key => (open ? key < upper : key <= upper) }),
  only: value => ({ includes: key => key === value }),
};
const inRange = (range, key) => range === null || range === undefined || range.includes(key);
const keyRange = value => (typeof value === "object" && value !== null ? value : KeyRange.only(value));

export function fakeIndexedDB() {
  const databases = new Map();
  const later = callback => setImmediate(callback);
  const request = () => ({ onsuccess: null, onerror: null, result: undefined, error: null });

  function transaction(database) {
    let waiting = 0;
    let complete = false;
    let finish;
    const started = database.tail;
    database.tail = new Promise(resolveFinished => { finish = resolveFinished; });
    const handle = { oncomplete: null, onerror: null, onabort: null, error: null };
    const settle = () => later(() => {
      if (complete || waiting > 0) return;
      complete = true;
      finish();
      handle.oncomplete?.();
    });
    const answer = (pending, result) => {
      waiting += 1;
      void started.then(() => later(() => {
        pending.result = result();
        waiting -= 1;
        pending.onsuccess?.();
        settle();
      }));
      return pending;
    };
    const run = result => answer(request(), result);
    handle.objectStore = (name) => {
      const store = database.stores.get(name);
      const keys = range => [...store.rows.keys()].filter(key => inRange(range, key)).sort((left, right) => left - right);
      const read = key => structuredClone(store.rows.get(key));
      return {
        get: key => run(() => read(key)),
        add: value => run(() => {
          const key = store.next++;
          store.rows.set(key, structuredClone({ ...value, [store.keyPath]: key }));
          return key;
        }),
        put: value => run(() => {
          const key = value[store.keyPath];
          store.rows.set(key, structuredClone(value));
          store.next = Math.max(store.next, key + 1);
          return key;
        }),
        delete: query => run(() => {
          for (const key of keys(keyRange(query))) store.rows.delete(key);
        }),
        clear: () => run(() => { store.rows.clear(); }),
        count: () => run(() => store.rows.size),
        getAll: (range = null, count = undefined) => run(() => keys(range).slice(0, count ?? Infinity).map(read)),
        openCursor(range = null, direction = "next") {
          const pending = request();
          const forward = direction === "next";
          let position = null;
          const move = steps => answer(pending, () => {
            let key = position;
            for (let step = 0; step < steps; step += 1) {
              const candidates = keys(range).filter(each => key === null || (forward ? each > key : each < key));
              key = candidates.length === 0 ? undefined : (forward ? candidates[0] : candidates.at(-1));
              if (key === undefined) break;
            }
            if (key === undefined || key === null) return null;
            position = key;
            return { key, value: read(key), continue: () => { move(1); }, advance: (count) => { move(count); } };
          });
          return move(1);
        },
      };
    };
    settle();
    return handle;
  }

  return {
    databases,
    open(name) {
      const opening = request();
      later(() => {
        const created = !databases.has(name);
        if (created) databases.set(name, { stores: new Map(), tail: Promise.resolve() });
        const database = databases.get(name);
        opening.result = {
          createObjectStore(store, { keyPath = "id" } = {}) {
            database.stores.set(store, { rows: new Map(), next: 1, keyPath });
          },
          transaction: () => transaction(database),
          close() {},
        };
        if (created) opening.onupgradeneeded?.();
        opening.onsuccess?.();
      });
      return opening;
    },
  };
}
