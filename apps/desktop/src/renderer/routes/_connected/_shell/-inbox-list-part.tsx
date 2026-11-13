import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
} from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { namePlugin, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  decideInboxEmpty,
  describeInboxClause,
  describeInboxGroupRow,
  describeInboxRow,
  findAccountLabel,
  type InboxEntry,
  type InboxRowView,
  type InboxScope,
} from "@hercule/client-core/inbox";
import { CORE_SAVED_QUERY_IDS, type InboxClause, type InboxOrder } from "@hercule/contract";
import { inboxOutlineQuery, inboxQuery, pluginsQuery, userQuery } from "../../../app/queries";
import {
  InboxList,
  type InboxListActions,
  type InboxListHandle,
} from "../../../screens/inbox/inbox-list";
import type { InboxListEntry } from "../../../screens/inbox/inbox-list-entry";
import { InboxListHead } from "../../../screens/inbox/inbox-list-head";
import { InboxNarrowMenu, type NarrowFacet } from "../../../screens/inbox/inbox-narrow-menu";
import { InboxSelectionBar } from "../../../screens/inbox/inbox-selection-bar";
import {
  InboxEmpty,
  InboxFailingSource,
  InboxReadFailed,
  InboxRowsSkeleton,
  type InboxEmptyState,
} from "../../../screens/inbox/inbox-states";
import type { InboxLeaveHow } from "../../../screens/inbox/use-inbox-list-motion";
import type { InboxListRow, InboxListSnapshot, InboxListVisit } from "./-inbox-visit";
import { useInboxClock, useInboxNow } from "./-inbox-clock";
import {
  EVERYTHING_INBOX_SCOPE,
  EVERYTHING_QUERY_ID,
  buildInboxList,
  buildInboxSelection,
  isSearching,
  type InboxNarrowing,
} from "./-inbox-scope";

/** How the saved queries' orders read in the list head. */
const ORDER_WORDS: Readonly<Record<InboxOrder, string>> = {
  waiting: "Longest waiting first",
  newest: "Newest first",
};

/** How much further the list's foot reaches while the selection bar covers it, in pixels. */
const SELECTION_BAR_RESERVE = 30;

const NO_ROWS: ReadonlyArray<InboxListRow> = [];

/** The view last described for a row, kept while the row, the order, the minute and the user's name stay the same. */
const viewsByRow = new WeakMap<
  InboxListRow,
  { order: InboxOrder; nowTime: number; userName: string; view: InboxRowView }
>();

/**
 * Returns the view of `row`, the same object as last time when nothing it
 * draws changed, so a row that did not change is not drawn again.
 */
function describeStableRow(
  row: InboxListRow,
  order: InboxOrder,
  now: Date,
  userName: string,
): InboxRowView {
  const kept = viewsByRow.get(row);
  if (
    kept !== undefined &&
    kept.order === order &&
    kept.nowTime === now.getTime() &&
    kept.userName === userName
  ) {
    return kept.view;
  }
  const view = describeInboxRow(row, { order, now, userName, offers: row.offers });
  viewsByRow.set(row, { order, nowTime: now.getTime(), userName, view });
  return view;
}

const NO_REFS: ReadonlyArray<string> = [];

const NO_ENTRIES: ReadonlyArray<InboxListEntry> = [];

/** The line last described for an entry, kept while the entry, the order, the minute and the user's name stay the same. */
const linesByEntry = new WeakMap<
  InboxEntry<InboxListRow>,
  { order: InboxOrder; nowTime: number; userName: string; line: InboxListEntry }
>();

/**
 * Returns the line the list draws for `entry`, the same object as last time
 * when nothing it draws changed, so a line that did not change is not drawn
 * again. A "more" line and the members' own views are described the way a lone
 * row is.
 */
function describeStableEntry(
  entry: InboxEntry<InboxListRow>,
  order: InboxOrder,
  now: Date,
  userName: string,
): InboxListEntry {
  const kept = linesByEntry.get(entry);
  if (
    kept !== undefined &&
    kept.order === order &&
    kept.nowTime === now.getTime() &&
    kept.userName === userName
  ) {
    return kept.line;
  }
  const line = describeEntry(entry, order, now, userName);
  linesByEntry.set(entry, { order, nowTime: now.getTime(), userName, line });
  return line;
}

function describeEntry(
  entry: InboxEntry<InboxListRow>,
  order: InboxOrder,
  now: Date,
  userName: string,
): InboxListEntry {
  switch (entry.kind) {
    case "thing":
      return {
        kind: "thing",
        key: entry.key,
        view: describeStableRow(entry.row, order, now, userName),
      };
    case "member":
      return {
        kind: "member",
        key: entry.key,
        view: describeStableRow(entry.row, order, now, userName),
        member: {
          isQuiet: !entry.matches,
          isLast: entry.isLast,
          position: entry.position,
          of: entry.of,
        },
      };
    case "head": {
      const { group } = entry;
      return {
        kind: "head",
        key: entry.key,
        view: describeInboxGroupRow(group, {
          order,
          now,
          userName,
          offers: group.placedBy.offers,
        }),
        isOpen: group.isOpen,
        tick: group.tick,
        unloadedCount: group.unloadedCount,
      };
    }
    case "more":
      return entry;
  }
}

/**
 * Returns how the rows move for the change the visit last made: whether the
 * rows that left slid aside (a dismissal), the rows an undo put back, and the
 * rows "Show" took in. The visit says what happened and this part decides
 * what it looks like.
 */
const readListMotion = (
  change: InboxListSnapshot["lastChange"],
): {
  readonly leaveHow: InboxLeaveHow;
  readonly returning: ReadonlyArray<string>;
  readonly arriving: ReadonlyArray<string>;
} => ({
  leaveHow:
    change?.kind === "dismissed" || change?.kind === "emptied-by-move" ? "dismiss" : "taken",
  returning: change?.kind === "restored" ? change.refs : NO_REFS,
  arriving: change?.kind === "arrived" ? change.refs : NO_REFS,
});

/**
 * Renders a column that holds a state (the skeleton or an empty state) where
 * the rows would be. With `isCentred` the state takes the column's whole
 * height, which the empty and failed states need to centre themselves. It is
 * a class and not a `:has()` rule in the stylesheet, because a `:has()` rule
 * makes the browser check the column again each time a row is added to it.
 */
function ListState({
  children,
  isBusy,
  isCentred,
}: {
  children: JSX.Element;
  isBusy?: boolean;
  isCentred?: boolean;
}): JSX.Element {
  return (
    <div className="ib-list">
      <div className="ib-scroll">
        <div
          className={isCentred === true ? "ib-lines is-centred" : "ib-lines"}
          aria-busy={isBusy === true ? "true" : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the list column: the line for a source that cannot be read, the
 * head, and under it the rows, or the state that stands in for them (the
 * still shapes while the first page is read, the read that failed, an empty
 * list), and the selection bar.
 *
 * The rows are the visit's, never a read's: this part draws the `snapshot`
 * of `useInboxVisit`. Whether Narrow's menu is open is the screen's
 * (`isNarrowOpen`), because a key opens it too; this part draws it under the
 * Narrow button.
 *
 * `ref` receives the list's handle once it draws rows. The motion of the
 * rows follows from what the snapshot says changed (`lastChange`): rows a
 * dismissal took slide aside, rows an undo put back return from aside, rows
 * "Show" took in come down, and the empty state's sunrise rises when the
 * user's own move emptied the list.
 *
 * Orchestrating: it reads the outline, the plugins and the user where it draws
 * them, and the size of the same search in Everything while an empty search
 * offers to widen.
 */
export function InboxListPart({
  client,
  snapshot,
  visit,
  scope,
  scopeTitle,
  search,
  rowActions,
  focusRequest,
  headingFocusRequest,
  isNarrowOpen,
  undoLine,
  ref,
  onNarrowOpenChange,
  onNarrowPick,
  onShowNew,
  onOpenScope,
  onSearchEverything,
  onClearSearch,
}: {
  readonly client: HerculeClient;
  readonly snapshot: InboxListSnapshot;
  readonly visit: InboxListVisit;
  readonly scope: InboxScope;
  readonly scopeTitle: string;
  readonly search: InboxNarrowing;
  readonly rowActions: InboxListActions;
  readonly focusRequest: number;
  /** Rises when a move left nothing current: the focus then goes to the empty state's heading. */
  readonly headingFocusRequest: number;
  readonly isNarrowOpen: boolean;
  /** The undo line, drawn over the foot of the list. */
  readonly undoLine: ReactNode;
  readonly ref: Ref<InboxListHandle>;
  readonly onNarrowOpenChange: (isOpen: boolean) => void;
  readonly onNarrowPick: (clause: InboxClause) => void;
  /** Takes in what arrived, as the `.` key does. */
  readonly onShowNew: () => void;
  readonly onOpenScope: (entry: InboxScope) => void;
  readonly onSearchEverything: () => void;
  readonly onClearSearch: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const outline = useSuspenseQuery(inboxOutlineQuery(client)).data;
  const formatClock = useInboxClock(client);
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const [narrowButton, setNarrowButton] = useState<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const handledHeadingRequest = useRef(headingFocusRequest);
  const isReady = snapshot.status === "ready";
  const rows = isReady ? snapshot.rows : NO_ROWS;
  const reading = useInboxNow(rows);
  // `useInboxNow` returns a new Date on each render; the views depend on the moment it holds.
  const readingTime = reading.getTime();
  const now = useMemo(() => new Date(readingTime), [readingTime]);
  const isNarrowed = isSearching(search);
  const arrivalCount = isReady ? snapshot.arrivals : 0;
  const isEmpty = isReady && rows.length === 0 && arrivalCount === 0;
  const { leaveHow, returning, arriving } = readListMotion(snapshot.lastChange);
  // The sunrise rises only for a list the user's own move emptied.
  const isRising = snapshot.lastChange?.kind === "emptied-by-move" && rows.length === 0;
  const isEverything = scope.kind === "saved-query" && scope.id === EVERYTHING_QUERY_ID;

  // What the same search finds in Everything, which an empty search offers to widen to.
  const wider = useQuery({
    ...inboxQuery(client, {
      list: buildInboxList(EVERYTHING_INBOX_SCOPE),
      clauses: [...search.clauses],
      text: search.text,
    }),
    enabled: isEmpty && isNarrowed && !isEverything,
  });

  // Narrow's button is gone while the head is empty, and its menu goes with it: it must not come
  // back open when the button does.
  const handleNarrowButton = useCallback(
    (button: HTMLButtonElement | null): void => {
      setNarrowButton(button);
      if (button === null) onNarrowOpenChange(false);
    },
    [onNarrowOpenChange],
  );

  // Only a new request moves the focus, not a render.
  useEffect(() => {
    if (headingFocusRequest === handledHeadingRequest.current) return;
    handledHeadingRequest.current = headingFocusRequest;
    headingRef.current?.focus({ preventScroll: true });
  }, [headingFocusRequest]);

  // One array for as long as the rows, the order, the minute and the user stay the same: the list
  // takes a new array to be a change of rows, and a step with J changes none.
  const order = snapshot.order;
  const entries = snapshot.entries;
  const lines = useMemo(
    () =>
      order === undefined
        ? NO_ENTRIES
        : entries.map((entry) => describeStableEntry(entry, order, now, username)),
    [entries, order, now, username],
  );

  const empty: InboxEmptyState | null = (() => {
    if (isReady && rows.length === 0 && arrivalCount > 0) {
      return { kind: "new-waiting", count: arrivalCount, onShowNew };
    }
    if (!isEmpty) return null;
    const decision = decideInboxEmpty({
      isSearching: isNarrowed,
      savedQueryId: scope.kind === "saved-query" ? scope.id : null,
      counts: outline,
    });
    switch (decision.kind) {
      case "all-clear":
        return { kind: "all-clear" };
      case "nobody-waits":
        return {
          kind: "nobody-waits",
          updatesCount: decision.updatesCount,
          onOpenUpdates: () => {
            onOpenScope({ kind: "saved-query", id: CORE_SAVED_QUERY_IDS.updates });
          },
        };
      case "nothing-in-list":
        return { kind: "nothing-in-list", title: scopeTitle };
      case "nothing-matches":
        return {
          kind: "nothing-matches",
          scopeTitle,
          tokens: search.clauses.map((clause) => describeInboxClause(clause, outline.fields)),
          text: search.text.trim(),
          widerCount: isEverything ? 0 : (wider.data?.total ?? 0),
          onSearchEverything,
          onClearSearch,
        };
    }
  })();

  const narrowFacets: NarrowFacet[] = snapshot.facets.map((facet) => ({
    source: facet.source,
    sourceName: namePlugin(facet.source, plugins),
    key: facet.key,
    label: facet.label,
    values: facet.values.map(({ value, label, count }) => ({ value, label, count })),
    ...(facet.connectionId === undefined ? {} : { connectionId: facet.connectionId }),
  }));

  const browseValue = scope.kind === "value" ? scope.value : undefined;
  const browseAccount =
    browseValue === undefined
      ? undefined
      : findAccountLabel(
          outline.sources.find((source) => source.source === browseValue.source)?.accounts ?? [],
          browseValue.connectionId === undefined ? [] : [browseValue.connectionId],
        );
  const selectionSize = isReady ? snapshot.selection.size : 0;
  const isHeadEmpty = !isReady || (rows.length === 0 && arrivalCount === 0);

  return (
    <>
      <InboxListHead
        title={isNarrowed ? "Search" : scopeTitle}
        mark={browseValue?.source}
        plugins={plugins}
        account={browseAccount}
        count={isReady ? (snapshot.total ?? rows.length) : null}
        orderWords={snapshot.order === undefined ? "" : ORDER_WORDS[snapshot.order]}
        newCount={arrivalCount}
        empty={isHeadEmpty}
        narrowOpen={isNarrowOpen && narrowButton !== null}
        narrowRef={handleNarrowButton}
        onShowNew={onShowNew}
        onNarrow={() => {
          onNarrowOpenChange(!isNarrowOpen);
        }}
      />
      {outline.failing.map((source) => (
        <InboxFailingSource
          key={source.source}
          sourceName={namePlugin(source.source, plugins)}
          changedLabel={formatClock(source.updatedAt)}
          onOpenConnections={() => {
            void navigate({ to: "/settings/connections" });
          }}
        />
      ))}
      {isNarrowOpen && narrowButton !== null && (
        <InboxNarrowMenu
          facets={narrowFacets}
          plugins={plugins}
          anchor={narrowButton}
          onPick={(clause) => {
            onNarrowOpenChange(false);
            onNarrowPick(clause);
          }}
          onClose={() => {
            onNarrowOpenChange(false);
          }}
        />
      )}
      {snapshot.status === "loading" && (
        <ListState isBusy>
          <InboxRowsSkeleton />
        </ListState>
      )}
      {snapshot.status === "failed" && (
        <ListState isCentred>
          <InboxReadFailed
            reason={readErrorMessage(snapshot.error)}
            onTryAgain={() => {
              visit.open(buildInboxSelection(scope, search));
            }}
          />
        </ListState>
      )}
      {empty !== null && (
        <ListState isCentred>
          <InboxEmpty state={empty} isRising={isRising} headingRef={headingRef} />
        </ListState>
      )}
      {isReady && rows.length > 0 && (
        <InboxList
          listId={JSON.stringify(snapshot.query)}
          label={isNarrowed ? "Search results" : scopeTitle}
          entries={lines}
          plugins={plugins}
          currentKey={snapshot.current}
          selection={snapshot.selection}
          actions={rowActions}
          leaveHow={leaveHow}
          returning={returning}
          arriving={arriving}
          footReserve={selectionSize > 0 ? SELECTION_BAR_RESERVE : 0}
          focusRequest={focusRequest}
          onViewportChange={visit.viewportChanged}
          handle={ref}
        />
      )}
      <InboxSelectionBar
        count={selectionSize}
        onClear={() => {
          visit.select({ kind: "clear" });
        }}
      />
      {undoLine}
    </>
  );
}
