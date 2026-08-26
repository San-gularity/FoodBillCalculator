import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../src/scanner/parse-receipt.js';
import { mergeReceiptDrafts, overlapLength } from '../src/scanner/merge-drafts.js';

// A long receipt photographed in two halves.
const TOP = `SPICE MART
Swad Sunflower Oil 2ltr 10.99
Garlic Naan 4.50
Veg Samosa 6.25
Mango Lassi 4.75`;

const BOTTOM = `Coke 2.00
Green Chili 2.99
Subtotal 31.48
Tax 2.52
Total 34.00`;

test('two halves of one receipt become a single bill', () => {
  const merged = mergeReceiptDrafts([parseReceipt(TOP), parseReceipt(BOTTOM)]);
  assert.deepEqual(merged.items.map((i) => i.name), [
    'Swad Sunflower Oil 2ltr', 'Garlic Naan', 'Veg Samosa', 'Mango Lassi', 'Coke', 'Green Chili',
  ]);
  assert.equal(merged.itemsSumCents, 3148, 'items add up across both photos');
  assert.equal(merged.subtotalCents, 3148);
  assert.equal(merged.taxCents, 252);
  assert.equal(merged.totalCents, 3400);
  assert.equal(merged.sourceCount, 2);
  assert.deepEqual(merged.warnings, [], 'a clean merge needs no attention');
  assert.ok(merged.items.every((i) => !i.needsReview));
});

test('lines caught in both photos are counted once', () => {
  const overlappingTop = `Pizza 20.00
Burger 12.00
Fries 8.00
Coke 4.00`;
  const overlappingBottom = `Fries 8.00
Coke 4.00
Salad 6.00
Subtotal 50.00
Tax 4.00
Total 54.00`;
  const merged = mergeReceiptDrafts([parseReceipt(overlappingTop), parseReceipt(overlappingBottom)]);
  assert.deepEqual(merged.items.map((i) => i.name), ['Pizza', 'Burger', 'Fries', 'Coke', 'Salad']);
  assert.equal(merged.itemsSumCents, 5000, 'the overlap is not double-counted');
  assert.ok(merged.warnings.some((w) => w.code === 'overlap-merged'));
});

test('a single repeated line is kept, because two of an item look the same', () => {
  const a = `Pizza 20.00
Coke 4.00`;
  const b = `Coke 4.00
Fries 8.00
Subtotal 36.00
Tax 3.00
Total 39.00`;
  const merged = mergeReceiptDrafts([parseReceipt(a), parseReceipt(b)]);
  assert.equal(merged.items.length, 4, 'both Cokes survive — the user can delete one');
  assert.equal(merged.itemsSumCents, 3600);
});

test('overlapLength finds the longest shared run', () => {
  const item = (name, cents) => ({ name, totalPriceCents: cents });
  const head = [item('A', 100), item('B', 200), item('C', 300)];
  assert.equal(overlapLength(head, [item('B', 200), item('C', 300), item('D', 400)]), 2);
  assert.equal(overlapLength(head, [item('C', 300)]), 1);
  assert.equal(overlapLength(head, [item('D', 400)]), 0);
  assert.equal(overlapLength(head, []), 0);
  assert.equal(overlapLength([], [item('A', 100)]), 0);
});

test('totals come from whichever photo actually shows them', () => {
  const merged = mergeReceiptDrafts([parseReceipt(TOP), parseReceipt(BOTTOM)]);
  assert.equal(merged.totalCents, 3400);

  // Reversed order (bottom photographed first) still finds them.
  const reversed = mergeReceiptDrafts([parseReceipt(BOTTOM), parseReceipt(TOP)]);
  assert.equal(reversed.totalCents, 3400);
  assert.equal(reversed.taxCents, 252);
});

test('two different tax lines across photos are added up', () => {
  const first = parseReceipt(`Pizza 20.00\nTax2 (1.25%) 0.25`);
  const second = parseReceipt(`Fries 8.00\nTax (10.25%) 2.87\nTotal 31.12`);
  const merged = mergeReceiptDrafts([first, second]);
  assert.equal(merged.taxCents, 312);
});

test('one unreadable photo doesn’t sink the others', () => {
  const merged = mergeReceiptDrafts([parseReceipt(TOP), null, parseReceipt(BOTTOM)]);
  assert.equal(merged.items.length, 6);
  assert.equal(merged.sourceCount, 2);
});

test('merging a single draft returns it untouched', () => {
  const only = parseReceipt(TOP);
  assert.equal(mergeReceiptDrafts([only]), only);
  assert.equal(mergeReceiptDrafts([]), null);
});

test('a mismatch across photos is reported once, on the merged total', () => {
  const merged = mergeReceiptDrafts([parseReceipt(TOP), parseReceipt(`Coke 2.00\nSubtotal 99.00\nTax 2.52\nTotal 101.52`)]);
  const mismatch = merged.warnings.filter((w) => w.code === 'subtotal-mismatch');
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].diffCents, merged.itemsSumCents - 9900);
});

test('a one-line overlap is dropped when the subtotal proves it', () => {
  const a = `Pizza 20.00
Coke 4.00`;
  const b = `Coke 4.00
Fries 8.00
Subtotal 32.00
Tax 2.80
Total 34.80`;
  const merged = mergeReceiptDrafts([parseReceipt(a), parseReceipt(b)]);
  assert.deepEqual(merged.items.map((i) => i.name), ['Pizza', 'Coke', 'Fries']);
  assert.equal(merged.itemsSumCents, 3200, 'matches the printed subtotal');
  assert.ok(merged.warnings.some((w) => w.code === 'overlap-merged'));
  assert.ok(!merged.warnings.some((w) => w.code === 'subtotal-mismatch'));
});

test('an unprovable one-line overlap is flagged, not silently kept or dropped', () => {
  const a = `Pizza 20.00
Coke 4.00`;
  const b = `Coke 4.00
Fries 8.00`;
  const merged = mergeReceiptDrafts([parseReceipt(a), parseReceipt(b)]);
  assert.equal(merged.items.length, 4, 'both Cokes kept');
  const flagged = merged.items.filter((i) => i.note);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].note, /both photos/i);
  assert.equal(flagged[0].needsReview, true);
});
