// Money helpers. Every amount in the app is stored as an integer number of
// cents so that splitting, tax and totals never drift through float rounding.

/** Round a float to the nearest cent (half away from zero, like a till does). */
export function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 100);
}

export function fromCents(cents) {
  return (Number(cents) || 0) / 100;
}

/**
 * Parse anything a human might type into a price field: "12", "12.5", "$12.50",
 * "1,234.56", "12,50" (European style), "  " -> null.
 * Returns cents, or null when the input is not a usable number.
 */
export function parseMoneyInput(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? toCents(input) : null;
  if (input == null) return null;

  let raw = String(input).trim();
  if (!raw) return null;

  let negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  raw = raw.replace(/[()]/g, '').replace(/^-/, '');
  // Drop currency symbols, letters and spaces; keep digits and separators.
  raw = raw.replace(/[^\d.,]/g, '');
  if (!raw) return null;

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever comes last is the decimal separator.
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    raw = raw.split(groupSep).join('');
    raw = raw.replace(decimalSep, '.');
  } else if (lastComma > -1) {
    // "12,50" is a decimal; "1,234" is a thousands group.
    raw = raw.length - lastComma === 3 ? raw.replace(',', '.') : raw.split(',').join('');
  }

  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  return toCents(negative ? -value : value);
}

const formatters = new Map();
function formatterFor(currency) {
  if (!formatters.has(currency)) {
    let f;
    try {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    } catch {
      f = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    formatters.set(currency, f);
  }
  return formatters.get(currency);
}

/** "$12.50" — locale aware, always two decimals. */
export function formatMoney(cents, currency = 'USD') {
  return formatterFor(currency).format(fromCents(cents));
}

/** "12.50" — for <input> values, never with a currency symbol. */
export function centsToInput(cents) {
  if (cents == null) return '';
  return (Math.abs(Number(cents) || 0) / 100).toFixed(2).replace(/^/, Number(cents) < 0 ? '-' : '');
}

/**
 * Split `totalCents` across `weights` using the largest-remainder method so the
 * parts always add back up to exactly `totalCents` — no lost or invented pennies.
 * Zero/absent weights fall back to an even split. Ties go to the earlier index,
 * which keeps the result stable for the same inputs.
 */
export function reconcileRounding(totalCents, weights) {
  const n = weights.length;
  if (n === 0) return [];

  const total = Math.trunc(Number(totalCents) || 0);
  const sign = total < 0 ? -1 : 1;
  const amount = Math.abs(total);

  const safeWeights = weights.map((w) => {
    const v = Number(w);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  let weightSum = safeWeights.reduce((a, b) => a + b, 0);
  const effective = weightSum > 0 ? safeWeights : safeWeights.map(() => 1);
  if (weightSum <= 0) weightSum = n;

  const exact = effective.map((w) => (amount * w) / weightSum);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = amount - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = floors.slice();
  for (let k = 0; k < remainder; k++) out[order[k % n].i] += 1;
  return out.map((v) => v * sign);
}

/** Even split of an amount across `count` shares, pennies distributed left to right. */
export function splitEvenly(totalCents, count) {
  if (count <= 0) return [];
  return reconcileRounding(totalCents, new Array(count).fill(1));
}

export function sumCents(list, pick = (x) => x) {
  return list.reduce((acc, item) => acc + (Math.trunc(Number(pick(item))) || 0), 0);
}
