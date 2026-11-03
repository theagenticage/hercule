import { useState, type JSX, type ReactNode } from "react";
import { useRouteContext } from "@tanstack/react-router";
import type { MachineSummary } from "@hercule/client-core/fleet";
import { EmptyFleetCard } from "../../../../screens/fleet/empty-fleet-card";
import { MachineCard, MachineGrid } from "../../../../screens/fleet/machine-card";
import { MachineList, MachineRow } from "../../../../screens/fleet/machine-list";
import {
  readMachineView,
  rememberMachineView,
  type MachineView,
} from "../../../../screens/fleet/machine-view";
import { ViewSwitch } from "../../../../screens/workflows/view-switch";
import { AllowSessionsButton } from "./-allow-sessions-button";
import { useMachineFaces } from "./-machine-faces";

/** The two ways to show the machines, in the order the switch lists them. */
const VIEW_CHOICES = [
  { view: "grid", label: "Grid" },
  { view: "list", label: "List" },
] as const;

/** Returns the Allow button of `machine`, or `null` when no session of it waits for a slot. */
const buildAllowButton = ({ runnerId, need }: MachineSummary): ReactNode =>
  need?.kind === "waiting" ? <AllowSessionsButton runnerId={runnerId} need={need} /> : null;

/**
 * Renders the machines as cards, each with the faces of the work on its
 * machine. It reads the faces here, and not in the section, so the list view
 * reads no sessions.
 */
function MachineCards({
  machines,
  onOpen,
}: {
  readonly machines: readonly MachineSummary[];
  readonly onOpen: (runnerId: string) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const faces = useMachineFaces(client);
  return (
    <>
      {machines.map((machine) => (
        <MachineCard
          key={machine.runnerId}
          machine={machine}
          faces={faces[machine.runnerId]}
          allow={buildAllowButton(machine)}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/**
 * Renders the Machines section of the Fleet page: its heading with the count
 * of machines and the Grid | List switch, then the machines as cards or as
 * rows, then, while the fleet is empty, the card that adds a machine.
 *
 * The switch starts at the view the window last showed and writes each pick
 * back (`machine-view.ts`), so the choice survives leaving the page.
 */
export function MachinesSection({
  machines,
  isEmpty,
  onOpen,
  onAddMachine,
}: {
  readonly machines: readonly MachineSummary[];
  readonly isEmpty: boolean;
  readonly onOpen: (runnerId: string) => void;
  readonly onAddMachine: () => void;
}): JSX.Element {
  const [view, setView] = useState<MachineView>(readMachineView);
  const pickView = (picked: MachineView): void => {
    rememberMachineView(picked);
    setView(picked);
  };
  const emptyCard = isEmpty ? <EmptyFleetCard onAddMachine={onAddMachine} /> : null;
  return (
    <section id="machines" className="fleet-machines">
      <div className="fleet-sec-h">
        <h2>
          Machines <span className="count">{machines.length}</span>
        </h2>
        <ViewSwitch
          label="Show the machines as"
          choices={VIEW_CHOICES}
          view={view}
          onPick={pickView}
        />
      </div>
      {view === "grid" ? (
        <MachineGrid>
          <MachineCards machines={machines} onOpen={onOpen} />
          {emptyCard}
        </MachineGrid>
      ) : (
        <>
          <MachineList>
            {machines.map((machine) => (
              <MachineRow
                key={machine.runnerId}
                machine={machine}
                allow={buildAllowButton(machine)}
                onOpen={onOpen}
              />
            ))}
          </MachineList>
          {emptyCard}
        </>
      )}
    </section>
  );
}
