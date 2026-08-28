import { createBill, createItem, createPerson } from '../src/core/model.js';

/** Build a bill from a compact spec, returning the bill plus name->id maps. */
export function makeBill({
  people = [],
  items = [],
  taxCents = 0,
  extraCents = 0,
  declaredTotalCents = null,
  sharedChargeSplit = 'equal',
} = {}) {
  const bill = createBill();
  const byName = {};
  people.forEach((name, index) => {
    const person = createPerson(name, index);
    byName[name] = person.id;
    bill.people.push(person);
  });
  items.forEach((spec) => {
    bill.items.push(
      createItem({
        name: spec.name,
        quantity: spec.quantity ?? 1,
        unitPriceCents: spec.unitPriceCents ?? spec.priceCents,
        totalPriceCents: spec.totalPriceCents ?? null,
        assignedTo: (spec.people || []).map((name) => byName[name]),
      }),
    );
  });
  bill.taxCents = taxCents;
  bill.extraCents = extraCents;
  bill.declaredTotalCents = declaredTotalCents;
  bill.sharedChargeSplit = sharedChargeSplit;
  return { bill, ids: byName };
}

export function totalsByName(summary) {
  return Object.fromEntries(summary.people.map((person) => [person.name, person.totalCents]));
}

export function subtotalsByName(summary) {
  return Object.fromEntries(summary.people.map((person) => [person.name, person.subtotalCents]));
}
