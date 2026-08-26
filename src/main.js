// Bootstrap: load whatever was saved, build the store, mount the UI, then keep
// storage in sync with every change.

import { createStore } from './state/store.js';
import { createBillRepository } from './storage/repository.js';
import { createApp } from './ui/app.js';
import { toast } from './ui/components.js';

const seenStorageErrors = new Set();

async function boot() {
  const root = document.getElementById('app');
  const splash = document.getElementById('splash');

  const repo = createBillRepository({
    onError: (error) => {
      // Never show the same storage problem twice, and never show a stack trace.
      if (seenStorageErrors.has(error.code)) return;
      seenStorageErrors.add(error.code);
      toast(error.message, { tone: 'warn', duration: 6000 });
      if (error.error) console.warn('[storage]', error.code, error.error);
    },
  });

  let restored = null;
  try {
    restored = await repo.load();
  } catch (error) {
    console.warn('[storage] load failed', error);
  }

  const [settings, roster, archived] = await Promise.all([
    repo.loadSettings(),
    repo.loadRoster(),
    repo.listArchived(),
  ]);

  const store = createStore({
    bill: restored?.bill,
    ui: restored?.ui,
    session: { roster, archivedCount: archived.length },
  });
  const app = createApp({ root, store, repo, settings });

  splash?.remove();
  root.hidden = false;

  if (restored?.recovered) {
    toast('Some saved data was damaged, so we repaired what we could.', { tone: 'warn', duration: 6000 });
  } else if (restored?.bill?.items?.length || restored?.bill?.people?.length) {
    toast('Picked up where you left off.', { duration: 2500 });
  }

  // Persist on every change (debounced inside the repository).
  store.subscribe((state) => repo.save(state));

  // Make sure the last keystroke is written before the tab goes away.
  const flush = () => repo.flush();
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // Handy in the console and for the smoke tests.
  window.__billApp = { store, repo, app };
}

boot().catch((error) => {
  console.error(error);
  const root = document.getElementById('app');
  if (root) {
    root.hidden = false;
    root.innerHTML = `<div class="fatal">
      <h1>Something went wrong</h1>
      <p>We couldn’t start the app. Reloading the page usually fixes it.</p>
      <button class="btn btn--primary" onclick="location.reload()">Reload</button>
    </div>`;
  }
  document.getElementById('splash')?.remove();
});
