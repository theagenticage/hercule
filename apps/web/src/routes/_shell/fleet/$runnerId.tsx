import type { JSX } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FormCard } from "@hydra/ui";
import { FALLBACK_TIMEZONE, isSupportedTimezone } from "@hydra/client-core";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { controllerQuery, providersQuery, runnerQuery, settingsQuery } from "../../../app/queries";
import { Connectivity } from "../../../screens/connectivity";
import { EditForm } from "./-edit-form";
import { RunnerFacts } from "./-facts";
import { Moves } from "./-moves";
import { Providers } from "./-providers";

export const Route = createFileRoute("/_shell/fleet/$runnerId")({
  staticData: { title: "Runner" },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(runnerQuery(context.client, params.runnerId)),
      context.queryClient.ensureQueryData(controllerQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
    ]);
  },
  component: RunnerPage,
});

/**
 * One machine: what it reported about itself, the four things its owner owns,
 * and the moves that take it out of service.
 *
 * Where a fleet row says only what is news, a page says every fact, so the
 * lifecycle is written out even when it is the ordinary one. A retired machine
 * has no move left to make, so its moves are gone; its record is still the
 * owner's to name and label.
 */
function RunnerPage(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const { runnerId } = Route.useParams();

  useLiveInvalidation(live, queryClient, "runner");
  useLiveInvalidation(live, queryClient, "provider");

  const runner = useSuspenseQuery(runnerQuery(client, runnerId)).data;
  const controller = useSuspenseQuery(controllerQuery(client)).data;
  const stored = useSuspenseQuery(settingsQuery(client)).data.user.timezone ?? FALLBACK_TIMEZONE;
  const timezone = isSupportedTimezone(stored) ? stored : FALLBACK_TIMEZONE;

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
        <EditForm client={client} runner={runner} />
        {runner.lifecycle === "retired" ? null : (
          <Moves client={client} runner={runner} defaultRunnerId={controller.defaultRunnerId} />
        )}
      </FormCard>

      <Providers client={client} runner={runner} />
    </div>
  );
}
