// Versioned envelope handling. Everything that comes out of a storage adapter
// passes through here first, so a corrupted or outdated blob can never reach
// the rest of the app as-is.

import { SCHEMA_VERSION, createBill, createItem, createPerson, pruneAssignments } from '../core/model.js';

export const STORAGE_KEY = 'current-bill';

export function createEnvelope(state) {
  return {
    version: SCHEMA_VERSION,
    bill: state.bill,
    ui: state.ui,
    updatedAt: new Date().toISOString(),
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** v1 was the original name-keyed shape: { items: {name: price}, people: {name: [itemName]} } */
function migrateV1(raw) {
  const bill = createBill({ name: raw.name });
  const itemsByName = new Map();

  const legacyItems = isObject(raw.items) ? raw.items : {};
  Object.entries(legacyItems).forEach(([name, price]) => {
    const item = createItem({ name, unitPriceCents: Math.round(Number(price) * 100) || 0 });
    itemsByName.set(name, item);
    bill.items.push(item);
  });

  const legacyPeople = isObject(raw.people) ? raw.people : {};
  Object.entries(legacyPeople).forEach(([name, orders], index) => {
    const person = createPerson(name, index);
    bill.people.push(person);
    (Array.isArray(orders) ? orders : []).forEach((itemName) => {
      const item = itemsByName.get(itemName);
      if (item) item.assignedTo.push(person.id);
    });
  });

  bill.taxCents = Math.round(Number(raw.tax) * 100) || 0;
  return { version: 2, bill, ui: null, updatedAt: raw.updatedAt };
}

const MIGRATIONS = { 1: migrateV1 };

function coerceItem(raw, index) {
  if (!isObject(raw)) return null;
  const item = createItem({
    id: typeof raw.id === 'string' ? raw.id : undefined,
    name: raw.name,
    quantity: raw.quantity,
    unitPriceCents: raw.unitPriceCents,
    totalPriceCents: raw.totalPriceCents,
    assignedTo: Array.isArray(raw.assignedTo) ? raw.assignedTo.filter((v) => typeof v === 'string') : [],
    source: raw.source,
  });
  if (!item.name) item.name = `Item ${index + 1}`;
  return item;
}

function coercePerson(raw, index) {
  if (!isObject(raw)) return null;
  const person = createPerson(raw.name, index);
  if (typeof raw.id === 'string' && raw.id) person.id = raw.id;
  if (typeof raw.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(raw.color)) person.color = raw.color;
  return person;
}

function coerceInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function coerceNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Rebuilds a valid bill from whatever shape the stored object happens to be. */
export function coerceBill(raw) {
  const base = createBill(isObject(raw) ? { id: raw.id, name: raw.name, currency: raw.currency, createdAt: raw.createdAt } : {});
  if (!isObject(raw)) return base;

  base.items = (Array.isArray(raw.items) ? raw.items : []).map(coerceItem).filter(Boolean);
  base.people = (Array.isArray(raw.people) ? raw.people : []).map(coercePerson).filter(Boolean);
  base.taxCents = coerceInt(raw.taxCents, 0);
  base.extraCents = coerceInt(raw.extraCents, 0);
  base.extraLabel = typeof raw.extraLabel === 'string' && raw.extraLabel ? raw.extraLabel : 'Service & fees';
  base.sharedChargeSplit = raw.sharedChargeSplit === 'proportional' ? 'proportional' : 'equal';
  base.declaredSubtotalCents = coerceNullableInt(raw.declaredSubtotalCents);
  base.declaredTotalCents = coerceNullableInt(raw.declaredTotalCents);
  base.receipt = isObject(raw.receipt)
    ? {
        id: typeof raw.receipt.id === 'string' ? raw.receipt.id : 'receipt',
        capturedAt: typeof raw.receipt.capturedAt === 'string' ? raw.receipt.capturedAt : null,
        provider: typeof raw.receipt.provider === 'string' ? raw.receipt.provider : 'unknown',
        photoCount: Number(raw.receipt.photoCount) > 0 ? Math.trunc(Number(raw.receipt.photoCount)) : 1,
        thumbnail: typeof raw.receipt.thumbnail === 'string' ? raw.receipt.thumbnail : null,
        rawText: typeof raw.receipt.rawText === 'string' ? raw.receipt.rawText.slice(0, 20000) : '',
      }
    : null;

  // Drop assignments pointing at people who no longer exist.
  return pruneAssignments(base);
}

const VALID_STEPS = new Set(['items', 'people', 'assign', 'review']);

function coerceUi(raw) {
  const ui = { step: 'items', expandedPersonId: null };
  if (!isObject(raw)) return ui;
  if (VALID_STEPS.has(raw.step)) ui.step = raw.step;
  if (typeof raw.expandedPersonId === 'string') ui.expandedPersonId = raw.expandedPersonId;
  return ui;
}

/**
 * Take anything at all and return { bill, ui, updatedAt, recovered }.
 * `recovered` is true when the stored data had to be repaired or dropped, so
 * the UI can tell the user instead of silently losing their bill.
 */
export function normalizeStoredState(raw) {
  if (raw == null) return null;

  let data = raw;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return { bill: createBill(), ui: coerceUi(null), updatedAt: null, recovered: true };
    }
  }
  if (!isObject(data)) return { bill: createBill(), ui: coerceUi(null), updatedAt: null, recovered: true };

  let recovered = false;
  let version = Number(data.version);
  if (!Number.isFinite(version) || version < 1) {
    version = SCHEMA_VERSION;
    recovered = true;
  }

  let envelope = data;
  while (version < SCHEMA_VERSION && MIGRATIONS[version]) {
    envelope = MIGRATIONS[version](envelope);
    version = envelope.version;
    recovered = true;
  }

  if (version > SCHEMA_VERSION) recovered = true; // written by a newer build

  const bill = coerceBill(envelope.bill);
  const before = JSON.stringify(envelope.bill ?? null);
  if (before !== JSON.stringify(bill) && !recovered) {
    // Fields were repaired; only flag it when something meaningful was lost.
    const rawItems = Array.isArray(envelope.bill?.items) ? envelope.bill.items.length : 0;
    const rawPeople = Array.isArray(envelope.bill?.people) ? envelope.bill.people.length : 0;
    recovered = rawItems !== bill.items.length || rawPeople !== bill.people.length;
  }

  return {
    bill,
    ui: coerceUi(envelope.ui),
    updatedAt: typeof envelope.updatedAt === 'string' ? envelope.updatedAt : null,
    recovered,
  };
}
