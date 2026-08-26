// Merging the parts of a receipt that was photographed in more than one shot.
//
// Pure functions over review drafts, so the behaviour is testable without a
// camera: parts are joined in order, an overlapping run of lines (people tend
// to overlap their photos) is counted once, and the totals are taken from
// whichever part actually shows them — normally the last one.

import { finalizeDraft } from './parse-receipt.js';

const key = (item) =>
  `${String(item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${item.totalPriceCents ?? 'x'}`;

/**
 * How many lines at the end of `head` are repeated at the start of `next`.
 * Returns 0 when the parts don't overlap.
 */
export function overlapLength(head, next) {
  const max = Math.min(head.length, next.length);
  for (let length = max; length > 0; length--) {
    let matches = true;
    for (let offset = 0; offset < length; offset++) {
      if (key(head[head.length - length + offset]) !== key(next[offset])) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

/** Later parts win a field only if they actually have it (and look surer of it). */
function pickField(drafts, field, confidenceKey) {
  let best = null;
  drafts.forEach((draft, index) => {
    const value = draft[field];
    if (value == null) return;
    const confidence = confidenceKey ? draft.fieldConfidence?.[confidenceKey] ?? 0 : 0;
    if (!best || confidence > best.confidence || (confidence === best.confidence && index > best.index)) {
      best = { value, confidence, index };
    }
  });
  return best ? best.value : null;
}

function sumField(drafts, field) {
  const values = drafts.map((draft) => draft[field]).filter((value) => value != null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

/**
 * Decide what to do with lines that sit exactly on a photo boundary: drop them
 * when that makes the items match the printed subtotal, otherwise keep them and
 * flag them, so the user is never silently charged twice.
 */
function resolveMaybeDuplicates(items, candidates, subtotalCents) {
  if (!candidates.length) return { items, removed: 0 };

  const sum = items.reduce((acc, item) => acc + (item.totalPriceCents || 0), 0);
  let excess = subtotalCents == null ? 0 : sum - subtotalCents;

  if (excess > 0) {
    const doomed = new Set();
    for (const candidate of candidates) {
      const price = candidate.totalPriceCents || 0;
      if (price > 0 && excess >= price) {
        doomed.add(candidate);
        excess -= price;
      }
    }
    if (excess === 0 && doomed.size) {
      return { items: items.filter((item) => !doomed.has(item)), removed: doomed.size };
    }
  }

  for (const candidate of candidates) {
    candidate.base = candidate.base || { name: candidate.confidence.name, price: candidate.confidence.price };
    candidate.base.price = Math.min(candidate.base.price, 0.6);
    candidate.confidence.price = candidate.base.price;
    candidate.note = 'This line was in both photos. Remove it if it was only charged once.';
  }
  return { items, removed: 0 };
}

/**
 * @param {object[]} drafts review drafts, in the order the photos were taken
 * @returns {object} one draft covering the whole receipt
 */
export function mergeReceiptDrafts(drafts) {
  const parts = (drafts || []).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  const items = [];
  let overlapDropped = 0;
  // Boundary lines that *might* be a one-line overlap. Two of an item look
  // exactly like one item photographed twice, so these are only dropped if the
  // printed subtotal proves it.
  const maybeDuplicates = [];

  for (const part of parts) {
    const partItems = part.items || [];
    if (!items.length) {
      items.push(...partItems);
      continue;
    }
    const overlap = overlapLength(items, partItems);
    if (overlap >= 2) {
      overlapDropped += overlap;
      items.push(...partItems.slice(overlap));
      continue;
    }
    if (overlap === 1) maybeDuplicates.push(partItems[0]);
    items.push(...partItems);
  }

  const subtotal = pickField(parts, 'subtotalCents', 'subtotal');
  const proven = resolveMaybeDuplicates(items, maybeDuplicates, subtotal);
  overlapDropped += proven.removed;
  const total = pickField(parts, 'totalCents', 'total');
  // Tax can legitimately appear once; if two parts each show a tax line, they
  // are different taxes only when the parts didn't overlap on that line.
  const taxValues = parts.map((p) => p.taxCents).filter((v) => v != null);
  const tax = taxValues.length ? (new Set(taxValues).size === 1 ? taxValues[0] : sumField(parts, 'taxCents')) : null;

  const warnings = [];
  if (overlapDropped) {
    warnings.push({
      code: 'overlap-merged',
      message: `${overlapDropped} line${overlapDropped > 1 ? 's' : ''} appeared in two photos and ${
        overlapDropped > 1 ? 'were' : 'was'
      } counted once.`,
    });
  }

  const merged = {
    ...parts[0],
    id: parts[0].id,
    provider: parts[0].provider,
    sourceCount: parts.reduce((count, part) => count + (part.sourceCount || 1), 0),
    merchant: parts.map((p) => p.merchant).find(Boolean) || null,
    items: proven.items,
    subtotalCents: subtotal,
    taxCents: tax,
    tipCents: pickField(parts, 'tipCents', 'tip'),
    feeCents: pickField(parts, 'feeCents'),
    discountCents: pickField(parts, 'discountCents'),
    totalCents: total,
    fieldConfidence: {
      subtotal: Math.max(...parts.map((p) => p.fieldConfidence?.subtotal ?? 0)),
      tax: Math.max(...parts.map((p) => p.fieldConfidence?.tax ?? 0)),
      tip: Math.max(...parts.map((p) => p.fieldConfidence?.tip ?? 0)),
      total: Math.max(...parts.map((p) => p.fieldConfidence?.total ?? 0)),
    },
    thumbnail: parts.map((p) => p.thumbnail).find(Boolean) || null,
    warnings: [...warnings, ...parts.flatMap((p) => (p.warnings || []).filter((w) => w.code === 'duplicate-removed'))],
    rawText: parts.map((p) => p.rawText).filter(Boolean).join('\n---\n'),
  };

  return finalizeDraft(merged);
}
