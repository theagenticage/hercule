import type { JSX } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FormCard, useMinuteClock } from "@hercule/ui";
import {
  formatAge,
  describeCapacity,
  resolveDisplayTimezone,
  listQueuedSessions,
} from "@hercule/client-core";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import {
  controllerQuery,
  providersQuery,
  runnerQuery,
  runnerSessionsQuery,
  settingsQuery,
} from "../../../app/queries";
import { Connectivity } from "../../../screens/connectivity";
import { EditForm } from "./-edit-form";
import { RunnerFacts } from "./-facts";
import { Moves } from "./-moves";
import { Providers } from "./-providers";
import { SessionQueue } from "./-queue";

export const Route = createFileRoute("/_shell/fleet/$runnerId")({
  staticData: { title: "Runner" },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(runnerQuery(context.client, params.runnerId)),
      context.queryClient.ensureQueryData(controllerQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      context.queryClient.ensureQueryData(runnerSessionsQuery(context.client, params.runnerId)),
    ]);
  },
  component: RunnerPage,
});

/**
 * The page for one runner: what the machine reported about itself, the fields
 * its owner can edit, and the actions that take it out of service.
 *
 * A fleet row shows only what is unusual, but this page shows every fact, so
 * the lifecycle is shown even when it is the ordinary one. A retired runner
 * has no actions left, so they are hidden; the owner can still edit its name
 * and labels.
 */
function RunnerPage(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const { runnerId } = Route.useParams();

  useLiveInvalidation(live, queryClient, "runner");
  useLiveInvalidation(live, queryClient, "provider");
  useLiveInvalidation(live, queryClient, "session");

  const runner = useSuspenseQuery(runnerQuery(client, runnerId)).data;
  const controller = useSuspenseQuery(controllerQuery(client)).data;
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );
  const sessions = useSuspenseQuery(runnerSessionsQuery(client, runnerId)).data.items;
  // Ages are computed from a ticking clock, not from the last refetch, so a
  // waiting time counts up on its own, as it does in a thread row.
  const now = useMinuteClock();

  return (
    <div className="flex flex-col gap-4">
      <Link to="/fleet" className="text-fine text-muted hover:text-ink">
        ← Fleet
      </Link>

      <FormCard
        label={
          <div className="flex items-baseline gap-2.5 text-row">
            <b className="min-w-0 truncate font-emph text-ink">{runner.name}</b>
            <span className="text-fine text-muted">{runner.lifecycle}</span>
            <span className="ml-auto">
              <Connectivity runner={runner} timezone={timezone} />
            </span>
          </div>
        }
      >
        <RunnerFacts runner={runner} />
        <SessionQueue
          line={describeCapacity(runner, sessions)}
          queue={listQueuedSessions(sessions).map((session) => ({
            id: session.id,
            title: session.title,
            age: formatAge(session.createdAt, now),
          }))}
        />
        <EditForm client={client} runner={runner} />
        {runner.lifecycle === "retired" ? null : (
          <Moves client={client} runner={runner} defaultRunnerId={controller.defaultRunnerId} />
        )}
      </FormCard>

      <Providers client={client} runner={runner} />
    </div>
  );
}
