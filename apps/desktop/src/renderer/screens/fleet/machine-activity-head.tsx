import type { JSX, ReactNode } from "react";
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
 * what the page lists, and the filters as a segmented control. Pressing a
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
      <ViewSwitch label="Show" choices={FILTER_CHOICES} view={filter} onPick={onPickFilter} />
    </header>
  );
}

/** Returns the line that tells the user why no entry shows for `filter` on the machine `machineName`. */
export const describeEmptyActivity = (
  filter: MachineActivityFilter,
  machineName: string,
): string => {
  switch (filter) {
    case "all":
      return `Nothing has happened on ${machineName} yet.`;
    case "problems":
      return `No problems on ${machineName}.`;
    case "connection":
      return `No connection changes on ${machineName}.`;
    case "sessions":
      return `No session activity on ${machineName}.`;
    case "workspaces":
      return `No workspace activity on ${machineName}.`;
    case "settings":
      return `No settings changes on ${machineName}.`;
  }
};

/**
 * Renders a quiet line under or in place of the entries, such as "Reading
 * older activity…". With `onRetry`, the line is an alert about a failed read,
 * with a Retry button.
 */
export function MachineActivityNote({
  children,
  onRetry,
}: {
  readonly children: ReactNode;
  readonly onRetry: (() => void) | undefined;
}): JSX.Element {
  return onRetry === undefined ? (
    <p className="machine-activity-note">{children}</p>
  ) : (
    <p className="machine-activity-note" role="alert">
      <span>{children}</span>
      <button type="button" className="btn btn--sm btn--quiet" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}
