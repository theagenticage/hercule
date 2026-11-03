import { useCallback, useMemo, useRef, useState, type JSX } from "react";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { readErrorMessage, resolveDisplayTimezone } from "@hercule/client-core";
import { decideMachineKind } from "@hercule/client-core/fleet";
import {
  describeEmptyMachineActivity,
  describeMachineActivity,
  type MachineActivityFilter,
} from "@hercule/client-core/machine-activity";
import type { Runner } from "@hercule/contract";
import { throwScreenNotFound } from "../../../../app/last-screen";
import {
  machineActivityQuery,
  providerAccountsQuery,
  readInfiniteOnOpen,
  readOnOpen,
  runnersQuery,
  settingsQuery,
} from "../../../../app/queries";
import { AddMachineDialog } from "../../../../screens/fleet/add-machine-dialog";
import { FleetHeader } from "../../../../screens/fleet/fleet-header";
import { FleetScroll } from "../../../../screens/fleet/fleet-scroll";
import { MachineActivityList } from "../../../../screens/fleet/machine-activity-list";
import {
  describeBoundedActivity,
  MachineActivityHead,
} from "../../../../screens/fleet/machine-activity-head";
import { MachineActivityNote } from "../../../../screens/fleet/machine-activity-note";
import { useFleetToday } from "../../../../screens/fleet/use-fleet-today";
import { useOpenEntries } from "../../../../screens/fleet/use-open-entries";
import { RunnerNotFound } from "./-runner-not-found";

/**
 * One machine's activity (spec 17 §Fleet, Activity): what the controller's
 * audit log recorded about the machine, by day, newest first, with filters.
 *
 * The page is a route of its own, beside the machine's page and not inside
 * it, so its loader reads only what the page draws: the first page of the
 * log (started afresh on each opening, see `readInfiniteOnOpen`), the
 * runners, the Provider Accounts that name an account in a sentence, and the
 * settings, whose time zone the times are shown in. When no runner has the
 * id, or the runner is retired, it shows the same screen as the machine's
 * page.
 */
export const Route = createFileRoute("/_connected/_shell/fleet/$runnerId_/activity")({
  staticData: { title: "Fleet" },
  loader: async ({ context: { controller, queryClient }, params: { runnerId }, location }) => {
    const { client } = controller;
    const [runners] = await Promise.all([
      queryClient.ensureQueryData(runnersQuery(client)),
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      readOnOpen(queryClient, settingsQuery(client)),
      readInfiniteOnOpen(queryClient, machineActivityQuery(client, runnerId)),
    ]);
    if (!runners.some((runner) => runner.id === runnerId && runner.lifecycle !== "retired")) {
      throwScreenNotFound(location);
    }
  },
  component: MachineActivityPage,
  notFoundComponent: RunnerNotFound,
});

/**
 * How many pages the page reads on its own that add no log entry matching
 * the current filter before it stops and offers "Read older". Five pages are
 * 500 log entries. Without the bound, a filter that matches nothing would read
 * the whole log.
 */
const MAX_PAGES_WITHOUT_GAIN = 5;

/**
 * Where the automatic reading under a filter stands: the pages loaded and
 * the log entries that match the filter, when the filter was picked or a
 * matching log entry last appeared. Log entries are counted, not the entries
 * the list shows, because many log entries fold into one shown entry (700
 * sessions spawned in one minute are one entry), and each page of them is a
 * gain.
 */
interface ReadingGain {
  readonly filter: MachineActivityFilter;
  readonly pageCount: number;
  readonly matchCount: number;
}

/** Draws the machine's activity, or `RunnerNotFound` when the machine was retired or removed while the page was open. */
function MachineActivityPage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { runnerId } = Route.useParams();
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const runner = runners.find((each) => each.id === runnerId && each.lifecycle !== "retired");
  return runner === undefined ? <RunnerNotFound /> : <MachineActivityFrame runner={runner} />;
}

/**
 * Draws the Fleet header over the activity of the machine `runner`, and the
 * page in the Fleet scroll area. Add a machine is held here, because the
 * header offers it on every Fleet page.
 *
 * The filters apply to the pages read so far. A page holds entries of every
 * category, so a filter may leave the list short or empty while older pages
 * remain. The list asks for the next page whenever its last line is drawn,
 * which includes a list with no lines, so reading goes on until the filtered
 * entries fill the view or the log ends. The user is never left looking at
 * an empty list that hides further entries.
 *
 * That reading is bounded: after `MAX_PAGES_WITHOUT_GAIN` pages that add no
 * log entry matching the filter, it stops with a line and a "Read older"
 * button, which allows as many pages again.
 */
function MachineActivityFrame({ runner }: { readonly runner: Runner }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client } = controller;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const paged = useInfiniteQuery(machineActivityQuery(client, runner.id));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<MachineActivityFilter>("all");
  const { openKeys, toggle } = useOpenEntries();
  const [isAdding, setAdding] = useState(false);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  // The day headings say "Today" and "Yesterday", so the page watches for midnight.
  const today = useFleetToday(timezone, true);
  const events = useMemo(() => paged.data?.pages.flatMap((page) => page.items) ?? [], [paged.data]);
  const days = describeMachineActivity(events, { filter, timezone, today, accounts });

  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
    paged;
  const pageCount = paged.data?.pages.length ?? 0;
  const matchCount = days.reduce(
    (total, day) => day.entries.reduce((dayTotal, entry) => dayTotal + entry.count, total),
    0,
  );
  const [gain, setGain] = useState<ReadingGain>({ filter, pageCount, matchCount: 0 });
  // A new filter, or a matching log entry that appears, starts the count of pages without gain again.
  if (gain.filter !== filter || matchCount > gain.matchCount) {
    setGain({ filter, pageCount, matchCount });
  }
  const isBoundReached =
    gain.filter === filter &&
    matchCount <= gain.matchCount &&
    hasNextPage &&
    pageCount - gain.pageCount >= MAX_PAGES_WITHOUT_GAIN;
  const readNextPage = useCallback((): void => {
    void fetchNextPage();
  }, [fetchNextPage]);
  // A failed page is not asked for again by scrolling: the list would still be at its end, and
  // that would loop. Retry at the end of the list asks again. Nothing is asked for while any
  // read runs, because asking for a page cancels a refresh of the pages already loaded.
  const canReadMore = hasNextPage && !isFetching && !isFetchNextPageError && !isBoundReached;

  // The line under the entries, or in their place when there are none. It never says how far
  // back the log reaches.
  let foot: JSX.Element | null = null;
  if (paged.isError) {
    const retry = isFetchNextPageError ? () => void fetchNextPage() : () => void paged.refetch();
    const failed =
      paged.data === undefined
        ? "Couldn't read the activity."
        : isFetchNextPageError
          ? "Couldn't read older activity."
          : "Couldn't refresh the activity.";
    foot = (
      <MachineActivityNote onRetry={retry}>
        {`${failed} ${readErrorMessage(paged.error)}`}
      </MachineActivityNote>
    );
  } else if (isBoundReached && !isFetchingNextPage) {
    foot = (
      <MachineActivityNote
        onRetry={undefined}
        onReadOlder={() => setGain({ filter, pageCount, matchCount })}
      >
        {describeBoundedActivity(filter, events.length, days.length > 0)}
      </MachineActivityNote>
    );
  } else if (isFetchingNextPage || (days.length === 0 && hasNextPage)) {
    foot = <MachineActivityNote onRetry={undefined}>Reading older activity…</MachineActivityNote>;
  } else if (days.length === 0 && !paged.isPending) {
    foot = (
      <MachineActivityNote onRetry={undefined}>
        {describeEmptyMachineActivity(filter, runner.name)}
      </MachineActivityNote>
    );
  }

  return (
    <>
      <FleetHeader
        place={{
          page: "activity",
          runnerId: runner.id,
          machine: { name: runner.name, kind: decideMachineKind(runner.facts) },
        }}
        onAddMachine={() => setAdding(true)}
      />
      <FleetScroll scrollRef={scrollRef}>
        <div className="machine-activity-page">
          <MachineActivityList
            days={days}
            openEntryKeys={openKeys}
            onToggleEntry={toggle}
            scrollRef={scrollRef}
            head={
              <MachineActivityHead
                machineName={runner.name}
                filter={filter}
                onPickFilter={setFilter}
              />
            }
            foot={foot}
            onEndReached={canReadMore ? readNextPage : undefined}
          />
        </div>
      </FleetScroll>
      {isAdding && (
        <AddMachineDialog
          client={client}
          origin={controller.url}
          timezone={timezone}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
