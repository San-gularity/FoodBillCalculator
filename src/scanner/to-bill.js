// The bridge between "reviewed receipt draft" and "bill items".
// Kept separate (and pure) so the review screen never has to know about the
// bill model, and so the conversion is easy to test.

import { itemTotalCents } from '../core/model.js';

/** Draft items -> item payloads for store.addItems(). */
export function draftToBillItems(draft) {
  return (draft.items || [])
    .filter((item) => item.name && item.totalPriceCents != null)
    .map((item) => ({
      name: item.name,
      quantity: item.quantity || 1,
      unitPriceCents:
        item.unitPriceCents != null ? item.unitPriceCents : Math.round(item.totalPriceCents / (item.quantity || 1)),
      totalPriceCents: item.totalPriceCents,
      source: 'scan',
    }));
}

/**
 * Charges the receipt implies, after the user's corrections.
 * Anything the receipt claims but the items don't explain becomes an explicit
 * tip/fees line so that the person totals still reconcile with the printed total.
 */
export function draftToCharges(draft) {
  const items = draftToBillItems(draft);
  const itemsSum = items.reduce((acc, item) => acc + itemTotalCents(item), 0);
  const taxCents = draft.taxCents ?? 0;
  const declaredTotal = draft.totalCents ?? null;

  let extraCents = (draft.tipCents || 0) + (draft.feeCents || 0) - (draft.discountCents || 0);
  if (declaredTotal != null) {
    const unexplained = declaredTotal - (itemsSum + taxCents + extraCents);
    // Only absorb a difference that is real money, not a rounding cent.
    if (Math.abs(unexplained) > 1) extraCents += unexplained;
  }

  return {
    items,
    taxCents,
    extraCents,
    declaredSubtotalCents: draft.subtotalCents ?? null,
    declaredTotalCents: declaredTotal,
    itemsSumCents: itemsSum,
  };
}
