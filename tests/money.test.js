import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyInput, reconcileRounding, splitEvenly, toCents, formatMoney, centsToInput } from '../src/core/money.js';

test('parseMoneyInput handles the ways people type prices', () => {
  assert.equal(parseMoneyInput('12'), 1200);
  assert.equal(parseMoneyInput('12.5'), 1250);
  assert.equal(parseMoneyInput('$12.50'), 1250);
  assert.equal(parseMoneyInput(' 1,234.56 '), 123456);
  assert.equal(parseMoneyInput('12,50'), 1250, 'European decimal comma');
  assert.equal(parseMoneyInput('1.234,56'), 123456, 'European grouping');
  assert.equal(parseMoneyInput('(3.00)'), -300, 'accounting negative');
  assert.equal(parseMoneyInput('-3.00'), -300);
  assert.equal(parseMoneyInput(''), null);
  assert.equal(parseMoneyInput('   '), null);
  assert.equal(parseMoneyInput('abc'), null);
  assert.equal(parseMoneyInput(null), null);
});

test('toCents rounds half away from zero', () => {
  assert.equal(toCents(0.005), 1);
  assert.equal(toCents(-0.005), -1);
  assert.equal(toCents(19.999), 2000);
});

test('reconcileRounding never invents or loses a cent', () => {
  assert.deepEqual(reconcileRounding(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(reconcileRounding(1, [1, 1]), [1, 0]);
  assert.deepEqual(reconcileRounding(0, [1, 1, 1]), [0, 0, 0]);
  assert.deepEqual(reconcileRounding(-5, [1, 1]), [-3, -2]);
  for (const total of [1, 7, 99, 1234, 100003]) {
    for (const n of [1, 2, 3, 7, 11]) {
      const parts = splitEvenly(total, n);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total} across ${n}`);
      assert.ok(Math.max(...parts) - Math.min(...parts) <= 1, 'shares differ by at most a cent');
    }
  }
});

test('reconcileRounding falls back to an even split when weights are empty or zero', () => {
  assert.deepEqual(reconcileRounding(300, [0, 0, 0]), [100, 100, 100]);
  assert.deepEqual(reconcileRounding(300, []), []);
  assert.deepEqual(reconcileRounding(100, [3, 1]), [75, 25]);
});

test('formatting is stable', () => {
  assert.equal(formatMoney(4752), '$47.52');
  assert.equal(centsToInput(1999), '19.99');
  assert.equal(centsToInput(0), '0.00');
  assert.equal(centsToInput(null), '');
});
