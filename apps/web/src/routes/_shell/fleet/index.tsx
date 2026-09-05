import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Button, Group, LaneLabel } from "@hydra/ui";
import { FALLBACK_TIMEZONE, isSupportedTimezone } from "@hydra/client-core";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import {
  controllerQuery,
  localRunnerQuery,
  runnersQuery,
  settingsQuery,
} from "../../../app/queries";
import { NoRunners } from "./-no-runners";
import { RunnerRow } from "./-row";

export const Route = createFileRoute("/_shell/fleet/")({
  staticData: { title: "Fleet" },
  // Answered before it is shown: a fleet that grew a machine under the reader a
  // moment after the screen opened would read as one arriving.
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

  const mint = useMutation({ mutationFn: () => client.runner.createJoinToken() });
  const command =
    mint.data === undefined
      ? undefined
      : `hydra runner join ${window.location.origin} --token ${mint.data.token}`;

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

      <section className="flex max-w-[560px] flex-col items-start gap-1 rounded-card border border-dashed border-line px-4 py-3 text-row text-muted">
        {command === undefined ? (
          <>
            {/* Before a token exists the action is the whole of this spot, so
                it carries the name rather than repeating one above itself. */}
            <Button
              variant="primary"
              className="-ml-2"
              onClick={() => {
                mint.mutate();
              }}
              disabled={mint.isPending}
            >
              Add machine
            </Button>
            <span className="pt-0.5">
              Mint a single-use token, then run the command it gives you on that machine.
            </span>
          </>
        ) : (
          <>
            <b className="font-emph text-ink">Add machine</b>
            <span>Run this on the machine, then log in to its providers here.</span>
            <code className="mt-1 rounded-[4px] bg-line-soft px-1.5 py-px font-mono text-fine break-all text-muted">
              {command}
            </code>
            {/* A fleet is enlisted one machine at a time and each needs a token
                of its own, so there is a way to the next one without a reload. */}
            <Button
              className="-ml-2 mt-1.5"
              onClick={() => {
                mint.mutate();
              }}
              disabled={mint.isPending}
            >
              Mint another
            </Button>
          </>
        )}
        <span className="pt-1 text-fine text-faint">
          {mint.isError
            ? "The token could not be minted. Try again."
            : "A token is single-use and lasts an hour."}
        </span>
      </section>
    </div>
  );
}
