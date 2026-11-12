import {
  useCallback,
  useEffect,
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
  changeInboxSelection,
  decideInboxEmpty,
  describeInboxClause,
  describeInboxRow,
  findAccountLabel,
  listCardOffers,
  type InboxScope,
} from "@hercule/client-core/inbox";
import {
  CORE_SAVED_QUERY_IDS,
  type InboxClause,
  type InboxOrder,
  type InboxThing,
} from "@hercule/contract";
import { inboxOutlineQuery, inboxQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { InboxList, type InboxListHandle } from "../../../screens/inbox/inbox-list";
import { InboxListHead } from "../../../screens/inbox/inbox-list-head";
import { InboxNarrowMenu, type NarrowFacet } from "../../../screens/inbox/inbox-narrow-menu";
import type { InboxRowActions } from "../../../screens/inbox/inbox-row";
import { InboxSelectionBar } from "../../../screens/inbox/inbox-selection-bar";
import {
  InboxEmpty,
  InboxFailingSource,
  InboxReadFailed,
  InboxRowsSkeleton,
  type InboxEmptyState,
} from "../../../screens/inbox/inbox-states";
import type { InboxLeaveHow } from "../../../screens/inbox/use-inbox-list-motion";
import type { HeldInboxList } from "./-inbox-held-list";
import { useInboxClock, useInboxNow } from "./-inbox-clock";
import {
  EVERYTHING_INBOX_SCOPE,
  EVERYTHING_QUERY_ID,
  buildInboxList,
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

/** Renders a column that holds a state (the skeleton or an empty state) where the rows would be. */
function ListState({ children, isBusy }: { children: JSX.Element; isBusy?: boolean }): JSX.Element {
  return (
    <div className="ib-list">
      <div className="ib-scroll">
        <div className="ib-lines" aria-busy={isBusy === true ? "true" : undefined}>
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
 * The rows are the held list's, never a read's: this part draws what
 * `useHeldInboxList` holds. Whether Narrow's menu is open is the screen's
 * (`isNarrowOpen`), because a key opens it too; this part draws it under the
 * Narrow button.
 *
 * `ref` receives the list's handle once it draws rows. `leaveHow` and
 * `returning` tell how the rows of the last move went, and `isRising` says
 * that the user's own move emptied the list, so the empty state's sunrise rises.
 *
 * Orchestrating: it reads the outline, the plugins and the user where it draws
 * them, and the size of the same search in Everything while an empty search
 * offers to widen.
 */
export function InboxListPart({
  client,
  held,
  scope,
  scopeTitle,
  search,
  rowActions,
  readHandedThing,
  focusRequest,
  headingFocusRequest,
  leaveHow,
  returning,
  isRising,
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
  readonly held: HeldInboxList;
  readonly scope: InboxScope;
  readonly scopeTitle: string;
  readonly search: InboxNarrowing;
  readonly rowActions: InboxRowActions;
  /** Returns a thing as its row reads while a hand-off of it is on its way. */
  readonly readHandedThing: (thing: InboxThing) => InboxThing;
  readonly focusRequest: number;
  /** Rises when a move left nothing current: the focus then goes to the empty state's heading. */
  readonly headingFocusRequest: number;
  readonly leaveHow: InboxLeaveHow;
  readonly returning: ReadonlyArray<string>;
  /** Whether the empty state's sunrise rises, which it does for a list the user's own move emptied. */
  readonly isRising: boolean;
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
  const { list } = held;
  const rows = list?.rows ?? [];
  const now = useInboxNow(rows);
  const isNarrowed = isSearching(search);
  const arrivalCount = list?.arrivals.length ?? 0;
  const isEmpty = held.status === "ready" && rows.length === 0 && arrivalCount === 0;
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

  const views =
    held.order === undefined
      ? []
      : rows.map((thing) =>
          describeInboxRow(readHandedThing(thing), {
            order: held.order!,
            now,
            userName: username,
            offers: listCardOffers(thing, held.offerSets),
          }),
        );

  const empty: InboxEmptyState | null = (() => {
    if (held.status === "ready" && rows.length === 0 && arrivalCount > 0) {
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

  const narrowFacets: NarrowFacet[] = held.facets.map((facet) => ({
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
  const selectionSize = list?.selection.size ?? 0;
  const isHeadEmpty = held.status !== "ready" || (rows.length === 0 && arrivalCount === 0);

  return (
    <>
      <InboxListHead
        title={isNarrowed ? "Search" : scopeTitle}
        mark={browseValue?.source}
        plugins={plugins}
        account={browseAccount}
        count={held.status === "ready" ? (held.total ?? rows.length) : null}
        orderWords={held.order === undefined ? "" : ORDER_WORDS[held.order]}
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
      {held.status === "loading" && (
        <ListState isBusy>
          <InboxRowsSkeleton />
        </ListState>
      )}
      {held.status === "failed" && (
        <ListState>
          <InboxReadFailed reason={readErrorMessage(held.error)} onTryAgain={held.retry} />
        </ListState>
      )}
      {empty !== null && (
        <ListState>
          <InboxEmpty state={empty} isRising={isRising} headingRef={headingRef} />
        </ListState>
      )}
      {held.status === "ready" && rows.length > 0 && (
        <InboxList
          listId={list!.listId}
          label={isNarrowed ? "Search results" : scopeTitle}
          rows={views}
          plugins={plugins}
          currentRef={list!.current}
          selection={list!.selection}
          actions={rowActions}
          leaveHow={leaveHow}
          returning={returning}
          arriving={held.arrived}
          footReserve={selectionSize > 0 ? SELECTION_BAR_RESERVE : 0}
          focusRequest={focusRequest}
          onNearEnd={held.loadNextPage}
          handle={ref}
        />
      )}
      <InboxSelectionBar
        count={selectionSize}
        onClear={() => {
          held.change((state) => changeInboxSelection(state, { kind: "clear" }));
        }}
      />
      {undoLine}
    </>
  );
}
