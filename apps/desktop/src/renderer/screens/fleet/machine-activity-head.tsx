import type { JSX } from "react";
import {
  MACHINE_ACTIVITY_FILTERS,
  type MachineActivityFilter,
} from "@hercule/client-core/machine-activity";
import { ViewSwitch } from "../workflows/view-switch";
import "./machine-activity.css";

/** The filters as the segmented control lists them. */
const FILTER_CHOICES = MACHINE_ACTIVITY_FILTERS.map(({ filter, label }) => ({
  view: filter,
  label,
}));

/**
 * Renders the top of the Activity page: the heading "Activity", one line on
 * what the page lists, and the filters as a row of flat buttons. Pressing a
 * filter calls `onPickFilter` with it.
 */
export function MachineActivityHead({
  machineName,
  filter,
  onPickFilter,
}: {
  readonly machineName: string;
  readonly filter: MachineActivityFilter;
  readonly onPickFilter: (filter: MachineActivityFilter) => void;
}): JSX.Element {
  return (
    <header className="machine-activity-head">
      <h2>Activity</h2>
      <p>
        What the controller recorded about {machineName}: its connection, its settings, the sessions
        it started and the workspaces it removed.
      </p>
      <ViewSwitch
        label="Show"
        choices={FILTER_CHOICES}
        view={filter}
        onPick={onPickFilter}
        className="machine-activity-filters"
      />
    </header>
  );
}
