import type { JSX } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { isNotFound, resolveDisplayTimezone } from "@hercule/client-core";
import { EmptyState } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { runQuery, settingsQuery } from "../../../app/queries";
import { RunPage, type StepsView } from "./-page";

export const Route = createFileRoute("/_shell/runs/$runId")({
  // The page draws its own header with the workflow's name, so the shell
  // hides its top bar.
  staticData: { title: "Run", ownsTopBar: true },
  // The steps view is in the address, so a reload or a shared link keeps it.
  // The list is the default and leaves the address without it.
  validateSearch: (search: Record<string, unknown>): { readonly steps?: StepsView } =>
    search["steps"] === "timeline" ? { steps: "timeline" } : {},
  // Loads the run before the page renders, so the page never waits on it.
  loader: async ({ context: { client, queryClient }, params }) => {
    await queryClient.ensureQueryData(runQuery(client, params.runId)).catch((error: unknown) => {
      // A link to a run the controller does not have shows that, instead of
      // a load error.
      throw isNotFound(error) ? notFound() : error;
    });
  },
  component: RunScreen,
  notFoundComponent: MissingRun,
});

/**
 * Renders a run's page, kept current by the `run` topic: the run engine
 * publishes the run's id on that topic after every change to the run or to
 * one of its step records.
 */
function RunScreen(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const { runId } = Route.useParams();
  const { steps = "list" } = Route.useSearch();
  const navigate = Route.useNavigate();

  useLiveInvalidation(live, queryClient, "run");

  const run = useSuspenseQuery(runQuery(client, runId)).data;
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );

  return (
    <RunPage
      // Keyed by id, so moving to another run mounts a fresh page, without the
      // previous run's open rows or its question.
      key={runId}
      client={client}
      run={run}
      timezone={timezone}
      stepsView={steps}
      onStepsViewChange={(next) =>
        void navigate({ search: next === "list" ? {} : { steps: next }, replace: true })
      }
    />
  );
}

/** Renders the page for a run id that the controller does not have. */
function MissingRun(): JSX.Element {
  return (
    <EmptyState headline="There is no run with this id.">
      <Link
        to="/runs"
        className="self-start text-row text-muted underline underline-offset-2 hover:text-ink"
      >
        Go to Runs
      </Link>
    </EmptyState>
  );
}
