import { useCallback, useMemo, useRef, useState, type JSX } from "react";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { readErrorMessage, resolveDisplayTimezone } from "@hercule/client-core";
import { decideMachineKind } from "@hercule/client-core/fleet";
import {
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
  describeEmptyActivity,
  MachineActivityHead,
  MachineActivityNote,
} from "../../../../screens/fleet/machine-activity-head";
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
    const runners = await queryClient.ensureQueryData(runnersQuery(client));
    if (!runners.some((runner) => runner.id === runnerId && runner.lifecycle !== "retired")) {
      throwScreenNotFound(location);
    }
    await Promise.all([
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      readOnOpen(queryClient, settingsQuery(client)),
      readInfiniteOnOpen(queryClient, machineActivityQuery(client, runnerId)),
    ]);
  },
  component: MachineActivityPage,
  notFoundComponent: RunnerNotFound,
});

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

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = paged;
  const readNextPage = useCallback((): void => {
    void fetchNextPage();
  }, [fetchNextPage]);
  // A failed page is not asked for again by scrolling: the list would still be at its end, and
  // that would loop. Retry at the end of the list asks again.
  const canReadMore = hasNextPage && !isFetchingNextPage && !isFetchNextPageError;

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
  } else if (isFetchingNextPage || (days.length === 0 && hasNextPage)) {
    foot = <MachineActivityNote onRetry={undefined}>Reading older activity…</MachineActivityNote>;
  } else if (days.length === 0 && !paged.isPending) {
    foot = (
      <MachineActivityNote onRetry={undefined}>
        {describeEmptyActivity(filter, runner.name)}
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
        sections={[]}
        activeSectionId={null}
        onJump={() => undefined}
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
