// Domain model. Pure data + pure helpers — nothing in here touches the DOM,
// storage or the network, so it can be unit tested and reused on a server later.

import { toCents, sumCents } from './money.js';

export const SCHEMA_VERSION = 2;

export const PERSON_COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6',
  '#ef4444', '#0ea5e9', '#84cc16', '#f97316', '#06b6d4',
];

let idCounter = 0;
/** Stable-ish unique id that works without crypto (file:// on old browsers). */
export function createId(prefix = 'id') {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

export function createPerson(name, index = 0) {
  return {
    id: createId('p'),
    name: String(name ?? '').trim().slice(0, 40) || `Person ${index + 1}`,
    color: PERSON_COLORS[index % PERSON_COLORS.length],
  };
}

export function createItem(partial = {}) {
  const quantity = normalizeQuantity(partial.quantity);
  const unitPriceCents = Math.trunc(Number(partial.unitPriceCents) || 0);
  return {
    id: partial.id || createId('i'),
    name: String(partial.name ?? '').trim().slice(0, 80) || 'Item',
    quantity,
    unitPriceCents,
    // Explicit line total wins when a receipt prints one that isn't qty x unit.
    totalPriceCents:
      partial.totalPriceCents == null ? null : Math.trunc(Number(partial.totalPriceCents) || 0),
    assignedTo: Array.isArray(partial.assignedTo) ? [...new Set(partial.assignedTo)] : [],
    source: partial.source === 'scan' ? 'scan' : 'manual',
  };
}

export function createBill(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: partial.id || createId('bill'),
    name: partial.name || defaultBillName(),
    currency: partial.currency || 'USD',
    createdAt: partial.createdAt || now,
    items: [],
    people: [],
    taxCents: 0,
    // Tip, service charge, fees or a discount (negative). Shared like tax.
    extraCents: 0,
    extraLabel: 'Service & fees',
    // How tax, service charges, bag fees and tip are shared out:
    // 'equal' — everyone with items pays the same amount (the default)
    // 'proportional' — bigger eaters carry more of it
    sharedChargeSplit: 'equal',
    // What the receipt itself claimed, kept for reconciliation only.
    declaredSubtotalCents: null,
    declaredTotalCents: null,
    receipt: null,
    ...partial,
  };
}

export function defaultBillName() {
  const d = new Date();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' bill';
}

export function normalizeQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  // Receipts can carry weights like 1.24 kg — keep two decimals, cap the silly.
  return Math.min(Math.round(n * 100) / 100, 999);
}

/** The amount this line contributes to the bill, in cents. */
export function itemTotalCents(item) {
  if (!item) return 0;
  if (item.totalPriceCents != null) return Math.trunc(item.totalPriceCents);
  return toCents((Number(item.unitPriceCents) || 0) * normalizeQuantity(item.quantity) / 100);
}

export function billSubtotalCents(bill) {
  return sumCents(bill.items || [], itemTotalCents);
}

export function isAssigned(item) {
  return Array.isArray(item.assignedTo) && item.assignedTo.length > 0;
}

export function unassignedItems(bill) {
  return (bill.items || []).filter((item) => !isAssigned(item));
}

/** People referenced by items but no longer on the bill get pruned. */
export function pruneAssignments(bill) {
  const valid = new Set((bill.people || []).map((p) => p.id));
  return {
    ...bill,
    items: (bill.items || []).map((item) => {
      const kept = (item.assignedTo || []).filter((id) => valid.has(id));
      return kept.length === (item.assignedTo || []).length ? item : { ...item, assignedTo: kept };
    }),
  };
}

/**
 * User-facing problems with the current bill. Returned as codes + messages so
 * the UI can decide how loudly to show each one.
 */
export function validateBill(bill) {
  const issues = [];
  const items = bill.items || [];
  const people = bill.people || [];

  if (items.length === 0) issues.push({ code: 'no-items', level: 'info', message: 'Add at least one item to split.' });
  if (people.length === 0) issues.push({ code: 'no-people', level: 'info', message: 'Add the people sharing this bill.' });

  const zeroPriced = items.filter((i) => itemTotalCents(i) === 0);
  if (zeroPriced.length) {
    issues.push({
      code: 'zero-price',
      level: 'warning',
      message: `${zeroPriced.length} item${zeroPriced.length > 1 ? 's have' : ' has'} no price.`,
      itemIds: zeroPriced.map((i) => i.id),
    });
  }

  const negative = items.filter((i) => itemTotalCents(i) < 0);
  if (negative.length) {
    issues.push({
      code: 'negative-price',
      level: 'info',
      message: `${negative.length} item${negative.length > 1 ? 's are' : ' is'} a credit or discount.`,
      itemIds: negative.map((i) => i.id),
    });
  }

  if (people.length > 0 && items.length > 0) {
    const missing = unassignedItems(bill);
    if (missing.length) {
      issues.push({
        code: 'unassigned',
        level: 'warning',
        message: `${missing.length} item${missing.length > 1 ? 's are' : ' is'} not assigned to anyone yet.`,
        itemIds: missing.map((i) => i.id),
      });
    }
  }

  if (bill.declaredTotalCents != null) {
    const computed = billSubtotalCents(bill) + (bill.taxCents || 0) + (bill.extraCents || 0);
    const diff = bill.declaredTotalCents - computed;
    if (Math.abs(diff) > 1) {
      issues.push({
        code: 'total-mismatch',
        level: 'warning',
        message: 'Items, tax and tip don’t add up to the receipt total.',
        diffCents: diff,
      });
    }
  }

  return issues;
}
