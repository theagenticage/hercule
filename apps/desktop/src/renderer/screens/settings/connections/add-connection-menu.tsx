import type { JSX } from "react";
import {
  summarizeConnectionType,
  type ConnectionType,
  type PluginIdentity,
} from "@hercule/client-core";
import { PlusIcon } from "../../../icons/plus";
import { ConnectionTypeMark } from "./connection-type-mark";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import "./connections.css";

/**
 * Renders Settings > Connections' header button, "Add a Connection", and
 * the menu it opens: one item per Connection type in `types`, in the order
 * given, with its plugin's mark, its name, and under it what setting it up
 * takes (`summarizeConnectionType`). Picking a type closes the menu and calls
 * `onPick` with it.
 *
 * With no type, there is nothing to add, so the button cannot open the menu,
 * and its tooltip says why. It is `aria-disabled` rather than `disabled`,
 * because the browser shows no tooltip on a disabled button, and it keeps
 * its pointer events, unlike the shared dimmed button, for the same reason.
 */
export function AddConnectionMenu({
  types,
  plugins,
  onPick,
}: {
  readonly types: ReadonlyArray<ConnectionType>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onPick: (type: ConnectionType) => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  if (types.length === 0) {
    return (
      <button
        type="button"
        className="btn btn--sm add-conn"
        aria-disabled="true"
        title="No installed plugin offers a Connection type."
      >
        <PlusIcon size={14} />
        Add a Connection
      </button>
    );
  }
  return (
    <>
      <button type="button" className="btn btn--sm add-conn" {...triggerProps}>
        <PlusIcon size={14} />
        Add a Connection
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label="Add a Connection"
        className="pop popover-menu conn-menu add-conn-menu"
      >
        {types.map((type) => (
          <button
            key={type.type}
            type="button"
            {...buildItemProps(type.type)}
            onClick={() => {
              close();
              onPick(type);
            }}
          >
            <span className="add-conn-mark">
              <ConnectionTypeMark type={type.type} plugins={plugins} />
            </span>
            <span className="add-conn-text">
              <b>{type.displayName}</b>
              <span>{summarizeConnectionType(type)}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
