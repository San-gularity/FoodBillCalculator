// Minimal DOM helpers. The app renders with template strings and event
// delegation — small enough to stay readable, no framework or build step.

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Replace a container's markup while keeping the field the user is in exactly as
 * they left it — same caret, same half-typed text. A focused field belongs to
 * the user until they leave it; without this, a background save landing
 * mid-keystroke would rewrite what they were typing.
 * Inputs opt in with `data-focus-key`.
 */
export function renderInto(container, html) {
  const active = document.activeElement;
  const focusKey = active && container.contains(active) ? active.dataset.focusKey : null;
  const isTextField = focusKey && typeof active.value === 'string';
  const value = isTextField ? active.value : null;
  const selectionStart = isTextField ? active.selectionStart : null;
  const selectionEnd = isTextField ? active.selectionEnd : null;

  container.innerHTML = html;

  if (!focusKey) return;
  const next = container.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
  if (!next) return;

  next.focus({ preventScroll: true });
  if (value != null && next.value !== value) next.value = value;
  if (selectionStart != null && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      /* number/date inputs don't support selection ranges */
    }
  }
}

/** Event delegation: on(root, 'click', '[data-action="x"]', handler). */
export function on(root, type, selector, handler) {
  root.addEventListener(
    type,
    (event) => {
      const target = event.target instanceof Element ? event.target.closest(selector) : null;
      if (target && root.contains(target)) handler(event, target);
    },
    type === 'focus' || type === 'blur' ? true : undefined,
  );
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
