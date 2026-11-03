import { useEffect, useEffectEvent, useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import { describeMachineGraphs } from "@hercule/client-core/machine-graphs";
import {
  buildMachineFiveMinuteScope,
  buildMachineHourScope,
} from "@hercule/client-core/metrics-history";
import { describeMachinePage } from "@hercule/client-core/machine-page";
import { listMachineRunIds } from "@hercule/client-core/machine-work";
import type { Runner } from "@hercule/contract";
import { throwScreenNotFound } from "../../../../app/last-screen";
import {
  controllerQuery,
  fleetSessionsQuery,
  harnessesQuery,
  machineRecentActivityQuery,
  providerAccountsQuery,
  providersQuery,
  readOnOpen,
  runnersQuery,
  runWorkflowNameQuery,
  settingsQuery,
} from "../../../../app/queries";
import { AddMachineDialog } from "../../../../screens/fleet/add-machine-dialog";
import { FleetHeader } from "../../../../screens/fleet/fleet-header";
import { FleetScroll } from "../../../../screens/fleet/fleet-scroll";
import { MachinePageBanner } from "../../../../screens/fleet/machine-page-banner";
import { MachinePageHead, MachinePageRoomLine } from "../../../../screens/fleet/machine-page-head";
import { MachinePageInstruments } from "../../../../screens/fleet/machine-page-instruments";
import { useFleetToday } from "../../../../screens/fleet/use-fleet-today";
import { useSectionInView } from "../../../../screens/fleet/use-section-in-view";
import { MachineRecent } from "./-machine-recent";
import { MachineRetireDialog } from "./-machine-retire-dialog";
import {
  MACHINE_CAPACITY_ID,
  MACHINE_RECENT_ID,
  MACHINE_SETTINGS_ID,
  MACHINE_SOFTWARE_ID,
  MACHINE_WORK_ID,
} from "./-machine-sections";
import { MachineSettings } from "./-machine-settings";
import { MachineSoftware } from "./-machine-software";
import { RunnerNotFound } from "./-runner-not-found";
import { runnerMetricsQuery, useRunnerMetricsLive } from "./-runner-metrics";
import { MachineRunningHere } from "./-running-here";
import { useRunnerSessionCounts } from "./-session-counts";

/** The ids of the page's sections, in order, which the header's jump links scroll to. */
const SECTION_IDS = [
  MACHINE_CAPACITY_ID,
  MACHINE_WORK_ID,
  MACHINE_SOFTWARE_ID,
  MACHINE_RECENT_ID,
  MACHINE_SETTINGS_ID,
];
const SECTIONS = [
  { id: MACHINE_CAPACITY_ID, label: "Capacity" },
  { id: MACHINE_WORK_ID, label: "Running" },
  { id: MACHINE_SOFTWARE_ID, label: "Software" },
  { id: MACHINE_RECENT_ID, label: "Recent" },
  { id: MACHINE_SETTINGS_ID, label: "Settings" },
];

/**
 * One machine's page (spec 17 §Fleet, A machine's page): its head and room
 * line, or the banner of a machine that is away, then its instruments, the
 * work running on it, its Software, its Recent activity and its Settings. Its
 * loader reads everything the page draws before it renders, as the Fleet
 * page's does (`fleet/index.tsx`), including the machine's five-minute points
 * of the last 24 hours and hour points of the last 14 days, for its graphs.
 * They are read only for a machine that exists, and a cached read is used as
 * it is: a `runnerMetrics` push brings them up to date (see
 * `useRunnerMetricsLive`). The workflow name of each run that has a session
 * on the machine is read once (`runWorkflowNameQuery`). When no runner has
 * the id, or the runner is retired, the route shows `RunnerNotFound`: retired
 * machines are not shown anywhere on Fleet.
 */
export const Route = createFileRoute("/_connected/_shell/fleet/$runnerId")({
  staticData: { title: "Fleet" },
  loader: async ({ context: { controller, queryClient }, params: { runnerId }, location }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureQueryData(runnersQuery(client)).then((runners) => {
        if (!runners.some((runner) => runner.id === runnerId && runner.lifecycle !== "retired")) {
          throwScreenNotFound(location);
        }
        return Promise.all([
          queryClient.ensureQueryData(
            runnerMetricsQuery(client, buildMachineFiveMinuteScope(runnerId)),
          ),
          queryClient.ensureQueryData(runnerMetricsQuery(client, buildMachineHourScope(runnerId))),
        ]);
      }),
      queryClient.ensureQueryData(harnessesQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      queryClient.fetchQuery(fleetSessionsQuery(client)).then((sessions) =>
        // `prefetchQuery` never fails: a failed read of one run's name leaves its group named
        // by its session's title.
        Promise.all(
          listMachineRunIds(sessions, runnerId).map((runId) =>
            queryClient.prefetchQuery(runWorkflowNameQuery(client, runId)),
          ),
        ),
      ),
      readOnOpen(queryClient, controllerQuery(client)),
      readOnOpen(queryClient, settingsQuery(client)),
      // Recent shows a failed read as a line of its own with a Retry, so a read that fails
      // must not fail the whole page.
      readOnOpen(queryClient, machineRecentActivityQuery(client, runnerId)).catch(() => undefined),
    ]);
  },
  component: MachinePage,
  notFoundComponent: RunnerNotFound,
});

/** Draws the machine's page, or `RunnerNotFound` when the machine was retired or removed while its page was open. */
function MachinePage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { runnerId } = Route.useParams();
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const runner = runners.find((each) => each.id === runnerId && each.lifecycle !== "retired");
  return runner === undefined ? <RunnerNotFound /> : <MachineFrame runner={runner} />;
}

/**
 * Draws the Fleet header over the page of the machine `runner`, and the page
 * in the Fleet scroll area. The head, its line and the instruments are drawn
 * here from what the page already holds; the Running here, Software and
 * Settings sections read what they draw themselves.
 *
 * Retire… on the banner and in Settings ask the same question, so the dialog
 * is held here. So is Add a machine, which the header offers on every Fleet
 * page.
 */
function MachineFrame({ runner }: { readonly runner: Runner }): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { client } = controller;
  useRunnerMetricsLive(controller.live, queryClient, runner.id);
  const sessionCounts = useRunnerSessionCounts(client);
  const { data: controllerRecord } = useSuspenseQuery(controllerQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const { data: fiveMinutes } = useSuspenseQuery(
    runnerMetricsQuery(client, buildMachineFiveMinuteScope(runner.id)),
  );
  const { data: hours } = useSuspenseQuery(
    runnerMetricsQuery(client, buildMachineHourScope(runner.id)),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const { activeSectionId, scrollToSection } = useSectionInView(scrollRef, SECTION_IDS);
  // A link from another page opens this one at a section by putting the
  // section's id in the location's hash (the Fleet page's Software column
  // heads do). The page scrolls there once it is drawn.
  const hashedSectionId = useLocation({ select: (location) => location.hash });
  const scrollToHashedSection = useEffectEvent(() => {
    if (SECTION_IDS.includes(hashedSectionId)) scrollToSection(hashedSectionId);
  });
  useEffect(() => {
    scrollToHashedSection();
  }, [hashedSectionId]);
  const [isRetiring, setRetiring] = useState(false);
  const [isAdding, setAdding] = useState(false);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const today = useFleetToday(timezone, true);
  const page = describeMachinePage(
    runner,
    sessionCounts,
    controllerRecord.version,
    timezone,
    today,
  );
  const graphs = describeMachineGraphs(runner, fiveMinutes, hours);

  return (
    <>
      <FleetHeader
        place={{
          page: "machine",
          machine: { name: page.head.name, kind: page.head.kind },
          sections: SECTIONS,
          activeSectionId,
          onJump: scrollToSection,
        }}
        onAddMachine={() => setAdding(true)}
      />
      <FleetScroll scrollRef={scrollRef}>
        <div className="machine-page">
          <MachinePageHead runnerId={runner.id} head={page.head} />
          {page.top.kind === "away" && (
            <MachinePageBanner banner={page.top.banner} onRetire={() => setRetiring(true)} />
          )}
          {/* The section has no visible heading: the room line and the numbers
              need none. Its label names it for the jump link and for screen readers. */}
          <section id={MACHINE_CAPACITY_ID} className="machine-page-capacity" aria-label="Capacity">
            {page.top.kind === "room" && <MachinePageRoomLine line={page.top.line} />}
            <MachinePageInstruments instruments={page.instruments} graphs={graphs} />
          </section>
          <MachineRunningHere
            key={runner.id}
            id={MACHINE_WORK_ID}
            runner={runner}
            timezone={timezone}
            today={today}
          />
          <MachineSoftware id={MACHINE_SOFTWARE_ID} runner={runner} />
          <MachineRecent id={MACHINE_RECENT_ID} runner={runner} />
          <MachineSettings
            id={MACHINE_SETTINGS_ID}
            runner={runner}
            onRetire={() => setRetiring(true)}
          />
        </div>
      </FleetScroll>
      {isRetiring && (
        <MachineRetireDialog
          runner={runner}
          defaultRunnerId={controllerRecord.defaultRunnerId}
          onClose={() => setRetiring(false)}
        />
      )}
      {isAdding && (
        <AddMachineDialog
          client={client}
          origin={controller.url}
          timezone={timezone}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
