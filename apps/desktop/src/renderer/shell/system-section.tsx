import type { JSX } from "react";
import { ConnectionsIcon } from "../icons/connections";
import { FleetIcon } from "../icons/fleet";
import {
  CONNECTIONS_SECTION,
  MACHINES_SECTION,
  SettingsNavRow,
} from "../screens/settings/settings-nav-row";

/**
 * Renders the Hercule face's System section: Fleet, which leads to Settings ›
 * Machines, and Connections, which leads to Settings › Connections and ends
 * in the red dot while `someConnectionNeedsAttention` is true. While their sections
 * are not built, both rows are drawn but inert, as in the Settings list.
 *
 * The book's last row, Settings, is not drawn: the foot's Settings button,
 * just below, is the same way in (spec 17 §The Hercule face).
 */
export function SystemSection({
  someConnectionNeedsAttention,
}: {
  readonly someConnectionNeedsAttention: boolean;
}): JSX.Element {
  return (
    <section className="side-sec">
      <h3 className="side-h">
        <span>System</span>
      </h3>
      <SettingsNavRow label="Fleet" Icon={FleetIcon} to={MACHINES_SECTION} />
      <SettingsNavRow
        label="Connections"
        Icon={ConnectionsIcon}
        to={CONNECTIONS_SECTION}
        someConnectionNeedsAttention={someConnectionNeedsAttention}
      />
    </section>
  );
}
