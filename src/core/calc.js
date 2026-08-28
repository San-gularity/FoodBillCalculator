// The single source of truth for every number the app shows.
// Pure functions, integer cents in and out. No DOM, no state, no side effects.

import { reconcileRounding, sumCents } from './money.js';
import { itemTotalCents, billSubtotalCents } from './model.js';

/**
 * Split one item between the people assigned to it.
 * Returns { totalCents, assignedCount, shares: { [personId]: cents } }.
 * The shares always sum to exactly the item total; leftover pennies go to the
 * first-assigned people so repeat runs give the same answer.
 */
export function calculateItemShares(item) {
  const totalCents = itemTotalCents(item);
  const assigned = Array.isArray(item.assignedTo) ? item.assignedTo : [];
  const shares = {};
  if (assigned.length === 0) return { totalCents, assignedCount: 0, shares, unassignedCents: totalCents };

  const parts = reconcileRounding(totalCents, assigned.map(() => 1));
  assigned.forEach((personId, index) => {
    shares[personId] = (shares[personId] || 0) + parts[index];
  });
  return { totalCents, assignedCount: assigned.length, shares, unassignedCents: 0 };
}

/** What one person owes before tax, across every item they're on. */
export function calculatePersonSubtotal(personId, items) {
  return sumCents(items, (item) => calculateItemShares(item).shares[personId] || 0);
}

/**
 * Share a pooled amount — tax, service charge, bag fee, tip — across people.
 *
 * 'equal' (the default): everyone who had something pays the same amount.
 *   Someone with nothing assigned yet pays nothing, so the numbers don't jump
 *   around while items are still being assigned; if nobody has anything yet,
 *   it is split across everyone.
 * 'proportional': the pool follows each person's subtotal.
 *
 * `subtotals` is an array of cents; the return is a matching array of cents
 * summing to exactly `poolCents`, odd pennies handed out one each.
 */
export function calculateSharedShares(subtotals, poolCents, mode = 'equal') {
  if (!subtotals.length) return [];
  if (mode === 'proportional') return reconcileRounding(poolCents, subtotals);

  const participants = subtotals.map((subtotal) => (subtotal !== 0 ? 1 : 0));
  const anyParticipants = participants.some((weight) => weight === 1);
  return reconcileRounding(poolCents, anyParticipants ? participants : subtotals.map(() => 1));
}

/** Proportional sharing, kept under its original name. */
export function calculateTaxShares(subtotals, poolCents) {
  return calculateSharedShares(subtotals, poolCents, 'proportional');
}

/**
 * Full breakdown for a bill: per-person totals, per-item shares, reconciliation.
 * This is what every screen renders from.
 */
export function calculateFinalTotals(bill) {
  const items = bill?.items || [];
  const people = bill?.people || [];
  const currency = bill?.currency || 'USD';

  const itemShares = {};
  let assignedSubtotalCents = 0;
  let unassignedCents = 0;
  const unassigned = [];

  for (const item of items) {
    const result = calculateItemShares(item);
    itemShares[item.id] = result;
    if (result.assignedCount === 0) {
      unassignedCents += result.totalCents;
      unassigned.push({ id: item.id, name: item.name, totalCents: result.totalCents });
    } else {
      assignedSubtotalCents += result.totalCents;
    }
  }

  const subtotalCents = billSubtotalCents(bill);
  const taxCents = Math.trunc(bill?.taxCents || 0);
  const extraCents = Math.trunc(bill?.extraCents || 0);
  const totalCents = subtotalCents + taxCents + extraCents;

  const subtotals = people.map((person) =>
    sumCents(items, (item) => itemShares[item.id].shares[person.id] || 0),
  );
  const splitMode = bill?.sharedChargeSplit === 'proportional' ? 'proportional' : 'equal';
  const taxParts = calculateSharedShares(subtotals, taxCents, splitMode);
  const extraParts = calculateSharedShares(subtotals, extraCents, splitMode);

  const peopleTotals = people.map((person, index) => {
    const lines = [];
    for (const item of items) {
      const share = itemShares[item.id].shares[person.id];
      if (share === undefined) continue;
      lines.push({
        itemId: item.id,
        name: item.name,
        quantity: item.quantity,
        itemTotalCents: itemShares[item.id].totalCents,
        sharedWith: itemShares[item.id].assignedCount,
        shareCents: share,
      });
    }
    const subtotal = subtotals[index];
    const tax = taxParts[index] || 0;
    const extra = extraParts[index] || 0;
    return {
      id: person.id,
      name: person.name,
      color: person.color,
      lines,
      subtotalCents: subtotal,
      taxCents: tax,
      extraCents: extra,
      totalCents: subtotal + tax + extra,
    };
  });

  const chargedCents = sumCents(peopleTotals, (p) => p.totalCents);
  const declaredTotalCents = bill?.declaredTotalCents ?? null;
  const differenceCents = declaredTotalCents == null ? 0 : declaredTotalCents - totalCents;

  return {
    currency,
    peopleCount: people.length,
    itemCount: items.length,
    subtotalCents,
    assignedSubtotalCents,
    unassignedCents,
    taxCents,
    extraCents,
    // A negative pool is a discount or a correction, never a "tip".
    extraLabel: extraCents < 0 ? 'Adjustment' : bill?.extraLabel || 'Service & fees',
    splitMode,
    sharedPoolCents: taxCents + extraCents,
    totalCents,
    chargedCents,
    declaredSubtotalCents: bill?.declaredSubtotalCents ?? null,
    declaredTotalCents,
    differenceCents,
    people: peopleTotals,
    itemShares,
    unassignedItems: unassigned,
    // True when everything on the bill has an owner and the pennies line up.
    reconciles: unassignedCents === 0 && chargedCents === totalCents,
  };
}
