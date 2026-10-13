import type { JSX } from "react";
import { MoreIcon } from "../../../icons/more";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import "./connections.css";

/**
 * Renders a Connection row's ⋯ button and the menu it opens, with
 * Reconnect…, Configure… and Delete…. Each item closes the menu and calls
 * its callback. Each ends in an ellipsis because it opens a dialog.
 *
 * Reconnect… sets the Connection up again through its type's setup, so it
 * is disabled, with a tooltip that says why, when `onReconnect` is
 * `undefined` because the binary no longer holds the type. It stays in the
 * menu then, so the menu keeps the same items on every row.
 *
 * `name` is the Connection as its row shows it, such as "GitHub · rogier".
 * It names the button and the menu, so each row's button can be told apart.
 */
export function ConnectionRowMenu({
  name,
  onReconnect,
  onConfigure,
  onDelete,
}: {
  readonly name: string;
  readonly onReconnect: (() => void) | undefined;
  readonly onConfigure: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const label = `More for ${name}`;
  return (
    <>
      <button
        type="button"
        className="icon-btn conn-more"
        {...triggerProps}
        aria-label={label}
        title="More"
      >
        <MoreIcon />
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label={label}
        className="pop popover-menu conn-menu"
      >
        <button
          type="button"
          {...buildItemProps("reconnect", onReconnect === undefined)}
          title={
            onReconnect === undefined
              ? "This Connection's plugin is not installed, so it cannot sign in again."
              : undefined
          }
          onClick={() => {
            // An `aria-disabled` button still takes clicks.
            if (onReconnect === undefined) return;
            close();
            onReconnect();
          }}
        >
          Reconnect…
        </button>
        <button
          type="button"
          {...buildItemProps("configure")}
          onClick={() => {
            close();
            onConfigure();
          }}
        >
          Configure…
        </button>
        <button
          type="button"
          {...buildItemProps("delete")}
          onClick={() => {
            close();
            onDelete();
          }}
        >
          Delete…
        </button>
      </div>
    </>
  );
}
