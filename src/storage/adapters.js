/**
 * Storage adapters.
 *
 * Every adapter implements the same tiny async key/value contract:
 *
 *   init()            -> Promise<void>   (throws if unusable)
 *   get(key)          -> Promise<any|null>
 *   set(key, value)   -> Promise<void>
 *   remove(key)       -> Promise<void>
 *   keys()            -> Promise<string[]>
 *
 * The contract is deliberately async and id-addressed so a future
 * CloudAdapter (fetch -> API -> Postgres) can drop in without the UI or the
 * domain layer changing. See docs/CLOUD-STORAGE-PLAN.md.
 */

const DB_NAME = 'food-bill-splitter';
const DB_VERSION = 1;
const STORE = 'state';

/** IndexedDB: structured clone, tens of MB, survives receipt thumbnails. */
export function createIndexedDbAdapter() {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    return dbPromise;
  }

  function tx(mode, run) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE, mode);
          const store = transaction.objectStore(STORE);
          let result;
          try {
            result = run(store);
          } catch (error) {
            reject(error);
            return;
          }
          transaction.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
          transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
          transaction.onabort = () => reject(transaction.error || new Error('IndexedDB aborted'));
        }),
    );
  }

  return {
    name: 'indexeddb',
    async init() {
      await open();
    },
    async get(key) {
      const value = await tx('readonly', (store) => store.get(key));
      return value === undefined ? null : value;
    },
    async set(key, value) {
      await tx('readwrite', (store) => store.put(value, key));
    },
    async remove(key) {
      await tx('readwrite', (store) => store.delete(key));
    },
    async keys() {
      const value = await tx('readonly', (store) => store.getAllKeys());
      return Array.isArray(value) ? value.map(String) : [];
    },
  };
}

/** localStorage: ~5 MB of strings. Fallback when IndexedDB is blocked. */
export function createLocalStorageAdapter(prefix = 'fbs:') {
  function store() {
    if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
    return localStorage;
  }
  return {
    name: 'localstorage',
    async init() {
      const probe = `${prefix}__probe__`;
      store().setItem(probe, '1');
      store().removeItem(probe);
    },
    async get(key) {
      const raw = store().getItem(prefix + key);
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw; // normalizeStoredState() deals with the mess
      }
    },
    async set(key, value) {
      store().setItem(prefix + key, JSON.stringify(value));
    },
    async remove(key) {
      store().removeItem(prefix + key);
    },
    async keys() {
      const out = [];
      const s = store();
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
      return out;
    },
  };
}

/** Last resort: in-memory. The app keeps working, it just won't survive a reload. */
export function createMemoryAdapter() {
  const map = new Map();
  return {
    name: 'memory',
    async init() {},
    async get(key) {
      return map.has(key) ? structuredCloneSafe(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, structuredCloneSafe(value));
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}

function structuredCloneSafe(value) {
  try {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/**
 * Pick the best storage this browser will actually let us use.
 * Order: IndexedDB (roomy, holds the receipt image) -> localStorage -> memory.
 */
export async function createBestAdapter(candidates) {
  const list = candidates || [createIndexedDbAdapter(), createLocalStorageAdapter(), createMemoryAdapter()];
  const failures = [];
  for (const adapter of list) {
    try {
      await adapter.init();
      return { adapter, failures };
    } catch (error) {
      failures.push({ name: adapter.name, error });
    }
  }
  const memory = createMemoryAdapter();
  await memory.init();
  return { adapter: memory, failures };
}
