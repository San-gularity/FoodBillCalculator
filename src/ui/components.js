// Shared UI pieces: avatars, chips, toasts, sheets, confirm dialogs.

import { escapeHtml, initials, prefersReducedMotion } from './dom.js';
import { formatMoney } from '../core/money.js';

export function avatar(person, { size = 'md', selected = false } = {}) {
  return `<span class="avatar avatar--${size}${selected ? ' is-selected' : ''}" style="--avatar-color:${escapeHtml(
    person.color,
  )}" title="${escapeHtml(person.name)}" aria-hidden="true">${escapeHtml(initials(person.name))}</span>`;
}

export function personToggle(person, checked, itemId) {
  return `
    <button type="button"
      class="chip chip--toggle${checked ? ' is-on' : ''}"
      style="--chip-color:${escapeHtml(person.color)}"
      role="checkbox" aria-checked="${checked}"
      data-action="toggle-assign" data-item="${escapeHtml(itemId)}" data-person="${escapeHtml(person.id)}">
      ${avatar(person, { size: 'sm', selected: checked })}
      <span class="chip__label">${escapeHtml(person.name)}</span>
    </button>`;
}

export function moneyRow(label, cents, currency, { strong = false, muted = false, negative = false } = {}) {
  return `<div class="money-row${strong ? ' money-row--strong' : ''}${muted ? ' money-row--muted' : ''}">
    <span>${escapeHtml(label)}</span>
    <span class="money-row__value${negative ? ' is-negative' : ''}">${formatMoney(cents, currency)}</span>
  </div>`;
}

export function emptyState({ icon, title, body, actionLabel, action }) {
  return `<div class="empty">
    <div class="empty__icon" aria-hidden="true">${icon}</div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(body)}</p>
    ${action ? `<button class="btn btn--primary" data-action="${escapeHtml(action)}">${escapeHtml(actionLabel)}</button>` : ''}
  </div>`;
}

// ---- Toasts ---------------------------------------------------------------

let toastHost = null;
function ensureToastHost() {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

export function toast(message, { tone = 'default', actionLabel, onAction, duration = 4000 } = {}) {
  const host = ensureToastHost();
  // Never stack more than three; older ones fall off the top.
  while (host.children.length >= 3) host.firstElementChild.remove();
  const node = document.createElement('div');
  node.className = `toast toast--${tone}`;
  node.innerHTML = `<span class="toast__text">${escapeHtml(message)}</span>`;
  if (actionLabel && onAction) {
    const button = document.createElement('button');
    button.className = 'toast__action';
    button.textContent = actionLabel;
    button.addEventListener('click', () => {
      onAction();
      dismiss();
    });
    node.appendChild(button);
  }
  host.appendChild(node);

  let timer = setTimeout(dismiss, duration);
  function dismiss() {
    clearTimeout(timer);
    node.classList.add('is-leaving');
    if (prefersReducedMotion()) node.remove();
    else setTimeout(() => node.remove(), 180);
  }
  return dismiss;
}

// ---- Sheet / modal --------------------------------------------------------

let openSheet = null;

/**
 * Bottom sheet on phones, centred dialog on wider screens.
 * `render(close)` returns HTML; `onMount(root, close)` wires it up.
 */
export function showSheet({ title, render, onMount, size = 'md', dismissable = true }) {
  closeSheet();
  // A sheet that is still fading out must not sit on top of the new one.
  document.querySelectorAll('.sheet-backdrop').forEach((node) => node.remove());

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <section class="sheet sheet--${size}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <header class="sheet__head">
        <div class="sheet__grabber" aria-hidden="true"></div>
        <h2>${escapeHtml(title)}</h2>
        ${dismissable ? '<button class="icon-btn sheet__close" data-sheet-close aria-label="Close">✕</button>' : ''}
      </header>
      <div class="sheet__body"></div>
    </section>`;

  const body = backdrop.querySelector('.sheet__body');
  body.innerHTML = typeof render === 'function' ? render(close) : render;
  document.body.appendChild(backdrop);
  document.body.classList.add('has-sheet');

  const previouslyFocused = document.activeElement;
  requestAnimationFrame(() => {
    backdrop.classList.add('is-open');
    const focusTarget = backdrop.querySelector('[data-autofocus]') || backdrop.querySelector('button, input');
    focusTarget?.focus({ preventScroll: true });
  });

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop && dismissable) close();
    if (event.target.closest('[data-sheet-close]')) close();
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dismissable) {
      event.stopPropagation();
      close();
    }
    if (event.key === 'Tab') trapFocus(event, backdrop);
  });

  function close(result) {
    if (openSheet !== handle) return;
    openSheet = null;
    document.body.classList.remove('has-sheet');
    backdrop.classList.remove('is-open');
    backdrop.style.pointerEvents = 'none';
    const remove = () => backdrop.remove();
    if (prefersReducedMotion()) remove();
    else setTimeout(remove, 180);
    previouslyFocused?.focus?.({ preventScroll: true });
    handle.onClose?.(result);
  }

  const handle = { close, root: backdrop, body };
  openSheet = handle;
  onMount?.(backdrop, close);
  return handle;
}

export function closeSheet() {
  openSheet?.close();
}

function trapFocus(event, root) {
  const focusable = [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => el.offsetParent !== null,
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function confirmSheet({ title, message, confirmLabel = 'Confirm', tone = 'danger' }) {
  return new Promise((resolve) => {
    const handle = showSheet({
      title,
      size: 'sm',
      render: () => `
        <p class="sheet__message">${escapeHtml(message)}</p>
        <div class="sheet__actions">
          <button class="btn btn--ghost" data-sheet-close>Cancel</button>
          <button class="btn btn--${tone}" data-confirm data-autofocus>${escapeHtml(confirmLabel)}</button>
        </div>`,
      onMount: (root, close) => {
        root.querySelector('[data-confirm]').addEventListener('click', () => {
          resolved = true;
          close();
          resolve(true);
        });
      },
    });
    let resolved = false;
    handle.onClose = () => {
      if (!resolved) resolve(false);
    };
  });
}
