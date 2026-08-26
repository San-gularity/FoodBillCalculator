import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftFromStructured, confidenceTier, itemsNeedingInput } from '../src/scanner/parse-receipt.js';
import { draftToCharges } from '../src/scanner/to-bill.js';

const GEMINI_RESPONSE = {
  merchant: 'Tasty Bites',
  currency: 'USD',
  items: [
    { name: 'Chicken Biryani', quantity: 2, unit_price: 14.99, total_price: 29.98, confidence: 0.97 },
    { name: 'Garlic Naan', quantity: 1, unit_price: 4.5, total_price: 4.5, confidence: 0.95 },
    { name: 'Mango Lassi', quantity: 1, unit_price: null, total_price: 4.75, confidence: 0.62 },
  ],
  subtotal: 39.23,
  tax: 3.14,
  tip: null,
  total: 42.37,
};

test('structured AI output becomes the same review draft as OCR text', () => {
  const draft = createDraftFromStructured(GEMINI_RESPONSE, { provider: 'gemini' });
  assert.equal(draft.provider, 'gemini');
  assert.equal(draft.merchant, 'Tasty Bites');
  assert.deepEqual(
    draft.items.map((i) => [i.name, i.quantity, i.totalPriceCents, i.unitPriceCents]),
    [
      ['Chicken Biryani', 2, 2998, 1499],
      ['Garlic Naan', 1, 450, 450],
      ['Mango Lassi', 1, 475, 475],
    ],
  );
  assert.equal(draft.subtotalCents, 3923);
  assert.equal(draft.taxCents, 314);
  assert.equal(draft.totalCents, 4237);
  assert.equal(draft.warnings.length, 0);
});

test('model confidence drives what the user is asked to check', () => {
  const draft = createDraftFromStructured(GEMINI_RESPONSE);
  assert.equal(draft.items[0].needsReview, false, 'high confidence is accepted silently');
  assert.equal(confidenceTier(draft.items[2].confidence.overall), 'medium', 'a hesitant line is flagged');
  assert.equal(itemsNeedingInput(draft).length, 0, 'medium confidence never blocks');
});

test('a missing price from the model becomes a row the user has to fill in', () => {
  const draft = createDraftFromStructured({
    items: [{ name: 'Chicken ???', quantity: 1, total_price: null, confidence: 0.3 }],
    tax: 1,
  });
  assert.equal(draft.items[0].totalPriceCents, null);
  assert.equal(confidenceTier(draft.items[0].confidence.overall), 'low');
  assert.deepEqual(itemsNeedingInput(draft).map((i) => i.name), ['Chicken ???']);
});

test('junk, missing fields and wrong types never crash the normaliser', () => {
  for (const input of [null, undefined, 'nope', 42, [], {}, { items: 'no' }, { items: [null, 5, {}] }]) {
    const draft = createDraftFromStructured(input);
    assert.ok(Array.isArray(draft.items));
    assert.ok(draft.warnings.some((w) => w.code === 'no-items'));
  }
});

test('a model total that disagrees with its own items is reported, not hidden', () => {
  const draft = createDraftFromStructured({
    items: [{ name: 'Pizza', total_price: 20, confidence: 0.9 }],
    subtotal: 28,
    tax: 2,
    total: 30,
  });
  assert.ok(draft.warnings.some((w) => w.code === 'subtotal-mismatch'));
  const charges = draftToCharges(draft);
  assert.equal(charges.extraCents, 800, 'the unexplained $8 becomes an explicit line');
  assert.equal(charges.itemsSumCents + charges.taxCents + charges.extraCents, 3000);
});

test('quantity is used when only a unit price comes back', () => {
  const draft = createDraftFromStructured({
    items: [{ name: 'Samosa', quantity: 3, unit_price: 2.5, total_price: null, confidence: 0.9 }],
  });
  assert.equal(draft.items[0].totalPriceCents, 750);
});

// The exact reply Gemini returned for a real grocery receipt: its own key names
// ("line_items"/"item"), no subtotal or total, and a line printed twice.
const GEMINI_LINE_ITEMS_REPLY = {
  line_items: [
    { item: 'Swad Sunflower Oil 2ltr', quantity: 1, total_price: 10.99, confidence: 1.0 },
    { item: 'Chings Singapore Curry Noodles 300g', quantity: 1, total_price: 2.49, confidence: 1.0 },
    { item: 'Curry Leaf', quantity: 1, total_price: 1.99, confidence: 1.0 },
    { item: 'Parle G 799g', quantity: 1, total_price: 3.99, confidence: 1.0 },
    { item: 'Parle G 799g', quantity: 1, total_price: 3.99, confidence: 1.0 },
    { item: 'Green Chili', quantity: 1, total_price: 2.99, confidence: 1.0 },
  ],
  tax: 1.08,
  confidence: 1.0,
};

test('a model that renames the keys still produces items', () => {
  const draft = createDraftFromStructured(GEMINI_LINE_ITEMS_REPLY, { provider: 'gemini' });
  assert.equal(draft.items.length, 6, 'line_items/item are understood');
  assert.equal(draft.items[0].name, 'Swad Sunflower Oil 2ltr');
  assert.equal(draft.items[0].totalPriceCents, 1099);
  assert.equal(draft.taxCents, 108);
});

test('other common key spellings are understood too', () => {
  const draft = createDraftFromStructured({
    products: [{ description: 'Pizza', qty: 2, price_each: 10, line_total: 20, score: 0.9 }],
    sub_total: 20,
    sales_tax: 1.75,
    grand_total: 21.75,
  });
  assert.deepEqual(draft.items.map((i) => [i.name, i.quantity, i.unitPriceCents, i.totalPriceCents]), [['Pizza', 2, 1000, 2000]]);
  assert.equal(draft.subtotalCents, 2000);
  assert.equal(draft.taxCents, 175);
  assert.equal(draft.totalCents, 2175);
});

test('a line printed twice is dropped when that makes the subtotal match', () => {
  const draft = createDraftFromStructured({ ...GEMINI_LINE_ITEMS_REPLY, subtotal: 22.45, total: 23.53 });
  assert.equal(draft.items.length, 5, 'the repeat is counted once');
  assert.equal(draft.itemsSumCents, 2245);
  assert.ok(draft.warnings.some((w) => w.code === 'duplicate-removed'));
  assert.ok(!draft.warnings.some((w) => w.code === 'subtotal-mismatch'));
});

test('an unprovable repeat is flagged for the user instead of charged twice', () => {
  const draft = createDraftFromStructured(GEMINI_LINE_ITEMS_REPLY);
  const repeat = draft.items[4];
  assert.equal(repeat.name, 'Parle G 799g');
  assert.equal(repeat.needsReview, true, 'shown with a warning');
  assert.match(repeat.note, /appears twice/i);
  assert.equal(draft.items[3].needsReview, false, 'the first one is fine');
});

test('a missing total is derived from subtotal and tax (and vice versa)', () => {
  const fromParts = createDraftFromStructured({ items: [{ name: 'Pizza', total_price: 20, confidence: 1 }], subtotal: 20, tax: 1.75 });
  assert.equal(fromParts.totalCents, 2175);

  const fromTotal = createDraftFromStructured({ items: [{ name: 'Pizza', total_price: 20, confidence: 1 }], tax: 1.75, total: 21.75 });
  assert.equal(fromTotal.subtotalCents, 2000);
});
