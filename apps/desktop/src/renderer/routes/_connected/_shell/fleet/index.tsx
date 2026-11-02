import { useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import {
  buildFleetMachines,
  describeFleet,
  describeMachinesTab,
  isFleetEmpty,
} from "@hercule/client-core/fleet";
import {
  controllerQuery,
  fleetSessionsQuery,
  harnessesQuery,
  providerAccountsQuery,
  providersQuery,
  readOnOpen,
  runnersQuery,
  settingsQuery,
} from "../../../../app/queries";
import { AddMachineDialog } from "../../../../screens/fleet/add-machine-dialog";
import { FleetHeader, type FleetSection } from "../../../../screens/fleet/fleet-header";
import { FleetLead } from "../../../../screens/fleet/fleet-lead";
import { FleetScroll } from "../../../../screens/fleet/fleet-scroll";
import { useFleetNow } from "../../../../screens/fleet/use-fleet-now";
import { useSectionInView } from "../../../../screens/fleet/use-section-in-view";
import { useAllowSessions } from "./-allow-sessions";
import { MachinesSection } from "./-machines-section";

/**
 * Fleet: every machine at a glance (spec 17 §Fleet). Its loader reads
 * everything the page draws before it renders:
 *
 * - the runners, the harnesses, the providers and the Provider Accounts,
 *   which the shell reads and keeps current, so they are cached already;
 * - every session that has not exited, which a push on the `session` topic
 *   keeps current while Fleet is open. `fetchQuery` reads it again on open
 *   only when a push marked the cached read out of date while Fleet was
 *   closed;
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
      queryClient.ensureQueryData(harnessesQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      queryClient.fetchQuery(fleetSessionsQuery(client)),
      readOnOpen(queryClient, controllerQuery(client)),
      readOnOpen(queryClient, settingsQuery(client)),
    ]);
  },
  component: FleetPage,
});

/** The jump links' section ids, in the order the sections are on the page. */
const SECTION_IDS = ["machines"];

/**
 * Draws the Fleet page: the floating header, the lead and the Machines
 * section. Pressing a machine opens its page; the router runs that as a view
 * transition (see `decideMachineTransitionTypes`). Allow saves the machine's
 * session cap.
 */
function FleetPage(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client, url } = controller;
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const { data: sessions } = useSuspenseQuery(fleetSessionsQuery(client));
  const { data: record } = useSuspenseQuery(controllerQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { activeSectionId, scrollToSection } = useSectionInView(scrollRef, SECTION_IDS);
  const { allow, pendingRunnerIds, failure } = useAllowSessions(client);
  const [isAdding, setIsAdding] = useState(false);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const machines = buildFleetMachines(runners, sessions);
  const now = useFleetNow(machines, timezone);
  const sections: ReadonlyArray<FleetSection> = [
    { id: "machines", label: "Machines", count: describeMachinesTab(machines) },
  ];
  const failedMachine =
    failure === null ? undefined : machines.find(({ runner }) => runner.id === failure.runnerId);
  const failedAllow =
    failure === null || failedMachine === undefined
      ? null
      : `Could not allow ${String(failure.cap)} sessions on ${failedMachine.runner.name}: ${failure.message}`;

  return (
    <div className="fleet-page">
      <FleetHeader
        place={{ page: "fleet" }}
        sections={sections}
        activeSectionId={activeSectionId}
        onJump={scrollToSection}
        onAddMachine={() => setIsAdding(true)}
      />
      <FleetScroll scrollRef={scrollRef}>
        <div className="fleet-col">
          <FleetLead lead={describeFleet(machines)} />
          <MachinesSection
            machines={machines}
            timezone={timezone}
            now={now}
            isEmpty={isFleetEmpty(machines, record.localRunnerId)}
            pendingAllowRunnerIds={pendingRunnerIds}
            failedAllow={failedAllow}
            onOpen={(runnerId) => void navigate({ to: "/fleet/$runnerId", params: { runnerId } })}
            onAllow={allow}
            onAddMachine={() => setIsAdding(true)}
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
