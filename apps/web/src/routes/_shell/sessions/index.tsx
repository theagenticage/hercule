import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  formatAge,
  buildHeadline,
  buildLanes,
  buildThreadRows,
  describeStartingStep,
  listWorkflowSessions,
  resolveDisplayTimezone,
  summarizeWorkflowSessions,
  type LaneKind,
} from "@hercule/client-core";
import type { ProviderInstance, Session } from "@hercule/contract";
import { Group, LaneLabel, useMinuteClock, useSessionFlag } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { providersQuery, sessionsQuery, settingsQuery } from "../../../app/queries";
import { CreateThreadLink } from "../../../screens/create-thread-link";
import { ThreadRowView } from "../../../screens/thread-row";

export const Route = createFileRoute("/_shell/sessions/")({
  staticData: { title: "All sessions" },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(sessionsQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
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
 * sessions, and at the bottom the fold that holds the sessions workflow runs
 * started. Those sessions are not threads, so they are left out of the lanes
 * and the headline.
 */
function AllSessions(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "session");
  // The headline and every row's age are computed from this clock, so they
  // update every minute rather than waiting for the next invalidation.
  const now = useMinuteClock();

  const sessions = useSuspenseQuery(sessionsQuery(client)).data.items;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  // The entry guard has read the settings before any screen loads.
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );

  const providerNames = new Map(instances.map((instance) => [instance.id, instance.displayName]));
  const sessionsById = new Map<string, Session>(sessions.map((session) => [session.id, session]));

  // `buildHeadline` returns "No sessions yet" for an empty list, and every lane
  // is empty too. So the empty state is this same header with nothing below
  // it, rather than a second block that repeats the header.
  const lanes = buildLanes(sessions).filter((lane) => lane.sessions.length > 0);
  const workflowSummary = summarizeWorkflowSessions(sessions, now, timezone);

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
            {buildThreadRows(lane.sessions, "plain", instances).map((row) => {
              const instanceId = sessionsById.get(row.id)?.instanceId;
              return (
                <ThreadRowView
                  key={row.id}
                  mark={row.mark}
                  title={row.title}
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

      {workflowSummary === undefined ? null : (
        <WorkflowSessionsFold
          sessions={listWorkflowSessions(sessions)}
          summary={workflowSummary}
          instances={instances}
          now={now}
        />
      )}
    </div>
  );
}

/**
 * Renders the fold at the bottom of All sessions that holds the sessions
 * workflow runs started. It starts closed, showing only how many there are,
 * such as "show 2 · 1 running · 14 today", and stays open across page loads
 * in this tab once opened, like the pulse. Open, it lists the sessions, each
 * with the step and the run that started it.
 */
function WorkflowSessionsFold({
  sessions,
  summary,
  instances,
  now,
}: {
  /** The sessions workflow runs started. */
  readonly sessions: readonly Session[];
  /** The counts the closed fold shows, from `summarizeWorkflowSessions`. */
  readonly summary: string;
  readonly instances: readonly ProviderInstance[];
  readonly now: Date;
}): JSX.Element {
  const [open, toggle] = useSessionFlag("hercule.sessions.workflows.open");
  const sessionsById = new Map<string, Session>(sessions.map((session) => [session.id, session]));

  return (
    <section className="flex max-w-[568px] flex-col gap-1.5">
      {/*
        A digest steps back from the lanes above it, until it is opened. The
        button reaches past the section by its own padding, so its words line
        up with the lane headings and only its hover background sticks out.
      */}
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="-mx-2.5 flex cursor-pointer items-center gap-2 rounded-control px-2.5 py-1 text-left text-fine text-muted not-aria-expanded:opacity-82 hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
      >
        <span className="min-w-0 flex-1 truncate">Sessions started by workflows</span>
        <span className="shrink-0 tabular-nums">{`${open ? "hide" : "show"} ${summary}`}</span>
        <span
          aria-hidden="true"
          className={`text-fine text-faint transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
      </button>
      {open ? (
        <Group>
          {buildThreadRows(sessions, "plain", instances).map((row) => {
            const session = sessionsById.get(row.id);
            return (
              <ThreadRowView
                key={row.id}
                mark={row.mark}
                title={row.title}
                age={formatAge(row.activityAt, now)}
                secondLine={session === undefined ? null : (describeStartingStep(session) ?? null)}
                sessionId={row.id}
              />
            );
          })}
        </Group>
      ) : null}
    </section>
  );
}
