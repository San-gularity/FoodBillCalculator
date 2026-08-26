// Central application state: one bill + a little UI state.
// Every mutation goes through an action here, which keeps the UI dumb and makes
// persistence a single subscription rather than scattered save() calls.

import {
  createBill,
  createItem,
  createPerson,
  pruneAssignments,
  normalizeQuantity,
} from '../core/model.js';

const UNDO_LIMIT = 10;

export function createStore(initial = {}) {
  let state = {
    bill: initial.bill || createBill(),
    ui: { step: 'items', expandedPersonId: null, ...(initial.ui || {}) },
    // Not persisted with the bill: remembered names, archive count, AI status.
    session: { roster: [], archivedCount: 0, aiReady: false, ...(initial.session || {}) },
  };
  const listeners = new Set();
  const undoStack = [];

  function notify() {
    for (const listener of [...listeners]) listener(state);
  }

  function set(next, { undoable = false, label = '' } = {}) {
    if (undoable) {
      undoStack.push({ state, label });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    // Session data (remembered people, archive count) belongs to the browser,
    // not to a bill, so it survives every bill-level change.
    state = { ...next, session: next.session || state.session };
    notify();
  }

  function setBill(mutate, options) {
    const bill = mutate({ ...state.bill });
    set({ ...state, bill }, options);
  }

  const store = {
    getState: () => state,
    getBill: () => state.bill,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    replaceState(next) {
      set({
        bill: next.bill || createBill(),
        ui: { step: 'items', expandedPersonId: null, ...(next.ui || {}) },
        session: state.session,
      });
    },

    /** Session-only data (remembered people, archive count, AI availability). */
    setSession(patch) {
      set({ ...state, session: { ...state.session, ...patch } });
    },

    /** Open a saved bill for editing. */
    loadBill(bill, { step } = {}) {
      set(
        {
          bill,
          ui: { step: step || (bill.items?.length ? 'assign' : 'items'), expandedPersonId: null },
          session: state.session,
        },
        { undoable: true, label: 'Opened a saved bill' },
      );
    },

    // ---- UI -------------------------------------------------------------
    setStep(step) {
      if (state.ui.step === step) return;
      set({ ...state, ui: { ...state.ui, step } });
    },
    toggleExpandedPerson(personId) {
      const expandedPersonId = state.ui.expandedPersonId === personId ? null : personId;
      set({ ...state, ui: { ...state.ui, expandedPersonId } });
    },

    // ---- Bill -----------------------------------------------------------
    newBill(keepPeople = false) {
      const people = keepPeople ? state.bill.people.map((p) => ({ ...p })) : [];
      set(
        { bill: createBill({ people }), ui: { step: 'items', expandedPersonId: null } },
        { undoable: true, label: 'New bill' },
      );
    },
    renameBill(name) {
      setBill((bill) => ({ ...bill, name: String(name || '').slice(0, 60) || bill.name }));
    },

    // ---- Items ----------------------------------------------------------
    addItem(partial) {
      const item = createItem(partial);
      setBill((bill) => ({ ...bill, items: [...bill.items, item] }));
      return item;
    },
    addItems(list, meta = {}) {
      const items = list.map((partial) => createItem(partial));
      setBill(
        (bill) => ({
          ...bill,
          items: [...bill.items, ...items],
          taxCents: meta.taxCents != null ? meta.taxCents : bill.taxCents,
          extraCents: meta.extraCents != null ? meta.extraCents : bill.extraCents,
          declaredSubtotalCents:
            meta.declaredSubtotalCents !== undefined ? meta.declaredSubtotalCents : bill.declaredSubtotalCents,
          declaredTotalCents:
            meta.declaredTotalCents !== undefined ? meta.declaredTotalCents : bill.declaredTotalCents,
          receipt: meta.receipt !== undefined ? meta.receipt : bill.receipt,
        }),
        { undoable: true, label: 'Receipt added' },
      );
      return items;
    },
    updateItem(itemId, patch) {
      setBill((bill) => ({
        ...bill,
        items: bill.items.map((item) => {
          if (item.id !== itemId) return item;
          const next = { ...item, ...patch };
          if (patch.quantity !== undefined) next.quantity = normalizeQuantity(patch.quantity);
          if (patch.unitPriceCents !== undefined && patch.totalPriceCents === undefined) {
            next.totalPriceCents = null; // derive the line total again
          }
          if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 80) || item.name;
          return next;
        }),
      }));
    },
    removeItem(itemId) {
      setBill((bill) => ({ ...bill, items: bill.items.filter((item) => item.id !== itemId) }), {
        undoable: true,
        label: 'Item removed',
      });
    },
    duplicateItem(itemId) {
      const source = state.bill.items.find((item) => item.id === itemId);
      if (!source) return;
      const copy = createItem({ ...source, id: undefined });
      setBill((bill) => {
        const index = bill.items.findIndex((item) => item.id === itemId);
        const items = [...bill.items];
        items.splice(index + 1, 0, copy);
        return { ...bill, items };
      });
    },
    clearItems() {
      setBill((bill) => ({ ...bill, items: [], receipt: null, declaredSubtotalCents: null, declaredTotalCents: null }), {
        undoable: true,
        label: 'Items cleared',
      });
    },

    // ---- People ---------------------------------------------------------
    addPerson(name, options = {}) {
      const trimmed = String(name || '').trim();
      if (!trimmed) return null;
      const exists = state.bill.people.some((p) => p.name.toLowerCase() === trimmed.toLowerCase());
      if (exists) return { duplicate: true };
      const person = createPerson(trimmed, state.bill.people.length);
      if (options.color) person.color = options.color;
      setBill((bill) => ({ ...bill, people: [...bill.people, person] }));
      return person;
    },

    /** Add several remembered names at once, skipping anyone already here. */
    addPeople(names) {
      const added = [];
      for (const entry of names) {
        const name = typeof entry === 'string' ? entry : entry?.name;
        const person = store.addPerson(name, { color: typeof entry === 'object' ? entry.color : null });
        if (person && !person.duplicate) added.push(person);
      }
      return added;
    },
    renamePerson(personId, name) {
      const trimmed = String(name || '').trim();
      if (!trimmed) return;
      setBill((bill) => ({
        ...bill,
        people: bill.people.map((p) => (p.id === personId ? { ...p, name: trimmed.slice(0, 40) } : p)),
      }));
    },
    removePerson(personId) {
      setBill(
        (bill) =>
          pruneAssignments({
            ...bill,
            people: bill.people.filter((person) => person.id !== personId),
          }),
        { undoable: true, label: 'Person removed' },
      );
    },

    // ---- Assignment -----------------------------------------------------
    toggleAssignment(itemId, personId) {
      setBill((bill) => ({
        ...bill,
        items: bill.items.map((item) => {
          if (item.id !== itemId) return item;
          const has = item.assignedTo.includes(personId);
          return {
            ...item,
            assignedTo: has ? item.assignedTo.filter((id) => id !== personId) : [...item.assignedTo, personId],
          };
        }),
      }));
    },
    setAssignment(itemId, personIds) {
      setBill((bill) => ({
        ...bill,
        items: bill.items.map((item) => (item.id === itemId ? { ...item, assignedTo: [...new Set(personIds)] } : item)),
      }));
    },
    assignEveryone(itemId) {
      const everyone = state.bill.people.map((p) => p.id);
      store.setAssignment(itemId, everyone);
    },
    /** One tap: put everyone on every item that still has nobody. */
    assignEveryoneToUnassigned() {
      const everyone = state.bill.people.map((p) => p.id);
      if (!everyone.length) return 0;
      let touched = 0;
      setBill(
        (bill) => ({
          ...bill,
          items: bill.items.map((item) => {
            if (item.assignedTo.length) return item;
            touched += 1;
            return { ...item, assignedTo: [...everyone] };
          }),
        }),
        { undoable: true, label: 'Split remaining' },
      );
      return touched;
    },

    // ---- Charges --------------------------------------------------------
    setTax(cents) {
      setBill((bill) => ({ ...bill, taxCents: Math.trunc(Number(cents) || 0) }));
    },
    setExtra(cents, label) {
      setBill((bill) => ({
        ...bill,
        extraCents: Math.trunc(Number(cents) || 0),
        extraLabel: label || bill.extraLabel,
      }));
    },
    setDeclared({ subtotalCents, totalCents }, options = {}) {
      setBill(
        (bill) => ({
          ...bill,
          declaredSubtotalCents: subtotalCents === undefined ? bill.declaredSubtotalCents : subtotalCents,
          declaredTotalCents: totalCents === undefined ? bill.declaredTotalCents : totalCents,
        }),
        options,
      );
    },
    /** Turn a receipt/computed mismatch into an explicit tip-or-fees line. */
    absorbDifferenceAsExtra(diffCents) {
      setBill((bill) => ({ ...bill, extraCents: (bill.extraCents || 0) + Math.trunc(diffCents) }), {
        undoable: true,
        label: 'Adjustment applied',
      });
    },

    // ---- Undo -----------------------------------------------------------
    canUndo: () => undoStack.length > 0,
    undo() {
      const previous = undoStack.pop();
      if (!previous) return false;
      state = previous.state;
      notify();
      return true;
    },
  };

  return store;
}
