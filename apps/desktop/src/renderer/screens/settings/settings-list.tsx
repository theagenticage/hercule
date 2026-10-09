import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { SettingsSectionPath } from "../../app/last-settings-section";
import type { IconProps } from "../../icons/icon-frame";
import { BoundIcon } from "../../icons/bound";
import { ConnectionsIcon } from "../../icons/connections";
import { CpuIcon } from "../../icons/cpu";
import { CrewIcon } from "../../icons/crew";
import { FleetIcon } from "../../icons/fleet";
import { IdIcon } from "../../icons/id";
import { KeyIcon } from "../../icons/key";
import { PaletteIcon } from "../../icons/palette";
import { PuzzleIcon } from "../../icons/puzzle";
import { ShieldIcon } from "../../icons/shield";
import { SystemIcon } from "../../icons/system";
import { ThreadsIcon } from "../../icons/threads";
import { UserIcon } from "../../icons/user";
import { SELECTED_LINK_PROPS } from "../selected-link-props";

/** One row of the Settings list. */
interface SettingsListRow {
  readonly label: string;
  readonly Icon: (props: IconProps) => JSX.Element;
  /** The section's route, or `null` while the section is not built: the row is drawn but inert. */
  readonly to: SettingsSectionPath | null;
  /** Whether the row carries the dot that shows a Connection needs attention. */
  readonly carriesConnectionDot?: true;
}

/**
 * The Settings list, in the book's groups and order (spec 17 §Settings, The
 * frame). Building a section means giving its row a `to`.
 */
const SETTINGS_GROUPS: ReadonlyArray<{
  readonly heading: string;
  readonly rows: ReadonlyArray<SettingsListRow>;
}> = [
  {
    heading: "You",
    rows: [
      { label: "Profile", Icon: UserIcon, to: "/settings/profile" },
      { label: "Appearance", Icon: PaletteIcon, to: "/settings/appearance" },
      { label: "Threads", Icon: ThreadsIcon, to: null },
    ],
  },
  {
    heading: "Crew",
    rows: [
      { label: "Assistants", Icon: CrewIcon, to: "/settings/assistants" },
      { label: "Connections", Icon: ConnectionsIcon, to: null, carriesConnectionDot: true },
      { label: "Providers", Icon: CpuIcon, to: null },
      { label: "Machines", Icon: FleetIcon, to: null },
    ],
  },
  {
    heading: "Safety",
    rows: [
      { label: "Identities", Icon: IdIcon, to: null },
      { label: "Permission profiles", Icon: ShieldIcon, to: "/settings/permission-profiles" },
      { label: "Secrets", Icon: KeyIcon, to: null },
      { label: "Bounds", Icon: BoundIcon, to: null },
    ],
  },
  {
    heading: "System",
    rows: [
      { label: "Plugins", Icon: PuzzleIcon, to: null },
      { label: "System", Icon: SystemIcon, to: "/settings/system" },
    ],
  },
];

/** The text of the Connections row's dot, as its tooltip and its accessible name. */
const CONNECTION_ATTENTION = "A Connection needs attention";

/**
 * Renders the Settings list beside a section's body: the book's four groups
 * of rows (spec 17 §Settings, The frame).
 *
 * - A built row is a link to its section, selected while the section is open.
 * - A row whose section is not built yet is drawn but inert: it shows its
 *   hover state, does nothing when pressed, and carries `aria-disabled` and
 *   the tooltip "Not built yet". It is drawn so the list keeps the book's
 *   shape and does not change shape when the section is built.
 * - The Connections row carries a red dot while `someConnectionNeedsAttention`
 *   is true, whether its section is built or not.
 */
export function SettingsList({
  someConnectionNeedsAttention,
}: {
  readonly someConnectionNeedsAttention: boolean;
}): JSX.Element {
  return (
    <nav className="set-nav" aria-label="Settings">
      {SETTINGS_GROUPS.map((group) => (
        <section key={group.heading} className="side-sec">
          <h3 className="side-h">
            <span>{group.heading}</span>
          </h3>
          {group.rows.map(({ label, Icon, to, carriesConnectionDot }) => {
            const content = (
              <>
                <Icon />
                <span>{label}</span>
                {carriesConnectionDot === true && someConnectionNeedsAttention && (
                  <i
                    className="dot dot--fail"
                    role="img"
                    aria-label={CONNECTION_ATTENTION}
                    title={CONNECTION_ATTENTION}
                  />
                )}
              </>
            );
            return to === null ? (
              <button
                key={label}
                type="button"
                className="nav-row"
                aria-disabled="true"
                title="Not built yet"
              >
                {content}
              </button>
            ) : (
              <Link key={label} to={to} className="nav-row" activeProps={SELECTED_LINK_PROPS}>
                {content}
              </Link>
            );
          })}
        </section>
      ))}
    </nav>
  );
}
