import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { SettingsSectionPath } from "../../app/last-settings-section";
import type { IconProps } from "../../icons/icon-frame";
import { SELECTED_LINK_PROPS } from "../selected-link-props";

/** The text of the Connections row's dot, as its tooltip and its accessible name. */
const CONNECTION_ATTENTION = "A Connection needs attention";

/**
 * The Machines section's route, or `null` while the section is not built.
 * Both Settings' Machines row and the Hercule face's Fleet row lead here, so
 * building the section turns both into links.
 */
export const MACHINES_SECTION: SettingsSectionPath | null = null;

/**
 * The Connections section's route, or `null` while the section is not built.
 * Both Settings' Connections row and the Hercule face's Connections row lead
 * here.
 */
export const CONNECTIONS_SECTION: SettingsSectionPath | null = null;

/**
 * Renders a row that leads to a Settings section, as the Settings list and
 * the Hercule face draw it.
 *
 * - With a `to`, the row is a link to the section, selected while the
 *   section is open.
 * - With `to` set to `null`, the section is not built yet, and the row is
 *   drawn but inert: it shows its hover state, does nothing when pressed, and
 *   carries `aria-disabled` and the tooltip "Not built yet". It is drawn so
 *   the list keeps the book's shape and does not change shape when the
 *   section is built.
 * - While `someConnectionNeedsAttention` is true, the row ends in the red dot
 *   that shows a Connection needs attention.
 */
export function SettingsNavRow({
  label,
  Icon,
  to,
  someConnectionNeedsAttention = false,
}: {
  readonly label: string;
  readonly Icon: (props: IconProps) => JSX.Element;
  readonly to: SettingsSectionPath | null;
  readonly someConnectionNeedsAttention?: boolean;
}): JSX.Element {
  const content = (
    <>
      <Icon />
      <span>{label}</span>
      {someConnectionNeedsAttention && (
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
    <button type="button" className="nav-row" aria-disabled="true" title="Not built yet">
      {content}
    </button>
  ) : (
    <Link to={to} className="nav-row" activeProps={SELECTED_LINK_PROPS}>
      {content}
    </Link>
  );
}
