import type { JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  buildStepSessionRows,
  formatAge,
  resolveDisplayTimezone,
  summarizeStepSessions,
} from "@hercule/client-core";
import { DisclosureButton, Group, useTabFlag } from "@hercule/ui";
import { runnersQuery, sessionsQuery, settingsQuery } from "../../../app/queries";
import { ThreadRowView } from "../../../screens/thread-row";

/**
 * Renders the fold at the bottom of All sessions that holds the step
 * sessions, or nothing when there are none. It starts closed, showing only
 * how many there are, such as "show 6 · 2 running · 1 queued · 6 today", and
 * stays open across page loads in this tab once opened, like the pulse.
 * Open, it lists the step sessions, each with the run that started it.
 *
 * It reads the sessions, the runners and the settings from the query cache,
 * which the route's loader and the entry guard have filled, so it never
 * waits.
 */
export function StepSessionsFold({
  now,
}: {
  /** The clock the summary's "today" and every row's age are computed from. */
  readonly now: Date;
}): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_shell" });
  const [open, toggle] = useTabFlag("hercule.sessions.workflows.open");
  const sessions = useSuspenseQuery(sessionsQuery(client)).data.items;
  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );
  const summary = summarizeStepSessions(sessions, now, timezone);
  if (summary === undefined) return null;

  return (
    <section className="flex max-w-[568px] flex-col gap-1.5">
      {/*
        A digest steps back from the lanes above it, until it is opened. The
        button reaches past the section by its own padding, so its words line
        up with the lane headings. Only its background, shown on hover and
        while the fold is open, reaches past them.
      */}
      <DisclosureButton
        open={open}
        onToggle={toggle}
        className="-mx-2.5 not-aria-expanded:opacity-82"
      >
        <span className="min-w-0 flex-1 truncate">Sessions started by workflows</span>
        <span className="shrink-0 tabular-nums">{`${open ? "hide" : "show"} ${summary}`}</span>
      </DisclosureButton>
      {open ? (
        <Group>
          {buildStepSessionRows(sessions, runners).map((row) => (
            <ThreadRowView
              key={row.id}
              mark={row.mark}
              title={row.title}
              end={row.end}
              age={formatAge(row.activityAt, now)}
              secondLine={row.secondLine}
              sessionId={row.id}
            />
          ))}
        </Group>
      ) : null}
    </section>
  );
}
