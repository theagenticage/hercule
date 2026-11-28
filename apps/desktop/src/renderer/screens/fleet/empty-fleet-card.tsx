import type { JSX } from "react";
import { PlusIcon } from "../../icons/plus";
import "./fleet-page.css";

/**
 * Renders the dashed card that ends a fleet with no other machine in it. It
 * is a row of its own under the machines, as wide as the grid or the list,
 * and calls `onAddMachine` (which opens Add a machine) when pressed.
 */
export function EmptyFleetCard({
  onAddMachine,
}: {
  readonly onAddMachine: () => void;
}): JSX.Element {
  return (
    <button type="button" className="fleet-empty" onClick={onAddMachine}>
      <span className="fleet-empty-icon">
        <PlusIcon size={16} />
      </span>
      <span className="fleet-empty-text">
        <b>Add a machine.</b>
        <span>Run one command on another computer and it joins your fleet.</span>
      </span>
    </button>
  );
}
