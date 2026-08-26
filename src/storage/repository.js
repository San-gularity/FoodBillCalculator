// The only object the app talks to about persistence.
// Swap the adapter underneath (cloud API, sync engine) and nothing above changes.

import { createBestAdapter } from './adapters.js';
import { STORAGE_KEY, createEnvelope, normalizeStoredState } from './migrate.js';

const HISTORY_KEY = 'bill-history';
const ROSTER_KEY = 'people-roster';
const SETTINGS_KEY = 'settings';
const SAVE_DEBOUNCE_MS = 350;
const MAX_HISTORY = 50;
const MAX_ROSTER = 40;

export function createBillRepository(options = {}) {
  const { onError = () => {}, debounceMs = SAVE_DEBOUNCE_MS } = options;
  let adapter = null;
  let timer = null;
  let pendingState = null;
  let inFlight = Promise.resolve();
  let degraded = false;
  // Bills that also live in the archive: edits to those are mirrored there, so
  // opening a saved bill and changing it actually updates the saved copy.
  let archivedIds = new Set();

  async function ready() {
    if (adapter) return adapter;
    const result = await createBestAdapter(options.adapters);
    adapter = result.adapter;
    degraded = adapter.name === 'memory';
    if (degraded) {
      onError({
        code: 'storage-unavailable',
        message: 'Your browser is blocking storage, so this bill won’t be saved if you close the tab.',
      });
    }
    return adapter;
  }

  async function load() {
    try {
      const store = await ready();
      const raw = await store.get(STORAGE_KEY);
      return normalizeStoredState(raw);
    } catch (error) {
      onError({ code: 'storage-read-failed', message: 'We couldn’t read your saved bill, so we started a fresh one.', error });
      return null;
    }
  }

  async function writeNow(state) {
    try {
      const store = await ready();
      await store.set(STORAGE_KEY, createEnvelope(state));
      if (archivedIds.has(state.bill?.id)) await archive(state.bill, { silent: true });
      return true;
    } catch (error) {
      // Most likely cause: quota exceeded because of a large receipt image.
      const quota = error && /quota|exceed/i.test(String(error.name || error.message));
      onError({
        code: quota ? 'storage-quota' : 'storage-write-failed',
        message: quota
          ? 'Storage is full. We saved the bill without the receipt photo.'
          : 'We couldn’t save your latest change.',
        error,
      });
      if (quota) return writeWithoutImage(state);
      return false;
    }
  }

  async function writeWithoutImage(state) {
    try {
      const store = await ready();
      const slim = {
        ...state,
        bill: { ...state.bill, receipt: state.bill.receipt ? { ...state.bill.receipt, thumbnail: null } : null },
      };
      await store.set(STORAGE_KEY, createEnvelope(slim));
      return true;
    } catch {
      return false;
    }
  }

  function save(state) {
    pendingState = state;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const snapshot = pendingState;
      pendingState = null;
      inFlight = inFlight.then(() => writeNow(snapshot));
    }, debounceMs);
    return inFlight;
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      const snapshot = pendingState;
      pendingState = null;
      if (snapshot) inFlight = inFlight.then(() => writeNow(snapshot));
    }
    return inFlight;
  }

  async function clear() {
    try {
      const store = await ready();
      await store.remove(STORAGE_KEY);
    } catch (error) {
      onError({ code: 'storage-write-failed', message: 'We couldn’t clear the saved bill.', error });
    }
  }

  /** Save (or update) a bill in the archive. Editing a saved bill re-saves it here. */
  async function archive(bill, { silent = false } = {}) {
    if (!bill?.id) return false;
    try {
      const store = await ready();
      const list = await readList(store, HISTORY_KEY);
      const previous = list.find((entry) => entry.id === bill.id);
      const entry = {
        id: bill.id,
        name: bill.name,
        archivedAt: previous?.archivedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // The photo stays out of the archive: it is the bulkiest part by far and
        // the numbers are what people come back for.
        bill: { ...bill, receipt: bill.receipt ? { ...bill.receipt, thumbnail: null } : null },
      };
      await store.set(HISTORY_KEY, [entry, ...list.filter((b) => b.id !== bill.id)].slice(0, MAX_HISTORY));
      archivedIds.add(bill.id);
      return true;
    } catch (error) {
      if (!silent) onError({ code: 'storage-write-failed', message: 'We couldn’t save that bill.', error });
      return false;
    }
  }

  async function listArchived() {
    try {
      const store = await ready();
      const list = await readList(store, HISTORY_KEY);
      archivedIds = new Set(list.map((entry) => entry.id));
      return list;
    } catch {
      return [];
    }
  }

  async function getArchived(id) {
    const list = await listArchived();
    const entry = list.find((item) => item.id === id);
    if (!entry) return null;
    // Run it through the same repair path as anything else off disk.
    const restored = normalizeStoredState({ version: undefined, bill: entry.bill });
    return restored ? { ...entry, bill: restored.bill } : null;
  }

  /** Remove a bill from the archive — and therefore from browser storage. */
  async function deleteArchived(id) {
    try {
      const store = await ready();
      const list = await readList(store, HISTORY_KEY);
      const next = list.filter((entry) => entry.id !== id);
      await store.set(HISTORY_KEY, next);
      archivedIds.delete(id);
      return list.length !== next.length;
    } catch (error) {
      onError({ code: 'storage-write-failed', message: 'We couldn’t delete that bill.', error });
      return false;
    }
  }

  async function clearArchive() {
    try {
      const store = await ready();
      await store.set(HISTORY_KEY, []);
      archivedIds = new Set();
      return true;
    } catch (error) {
      onError({ code: 'storage-write-failed', message: 'We couldn’t clear your saved bills.', error });
      return false;
    }
  }

  // ---- people you split with often ----------------------------------------

  /** Remembered names, most recently used first. */
  async function loadRoster() {
    try {
      const store = await ready();
      const list = await readList(store, ROSTER_KEY);
      return list
        .map((entry) =>
          typeof entry === 'string'
            ? { name: entry, color: null, lastUsedAt: null, uses: 1 }
            : {
                name: String(entry?.name || '').trim().slice(0, 40),
                color: typeof entry?.color === 'string' ? entry.color : null,
                lastUsedAt: typeof entry?.lastUsedAt === 'string' ? entry.lastUsedAt : null,
                uses: Number(entry?.uses) > 0 ? Number(entry.uses) : 1,
                seq: Number(entry?.seq) > 0 ? Number(entry.seq) : 0,
              },
        )
        .filter((entry) => entry.name);
    } catch {
      return [];
    }
  }

  // Adding three people quickly fires three read-modify-write cycles; without
  // this queue the last one wins and the other two names are lost.
  let rosterQueue = Promise.resolve();

  function rememberPeople(people) {
    rosterQueue = rosterQueue.then(() => writeRoster(people)).catch(() => loadRoster());
    return rosterQueue;
  }

  async function writeRoster(people) {
    const incoming = (Array.isArray(people) ? people : [people]).filter((p) => p && p.name);
    if (!incoming.length) return loadRoster();
    try {
      const store = await ready();
      const existing = await loadRoster();
      const byName = new Map(existing.map((entry) => [entry.name.toLowerCase(), entry]));
      const now = new Date().toISOString();
      // A counter, not the clock: several names added in the same millisecond
      // still keep the order they were added in.
      let seq = existing.reduce((max, entry) => Math.max(max, entry.seq || 0), 0);
      for (const person of incoming) {
        const key = person.name.trim().toLowerCase();
        const previous = byName.get(key);
        seq += 1;
        byName.set(key, {
          name: person.name.trim().slice(0, 40),
          color: person.color || previous?.color || null,
          lastUsedAt: now,
          uses: (previous?.uses || 0) + 1,
          seq,
        });
      }
      const next = [...byName.values()]
        .sort((a, b) => (b.seq || 0) - (a.seq || 0) || b.uses - a.uses)
        .slice(0, MAX_ROSTER);
      await store.set(ROSTER_KEY, next);
      return next;
    } catch {
      return loadRoster();
    }
  }

  function forgetPerson(name) {
    rosterQueue = rosterQueue.then(() => removeFromRoster(name)).catch(() => loadRoster());
    return rosterQueue;
  }

  async function removeFromRoster(name) {
    try {
      const store = await ready();
      const list = await loadRoster();
      const next = list.filter((entry) => entry.name.toLowerCase() !== String(name).toLowerCase());
      await store.set(ROSTER_KEY, next);
      return next;
    } catch {
      return loadRoster();
    }
  }

  // ---- settings ------------------------------------------------------------

  async function loadSettings() {
    try {
      const store = await ready();
      const value = await store.get(SETTINGS_KEY);
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  async function saveSettings(settings) {
    try {
      const store = await ready();
      await store.set(SETTINGS_KEY, settings);
      return true;
    } catch (error) {
      onError({ code: 'storage-write-failed', message: 'We couldn’t save that setting.', error });
      return false;
    }
  }

  async function readList(store, key) {
    const value = await store.get(key);
    return Array.isArray(value) ? value : [];
  }

  return {
    load,
    save,
    flush,
    clear,
    archive,
    listArchived,
    getArchived,
    deleteArchived,
    clearArchive,
    loadRoster,
    rememberPeople,
    forgetPerson,
    loadSettings,
    saveSettings,
    get backend() {
      return adapter ? adapter.name : 'pending';
    },
    get isDegraded() {
      return degraded;
    },
  };
}
