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
import type { InboxFacet, InboxGroup, InboxOrder } from "@hercule/contract";
import {
  buildEntries,
  entryRefs,
  findEntryKey,
  gatherGroupRows,
  isGroupKey,
  listEntryRows,
  reconcileGroups,
  removeMembers,
  settleKey,
  type GroupFold,
  type GroupKey,
  type HeldGroup,
  type InboxEntry,
} from "./inbox-groups";
import type { InboxMoveTarget } from "./inbox-moves";

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
  /** The groups of linked things whose members are in `rows`. */
  readonly groups: readonly InboxGroup[];
  readonly nextCursor?: string | undefined;
  readonly total: number;
  readonly order: InboxOrder;
  /** Only a first page carries facets. */
  readonly facets?: readonly InboxFacet[] | undefined;
}

export interface NextPage<Row> {
  readonly rows: readonly Row[];
  readonly groups: readonly InboxGroup[];
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
  /** The groups the move touched, as they were before it, so an undo can put them back under their keys. */
  readonly groups: readonly HeldGroup[];
  /** The entry that was current when the move was made. */
  readonly currentKey: string | null;
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
  /** The key of the current entry: a thing's ref, a group's key (its head), or a group's "more" key. */
  readonly current: string | null;
  /** Refs of selected rows, never keys of groups. */
  readonly selection: ReadonlySet<string>;
  /** The key of the entry a range selection starts from. */
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
  /** The groups of linked things the list holds, with the keys the visit gave them. */
  readonly groups: readonly HeldGroup[];
  /** The number the next minted group key gets. */
  readonly nextGroupNumber: number;
  /** What the user chose for each group. A group with no choice is displayed by default (see `buildEntries`). */
  readonly folds: ReadonlyMap<GroupKey, GroupFold>;
  /** True when the list has text or clauses to search for. Fixed when the list opens. */
  readonly isSearch: boolean;
  /**
   * Set when a move made a group's head the current entry, with the time it
   * happened (`now`). Cleared by every other change of the current entry, so
   * a second E on the head that just arrived is not taken for a decision.
   */
  readonly landedOn: { readonly key: GroupKey; readonly at: number } | null;
}

/** A second dismissal of a group's head within this many milliseconds of the first move onto it is refused. */
export const FRESH_GROUP_MS = 600;

const highestArrival = (rows: readonly InboxVisitRow[]): number =>
  rows.reduce((highest, row) => Math.max(highest, row.arrival), 0);

/** Starts a visit from its first page: the first entry is current. */
export function startVisit<Row extends InboxVisitRow, Query>(
  query: Query,
  page: FirstPage<Row>,
  ticket: ReadTicket,
  isSearch: boolean,
): VisitState<Row, Query> {
  const { groups, nextNumber } = reconcileGroups({
    previous: [],
    incoming: page.groups,
    covered: new Set(),
    nextNumber: 1,
    currentGroup: null,
  });
  const rows = gatherGroupRows(page.rows, groups);
  const folds = new Map<GroupKey, GroupFold>();
  const entries = buildEntries({ rows, groups, folds, isSearch, selection: new Set() });
  return {
    query,
    rows,
    arrivals: [],
    firstPageRefs: page.rows.map((row) => row.ref),
    frontier: page.nextCursor,
    watermark: highestArrival(page.rows),
    current: entries[0]?.key ?? null,
    selection: new Set(),
    anchor: null,
    total: page.total,
    order: page.order,
    facets: page.facets ?? [],
    freshAt: new Map(page.rows.map((row) => [row.ref, ticket.gen])),
    locks: new Map(),
    hidden: new Map(),
    overrides: new Map(),
    groups,
    nextGroupNumber: nextNumber,
    folds,
    isSearch,
    landedOn: null,
  };
}

/** Returns the rows as the list draws them: a row with an override shows its override's copy. */
export function listShownRows<Row extends InboxVisitRow>(
  state: Pick<VisitState<Row, unknown>, "rows" | "overrides">,
): Row[] {
  return state.rows.map((row) => {
    const override = state.overrides.get(row.ref);
    return override?.from === row ? override.to : row;
  });
}

/** Builds the entries of the list from `rows` (the state's rows, or the shown copies of them). */
export function buildStateEntries<Row extends InboxVisitRow>(
  state: VisitState<Row, unknown>,
  rows: readonly Row[],
): InboxEntry<Row>[] {
  return buildEntries({
    rows,
    groups: state.groups,
    folds: state.folds,
    isSearch: state.isSearch,
    selection: state.selection,
  });
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
 * Matches the groups a read describes to the groups the visit holds (see
 * `reconcileGroups`) and returns the new groups with the folds that follow them.
 *
 * - `found` are the refs the read vouches for as on the list; a group the read
 *   does not mention keeps the members the read did not cover.
 * - A member the visit hid is left out of the reply's group, so a dismissal
 *   that is still on its way never draws its group again.
 * - A reply group with a member the visit put back locally (see `locks`) is
 *   ignored: the read may predate that, so it may not regroup the member.
 */
function reconcileReadGroups<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  read: {
    readonly previous: readonly HeldGroup[];
    readonly groups: readonly InboxGroup[];
    readonly found: Iterable<string>;
    readonly hidden: ReadonlyMap<string, HiddenRow>;
    readonly ticket: ReadTicket;
  },
): Pick<VisitState<Row, Query>, "groups" | "nextGroupNumber" | "folds"> {
  const covered = new Set(read.found);
  const incoming: HeldGroup[] = [];
  for (const group of read.groups) {
    if (group.members.some((member) => isLocked(state, member.ref, read.ticket))) {
      for (const member of group.members) covered.delete(member.ref);
      continue;
    }
    const members = group.members.filter((member) => !read.hidden.has(member.ref));
    for (const member of members) covered.add(member.ref);
    incoming.push({
      key: "group:0",
      labelRef: group.labelRef,
      label: group.label,
      members,
      size: group.size - (group.members.length - members.length),
    });
  }
  for (const ref of covered) if (isLocked(state, ref, read.ticket)) covered.delete(ref);
  const result = reconcileGroups({
    previous: read.previous,
    incoming,
    covered,
    nextNumber: state.nextGroupNumber,
    currentGroup: groupKeyOf(state, state.current),
  });
  const folds = new Map<GroupKey, GroupFold>();
  for (const group of result.groups) {
    const fold = state.folds.get(group.key) ?? state.folds.get(result.inherit.get(group.key)!);
    if (fold !== undefined) folds.set(group.key, fold);
  }
  return {
    groups: replaceEqualDeep(state.groups, result.groups),
    nextGroupNumber: result.nextNumber,
    folds: replaceEqualDeep(state.folds, folds),
  };
}

/** Returns the key of the group an entry key belongs to: the key itself, its "more" line's group, or the group holding the member. */
function groupKeyOf(
  state: VisitState<InboxVisitRow, unknown>,
  key: string | null,
): GroupKey | null {
  if (key === null) return null;
  const head = key.endsWith(":more") ? key.slice(0, -":more".length) : key;
  if (isGroupKey(head)) return head;
  return (
    state.groups.find((group) => group.members.some((member) => member.ref === key))?.key ?? null
  );
}

/**
 * Returns the groups of the first page and of the held rows as one list. A
 * group in both is described twice by one reply: the first description wins.
 */
function mergeGroupReplies(...lists: (readonly InboxGroup[])[]): InboxGroup[] {
  const byLabel = new Map<string, InboxGroup>();
  for (const group of lists.flat())
    if (!byLabel.has(group.labelRef)) byLabel.set(group.labelRef, group);
  return [...byLabel.values()];
}

/**
 * Applies one refresh. `asked` is every ref the read asked about (the held
 * rows of the window and the hidden rows), `heldRows` the asked rows still in
 * the list, and `heldGroups` the groups those rows belong to. Then:
 * - a held row found in any reply is replaced by its new copy, in place;
 * - a held row that was asked for and found in none has left, and is dropped
 *   from its group;
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
 * - the groups follow the reply (see `reconcileReadGroups`).
 */
export function applyRefresh<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  reply: {
    readonly firstPage: FirstPage<Row>;
    readonly heldRows: readonly Row[];
    readonly heldGroups: readonly InboxGroup[];
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
  const left = new Set<string>();
  const kept = state.rows.flatMap((row) => {
    if (isLocked(state, row.ref, ticket)) return [row];
    const next = found.get(row.ref);
    if (next !== undefined) {
      freshAt.set(row.ref, ticket.gen);
      return [replaceEqualDeep(row, next)];
    }
    if (!asked.has(row.ref)) return [row];
    freshAt.delete(row.ref);
    left.add(row.ref);
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
    state,
    {
      arrivals: unheld.filter((row) => !slidIn(row)),
      firstPageRefs: firstPage.rows.map((row) => row.ref),
      total: firstPage.total,
      order: replaceEqualDeep(state.order, firstPage.order),
      facets: replaceEqualDeep(state.facets, firstPage.facets ?? state.facets),
      freshAt,
      hidden,
      ...reconcileReadGroups(state, {
        previous: removeMembers(state.groups, left),
        groups: mergeGroupReplies(firstPage.groups, reply.heldGroups),
        found: [...found.keys(), ...left],
        hidden,
        ticket,
      }),
    },
    [...kept, ...unheld.filter(slidIn)],
  );
}

/**
 * Applies a read of specific rows (rows that scrolled back into view): asked
 * rows found are replaced in place, asked rows not found have left. Never adds
 * a row. The groups follow the reply like a refresh's.
 */
export function applyRowsRead<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  reply: {
    readonly rows: readonly Row[];
    readonly groups: readonly InboxGroup[];
    readonly asked: readonly string[];
  },
  ticket: ReadTicket,
): VisitState<Row, Query> {
  const found = new Map(reply.rows.map((row) => [row.ref, row]));
  const asked = new Set(reply.asked);
  const freshAt = new Map(state.freshAt);
  const left = new Set<string>();
  const rows = state.rows.flatMap((row) => {
    if (!asked.has(row.ref) || isLocked(state, row.ref, ticket)) return [row];
    const next = found.get(row.ref);
    if (next === undefined) {
      freshAt.delete(row.ref);
      left.add(row.ref);
      return [];
    }
    freshAt.set(row.ref, ticket.gen);
    return [next];
  });
  return withRows(
    state,
    {
      freshAt,
      ...reconcileReadGroups(state, {
        previous: removeMembers(state.groups, left),
        groups: reply.groups,
        found: [...found.keys(), ...left],
        hidden: state.hidden,
        ticket,
      }),
    },
    rows,
  );
}

/**
 * Appends a next page: the rows the list does not hold yet and has not hidden.
 * Ignored when it did not continue from the frontier (another page was
 * fetched meanwhile). A hidden row the page carries, when the page was read
 * after the dismissal was confirmed, belongs to the list again and is added.
 * The groups follow the page like a refresh's.
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
    state,
    {
      hidden,
      freshAt,
      watermark: Math.max(state.watermark, highestArrival(added)),
      frontier: page.nextCursor,
      arrivals: state.arrivals.filter((row) => !addedRefs.has(row.ref)),
      ...reconcileReadGroups(state, {
        previous: state.groups,
        groups: page.groups,
        found: present,
        hidden,
        ticket,
      }),
    },
    [...state.rows, ...added],
  );
}

/**
 * Takes the arrivals into the list ("Show"). Each goes right after the nearest
 * row above it in the first page's rank that the list holds, or to the top when
 * there is none. The entry of the topmost arrival becomes current (the head,
 * when its group is closed). Returns the same state when nothing waits.
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
  const result = withRows(
    state,
    { arrivals: [], watermark: Math.max(state.watermark, highestArrival(state.arrivals)) },
    rows,
  );
  const firstKey =
    first === undefined ? null : findEntryKey(buildStateEntries(result, result.rows), first.ref);
  return { ...result, current: firstKey ?? state.current };
}

/**
 * Applies a move to the rows the user handled, and returns what undo needs.
 * The current entry moves on at once when every row it stands for is handled:
 * to the next entry after it in the old order that stands for an unhandled
 * row, else the previous one. The selection drops the handled rows.
 *
 * - `dismissed`: the rows leave at once and stay hidden until a read issued
 *   after `confirmMove` shows the controller dropped them. They leave their
 *   groups too, and a group left with fewer than two members dissolves.
 * - `taken`: the rows may still belong to the list, so they stay. A read
 *   updates them in place or drops them. `show` gives the copy to draw in the
 *   meantime (a handed row), kept until a read brings a new copy.
 *
 * `at` is the time of the move. When a move leaves a group's head current, it
 * is recorded in `landedOn`, which `listMoveTargets` uses to tell a second
 * press of E meant for the next entry from the first press repeated.
 */
export function applyMove<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  move: {
    readonly id: number;
    readonly visit: number;
    readonly kind: "dismissed" | "taken";
    readonly refs: readonly string[];
    readonly at: number;
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
    groups: state.groups.filter((group) =>
      group.members.some((member) => isHandled.has(member.ref)),
    ),
    currentKey: state.current,
  };
  const land = (next: VisitState<Row, Query>): VisitState<Row, Query> => ({
    ...next,
    landedOn:
      next.current !== null && isGroupKey(next.current) && next.current !== state.current
        ? { key: next.current, at: move.at }
        : null,
  });
  if (move.kind === "dismissed") {
    const hidden = new Map(state.hidden);
    for (const { row } of entries) {
      hidden.set(row.ref, { receiptId: move.id, confirmedAfter: null });
    }
    return {
      state: land(
        withRows(
          state,
          { hidden, groups: removeMembers(state.groups, isHandled) },
          state.rows.filter((row) => !isHandled.has(row.ref)),
        ),
      ),
      receipt,
    };
  }
  const overrides = new Map(state.overrides);
  if (move.show !== undefined) {
    for (const { row } of entries) overrides.set(row.ref, { from: row, to: move.show(row) });
  }
  const oldEntries = buildStateEntries(state, state.rows);
  const standsFor = listEntryRows(oldEntries);
  const isUnhandled = (index: number) => !standsFor[index]!.every((ref) => isHandled.has(ref));
  const indexes = [...oldEntries.keys()];
  const at = oldEntries.findIndex((entry) => entry.key === state.current);
  const order =
    at < 0 || isUnhandled(at)
      ? []
      : [
          ...indexes.filter((index) => index > at),
          ...indexes.filter((index) => index < at).reverse(),
        ];
  const next = order.find(isUnhandled);
  const current = next === undefined ? state.current : oldEntries[next]!.key;
  return {
    state: land({
      ...state,
      overrides,
      current,
      selection: new Set([...state.selection].filter((ref) => !isHandled.has(ref))),
      anchor: state.anchor !== null && isHandled.has(state.anchor) ? null : state.anchor,
    }),
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
 * Puts the groups a move touched back: a group that still exists gets its
 * restored members back, and a group that dissolved is made again under its old
 * key from the receipt, with the members that are held or were restored.
 */
function restoreGroups(
  groups: readonly HeldGroup[],
  receipt: MoveReceipt<InboxVisitRow>,
  heldRefs: ReadonlySet<string>,
): readonly HeldGroup[] {
  const restored = new Set(receipt.refs);
  const result = [...groups];
  for (const before of receipt.groups) {
    const at = result.findIndex((group) => group.key === before.key);
    const current = at < 0 ? undefined : result[at];
    if (current === undefined) {
      const members = before.members.filter(
        (member) => heldRefs.has(member.ref) || restored.has(member.ref),
      );
      if (members.length < 2) continue;
      result.push({
        ...before,
        members,
        size: before.size - (before.members.length - members.length),
      });
      continue;
    }
    const present = new Set(current.members.map((member) => member.ref));
    const members = [
      ...before.members.filter((member) => present.has(member.ref) || restored.has(member.ref)),
      ...current.members.filter((member) => !before.members.some((m) => m.ref === member.ref)),
    ];
    result[at] = {
      ...current,
      members,
      size: current.size + (members.length - current.members.length),
    };
  }
  return result;
}

/**
 * Takes a move back and makes an entry of its rows current: the head of the
 * group that was current when the move was made, else the topmost entry that
 * shows a restored row. Rows that left are put back at their old place with
 * the receipt's copy; a row that came back since and waits behind "N new" is
 * taken out of the arrivals and put at its old place with its newest copy. Rows
 * that stayed are only made current, never added twice. The groups the move
 * touched are put back under their keys. The rows are locked at `seq`, so a
 * read issued before the undo cannot take them out again. Returns the same
 * state when nothing is put back.
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
  if (!rows.some((row) => wanted.has(row.ref))) return state;
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
  const result = withRows(
    state,
    {
      arrivals: state.arrivals.filter((row) => !wanted.has(row.ref)),
      hidden,
      overrides,
      locks,
      freshAt,
      groups: restoreGroups(state.groups, receipt, new Set(rows.map((row) => row.ref))),
      landedOn: null,
    },
    rows,
  );
  const entries = buildStateEntries(result, result.rows);
  const isHeadShown =
    receipt.currentKey !== null && entries.some((e) => e.key === receipt.currentKey);
  const topmost = entries.find((entry) =>
    entry.kind === "head"
      ? entry.group.rows.some((row) => wanted.has(row.ref))
      : entry.kind !== "more" && wanted.has(entry.row.ref),
  );
  const current =
    isHeadShown && isGroupKey(receipt.currentKey)
      ? receipt.currentKey
      : (topmost?.key ?? state.current);
  return { ...result, current };
}

/**
 * Moves the current entry one step (J, K): over heads, members and "Show N
 * more" lines. A step with `extend` (⇧J, ⇧K) selects the range from the anchor
 * to the new current entry, so stepping back shrinks it. Any other move forgets
 * the anchor. A step past either end stays on the end entry.
 */
export function moveCurrent<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  move: { readonly by: 1 | -1; readonly extend?: boolean },
): VisitState<Row, Query> {
  const entries = buildStateEntries(state, state.rows);
  const index = entries.findIndex((entry) => entry.key === state.current);
  const target = entries[Math.max(0, Math.min(entries.length - 1, index + move.by))];
  if (target === undefined) return state;
  if (!move.extend) return { ...state, current: target.key, anchor: null, landedOn: null };
  const anchor = state.anchor ?? state.current ?? target.key;
  return {
    ...state,
    current: target.key,
    anchor,
    selection: selectRange(entries, anchor, target.key),
    landedOn: null,
  };
}

export type SelectionChange =
  /** A click: the entry becomes current and nothing is selected by it. */
  | { readonly kind: "focus"; readonly ref: string }
  /**
   * X or a ⌘-click: flips one entry, which becomes current and the anchor. On a
   * group's head it flips the members that answer the query, or with `whole`
   * (⇧X) all its held members; when all of them are selected it removes them.
   */
  | { readonly kind: "toggle"; readonly ref: string; readonly whole?: boolean }
  /** A ⇧-click: selects from the anchor (else the current entry) to the entry. */
  | { readonly kind: "extendTo"; readonly ref: string }
  /** ⌘A: every thing and every group's members that answer the query. */
  | { readonly kind: "all" }
  /** Esc: nothing. */
  | { readonly kind: "clear" };

/**
 * Changes the selection. `ref` of a focus, a toggle or an extend is the key of
 * an entry (a thing's ref or a group's key); one that is not displayed is
 * ignored. The selection holds refs of things, never keys of groups.
 */
export function applySelectionChange<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  change: SelectionChange,
): VisitState<Row, Query> {
  if (change.kind === "clear")
    return { ...state, selection: new Set(), anchor: null, landedOn: null };
  const entries = buildStateEntries(state, state.rows);
  if (change.kind === "all") {
    const refs = entries.filter((e) => e.kind === "thing" || e.kind === "head").flatMap(entryRefs);
    return { ...state, selection: new Set(refs), landedOn: null };
  }
  const entry = entries.find((candidate) => candidate.key === change.ref);
  if (entry === undefined) return state;
  if (change.kind === "focus")
    return { ...state, current: change.ref, anchor: null, landedOn: null };
  if (change.kind === "toggle") {
    if (entry.kind === "more") return state;
    const refs =
      entry.kind === "head" && change.whole === true
        ? entry.group.rows.map((row) => row.ref)
        : entryRefs(entry);
    const selection = new Set(state.selection);
    if (refs.length > 0 && refs.every((ref) => selection.has(ref))) {
      for (const ref of refs) selection.delete(ref);
    } else {
      for (const ref of refs) selection.add(ref);
    }
    return { ...state, selection, current: change.ref, anchor: change.ref, landedOn: null };
  }
  const anchor = state.anchor ?? state.current ?? change.ref;
  return {
    ...state,
    current: change.ref,
    anchor,
    selection: selectRange(entries, anchor, change.ref),
    landedOn: null,
  };
}

export type FoldChange =
  /** → or ↩ on a head: opens the group. */
  | { readonly kind: "open"; readonly key?: string }
  /** ← on a head: closes the group. On a member or a "more" line: makes the head current. */
  | { readonly kind: "close"; readonly key?: string }
  /** ↩ on a "more" line: shows all the members, and the first newly shown one becomes current. */
  | { readonly kind: "showMore"; readonly key?: string };

/**
 * Opens, closes or expands a group, for the entry `key` (default: the current
 * entry). A fold never touches the selection. When a group closes while the
 * current entry or the anchor is one of its members, they move to the head.
 */
export function applyFold<Row extends InboxVisitRow, Query>(
  state: VisitState<Row, Query>,
  change: FoldChange,
): VisitState<Row, Query> {
  const key = change.key ?? state.current;
  const entries = buildStateEntries(state, state.rows);
  const entry = entries.find((candidate) => candidate.key === key);
  if (entry === undefined || entry.kind === "thing") return state;
  const cleared = { ...state, landedOn: null };
  if (change.kind === "close" && entry.kind !== "head") {
    return { ...cleared, current: entry.groupKey };
  }
  if (change.kind === "open" && entry.kind !== "head") return state;
  if (change.kind === "showMore" && entry.kind !== "more") return state;
  const groupKey = entry.kind === "head" ? entry.key : entry.groupKey;
  const folds = new Map(state.folds);
  folds.set(groupKey, {
    ...state.folds.get(groupKey),
    ...(change.kind === "showMore" ? { isExpanded: true } : { isOpen: change.kind === "open" }),
  });
  const next = { ...cleared, folds };
  const after = buildStateEntries(next, next.rows);
  if (change.kind === "showMore") {
    const membersOf = (list: readonly InboxEntry<Row>[]) =>
      list.filter((e) => e.kind === "member" && e.groupKey === groupKey);
    const firstNew = membersOf(after)[membersOf(entries).length];
    return { ...next, current: firstNew?.key ?? next.current };
  }
  const oldKeys = entries.map((e) => e.key);
  const settle = (at: string | null) =>
    at === null ? null : settleKey(oldKeys, after, at, state.groups);
  return { ...next, current: settle(next.current), anchor: settle(next.anchor) };
}

/**
 * Returns what a move acts on, or `null` when there is nothing.
 * - From the keyboard or the pane (no `hoveredKey`): the selection if there is
 *   one, else the current entry: a group when it is a head, else a thing.
 * - From an entry's own hover button: that entry, unless it is selected (a
 *   thing in the selection, or a head whose members that answer the query are
 *   all selected), then the whole selection.
 *
 * A group target is `isFresh` only when the keyboard acts (no hover, nothing
 * selected) and the head became current by a move less than `FRESH_GROUP_MS`
 * before `now`. Its `members` leave out the members the visit hid and the
 * arrivals that wait behind "N new", and its `size` follows.
 */
export function listMoveTargets<Row extends InboxVisitRow>(
  state: VisitState<Row, unknown>,
  hoveredKey: string | undefined,
  now: number,
): InboxMoveTarget<Row> | null {
  const rows = listShownRows(state);
  const entries = buildStateEntries(state, rows);
  const selectionTarget = (): InboxMoveTarget<Row> => ({
    kind: "selection",
    rows: rows.filter((row) => state.selection.has(row.ref)),
  });
  const targetOf = (key: string, isFresh: boolean): InboxMoveTarget<Row> | null => {
    const entry = entries.find((candidate) => candidate.key === key);
    if (entry === undefined || entry.kind === "more") return null;
    if (entry.kind !== "head") return { kind: "thing", row: entry.row };
    const group = state.groups.find((candidate) => candidate.key === key)!;
    const waiting = new Set(state.arrivals.map((row) => row.ref));
    const members = group.members
      .filter((member) => !state.hidden.has(member.ref) && !waiting.has(member.ref))
      .map(({ id, ref }) => ({ id, ref }));
    return {
      kind: "group",
      labelRef: group.labelRef,
      label: group.label,
      members,
      rows: entry.group.rows,
      size: group.size - (group.members.length - members.length),
      isFresh,
    };
  };
  if (hoveredKey !== undefined) {
    const entry = entries.find((candidate) => candidate.key === hoveredKey);
    const isSelected =
      entry !== undefined &&
      (entry.kind === "head"
        ? entry.group.tick === "all"
        : entry.kind !== "more" && state.selection.has(entry.row.ref));
    return isSelected ? selectionTarget() : targetOf(hoveredKey, false);
  }
  if (state.selection.size > 0) return selectionTarget();
  if (state.current === null) return null;
  const isFresh = state.landedOn?.key === state.current && now - state.landedOn.at < FRESH_GROUP_MS;
  return targetOf(state.current, isFresh);
}

/** Returns the refs of the entries from `fromKey` to `toKey`, both ends included, as a set. */
function selectRange(
  entries: readonly InboxEntry<InboxVisitRow>[],
  fromKey: string,
  toKey: string,
): Set<string> {
  const from = entries.findIndex((entry) => entry.key === fromKey);
  const to = entries.findIndex((entry) => entry.key === toKey);
  if (from < 0 || to < 0) return new Set();
  return new Set(
    entries.slice(Math.min(from, to), Math.max(from, to) + 1).flatMap((entry) => entryRefs(entry)),
  );
}

/**
 * Applies `patch` to `before` and sets the rows, then repairs what hangs on
 * them. The groups of the patched state gather their held rows next to each
 * other. The selection keeps only held rows. The anchor is kept while its entry
 * shows (or a group now shows it), else it resets. A current entry that is gone
 * gives way by `settleKey`; with no current entry, the first entry takes it.
 */
function withRows<Row extends InboxVisitRow, Query>(
  before: VisitState<Row, Query>,
  patch: Partial<VisitState<Row, Query>>,
  rows: readonly Row[],
): VisitState<Row, Query> {
  const patched = { ...before, ...patch };
  const gathered = gatherGroupRows(rows, patched.groups);
  const shown = new Set(gathered.map((row) => row.ref));
  const kept = [...patched.selection].filter((ref) => shown.has(ref));
  const selection = kept.length === patched.selection.size ? patched.selection : new Set(kept);
  const after = { ...patched, rows: gathered, selection };
  const entries = buildStateEntries(after, gathered);
  const oldKeys = buildStateEntries(before, before.rows).map((entry) => entry.key);
  const anchor = after.anchor === null ? null : findEntryKey(entries, after.anchor);
  const current =
    after.current === null
      ? (entries[0]?.key ?? null)
      : settleKey(oldKeys, entries, after.current, before.groups);
  return { ...after, anchor, current };
}
