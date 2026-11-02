import { useState, type JSX } from "react";
import type { FleetMachine } from "@hercule/client-core/fleet";
import { EmptyFleetCard } from "../../../../screens/fleet/empty-fleet-card";
import { MachineCard, MachineGrid } from "../../../../screens/fleet/machine-card";
import { MachineList } from "../../../../screens/fleet/machine-list";
import {
  readMachineView,
  rememberMachineView,
  type MachineView,
} from "../../../../screens/fleet/machine-view";
import { ViewSwitch } from "../../../../screens/workflows/view-switch";

/** The two ways to show the machines, in the order the switch lists them. */
const VIEW_CHOICES = [
  { view: "grid", label: "Grid" },
  { view: "list", label: "List" },
] as const;

/**
 * Renders the Machines section of the Fleet page: its heading with the count
 * of machines and the Grid | List switch, then the machines as cards or as
 * rows, then, while the fleet is empty, the card that adds a machine.
 *
 * The switch starts at the view the window last showed and writes each pick
 * back (`machine-view.ts`), so the choice survives leaving the page.
 * `failedAllow` is the text of a failed Allow, drawn under the heading. The
 * other props are what `MachineCard` and `MachineList` take.
 */
export function MachinesSection({
  machines,
  timezone,
  now,
  isEmpty,
  pendingAllowRunnerIds,
  failedAllow,
  onOpen,
  onAllow,
  onAddMachine,
}: {
  readonly machines: readonly FleetMachine[];
  readonly timezone: string;
  readonly now: Date;
  readonly isEmpty: boolean;
  readonly pendingAllowRunnerIds: ReadonlySet<string>;
  readonly failedAllow: string | null;
  readonly onOpen: (runnerId: string) => void;
  readonly onAllow: (runnerId: string, cap: number) => void;
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
      {failedAllow === null ? null : (
        <p className="fleet-err" role="alert">
          {failedAllow}
        </p>
      )}
      {view === "grid" ? (
        <MachineGrid>
          {machines.map((machine) => (
            <MachineCard
              key={machine.runner.id}
              machine={machine}
              timezone={timezone}
              now={now}
              allowPending={pendingAllowRunnerIds.has(machine.runner.id)}
              onOpen={onOpen}
              onAllow={onAllow}
            />
          ))}
          {emptyCard}
        </MachineGrid>
      ) : (
        <>
          <MachineList
            machines={machines}
            timezone={timezone}
            now={now}
            pendingAllowRunnerIds={pendingAllowRunnerIds}
            onOpen={onOpen}
            onAllow={onAllow}
          />
          {emptyCard}
        </>
      )}
    </section>
  );
}
