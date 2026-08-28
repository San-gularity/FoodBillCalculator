// Step views. Each function takes state + the calculated summary and returns
// HTML. No calculations happen here — everything numeric comes from calc.js.

import { escapeHtml, initials } from './dom.js';
import { avatar, personToggle, moneyRow, emptyState } from './components.js';
import { formatMoney, centsToInput } from '../core/money.js';
import { itemTotalCents, validateBill } from '../core/model.js';

export const STEPS = [
  { id: 'items', label: 'Items', short: '1' },
  { id: 'people', label: 'People', short: '2' },
  { id: 'assign', label: 'Assign', short: '3' },
  { id: 'review', label: 'Split', short: '4' },
];

// ---- shared fragments -----------------------------------------------------

function peopleStack(bill, item) {
  if (!item.assignedTo.length) {
    return '<span class="pill pill--warn">Unassigned</span>';
  }
  const assigned = bill.people.filter((p) => item.assignedTo.includes(p.id));
  const shown = assigned.slice(0, 4);
  const rest = assigned.length - shown.length;
  return `<span class="stack">${shown.map((p) => avatar(p, { size: 'xs' })).join('')}${
    rest > 0 ? `<span class="stack__more">+${rest}</span>` : ''
  }</span>`;
}

function itemMeta(item) {
  const quantity = Number(item.quantity) || 1;
  if (quantity === 1) return '';
  return `<span class="item__meta">${quantity} × ${formatMoney(
    item.unitPriceCents ?? Math.round(itemTotalCents(item) / quantity),
  )}</span>`;
}

/**
 * The one place the three totals people confuse are shown together:
 * what the items add up to, what gets added on top, and what the receipt says.
 * Every row is labelled with where its number comes from.
 */
function chargesCard(bill, summary) {
  const declared = summary.declaredTotalCents;
  const mismatch = declared != null && Math.abs(summary.differenceCents) > 1;
  // Show an empty field rather than "0.00", or typing a tax lands as "0.001.23".
  const amountValue = (cents) => (cents ? escapeHtml(centsToInput(cents)) : '');

  return `
  <section class="card card--charges">
    <h3 class="card__title">The maths</h3>

    <div class="ledger">
      <div class="ledger__row">
        <span class="ledger__label">Your items
          <small>${summary.itemCount} line${summary.itemCount === 1 ? '' : 's'} in the app</small>
        </span>
        <span class="ledger__value">${formatMoney(summary.subtotalCents, summary.currency)}</span>
      </div>

      <label class="ledger__row ledger__row--input">
        <span class="ledger__label">Tax <small>from the receipt</small></span>
        <span class="field__input ledger__input">
          <span class="field__prefix">$</span>
          <input type="text" inputmode="decimal" data-action="set-tax" data-focus-key="tax"
                 value="${amountValue(bill.taxCents)}" placeholder="0.00" aria-label="Tax amount">
        </span>
      </label>

      <label class="ledger__row ledger__row--input">
        <span class="ledger__label">${escapeHtml(bill.extraLabel || 'Service & fees')}
          <small>service charge, bag fee, tip</small>
        </span>
        <span class="field__input ledger__input">
          <span class="field__prefix">$</span>
          <input type="text" inputmode="decimal" data-action="set-extra" data-focus-key="extra"
                 value="${amountValue(bill.extraCents)}" placeholder="0.00" aria-label="Service and fees">
        </span>
      </label>

      <div class="ledger__row ledger__row--total">
        <span class="ledger__label">Total to split <small>items + tax + fees</small></span>
        <span class="ledger__value">${formatMoney(summary.totalCents, summary.currency)}</span>
      </div>
    </div>

    ${sharedSplitToggle(summary)}

    <div class="ledger ledger--check">
      <label class="ledger__row ledger__row--input">
        <span class="ledger__label">Receipt total <small>what the paper says — optional</small></span>
        <span class="field__input ledger__input${mismatch ? ' is-warn' : ''}">
          <span class="field__prefix">$</span>
          <input type="text" inputmode="decimal" data-action="set-declared-total" data-focus-key="declared-total"
                 value="${declared == null ? '' : escapeHtml(centsToInput(declared))}"
                 placeholder="optional" aria-label="Receipt total">
        </span>
      </label>
      ${
        declared == null
          ? '<p class="ledger__status">Add it and we’ll check your items against it.</p>'
          : mismatch
            ? `<p class="ledger__status is-warn">⚠ Your items are ${formatMoney(
                Math.abs(summary.differenceCents),
                summary.currency,
              )} ${summary.differenceCents > 0 ? 'short of' : 'over'} the receipt.</p>`
            : '<p class="ledger__status is-ok">✓ Matches your items exactly.</p>'
      }
    </div>

    ${mismatch ? mismatchNotice(summary) : ''}
  </section>`;
}

/** Tax and fees: the same amount each, or scaled to what people ate. */
function sharedSplitToggle(summary) {
  const equal = summary.splitMode !== 'proportional';
  const sharers = summary.people.filter((person) => person.lines.length).length || summary.peopleCount;
  const each = sharers ? Math.round(summary.sharedPoolCents / sharers) : 0;

  const note = !summary.sharedPoolCents
    ? 'No tax or fees on this bill yet.'
    : equal
      ? sharers
        ? `${formatMoney(summary.sharedPoolCents, summary.currency)} split equally — about ${formatMoney(
            each,
            summary.currency,
          )} each.`
        : `${formatMoney(summary.sharedPoolCents, summary.currency)} to split equally once people are added.`
      : `${formatMoney(summary.sharedPoolCents, summary.currency)} shared in proportion to what each person had.`;

  return `
    <div class="split-mode">
      <span class="split-mode__label">Tax &amp; fees split</span>
      <div class="segmented" role="group" aria-label="How tax and fees are split">
        <button type="button" class="segmented__option${equal ? ' is-on' : ''}"
                data-action="set-split-mode" data-mode="equal" aria-pressed="${equal}">Equally</button>
        <button type="button" class="segmented__option${equal ? '' : ' is-on'}"
                data-action="set-split-mode" data-mode="proportional" aria-pressed="${!equal}">By what each had</button>
      </div>
      <p class="hint">${note}</p>
    </div>`;
}

/**
 * The bill doesn't agree with the receipt total that was typed in or scanned.
 * Both readings can be the right one, so offer both fixes plainly rather than
 * nagging with a single option.
 */
export function mismatchNotice(summary) {
  const diff = summary.differenceCents; // receipt − computed
  const over = diff < 0; // our items add up to more than the receipt says
  const gap = formatMoney(Math.abs(diff), summary.currency);
  return `
    <div class="notice notice--warn mismatch">
      <p class="mismatch__title">These don’t add up${over ? '' : ' either'}.</p>
      <div class="mismatch__rows">
        ${moneyRow('Your items + tax + fees', summary.totalCents, summary.currency)}
        ${moneyRow('Receipt total', summary.declaredTotalCents, summary.currency)}
        <div class="money-row money-row--strong">
          <span>Difference</span>
          <span class="money-row__value">${gap} ${over ? 'over' : 'under'}</span>
        </div>
      </div>
      <p class="mismatch__hint">Whichever is right, pick one — the split follows the bill total.</p>
      <div class="mismatch__actions">
        <button class="btn btn--sm btn--primary" data-action="match-receipt-total">
          My items are right — set total to ${formatMoney(summary.totalCents, summary.currency)}
        </button>
        <button class="btn btn--sm btn--ghost" data-action="absorb-diff">
          Receipt is right — add ${gap} as ${diff > 0 ? 'service &amp; fees' : 'a discount'}
        </button>
      </div>
    </div>`;
}

function heroCard(summary) {
  return `
    <section class="card card--hero">
      <span class="hero__label">Bill total</span>
      <span class="hero__value">${formatMoney(summary.totalCents, summary.currency)}</span>
      <span class="hero__meta">${summary.itemCount} item${summary.itemCount === 1 ? '' : 's'} · ${
        summary.peopleCount
      } ${summary.peopleCount === 1 ? 'person' : 'people'}</span>
    </section>`;
}

function totalsCard(summary) {
  const how = summary.splitMode === 'proportional' ? 'by what each had' : 'split equally';
  return `
  <section class="card card--totals">
    ${moneyRow(`Your items (${summary.itemCount})`, summary.subtotalCents, summary.currency)}
    ${summary.taxCents ? moneyRow(`Tax — ${how}`, summary.taxCents, summary.currency) : ''}
    ${
      summary.extraCents
        ? moneyRow(`${summary.extraLabel} — ${how}`, summary.extraCents, summary.currency, {
            negative: summary.extraCents < 0,
          })
        : ''
    }
    ${moneyRow('Total to split', summary.totalCents, summary.currency, { strong: true })}
    ${
      summary.declaredTotalCents != null
        ? `<p class="ledger__status ${
            Math.abs(summary.differenceCents) > 1 ? 'is-warn' : 'is-ok'
          }">${
            Math.abs(summary.differenceCents) > 1
              ? `⚠ Receipt total says ${formatMoney(summary.declaredTotalCents, summary.currency)}`
              : `✓ Agrees with the receipt total`
          }</p>`
        : ''
    }
  </section>`;
}

function issueBanner(bill, summary) {
  const issues = validateBill(bill).filter((issue) => issue.level === 'warning');
  const mismatch = issues.find((issue) => issue.code === 'total-mismatch');
  const others = issues.filter((issue) => issue.code !== 'total-mismatch');

  const otherHtml = others.length
    ? `<div class="notice notice--warn notice--compact">
         <ul>${others.map((issue) => `<li>${escapeHtml(issue.message)}</li>`).join('')}</ul>
         ${
           summary.unassignedItems.length && summary.peopleCount
             ? '<button class="btn btn--sm" data-action="assign-remaining">Split those evenly</button>'
             : ''
         }
       </div>`
    : '';

  // The same two-way fix as on the items step, so it can be settled from here.
  return `${mismatch ? mismatchNotice(summary) : ''}${otherHtml}`;
}

// ---- Step 1: items --------------------------------------------------------

export function itemsView(state, summary) {
  const { bill } = state;
  const hasItems = bill.items.length > 0;

  return `
  <div class="stack-lg">
    <section class="scan-strip">
      <button class="btn btn--primary btn--lg" data-action="scan-receipt">
        <span aria-hidden="true">📷</span> Scan receipt
      </button>
      <button class="btn btn--ghost" data-action="paste-receipt">Type it in</button>
    </section>

    <form class="quick-add" data-action="add-item-form" autocomplete="off">
      <input class="quick-add__name" name="name" placeholder="Add an item…" aria-label="Item name" data-focus-key="new-item-name" required>
      <span class="quick-add__price">
        <span class="field__prefix">$</span>
        <input name="price" inputmode="decimal" placeholder="0.00" aria-label="Item price" data-focus-key="new-item-price">
      </span>
      <button class="btn btn--primary quick-add__submit" type="submit" aria-label="Add item">Add</button>
    </form>

    ${
      hasItems
        ? `<section class="list" aria-label="Items">
            ${bill.items
              .map(
                (item) => `
              <article class="card item" data-id="${escapeHtml(item.id)}">
                <button class="item__main" data-action="edit-item" data-id="${escapeHtml(item.id)}">
                  <span class="item__name">${escapeHtml(item.name)}</span>
                  ${itemMeta(item)}
                </button>
                <div class="item__side">
                  <span class="item__price">${formatMoney(itemTotalCents(item), summary.currency)}</span>
                  ${bill.people.length ? peopleStack(bill, item) : ''}
                </div>
                <button class="icon-btn item__delete" data-action="delete-item" data-id="${escapeHtml(item.id)}"
                        aria-label="Delete ${escapeHtml(item.name)}">✕</button>
              </article>`,
              )
              .join('')}
           </section>`
        : emptyState({
            icon: '🧾',
            title: 'No items yet',
            body: 'Scan the receipt, or type items in above. You can fix anything later.',
            actionLabel: 'Scan receipt',
            action: 'scan-receipt',
          })
    }

    ${hasItems ? chargesCard(bill, summary) : ''}
  </div>`;
}

// ---- Step 2: people -------------------------------------------------------

export function peopleView(state) {
  const { bill } = state;
  const roster = (state.session?.roster || []).filter(
    (entry) => !bill.people.some((person) => person.name.toLowerCase() === entry.name.toLowerCase()),
  );
  return `
  <div class="stack-lg">
    <p class="lede">Who's splitting this bill? Type a name and press Enter.</p>
    <div class="people-wrap">
      ${bill.people
        .map(
          (person) => `
        <span class="person-chip" style="--chip-color:${escapeHtml(person.color)}">
          ${avatar(person, { size: 'sm' })}
          <button class="person-chip__name" data-action="rename-person" data-id="${escapeHtml(person.id)}"
                  aria-label="Rename ${escapeHtml(person.name)}">${escapeHtml(person.name)}</button>
          <button class="person-chip__remove" data-action="remove-person" data-id="${escapeHtml(person.id)}"
                  aria-label="Remove ${escapeHtml(person.name)}">✕</button>
        </span>`,
        )
        .join('')}
      <form class="person-add" data-action="add-person-form" autocomplete="off">
        <input name="name" placeholder="+ Add person" aria-label="Person's name" data-focus-key="new-person" maxlength="40">
      </form>
    </div>
    ${
      roster.length
        ? `<section class="roster">
             <h3 class="card__title">People you split with</h3>
             <div class="people-wrap">
               ${roster
                 .slice(0, 12)
                 .map(
                   (entry) => `
                 <span class="person-chip person-chip--suggested">
                   <button class="person-chip__name" data-action="add-known-person" data-name="${escapeHtml(entry.name)}"
                           data-color="${escapeHtml(entry.color || '')}">+ ${escapeHtml(entry.name)}</button>
                   <button class="person-chip__remove" data-action="forget-person" data-name="${escapeHtml(entry.name)}"
                           aria-label="Forget ${escapeHtml(entry.name)}">✕</button>
                 </span>`,
                 )
                 .join('')}
               ${roster.length > 1 ? '<button class="btn btn--ghost btn--sm" data-action="add-all-known">Add all</button>' : ''}
             </div>
           </section>`
        : ''
    }
    ${
      bill.people.length === 0
        ? emptyState({
            icon: '👥',
            title: 'Add the people',
            body: 'Everyone who shared something on this bill. First names are plenty.',
          })
        : `<div class="hint-row">
             <button class="btn btn--ghost btn--sm" data-action="add-me">Add “Me”</button>
             <span class="hint">${bill.people.length} ${bill.people.length === 1 ? 'person' : 'people'}</span>
           </div>`
    }
  </div>`;
}

// ---- Step 3: assign -------------------------------------------------------

export function assignView(state, summary) {
  const { bill } = state;
  if (!bill.people.length) {
    return emptyState({
      icon: '👥',
      title: 'Add people first',
      body: 'Once people are on the bill you can tap to assign each item.',
      actionLabel: 'Add people',
      action: 'go-people',
    });
  }
  if (!bill.items.length) {
    return emptyState({
      icon: '🧾',
      title: 'No items to assign',
      body: 'Scan a receipt or add a few items, then come back here.',
      actionLabel: 'Add items',
      action: 'go-items',
    });
  }

  const assignedCount = bill.items.filter((item) => item.assignedTo.length).length;
  const progress = Math.round((assignedCount / bill.items.length) * 100);

  return `
  <div class="stack-lg">
    <div class="progress" role="progressbar" aria-valuenow="${assignedCount}" aria-valuemin="0" aria-valuemax="${bill.items.length}">
      <div class="progress__bar" style="width:${progress}%"></div>
      <span class="progress__label">${assignedCount} of ${bill.items.length} items assigned</span>
    </div>
    ${
      assignedCount < bill.items.length
        ? '<button class="btn btn--ghost btn--sm" data-action="assign-remaining">Put everyone on the rest</button>'
        : ''
    }

    <section class="list" aria-label="Assign items">
      ${bill.items
        .map((item) => {
          const shares = summary.itemShares[item.id];
          const each = shares.assignedCount ? Math.round(shares.totalCents / shares.assignedCount) : 0;
          return `
        <article class="card assign-card${item.assignedTo.length ? '' : ' is-unassigned'}">
          <header class="assign-card__head">
            <div>
              <span class="item__name">${escapeHtml(item.name)}</span>
              ${itemMeta(item)}
            </div>
            <div class="assign-card__price">
              <span class="item__price">${formatMoney(itemTotalCents(item), summary.currency)}</span>
              ${
                shares.assignedCount > 1
                  ? `<span class="item__meta">${formatMoney(each, summary.currency)} each</span>`
                  : ''
              }
            </div>
          </header>
          <div class="chip-row" role="group" aria-label="People sharing ${escapeHtml(item.name)}">
            ${bill.people.map((person) => personToggle(person, item.assignedTo.includes(person.id), item.id)).join('')}
            <button type="button" class="chip chip--all" data-action="assign-everyone" data-item="${escapeHtml(item.id)}">
              ${item.assignedTo.length === bill.people.length ? 'Clear' : 'Everyone'}
            </button>
          </div>
        </article>`;
        })
        .join('')}
    </section>
  </div>`;
}

// ---- Step 4: review -------------------------------------------------------

export function reviewView(state, summary) {
  const { bill, ui } = state;
  if (!summary.itemCount) {
    return emptyState({
      icon: '🧮',
      title: 'Nothing to split yet',
      body: 'Add items and people, assign who had what, and the split shows up here.',
      actionLabel: 'Back to items',
      action: 'go-items',
    });
  }

  // Items but nobody to split with: still show the money, so a wrong total is
  // visible here too instead of being hidden behind an empty state.
  if (!summary.peopleCount) {
    return `
    <div class="stack-lg">
      ${issueBanner(bill, summary)}
      ${heroCard(summary)}
      ${totalsCard(summary)}
      ${emptyState({
        icon: '👥',
        title: 'Add people to split it',
        body: 'The totals above are ready — say who was there and tap who had what.',
        actionLabel: 'Add people',
        action: 'go-people',
      })}
    </div>`;
  }

  return `
  <div class="stack-lg">
    ${issueBanner(bill, summary)}

    ${heroCard(summary)}

    ${totalsCard(summary)}

    <section class="list" aria-label="What each person owes">
      ${summary.people
        .map((person) => {
          const expanded = ui.expandedPersonId === person.id;
          return `
        <article class="card person-total${expanded ? ' is-open' : ''}">
          <button class="person-total__head" data-action="toggle-person" data-id="${escapeHtml(person.id)}"
                  aria-expanded="${expanded}">
            ${avatar(person, { size: 'md' })}
            <span class="person-total__name">${escapeHtml(person.name)}</span>
            <span class="person-total__amount">${formatMoney(person.totalCents, summary.currency)}</span>
            <span class="person-total__caret" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
          </button>
          ${
            expanded
              ? `<div class="person-total__body">
                   ${
                     person.lines.length
                       ? person.lines
                           .map(
                             (line) => `${moneyRow(
                               line.sharedWith > 1
                                 ? `${line.name} (÷${line.sharedWith})`
                                 : line.name,
                               line.shareCents,
                               summary.currency,
                               { muted: true },
                             )}`,
                           )
                           .join('')
                       : '<p class="hint">Nothing assigned to this person yet.</p>'
                   }
                   ${moneyRow('Subtotal', person.subtotalCents, summary.currency)}
                   ${
                     person.taxCents
                       ? moneyRow(
                           summary.splitMode === 'proportional' ? 'Tax share' : 'Tax (equal share)',
                           person.taxCents,
                           summary.currency,
                           { muted: true },
                         )
                       : ''
                   }
                   ${
                     person.extraCents
                       ? moneyRow(
                           `${summary.extraLabel}${summary.splitMode === 'proportional' ? ' share' : ' (equal share)'}`,
                           person.extraCents,
                           summary.currency,
                           { muted: true },
                         )
                       : ''
                   }
                   ${moneyRow('Total', person.totalCents, summary.currency, { strong: true })}
                 </div>`
              : `<div class="person-total__preview">${
                  person.lines.length
                    ? escapeHtml(person.lines.map((l) => l.name).slice(0, 3).join(' · ')) +
                      (person.lines.length > 3 ? ` +${person.lines.length - 3}` : '')
                    : 'Nothing assigned'
                }</div>`
          }
        </article>`;
        })
        .join('')}
    </section>

    <section class="card card--reconcile">
      ${moneyRow('Charged to people', summary.chargedCents, summary.currency)}
      ${
        summary.unassignedCents
          ? moneyRow('Not assigned to anyone', summary.unassignedCents, summary.currency, { muted: true })
          : ''
      }
      ${moneyRow('Bill total', summary.totalCents, summary.currency)}
      <p class="reconcile__status ${summary.reconciles ? 'is-ok' : 'is-warn'}">
        ${
          summary.reconciles
            ? '✓ Everyone’s share adds up to the bill exactly.'
            : summary.unassignedCents
              ? `⚠ ${formatMoney(summary.unassignedCents, summary.currency)} isn’t assigned to anyone yet.`
              : '⚠ Totals don’t reconcile — check the items above.'
        }
      </p>
      ${
        summary.declaredTotalCents != null && Math.abs(summary.differenceCents) > 1
          ? `<p class="reconcile__status is-warn">⚠ Receipt says ${formatMoney(
              summary.declaredTotalCents,
              summary.currency,
            )} (${summary.differenceCents > 0 ? '+' : '−'}${formatMoney(
              Math.abs(summary.differenceCents),
              summary.currency,
            )}).</p>`
          : ''
      }
    </section>

    <div class="row-actions">
      ${typeof navigator !== 'undefined' && navigator.share ? '<button class="btn btn--ghost" data-action="share-summary">Share</button>' : ''}
      <button class="btn btn--ghost" data-action="new-bill">Start a new bill</button>
    </div>
  </div>`;
}

// ---- plain-text summary (copy / share) -----------------------------------

export function summaryText(bill, summary) {
  const lines = [`${bill.name} — ${formatMoney(summary.totalCents, summary.currency)}`, ''];
  const how = summary.splitMode === 'proportional' ? 'by what each had' : 'split equally';
  lines.push(`Items ${formatMoney(summary.subtotalCents, summary.currency)}`);
  if (summary.taxCents) lines.push(`Tax ${formatMoney(summary.taxCents, summary.currency)} (${how})`);
  if (summary.extraCents) {
    lines.push(`${summary.extraLabel} ${formatMoney(summary.extraCents, summary.currency)} (${how})`);
  }
  lines.push('');
  for (const person of summary.people) {
    lines.push(`${person.name}: ${formatMoney(person.totalCents, summary.currency)}`);
    for (const line of person.lines) {
      lines.push(`  · ${line.name}${line.sharedWith > 1 ? ` (÷${line.sharedWith})` : ''} ${formatMoney(line.shareCents, summary.currency)}`);
    }
    if (person.taxCents) lines.push(`  · Tax ${formatMoney(person.taxCents, summary.currency)}`);
    if (person.extraCents) lines.push(`  · ${summary.extraLabel} ${formatMoney(person.extraCents, summary.currency)}`);
  }
  if (summary.unassignedCents) {
    lines.push('', `Unassigned: ${formatMoney(summary.unassignedCents, summary.currency)}`);
  }
  return lines.join('\n');
}

export { initials };
