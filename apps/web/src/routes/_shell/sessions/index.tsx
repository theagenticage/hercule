import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  formatAge,
  buildHeadline,
  buildLanes,
  buildThreadRows,
  type LaneKind,
} from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { Group, LaneLabel, useMinuteClock } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { providersQuery, runnersQuery, sessionsQuery } from "../../../app/queries";
import { CreateThreadLink } from "../../../screens/create-thread-link";
import { ThreadRowView } from "../../../screens/thread-row";
import { StepSessionsFold } from "./-step-sessions-fold";

export const Route = createFileRoute("/_shell/sessions/")({
  staticData: { title: "All sessions" },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(sessionsQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
    ]);
  },
  component: AllSessions,
});

/** The heading of each lane. The lane order comes from `buildLanes`. */
const LANE_LABELS: Readonly<Record<LaneKind, string>> = {
  waiting: "Waiting on you",
  running: "Running",
  idle: "Idle",
  assistants: "Assistants",
  settled: "Settled",
};

/**
 * Renders All sessions: the headline, the lanes of threads and assistant
 * sessions, and at the bottom the fold that holds the step sessions. Those
 * sessions are not threads, so they are left out of the lanes and the
 * headline.
 *
 * A row on a runner that goes offline ends in "offline", so the page follows
 * the runners as well as the sessions.
 */
function AllSessions(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "session");
  useLiveInvalidation(live, queryClient, "runner");
  // The headline and every row's age are computed from this clock, so they
  // update every minute rather than waiting for the next invalidation.
  const now = useMinuteClock();

  const sessions = useSuspenseQuery(sessionsQuery(client)).data.items;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;

  const providerNames = new Map(instances.map((instance) => [instance.id, instance.displayName]));
  const sessionsById = new Map<string, Session>(sessions.map((session) => [session.id, session]));

  // `buildHeadline` returns "No sessions yet" for an empty list, and every lane
  // is empty too. So the empty state is this same header with nothing below
  // it, rather than a second block that repeats the header.
  const lanes = buildLanes(sessions).filter((lane) => lane.sessions.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-row text-muted">{buildHeadline(sessions, now)}</p>
        <CreateThreadLink />
      </div>

      {lanes.map((lane) => (
        <section key={lane.kind}>
          <LaneLabel>{LANE_LABELS[lane.kind]}</LaneLabel>
          <Group>
            {buildThreadRows(lane.sessions, "plain", runners, instances).map((row) => {
              const instanceId = sessionsById.get(row.id)?.instanceId;
              return (
                <ThreadRowView
                  key={row.id}
                  mark={row.mark}
                  title={row.title}
                  end={row.end}
                  age={formatAge(row.activityAt, now)}
                  secondLine={
                    instanceId === undefined ? null : (providerNames.get(instanceId) ?? null)
                  }
                  sessionId={row.id}
                />
              );
            })}
          </Group>
        </section>
      ))}

      <StepSessionsFold now={now} />
    </div>
  );
}
