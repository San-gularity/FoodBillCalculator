// App shell: header, steps, action bar, and all the event wiring.
// Views are pure functions of state; this file owns the interactions.

import { $, escapeHtml, on, renderInto } from './dom.js';
import { showSheet, toast, confirmSheet } from './components.js';
import { STEPS, itemsView, peopleView, assignView, reviewView, summaryText } from './views.js';
import { openScanner, openTextEntry } from './scanner-view.js';
import { calculateFinalTotals } from '../core/calc.js';
import { formatMoney, parseMoneyInput, centsToInput } from '../core/money.js';
import { itemTotalCents } from '../core/model.js';
import {
  configureGemini,
  getGeminiKey,
  testGeminiConnection,
  MODEL_CHAIN,
  DEFAULT_MODEL,
} from '../scanner/providers/gemini.js';

export function createApp({ root, store, repo, settings = {} }) {
  let scannerSettings = { aiEnabled: true, geminiApiKey: '', ...settings };
  root.innerHTML = shellHtml();
  const viewHost = $('[data-view]', root);
  const headerHost = $('[data-header]', root);
  const navHost = $('[data-steps]', root);
  const barHost = $('[data-actionbar]', root);

  const app = {
    store,
    repo,
    getBill: () => store.getBill(),
    applyReceipt,
    render,
    getScannerSettings: () => scannerSettings,
    openScannerSettings: () => openScannerSettings(),
    refreshRoster,
    refreshArchive,
  };

  async function refreshRoster() {
    const roster = await repo.loadRoster();
    store.setSession({ roster });
  }

  async function refreshArchive() {
    const list = await repo.listArchived();
    store.setSession({ archivedCount: list.length });
    return list;
  }

  function applyScannerSettings(next) {
    scannerSettings = { ...scannerSettings, ...next };
    configureGemini({ apiKey: scannerSettings.geminiApiKey, model: scannerSettings.geminiModel });
    store.setSession({ aiReady: scannerSettings.aiEnabled && Boolean(getGeminiKey()) });
    return repo.saveSettings(scannerSettings);
  }

  function summary() {
    return calculateFinalTotals(store.getBill());
  }

  let lastTotalCents = null;
  let bumpUntil = 0;

  function render() {
    const state = store.getState();
    const totals = summary();
    // Nudge the header total whenever it changes, so it's obvious that edits
    // land immediately rather than at some later "save". One action can cause
    // several renders (an edit plus its assignment), so hold the nudge briefly
    // instead of tying it to a single render.
    if (lastTotalCents !== null && lastTotalCents !== totals.totalCents) bumpUntil = Date.now() + 500;
    lastTotalCents = totals.totalCents;
    const totalChanged = Date.now() < bumpUntil;

    renderInto(headerHost, headerHtml(state, totals, totalChanged));
    renderInto(navHost, stepsHtml(state, totals));
    renderInto(viewHost, viewHtml(state, totals));
    renderInto(barHost, actionBarHtml(state, totals));
    root.dataset.step = state.ui.step;
  }

  function viewHtml(state, totals) {
    switch (state.ui.step) {
      case 'people':
        return peopleView(state, totals);
      case 'assign':
        return assignView(state, totals);
      case 'review':
        return reviewView(state, totals);
      default:
        return itemsView(state, totals);
    }
  }

  function applyReceipt(draft, charges) {
    store.addItems(charges.items, {
      taxCents: charges.taxCents ?? 0,
      extraCents: charges.extraCents ?? 0,
      declaredSubtotalCents: charges.declaredSubtotalCents,
      declaredTotalCents: charges.declaredTotalCents,
      receipt: {
        id: draft.id,
        capturedAt: draft.capturedAt,
        provider: draft.provider,
        photoCount: draft.sourceCount || 1,
        thumbnail: draft.thumbnail || null,
        rawText: draft.rawText || '',
      },
    });
    toast(`Added ${charges.items.length} item${charges.items.length === 1 ? '' : 's'} from the receipt.`, {
      tone: 'success',
      actionLabel: 'Undo',
      onAction: () => store.undo(),
    });
    store.setStep(store.getBill().people.length ? 'assign' : 'people');
  }

  // ---- interactions -------------------------------------------------------

  // Sheets are appended to <body>, so delegation has to start there for menu
  // and dialog actions to reach this switch.
  on(document.body, 'click', '[data-action]', async (event, el) => {
    const action = el.dataset.action;
    const bill = store.getBill();

    switch (action) {
      case 'step':
        store.setStep(el.dataset.step);
        break;
      case 'go-items':
        store.setStep('items');
        break;
      case 'go-people':
        store.setStep('people');
        break;
      case 'go-assign':
        store.setStep('assign');
        break;
      case 'go-review':
        store.setStep('review');
        break;
      case 'scan-receipt':
        openScanner(app);
        break;
      case 'paste-receipt':
        openTextEntry(app);
        break;
      case 'edit-item':
        openItemEditor(el.dataset.id);
        break;
      case 'delete-item': {
        const item = bill.items.find((i) => i.id === el.dataset.id);
        store.removeItem(el.dataset.id);
        toast(`Removed ${item ? item.name : 'item'}.`, { actionLabel: 'Undo', onAction: () => store.undo() });
        break;
      }
      case 'remove-person': {
        const person = bill.people.find((p) => p.id === el.dataset.id);
        store.removePerson(el.dataset.id);
        toast(`Removed ${person ? person.name : 'person'}.`, { actionLabel: 'Undo', onAction: () => store.undo() });
        break;
      }
      case 'rename-person':
        openPersonRename(el.dataset.id);
        break;
      case 'add-me':
        addPerson('Me');
        break;
      case 'toggle-assign':
        store.toggleAssignment(el.dataset.item, el.dataset.person);
        break;
      case 'assign-everyone': {
        const item = bill.items.find((i) => i.id === el.dataset.item);
        if (item && item.assignedTo.length === bill.people.length) store.setAssignment(item.id, []);
        else store.assignEveryone(el.dataset.item);
        break;
      }
      case 'assign-remaining': {
        const touched = store.assignEveryoneToUnassigned();
        toast(
          touched
            ? `Split ${touched} item${touched === 1 ? '' : 's'} across everyone.`
            : 'Every item already has someone on it.',
          { actionLabel: touched ? 'Undo' : undefined, onAction: () => store.undo() },
        );
        break;
      }
      case 'toggle-person':
        store.toggleExpandedPerson(el.dataset.id);
        break;
      case 'set-split-mode':
        store.setSharedChargeSplit(el.dataset.mode);
        break;
      case 'absorb-diff': {
        const diff = summary().differenceCents;
        store.absorbDifferenceAsExtra(diff);
        toast(
          `Added ${formatMoney(Math.abs(diff), summary().currency)} as ${diff > 0 ? 'tip & fees' : 'a discount'} — the totals match the receipt now.`,
          { actionLabel: 'Undo', onAction: () => store.undo() },
        );
        break;
      }
      case 'match-receipt-total': {
        const computed = summary().totalCents;
        store.setDeclared({ totalCents: computed }, { undoable: true, label: 'Receipt total updated' });
        toast(`Receipt total updated to ${formatMoney(computed, summary().currency)}.`, {
          actionLabel: 'Undo',
          onAction: () => store.undo(),
        });
        break;
      }
      case 'copy-summary':
        await copySummary();
        break;
      case 'share-summary':
        await shareSummary();
        break;
      case 'new-bill': {
        const ok = await confirmSheet({
          title: 'Start a new bill?',
          message: 'This bill will be archived and the screen cleared.',
          confirmLabel: 'Start new bill',
          tone: 'primary',
        });
        if (!ok) break;
        const saved = store.getBill().items.length ? await repo.archive(store.getBill()) : false;
        store.newBill(false);
        await refreshArchive();
        toast(saved ? 'Started a new bill. The old one is in Saved bills.' : 'Started a new bill.', {
          actionLabel: 'Undo',
          onAction: () => store.undo(),
        });
        break;
      }
      case 'rename-bill':
        openBillRename();
        break;
      case 'open-menu':
        openMenu();
        break;
      case 'open-archive':
        openArchive();
        break;
      case 'open-scanner-settings':
        openScannerSettings();
        break;
      case 'save-bill': {
        const saved = await repo.archive(store.getBill());
        await refreshArchive();
        toast(saved ? 'Saved to your bills. Changes keep saving as you edit.' : 'We couldn’t save that bill.', {
          tone: saved ? 'success' : 'danger',
        });
        break;
      }
      case 'add-known-person':
        addPerson(el.dataset.name, el.dataset.color ? { color: el.dataset.color } : {});
        break;
      case 'add-all-known': {
        const roster = store.getState().session.roster || [];
        const added = store.addPeople(roster.filter((entry) => !bill.people.some((p) => p.name.toLowerCase() === entry.name.toLowerCase())));
        if (added.length) {
          repo.rememberPeople(added).then((next) => store.setSession({ roster: next }));
          toast(`Added ${added.length} ${added.length === 1 ? 'person' : 'people'}.`, {
            actionLabel: 'Undo',
            onAction: () => added.forEach((person) => store.removePerson(person.id)),
          });
        }
        break;
      }
      case 'forget-person': {
        const roster = await repo.forgetPerson(el.dataset.name);
        store.setSession({ roster });
        toast(`${el.dataset.name} won’t be suggested again.`);
        break;
      }
      case 'undo':
        if (!store.undo()) toast('Nothing to undo.');
        break;
      default:
        break;
    }
  });

  on(document.body, 'submit', 'form[data-action]', (event, form) => {
    event.preventDefault();
    if (form.dataset.action === 'add-item-form') {
      const name = form.elements.name.value.trim();
      const cents = parseMoneyInput(form.elements.price.value);
      if (!name) return;
      if (cents == null) {
        toast('Enter a price like 12.50.', { tone: 'warn' });
        form.elements.price.focus();
        return;
      }
      // Clear before the store re-renders, so the fresh fields come up empty.
      form.reset();
      store.addItem({ name, unitPriceCents: cents });
    }
    if (form.dataset.action === 'add-person-form') {
      const name = form.elements.name.value;
      form.reset();
      addPerson(name);
    }
  });

  // Money fields commit as you type; the store keeps the canonical cents.
  on(document.body, 'input', 'input[data-action]', (event, el) => {
    const action = el.dataset.action;
    if (action === 'set-tax') store.setTax(parseMoneyInput(el.value) ?? 0);
    if (action === 'set-extra') store.setExtra(parseMoneyInput(el.value) ?? 0);
    if (action === 'set-declared-total') store.setDeclared({ totalCents: parseMoneyInput(el.value) });
  });

  function addPerson(name, options = {}) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    const result = store.addPerson(trimmed, options);
    if (result && result.duplicate) {
      toast(`${trimmed} is already on this bill.`, { tone: 'warn' });
      return;
    }
    if (result) repo.rememberPeople([result]).then((roster) => store.setSession({ roster }));
  }

  function openItemEditor(itemId) {
    const bill = store.getBill();
    const item = bill.items.find((i) => i.id === itemId);
    if (!item) return;

    showSheet({
      title: 'Edit item',
      render: () => `
        <div class="stack">
          <label class="field">
            <span class="field__label">Item</span>
            <span class="field__input"><input data-edit="name" value="${escapeHtml(item.name)}" data-autofocus aria-label="Item name"></span>
          </label>
          <div class="field-grid field-grid--2">
            <label class="field">
              <span class="field__label">Quantity</span>
              <span class="field__input"><input type="number" min="1" step="1" data-edit="qty" value="${escapeHtml(item.quantity)}" aria-label="Quantity"></span>
            </label>
            <label class="field">
              <span class="field__label">Line total</span>
              <span class="field__input"><span class="field__prefix">$</span>
                <input inputmode="decimal" data-edit="price" value="${escapeHtml(centsToInput(itemTotalCents(item)))}" aria-label="Line total"></span>
            </label>
          </div>
          ${
            bill.people.length
              ? `<div class="field">
                   <span class="field__label">Shared by</span>
                   <div class="chip-row">
                     ${bill.people
                       .map(
                         (person) => `
                       <button type="button" class="chip chip--toggle${item.assignedTo.includes(person.id) ? ' is-on' : ''}"
                         style="--chip-color:${escapeHtml(person.color)}" data-edit-person="${escapeHtml(person.id)}"
                         role="checkbox" aria-checked="${item.assignedTo.includes(person.id)}">
                         <span class="chip__label">${escapeHtml(person.name)}</span></button>`,
                       )
                       .join('')}
                   </div>
                 </div>`
              : ''
          }
          <div class="sheet__actions sheet__actions--split">
            <button class="btn btn--danger-ghost" data-edit-delete>Delete</button>
            <button class="btn btn--primary" data-edit-save>Save</button>
          </div>
        </div>`,
      onMount: (sheetRoot, close) => {
        const selected = new Set(item.assignedTo);
        sheetRoot.querySelectorAll('[data-edit-person]').forEach((button) => {
          button.addEventListener('click', () => {
            const id = button.dataset.editPerson;
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
            button.classList.toggle('is-on', selected.has(id));
            button.setAttribute('aria-checked', String(selected.has(id)));
          });
        });
        sheetRoot.querySelector('[data-edit-save]').addEventListener('click', () => {
          const name = sheetRoot.querySelector('[data-edit="name"]').value.trim();
          const qty = Number(sheetRoot.querySelector('[data-edit="qty"]').value) || 1;
          const cents = parseMoneyInput(sheetRoot.querySelector('[data-edit="price"]').value);
          if (!name) {
            toast('Give the item a name.', { tone: 'warn' });
            return;
          }
          if (cents == null) {
            toast('Enter a price like 12.50.', { tone: 'warn' });
            return;
          }
          store.updateItem(item.id, {
            name,
            quantity: qty,
            totalPriceCents: cents,
            unitPriceCents: Math.round(cents / qty),
          });
          store.setAssignment(item.id, [...selected]);
          close();
        });
        sheetRoot.querySelector('[data-edit-delete]').addEventListener('click', () => {
          store.removeItem(item.id);
          close();
          toast(`Removed ${item.name}.`, { actionLabel: 'Undo', onAction: () => store.undo() });
        });
      },
    });
  }

  function openPersonRename(personId) {
    const person = store.getBill().people.find((p) => p.id === personId);
    if (!person) return;
    showSheet({
      title: 'Rename person',
      size: 'sm',
      render: () => `
        <label class="field">
          <span class="field__label">Name</span>
          <span class="field__input"><input data-rename value="${escapeHtml(person.name)}" data-autofocus maxlength="40" aria-label="Name"></span>
        </label>
        <div class="sheet__actions">
          <button class="btn btn--ghost" data-sheet-close>Cancel</button>
          <button class="btn btn--primary" data-rename-save>Save</button>
        </div>`,
      onMount: (sheetRoot, close) => {
        const input = sheetRoot.querySelector('[data-rename]');
        const save = () => {
          store.renamePerson(person.id, input.value);
          close();
        };
        sheetRoot.querySelector('[data-rename-save]').addEventListener('click', save);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') save();
        });
      },
    });
  }

  function openBillRename() {
    const bill = store.getBill();
    showSheet({
      title: 'Rename bill',
      size: 'sm',
      render: () => `
        <label class="field">
          <span class="field__label">Bill name</span>
          <span class="field__input"><input data-rename value="${escapeHtml(bill.name)}" data-autofocus maxlength="60" aria-label="Bill name"></span>
        </label>
        <div class="sheet__actions">
          <button class="btn btn--ghost" data-sheet-close>Cancel</button>
          <button class="btn btn--primary" data-rename-save>Save</button>
        </div>`,
      onMount: (sheetRoot, close) => {
        const input = sheetRoot.querySelector('[data-rename]');
        const save = () => {
          store.renameBill(input.value);
          close();
        };
        sheetRoot.querySelector('[data-rename-save]').addEventListener('click', save);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') save();
        });
      },
    });
  }

  // ---- menu, saved bills, scanner settings --------------------------------

  function openMenu() {
    const session = store.getState().session;
    showSheet({
      title: 'Bill menu',
      size: 'sm',
      render: () => `
        <div class="menu-list">
          <button class="menu-item" data-action="open-archive" data-autofocus>
            <span class="menu-item__icon" aria-hidden="true">📁</span>
            <span><strong>Saved bills</strong><small>${session.archivedCount || 0} saved · open, edit or delete</small></span>
          </button>
          <button class="menu-item" data-action="save-bill">
            <span class="menu-item__icon" aria-hidden="true">💾</span>
            <span><strong>Save this bill</strong><small>Keep it in your saved bills</small></span>
          </button>
          <button class="menu-item" data-action="rename-bill">
            <span class="menu-item__icon" aria-hidden="true">✎</span>
            <span><strong>Rename bill</strong><small>${escapeHtml(store.getBill().name)}</small></span>
          </button>
          <button class="menu-item" data-action="new-bill">
            <span class="menu-item__icon" aria-hidden="true">✨</span>
            <span><strong>Start a new bill</strong><small>Saves this one first</small></span>
          </button>
          <button class="menu-item" data-action="open-scanner-settings">
            <span class="menu-item__icon" aria-hidden="true">🤖</span>
            <span><strong>Receipt scanning</strong><small>${
              session.aiReady ? 'AI reader is on' : 'Using the on-device reader'
            }</small></span>
          </button>
        </div>`,
      onMount: (sheetRoot, close) => {
        // The actions themselves are handled by the app-level delegate.
        sheetRoot.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => close()));
      },
    });
  }

  async function openArchive() {
    const list = await refreshArchive();
    const currentId = store.getBill().id;

    const handle = showSheet({
      title: 'Saved bills',
      render: () => (list.length ? archiveListHtml(list, currentId) : emptyArchiveHtml()),
      onMount: (sheetRoot, close) => {
        on(sheetRoot, 'click', '[data-open-bill]', async (event, el) => {
          const entry = await repo.getArchived(el.dataset.openBill);
          if (!entry) {
            toast('That bill is no longer saved.', { tone: 'warn' });
            return;
          }
          const current = store.getBill();
          // Only a bill with items is worth keeping; a stray name list isn't.
          if (current.id !== entry.id && current.items.length) await repo.archive(current);
          store.loadBill(entry.bill);
          await refreshArchive();
          close();
          toast(`Opened “${entry.bill.name}”. Edits save automatically.`, { tone: 'success' });
        });

        on(sheetRoot, 'click', '[data-delete-bill]', async (event, el) => {
          const id = el.dataset.deleteBill;
          const entry = list.find((item) => item.id === id);
          const ok = await confirmSheet({
            title: 'Delete this bill?',
            message: `“${entry?.name || 'This bill'}” will be removed from this browser for good.`,
            confirmLabel: 'Delete',
          });
          if (!ok) return;
          await repo.deleteArchived(id);
          if (id === store.getBill().id) {
            // It is still open on screen; make sure edits don't re-save it.
            store.renameBill(store.getBill().name);
          }
          const next = await refreshArchive();
          list.length = 0;
          list.push(...next);
          handle.body.innerHTML = next.length ? archiveListHtml(next, store.getBill().id) : emptyArchiveHtml();
          toast('Bill deleted.');
        });

        on(sheetRoot, 'click', '[data-clear-archive]', async () => {
          const ok = await confirmSheet({
            title: 'Delete all saved bills?',
            message: `All ${list.length} saved bills will be removed from this browser.`,
            confirmLabel: 'Delete all',
          });
          if (!ok) return;
          await repo.clearArchive();
          await refreshArchive();
          list.length = 0;
          handle.body.innerHTML = emptyArchiveHtml();
          toast('Saved bills cleared.');
        });
      },
    });
  }

  function openScannerSettings() {
    const configuredElsewhere = !scannerSettings.geminiApiKey && Boolean(getGeminiKey());
    showSheet({
      title: 'Receipt scanning',
      render: () => `
        <div class="stack">
          <div class="notice ${store.getState().session.aiReady ? 'notice--ok' : 'notice--info'}">
            <p><strong>${
              store.getState().session.aiReady ? 'AI reader is on.' : 'Using the on-device reader.'
            }</strong>
            ${
              store.getState().session.aiReady
                ? 'Receipts are read by Gemini, which is much better at ignoring order numbers and odd layouts.'
                : 'It works offline, but it can misread cramped receipts. Add a Gemini key for better results.'
            }</p>
          </div>

          <label class="field">
            <span class="field__label">Gemini API key ${
              configuredElsewhere ? '<span class="field__hint">currently set from .env</span>' : ''
            }</span>
            <span class="field__input">
              <input type="password" data-api-key placeholder="${configuredElsewhere ? 'Using the key from .env' : 'AIza…'}"
                     value="${escapeHtml(scannerSettings.geminiApiKey || '')}" autocomplete="off" spellcheck="false" aria-label="Gemini API key">
            </span>
          </label>
          <p class="hint">Get a free key at <strong>aistudio.google.com/apikey</strong>. It is stored in this browser only and sent straight to Google — never to us.</p>

          <label class="field">
            <span class="field__label">Model</span>
            <span class="field__input">
              <select data-model aria-label="Gemini model">
                <option value="">Auto — ${escapeHtml(DEFAULT_MODEL)}, then others if it's busy</option>
                ${MODEL_CHAIN.map(
                  (model) =>
                    `<option value="${escapeHtml(model)}" ${
                      scannerSettings.geminiModel === model ? 'selected' : ''
                    }>${escapeHtml(model)}</option>`,
                ).join('')}
              </select>
            </span>
          </label>
          <p class="hint">Newer models get busy at peak times. “Auto” starts with a steady one and moves down the list — with a couple of retries — before falling back to the on-device reader.</p>

          <label class="switch">
            <input type="checkbox" data-ai-toggle ${scannerSettings.aiEnabled ? 'checked' : ''}>
            <span>Use the AI reader when a key is available</span>
          </label>

          <p class="hint" data-test-result role="status"></p>

          <div class="sheet__actions sheet__actions--split">
            <button class="btn btn--danger-ghost" data-clear-key ${scannerSettings.geminiApiKey ? '' : 'disabled'}>Remove key</button>
            <span class="row-actions">
              <button class="btn btn--ghost" data-test-key>Test</button>
              <button class="btn btn--primary" data-save-key>Save</button>
            </span>
          </div>
        </div>`,
      onMount: (sheetRoot, close) => {
        sheetRoot.querySelector('[data-save-key]').addEventListener('click', async () => {
          const key = sheetRoot.querySelector('[data-api-key]').value.trim();
          const aiEnabled = sheetRoot.querySelector('[data-ai-toggle]').checked;
          const geminiModel = sheetRoot.querySelector('[data-model]').value;
          await applyScannerSettings({ geminiApiKey: key, aiEnabled, geminiModel });
          close();
          toast(
            store.getState().session.aiReady
              ? 'AI receipt reading is on.'
              : 'Saved. Scans will use the on-device reader.',
            { tone: 'success' },
          );
        });
        sheetRoot.querySelector('[data-test-key]').addEventListener('click', async (event) => {
          const button = event.currentTarget;
          const result = sheetRoot.querySelector('[data-test-result]');
          const key = sheetRoot.querySelector('[data-api-key]').value.trim();
          const model = sheetRoot.querySelector('[data-model]').value;
          // Test what's on screen, not what was last saved.
          configureGemini({ apiKey: key || getGeminiKey(), model });
          button.disabled = true;
          result.textContent = 'Checking…';
          result.className = 'hint';
          const outcome = await testGeminiConnection();
          button.disabled = false;
          result.textContent = outcome.message;
          result.className = `hint ${outcome.ok ? 'is-ok' : 'is-warn'}`;
          configureGemini({ apiKey: scannerSettings.geminiApiKey, model: scannerSettings.geminiModel });
        });

        sheetRoot.querySelector('[data-clear-key]').addEventListener('click', async () => {
          await applyScannerSettings({ geminiApiKey: '' });
          close();
          toast('Key removed from this browser.');
        });
      },
    });
  }

  async function copySummary() {
    const text = summaryText(store.getBill(), summary());
    try {
      await navigator.clipboard.writeText(text);
      toast('Summary copied.', { tone: 'success' });
    } catch {
      showSheet({
        title: 'Copy the summary',
        render: () => `<textarea class="textarea" rows="12" readonly data-autofocus>${escapeHtml(text)}</textarea>`,
      });
    }
  }

  async function shareSummary() {
    const bill = store.getBill();
    try {
      await navigator.share({ title: bill.name, text: summaryText(bill, summary()) });
    } catch (error) {
      if (error && error.name !== 'AbortError') toast('Sharing isn’t available here — try Copy summary.', { tone: 'warn' });
    }
  }

  applyScannerSettings(scannerSettings);
  store.subscribe(render);
  render();
  return app;
}

// ---- shell markup ---------------------------------------------------------

function shellHtml() {
  return `
    <header class="topbar" data-header></header>
    <nav class="steps" data-steps aria-label="Steps"></nav>
    <main class="view" data-view tabindex="-1"></main>
    <div class="actionbar" data-actionbar></div>`;
}

function archiveListHtml(list, currentId) {
  return `
    <div class="archive-list">
      ${list
        .map((entry) => {
          const totals = calculateFinalTotals(entry.bill);
          const when = entry.updatedAt || entry.archivedAt;
          return `
        <article class="archive-item${entry.id === currentId ? ' is-current' : ''}">
          <button class="archive-item__main" data-open-bill="${escapeHtml(entry.id)}">
            <span class="archive-item__name">${escapeHtml(entry.name)}${
              entry.id === currentId ? ' <span class="pill">open now</span>' : ''
            }</span>
            <span class="archive-item__meta">${formatWhen(when)} · ${totals.itemCount} item${
              totals.itemCount === 1 ? '' : 's'
            } · ${totals.peopleCount} ${totals.peopleCount === 1 ? 'person' : 'people'}</span>
          </button>
          <span class="archive-item__total">${formatMoney(totals.totalCents, totals.currency)}</span>
          <button class="icon-btn" data-delete-bill="${escapeHtml(entry.id)}" aria-label="Delete ${escapeHtml(entry.name)}">🗑</button>
        </article>`;
        })
        .join('')}
    </div>
    <div class="sheet__actions">
      <button class="btn btn--danger-ghost btn--sm" data-clear-archive>Delete all saved bills</button>
    </div>
    <p class="sheet__footnote">Opening a bill brings it back for editing; your current bill is saved first.</p>`;
}

function emptyArchiveHtml() {
  return `<div class="empty">
    <div class="empty__icon" aria-hidden="true">📁</div>
    <h3>No saved bills yet</h3>
    <p>Bills are saved here when you start a new one, or when you tap “Save this bill”.</p>
  </div>`;
}

function formatWhen(iso) {
  if (!iso) return 'Saved';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Saved';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `Today, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function headerHtml(state, totals, totalChanged = false) {
  const { bill } = state;
  return `
    <div class="topbar__row">
      <div class="topbar__title">
        <button class="topbar__name" data-action="rename-bill" aria-label="Rename bill">
          ${escapeHtml(bill.name)}<span class="topbar__pencil" aria-hidden="true">✎</span>
        </button>
        <span class="topbar__meta">${totals.itemCount} item${totals.itemCount === 1 ? '' : 's'} · ${
          totals.peopleCount
        } ${totals.peopleCount === 1 ? 'person' : 'people'}</span>
      </div>
      <div class="topbar__end">
        <div class="topbar__total">
          <span class="topbar__total-label">Total</span>
          <strong class="${totalChanged ? 'is-bumped' : ''}">${formatMoney(totals.totalCents, totals.currency)}</strong>
        </div>
        <button class="icon-btn topbar__menu" data-action="open-menu" aria-label="Bill menu">⋯</button>
      </div>
    </div>`;
}

function stepsHtml(state, totals) {
  const done = {
    items: totals.itemCount > 0,
    people: totals.peopleCount > 0,
    assign: totals.itemCount > 0 && totals.unassignedItems.length === 0,
    review: totals.reconciles && totals.itemCount > 0,
  };
  return STEPS.map(
    (step) => `
    <button class="step${state.ui.step === step.id ? ' is-active' : ''}${done[step.id] ? ' is-done' : ''}"
            data-action="step" data-step="${step.id}" aria-current="${state.ui.step === step.id}">
      <span class="step__dot">${done[step.id] ? '✓' : step.short}</span>
      <span class="step__label">${step.label}</span>
    </button>`,
  ).join('');
}

function actionBarHtml(state, totals) {
  const step = state.ui.step;
  if (step === 'items') {
    return `
      <div class="actionbar__inner">
        <span class="actionbar__info">${
          totals.itemCount ? `${formatMoney(totals.totalCents, totals.currency)} on the bill` : 'Start with the receipt'
        }</span>
        <button class="btn btn--primary" data-action="go-people">${
          totals.peopleCount ? 'Next: People' : 'Add people'
        }</button>
      </div>`;
  }
  if (step === 'people') {
    return `
      <div class="actionbar__inner">
        <span class="actionbar__info">${totals.peopleCount} ${totals.peopleCount === 1 ? 'person' : 'people'}</span>
        <button class="btn btn--primary" data-action="go-assign" ${totals.peopleCount ? '' : 'disabled'}>Next: Assign items</button>
      </div>`;
  }
  if (step === 'assign') {
    const left = totals.unassignedItems.length;
    return `
      <div class="actionbar__inner">
        <span class="actionbar__info${left ? ' is-warn' : ''}">${
          left ? `${left} item${left === 1 ? '' : 's'} left` : 'Everything is assigned'
        }</span>
        <button class="btn btn--primary" data-action="go-review">See the split</button>
      </div>`;
  }
  return `
    <div class="actionbar__inner">
      <span class="actionbar__info">${
        totals.peopleCount ? `${formatMoney(totals.totalCents, totals.currency)} across ${totals.peopleCount}` : ''
      }</span>
      <button class="btn btn--primary" data-action="copy-summary">Copy summary</button>
    </div>`;
}
