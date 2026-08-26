# Long-term storage plan — from browser-only to the cloud

*Proposal only. Nothing here is built; the current app is deliberately backend-free.*

The point of this document is that moving to the cloud should be **an adapter swap plus an
auth screen**, not a rewrite. The code already has the seam:

```
              UI  (src/ui)
                │            knows nothing about persistence
        Store / domain logic  (src/state, src/core)
                │            plain objects, integer cents, no I/O
        BillRepository  (src/storage/repository.js)
                │            load / save / flush / archive / listArchived
        StorageAdapter  (src/storage/adapters.js)
         ┌──────┴───────┬──────────────┐
    IndexedDB     localStorage      CloudAdapter   ← the only new file
      (today)      (fallback)         (later)
```

`StorageAdapter` is already async and key-addressed (`get/set/remove/keys`), which is the
same shape as a REST call. A `createCloudAdapter({ baseUrl, getToken })` that does
`fetch(`${baseUrl}/bills/${key}`)` satisfies the contract as-is.

---

## Option A — Backend + database

```
Browser  ──►  Auth (OIDC / JWT)  ──►  API  ──►  Postgres
   │                                    │
   └───────── offline queue ────────────┘
```

**Stack recommendation:** Postgres + a small typed API. Two credible shapes:

| | Managed BaaS (Supabase / Firebase) | Own API (Node + Fastify/Hono + Postgres) |
| --- | --- | --- |
| Time to ship | Days — auth, DB, storage, row-level security included | Weeks |
| Fit here | Excellent: this is a CRUD app with per-user rows | Better only once billing/complex logic appears |
| Lock-in | Moderate (Supabase is Postgres underneath, so exit is real) | None |

For an app of this size, **Supabase** (Postgres + GoTrue auth + Storage for receipt images +
row-level security) is the recommendation. Postgres is the right database because bills are
relational (bill → items → assignments → people) and the interesting queries — "what do I owe
Alex across all bills" — are joins and aggregates, not document lookups.

### Schema

```sql
create table users (            -- provisioned by the auth provider
  id            uuid primary key,
  email         text unique not null,
  display_name  text,
  created_at    timestamptz not null default now()
);

create table bills (
  id            uuid primary key,
  owner_id      uuid not null references users(id) on delete cascade,
  name          text not null,
  currency      char(3) not null default 'USD',
  tax_cents     integer not null default 0,
  extra_cents   integer not null default 0,
  extra_label   text,
  declared_subtotal_cents integer,
  declared_total_cents    integer,
  status        text not null default 'open',      -- open | settled | archived
  client_id     text,                              -- the local bill id, for idempotent import
  version       integer not null default 1,        -- optimistic concurrency
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner_id, client_id)
);

create table people (                              -- a participant on one bill
  id            uuid primary key,
  bill_id       uuid not null references bills(id) on delete cascade,
  name          text not null,
  color         text,
  user_id       uuid references users(id),         -- set if this person has an account
  position      integer not null default 0
);

create table items (
  id            uuid primary key,
  bill_id       uuid not null references bills(id) on delete cascade,
  name          text not null,
  quantity      numeric(8,2) not null default 1,
  unit_price_cents  integer not null default 0,
  total_price_cents integer,                       -- null = derive from qty x unit
  source        text not null default 'manual',    -- manual | scan
  position      integer not null default 0
);

create table item_assignments (
  item_id       uuid references items(id) on delete cascade,
  person_id     uuid references people(id) on delete cascade,
  primary key (item_id, person_id)
);

create table receipts (
  id            uuid primary key,
  bill_id       uuid not null references bills(id) on delete cascade,
  image_url     text,                              -- object storage, not the database
  provider      text,
  raw_text      text,
  parsed        jsonb,                             -- the draft, confidences included
  captured_at   timestamptz
);

create index on bills (owner_id, updated_at desc);
create index on items (bill_id);
create index on people (bill_id);
```

Money stays `integer` cents server-side too — never `float`.

### API

Resource-shaped, one bill per request, so the client can keep sending whole bills the way
the repository already does:

```
POST   /v1/bills                 create (accepts the local bill as-is, returns server ids)
GET    /v1/bills?cursor=…        the user's bills, newest first
GET    /v1/bills/:id             bill + items + people + assignments + receipt
PUT    /v1/bills/:id             full replace; If-Match: <version> for optimistic locking
PATCH  /v1/bills/:id/items/:itemId
DELETE /v1/bills/:id
POST   /v1/bills/:id/receipt     multipart upload → object storage → OCR job
POST   /v1/import                bulk import of local bills after first sign-in
```

Server-side, `calculateFinalTotals()` runs **unchanged** — it is already pure and
dependency-free, so the same module validates totals on the API and powers the UI.
That is the main reason the calculation layer has no DOM or storage imports.

### Security

* Auth via OIDC; short-lived access token in memory, refresh token in an httpOnly,
  `SameSite=Lax` cookie. Never put tokens in `localStorage`.
* Authorisation on every row: `owner_id = auth.uid()` (Postgres RLS), plus explicit shares
  once "share a bill with Alex" exists.
* Validate every amount server-side (integers, sane bounds); never trust client totals.
* Receipt images are private objects behind short-lived signed URLs, with a deletion policy —
  receipts contain card fragments and location data.
* Rate-limit the OCR endpoint; it is the expensive one.
* HTTPS + HSTS, strict CSP, CSRF token on cookie-authenticated writes.

### Migration from local storage

1. Ship the cloud adapter behind a flag; the app keeps using IndexedDB while signed out.
2. On first sign-in, read every local bill (current + archived) and `POST /v1/import`,
   keyed by the existing local `bill.id` (`client_id`) so a retry can't duplicate anything.
3. On success, switch the repository to a **write-through** adapter: IndexedDB stays the
   local cache and offline buffer, the cloud is the source of truth.
4. Keep the local copy for a release or two, then drop it. Nothing above the repository
   changes at any step.

---

## Option B — Google Sign-In

```
Google Sign-In ──► ID token ──► verify ──► user account ──► cloud database ──► the user's bills
```

**Yes, it makes sense — as the first and probably only provider.** This app is used at a
restaurant table, on a phone, and asking for a password there is the fastest way to lose the
user. Google covers most phones, gives a verified email (useful when bills get shared between
people later), and needs no password reset flow, no email verification and no credential
storage.

How it fits:

1. Google Identity Services renders the button and returns an ID token (JWT).
2. The backend verifies signature, `aud`, `iss` and expiry against Google's JWKS, then
   upserts a user by `sub` (never by email alone — emails change hands).
3. The backend issues its own session, so the rest of the API never depends on Google.
4. Because step 3 exists, adding Apple Sign-In or magic links later is one more route,
   not a redesign.

**Associating existing local bills:** each local bill already carries a stable id. After the
first sign-in, the import call sends every local bill with `client_id = bill.id`; the server
creates them owned by the new user and returns the mapping, which the client stores. If the
same person signs in on a second device, their local bills there import the same way and
`unique (owner_id, client_id)` keeps duplicates out. People named on a bill (`people.user_id`)
can later be linked to real accounts, which is what turns "who owes what tonight" into
"what Alex owes me overall".

---

## Recommendation

1. **Now:** keep it local-first. IndexedDB behind the repository; no account needed to split
   a bill, which is the app's biggest advantage over Splitwise-style products.
2. **Next:** Google Sign-In + Supabase (Postgres, RLS, Storage) with the cloud adapter and
   the import step above. Local storage becomes the offline cache, not the source of truth.
3. **Then, only if the product asks for it:** shared bills (invite by link), payment-status
   tracking, per-person balances across bills, and server-side OCR for better accuracy on
   hard receipts — the provider interface already allows the switch.

The design constraint worth keeping: **the UI never learns where data lives.** As long as
new features go through the store and the repository, moving between local, cloud and hybrid
storage stays a one-file change.
