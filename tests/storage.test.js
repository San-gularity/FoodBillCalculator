import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStoredState, createEnvelope, coerceBill } from '../src/storage/migrate.js';
import { createBillRepository } from '../src/storage/repository.js';
import { createMemoryAdapter } from '../src/storage/adapters.js';
import { SCHEMA_VERSION, createBill, createItem, createPerson } from '../src/core/model.js';
import { makeBill } from './helpers.js';

test('a round trip preserves the whole bill', () => {
  const { bill } = makeBill({
    people: ['San', 'Alex'],
    items: [{ name: 'Pizza', priceCents: 2000, people: ['San', 'Alex'] }],
    taxCents: 200,
  });
  const restored = normalizeStoredState(createEnvelope({ bill, ui: { step: 'assign', expandedPersonId: null } }));
  assert.equal(restored.recovered, false);
  assert.equal(restored.ui.step, 'assign');
  assert.deepEqual(restored.bill.items[0].assignedTo, bill.items[0].assignedTo);
  assert.equal(restored.bill.taxCents, 200);
});

test('missing, malformed and hostile storage never crashes the app', () => {
  assert.equal(normalizeStoredState(null), null);
  assert.equal(normalizeStoredState(undefined), null);

  for (const junk of ['{not json', '"a string"', 42, [], { version: 'x' }, { version: 2, bill: 'nope' }]) {
    const result = normalizeStoredState(junk);
    assert.ok(result.bill, `usable bill for ${JSON.stringify(junk)}`);
    assert.ok(Array.isArray(result.bill.items));
    assert.ok(Array.isArray(result.bill.people));
    assert.equal(result.ui.step, 'items');
  }
});

test('partly damaged items and people are repaired, and the user is told', () => {
  const result = normalizeStoredState({
    version: SCHEMA_VERSION,
    bill: {
      items: [{ name: 'Pizza', unitPriceCents: 2000, assignedTo: ['ghost'] }, null, 'garbage'],
      people: [{ name: 'San', id: 'p1' }, 42],
      taxCents: 'abc',
    },
  });
  assert.equal(result.bill.items.length, 1);
  assert.equal(result.bill.people.length, 1);
  assert.deepEqual(result.bill.items[0].assignedTo, [], 'assignment to a deleted person is dropped');
  assert.equal(result.bill.taxCents, 0);
  assert.equal(result.recovered, true);
});

test('a v1 bill migrates into the current model', () => {
  const result = normalizeStoredState({
    version: 1,
    items: { Pizza: 20, Fries: 8 },
    people: { San: ['Pizza', 'Fries'], Alex: ['Fries'] },
    tax: 2.8,
  });
  assert.equal(result.bill.items.length, 2);
  assert.equal(result.bill.people.length, 2);
  assert.equal(result.bill.taxCents, 280);
  const fries = result.bill.items.find((i) => i.name === 'Fries');
  assert.equal(fries.assignedTo.length, 2);
  assert.equal(result.recovered, true);
});

test('data written by a newer version is flagged instead of trusted blindly', () => {
  const result = normalizeStoredState({ version: SCHEMA_VERSION + 5, bill: createBill() });
  assert.equal(result.recovered, true);
  assert.ok(result.bill);
});

test('coerceBill keeps valid people colours and ids', () => {
  const person = createPerson('San', 0);
  const item = createItem({ name: 'Pizza', unitPriceCents: 100, assignedTo: [person.id] });
  const bill = coerceBill({ people: [person], items: [item] });
  assert.equal(bill.people[0].id, person.id);
  assert.equal(bill.people[0].color, person.color);
  assert.deepEqual(bill.items[0].assignedTo, [person.id]);
});

test('the repository saves, restores and archives through an adapter', async () => {
  const adapter = createMemoryAdapter();
  const repo = createBillRepository({ adapters: [adapter], debounceMs: 0 });
  const { bill } = makeBill({ people: ['San'], items: [{ name: 'Pizza', priceCents: 2000, people: ['San'] }] });

  repo.save({ bill, ui: { step: 'review' } });
  await repo.flush();

  const restored = await repo.load();
  assert.equal(restored.bill.items[0].name, 'Pizza');
  assert.equal(restored.ui.step, 'review');

  await repo.archive(bill);
  const history = await repo.listArchived();
  assert.equal(history.length, 1);
  assert.equal(history[0].id, bill.id);

  await repo.clear();
  assert.equal(await repo.load(), null);
});

test('a failing storage backend degrades instead of throwing', async () => {
  const broken = {
    name: 'broken',
    async init() {
      throw new Error('blocked by browser settings');
    },
    async get() {},
    async set() {},
    async remove() {},
    async keys() {
      return [];
    },
  };
  const errors = [];
  const repo = createBillRepository({ adapters: [broken], debounceMs: 0, onError: (e) => errors.push(e.code) });
  const { bill } = makeBill({ people: ['San'], items: [] });

  repo.save({ bill, ui: { step: 'items' } });
  await repo.flush();
  const restored = await repo.load();

  assert.ok(restored, 'still returns something usable');
  assert.ok(errors.includes('storage-unavailable'), 'user gets told once');
});

test('a quota error retries without the receipt photo', async () => {
  const stored = new Map();
  let rejectBig = true;
  const adapter = {
    name: 'tiny',
    async init() {},
    async get(key) {
      return stored.get(key) ?? null;
    },
    async set(key, value) {
      if (rejectBig && value.bill.receipt?.thumbnail) {
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      }
      stored.set(key, value);
    },
    async remove(key) {
      stored.delete(key);
    },
    async keys() {
      return [...stored.keys()];
    },
  };
  const errors = [];
  const repo = createBillRepository({ adapters: [adapter], debounceMs: 0, onError: (e) => errors.push(e.code) });
  const bill = createBill();
  bill.receipt = { id: 'r', thumbnail: 'data:image/jpeg;base64,AAAA', rawText: '', provider: 'tesseract', capturedAt: null };

  repo.save({ bill, ui: { step: 'items' } });
  await repo.flush();

  assert.ok(errors.includes('storage-quota'));
  const restored = await repo.load();
  assert.equal(restored.bill.receipt.thumbnail, null, 'saved without the photo rather than not at all');
});

test('saved bills can be listed, reopened, edited in place and deleted', async () => {
  const repo = createBillRepository({ adapters: [createMemoryAdapter()], debounceMs: 0 });
  const { bill } = makeBill({ people: ['San'], items: [{ name: 'Pizza', priceCents: 2000, people: ['San'] }] });

  await repo.archive(bill);
  let list = await repo.listArchived();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, bill.name);

  // Reopening returns a repaired, usable bill.
  const entry = await repo.getArchived(bill.id);
  assert.equal(entry.bill.items[0].name, 'Pizza');

  // Editing a saved bill keeps the saved copy in step, without archiving twice.
  const edited = { ...entry.bill, name: 'Dinner with San' };
  repo.save({ bill: edited, ui: { step: 'items' } });
  await repo.flush();
  list = await repo.listArchived();
  assert.equal(list.length, 1, 'still one entry');
  assert.equal(list[0].bill.name, 'Dinner with San', 'the saved copy was updated');

  assert.equal(await repo.deleteArchived(bill.id), true);
  assert.deepEqual(await repo.listArchived(), []);
  assert.equal(await repo.getArchived(bill.id), null);
  assert.equal(await repo.deleteArchived('nope'), false);
});

test('a deleted bill stops being re-saved by later edits', async () => {
  const repo = createBillRepository({ adapters: [createMemoryAdapter()], debounceMs: 0 });
  const { bill } = makeBill({ people: ['San'], items: [] });
  await repo.archive(bill);
  await repo.deleteArchived(bill.id);

  repo.save({ bill: { ...bill, name: 'Changed' }, ui: { step: 'items' } });
  await repo.flush();
  assert.deepEqual(await repo.listArchived(), [], 'edits do not resurrect a deleted bill');
});

test('clearing the archive removes every saved bill', async () => {
  const repo = createBillRepository({ adapters: [createMemoryAdapter()], debounceMs: 0 });
  const a = makeBill({ people: ['San'], items: [] }).bill;
  const b = makeBill({ people: ['Alex'], items: [] }).bill;
  await repo.archive(a);
  await repo.archive(b);
  assert.equal((await repo.listArchived()).length, 2);
  await repo.clearArchive();
  assert.deepEqual(await repo.listArchived(), []);
});

test('people are remembered across bills, most recent first, and can be forgotten', async () => {
  const repo = createBillRepository({ adapters: [createMemoryAdapter()], debounceMs: 0 });
  await repo.rememberPeople([{ name: 'San', color: '#6366f1' }, { name: 'Alex', color: '#ec4899' }]);
  await repo.rememberPeople([{ name: 'John' }]);

  let roster = await repo.loadRoster();
  assert.deepEqual(roster.map((p) => p.name).sort(), ['Alex', 'John', 'San']);
  assert.equal(roster[0].name, 'John', 'most recently used comes first');
  assert.equal(roster.find((p) => p.name === 'San').color, '#6366f1', 'colour is remembered');

  await repo.rememberPeople([{ name: 'San' }]);
  roster = await repo.loadRoster();
  assert.equal(roster.length, 3, 'no duplicates');
  assert.equal(roster[0].name, 'San');
  assert.equal(roster[0].uses, 2);

  roster = await repo.forgetPerson('alex');
  assert.deepEqual(roster.map((p) => p.name).sort(), ['John', 'San']);
});

test('settings round trip and survive a missing store', async () => {
  const repo = createBillRepository({ adapters: [createMemoryAdapter()], debounceMs: 0 });
  assert.deepEqual(await repo.loadSettings(), {});
  await repo.saveSettings({ aiEnabled: true, geminiApiKey: 'abc123' });
  assert.deepEqual(await repo.loadSettings(), { aiEnabled: true, geminiApiKey: 'abc123' });
});

test('names added in quick succession are all remembered', async () => {
  const repo = createBillRepository({ adapters: [createMemoryAdapter()], debounceMs: 0 });
  // No awaits between calls: this is what three fast Enter presses look like.
  repo.rememberPeople([{ name: 'San' }]);
  repo.rememberPeople([{ name: 'Alex' }]);
  const roster = await repo.rememberPeople([{ name: 'John' }]);
  assert.deepEqual(roster.map((p) => p.name).sort(), ['Alex', 'John', 'San']);
  assert.deepEqual((await repo.loadRoster()).map((p) => p.name).sort(), ['Alex', 'John', 'San']);
});
