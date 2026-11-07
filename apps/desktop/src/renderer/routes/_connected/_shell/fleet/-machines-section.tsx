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
import { ViewSwitch } from "../../../../screens/view-switch";
import { AllowSessionsButton } from "./-allow-sessions-button";
import { CleanUpButton } from "./-clean-up-button";
import { useMachineFaces } from "./-machine-faces";
import { useMachineUpdates } from "./-machine-updates";

/** The two ways to show the machines, in the order the switch lists them. */
const VIEW_CHOICES = [
  { view: "grid", label: "Grid" },
  { view: "list", label: "List" },
] as const;

/** Returns the Allow button of `machine`, or `null` when no session of it waits for a slot. */
const buildAllowButton = ({ runnerId, need }: MachineSummary): ReactNode =>
  need?.kind === "waiting" ? <AllowSessionsButton runnerId={runnerId} need={need} /> : null;

/** Returns the Clean up… button of `machine`. */
const buildCleanUpButton = ({ runnerId, name, isAway }: MachineSummary): ReactNode => (
  <CleanUpButton
    runnerId={runnerId}
    runnerName={name}
    isOnline={!isAway}
    className="btn btn--sm fleet-attn-btn"
  />
);

/**
 * Renders the machines as cards, each with the faces of the work on its
 * machine and its updates line. It reads the faces here, and not in the
 * section, so the list view reads no sessions.
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
  const updates = useMachineUpdates(client);
  return (
    <>
      {machines.map((machine) => (
        <MachineCard
          key={machine.runnerId}
          machine={machine}
          faces={faces[machine.runnerId]}
          updatesText={updates[machine.runnerId]}
          allow={buildAllowButton(machine)}
          cleanUp={buildCleanUpButton(machine)}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/** Renders the machines as rows, each with its updates line. */
function MachineRows({
  machines,
  onOpen,
}: {
  readonly machines: readonly MachineSummary[];
  readonly onOpen: (runnerId: string) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const updates = useMachineUpdates(client);
  return (
    <MachineList>
      {machines.map((machine) => (
        <MachineRow
          key={machine.runnerId}
          machine={machine}
          updatesText={updates[machine.runnerId]}
          allow={buildAllowButton(machine)}
          cleanUp={buildCleanUpButton(machine)}
          onOpen={onOpen}
        />
      ))}
    </MachineList>
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
          <MachineRows machines={machines} onOpen={onOpen} />
          {emptyCard}
        </>
      )}
    </section>
  );
}
