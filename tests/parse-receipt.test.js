import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt, confidenceTier, itemsNeedingInput, markItemEdited } from '../src/scanner/parse-receipt.js';
import { draftToBillItems, draftToCharges } from '../src/scanner/to-bill.js';

const CLEAN_RECEIPT = `TASTY BITES
123 Main St
Tel (312) 555-0199
------------------------
2 x Chicken Biryani  29.98
Garlic Naan           4.50
Fries                 8.00
Coke                  2.00
------------------------
Subtotal             44.48
Sales Tax             3.56
TOTAL                48.04
VISA                 48.04
Thank you!`;

test('a clean receipt parses items, quantity and totals', () => {
  const draft = parseReceipt(CLEAN_RECEIPT);
  assert.deepEqual(
    draft.items.map((i) => [i.name, i.quantity, i.totalPriceCents]),
    [
      ['Chicken Biryani', 2, 2998],
      ['Garlic Naan', 1, 450],
      ['Fries', 1, 800],
      ['Coke', 1, 200],
    ],
  );
  assert.equal(draft.subtotalCents, 4448);
  assert.equal(draft.taxCents, 356);
  assert.equal(draft.totalCents, 4804);
  assert.equal(draft.items[0].unitPriceCents, 1499, 'unit price derived from quantity');
});

test('store headers, phone numbers and payment lines never become items', () => {
  const draft = parseReceipt(CLEAN_RECEIPT);
  const names = draft.items.map((i) => i.name.toLowerCase());
  assert.ok(!names.some((n) => n.includes('tel')));
  assert.ok(!names.some((n) => n.includes('visa')));
  assert.ok(!names.some((n) => n.includes('total')));
});

test('items matching the printed subtotal are trusted (no busywork for the user)', () => {
  const draft = parseReceipt(CLEAN_RECEIPT);
  assert.equal(draft.warnings.length, 0);
  assert.ok(draft.items.every((i) => !i.needsReview), 'nothing needs review on a clean scan');
  assert.equal(itemsNeedingInput(draft).length, 0);
});

test('a subtotal that disagrees with the items raises a warning', () => {
  const draft = parseReceipt(`Pizza 20.00
Fries 8.00
Subtotal 44.00
Tax 3.00
Total 47.00`);
  const warning = draft.warnings.find((w) => w.code === 'subtotal-mismatch');
  assert.ok(warning, 'mismatch reported');
  assert.equal(warning.diffCents, 2800 - 4400);
});

test('low-confidence OCR lines survive as items that need input', () => {
  const draft = parseReceipt([
    { text: 'Chicken ???', confidence: 41 },
    { text: 'Paneer Tikka 12.99', confidence: 92 },
    { text: 'TAX 1.38', confidence: 80 },
  ]);
  const unclear = itemsNeedingInput(draft);
  assert.equal(unclear.length, 1);
  assert.equal(unclear[0].totalPriceCents, null, 'price is left blank for the user');
  assert.equal(confidenceTier(unclear[0].confidence.overall), 'low');
  assert.equal(draft.taxCents, 138);
});

test('editing an uncertain item clears its review flag', () => {
  const draft = parseReceipt([{ text: 'Chicken ???', confidence: 41 }]);
  const fixed = markItemEdited(draft.items[0], { name: 'Chicken Biryani', totalPriceCents: 1499 });
  assert.equal(fixed.needsReview, false);
  assert.equal(confidenceTier(fixed.confidence.overall), 'high');
});

test('a price printed on the next line is paired with its item name', () => {
  const draft = parseReceipt(`Mango Lassi
4.25
Tax 0.40`);
  assert.equal(draft.items.length, 1);
  assert.equal(draft.items[0].name, 'Mango Lassi');
  assert.equal(draft.items[0].totalPriceCents, 425);
});

test('missing tax and total are reported rather than guessed', () => {
  const draft = parseReceipt(`Burrito 9.50
Chips 3.00`);
  assert.deepEqual(draft.warnings.map((w) => w.code).sort(), ['no-tax', 'no-total']);
  assert.equal(draft.taxCents, null);
  assert.equal(draft.totalCents, null);
});

test('a missing subtotal is derived from total minus tax', () => {
  const draft = parseReceipt(`Burrito 9.50
Chips 3.00
Tax 1.00
Total 13.50`);
  assert.equal(draft.subtotalCents, 1250);
});

test('multiple tax lines are added together', () => {
  const draft = parseReceipt(`Beer 8.00
State Tax 0.50
City Tax 0.25
Total 8.75`);
  assert.equal(draft.taxCents, 75);
});

test('European formatting is understood', () => {
  const draft = parseReceipt(`Pizza Margherita 12,50
Acqua 2,00
Totale 14,50`);
  assert.deepEqual(draft.items.map((i) => i.totalPriceCents), [1250, 200]);
  assert.equal(draft.totalCents, 1450);
});

test('an unreadable image yields an empty draft with a clear warning', () => {
  const draft = parseReceipt('');
  assert.equal(draft.items.length, 0);
  assert.ok(draft.warnings.some((w) => w.code === 'no-items'));
});

test('draft converts into bill items, dropping anything still blank', () => {
  const draft = parseReceipt(CLEAN_RECEIPT);
  draft.items.push({ id: 'x', name: '', quantity: 1, unitPriceCents: null, totalPriceCents: null, confidence: { name: 0, price: 0, overall: 0 }, status: 'pending' });
  const items = draftToBillItems(draft);
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => i.source === 'scan'));
});

test('an unexplained gap between items+tax and the receipt total becomes tip & fees', () => {
  const draft = parseReceipt(`Steak 40.00
Tax 4.00
Total 52.00`);
  const charges = draftToCharges(draft);
  assert.equal(charges.itemsSumCents, 4000);
  assert.equal(charges.taxCents, 400);
  assert.equal(charges.extraCents, 800, 'the $8 tip is captured');
  assert.equal(charges.declaredTotalCents, 5200);
});

test('a printed tip line is used as-is', () => {
  const draft = parseReceipt(`Steak 40.00
Tax 4.00
Tip 8.00
Total 52.00`);
  const charges = draftToCharges(draft);
  assert.equal(charges.extraCents, 800);
});

test('an item whose price column was missed becomes a row that needs a price', () => {
  const draft = parseReceipt(`TASTY BITES
Chicken Biryani 14.99
Garlic Naan
Coke 2.00
Subtotal 21.49
Tax 1.80
Total 23.29
Thank you`);
  assert.deepEqual(draft.items.map((i) => i.name), ['Chicken Biryani', 'Garlic Naan', 'Coke']);
  const naan = draft.items[1];
  assert.equal(naan.totalPriceCents, null);
  assert.equal(confidenceTier(naan.confidence.overall), 'low');
  assert.deepEqual(itemsNeedingInput(draft).map((i) => i.name), ['Garlic Naan']);
});

test('store names and footers outside the item block are not turned into items', () => {
  const draft = parseReceipt(CLEAN_RECEIPT);
  const names = draft.items.map((i) => i.name);
  assert.ok(!names.includes('Tasty Bites'));
  assert.ok(!names.some((n) => /thank/i.test(n)));
  assert.equal(draft.items.length, 4);
});

test('reference numbers are never mistaken for prices', () => {
  const draft = parseReceipt(`GOOD EATS
Order #4471
Check No. 88213
Terminal 3
REG #4
#100234
Table 12
Chicken Biryani 14.99
Coke 2.00
Loyalty points 250
Subtotal 16.99
Tax 1.40
Total 18.39`);
  assert.deepEqual(draft.items.map((i) => i.name), ['Chicken Biryani', 'Coke']);
  assert.equal(draft.itemsSumCents, 1699);
  assert.equal(draft.totalCents, 1839);
});

// A real grocery receipt: wrapped item names, a repeated line, two tax lines,
// and card-terminal chatter above the items.
const GROCERY_RECEIPT = `Authorization: 09808D
Visa Credit
AID A0 00 00 00 00 03 10 10
Verified on Device
Swad Sunflower Oil 2ltr $10.99
Chings Singapore Curry Noodles $2.49
300g
Ching's Manchurian Noodles $2.49
240gm
Laxmi Ginger Garlic Paste 748gm $5.99
Britannia Suji Rusk 610gm $4.99
Deep Fenugreek Seeds200g $1.99
Milk Bikis Sandwich 88gm $1.29
Curry Leaf $1.99
Laxmi Frozen Bhindi 300gm $2.99
MTR Puliogare Paste 200gm $2.49
Dabur Real Pomegtanate Juice 1 $3.99
liter
Cilantro/Coriander Fresh $0.99
2 Bunch
Lijjat Papad Varieties $1.99
Parle G 799g $3.99
Parle G 799g
Maggie Masala Noodles 600gm $6.99
Palmolive 12.6 Oz $2.99
Everest Chicken Masala 100gm $2.99
Green Chili $2.99
Subtotal $64.62
Tax2 (1.25%) $0.77
Tax (10.25%) $0.31
Total $65.70
Visa 1409 (Contactless) $65.70
New Cafe is
Now Open at Metro Spice Mart!
See you there,`;

test('a real grocery receipt parses to the cent', () => {
  const draft = parseReceipt(GROCERY_RECEIPT);
  assert.equal(draft.items.length, 18);
  assert.equal(draft.itemsSumCents, 6462, 'items add up to the printed subtotal');
  assert.equal(draft.subtotalCents, 6462);
  assert.equal(draft.taxCents, 108, 'both tax lines are added together');
  assert.equal(draft.totalCents, 6570);
  assert.deepEqual(draft.warnings, []);
  assert.ok(draft.items.every((i) => !i.needsReview), 'nothing needs the user’s attention');
});

test('card terminal lines never become items', () => {
  const names = parseReceipt(GROCERY_RECEIPT).items.map((i) => i.name.toLowerCase());
  for (const junk of ['aid', 'authorization', 'verified', 'visa', 'tax2']) {
    assert.ok(!names.some((n) => n.includes(junk)), `"${junk}" is not an item`);
  }
});

test('a wrapped item name is joined to the item above it', () => {
  const draft = parseReceipt(GROCERY_RECEIPT);
  const names = draft.items.map((i) => i.name);
  assert.ok(names.includes('Chings Singapore Curry Noodles 300g'));
  assert.ok(names.includes('Dabur Real Pomegtanate Juice 1 liter'));
  assert.ok(names.includes('Cilantro/Coriander Fresh 2 Bunch'));
  assert.ok(!names.includes('300g') && !names.includes('Liter') && !names.includes('Bunch'));
});

test('a name printed twice is one item, not two', () => {
  const draft = parseReceipt(GROCERY_RECEIPT);
  assert.equal(draft.items.filter((i) => i.name.startsWith('Parle G')).length, 1);
});

test('brand acronyms and apostrophes survive tidying', () => {
  const names = parseReceipt(GROCERY_RECEIPT).items.map((i) => i.name);
  assert.ok(names.includes('MTR Puliogare Paste 200gm'), 'MTR stays uppercase');
  assert.ok(names.some((n) => n.startsWith("Ching's")), "Ching's keeps its apostrophe");
});

test('numbered tax lines are recognised as tax', () => {
  for (const line of ['Tax2 (1.25%) 0.77', 'TAX 1 0.50', 'VAT2 1.10', 'Taxes 2.00']) {
    const draft = parseReceipt(`Pizza 10.00\n${line}\nTotal 12.00`);
    assert.equal(draft.items.length, 1, `"${line}" is not an item`);
    assert.ok(draft.taxCents > 0, `"${line}" counted as tax`);
  }
});

test('a repeated line still merges when OCR garbles a character', () => {
  const draft = parseReceipt(`Parle G 799g 3.99
Parle G 799¢g
Coke 2.00
Subtotal 5.99
Tax 0.50
Total 6.49`);
  assert.deepEqual(draft.items.map((i) => i.name), ['Parle G 799g', 'Coke']);
  assert.equal(draft.itemsSumCents, 599);
});

test('two genuinely separate lines with short names stay separate', () => {
  const draft = parseReceipt(`Coke 2.00
Coke 2.00
Subtotal 4.00
Tax 0.35
Total 4.35`);
  assert.equal(draft.items.length, 2, 'both priced lines are kept');
  assert.equal(draft.itemsSumCents, 400);
});
