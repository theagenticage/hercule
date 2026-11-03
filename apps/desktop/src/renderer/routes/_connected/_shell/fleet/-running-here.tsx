import { useState, type JSX } from "react";
import { useQueries, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildMachineWork, listMachineRunIds } from "@hercule/client-core/machine-work";
import type { Runner } from "@hercule/contract";
import { useRowMembers } from "../../../../app/session-presentation";
import { assistantsQuery, fleetSessionsQuery, runWorkflowNameQuery } from "../../../../app/queries";
import { useWindowVisible } from "../../../../app/window-visibility";
import { RunningHere, type RunningHereView } from "../../../../screens/fleet/running-here";

/**
 * Renders the Running here section of the machine `runner`'s page (spec 17
 * §Fleet, A machine's page): the work on the machine now, as groups or as
 * plain sessions. `timezone` is the zone its "since" times are worded in, and
 * `today` the start of the current day in it (`useFleetToday`), which the
 * machine's page holds for its own times too.
 *
 * - The sessions are read through `select`, which returns plain data. A push
 *   that changes only a session's usage or last activity reads the list
 *   again but leaves the work equal, so nothing here draws again.
 * - While the window is hidden no query here is observed, as on the Fleet
 *   page (`useRunnerSessionCounts`).
 * - A run is named by its workflow's name, which is frozen when the run
 *   starts. Each run on this machine is read once by id
 *   (`runWorkflowNameQuery`) and never again, so a push about runs, or a
 *   run ending, redraws no name. While that read is pending, or after it
 *   fails, the group is named by its session's own title. That is a
 *   best-effort fallback: the title is "<workflow name> · <step id>" cut at
 *   80 characters, so a long name may be cut and the step shows.
 * - The assistants are read as id and name only, so a change to anything
 *   else about an assistant draws nothing here.
 * - Both views start with ten groups or twenty sessions, and "Show all"
 *   opens each view on its own. The caller keys this component by runner,
 *   so another machine starts at the Work view again.
 */
export function MachineRunningHere({
  id,
  runner,
  timezone,
  today,
}: {
  readonly id: string;
  readonly runner: Runner;
  readonly timezone: string;
  readonly today: Date;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const subscribed = useWindowVisible();
  const [view, setView] = useState<RunningHereView>("work");
  const [allShown, setAllShown] = useState<Readonly<Record<RunningHereView, boolean>>>({
    work: false,
    sessions: false,
  });

  const { data: runIds } = useSuspenseQuery({
    ...fleetSessionsQuery(client),
    select: (sessions) => listMachineRunIds(sessions, runner.id),
    subscribed,
  });
  // `subscribed` is set here, not on each query: `useQueries` ignores it there.
  const workflowNames = useQueries({
    queries: runIds.map((runId) => runWorkflowNameQuery(client, runId)),
    combine: (results) =>
      Object.fromEntries(
        results.flatMap(({ data }, index) => (data === undefined ? [] : [[runIds[index]!, data]])),
      ),
    subscribed,
  });
  const { data: assistants } = useSuspenseQuery({
    ...assistantsQuery(client),
    select: (all) => all.map(({ id: assistantId, name }) => ({ id: assistantId, name })),
  });
  const rowMembers = useRowMembers();

  const { data: work } = useSuspenseQuery({
    ...fleetSessionsQuery(client),
    select: (sessions) =>
      buildMachineWork({
        runner,
        sessions,
        rowMembers,
        workflowNames,
        assistants,
        timezone,
        today,
      }),
    subscribed,
  });

  return (
    <RunningHere
      id={id}
      work={work}
      view={view}
      isShowingAll={allShown[view]}
      isCounting={subscribed}
      onPickView={setView}
      onToggleShowAll={() => setAllShown((current) => ({ ...current, [view]: !current[view] }))}
    />
  );
}
