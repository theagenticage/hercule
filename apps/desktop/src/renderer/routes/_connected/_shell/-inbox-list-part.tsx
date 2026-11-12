import { useState, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { namePlugin, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  decideInboxEmpty,
  describeInboxClause,
  describeInboxRow,
  listCardOffers,
  type InboxSearch,
} from "@hercule/client-core/inbox";
import type { InboxClause, InboxOrder } from "@hercule/contract";
import { inboxCountQuery, inboxQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { InboxList } from "../../../screens/inbox/inbox-list";
import { InboxListHead } from "../../../screens/inbox/inbox-list-head";
import { InboxNarrowMenu, type NarrowFacet } from "../../../screens/inbox/inbox-narrow-menu";
import type { InboxRowActions } from "../../../screens/inbox/inbox-row";
import type { RailEntry } from "../../../screens/inbox/inbox-rail";
import { InboxSelectionBar } from "../../../screens/inbox/inbox-selection-bar";
import {
  InboxEmpty,
  InboxFailingSource,
  InboxReadFailed,
  InboxRowsSkeleton,
  type InboxEmptyState,
} from "../../../screens/inbox/inbox-states";
import type { HeldInboxList } from "./-inbox-held-list";
import { useInboxNow } from "./-inbox-clock";
import {
  EVERYTHING_INBOX_SCOPE,
  EVERYTHING_QUERY_ID,
  buildInboxList,
  formatInboxClock,
  isSearching as isSearchNarrowing,
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
 * `useHeldInboxList` holds. It owns Narrow's open state.
 *
 * Orchestrating: it reads the counts, the plugins and the user where it draws
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
  focusRequest,
  onNarrowPick,
  onOpenScope,
  onSearchEverything,
  onClearSearch,
}: {
  readonly client: HerculeClient;
  readonly held: HeldInboxList;
  readonly scope: RailEntry;
  readonly scopeTitle: string;
  readonly search: InboxSearch;
  readonly rowActions: InboxRowActions;
  readonly focusRequest: number;
  readonly onNarrowPick: (clause: InboxClause) => void;
  readonly onOpenScope: (entry: RailEntry) => void;
  readonly onSearchEverything: () => void;
  readonly onClearSearch: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const counts = useSuspenseQuery(inboxCountQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const [narrowAnchor, setNarrowAnchor] = useState<HTMLElement | null>(null);
  const { list } = held;
  const rows = list?.rows ?? [];
  const now = useInboxNow(rows);
  const isSearching = isSearchNarrowing(search);
  const isEmpty = held.status === "ready" && rows.length === 0 && list?.arrivals.length === 0;
  const isEverything = scope.kind === "saved-query" && scope.id === EVERYTHING_QUERY_ID;

  // What the same search finds in Everything, which an empty search offers to widen to.
  const wider = useQuery({
    ...inboxQuery(client, {
      list: buildInboxList(EVERYTHING_INBOX_SCOPE),
      clauses: [...search.clauses],
      text: search.text,
    }),
    enabled: isEmpty && isSearching && !isEverything,
  });

  const views =
    held.order === undefined
      ? []
      : rows.map((thing) =>
          describeInboxRow(thing, {
            order: held.order!,
            now,
            userName: username,
            offers: listCardOffers(thing, held.offerSets),
          }),
        );

  const empty: InboxEmptyState | null = (() => {
    if (!isEmpty) return null;
    const decision = decideInboxEmpty({
      isSearching,
      savedQueryId: scope.kind === "saved-query" ? scope.id : null,
      counts,
    });
    switch (decision.kind) {
      case "all-clear":
        return { kind: "all-clear" };
      case "nobody-waits":
        return {
          kind: "nobody-waits",
          updatesCount: decision.updatesCount,
          onOpenUpdates: () => {
            onOpenScope({ kind: "saved-query", id: "updates" });
          },
        };
      case "nothing-in-list":
        return { kind: "nothing-in-list", title: scopeTitle };
      case "nothing-matches":
        return {
          kind: "nothing-matches",
          scopeTitle,
          tokens: search.clauses.map((clause) => describeInboxClause(clause, counts.fields)),
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
    browseValue?.connectionId === undefined
      ? undefined
      : counts.sources
          .find((source) => source.source === browseValue.source)
          ?.accounts.find((account) => account.connectionId === browseValue.connectionId)?.label;
  const selectionSize = list?.selection.size ?? 0;
  const arrivalCount = list?.arrivals.length ?? 0;

  return (
    <>
      {counts.failing.map((source) => (
        <InboxFailingSource
          key={source.source}
          sourceName={namePlugin(source.source, plugins)}
          sinceLabel={formatInboxClock(source.since)}
          onOpenConnections={() => {
            void navigate({ to: "/settings/connections" });
          }}
        />
      ))}
      <InboxListHead
        title={isSearching ? "Search" : scopeTitle}
        mark={browseValue?.source}
        plugins={plugins}
        account={browseAccount}
        count={held.status === "ready" ? (held.total ?? rows.length) : null}
        orderWords={held.order === undefined ? "" : ORDER_WORDS[held.order]}
        newCount={arrivalCount}
        empty={held.status !== "ready" || (rows.length === 0 && arrivalCount === 0)}
        narrowOpen={narrowAnchor !== null}
        onShowNew={held.showArrivals}
        onNarrow={(anchor) => {
          setNarrowAnchor((open) => (open === null ? anchor : null));
        }}
      />
      {narrowAnchor === null ? null : (
        <InboxNarrowMenu
          facets={narrowFacets}
          plugins={plugins}
          anchor={narrowAnchor}
          onPick={(clause) => {
            setNarrowAnchor(null);
            onNarrowPick(clause);
          }}
          onClose={() => {
            setNarrowAnchor(null);
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
          <InboxEmpty state={empty} />
        </ListState>
      )}
      {held.status === "ready" && rows.length > 0 && (
        <InboxList
          listId={list!.listId}
          label={isSearching ? "Search results" : scopeTitle}
          rows={views}
          plugins={plugins}
          currentRef={list!.current}
          selection={list!.selection}
          actions={rowActions}
          arriving={held.arrived}
          footReserve={selectionSize > 0 ? SELECTION_BAR_RESERVE : 0}
          focusRequest={focusRequest}
          onNearEnd={held.loadNextPage}
        />
      )}
      <InboxSelectionBar
        count={selectionSize}
        onClear={() => {
          held.change((state) => ({ ...state, selection: new Set(), anchor: null }));
        }}
      />
    </>
  );
}
