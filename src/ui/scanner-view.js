// The scan → review → confirm flow.
// Only this file knows the scanner exists; it hands finished items to the store.

import { escapeHtml, renderInto, on } from './dom.js';
import { showSheet, toast, confirmSheet } from './components.js';
import { formatMoney, centsToInput, parseMoneyInput } from '../core/money.js';
import { scanReceiptImage, scanReceiptText } from '../scanner/index.js';
import { confidenceTier, markItemEdited, markItemConfirmed } from '../scanner/parse-receipt.js';
import { draftToCharges } from '../scanner/to-bill.js';
import { ScannerError } from '../scanner/errors.js';
import { createId } from '../core/model.js';

const STAGE_COPY = {
  preparing: 'Preparing the photo…',
  loading: 'Getting the reader ready…',
  reading: 'Reading the receipt…',
  retrying: 'The AI reader is busy — trying again…',
  parsing: 'Finding items and totals…',
};

function aiIsOn(app) {
  return Boolean(app.store.getState().session?.aiReady);
}

/** Entry point: choose camera, gallery, or typing it in. */
export function openScanner(app) {
  showSheet({
    title: 'Add a receipt',
    size: 'sm',
    render: () => `
      <div class="scan-options">
        <label class="scan-option" tabindex="0" data-autofocus>
          <input type="file" accept="image/*" capture="environment" data-source="camera" hidden>
          <span class="scan-option__icon" aria-hidden="true">📸</span>
          <span><strong>Take a photo</strong><small>Point at the receipt</small></span>
        </label>
        <label class="scan-option" tabindex="0">
          <input type="file" accept="image/*" data-source="gallery" hidden>
          <span class="scan-option__icon" aria-hidden="true">🖼️</span>
          <span><strong>Choose an image</strong><small>From your photos or files</small></span>
        </label>
        <button class="scan-option scan-option--ghost" data-action="type-receipt">
          <span class="scan-option__icon" aria-hidden="true">⌨️</span>
          <span><strong>Type or paste it</strong><small>No photo needed</small></span>
        </button>
      </div>
      <p class="sheet__footnote" data-reader-note></p>`,
    onMount: (root, close) => {
      const note = root.querySelector('[data-reader-note]');
      if (note) {
        note.innerHTML = aiIsOn(app)
          ? 'Read by the AI reader for best accuracy. <button class="linkish" data-open-settings>Change</button>'
          : 'Using the on-device reader — the first scan downloads it (~2 MB), then it works offline. <button class="linkish" data-open-settings>Use AI instead</button>';
        note.querySelector('[data-open-settings]')?.addEventListener('click', () => {
          close();
          app.openScannerSettings();
        });
      }
      root.querySelectorAll('input[type="file"]').forEach((input) => {
        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          if (!file) return;
          close();
          runScan(app, file);
        });
      });
      root.querySelectorAll('.scan-option[tabindex]').forEach((label) => {
        label.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            label.querySelector('input')?.click();
          }
        });
      });
      root.querySelector('[data-action="type-receipt"]').addEventListener('click', () => {
        close();
        openTextEntry(app);
      });
    },
  });
}

/** Paste the text of a receipt — works with no network and no camera. */
export function openTextEntry(app) {
  showSheet({
    title: 'Type or paste the receipt',
    render: () => `
      <p class="sheet__message">One item per line, price at the end. Lines like “Subtotal”, “Tax” and “Total” are picked up automatically.</p>
      <textarea class="textarea" rows="10" data-autofocus data-receipt-text
        placeholder="Chicken Biryani   14.99&#10;Garlic Naan        4.50&#10;Tax                1.56&#10;Total             21.05"></textarea>
      <div class="sheet__actions">
        <button class="btn btn--ghost" data-sheet-close>Cancel</button>
        <button class="btn btn--primary" data-parse-text>Read receipt</button>
      </div>`,
    onMount: (root, close) => {
      root.querySelector('[data-parse-text]').addEventListener('click', async () => {
        const text = root.querySelector('[data-receipt-text]').value;
        if (!text.trim()) {
          toast('Type at least one line first.', { tone: 'warn' });
          return;
        }
        try {
          const draft = await scanReceiptText(text);
          close();
          openReview(app, draft);
        } catch (error) {
          toast(friendlyError(error), { tone: 'danger' });
        }
      });
    },
  });
}

function friendlyError(error) {
  if (error instanceof ScannerError) return error.message;
  return 'Something went wrong reading that receipt. You can type the items in instead.';
}

async function runScan(app, file) {
  let cancelled = false;
  const handle = showSheet({
    title: 'Reading your receipt',
    size: 'sm',
    dismissable: false,
    render: () => `
      <div class="scan-progress">
        <div class="spinner" aria-hidden="true"></div>
        <p class="scan-progress__stage" data-stage>${STAGE_COPY.preparing}</p>
        <div class="progress progress--thin"><div class="progress__bar" data-bar style="width:8%"></div></div>
        <button class="btn btn--ghost btn--sm" data-cancel>Cancel</button>
      </div>`,
    onMount: (root, close) => {
      root.querySelector('[data-cancel]').addEventListener('click', () => {
        cancelled = true;
        close();
      });
    },
  });

  const setStage = ({ stage, progress }) => {
    if (cancelled) return;
    const stageEl = handle.root.querySelector('[data-stage]');
    const bar = handle.root.querySelector('[data-bar]');
    if (stageEl && STAGE_COPY[stage]) stageEl.textContent = STAGE_COPY[stage];
    if (bar) {
      const base = { preparing: 5, loading: 20, reading: 45, retrying: 45, parsing: 95 }[stage] ?? 10;
      const span = { preparing: 10, loading: 25, reading: 50, retrying: 50, parsing: 5 }[stage] ?? 10;
      bar.style.width = `${Math.min(99, base + span * (Number(progress) || 0))}%`;
    }
  };

  try {
    const draft = await scanReceiptImage(file, {
      onProgress: setStage,
      preferAi: aiIsOn(app),
      onNotice: (message) => toast(message, { tone: 'warn', duration: 5000 }),
    });
    if (cancelled) return;
    handle.close();
    openReview(app, draft);
  } catch (error) {
    if (cancelled) return;
    handle.close();
    openScanError(app, error, file);
  }
}

function openScanError(app, error, file) {
  showSheet({
    title: 'We couldn’t read that',
    size: 'sm',
    render: () => `
      <p class="sheet__message">${escapeHtml(friendlyError(error))}</p>
      <ul class="tips">
        <li>Lay the receipt flat and fill the frame.</li>
        <li>Good, even light — avoid shadows and glare.</li>
        <li>Keep the text upright and in focus.</li>
      </ul>
      <div class="sheet__actions sheet__actions--stack">
        <button class="btn btn--primary" data-retry>Try another photo</button>
        <button class="btn btn--ghost" data-type>Type it in instead</button>
      </div>`,
    onMount: (root, close) => {
      root.querySelector('[data-retry]').addEventListener('click', () => {
        close();
        openScanner(app);
      });
      root.querySelector('[data-type]').addEventListener('click', () => {
        close();
        openTextEntry(app);
      });
    },
  });
}

// ---- Review screen --------------------------------------------------------

function itemStatus(item) {
  if (item.status !== 'pending') return 'ok';
  const nameTier = confidenceTier(item.confidence.name);
  const priceTier = item.totalPriceCents == null ? 'low' : confidenceTier(item.confidence.price);
  if (nameTier === 'low' || priceTier === 'low') return 'low';
  if (nameTier === 'medium' || priceTier === 'medium') return 'medium';
  return 'ok';
}

function unresolved(draft) {
  return draft.items.filter((item) => itemStatus(item) === 'low');
}

export function openReview(app, initialDraft) {
  const draft = { ...initialDraft, items: initialDraft.items.map((item) => ({ ...item })) };

  const handle = showSheet({
    title: 'Review receipt',
    size: 'lg',
    render: () => '<div data-review-root></div>',
    onMount: (root, close) => {
      const container = root.querySelector('[data-review-root]');
      const rerender = () => renderInto(container, reviewHtml(draft));
      rerender();

      const patch = (id, changes) => {
        let updated = null;
        draft.items = draft.items.map((item) => {
          if (item.id !== id) return item;
          updated = markItemEdited(item, changes);
          return updated;
        });
        return updated;
      };

      // Edits update the row in place. Re-rendering the whole list here would
      // rip out the field the user is moving into and swallow their next keystroke.
      on(container, 'input', '[data-field]', (event, el) => {
        const id = el.dataset.id;
        const field = el.dataset.field;
        let updated = null;
        if (field === 'name') updated = patch(id, { name: el.value });
        if (field === 'price') updated = patch(id, { totalPriceCents: parseMoneyInput(el.value), unitPriceCents: null });
        if (field === 'qty') updated = patch(id, { quantity: Number(el.value) || 1 });
        if (field === 'tax') draft.taxCents = parseMoneyInput(el.value);
        if (field === 'subtotal') draft.subtotalCents = parseMoneyInput(el.value);
        if (field === 'total') draft.totalCents = parseMoneyInput(el.value);
        if (updated) refreshRow(container, updated);
        refreshSummary(container, draft);
        updateFooter(container, draft);
      });

      on(container, 'click', '[data-confirm-item]', (event, el) => {
        const id = el.dataset.confirmItem;
        draft.items = draft.items.map((item) => (item.id === id ? markItemConfirmed(item) : item));
        rerender();
      });

      on(container, 'click', '[data-remove-item]', (event, el) => {
        draft.items = draft.items.filter((item) => item.id !== el.dataset.removeItem);
        rerender();
      });

      on(container, 'click', '[data-add-item]', () => {
        draft.items = [
          ...draft.items,
          {
            id: createId('draft'),
            name: '',
            quantity: 1,
            unitPriceCents: null,
            totalPriceCents: null,
            confidence: { name: 0, price: 0, overall: 0 },
            status: 'pending',
            needsReview: true,
          },
        ];
        rerender();
        const inputs = container.querySelectorAll('[data-field="name"]');
        inputs[inputs.length - 1]?.focus();
      });

      on(container, 'click', '[data-confirm-all]', async () => {
        const missing = unresolved(draft);
        if (missing.length) {
          const first = container.querySelector(`[data-row="${missing[0].id}"]`);
          first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          first?.querySelector('input')?.focus();
          toast(`${missing.length} item${missing.length > 1 ? 's need' : ' needs'} a name and price first.`, {
            tone: 'warn',
          });
          return;
        }
        const charges = draftToCharges(draft);
        if (!charges.items.length) {
          toast('There are no items to add yet.', { tone: 'warn' });
          return;
        }
        if (app.getBill().items.length) {
          const replace = await confirmSheet({
            title: 'Replace current items?',
            message: `Your bill already has ${app.getBill().items.length} item(s). Replace them with this receipt?`,
            confirmLabel: 'Replace',
            tone: 'primary',
          });
          if (replace) app.store.clearItems();
        }
        close();
        app.applyReceipt(draft, charges);
      });
    },
  });

  return handle;
}

function updateFooter(container, draft) {
  const footer = container.querySelector('[data-review-footer]');
  if (footer) footer.innerHTML = reviewFooterHtml(draft);
}

/** Update one row's warning state without touching its inputs. */
function refreshRow(container, item) {
  const row = container.querySelector(`[data-row="${CSS.escape(item.id)}"]`);
  if (!row) return;
  const status = itemStatus(item);
  row.className = `review-row review-row--${status}`;
  const badge = row.querySelector('.review-row__status');
  if (badge) badge.textContent = status === 'ok' ? '✓' : '⚠';
  row.querySelector('.review-row__price')?.classList.toggle('is-warn', item.totalPriceCents == null);
  if (status !== 'low') row.querySelector('.review-row__hint')?.remove();
  if (status !== 'medium') row.querySelector('[data-confirm-item]')?.remove();
}

function refreshSummary(container, draft) {
  const summary = container.querySelector('.review__summary');
  if (!summary) return;
  const needsAttention = draft.items.filter((item) => itemStatus(item) !== 'ok').length;
  summary.innerHTML = summaryInnerHtml(draft.items.length, needsAttention);
}

function summaryInnerHtml(count, needsAttention) {
  return `<strong>We found ${count} item${count === 1 ? '' : 's'}.</strong>
    ${
      needsAttention
        ? `<span class="pill pill--warn">${needsAttention} need${needsAttention === 1 ? 's' : ''} a look</span>`
        : '<span class="pill pill--ok">All clear</span>'
    }`;
}

function reviewHtml(draft) {
  const needsAttention = draft.items.filter((item) => itemStatus(item) !== 'ok').length;
  return `
    <div class="review">
      <div class="review__summary">${summaryInnerHtml(draft.items.length, needsAttention)}</div>

      ${draft.warnings
        .filter((warning) => warning.code !== 'no-tax' || draft.taxCents == null)
        .map((warning) => `<div class="notice notice--warn notice--compact"><p>${escapeHtml(warning.message)}</p></div>`)
        .join('')}

      ${draft.thumbnail ? `<img class="review__thumb" src="${draft.thumbnail}" alt="Photo of the scanned receipt">` : ''}

      <div class="review__rows">
        ${draft.items.map(reviewRowHtml).join('')}
      </div>

      <button class="btn btn--ghost btn--block" data-add-item>+ Add a missing item</button>

      <div class="review__totals">
        ${totalFieldHtml('Subtotal', 'subtotal', draft.subtotalCents, 'optional')}
        ${totalFieldHtml('Tax', 'tax', draft.taxCents, draft.taxCents == null ? 'not found — add it' : '')}
        ${totalFieldHtml('Total', 'total', draft.totalCents, draft.totalCents == null ? 'not found' : '')}
      </div>

      <div class="review__footer" data-review-footer>${reviewFooterHtml(draft)}</div>
    </div>`;
}

function totalFieldHtml(label, field, cents, hint) {
  return `
    <label class="field">
      <span class="field__label">${escapeHtml(label)}${hint ? ` <span class="field__hint">${escapeHtml(hint)}</span>` : ''}</span>
      <span class="field__input${cents == null && field === 'tax' ? ' is-warn' : ''}">
        <span class="field__prefix">$</span>
        <input type="text" inputmode="decimal" data-field="${field}" data-focus-key="review-${field}"
               value="${cents == null ? '' : escapeHtml(centsToInput(cents))}" placeholder="0.00" aria-label="${escapeHtml(label)}">
      </span>
    </label>`;
}

function reviewRowHtml(item) {
  const status = itemStatus(item);
  const icon = status === 'ok' ? '✓' : '⚠';
  const nameUnclear = item.status === 'pending' && confidenceTier(item.confidence.name) === 'low';
  const priceUnclear = item.totalPriceCents == null || (item.status === 'pending' && confidenceTier(item.confidence.price) === 'low');

  return `
  <div class="review-row review-row--${status}" data-row="${escapeHtml(item.id)}">
    <span class="review-row__status" aria-hidden="true">${icon}</span>
    <div class="review-row__fields">
      <input class="review-row__name" data-field="name" data-id="${escapeHtml(item.id)}" data-focus-key="name-${escapeHtml(item.id)}"
             value="${escapeHtml(item.name)}" placeholder="${nameUnclear ? 'What is this item?' : 'Item name'}"
             aria-label="Item name" ${nameUnclear ? 'aria-invalid="true"' : ''}>
      <span class="review-row__qty">
        <input type="number" min="1" step="1" data-field="qty" data-id="${escapeHtml(item.id)}"
               data-focus-key="qty-${escapeHtml(item.id)}" value="${escapeHtml(item.quantity || 1)}" aria-label="Quantity">
      </span>
      <span class="review-row__price field__input${priceUnclear ? ' is-warn' : ''}">
        <span class="field__prefix">$</span>
        <input type="text" inputmode="decimal" data-field="price" data-id="${escapeHtml(item.id)}"
               data-focus-key="price-${escapeHtml(item.id)}"
               value="${item.totalPriceCents == null ? '' : escapeHtml(centsToInput(item.totalPriceCents))}"
               placeholder="${priceUnclear ? 'price?' : '0.00'}" aria-label="Price"
               ${priceUnclear ? 'aria-invalid="true"' : ''}>
      </span>
    </div>
    <div class="review-row__actions">
      ${
        status === 'medium'
          ? `<button class="icon-btn icon-btn--ok" data-confirm-item="${escapeHtml(item.id)}" aria-label="Confirm ${escapeHtml(item.name)}">✓</button>`
          : ''
      }
      <button class="icon-btn" data-remove-item="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.name || 'item')}">✕</button>
    </div>
    ${
      status === 'low'
        ? `<p class="review-row__hint">${
            nameUnclear && priceUnclear
              ? 'We couldn’t read this line. Add the name and price.'
              : nameUnclear
                ? 'We couldn’t read the item name.'
                : 'We couldn’t read the price.'
          }${item.raw ? ` <span class="review-row__raw">Scanned as “${escapeHtml(item.raw)}”</span>` : ''}</p>`
        : item.note && status !== 'ok'
          ? `<p class="review-row__hint">${escapeHtml(item.note)}</p>`
          : ''
    }
  </div>`;
}

function reviewFooterHtml(draft) {
  const charges = draftToCharges(draft);
  const blocked = unresolved(draft).length;
  const printedExtra = (draft.tipCents || 0) + (draft.feeCents || 0) - (draft.discountCents || 0);
  // What we had to invent to make the items, tax and printed total agree.
  const diff = charges.extraCents - printedExtra;
  return `
    <div class="review__math">
      <span>Items ${formatMoney(charges.itemsSumCents)}</span>
      ${draft.taxCents ? `<span>Tax ${formatMoney(draft.taxCents)}</span>` : ''}
      ${charges.extraCents ? `<span>Tip &amp; fees ${formatMoney(charges.extraCents)}</span>` : ''}
      ${draft.totalCents != null ? `<span class="is-strong">Total ${formatMoney(draft.totalCents)}</span>` : ''}
    </div>
    ${
      Math.abs(diff) > 1
        ? `<p class="hint">We’ll add ${formatMoney(Math.abs(diff))} as ${diff > 0 ? 'tip &amp; fees' : 'a discount'} so the split matches the receipt.</p>`
        : ''
    }
    <button class="btn btn--primary btn--block btn--lg" data-confirm-all>
      ${blocked ? `Fix ${blocked} item${blocked === 1 ? '' : 's'} first` : `Add ${charges.items.length} item${charges.items.length === 1 ? '' : 's'} to bill`}
    </button>`;
}
