# Split the Bill

Scan a receipt, add the people, tap who had what — everyone's share works out to the cent.

No build step, no dependencies, no server. It is still plain HTML, CSS and JavaScript
(now ES modules), so it can be hosted on GitHub Pages or any static host as-is.

---

## Running it

ES modules can't be loaded over `file://`, so serve the folder:

```bash
npm start          # http://localhost:4173
```

Any static server works just as well (`python3 -m http.server`, `npx serve`, …).

```bash
npm test           # 60+ unit tests, node --test, no dependencies
```

Requires Node 18+ (only for the dev server and the tests — the app itself needs none).

### Receipt scanning (optional AI reader)

Out of the box, scanning runs entirely on-device with
[Tesseract.js](https://tesseract.projectnaptha.com/) (~2 MB on first use, then cached).
Nothing leaves the browser and no key is needed.

For noticeably better accuracy — especially at ignoring order numbers, table numbers and
odd layouts — add a free [Gemini API key](https://aistudio.google.com/apikey):

```bash
cp .env.example .env
# GEMINI_API_KEY=AIza...
npm start
```

`npm start` serves that key to the page as `config.js`; `.env` is git-ignored. You can also
paste a key into the app itself (menu **⋯ → Receipt scanning**), where it is stored in that
browser only. For static hosting, `npm run config` writes a `config.js` from `.env` — don't
commit the result.

> **Note:** a key used from a static page is visible to anyone who opens that page. That's
> fine for a personal free-tier key; for a public deployment, proxy the call through a
> small server-side endpoint instead (see the cloud plan).

**Which model, and what happens when Google is busy.** Reading a receipt is an easy
extraction job, so the default is `gemini-2.5-flash` — mature, generous free quota, and far
less contended than whichever model shipped most recently (the newest ones return
*"currently experiencing high demand"* at peak times). If it is busy, the app retries it
twice with backoff, then probes each of the other stable models once:

```
gemini-2.5-flash → gemini-2.5-flash-lite → gemini-3.5-flash-lite → gemini-3.6-flash → gemini-3.7-flash
```

The whole AI attempt is capped at ~9 seconds and at most eight calls; after that — or if the
key is missing, rejected or out of quota — it falls back to the on-device reader and says so.
Pin a specific model with `GEMINI_MODEL=` in `.env` or in **⋯ → Receipt scanning**. Typing
the receipt in by hand is always available too.

---

## The workflow

```
Scan receipt → Review what was read → Add people → Tap people on each item → See the split
```

1. **Items** — scan a receipt, paste its text, or type items in. Tax, tip/fees and the
   printed receipt total live here too.
2. **People** — type a name, press Enter. Chips, no dialogs. Names you've used before are
   offered as one-tap suggestions ("Add all" puts the usual crowd on the bill at once).
3. **Assign** — tap a person's chip on an item to add or remove them. "Everyone" assigns
   the whole table in one tap, and "Put everyone on the rest" clears out the leftovers.
4. **Split** — per-person totals, each expandable into the exact lines they are paying for.

If what your items add up to doesn't match the receipt total, the app shows both numbers
and the gap, and lets you settle it either way: keep your items (it updates the receipt
total) or trust the receipt (it books the difference as tip/fees or a discount). The header
total updates on every keystroke, so corrections are visible immediately.

Everything is saved as you go and restored when you come back.

**Saved bills** (menu ⋯ → Saved bills): starting a new bill files the old one away, and
"Save this bill" does it on demand. Saved bills can be reopened and edited — the saved copy
keeps updating as you change it — or deleted, which removes them from browser storage for
good.

---

## Architecture

```
              UI (src/ui/*)                    ← rendering + interaction only
                   │
          store (src/state/store.js)           ← every mutation is an action
                   │
   ┌───────────────┼────────────────┐
   │               │                │
core/calc.js   core/model.js   storage/repository.js
(all the math)  (data model)         │
                              storage/adapters.js   ← IndexedDB → localStorage → memory
                                                       (a cloud adapter drops in here)
```

| Path | What lives there |
| --- | --- |
| `src/core/money.js` | Integer-cent maths, price parsing, `reconcileRounding()` |
| `src/core/calc.js` | `calculateItemShares` · `calculatePersonSubtotal` · `calculateTaxShares` · `calculateFinalTotals` |
| `src/core/model.js` | Bill/item/person shapes, `itemTotalCents()`, `validateBill()` |
| `src/state/store.js` | Central state, actions, subscriptions, undo |
| `src/storage/` | Versioned envelope, migrations, adapters, repository (bills, archive, roster, settings) |
| `src/scanner/` | Image prep → reader (Gemini or Tesseract) → review draft → bill items |
| `src/ui/` | Shell, step views, components, the receipt review screen |
| `tests/` | Calculation, parsing, storage and store behaviour |

Rules the code sticks to: **no arithmetic outside `core/`**, **no DOM outside `ui/`**, and
every amount is an integer number of cents until the moment it is formatted.

### How the split is calculated

```
personItemShare  = itemTotal / peopleOnThatItem     (largest-remainder, so pennies never vanish)
personSubtotal   = Σ personItemShare
personTax        = taxTotal × personSubtotal / assignedSubtotal
personExtra      = tip/fees, shared the same way
personTotal      = personSubtotal + personTax + personExtra
```

`Σ personTotal` equals the bill total exactly — every distribution goes through
`reconcileRounding()`, which hands out the leftover cents one at a time instead of
rounding each share independently. If some items aren't assigned to anyone, their money is
reported separately as *not assigned* rather than being quietly spread around, and the
review screen says so.

Edge cases that are handled deliberately: nothing assigned yet (tax splits evenly),
negative lines (coupons), quantities, a person on the same item twice, and a receipt total
that disagrees with the items (offered as a tip/fees adjustment).

---

## Receipt scanning

```
Image → image.js (downscale, greyscale, contrast)
      → a provider:
           gemini.js     → structured receipt straight from the model
           tesseract.js  → text lines → parse-receipt.js heuristics
      → the same review draft (items + confidences + totals)
      → Review screen                   ← user fixes only what looks uncertain
      → to-bill.js                      ← normalized receipt → bill items + charges
```

* **Swappable readers.** A provider is `{ id, label, isAvailable(), recognize() }` for
  text-based OCR, or `{ …, structured: true, extractReceipt() }` for a model that returns
  data directly. Three ship today — `gemini.js`, `tesseract.js`, `text.js` (pasted text,
  also what the tests run against) — and both paths converge on the same draft shape via
  `createDraftFromStructured()` / `parseReceipt()`, so the review screen, confidence rules
  and bill conversion are identical no matter which reader ran. Adding another service is
  one module plus one `registerProvider()` line.
* **Why AI helps.** Character-level OCR sees `Order #4471` and can read it as a $44.71 item.
  The model is told what a line item is and what a reference number is, and it returns
  quantity, unit price, line total and a per-item confidence. The heuristic parser has been
  hardened against the same problem (reference numbers, loyalty points, long digit strings
  and decimal-less amounts are rejected), so both readers get it right.
* **Nothing is assumed correct.** Every field carries a confidence: high (≥0.8) is accepted
  silently, medium shows a ⚠ and a one-tap "confirm", low blocks the "Add to bill" button
  until the user fills it in. Items whose price column was missed, or whose line the OCR
  wasn't sure about, are kept as rows that need a price rather than being dropped.
* **Real-receipt handling.** Long item names that wrap onto a second line are joined back
  together (`Chings Singapore Curry Noodles` + `300g`), a name printed twice in a row is one
  item (even when OCR garbles a character in the repeat), numbered tax lines (`Tax2 (1.25%)`)
  are summed as tax rather than treated as items, and card-terminal chatter
  (`Authorization:`, `AID A0 …`, `Verified on Device`, `Visa 1409 (Contactless)`) is filtered
  out. A real 18-item grocery receipt is covered end to end by a test.
* **Model-shape tolerance.** Models don't always answer in the shape you asked for — a real
  reply came back as `line_items[]` with `item` keys and no subtotal. The normaliser accepts
  the common aliases (`items`/`line_items`/`products`, `name`/`item`/`description`,
  `total_price`/`price`/`amount`, `sub_total`, `grand_total`, …), derives a missing total
  from subtotal + tax (and vice versa), and a reply with no usable items is treated as a
  failure so the on-device reader takes over rather than showing an empty bill.
* **Repeated lines.** If a receipt prints a name twice but charges once, a repeat is dropped
  automatically when that makes the items match the printed subtotal — and when there's no
  subtotal to check against, it is flagged for you ("this line appears twice") instead of
  quietly double-charging.
* **Diagnosing the AI reader.** **⋯ → Receipt scanning → Test** makes a tiny request and
  shows exactly what Google said (bad key, model not available, busy, network). Failures are
  also logged to the browser console with the HTTP status and response body. If the API ever
  rejects the structured-output schema, the provider retries the same request in plain-JSON
  mode instead of losing the feature, and the reply is parsed even when it arrives fenced,
  wrapped in prose, or behind the model's thinking steps.
* **Cross-checks.** If the items add up to the printed subtotal, everything is trusted and
  the user is asked to confirm nothing. If they don't, the mismatch is shown and confidence
  drops. A gap between items + tax and the printed total becomes an explicit tip/fees line
  so the split still matches the receipt.
* Store names, addresses, phone numbers, dates, card and payment lines are filtered out.
  Quantities (`2 x Naan`, `2 @ 4.50`), prices on the following line, multiple tax lines and
  European decimal commas are all handled.

---

## Storage

`localStorage` is the wrong tool once a receipt photo is involved — it is a 5 MB, string-only,
synchronous store. The app uses **IndexedDB** (structured clone, room for the thumbnail,
async so it never blocks typing), and falls back automatically:

```
IndexedDB → localStorage → in-memory (app still works, warns that it won't be saved)
```

Four keys are kept: `current-bill` (the bill you're working on), `bill-history` (saved
bills), `people-roster` (names you split with, most recent first) and `settings` (scanner
preferences). One versioned envelope is written per bill, debounced ~350 ms and flushed on
`pagehide`:

```js
{ version: 2, bill: { id, items, people, taxCents, extraCents, receipt, … }, ui: { step }, updatedAt }
```

Everything read back goes through `normalizeStoredState()`, which migrates old versions,
repairs damaged records, drops assignments pointing at deleted people, and never throws —
if a blob is unusable the user gets a plain-language message, not a stack trace. A quota
error retries the save without the receipt photo. Editing a bill that also lives in the
archive updates the saved copy in the same write, which is what makes saved bills editable
rather than read-only snapshots.

Long-term cloud plan (backend, Google Sign-In, migration): **[docs/CLOUD-STORAGE-PLAN.md](docs/CLOUD-STORAGE-PLAN.md)**.

---

## Tests

`npm test` — 60+ tests across four files, no test framework needed:

* `tests/calc.test.js` — one person/one item, shared items, mixed group sizes, proportional
  tax, tip/fees, discounts, quantities, empty bills, unassigned items, penny distribution,
  and a 200-round randomised bill that must reconcile exactly every time.
* `tests/money.test.js` — price parsing (`$1,234.56`, `12,50`, `(3.00)`), rounding, and the
  largest-remainder distributor.
* `tests/parse-receipt.test.js` — clean receipts, noise filtering, uncertain items, missing
  prices, prices on the next line, multiple tax lines, subtotal mismatches, the conversion
  into bill items, and a full 18-item grocery receipt (wrapped names, a repeated line,
  `Tax2`, terminal chatter) that must parse to the cent.
* `tests/storage.test.js` — round trips, corrupted/hostile data, v1 migration, adapter
  failure, quota handling, saved-bill CRUD (including edits syncing into the archive and
  deletions staying deleted), the remembered-people roster and its write ordering.
* `tests/ai-extraction.test.js` — turning a model's structured answer into the review draft:
  quantities, missing prices, confidence tiers, mismatched totals, and junk responses.
* `tests/gemini-provider.test.js` — the model fallback chain, which HTTP statuses are worth
  retrying, the bound on how many calls a busy model can cost, and pulling usable JSON out of
  fenced/prose/thinking-step replies.
* `tests/store.test.js` — people, assignment, undo, session data, opening a saved bill.

---

## Limitations and assumptions

* The AI reader needs a key and a network connection; without either — or when Google's
  models are busy — scanning falls back to on-device OCR, which does best with a flat,
  well-lit, in-focus receipt.
* A browser-held API key is visible to anyone using the page — personal use only.
* Remembered people and saved bills live in that browser profile; there is no sync yet.
* OCR runs on-device and does best with a flat, well-lit, in-focus receipt. Handwriting,
  crumpled paper and extreme angles will need corrections — which is exactly what the
  review screen is for. English (`eng`) is the trained language.
* One bill is active at a time; the rest live in Saved bills (most recent 50).
* Tax and tip are shared in proportion to what each person ate. Item-level tax rates
  (common on mixed alcohol/food bills) are not modelled.
* Currency is display-only (`USD` by default); there is no conversion.
* Data lives in the browser profile that created it — no sync between devices yet.
