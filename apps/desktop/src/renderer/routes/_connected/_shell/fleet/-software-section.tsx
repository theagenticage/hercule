import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { resolveDisplayTimezone } from "@hercule/client-core";
import { describeFleetSoftware } from "@hercule/client-core/software";
import {
  controllerQuery,
  harnessesQuery,
  runnersQuery,
  settingsQuery,
} from "../../../../app/queries";
import { FleetSoftwarePanel } from "../../../../screens/fleet/fleet-software";
import { useFleetToday } from "../../../../screens/fleet/use-fleet-today";

/**
 * Renders the Software section of the Fleet page (spec 17 §Fleet, Software):
 * the harnesses and toolchains on every machine, against their latest
 * releases. It reads what it draws: the harnesses, the controller's version
 * (the latest a runner can have), the settings' time zone, and the runners.
 * It reads no sessions and no metrics history.
 *
 * - The grid is built in the runners' `select`. Query keeps the identity of a
 *   selected result that is equal to the previous one, so the per-minute
 *   nudge of a machine's metrics redraws nothing here.
 * - It holds which tool's detail is open, one at a time. Pressing the open
 *   tool's name closes it.
 * - `onOpenMachine` is called with the runner id of the machine whose column
 *   head was pressed.
 */
export function SoftwareSection({
  onOpenMachine,
}: {
  readonly onOpenMachine: (runnerId: string) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: harnesses } = useSuspenseQuery(harnessesQuery(client));
  const { data: controller } = useSuspenseQuery(controllerQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const [openKey, setOpenKey] = useState<string | null>(null);

  const timezone = resolveDisplayTimezone(settings.user.timezone);
  // The detail words when each latest release was checked, so the section
  // needs the day whether or not a machine is away.
  const today = useFleetToday(timezone, true);
  const { data: software } = useSuspenseQuery({
    ...runnersQuery(client),
    select: (runners) =>
      describeFleetSoftware(runners, harnesses, controller.version, timezone, today),
  });

  return (
    <FleetSoftwarePanel
      software={software}
      openKey={openKey}
      onToggle={(key) => setOpenKey((current) => (current === key ? null : key))}
      onOpenMachine={onOpenMachine}
    />
  );
}
