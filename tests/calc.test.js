import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBill, totalsByName, subtotalsByName } from './helpers.js';
import { calculateFinalTotals, calculateItemShares, calculatePersonSubtotal, calculateTaxShares } from '../src/core/calc.js';
import { createItem } from '../src/core/model.js';

test('one person, one item: they owe the whole thing', () => {
  const { bill } = makeBill({ people: ['San'], items: [{ name: 'Pizza', priceCents: 2000, people: ['San'] }] });
  const summary = calculateFinalTotals(bill);
  assert.deepEqual(totalsByName(summary), { San: 2000 });
  assert.equal(summary.reconciles, true);
});

test('the README example splits and taxes exactly', () => {
  const { bill } = makeBill({
    people: ['San', 'Alex', 'John'],
    items: [
      { name: 'Pizza', priceCents: 2000, people: ['San', 'Alex'] },
      { name: 'Burger', priceCents: 1200, people: ['John'] },
      { name: 'Fries', priceCents: 800, people: ['San', 'Alex', 'John'] },
      { name: 'Coke', priceCents: 400, people: ['Alex'] },
    ],
    taxCents: 352,
    declaredTotalCents: 4752,
  });
  const summary = calculateFinalTotals(bill);

  assert.equal(summary.subtotalCents, 4400);
  assert.equal(summary.totalCents, 4752);
  assert.equal(summary.differenceCents, 0, 'matches the printed receipt total');
  assert.deepEqual(subtotalsByName(summary), { San: 1267, Alex: 1667, John: 1466 });
  assert.equal(summary.chargedCents, summary.totalCents, 'sum(personTotal) === billTotal');
  assert.equal(summary.reconciles, true);
});

test('proportional tax matches the worked example ($100 + $10 tax, 60/40)', () => {
  const { bill } = makeBill({
    people: ['San', 'Alex'],
    items: [
      { name: 'Steak', priceCents: 6000, people: ['San'] },
      { name: 'Pasta', priceCents: 4000, people: ['Alex'] },
    ],
    taxCents: 1000,
  });
  const summary = calculateFinalTotals(bill);
  assert.deepEqual(totalsByName(summary), { San: 6600, Alex: 4400 });
});

test('items with different numbers of people all reconcile', () => {
  const { bill } = makeBill({
    people: ['A', 'B', 'C', 'D'],
    items: [
      { name: 'Shared 4', priceCents: 1001, people: ['A', 'B', 'C', 'D'] },
      { name: 'Shared 3', priceCents: 1000, people: ['A', 'B', 'C'] },
      { name: 'Shared 2', priceCents: 999, people: ['C', 'D'] },
      { name: 'Solo', priceCents: 333, people: ['B'] },
    ],
    taxCents: 277,
  });
  const summary = calculateFinalTotals(bill);
  assert.equal(summary.chargedCents, summary.totalCents);
  assert.equal(summary.subtotalCents, 1001 + 1000 + 999 + 333);
});

test('odd cents are distributed, never dropped or duplicated', () => {
  const { bill } = makeBill({
    people: ['A', 'B', 'C'],
    items: [{ name: 'Cake', priceCents: 1000, people: ['A', 'B', 'C'] }],
    taxCents: 1,
  });
  const summary = calculateFinalTotals(bill);
  const shares = summary.people.map((p) => p.subtotalCents).sort((a, b) => b - a);
  assert.deepEqual(shares, [334, 333, 333]);
  assert.equal(summary.chargedCents, 1001);
});

test('unassigned items are reported, not silently charged to someone', () => {
  const { bill } = makeBill({
    people: ['San', 'Alex'],
    items: [
      { name: 'Pizza', priceCents: 2000, people: ['San'] },
      { name: 'Mystery side', priceCents: 500, people: [] },
    ],
    taxCents: 0,
  });
  const summary = calculateFinalTotals(bill);
  assert.equal(summary.unassignedCents, 500);
  assert.equal(summary.unassignedItems.length, 1);
  assert.equal(summary.chargedCents, 2000);
  assert.equal(summary.reconciles, false, 'flagged as not reconciling while something is unassigned');
  assert.deepEqual(totalsByName(summary), { San: 2000, Alex: 0 });
});

test('tax with nothing assigned yet is shared evenly instead of crashing', () => {
  const { bill } = makeBill({
    people: ['A', 'B', 'C'],
    items: [{ name: 'Pizza', priceCents: 2000, people: [] }],
    taxCents: 300,
  });
  const summary = calculateFinalTotals(bill);
  assert.deepEqual(summary.people.map((p) => p.taxCents), [100, 100, 100]);
  assert.equal(summary.chargedCents, 300);
});

test('an empty bill produces zeroes, not NaN', () => {
  const summary = calculateFinalTotals({ items: [], people: [] });
  assert.equal(summary.subtotalCents, 0);
  assert.equal(summary.totalCents, 0);
  assert.equal(summary.chargedCents, 0);
  assert.deepEqual(summary.people, []);
  assert.equal(summary.reconciles, true);
});

test('quantities multiply into the line total', () => {
  const { bill } = makeBill({
    people: ['San', 'Alex'],
    items: [{ name: 'Biryani', quantity: 2, unitPriceCents: 1499, people: ['San', 'Alex'] }],
  });
  const summary = calculateFinalTotals(bill);
  assert.equal(summary.subtotalCents, 2998);
  assert.deepEqual(subtotalsByName(summary), { San: 1499, Alex: 1499 });
});

test('an explicit line total wins over quantity x unit price', () => {
  const item = createItem({ name: 'Wings', quantity: 3, unitPriceCents: 400, totalPriceCents: 1100 });
  assert.equal(calculateItemShares({ ...item, assignedTo: ['x'] }).totalCents, 1100);
});

test('discounts (negative lines) reduce a share and still reconcile', () => {
  const { bill } = makeBill({
    people: ['San', 'Alex'],
    items: [
      { name: 'Pizza', priceCents: 2000, people: ['San', 'Alex'] },
      { name: 'Coupon', priceCents: -500, people: ['San', 'Alex'] },
    ],
    taxCents: 150,
  });
  const summary = calculateFinalTotals(bill);
  assert.equal(summary.subtotalCents, 1500);
  assert.equal(summary.chargedCents, 1650);
  assert.deepEqual(totalsByName(summary), { San: 825, Alex: 825 });
});

test('tip and fees ride along with tax, proportionally', () => {
  const { bill } = makeBill({
    people: ['San', 'Alex'],
    items: [
      { name: 'Steak', priceCents: 7500, people: ['San'] },
      { name: 'Salad', priceCents: 2500, people: ['Alex'] },
    ],
    taxCents: 1000,
    extraCents: 2000,
  });
  const summary = calculateFinalTotals(bill);
  assert.deepEqual(totalsByName(summary), { San: 9750, Alex: 3250 });
  assert.equal(summary.chargedCents, summary.totalCents);
});

test('building blocks are usable on their own', () => {
  const item = createItem({ name: 'Nachos', unitPriceCents: 1000, assignedTo: ['a', 'b', 'c'] });
  const shares = calculateItemShares(item);
  assert.equal(shares.assignedCount, 3);
  assert.equal(Object.values(shares.shares).reduce((x, y) => x + y, 0), 1000);
  assert.equal(calculatePersonSubtotal('a', [item]), 334);
  assert.deepEqual(calculateTaxShares([334, 333, 333], 100), [34, 33, 33]);
});

test('a person assigned twice to the same item is only charged once', () => {
  const item = createItem({ name: 'Fries', unitPriceCents: 900, assignedTo: ['a', 'a', 'b'] });
  const shares = calculateItemShares(item);
  assert.equal(Object.values(shares.shares).reduce((x, y) => x + y, 0), 900);
  assert.equal(Object.keys(shares.shares).length, 2);
});

test('a big randomised bill always reconciles to the cent', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let round = 0; round < 200; round++) {
    const people = ['A', 'B', 'C', 'D', 'E'].slice(0, 2 + Math.floor(rand() * 4));
    const items = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => {
      const sharers = people.filter(() => rand() > 0.45);
      return {
        name: `Item ${i}`,
        priceCents: 1 + Math.floor(rand() * 5000),
        people: sharers.length ? sharers : [people[0]],
      };
    });
    const { bill } = makeBill({ people, items, taxCents: Math.floor(rand() * 900), extraCents: Math.floor(rand() * 500) });
    const summary = calculateFinalTotals(bill);
    assert.equal(summary.chargedCents, summary.totalCents, `round ${round}`);
    assert.equal(summary.reconciles, true, `round ${round}`);
  }
});

test('a negative pooled amount is labelled an adjustment, not a tip', () => {
  const { bill } = makeBill({
    people: ['San'],
    items: [{ name: 'Pizza', priceCents: 2000, people: ['San'] }],
    extraCents: -25,
  });
  const summary = calculateFinalTotals(bill);
  assert.equal(summary.extraLabel, 'Adjustment');
  assert.equal(summary.people[0].totalCents, 1975);
});
