// OCR text -> normalized receipt data.
//
// This is deliberately a pure function over lines of text: the OCR provider can
// be swapped (Tesseract today, a cloud vision API tomorrow) without touching
// any of the parsing, confidence scoring or review UI.

import { parseMoneyInput, toCents } from '../core/money.js';
import { createId } from '../core/model.js';

export const CONFIDENCE = { HIGH: 0.8, MEDIUM: 0.5 };

/** high -> accept, medium -> ask to confirm, low -> require input. */
export function confidenceTier(value) {
  if (value >= CONFIDENCE.HIGH) return 'high';
  if (value >= CONFIDENCE.MEDIUM) return 'medium';
  return 'low';
}

const MONEY_AT_END = /(-?\(?\s*[$€£₹]?\s*\d{1,5}(?:[.,]\d{2})?\s*\)?)\s*(?:[A-Z*#]{1,3})?\s*$/;
const HAS_DECIMALS = /\d[.,]\d{2}\s*\)?\s*(?:[A-Z*#]{1,3})?\s*$/;

const KEYWORDS = [
  { key: 'subtotal', re: /\bsub[\s\-_]?totals?\b|\bsub tot\b|\bsubtotale\b/i },
  // Receipts often print several numbered tax lines: "Tax", "Tax2 (1.25%)", "VAT 1".
  { key: 'tax', re: /\b(sales\s*tax|tax(es)?\s*\d*|gst|hst|pst|qst|vat\s*\d*|tva|iva|mwst)\b/i },
  { key: 'tip', re: /\b(tip|gratuity|service\s*(charge|fee)|svc\s*chg)\b/i },
  { key: 'discount', re: /\b(discount|coupon|promo|savings|off)\b/i },
  { key: 'fee', re: /\b(delivery|service fee|bag fee|convenience|surcharge)\b/i },
  { key: 'total', re: /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|totals?|totale|totaal|gesamt|summe|importe)\b/i },
  { key: 'payment', re: /\b(cash|change|visa|mastercard|amex|debit|credit|card|tender|auth|approval|chip|contactless|ref#?|acct)\b/i },
];

const NOISE = [
  /\bthank\s*you\b/i,
  /\bserver\b|\bcashier\b|\btable\b|\bguests?\b|\bcheck\s*#/i,
  /\border\s*#|\bticket\b|\breceipt\b|\binvoice\b|\bbill\s*(no|number|#)/i,
  // Reference numbers: "Order 4471", "Trans No. 88213", "REG #4", "TRN: 0012"
  /\b(order|receipt|invoice|check|bill|trans(action)?|trn|txn|ref|reg(ister)?|terminal|store|lane|seq|slip|token|queue|batch|no|nr|num(ber)?)\b\s*[:.#-]?\s*\d+/i,
  /^#\s*\d+/,
  /^\d[\d\s-]{5,}$/, // long digit strings: card, phone, barcode fragments
  /\bpts?\b|\bpoints?\b|\bloyalty\b|\bsurvey\b/i,
  // Card terminal chatter: "Authorization: 09808D", "AID A0 00 …", "Verified on Device"
  /\bauthoriz|\bapprov|^aid\b|\bverified on device\b|\bmerchant\b|\bterminal\b|\bcontactless\b|\bchip\b|\bemv\b|\bsequence\b|\bentry mode\b|\bpin verified\b/i,
  /\b\d{1,2}[:/]\d{2}\b/, // times and dates
  /\b(mon|tue|wed|thu|fri|sat|sun)\b/i,
  /^[\W_]+$/,
  /\bwww\.|\.com\b|@/i,
  /\b(tel|phone|fax)\b|\(\d{3}\)\s*\d{3}/i,
  /\bqty\b\s*\bdescription\b|\bitem\b\s*\bprice\b/i,
];

function cleanLine(text) {
  return String(text || '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(name) {
  return String(name)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(titleCaseWord)
    .join(' ');
}

/** Keeps brand acronyms (MTR, BBQ) intact and doesn't produce "Ching'S". */
function titleCaseWord(word) {
  const uppercase = (word.match(/[A-Z]/g) || []).length;
  if (uppercase >= 2 && /^[A-Z0-9&.'/-]+$/.test(word)) return word;
  return word.toLowerCase().replace(/(^|[/\-])([a-z])/g, (match, separator, letter) => separator + letter.toUpperCase());
}

function classify(text) {
  for (const { key, re } of KEYWORDS) {
    if (re.test(text)) return key;
  }
  return null;
}

function isNoise(text) {
  return NOISE.some((re) => re.test(text));
}

/** Pull the trailing amount off a line. Returns { cents, rest, hadDecimals }. */
function extractTrailingAmount(text) {
  const match = text.match(MONEY_AT_END);
  if (!match) return null;
  const token = match[1];
  const cents = parseMoneyInput(token);
  if (cents == null) return null;
  const negative = /^\(/.test(token.trim()) || /-/.test(token);
  return {
    cents: negative ? -Math.abs(cents) : cents,
    rest: text.slice(0, match.index).trim(),
    hadDecimals: HAS_DECIMALS.test(text),
  };
}

/** "2 x Naan", "2x Naan", "Naan x2", "2 @ 4.50" */
function extractQuantity(name) {
  let quantity = 1;
  let unitPriceCents = null;
  let rest = name;

  const at = rest.match(/(\d+(?:\.\d+)?)\s*(?:@|x)\s*([$€£₹]?\s?\d+(?:[.,]\d{2}))\s*$/i);
  if (at) {
    quantity = Number(at[1]) || 1;
    unitPriceCents = parseMoneyInput(at[2]);
    rest = rest.slice(0, at.index).trim();
    return { quantity, unitPriceCents, rest };
  }

  const leading = rest.match(/^(\d{1,2})\s*(?:x|\*)?\s+(?=\D)/i);
  if (leading) {
    quantity = Number(leading[1]) || 1;
    rest = rest.slice(leading[0].length).trim();
    return { quantity, unitPriceCents, rest };
  }

  const trailing = rest.match(/\s*[x*]\s*(\d{1,2})\s*$/i);
  if (trailing) {
    quantity = Number(trailing[1]) || 1;
    rest = rest.slice(0, trailing.index).trim();
  }
  return { quantity, unitPriceCents, rest };
}

/**
 * Long item names wrap onto a second line, and the wrapped part is usually just
 * the size: "Chings Singapore Curry Noodles" / "300g". Those belong to the item
 * above, not to an item of their own.
 */
const SIZE_FRAGMENT =
  /^\d+(\.\d+)?\s*(g|gm|gms|kg|mg|ml|l|lt|ltr|liter|litre|oz|lb|lbs|ct|pc|pcs|pk|pack|bunch|box|bag|can|jar|each|ea|dozen|count)\b\.?$/i;
const BARE_UNIT = /^(g|gm|gms|kg|ml|l|lt|ltr|liter|litre|oz|lb|lbs|pack|bunch|each|dozen|bag|box|can|jar|ct|pcs?)\b\.?$/i;

export function isNameContinuation(text) {
  const value = String(text || '').trim();
  return SIZE_FRAGMENT.test(value) || BARE_UNIT.test(value);
}

/**
 * Same name, allowing for OCR noise: "Parle G 799g" vs "Parle G 799¢g".
 * Punctuation and spacing are dropped before comparing, and very short names
 * are left alone so "Coke" and "Coke" on two separate lines stay two items.
 */
function sameName(a, b) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const left = normalize(a);
  const right = normalize(b);
  if (left.length < 6 || right.length < 6) return left === right && left.length > 0;
  return left === right || withinOneEdit(left, right);
}

/** True when the two strings differ by at most one inserted/removed character. */
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (shorter.length === longer.length) i += 1;
    j += 1;
  }
  return edits + (longer.length - j) + (shorter.length - i) <= 1;
}

function scoreName(name) {
  if (!name) return 0;
  const letters = (name.match(/[a-z]/gi) || []).length;
  const junk = (name.match(/[^a-z0-9 '&.\-/()]/gi) || []).length;
  if (letters < 2) return 0.15;
  let score = Math.min(1, 0.45 + letters / 12);
  score -= junk * 0.12;
  if (name.length <= 2) score -= 0.3;
  if (/\d{4,}/.test(name)) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

function scorePrice(amount) {
  if (!amount) return 0;
  let score = amount.hadDecimals ? 0.95 : 0.5; // "12" could be a quantity column
  const abs = Math.abs(amount.cents);
  if (abs === 0) score -= 0.4;
  if (abs > 50000) score -= 0.35; // > $500 for a single food line is unusual
  return Math.max(0, Math.min(1, score));
}

/**
 * A number with no decimal point at the end of a line is only a price if it is
 * small. "Order 4471" and "#100234" are reference numbers, not $44.71 items.
 */
function looksLikeReferenceNumber(amount, name) {
  if (!amount || amount.hadDecimals) return false;
  const digits = String(Math.abs(amount.cents) / 100).replace(/\D/g, '');
  if (digits.length >= 4) return true;
  return /\b(no|nr|num|number|#|id|code)\b\s*$/i.test(name || '');
}

function normalizeLines(input) {
  if (Array.isArray(input)) {
    return input
      .map((line) =>
        typeof line === 'string'
          ? { text: cleanLine(line), confidence: 0.9 }
          : { text: cleanLine(line.text), confidence: normalizeConfidence(line.confidence) },
      )
      .filter((line) => line.text.length > 0);
  }
  return String(input || '')
    .split(/\r?\n/)
    .map((text) => ({ text: cleanLine(text), confidence: 0.9 }))
    .filter((line) => line.text.length > 0);
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.7;
  return n > 1 ? Math.max(0, Math.min(1, n / 100)) : Math.max(0, Math.min(1, n));
}

/**
 * @param {string|Array<{text:string, confidence?:number}>} input OCR output
 * @returns {object} normalized receipt draft, every field carrying a confidence
 */
export function parseReceipt(input, options = {}) {
  const lines = normalizeLines(input);
  const items = [];
  // Where the item block starts and ends, used to decide whether a line with no
  // price is a real item whose price we missed or just store/footer text.
  let firstItemLine = -1;
  let firstTotalsLine = -1;
  const totals = { subtotal: null, tax: null, tip: null, total: null, discount: null, fee: null };
  const totalsConfidence = { subtotal: 0, tax: 0, tip: 0, total: 0 };
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text;
    const amount = extractTrailingAmount(text);
    const kind = classify(text);

    if (kind === 'payment') continue;
    // Store headers, phone numbers, dates and footers never become items.
    if (!kind && isNoise(text)) continue;

    if (kind && kind !== 'discount' && kind !== 'fee' && amount) {
      if (firstTotalsLine === -1 && (kind === 'subtotal' || kind === 'tax' || kind === 'total')) firstTotalsLine = i;
      const value = Math.abs(amount.cents);
      const confidence = normalizeConfidence(line.confidence) * (amount.hadDecimals ? 1 : 0.6);
      if (kind === 'total') {
        // Receipts often print several "total" lines; the largest is the real one.
        if (totals.total == null || value > totals.total) {
          totals.total = value;
          totalsConfidence.total = confidence;
        }
      } else if (totals[kind] == null) {
        totals[kind] = value;
        totalsConfidence[kind] = confidence;
      } else if (kind === 'tax') {
        totals.tax += value; // multiple tax lines (state + city) add up
      }
      continue;
    }

    if (kind === 'discount' && amount) {
      totals.discount = (totals.discount || 0) + Math.abs(amount.cents);
      continue;
    }
    if (kind === 'fee' && amount) {
      totals.fee = (totals.fee || 0) + Math.abs(amount.cents);
      continue;
    }

    if (amount) {
      const { quantity, unitPriceCents, rest } = extractQuantity(amount.rest);
      const name = rest.replace(/[.\s_\-]+$/, '').trim();
      if (isNoise(name) && !name.match(/[a-z]{3,}/i)) continue;
      if (looksLikeReferenceNumber(amount, name)) continue; // "Order 4471" is not $44.71
      const nameScore = scoreName(name);
      const priceScore = scorePrice(amount);
      if (nameScore === 0 && priceScore < 0.6) continue; // pure garbage line

      if (firstItemLine === -1) firstItemLine = i;
      items.push(
        makeDraftItem({
          name,
          quantity,
          unitPriceCents,
          totalPriceCents: amount.cents,
          nameConfidence: nameScore * normalizeConfidence(line.confidence),
          priceConfidence: priceScore * normalizeConfidence(line.confidence),
          raw: text,
          lineIndex: i,
        }),
      );
      continue;
    }

    // A name with its price on the following line — common on narrow receipts.
    const next = lines[i + 1];
    if (next && !classify(next.text) && /^[$€£₹]?\s?\d{1,5}[.,]\d{2}$/.test(next.text.trim())) {
      const cents = parseMoneyInput(next.text);
      const nameScore = scoreName(text);
      if (cents != null && nameScore > 0.3) {
        const { quantity, unitPriceCents, rest } = extractQuantity(text);
        if (firstItemLine === -1) firstItemLine = i;
        items.push(
          makeDraftItem({
            name: rest,
            quantity,
            unitPriceCents,
            totalPriceCents: cents,
            nameConfidence: nameScore * normalizeConfidence(line.confidence),
            priceConfidence: 0.75 * normalizeConfidence(next.confidence),
            raw: `${text} ${next.text}`,
            lineIndex: i,
          }),
        );
        i += 1;
        continue;
      }
    }

    // A line with no price at all.
    const previousItem = items[items.length - 1];
    const insideItemBlock =
      firstItemLine !== -1 && i > firstItemLine && (firstTotalsLine === -1 || i < firstTotalsLine);

    if (previousItem && insideItemBlock && previousItem.totalPriceCents != null) {
      // "300g" / "liter" / "2 Bunch": the tail of the name above.
      if (isNameContinuation(text)) {
        previousItem.name = `${previousItem.name} ${text}`.trim().slice(0, 80);
        previousItem.raw = `${previousItem.raw || ''} ${text}`.trim();
        continue;
      }
      // The same name printed twice (a display quirk); the price was on the first.
      if (sameName(text, previousItem.name) || sameName(text, previousItem.raw)) continue;
    }

    // Either OCR was unsure what this line said, or it is an item whose price
    // column we missed. Both are worth asking the user about rather than
    // dropping the item silently.
    const unsureOcr = normalizeConfidence(line.confidence) < 0.65 && /[a-z]{3,}/i.test(text);
    const looksLikeItemName = scoreName(text) > 0.45;
    if (unsureOcr || looksLikeItemName) {
      const { quantity, rest } = extractQuantity(text);
      items.push(
        makeDraftItem({
          name: unsureOcr ? text : rest,
          quantity,
          unitPriceCents: null,
          totalPriceCents: null,
          nameConfidence: unsureOcr ? 0.25 * normalizeConfidence(line.confidence) : 0.55 * normalizeConfidence(line.confidence),
          priceConfidence: 0,
          raw: text,
          lineIndex: i,
          // A merely name-like line only counts if it sits inside the item block;
          // store names and footers live outside it.
          onlyInsideItemBlock: !unsureOcr,
        }),
      );
    }
  }

  // Drop name-only candidates that turned out to be header or footer text.
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item.onlyInsideItemBlock) continue;
    const inBlock =
      firstItemLine !== -1 &&
      item.lineIndex > firstItemLine &&
      (firstTotalsLine === -1 || item.lineIndex < firstTotalsLine);
    if (!inBlock) items.splice(index, 1);
  }

  // A "total" that is really the subtotal, or a missing subtotal we can derive.
  if (totals.subtotal == null && totals.total != null && totals.tax != null) {
    totals.subtotal = totals.total - totals.tax - (totals.tip || 0);
    totalsConfidence.subtotal = 0.55;
  }

  return finalizeDraft({
    id: createId('receipt'),
    provider: options.provider || 'unknown',
    capturedAt: options.capturedAt || null,
    sourceCount: 1,
    items,
    subtotalCents: totals.subtotal,
    taxCents: totals.tax,
    tipCents: totals.tip,
    feeCents: totals.fee,
    discountCents: totals.discount,
    totalCents: totals.total,
    fieldConfidence: totalsConfidence,
    warnings: [],
    rawText: lines.map((l) => l.text).join('\n'),
  });
}

/**
 * Build the same review draft from data an AI/vision model already structured,
 * so the review screen, confidence rules and bill conversion stay identical no
 * matter which provider read the receipt.
 *
 * Amounts arrive in major units (dollars), which is how models report them.
 */
export function createDraftFromStructured(data, options = {}) {
  const raw = data && typeof data === 'object' ? data : {};
  const toCentsOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const cents = typeof value === 'number' ? toCents(value) : parseMoneyInput(value);
    return cents == null ? null : cents;
  };

  const rawItems = pick(raw, ['items', 'line_items', 'lineItems', 'products', 'entries', 'rows']);
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const name = String(pick(entry, ['name', 'item', 'description', 'title', 'label']) ?? '').trim();
      const quantityValue = Number(pick(entry, ['quantity', 'qty', 'count', 'units']));
      const quantity = Number.isFinite(quantityValue) && quantityValue > 0 ? quantityValue : 1;
      const unit = toCentsOrNull(pick(entry, ['unit_price', 'unitPrice', 'price_each', 'each']));
      let total = toCentsOrNull(
        pick(entry, ['total_price', 'totalPrice', 'line_total', 'lineTotal', 'amount', 'price', 'total']),
      );
      if (total == null && unit != null) total = Math.round(unit * quantity);
      if (!name && total == null) return null;

      const confidence = clamp01(pick(entry, ['confidence', 'score', 'certainty']), 0.8);
      return makeDraftItem({
        name,
        quantity,
        unitPriceCents: unit,
        totalPriceCents: total,
        nameConfidence: name ? confidence : 0,
        priceConfidence: total == null ? 0 : confidence,
        raw: pick(entry, ['raw_text', 'rawText', 'raw']) || '',
      });
    })
    .filter(Boolean);

  let subtotal = toCentsOrNull(pick(raw, ['subtotal', 'sub_total', 'subTotal', 'items_total']));
  const tax = toCentsOrNull(pick(raw, ['tax', 'taxes', 'tax_total', 'taxTotal', 'sales_tax']));
  const tip = toCentsOrNull(pick(raw, ['tip', 'gratuity']));
  const fees = toCentsOrNull(pick(raw, ['fees', 'fee', 'service_fee', 'service_charge']));
  const discount = toCentsOrNull(pick(raw, ['discount', 'discounts', 'savings']));
  let total = toCentsOrNull(pick(raw, ['total', 'grand_total', 'grandTotal', 'amount_due', 'total_due', 'balance_due']));

  // Models sometimes report the printed total but not the subtotal (or the
  // other way round). Fill in whichever is implied by the other two.
  if (subtotal == null && total != null && tax != null) subtotal = total - tax - (tip || 0) - (fees || 0);
  if (total == null && subtotal != null && tax != null) total = subtotal + tax + (tip || 0) + (fees || 0) - (discount || 0);

  const deduped = dropRepeatedLines(items, subtotal);
  const finalItems = deduped.removed.length ? deduped.items : flagUnverifiedRepeats(deduped.items);
  const warnings = [];
  if (deduped.removed.length) {
    warnings.push({
      code: 'duplicate-removed',
      message: `${deduped.removed.length} repeated line${
        deduped.removed.length > 1 ? 's were' : ' was'
      } counted once, to match the printed subtotal.`,
    });
  }

  return finalizeDraft({
    id: createId('receipt'),
    provider: options.provider || 'ai',
    capturedAt: options.capturedAt || null,
    sourceCount: 1,
    merchant: typeof raw.merchant === 'string' ? raw.merchant.slice(0, 80) : null,
    items: finalItems,
    subtotalCents: subtotal,
    taxCents: tax,
    tipCents: tip,
    feeCents: fees,
    discountCents: discount,
    totalCents: total,
    fieldConfidence: {
      subtotal: subtotal == null ? 0 : 0.9,
      tax: tax == null ? 0 : 0.9,
      tip: 0.9,
      total: total == null ? 0 : 0.9,
    },
    warnings,
    rawText: typeof raw.raw_text === 'string' ? raw.raw_text.slice(0, 20000) : '',
  });
}

/** First present value among several possible key spellings. */
function pick(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Some receipts print an item's name twice but charge for it once, and a model
 * reading that will happily return it twice with the same price. Only drop such
 * a repeat when doing so makes the items match the printed subtotal exactly —
 * otherwise leave it alone and let the mismatch warning speak.
 */
function dropRepeatedLines(items, subtotalCents) {
  if (subtotalCents == null || items.length < 2) return { items, removed: [] };
  const sum = items.reduce((acc, item) => acc + (item.totalPriceCents || 0), 0);
  let excess = sum - subtotalCents;
  if (excess <= 0) return { items, removed: [] };

  const kept = [];
  const removed = [];
  for (const item of items) {
    const previous = kept[kept.length - 1];
    const isRepeat =
      previous &&
      sameName(previous.name, item.name) &&
      previous.totalPriceCents === item.totalPriceCents &&
      item.totalPriceCents > 0 &&
      excess >= item.totalPriceCents;
    if (isRepeat) {
      excess -= item.totalPriceCents;
      removed.push(item);
      continue;
    }
    kept.push(item);
  }
  return excess === 0 ? { items: kept, removed } : { items, removed: [] };
}

/**
 * Repeats we couldn't prove are duplicates. Charging twice for something the
 * receipt priced once is the worst outcome, so ask rather than assume.
 */
function flagUnverifiedRepeats(items) {
  for (let i = 1; i < items.length; i++) {
    const previous = items[i - 1];
    const item = items[i];
    if (!sameName(previous.name, item.name) || previous.totalPriceCents !== item.totalPriceCents) continue;
    if (item.totalPriceCents == null) continue;
    // Lower the reader's own opinion, so re-finalising keeps the doubt.
    item.base = item.base || { name: item.confidence.name, price: item.confidence.price };
    item.base.price = Math.min(item.base.price, 0.6);
    item.confidence.price = item.base.price;
    item.note = 'This line appears twice on the receipt. Keep it only if you were charged twice.';
  }
  return items;
}

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function makeDraftItem({
  name,
  quantity,
  unitPriceCents,
  totalPriceCents,
  nameConfidence,
  priceConfidence,
  raw,
  note = null,
  lineIndex = -1,
  onlyInsideItemBlock = false,
}) {
  const cleanName = titleCase(String(name || '').replace(/\s{2,}/g, ' ').trim());
  return {
    id: createId('draft'),
    name: cleanName,
    quantity: quantity || 1,
    unitPriceCents:
      unitPriceCents != null
        ? unitPriceCents
        : totalPriceCents == null
          ? null
          : Math.round(totalPriceCents / (quantity || 1)),
    totalPriceCents: totalPriceCents == null ? null : totalPriceCents,
    confidence: { name: nameConfidence, price: priceConfidence, overall: 0 },
    // The reader's own opinion, before any subtotal cross-check adjusts it.
    base: { name: nameConfidence, price: priceConfidence },
    status: 'pending', // 'pending' | 'confirmed' | 'edited'
    raw,
    note,
    lineIndex,
    onlyInsideItemBlock,
  };
}

const RECOMPUTED_WARNINGS = new Set(['no-items', 'no-tax', 'no-total', 'subtotal-mismatch']);

/**
 * Recompute everything that depends on the item list: the running total, the
 * warnings, and how much each item should be trusted. Used by the text parser,
 * the AI normaliser and the multi-photo merge, so all three end up identical.
 * Safe to run again after items change; user edits are left alone.
 */
export function finalizeDraft(draft) {
  const items = draft.items || [];
  const itemsSum = items.reduce((acc, item) => acc + (item.totalPriceCents || 0), 0);
  const subtotal = draft.subtotalCents;
  const matchesSubtotal = subtotal != null && items.length > 0 && Math.abs(itemsSum - subtotal) <= 2;

  for (const item of items) {
    if (item.status !== 'pending') continue; // the user has already spoken
    const base = item.base || { name: item.confidence.name, price: item.confidence.price };
    item.base = base;
    item.confidence.name = base.name;
    item.confidence.price = base.price;
    if (matchesSubtotal) {
      // The items add up to the printed subtotal — strong evidence they're right.
      item.confidence.name = Math.min(1, base.name + 0.15);
      item.confidence.price = Math.min(1, base.price + 0.25);
    } else if (subtotal != null && items.length > 0) {
      item.confidence.price = Math.max(0, base.price - 0.15);
    }
    finalizeConfidence(item);
  }

  const warnings = (draft.warnings || []).filter((warning) => !RECOMPUTED_WARNINGS.has(warning.code));
  if (!items.length) warnings.unshift({ code: 'no-items', message: 'We couldn’t find any items on this receipt.' });
  if (draft.taxCents == null) {
    warnings.push({ code: 'no-tax', message: 'We couldn’t find a tax line. Add it if the receipt has one.' });
  }
  if (draft.totalCents == null) warnings.push({ code: 'no-total', message: 'We couldn’t find the receipt total.' });
  if (subtotal != null && items.length && !matchesSubtotal) {
    warnings.push({
      code: 'subtotal-mismatch',
      message: `Scanned items add up to ${(itemsSum / 100).toFixed(2)}, but the receipt says ${(subtotal / 100).toFixed(2)}.`,
      diffCents: itemsSum - subtotal,
    });
  }

  draft.itemsSumCents = itemsSum;
  draft.warnings = warnings;
  return draft;
}

function finalizeConfidence(item) {
  if (!item.name) item.confidence.name = 0;
  if (!item.totalPriceCents) item.confidence.price = Math.min(item.confidence.price, 0.3);
  item.confidence.overall = Math.min(item.confidence.name, item.confidence.price);
  item.needsReview = confidenceTier(item.confidence.overall) !== 'high';
  return item;
}

/** Re-run the derived flags after a user edit. */
export function markItemEdited(item, patch) {
  const next = { ...item, ...patch, confidence: { ...item.confidence } };
  if (patch.name !== undefined) next.confidence.name = 1;
  if (patch.totalPriceCents !== undefined || patch.unitPriceCents !== undefined) next.confidence.price = 1;
  next.status = 'edited';
  return finalizeConfidence(next);
}

export function markItemConfirmed(item) {
  const next = { ...item, confidence: { name: 1, price: 1, overall: 1 }, status: 'confirmed' };
  next.needsReview = false;
  return next;
}

/** Items whose name or price still needs a human before we can use them. */
export function itemsNeedingInput(draft) {
  return draft.items.filter(
    (item) =>
      item.status === 'pending' &&
      (confidenceTier(item.confidence.name) === 'low' || confidenceTier(item.confidence.price) === 'low'),
  );
}
