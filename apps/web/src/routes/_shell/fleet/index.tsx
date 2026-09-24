import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Group, LaneLabel } from "@hercule/ui";
import { FALLBACK_TIMEZONE, isSupportedTimezone } from "@hercule/client-core";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import {
  controllerQuery,
  localRunnerQuery,
  runnersQuery,
  settingsQuery,
} from "../../../app/queries";
import { AddMachine } from "./-add-machine";
import { NoRunners } from "./-no-runners";
import { RunnerRow } from "./-row";

export const Route = createFileRoute("/_shell/fleet/")({
  staticData: { title: "Fleet" },
  // Loaded before the screen renders. Otherwise runners would appear a moment
  // after the screen opens and look like machines that just joined.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      context.queryClient.ensureQueryData(controllerQuery(context.client)),
    ]);
  },
  component: Fleet,
});

function Fleet(): JSX.Element {
  const { client, queryClient, live, detectLocalRunner } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "runner");

  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const controller = useSuspenseQuery(controllerQuery(client)).data;
  const stored = useSuspenseQuery(settingsQuery(client)).data.user.timezone ?? FALLBACK_TIMEZONE;
  const timezone = isSupportedTimezone(stored) ? stored : FALLBACK_TIMEZONE;
  const local = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;

  return (
    <div className="flex flex-col gap-7">
      <section>
        <LaneLabel>Runners</LaneLabel>
        {runners.length === 0 ? (
          <NoRunners />
        ) : (
          <Group>
            {runners.map((runner) => (
              <RunnerRow
                key={runner.id}
                runner={runner}
                controllerVersion={controller.version}
                isLocal={runner.id === local}
                timezone={timezone}
              />
            ))}
          </Group>
        )}
      </section>

      <AddMachine client={client} timezone={timezone} />
    </div>
  );
}
