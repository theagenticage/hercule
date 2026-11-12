/**
 * The Inbox list's state, kept so that it holds still: a row never moves
 * under the user's eyes. The state holds the rows in visit order, the arrivals
 * waiting behind "N new", the current row, the selection and the range anchor.
 * Every function here returns a new state and reads nothing, so the screen can
 * test the rules without a server, a DOM or a timer.
 *
 * Rows are generic over `{ ref }`: the module never looks at what else a row
 * carries, it only keeps the latest copy of each so the screen can draw
 * updated rows in place.
 *
 * Two identities keep stale replies out:
 * - `listId` names the list (a scope or search). A reply that carries another
 *   `listId` belongs to a superseded list and is ignored.
 * - `frontier` is the cursor of the last page fetched. It is kept apart from
 *   the displayed order, and a next page counts only when it continued from it.
 *
 * Known effect of the keyset pages: the server orders by a sort key that can
 * change while the list is open. A row whose key changed may move above the
 * frontier and so be skipped by the later pages, or come again in a later page.
 * A row seen again is already held and is ignored, so nothing repeats. A row
 * skipped shows up when the list is read again from its first page.
 */

export interface InboxListRow {
  readonly ref: string;
}

/** A row the user handled: where it stood, so that undo can put it back. */
interface HandledRow<Row extends InboxListRow> {
  readonly row: Row;
  readonly index: number;
  /**
   * True from a dismissal until a first page arrives without the row, which
   * shows the server has taken it out. Until then a refresh must not bring it
   * back. Always false for a move that leaves the row displayed.
   */
  readonly awaitingServer: boolean;
}

export interface InboxListState<Row extends InboxListRow> {
  /** Names this list; replies carrying another id are ignored. */
  readonly listId: string;
  /** The rows the list shows, in visit order. */
  readonly rows: readonly Row[];
  /** Rows the latest first page ranks but the list does not hold: "N new" is their count. */
  readonly arrivals: readonly Row[];
  /** The cursor of the last page fetched, or undefined when no page follows. */
  readonly frontier: string | undefined;
  /** The ref of the current row, or null when the list is empty. */
  readonly current: string | null;
  /** Refs of the selected rows. Always a subset of `rows`. */
  readonly selection: ReadonlySet<string>;
  /** The row a range selection starts from, or null. */
  readonly anchor: string | null;
  /** The refs of the latest first page in its rank, used to place arrivals on Show. */
  readonly firstPageRefs: readonly string[];
  readonly handled: ReadonlyMap<string, HandledRow<Row>>;
  /**
   * Rows an undo just put back. The next refresh keeps them even when it did
   * not find them, because it may have been read before the undo reached the
   * server. That refresh then clears the set.
   */
  readonly restored: ReadonlySet<string>;
}

/**
 * Starts a list over from its first page: a new scope or search, or the first
 * read. The first row is current. `nextCursor` is the first page's cursor.
 */
export function startInboxList<Row extends InboxListRow>(
  listId: string,
  firstPage: readonly Row[],
  nextCursor?: string,
): InboxListState<Row> {
  return {
    listId,
    rows: firstPage,
    arrivals: [],
    frontier: nextCursor,
    current: firstPage[0]?.ref ?? null,
    selection: new Set(),
    anchor: null,
    firstPageRefs: firstPage.map((row) => row.ref),
    handled: new Map(),
    restored: new Set(),
  };
}

/** The replies of one refresh, handed over together once every read of it has succeeded. */
export interface InboxRefreshReply<Row extends InboxListRow> {
  readonly listId: string;
  readonly firstPage: readonly Row[];
  /** True when the first page has a next page, so a row can slide into it from there. */
  readonly firstPageHasMore: boolean;
  /** The refs the `refs` reads asked for: every held row that was not on the new first page. */
  readonly askedRefs: readonly string[];
  /** The rows those reads returned. An asked ref missing here no longer belongs to the list. */
  readonly refsReads: readonly Row[];
}

/**
 * Applies one refresh. Call it only when every read of the refresh succeeded:
 * a row missing from a failed read would look like a row that left. Then:
 * - a held row found in any reply is replaced by the reply's copy, in place;
 * - a held row that was asked for and found in none has left, and is dropped,
 *   unless an undo put it back since (see `restored`);
 * - a held row that was not asked for (a page appended meanwhile) is kept;
 * - a first-page row that is not held becomes an arrival, unless the first page
 *   has a next page and the row ranks after every held row of the first page.
 *   That row did not appear: it slid into the first page from the next one
 *   because a row above it left (a page holds at most 200 things). It is
 *   appended to the held rows quietly and not counted.
 *
 * Rows the user dismissed are not brought back by a reply that still has them,
 * until a reply shows the server dropped them. A row that then comes back is a
 * new arrival, and its undo memory is forgotten so an undo cannot duplicate it.
 * Returns the same state when the reply belongs to another list.
 */
export function applyInboxRefresh<Row extends InboxListRow>(
  state: InboxListState<Row>,
  reply: InboxRefreshReply<Row>,
): InboxListState<Row> {
  if (reply.listId !== state.listId) return state;
  const latest = new Map<string, Row>();
  for (const row of reply.refsReads) latest.set(row.ref, row);
  for (const row of reply.firstPage) latest.set(row.ref, row);

  const asked = new Set(reply.askedRefs);
  const heldRefs = new Set(state.rows.map((row) => row.ref));
  const kept = state.rows.flatMap(
    (row) => latest.get(row.ref) ?? (asked.has(row.ref) && !state.restored.has(row.ref) ? [] : row),
  );
  const unheld = reply.firstPage.filter(
    (row) => !heldRefs.has(row.ref) && !state.handled.get(row.ref)?.awaitingServer,
  );
  const lastHeldRank = reply.firstPage.findLastIndex((row) => heldRefs.has(row.ref));
  const isPastHeld = (row: Row) =>
    reply.firstPageHasMore && lastHeldRank >= 0 && reply.firstPage.indexOf(row) > lastHeldRank;
  const rows = [...kept, ...unheld.filter(isPastHeld)];
  const arrivals = unheld.filter((row) => !isPastHeld(row));
  const onFirstPage = new Set(reply.firstPage.map((row) => row.ref));
  const handled = new Map<string, HandledRow<Row>>();
  for (const [ref, entry] of state.handled) {
    if (entry.awaitingServer) {
      handled.set(ref, onFirstPage.has(ref) ? entry : { ...entry, awaitingServer: false });
    } else if (heldRefs.has(ref) || !onFirstPage.has(ref)) {
      handled.set(ref, entry);
    }
  }
  return withRows(
    {
      ...state,
      arrivals,
      handled,
      restored: new Set(),
      firstPageRefs: reply.firstPage.map((row) => row.ref),
    },
    rows,
  );
}

/**
 * Appends a next page: the rows the list does not hold yet, except those the
 * user dismissed and the server has not yet dropped (the same rule as a
 * refresh). `after` is the cursor the page was requested with. The page is
 * ignored when it belongs to another list or did not continue from the
 * frontier (another page was fetched meanwhile). The page's `nextCursor`
 * becomes the new frontier.
 */
export function applyInboxNextPage<Row extends InboxListRow>(
  state: InboxListState<Row>,
  page: {
    readonly listId: string;
    readonly after: string;
    readonly rows: readonly Row[];
    readonly nextCursor?: string;
  },
): InboxListState<Row> {
  if (page.listId !== state.listId || page.after !== state.frontier) return state;
  const known = new Set(state.rows.map((row) => row.ref));
  const added = page.rows.filter(
    (row) => !known.has(row.ref) && !state.handled.get(row.ref)?.awaitingServer,
  );
  const addedRefs = new Set(added.map((row) => row.ref));
  const handled = new Map(state.handled);
  for (const ref of addedRefs) handled.delete(ref);
  return withRows(
    {
      ...state,
      handled,
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
export function showInboxArrivals<Row extends InboxListRow>(
  state: InboxListState<Row>,
): InboxListState<Row> {
  if (state.arrivals.length === 0) return state;
  // Each arrival goes right after the nearest row above it in the first
  // page's rank that is held or is itself an arrival (arrivals are in that
  // rank). One pass over the rank finds every anchor.
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
  return { ...withRows({ ...state, arrivals: [] }, rows), current: first?.ref ?? state.current };
}

/**
 * Applies a move on the rows the user handled. The current row moves on at
 * once when it is among them: to the next row after it in the old order that
 * is not handled, else the previous one. The selection drops the handled rows.
 *
 * `leavesList` says whether the handled rows certainly stop belonging to this
 * list:
 * - true (dismiss): the rows are removed at once, remembered for undo, and a
 *   refresh that still has them does not bring them back;
 * - false (take on, hand-off): the rows may still belong, so they stay
 *   displayed. The next refresh updates them in place, or drops them if the
 *   list no longer has them.
 */
export function applyInboxMove<Row extends InboxListRow>(
  state: InboxListState<Row>,
  handledRefs: readonly string[],
  { leavesList }: { readonly leavesList: boolean },
): InboxListState<Row> {
  const isHandled = new Set(handledRefs);
  const handled = new Map(state.handled);
  state.rows.forEach((row, index) => {
    if (isHandled.has(row.ref)) handled.set(row.ref, { row, index, awaitingServer: leavesList });
  });
  if (leavesList) {
    return withRows(
      { ...state, handled },
      state.rows.filter((row) => !isHandled.has(row.ref)),
    );
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
    ...state,
    handled,
    current,
    selection: new Set([...state.selection].filter((ref) => !isHandled.has(ref))),
    anchor: state.anchor !== null && isHandled.has(state.anchor) ? null : state.anchor,
  };
}

/**
 * Takes a move back and makes the topmost of its rows current. Rows that left
 * the list are put back at their old positions; rows that stayed, or came back
 * on their own since, are only made current, never added twice. Refs the list
 * never held are ignored. The restored rows survive the next refresh even if
 * it was read before the undo (see `restored`).
 */
export function undoInboxMove<Row extends InboxListRow>(
  state: InboxListState<Row>,
  restoredRefs: readonly string[],
): InboxListState<Row> {
  const held = new Set(state.rows.map((row) => row.ref));
  const entries = restoredRefs
    .flatMap((ref) => state.handled.get(ref) ?? [])
    .sort((a, b) => a.index - b.index);
  const rows = [...state.rows];
  for (const { row, index } of entries) {
    if (!held.has(row.ref)) rows.splice(Math.min(index, rows.length), 0, row);
  }
  const handled = new Map(state.handled);
  for (const { row } of entries) handled.delete(row.ref);
  const wanted = new Set(restoredRefs);
  const topmost = rows.find((row) => wanted.has(row.ref));
  if (topmost === undefined) return state;
  const restored = new Set(rows.filter((row) => wanted.has(row.ref)).map((row) => row.ref));
  return { ...withRows({ ...state, handled, restored }, rows), current: topmost.ref };
}

/**
 * Moves the current row one step (J, K) or to a given row (a click).
 * A step with `extend` (⇧J, ⇧K) selects the range from the anchor to the new
 * current row, so stepping back shrinks it. Any other move forgets the anchor.
 * A step past either end stays on the end row.
 */
export function moveInboxCurrent<Row extends InboxListRow>(
  state: InboxListState<Row>,
  move: { readonly by: 1 | -1; readonly extend?: boolean } | { readonly to: string },
): InboxListState<Row> {
  const index = state.rows.findIndex((row) => row.ref === state.current);
  const target =
    "to" in move
      ? state.rows.find((row) => row.ref === move.to)
      : state.rows[Math.max(0, Math.min(state.rows.length - 1, index + move.by))];
  if (target === undefined) return state;
  if (!("by" in move && move.extend)) return { ...state, current: target.ref, anchor: null };
  const anchor = state.anchor ?? state.current ?? target.ref;
  return {
    ...state,
    current: target.ref,
    anchor,
    selection: selectRange(state.rows, anchor, target.ref),
  };
}

export type InboxSelectionChange =
  /** X or a ⌘-click: flips one row, which becomes current and the anchor. */
  | { readonly kind: "toggle"; readonly ref: string }
  /** A ⇧-click: selects from the anchor (else the current row) to the row. */
  | { readonly kind: "extendTo"; readonly ref: string }
  /** ⌘A: every displayed row. */
  | { readonly kind: "all" }
  /** Esc: nothing. */
  | { readonly kind: "clear" };

/** Changes the selection. A ref that is not displayed is ignored. */
export function changeInboxSelection<Row extends InboxListRow>(
  state: InboxListState<Row>,
  change: InboxSelectionChange,
): InboxListState<Row> {
  if (change.kind === "all")
    return { ...state, selection: new Set(state.rows.map((row) => row.ref)) };
  if (change.kind === "clear") return { ...state, selection: new Set(), anchor: null };
  if (!state.rows.some((row) => row.ref === change.ref)) return state;
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
export function decideMoveTargets<Row extends InboxListRow>(
  state: InboxListState<Row>,
  hoveredRef?: string,
): string[] {
  const refs = state.rows.map((row) => row.ref);
  const inSelection = (ref: string) => state.selection.has(ref);
  if (hoveredRef !== undefined)
    return inSelection(hoveredRef) ? refs.filter(inSelection) : [hoveredRef];
  if (state.selection.size > 0) return refs.filter(inSelection);
  return state.current === null ? [] : [state.current];
}

function selectRange(rows: readonly InboxListRow[], fromRef: string, toRef: string): Set<string> {
  const from = rows.findIndex((row) => row.ref === fromRef);
  const to = rows.findIndex((row) => row.ref === toRef);
  if (from < 0 || to < 0) return new Set();
  return new Set(rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.ref));
}

/**
 * Sets the rows, then repairs what hangs on them: the selection keeps only
 * displayed rows, the anchor resets when its row is gone, and a current row
 * that is gone gives way to the next row after it in the old order that is
 * still displayed (else the previous one). With no current row, the first
 * row takes it.
 */
function withRows<Row extends InboxListRow>(
  state: InboxListState<Row>,
  rows: readonly Row[],
): InboxListState<Row> {
  const shown = new Set(rows.map((row) => row.ref));
  const oldRefs = state.rows.map((row) => row.ref);
  const selection = new Set([...state.selection].filter((ref) => shown.has(ref)));
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
