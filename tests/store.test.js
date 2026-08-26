import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/state/store.js';
import { calculateFinalTotals } from '../src/core/calc.js';
import { validateBill } from '../src/core/model.js';

function seeded() {
  const store = createStore();
  const san = store.addPerson('San');
  const alex = store.addPerson('Alex');
  const pizza = store.addItem({ name: 'Pizza', unitPriceCents: 2000 });
  const fries = store.addItem({ name: 'Fries', unitPriceCents: 800 });
  return { store, san, alex, pizza, fries };
}

test('adding people rejects blanks and duplicates', () => {
  const store = createStore();
  assert.ok(store.addPerson('San'));
  assert.equal(store.addPerson('   '), null);
  assert.deepEqual(store.addPerson('san'), { duplicate: true });
  assert.equal(store.getBill().people.length, 1);
});

test('removing a person clears their assignments', () => {
  const { store, san, alex, pizza } = seeded();
  store.setAssignment(pizza.id, [san.id, alex.id]);
  store.removePerson(alex.id);
  assert.deepEqual(store.getBill().items[0].assignedTo, [san.id]);
});

test('toggling assignment is idempotent both ways', () => {
  const { store, san, pizza } = seeded();
  store.toggleAssignment(pizza.id, san.id);
  assert.deepEqual(store.getBill().items[0].assignedTo, [san.id]);
  store.toggleAssignment(pizza.id, san.id);
  assert.deepEqual(store.getBill().items[0].assignedTo, []);
});

test('“split the rest” only touches unassigned items', () => {
  const { store, san, pizza, fries } = seeded();
  store.setAssignment(pizza.id, [san.id]);
  const touched = store.assignEveryoneToUnassigned();
  assert.equal(touched, 1);
  assert.deepEqual(store.getBill().items.find((i) => i.id === pizza.id).assignedTo, [san.id]);
  assert.equal(store.getBill().items.find((i) => i.id === fries.id).assignedTo.length, 2);
});

test('editing a price recalculates the split', () => {
  const { store, san, alex, pizza } = seeded();
  store.setAssignment(pizza.id, [san.id, alex.id]);
  store.updateItem(pizza.id, { unitPriceCents: 3000 });
  const summary = calculateFinalTotals(store.getBill());
  assert.equal(summary.people[0].subtotalCents, 1500);
});

test('undo restores the previous bill after a destructive action', () => {
  const { store, pizza } = seeded();
  assert.equal(store.getBill().items.length, 2);
  store.removeItem(pizza.id);
  assert.equal(store.getBill().items.length, 1);
  assert.equal(store.undo(), true);
  assert.equal(store.getBill().items.length, 2);
  assert.equal(store.canUndo(), false);
});

test('subscribers are notified on every change', () => {
  const store = createStore();
  let calls = 0;
  const off = store.subscribe(() => (calls += 1));
  store.addPerson('San');
  store.addItem({ name: 'Pizza', unitPriceCents: 100 });
  off();
  store.addPerson('Alex');
  assert.equal(calls, 2);
});

test('validation surfaces the things the user still has to do', () => {
  const { store, pizza, san } = seeded();
  store.setAssignment(pizza.id, [san.id]);
  const codes = validateBill(store.getBill()).map((i) => i.code);
  assert.ok(codes.includes('unassigned'));

  store.assignEveryoneToUnassigned();
  assert.ok(!validateBill(store.getBill()).some((i) => i.code === 'unassigned'));
});

test('a zero-priced item is flagged rather than ignored', () => {
  const store = createStore();
  store.addItem({ name: 'Water', unitPriceCents: 0 });
  const issue = validateBill(store.getBill()).find((i) => i.code === 'zero-price');
  assert.ok(issue);
  assert.equal(issue.itemIds.length, 1);
});

test('a receipt lands as items plus charges in one step', () => {
  const store = createStore();
  store.addItems(
    [
      { name: 'Pizza', quantity: 1, unitPriceCents: 2000, totalPriceCents: 2000, source: 'scan' },
      { name: 'Fries', quantity: 1, unitPriceCents: 800, totalPriceCents: 800, source: 'scan' },
    ],
    { taxCents: 224, extraCents: 0, declaredTotalCents: 3024, receipt: { id: 'r1', provider: 'tesseract' } },
  );
  const bill = store.getBill();
  assert.equal(bill.items.length, 2);
  assert.equal(bill.taxCents, 224);
  assert.equal(bill.receipt.id, 'r1');
  assert.equal(calculateFinalTotals(bill).differenceCents, 0);
});

test('remembered people survive every bill-level change', () => {
  const store = createStore({ session: { roster: [{ name: 'San' }], archivedCount: 2 } });
  store.addPerson('Alex');
  store.newBill(false);
  assert.deepEqual(store.getState().session.roster, [{ name: 'San' }]);
  assert.equal(store.getState().session.archivedCount, 2);
  store.replaceState({ bill: undefined, ui: { step: 'items' } });
  assert.deepEqual(store.getState().session.roster, [{ name: 'San' }]);
});

test('a saved bill can be reopened for editing', () => {
  const store = createStore();
  const saved = { ...store.getBill(), id: 'bill_old', name: 'Friday dinner', items: [], people: [] };
  store.loadBill(saved);
  assert.equal(store.getBill().id, 'bill_old');
  assert.equal(store.getState().ui.step, 'items');
  assert.equal(store.undo(), true, 'reopening is undoable');
});

test('a receipt total that disagrees can be settled from either side', () => {
  const store = createStore();
  store.addItem({ name: 'Pizza', unitPriceCents: 2000 });
  store.setTax(352);
  store.setDeclared({ totalCents: 4752 });

  const mismatch = () => validateBill(store.getBill()).find((i) => i.code === 'total-mismatch');
  assert.ok(mismatch(), 'flagged while the two disagree');
  assert.equal(mismatch().diffCents, 4752 - 2352);

  // "My items are right": adopt the computed total.
  store.setDeclared({ totalCents: calculateFinalTotals(store.getBill()).totalCents }, { undoable: true });
  assert.equal(mismatch(), undefined);

  // Undo puts the receipt total back, and the warning with it.
  assert.equal(store.undo(), true);
  assert.ok(mismatch());

  // "The receipt is right": book the gap as tip/fees instead.
  store.absorbDifferenceAsExtra(calculateFinalTotals(store.getBill()).differenceCents);
  assert.equal(mismatch(), undefined);
  assert.equal(calculateFinalTotals(store.getBill()).totalCents, 4752);
});

test('tax alone can push the bill past the receipt total, and that is flagged', () => {
  const store = createStore();
  store.addItem({ name: 'Pizza', unitPriceCents: 2000 });
  store.setDeclared({ totalCents: 2200 });
  store.setTax(1000);
  const issue = validateBill(store.getBill()).find((i) => i.code === 'total-mismatch');
  assert.ok(issue, 'over-by-tax is reported');
  assert.equal(issue.diffCents, 2200 - 3000, 'the bill is $8 over the receipt');
});
