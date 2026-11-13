/**
 * The Inbox visit: the whole life of one list the user looks at, kept so that
 * it holds still. A row never moves under the user's eyes; what the controller
 * changes meanwhile waits behind "N new" until the user takes it in.
 *
 * The visit owns:
 * - the rows, the arrivals, the current row, the selection and the anchor;
 * - every read, through the `InboxReader` port, with its order: an older
 *   read's answer never applies, a push during a read cancels it and reads
 *   again so no change is missed, a next page continues from the frontier;
 * - the moves the user makes, which show at once and stay in force until the
 *   controller's answer and a later read agree (see `move`);
 * - the freshness of each row against the pushes, so a refresh re-reads only
 *   the first page and the rows around the viewport, and the rest are re-read
 *   when they scroll back into view.
 *
 * It is framework-free: `subscribe` and `getSnapshot` fit React's
 * `useSyncExternalStore`, and the snapshot only changes when something did.
 * It draws nothing and times nothing: `lastChange` says what happened in
 * words (dismissed, restored, arrived) and the screen picks the motion.
 */
import { replaceEqualDeep } from "@tanstack/query-core";
import type { InboxFacet, InboxGroup, InboxOrder } from "@hercule/contract";
import { keepUnchangedEntries, listSelectionRefs, type InboxEntry } from "./inbox-groups";
import type { InboxMoveTarget } from "./inbox-moves";
import {
  HELD_WINDOW,
  applyFold,
  applyMove,
  applyNextPage,
  applyRefresh,
  applyRowsRead,
  applySelectionChange,
  applyUndo,
  buildStateEntries,
  confirmHidden,
  listMoveTargets,
  listShownRows,
  listUnloadedMembers,
  openLinkedGroup,
  moveCurrent,
  pickWindow,
  startVisit,
  takeArrivals,
  type FirstPage,
  type FoldChange,
  type InboxVisitRow,
  type MoveReceipt,
  type NextPage,
  type ReadTicket,
  type SelectionChange,
  type VisitState,
} from "./inbox-visit-state";

export type { FirstPage, FoldChange, InboxVisitRow, MoveReceipt, NextPage, SelectionChange };
export type { InboxMoveTarget };
export { buildMoreKey, findEntryKey, parseMoreKey } from "./inbox-groups";
export type { GroupKey, InboxEntry, InboxGroupView, MoreKey } from "./inbox-groups";

/**
 * How the visit reads. `Query` is opaque to the visit (the scope and search
 * of a list); the adapter maps it to the controller's request. Every read
 * takes an `AbortSignal` the visit aborts when the answer is no longer wanted.
 * `readFirst` and `refresh` carry the list's size, order and facets; the
 * replies of the others carry rows only. Every reply carries the groups the
 * rows belong to.
 */
export interface InboxReader<Row extends InboxVisitRow, Query> {
  /** Reads the first page of the list. */
  readFirst(query: Query, signal: AbortSignal): Promise<FirstPage<Row>>;
  /** Reads the page after the cursor `after`. */
  readNext(query: Query, after: string, signal: AbortSignal): Promise<NextPage<Row>>;
  /**
   * Reads the first page and, in the same reply, those of the `held` refs
   * (at most 400) that still belong to the list, with the groups of those. A
   * held ref in neither has left the list. A group may name members the visit
   * does not hold; that is not leaving.
   */
  refresh(
    query: Query,
    held: readonly string[],
    signal: AbortSignal,
  ): Promise<{
    readonly firstPage: FirstPage<Row>;
    readonly heldRows: readonly Row[];
    readonly heldGroups: readonly InboxGroup[];
  }>;
  /** Reads the `held` refs (at most 400) that still belong to the list, with their groups. */
  readRows(
    query: Query,
    held: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly rows: readonly Row[]; readonly groups: readonly InboxGroup[] }>;
}

/** What just happened to the rows, in words. The screen decides how that looks. */
export interface InboxVisitChange {
  readonly kind:
    /** The user dismissed rows. */
    | "dismissed"
    /** The user took rows on or handed them off; they stay until a read says otherwise. */
    | "taken"
    /** A dismissal emptied the list. */
    | "emptied-by-move"
    /** An undo or a refused move put rows back. */
    | "restored"
    /** Show took arrivals into the list. */
    | "arrived"
    /** A read found rows no longer belong to the list. */
    | "left";
  readonly refs: readonly string[];
}

export interface InboxVisitSnapshot<Row extends InboxVisitRow, Query> {
  /**
   * `loading` until the first page is in, `failed` when it could not be
   * read, else `ready`. While another list is being opened, the previous
   * rows stay shown and the status is `ready` until the new first page fails.
   */
  readonly status: "loading" | "failed" | "ready";
  readonly error: unknown;
  /** The list the rows belong to: the previous one while a new one is being opened. */
  readonly query: Query | null;
  /** The rows in visit order. A handed row is drawn as its hand-off copy. */
  readonly rows: readonly Row[];
  /**
   * What the list draws, in order: things, and for each group its head, its
   * members when open, and a "Show N more" line. Keeps its identity (and the
   * identity of each entry that is equal) across reads that change nothing.
   */
  readonly entries: readonly InboxEntry<Row>[];
  /** How many arrivals wait behind "N new". */
  readonly arrivals: number;
  /** The key of the current entry: a thing's ref, a group's key, or a group's "more" key. */
  readonly current: string | null;
  /** Refs of the selected rows: always a subset of `rows`. The selection never holds a group's key. */
  readonly selection: ReadonlySet<string>;
  /** The key of the entry a range selection starts from, or null. */
  readonly anchor: string | null;
  readonly total: number | undefined;
  readonly order: InboxOrder | undefined;
  readonly facets: readonly InboxFacet[];
  /**
   * The latest transition of the rows, or null. A new object per
   * transition and the same object until the next one, so a screen that sees
   * a different object knows something new happened.
   */
  readonly lastChange: InboxVisitChange | null;
}

export interface InboxVisit<Row extends InboxVisitRow, Query> {
  /**
   * Starts visiting the list of `query`, from its first page. The previous
   * list's rows stay shown until the new first page arrives. Call it again
   * with the same query to retry after a failure.
   */
  readonly open: (query: Query) => void;
  /** Cancels every read. Call it when the screen goes away. */
  readonly close: () => void;
  /** Tells the visit the controller changed: it reads the visible window again. */
  readonly pushArrived: () => void;
  /**
   * Tells the visit the user just linked things: `refs` are the things the
   * link joined. Reads like `pushArrived` does (cancelling the read in flight
   * and reading again). When the first read issued after this call is
   * accepted, the group that holds `refs` opens and becomes current, and its
   * members that wait as arrivals are taken in as its rows, so they are never
   * counted as "N new". When no group holds `refs`, that read changes nothing
   * special. The intent applies once, and opening another list drops it.
   */
  readonly linkMade: (refs: readonly string[]) => void;
  /**
   * Tells the visit which entries the user sees (indexes into `snapshot.entries`,
   * both ends included). Rows near the viewport that missed the latest push
   * are re-read, and the next page is read near the end.
   */
  readonly viewportChanged: (firstIndex: number, lastIndex: number) => void;
  /** Takes the arrivals in ("Show"), after re-reading the first page. */
  readonly show: () => void;
  /**
   * Applies a move of `refs` at once and returns its receipt.
   * - `dismissed`: the rows leave. A read never brings them back until one
   *   issued after `confirmMove` finds the controller dropped them.
   * - `taken`: the rows stay and the current row moves on. `show` gives the
   *   copy to draw in the meantime (a handed row), kept until a read brings a
   *   new copy.
   * Rows the visit does not hold are ignored.
   */
  readonly move: (
    kind: "dismissed" | "taken",
    refs: readonly string[],
    show?: (row: Row) => Row,
  ) => MoveReceipt<Row>;
  /** Tells the visit the controller accepted the move. */
  readonly confirmMove: (receipt: MoveReceipt<Row>) => void;
  /** Takes a move back because the controller refused it. */
  readonly failMove: (receipt: MoveReceipt<Row>) => void;
  /**
   * Takes back a move the controller has already undone: its rows return to
   * their old places and the topmost becomes current.
   */
  readonly undo: (receipt: MoveReceipt<Row>) => void;
  /** Steps the current row by one (J, K), or with `extend` extends the selection (⇧J, ⇧K). */
  readonly step: (by: 1 | -1, extend?: boolean) => void;
  /** Changes the selection or the current entry. */
  readonly select: (change: SelectionChange) => void;
  /** Opens, closes or expands a group (see `applyFold`). */
  readonly fold: (change: FoldChange) => void;
  /**
   * Returns what a move acts on (see `listMoveTargets`): the selection or the
   * current entry, or with `hoveredKey` that entry (the selection when it is in it).
   * Null when there is nothing.
   */
  readonly targets: (hoveredKey?: string) => InboxMoveTarget<Row> | null;
  readonly subscribe: (listener: () => void) => () => void;
  /** Returns the snapshot: the same object until something changed. */
  readonly getSnapshot: () => InboxVisitSnapshot<Row, Query>;
}

/** The next page is read when the viewport comes within this many rows of the end. */
const NEAR_END_ROWS = 20;

/** Shared so the snapshot of a visit that holds nothing keeps the same objects. */
const NO_SELECTION: ReadonlySet<string> = new Set();
const NO_FACETS: readonly InboxFacet[] = [];
const NO_ENTRIES: readonly never[] = [];

/**
 * Returns the range of rows (indexes into `rows`) that the entries from
 * `firstIndex` to `lastIndex` stand for, or `undefined` when none stands for a row.
 * A head stands for all the held members of its group.
 */
function findViewedRowRange<Row extends InboxVisitRow>(
  rows: readonly Row[],
  entries: readonly InboxEntry<Row>[],
  firstIndex: number,
  lastIndex: number,
): { first: number; last: number } | undefined {
  const indexOf = new Map(rows.map((row, index) => [row.ref, index]));
  const seen = entries
    .slice(Math.max(0, firstIndex), lastIndex + 1)
    .flatMap((entry) =>
      entry.kind === "head" ? entry.group.rows.map((row) => row.ref) : listSelectionRefs(entry),
    )
    .flatMap((ref) => indexOf.get(ref) ?? []);
  if (seen.length === 0) return undefined;
  return { first: Math.min(...seen), last: Math.max(...seen) };
}

interface Read {
  /** The visit (list shown) that was current when the read was issued. */
  readonly visit: number;
  readonly controller: AbortController;
  readonly ticket: ReadTicket;
  readonly refs: ReadonlySet<string>;
}

export interface InboxVisitOptions<Query> {
  /** Returns the time in milliseconds. The visit starts no timer; it only asks the time of a move. Default: `performance.now`. */
  readonly now?: () => number;
  /** Tells whether a list has text or clauses to search for, so groups with a hit inside open. Default: never. */
  readonly isSearch?: (query: Query) => boolean;
}

/** Creates a visit that reads through `reader`. It starts empty: call `open`. */
export function createInboxVisit<Row extends InboxVisitRow, Query>(
  reader: InboxReader<Row, Query>,
  options: InboxVisitOptions<Query> = {},
): InboxVisit<Row, Query> {
  const now = options.now ?? (() => performance.now());
  let seq = 0;
  let pushGen = 0;
  let visitId = 0;
  let receiptId = 0;
  let viewport = { first: 0, last: 0 };
  /** The state of the list shown, or null before the first first-page arrived. */
  let state: VisitState<Row, Query> | null = null;
  /** The list being opened: its first read is on its way or has failed. */
  let opening: { readonly query: Query; read: Read | null; error: unknown } | null = null;
  let refreshing: Read | null = null;
  let nextPage: (Read & { readonly after: string }) | null = null;
  const rowReads = new Set<Read>();
  /** The list each move was made in, by receipt id, so an undo can find its list again. */
  const receiptQueries = new Map<number, Query>();
  /** The ids of the moves that handled each row, oldest first, until the move is put back. */
  const claims = new Map<string, number[]>();
  let isShowPending = false;
  /** The things the user linked, until the first read issued after the link applies. */
  let pendingLink: { readonly refs: readonly string[] } | null = null;
  let lastChange: InboxVisitChange | null = null;
  const listeners = new Set<() => void>();
  let snapshot = buildSnapshot(null);

  /** Builds the snapshot; its `rows` array is `previous`'s when every row is the same object. */
  function buildSnapshot(
    previous: InboxVisitSnapshot<Row, Query> | null,
  ): InboxVisitSnapshot<Row, Query> {
    const failed = opening !== null && opening.read === null;
    const shown = state === null ? [] : listShownRows(state);
    const isSameRows =
      previous !== null &&
      previous.rows.length === shown.length &&
      previous.rows.every((row, index) => row === shown[index]);
    return {
      status: failed ? "failed" : state === null ? "loading" : "ready",
      error: opening?.error,
      query: state?.query ?? null,
      rows: isSameRows ? previous.rows : shown,
      entries: keepUnchangedEntries(
        previous?.entries ?? NO_ENTRIES,
        state === null ? NO_ENTRIES : buildStateEntries(state, shown),
      ),
      arrivals: state?.arrivals.length ?? 0,
      current: state?.current ?? null,
      selection: state?.selection ?? NO_SELECTION,
      anchor: state?.anchor ?? null,
      total: state?.total,
      order: state?.order,
      facets: state?.facets ?? NO_FACETS,
      lastChange,
    };
  }

  /** Rebuilds the snapshot and tells the listeners, unless nothing the screen draws changed. */
  function commit(): void {
    const next = buildSnapshot(snapshot);
    const isUnchanged = (Object.keys(next) as (keyof typeof next)[]).every((key) =>
      Object.is(next[key], snapshot[key]),
    );
    if (isUnchanged) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  /** Replaces the state and commits, naming the transition when rows left or came. */
  function setState(next: VisitState<Row, Query>, change?: InboxVisitChange): void {
    if (next === state) return;
    const before = state;
    state = next;
    if (change !== undefined) lastChange = change;
    else if (before !== null) {
      const kept = new Set(next.rows.map((row) => row.ref));
      const left = before.rows.map((row) => row.ref).filter((ref) => !kept.has(ref));
      if (left.length > 0) lastChange = { kind: "left", refs: left };
    }
    commit();
  }

  function startRead(refs: readonly string[] = []): Read {
    seq += 1;
    return {
      visit: visitId,
      controller: new AbortController(),
      ticket: { seq, gen: pushGen },
      refs: new Set(refs),
    };
  }

  /**
   * Returns the state a finished read applies to, or null when the read no
   * longer applies: it was cancelled, or it was issued for the list that was
   * shown before the current one. A read of the list left behind never
   * touches the one that replaced it.
   */
  function acceptRead(read: Read): VisitState<Row, Query> | null {
    return !read.controller.signal.aborted && read.visit === visitId ? state : null;
  }

  function cancelRowReads(): void {
    refreshing?.controller.abort();
    refreshing = null;
    for (const read of rowReads) read.controller.abort();
    rowReads.clear();
  }

  function cancelAll(): void {
    cancelRowReads();
    nextPage?.controller.abort();
    nextPage = null;
    opening?.read?.controller.abort();
  }

  function startFirstRead(): void {
    if (opening === null) return;
    const current = opening;
    const read = startRead();
    current.read?.controller.abort();
    current.read = read;
    current.error = undefined;
    reader.readFirst(current.query, read.controller.signal).then(
      (page) => {
        if (read.controller.signal.aborted || opening !== current) return;
        opening = null;
        cancelAll();
        visitId += 1;
        isShowPending = false;
        pendingLink = null;
        viewport = { first: 0, last: 0 };
        lastChange = null;
        state = startVisit(
          current.query,
          page,
          read.ticket,
          options.isSearch?.(current.query) ?? false,
        );
        commit();
        readStaleRows();
      },
      (error: unknown) => {
        if (read.controller.signal.aborted || opening !== current) return;
        current.read = null;
        current.error = error;
        commit();
      },
    );
  }

  function startRefresh(): void {
    if (state === null) return;
    const query = state.query;
    cancelRowReads();
    // A dismissed group hides every member, so the hidden refs may outnumber the window.
    // They take at most half of it and the rest are asked in the refreshes after.
    const hidden = [...state.hidden.keys()].slice(0, HELD_WINDOW / 2);
    const held = [
      ...hidden,
      ...pickWindow(state.rows, viewport.first, viewport.last)
        .map((row) => row.ref)
        .slice(0, HELD_WINDOW - hidden.length),
    ];
    const read = startRead(held);
    refreshing = read;
    const link = pendingLink;
    reader.refresh(query, held, read.controller.signal).then(
      (reply) => {
        const accepted = acceptRead(read);
        if (accepted === null) return;
        refreshing = null;
        const refreshed = applyRefresh(accepted, { ...reply, asked: held }, read.ticket);
        if (link !== null && link === pendingLink) {
          pendingLink = null;
          setState(openLinkedGroup(refreshed, link.refs));
        } else setState(refreshed);
        if (isShowPending) takeInArrivals();
        readStaleRows();
      },
      () => {
        // A row missing from a read that failed would look like a row that left, so nothing is
        // applied; the next push or scroll reads again. A waiting Show takes in what is held.
        if (read.controller.signal.aborted) return;
        refreshing = null;
        if (isShowPending) takeInArrivals();
      },
    );
  }

  function takeInArrivals(): void {
    isShowPending = false;
    if (state === null || state.arrivals.length === 0) return;
    const refs = state.arrivals.map((row) => row.ref);
    setState(takeArrivals(state), { kind: "arrived", refs });
  }

  /**
   * Reads the rows that are missing or old: the rows in the window that missed
   * the latest push, then the members of the open groups that the visit holds no
   * row for (so a group the page cut fills in). Asks about at most `HELD_WINDOW`
   * refs and none that a read in flight covers.
   */
  function readStaleRows(): void {
    if (state === null) return;
    const current = state;
    const covered = (ref: string): boolean =>
      [refreshing, ...rowReads].some((read) => read?.ticket.gen === pushGen && read.refs.has(ref));
    const isBeingRead = (ref: string): boolean => [...rowReads].some((read) => read.refs.has(ref));
    const stale = [
      ...pickWindow(current.rows, viewport.first, viewport.last)
        .map((row) => row.ref)
        .filter((ref) => (current.freshAt.get(ref) ?? -1) < pushGen && !covered(ref)),
      ...listUnloadedMembers(current).filter((ref) => !isBeingRead(ref)),
    ].slice(0, HELD_WINDOW);
    if (stale.length === 0) return;
    const read = startRead(stale);
    rowReads.add(read);
    reader.readRows(current.query, stale, read.controller.signal).then(
      (reply) => {
        rowReads.delete(read);
        const accepted = acceptRead(read);
        if (accepted === null) return;
        setState(applyRowsRead(accepted, { ...reply, asked: stale }, read.ticket));
        readStaleRows();
      },
      () => {
        rowReads.delete(read);
      },
    );
  }

  function readNextPage(): void {
    if (state === null || state.frontier === undefined) return;
    const after = state.frontier;
    if (nextPage?.after === after) return;
    const query = state.query;
    const read = { ...startRead(), after };
    nextPage = read;
    reader.readNext(query, after, read.controller.signal).then(
      (page) => {
        const accepted = acceptRead(read);
        if (accepted === null) return;
        nextPage = null;
        setState(applyNextPage(accepted, { ...page, after }, read.ticket));
        readStaleRows();
      },
      () => {
        // The next time the viewport nears the end reads this page again.
        if (nextPage === read) nextPage = null;
      },
    );
  }

  /** The ids of the moves the controller has confirmed but whose row is still claimed by an unsettled move. */
  const confirmedClaims = new Set<number>();

  /**
   * Settles `receipt` in the claims: a move that failed or was undone
   * (`isConfirmed` false) leaves them, a confirmed one stays only while an
   * earlier, unsettled move on the same row could still fail and must see it.
   * A row whose claims are all confirmed is forgotten, so the claims do not
   * grow with every move.
   */
  function settleClaims(receipt: MoveReceipt<Row>, isConfirmed: boolean): void {
    if (isConfirmed) confirmedClaims.add(receipt.id);
    for (const ref of receipt.refs) {
      const rest = (claims.get(ref) ?? []).filter((id) => isConfirmed || id !== receipt.id);
      if (rest.every((id) => confirmedClaims.has(id))) {
        for (const id of rest) confirmedClaims.delete(id);
        claims.delete(ref);
      } else claims.set(ref, rest);
    }
  }

  /**
   * Returns `receipt` with only the rows no later move has handled since, and
   * takes the receipt out of the claims. A move that fails or is undone late
   * must not reverse what the user did to the same row after it: an answer that
   * failed after its row was dismissed leaves the dismissal alone.
   */
  function narrowToOwnedRows(receipt: MoveReceipt<Row>): MoveReceipt<Row> {
    const owned = receipt.refs.filter(
      (ref) => !(claims.get(ref) ?? []).some((id) => id > receipt.id),
    );
    settleClaims(receipt, false);
    if (owned.length === receipt.refs.length) return receipt;
    const isOwned = new Set(owned);
    return {
      ...receipt,
      refs: owned,
      entries: receipt.entries.filter((e) => isOwned.has(e.row.ref)),
    };
  }

  /**
   * Puts a move back and reads the restored rows afresh when they are in view.
   * A receipt of an earlier visit still applies when the list shown now is the
   * same list (same query): the controller took the move back for that list.
   */
  function putBack(wholeReceipt: MoveReceipt<Row>): void {
    if (state === null) return;
    const receipt = narrowToOwnedRows(wholeReceipt);
    if (receipt.refs.length === 0) return;
    const madeIn = receiptQueries.get(receipt.id);
    const isSameList = madeIn !== undefined && replaceEqualDeep(madeIn, state.query) === madeIn;
    if (receipt.visit !== visitId && !isSameList) return;
    setState(applyUndo(state, receipt, seq), { kind: "restored", refs: receipt.refs });
    readStaleRows();
  }

  /** Counts a change the controller made and reads again, cancelling the read in flight. */
  function pushArrived(): void {
    pushGen += 1;
    if (opening === null) {
      startRefresh();
      return;
    }
    startFirstRead();
    commit();
  }

  return {
    open(query) {
      cancelAll();
      isShowPending = false;
      pendingLink = null;
      opening = { query, read: null, error: undefined };
      startFirstRead();
      commit();
    },
    close() {
      cancelAll();
      opening = null;
    },
    pushArrived,
    linkMade(refs) {
      if (opening === null && state !== null) pendingLink = { refs };
      pushArrived();
    },
    viewportChanged(firstIndex, lastIndex) {
      if (state === null) return;
      const entries = snapshot.entries;
      viewport = findViewedRowRange(state.rows, entries, firstIndex, lastIndex) ?? viewport;
      if (lastIndex >= entries.length - 1 - NEAR_END_ROWS) readNextPage();
      readStaleRows();
    },
    show() {
      if (state === null || state.arrivals.length === 0) return;
      isShowPending = true;
      startRefresh();
    },
    move(kind, refs, show) {
      const id = (receiptId += 1);
      if (state === null)
        return {
          id,
          visit: visitId,
          refs: [],
          entries: [],
          groups: [],
          folds: new Map(),
          currentKey: null,
        };
      const before = state;
      const applied = applyMove(before, { id, visit: visitId, kind, refs, at: now(), show });
      const emptied =
        kind === "dismissed" && applied.state.rows.length === 0 && before.rows.length > 0;
      receiptQueries.set(id, before.query);
      for (const ref of applied.receipt.refs) claims.set(ref, [...(claims.get(ref) ?? []), id]);
      setState(applied.state, {
        kind: emptied ? "emptied-by-move" : kind,
        refs: applied.receipt.refs,
      });
      return applied.receipt;
    },
    confirmMove(receipt) {
      settleClaims(receipt, true);
      if (state === null || receipt.visit !== visitId) return;
      state = confirmHidden(state, receipt, seq);
    },
    failMove: putBack,
    undo: putBack,
    step(by, extend) {
      if (state !== null) setState(moveCurrent(state, { by, ...(extend ? { extend } : {}) }));
    },
    select(change) {
      if (state !== null) setState(applySelectionChange(state, change));
    },
    fold(change) {
      if (state === null) return;
      setState(applyFold(state, change));
      readStaleRows();
    },
    targets(hoveredKey) {
      return state === null ? null : listMoveTargets(state, hoveredKey, now());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}
