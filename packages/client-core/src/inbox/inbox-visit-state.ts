/**
 * The rows of one Inbox visit and the rules that keep them still. Internal to
 * `inbox-visit.ts`: every function here takes a state and returns a new one,
 * reads nothing and starts no timer, so the visit can stay a thin shell of
 * requests around it.
 *
 * Vocabulary:
 * - A read is numbered when it is issued (`ReadTicket.seq`, rising by one per
 *   read) and remembers the push generation it was issued at (`gen`). A
 *   reader's answer reflects the controller at the moment of issue, so every
 *   rule that asks "could this answer know about X?" compares `seq`s.
 * - The frontier (cursor of the last page fetched) is kept apart from the
 *   displayed order, which only the user's moves and Show reorder.
 *
 * Known effect of keyset pages: the controller orders by a key that can change
 * while the list is open. A row whose key changed may move above the frontier
 * and so be skipped by later pages, or come again in a later page. A row seen
 * again is already held and is ignored. A row skipped shows up when the list is
 * read again from its first page.
 */
import { replaceEqualDeep } from "@tanstack/query-core";
import type { InboxFacet, InboxOrder } from "@hercule/contract";

export interface InboxVisitRow {
  readonly ref: string;
  /**
   * The row's place in the controller's arrival sequence: opaque, and a larger
   * number arrived later. The visit uses it to tell a genuine arrival from a
   * row that only slid into the first page.
   */
  readonly arrival: number;
}

/** The most held rows one refresh or row read asks for. */
export const HELD_WINDOW = 400;

export interface ReadTicket {
  /** Counts the reads issued, from 1. */
  readonly seq: number;
  /** The push generation when the read was issued. */
  readonly gen: number;
}

export interface FirstPage<Row> {
  readonly rows: readonly Row[];
  readonly nextCursor?: string | undefined;
  readonly total: number;
  readonly order: InboxOrder;
  /** Only a first page carries facets. */
  readonly facets?: readonly InboxFacet[] | undefined;
}

export interface NextPage<Row> {
  readonly rows: readonly Row[];
  readonly nextCursor?: string | undefined;
}

/** What a move did to the rows, handed back to undo it. */
export interface MoveReceipt<Row> {
  readonly id: number;
  /** The visit the move was made in. An undo in another visit does nothing, unless that visit shows the same list. */
  readonly visit: number;
  readonly refs: readonly string[];
  /** The rows the move touched with the place each had in the list, in list order. */
  readonly entries: ReadonlyArray<{ readonly row: Row; readonly index: number }>;
}

/** A row a dismissal took off the list, until a read confirms the controller dropped it. */
interface HiddenRow {
  readonly receiptId: number;
  /** The `seq` counter when the dismissal was confirmed, or `null` while it is still on its way. */
  readonly confirmedAfter: number | null;
}

export interface VisitState<Row extends InboxVisitRow, Query> {
  readonly query: Query;
  /** The rows the list shows, in visit order. */
  readonly rows: readonly Row[];
  /** Rows the latest first page ranks but the list does not hold: "N new" is their count. */
  readonly arrivals: readonly Row[];
  readonly firstPageRefs: readonly string[];
  /** The cursor of the last page fetched, or undefined when no page follows. */
  readonly frontier: string | undefined;
  /**
   * The highest `arrival` the list has shown: set when it starts, raised by
   * each page appended and by Show. A first-page row that is not held is an
   * arrival when its own `arrival` is above this, whatever its rank.
   */
  readonly watermark: number;
  readonly current: string | null;
  readonly selection: ReadonlySet<string>;
  readonly anchor: string | null;
  readonly total: number;
  readonly order: InboxOrder;
  readonly facets: readonly InboxFacet[];
  /** The push generation each row's copy was read at. A row below the current generation is stale. */
  readonly freshAt: ReadonlyMap<string, number>;
  /**
   * Rows put back locally (undo, failed move) at a `seq`: a read issued at or
   * before it may not update or remove the row, because it may predate the
   * controller taking the row back.
   */
  readonly locks: ReadonlyMap<string, number>;
  readonly hidden: ReadonlyMap<string, HiddenRow>;
  /** Copies shown instead of a held row (a handed row) until a read brings a new copy of it. */
  readonly overrides: ReadonlyMap<string, { readonly from: Row; readonly to: Row }>;
}

const highestArrival = (rows: readonly InboxVisitRow[]): number =>
  rows.reduce((highest, row) => Math.max(highest, row.arrival), 0);

/** Starts a visit from its first page: the first row is current. */
export function startVisit<Row extends InboxVisitRow, Query>(
  query: Query,
  page: FirstPage<Row>,
  ticket: ReadTicket,
): VisitState<Row, Query> {
  return {
    query,
    rows: page.rows,
    arrivals: [],
    firstPageRefs: page.rows.map((row) => row.ref),
    frontier: page.nextCursor,
    watermark: highestArrival(page.rows),
    current: page.rows[0]?.ref ?? null,
    selection: new Set(),
    anchor: null,
    total: page.total,
    order: page.order,
    facets: page.facets ?? [],
    freshAt: new Map(page.rows.map((row) => [row.ref, ticket.gen])),
    locks: new Map(),
    hidden: new Map(),
    overrides: new Map(),
  };
}

/**
 * Returns the rows to ask a refresh or a row read about: the held rows in a
 * window of at most `HELD_WINDOW` around the viewport, centred on it. Rows far
 * from the viewport are left stale until they scroll back into view.
 */
export function pickWindow<Row>(
  rows: readonly Row[],
  firstIndex: number,
  lastIndex: number,
): readonly Row[] {
  const visible = Math.max(1, lastIndex - firstIndex + 1);
  const padding = Math.max(0, Math.floor((HELD_WINDOW - visible) / 2));
  const start = Math.max(0, Math.min(firstIndex - padding, rows.length - HELD_WINDOW));
  return rows.slice(start, start + HELD_WINDOW);
}

/**
 * Settles the hidden rows against a read: a dismissal confirmed before the
 * read was issued is over once the read covered the row, whether the row is
 * back (`revived`) or gone. A row the read did not cover stays hidden.
 */
function settleHidden(
  state: VisitState<InboxVisitRow, unknown>,
  ticket: ReadTicket,
  covers: (ref: string) => boolean,
  isPresent: (ref: string) => boolean,
): { hidden: Map<string, HiddenRow>; revived: Set<string> } {
  const hidden = new Map(state.hidden);
  const revived = new Set<string>();
  for (const [ref, entry] of state.hidden) {
    if (entry.confirmedAfter === null || ticket.seq <= entry.confirmedAfter || !covers(ref))
      continue;
    hidden.delete(ref);
    if (isPresent(ref)) revived.add(ref);
  }
  return { hidden, revived };
}

const isLocked = (
  state: VisitState<InboxVisitRow, unknown>,
  ref: string,
  ticket: ReadTicket,
): boolean => (state.locks.get(ref) ?? -1) >= ticket.seq;

/**
 * Applies one refresh. `asked` is every ref the read asked about (the held
 * rows of the window and the hidden rows), `heldRows` the asked rows still in
 * the list. Then:
 * - a held row found in any reply is replaced by its new copy, in place;
 * - a held row that was asked for and found in none has left, and is dropped;
 * - a held row that was not asked for is stale and kept;
 * - a first-page row that is not held becomes an arrival, unless the first page
 *   has a next page, the row ranks after every held row of the first page, and
 *   its `arrival` is not above the watermark. That row did not appear: it slid
 *   into the first page from the next one because a row above it left (a page
 *   holds at most 200 things). It is appended quietly and not counted. Position
 *   alone is not evidence: a genuine arrival can rank last too, and only its
 *   arrival number tells it apart.
 * - a hidden row stays hidden until a read issued after its dismissal was
 *   confirmed covers it. A row that is then back is an arrival, never quiet.
 */
export function applyRefresh<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  reply: {
    readonly firstPage: FirstPage<Row>;
    readonly heldRows: readonly Row[];
    readonly asked: readonly string[];
  },
  ticket: ReadTicket,
): VisitState<Row, Query> {
  const { firstPage } = reply;
  const found = new Map<string, Row>();
  for (const row of reply.heldRows) found.set(row.ref, row);
  for (const row of firstPage.rows) found.set(row.ref, row);
  const asked = new Set(reply.asked);
  const { hidden, revived } = settleHidden(
    state,
    ticket,
    (ref) => asked.has(ref) || found.has(ref),
    (ref) => found.has(ref),
  );

  const heldRefs = new Set(state.rows.map((row) => row.ref));
  const freshAt = new Map(state.freshAt);
  const kept = state.rows.flatMap((row) => {
    if (isLocked(state, row.ref, ticket)) return [row];
    const next = found.get(row.ref);
    if (next !== undefined) {
      freshAt.set(row.ref, ticket.gen);
      return [replaceEqualDeep(row, next)];
    }
    if (!asked.has(row.ref)) return [row];
    freshAt.delete(row.ref);
    return [];
  });
  const unheld = firstPage.rows.filter((row) => !heldRefs.has(row.ref) && !hidden.has(row.ref));
  for (const row of unheld) freshAt.set(row.ref, ticket.gen);
  const lastHeldRank = firstPage.rows.findLastIndex((row) => heldRefs.has(row.ref));
  const hasMore = firstPage.nextCursor !== undefined;
  const slidIn = (row: Row) =>
    hasMore &&
    lastHeldRank >= 0 &&
    firstPage.rows.indexOf(row) > lastHeldRank &&
    row.arrival <= state.watermark &&
    !revived.has(row.ref);
  return withRows(
    {
      ...state,
      arrivals: unheld.filter((row) => !slidIn(row)),
      firstPageRefs: firstPage.rows.map((row) => row.ref),
      total: firstPage.total,
      order: replaceEqualDeep(state.order, firstPage.order),
      facets: replaceEqualDeep(state.facets, firstPage.facets ?? state.facets),
      freshAt,
      hidden,
    },
    [...kept, ...unheld.filter(slidIn)],
  );
}

/**
 * Applies a read of specific rows (rows that scrolled back into view): asked
 * rows found are replaced in place, asked rows not found have left. Never adds
 * a row.
 */
export function applyRowsRead<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  reply: { readonly rows: readonly Row[]; readonly asked: readonly string[] },
  ticket: ReadTicket,
): VisitState<Row, Query> {
  const found = new Map(reply.rows.map((row) => [row.ref, row]));
  const asked = new Set(reply.asked);
  const freshAt = new Map(state.freshAt);
  const rows = state.rows.flatMap((row) => {
    if (!asked.has(row.ref) || isLocked(state, row.ref, ticket)) return [row];
    const next = found.get(row.ref);
    if (next === undefined) {
      freshAt.delete(row.ref);
      return [];
    }
    freshAt.set(row.ref, ticket.gen);
    return [next];
  });
  return withRows({ ...state, freshAt }, rows);
}

/**
 * Appends a next page: the rows the list does not hold yet and has not hidden.
 * Ignored when it did not continue from the frontier (another page was
 * fetched meanwhile). A hidden row the page carries, when the page was read
 * after the dismissal was confirmed, belongs to the list again and is added.
 */
export function applyNextPage<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  page: NextPage<Row> & { readonly after: string },
  ticket: ReadTicket,
): VisitState<Row, Query> {
  if (page.after !== state.frontier) return state;
  const present = new Set(page.rows.map((row) => row.ref));
  const { hidden } = settleHidden(
    state,
    ticket,
    (ref) => present.has(ref),
    () => true,
  );
  const held = new Set(state.rows.map((row) => row.ref));
  const added = page.rows.filter((row) => !held.has(row.ref) && !hidden.has(row.ref));
  const addedRefs = new Set(added.map((row) => row.ref));
  const freshAt = new Map(state.freshAt);
  for (const ref of addedRefs) freshAt.set(ref, ticket.gen);
  return withRows(
    {
      ...state,
      hidden,
      freshAt,
      watermark: Math.max(state.watermark, highestArrival(added)),
      frontier: page.nextCursor,
      arrivals: state.arrivals.filter((row) => !addedRefs.has(row.ref)),
    },
    [...state.rows, ...added],
  );
}

/**
 * Takes the arrivals into the list ("Show"). Each goes right after the nearest
 * row above it in the first page's rank that the list holds, or to the top when
 * there is none. The topmost arrival becomes current. Returns the same state
 * when nothing waits.
 */
export function takeArrivals<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
): VisitState<Row, Query> {
  if (state.arrivals.length === 0) return state;
  // One pass over the first page's rank finds every anchor: the nearest row
  // above that is held or is itself an arrival.
  const members = new Set([...state.rows, ...state.arrivals].map((row) => row.ref));
  const arrivalByRef = new Map(state.arrivals.map((row) => [row.ref, row]));
  const placed = new Set<string>();
  const after = new Map<string, Row>();
  const top: Row[] = [];
  let anchor: string | undefined;
  for (const ref of state.firstPageRefs) {
    const arrival = arrivalByRef.get(ref);
    if (arrival !== undefined) {
      placed.add(ref);
      if (anchor === undefined) top.push(arrival);
      else after.set(anchor, arrival);
    }
    if (members.has(ref)) anchor = ref;
  }
  // An arrival missing from the rank cannot be placed; it goes to the top.
  for (const arrival of state.arrivals) if (!placed.has(arrival.ref)) top.push(arrival);
  const rows: Row[] = [];
  const emit = (row: Row) => {
    rows.push(row);
    const next = after.get(row.ref);
    if (next !== undefined) emit(next);
  };
  for (const row of top) emit(row);
  for (const row of state.rows) emit(row);
  const shown = new Set(state.arrivals.map((row) => row.ref));
  const first = rows.find((row) => shown.has(row.ref));
  return {
    ...withRows(
      {
        ...state,
        arrivals: [],
        watermark: Math.max(state.watermark, highestArrival(state.arrivals)),
      },
      rows,
    ),
    current: first?.ref ?? state.current,
  };
}

/**
 * Applies a move to the rows the user handled, and returns what undo needs.
 * The current row moves on at once when it is among them: to the next row after
 * it in the old order that is not handled, else the previous one. The selection
 * drops the handled rows.
 *
 * - `dismissed`: the rows leave at once and stay hidden until a read issued
 *   after `confirmMove` shows the controller dropped them.
 * - `taken`: the rows may still belong to the list, so they stay. A read
 *   updates them in place or drops them. `show` gives the copy to draw in the
 *   meantime (a handed row), kept until a read brings a new copy.
 */
export function applyMove<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  move: {
    readonly id: number;
    readonly visit: number;
    readonly kind: "dismissed" | "taken";
    readonly refs: readonly string[];
    readonly show?: ((row: Row) => Row) | undefined;
  },
): { state: VisitState<Row, Query>; receipt: MoveReceipt<Row> } {
  const isHandled = new Set(move.refs);
  const entries = state.rows.flatMap((row, index) =>
    isHandled.has(row.ref) ? [{ row, index }] : [],
  );
  const receipt: MoveReceipt<Row> = {
    id: move.id,
    visit: move.visit,
    refs: entries.map((entry) => entry.row.ref),
    entries,
  };
  if (move.kind === "dismissed") {
    const hidden = new Map(state.hidden);
    for (const { row } of entries) {
      hidden.set(row.ref, { receiptId: move.id, confirmedAfter: null });
    }
    return {
      state: withRows(
        { ...state, hidden },
        state.rows.filter((row) => !isHandled.has(row.ref)),
      ),
      receipt,
    };
  }
  const overrides = new Map(state.overrides);
  if (move.show !== undefined) {
    for (const { row } of entries) overrides.set(row.ref, { from: row, to: move.show(row) });
  }
  const refs = state.rows.map((row) => row.ref);
  const at = state.current === null ? -1 : refs.indexOf(state.current);
  const current =
    at < 0 || !isHandled.has(state.current!)
      ? state.current
      : ([...refs.slice(at + 1), ...refs.slice(0, at).reverse()].find(
          (ref) => !isHandled.has(ref),
        ) ?? state.current);
  return {
    state: {
      ...state,
      overrides,
      current,
      selection: new Set([...state.selection].filter((ref) => !isHandled.has(ref))),
      anchor: state.anchor !== null && isHandled.has(state.anchor) ? null : state.anchor,
    },
    receipt,
  };
}

/** Marks the dismissal of a move as confirmed by the controller at `seq`. */
export function confirmHidden<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  receipt: MoveReceipt<Row>,
  seq: number,
): VisitState<Row, Query> {
  const hidden = new Map(state.hidden);
  for (const [ref, entry] of state.hidden) {
    if (entry.receiptId === receipt.id) hidden.set(ref, { ...entry, confirmedAfter: seq });
  }
  return { ...state, hidden };
}

/**
 * Takes a move back and makes the topmost of its rows current. Rows that left
 * are put back at their old place with the receipt's copy; a row that came back
 * since and waits behind "N new" is taken out of the arrivals and put at its old
 * place with its newest copy. Rows that stayed are only made current, never
 * added twice. The rows are locked at `seq`, so a read issued before the undo
 * cannot take them out again. Returns the same state when nothing is put back.
 */
export function applyUndo<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  receipt: MoveReceipt<Row>,
  seq: number,
): VisitState<Row, Query> {
  const held = new Set(state.rows.map((row) => row.ref));
  const arrived = new Map(state.arrivals.map((row) => [row.ref, row]));
  const rows = [...state.rows];
  for (const { row, index } of receipt.entries) {
    if (!held.has(row.ref)) {
      rows.splice(Math.min(index, rows.length), 0, arrived.get(row.ref) ?? row);
    }
  }
  const wanted = new Set(receipt.refs);
  const topmost = rows.find((row) => wanted.has(row.ref));
  if (topmost === undefined) return state;
  const hidden = new Map(state.hidden);
  const overrides = new Map(state.overrides);
  const locks = new Map(state.locks);
  const freshAt = new Map(state.freshAt);
  for (const ref of receipt.refs) {
    hidden.delete(ref);
    overrides.delete(ref);
    locks.set(ref, seq);
    freshAt.set(ref, -1);
  }
  return {
    ...withRows(
      {
        ...state,
        arrivals: state.arrivals.filter((row) => !wanted.has(row.ref)),
        hidden,
        overrides,
        locks,
        freshAt,
      },
      rows,
    ),
    current: topmost.ref,
  };
}

/**
 * Moves the current row one step (J, K), or to a given row (a click). A step
 * with `extend` (⇧J, ⇧K) selects the range from the anchor to the new current
 * row, so stepping back shrinks it. Any other move forgets the anchor. A step
 * past either end stays on the end row.
 */
export function moveCurrent<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  move: { readonly by: 1 | -1; readonly extend?: boolean },
): VisitState<Row, Query> {
  const index = state.rows.findIndex((row) => row.ref === state.current);
  const target = state.rows[Math.max(0, Math.min(state.rows.length - 1, index + move.by))];
  if (target === undefined) return state;
  if (!move.extend) return { ...state, current: target.ref, anchor: null };
  const anchor = state.anchor ?? state.current ?? target.ref;
  return {
    ...state,
    current: target.ref,
    anchor,
    selection: selectRange(state.rows, anchor, target.ref),
  };
}

export type SelectionChange =
  /** A click: the row becomes current and nothing is selected by it. */
  | { readonly kind: "focus"; readonly ref: string }
  /** X or a ⌘-click: flips one row, which becomes current and the anchor. */
  | { readonly kind: "toggle"; readonly ref: string }
  /** A ⇧-click: selects from the anchor (else the current row) to the row. */
  | { readonly kind: "extendTo"; readonly ref: string }
  /** ⌘A: every displayed row. */
  | { readonly kind: "all" }
  /** Esc: nothing. */
  | { readonly kind: "clear" };

/** Changes the selection. A ref that is not displayed is ignored. */
export function applySelectionChange<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  change: SelectionChange,
): VisitState<Row, Query> {
  if (change.kind === "all")
    return { ...state, selection: new Set(state.rows.map((row) => row.ref)) };
  if (change.kind === "clear") return { ...state, selection: new Set(), anchor: null };
  if (!state.rows.some((row) => row.ref === change.ref)) return state;
  if (change.kind === "focus") return { ...state, current: change.ref, anchor: null };
  if (change.kind === "toggle") {
    const selection = new Set(state.selection);
    if (!selection.delete(change.ref)) selection.add(change.ref);
    return { ...state, selection, current: change.ref, anchor: change.ref };
  }
  const anchor = state.anchor ?? state.current ?? change.ref;
  return {
    ...state,
    current: change.ref,
    anchor,
    selection: selectRange(state.rows, anchor, change.ref),
  };
}

/**
 * Returns the refs a move acts on, in displayed order.
 * - From the keyboard or the pane (no `hoveredRef`): the selection if there is
 *   one, else the current row.
 * - From a row's own hover button: that row, unless it is in the selection,
 *   then the whole selection.
 */
export function listMoveTargets(
  state: VisitState<InboxVisitRow, unknown>,
  hoveredRef?: string,
): string[] {
  const refs = state.rows.map((row) => row.ref);
  const isSelected = (ref: string) => state.selection.has(ref);
  if (hoveredRef !== undefined)
    return isSelected(hoveredRef) ? refs.filter(isSelected) : [hoveredRef];
  if (state.selection.size > 0) return refs.filter(isSelected);
  return state.current === null ? [] : [state.current];
}

function selectRange(rows: readonly InboxVisitRow[], fromRef: string, toRef: string): Set<string> {
  const from = rows.findIndex((row) => row.ref === fromRef);
  const to = rows.findIndex((row) => row.ref === toRef);
  if (from < 0 || to < 0) return new Set();
  return new Set(rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.ref));
}

/**
 * Sets the rows, then repairs what hangs on them: the selection keeps only
 * displayed rows, the anchor resets when its row is gone, and a current row
 * that is gone gives way to the next row after it in the old order that is
 * still displayed (else the previous one). With no current row, the first row
 * takes it.
 */
function withRows<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  rows: readonly Row[],
): VisitState<Row, Query> {
  const shown = new Set(rows.map((row) => row.ref));
  const oldRefs = state.rows.map((row) => row.ref);
  const kept = [...state.selection].filter((ref) => shown.has(ref));
  const selection = kept.length === state.selection.size ? state.selection : new Set(kept);
  const anchor = state.anchor !== null && shown.has(state.anchor) ? state.anchor : null;
  let current = state.current;
  if (current === null || !shown.has(current)) {
    const at = current === null ? -1 : oldRefs.indexOf(current);
    const after = at < 0 ? [] : oldRefs.slice(at + 1);
    const before = at < 0 ? [] : oldRefs.slice(0, at).reverse();
    current = [...after, ...before].find((ref) => shown.has(ref)) ?? rows[0]?.ref ?? null;
  }
  return { ...state, rows, selection, anchor, current };
}
