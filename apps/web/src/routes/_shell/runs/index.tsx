import { useState, type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { RunFilter } from "@hercule/contract";
import { Button, EmptyState, useMinuteClock } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { runsQuery, workflowsQuery } from "../../../app/queries";
import { RunFormDrawer } from "../../../screens/runs/run-form-drawer";
import { RunRow } from "../../../screens/runs/run-row";
import { RunFilterBar } from "./-filters";

export const Route = createFileRoute("/_shell/runs/")({
  staticData: { title: "Runs" },
  // Loads the first page of runs and the workflows for the filter before the
  // screen shows, so it never renders empty and then fills in.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(runsQuery(context.client, {})),
      context.queryClient.ensureQueryData(workflowsQuery(context.client)),
    ]);
  },
  component: Runs,
});

/**
 * The run list, newest first, with filters by workflow and status, paging
 * with Load more, and the run form behind Run workflow. The list follows the
 * `run` topic, so a run started anywhere, and every change of status, shows
 * without a reload.
 */
function Runs(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "run");

  const [filter, setFilter] = useState<RunFilter>({});
  const [isFormOpen, setFormOpen] = useState(false);
  const listing = useInfiniteQuery(runsQuery(client, filter));
  const workflows = useSuspenseQuery(workflowsQuery(client)).data.items;
  // Ages come from a clock that ticks every minute, not from the last
  // refetch, so they stay current.
  const now = useMinuteClock();
  const runs = listing.data?.pages.flatMap((page) => page.items) ?? [];
  const isFiltering = Object.keys(filter).length > 0;

  return (
    <div className="flex max-w-[940px] flex-col gap-4">
      <RunFilterBar
        value={filter}
        workflows={workflows}
        onChange={setFilter}
        onRun={() => {
          setFormOpen(true);
        }}
      />
      {listing.isError ? (
        <EmptyState headline="The runs could not be read." lead={listing.error.message} />
      ) : listing.isPending ? null : runs.length === 0 ? (
        isFiltering ? (
          <EmptyState headline="Nothing matches these filters." />
        ) : (
          <EmptyState
            headline="No runs yet."
            lead="A run is one execution of a workflow. Runs appear here when a trigger fires or you start one by hand."
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} now={now} />
            ))}
          </ul>
          {listing.hasNextPage ? (
            <Button
              className="self-start"
              disabled={listing.isFetchingNextPage}
              onClick={() => void listing.fetchNextPage()}
            >
              Load more
            </Button>
          ) : null}
        </div>
      )}
      {isFormOpen ? (
        <RunFormDrawer
          client={client}
          workflowId={undefined}
          onClose={() => {
            setFormOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
