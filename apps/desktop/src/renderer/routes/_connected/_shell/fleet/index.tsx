import { useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import { describeFleetPage } from "@hercule/client-core/fleet";
import { FLEET_HOUR_METRICS_SCOPE } from "@hercule/client-core/metrics-history";
import {
  controllerQuery,
  fleetSessionsQuery,
  harnessesQuery,
  readOnOpen,
  runnersQuery,
  settingsQuery,
} from "../../../../app/queries";
import { AddMachineDialog } from "../../../../screens/fleet/add-machine-dialog";
import { FleetHeader } from "../../../../screens/fleet/fleet-header";
import { FleetPageLead } from "../../../../screens/fleet/fleet-lead";
import { FleetScroll } from "../../../../screens/fleet/fleet-scroll";
import { useFleetToday } from "../../../../screens/fleet/use-fleet-today";
import { useSectionInView } from "../../../../screens/fleet/use-section-in-view";
import { MACHINE_SOFTWARE_ID } from "./-machine-sections";
import { MachinesSection } from "./-machines-section";
import { runnerMetricsQuery, useRunnerMetricsLive } from "./-runner-metrics";
import { useRunnerSessionCounts } from "./-session-counts";
import { SoftwareSection } from "./-software-section";

/**
 * Fleet: every machine at a glance (spec 17 §Fleet). Its loader reads
 * everything the page draws before it renders:
 *
 * - the runners, which the shell reads and keeps current, so they are cached
 *   already;
 * - every session that has not exited, which a push on the `session` topic
 *   keeps current while Fleet is open. `fetchQuery` reads it again on open
 *   only when a push marked the cached read out of date while Fleet was
 *   closed;
 * - every runner's hour points of the last 7 days, for the disk forecasts.
 *   A `runnerMetrics` push reads them again at most once an hour (see
 *   `useRunnerMetricsLive`), so a cached read is used as it is;
 * - the harnesses with their latest releases, which the Software section
 *   draws. The shell reads and keeps them current: a push on `runner` or
 *   `provider` reads them again (the controller announces a new latest
 *   release on `provider`);
 * - the controller's record, whose `localRunnerId` the page needs when the
 *   fleet is empty, and the settings, whose time zone the times are shown in.
 *   No topic covers either, so they are read each time the page opens.
 */
export const Route = createFileRoute("/_connected/_shell/fleet/")({
  staticData: { title: "Fleet" },
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureQueryData(runnersQuery(client)),
      queryClient.fetchQuery(fleetSessionsQuery(client)),
      queryClient.ensureQueryData(runnerMetricsQuery(client, FLEET_HOUR_METRICS_SCOPE)),
      queryClient.ensureQueryData(harnessesQuery(client)),
      readOnOpen(queryClient, controllerQuery(client)),
      readOnOpen(queryClient, settingsQuery(client)),
    ]);
  },
  component: FleetPage,
});

/** The jump links' section ids, in the order the sections are on the page. */
const SECTION_IDS = ["machines", "software"];

/**
 * Draws the Fleet page: the floating header, the lead, the Machines section
 * and the Software section. Pressing a machine opens its page; the router
 * runs that as a view transition (see `decideMachineTransitionTypes`).
 * Pressing a machine's column head in Software opens its page at its
 * Software section: the location's hash names the section, and the page
 * scrolls to it once it is drawn.
 */
function FleetPage(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { client, url } = controller;
  useRunnerMetricsLive(controller.live, queryClient, null);
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const { data: hours } = useSuspenseQuery(runnerMetricsQuery(client, FLEET_HOUR_METRICS_SCOPE));
  const sessionCounts = useRunnerSessionCounts(client);
  const { data: record } = useSuspenseQuery(controllerQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { activeSectionId, scrollToSection } = useSectionInView(scrollRef, SECTION_IDS);
  const [isAdding, setIsAdding] = useState(false);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  // A time shows for a machine that is away. A retired machine is offline for
  // good and is not shown, so it does not count: it would keep the midnight
  // watch running with no time to redraw.
  const today = useFleetToday(
    timezone,
    runners.some((runner) => runner.lifecycle !== "retired" && runner.connectivity !== "online"),
  );
  // The page is built in the runners' `select`, not in the render. Query keeps
  // the identity of every part of a selected result that is equal to the
  // previous one, so a nudge for one machine gives the other machines' cards
  // the same summary objects they had, and only the card that changed draws.
  const { data: page } = useSuspenseQuery({
    ...runnersQuery(client),
    select: (each) =>
      describeFleetPage(each, sessionCounts, hours, record.localRunnerId, timezone, today),
  });

  return (
    <div className="fleet-page">
      <FleetHeader
        place={{
          page: "fleet",
          sections: [
            { id: "machines", label: "Machines", count: page.machinesSection },
            { id: "software", label: "Software" },
          ],
          activeSectionId,
          onJump: scrollToSection,
        }}
        onAddMachine={() => setIsAdding(true)}
      />
      <FleetScroll scrollRef={scrollRef}>
        <div className="fleet-col">
          <FleetPageLead lead={page.lead} />
          <MachinesSection
            machines={page.machines}
            isEmpty={page.isEmpty}
            onOpen={(runnerId) => void navigate({ to: "/fleet/$runnerId", params: { runnerId } })}
            onAddMachine={() => setIsAdding(true)}
          />
          <SoftwareSection
            onOpenMachine={(runnerId) =>
              void navigate({
                to: "/fleet/$runnerId",
                params: { runnerId },
                hash: MACHINE_SOFTWARE_ID,
              })
            }
          />
        </div>
      </FleetScroll>
      {isAdding ? (
        <AddMachineDialog
          client={client}
          origin={url}
          timezone={timezone}
          onClose={() => setIsAdding(false)}
        />
      ) : null}
    </div>
  );
}
