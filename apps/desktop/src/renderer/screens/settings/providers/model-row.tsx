import type { ComponentProps, JSX } from "react";
import type { ModelSectionRow } from "@hercule/client-core";
import { CheckIcon } from "../../../icons/check";
import { CloseIcon } from "../../../icons/close";
import { GripIcon } from "../../../icons/grip";
import { MoreIcon } from "../../../icons/more";
import { HarnessLogo } from "../../thread/harness-logo";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import "./models.css";

/**
 * Renders one entry of a profile's section: its model's name, "default" when
 * it is the profile's default entry, "in pi" (the harness's name) when it runs
 * in another harness than its section, and a ⋯ menu with "Make it <profile>'s
 * default" and "Take out of the menu". A problem with the model shows under
 * the row.
 *
 * `rowProps` is spread on the list item. The caller makes the item draggable,
 * focusable and movable with Alt+Up and Alt+Down, and marks where a dragged
 * item will land beside it, through these props.
 */
export function ModelRow({
  row,
  profileName,
  rowProps,
  onMakeDefault,
  onTakeOut,
}: {
  readonly row: ModelSectionRow;
  readonly profileName: string;
  readonly rowProps: ComponentProps<"li">;
  readonly onMakeDefault: () => void;
  readonly onTakeOut: () => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const label = `More for ${row.name}`;
  const takeOutProps = buildItemProps("take-out");

  return (
    <li {...rowProps}>
      <span className="pm-grip" aria-hidden="true">
        <GripIcon size={12} />
      </span>
      <b>{row.name}</b>
      {row.otherHarnessName === null ? null : (
        <span className="pm-inharness">
          <HarnessLogo harnessId={row.entry.resolvedHarnessId} size={10} />
          in {row.otherHarnessName}
        </span>
      )}
      <span className="pm-spacer" />
      {row.isDefault ? <span className="pm-default">default</span> : null}
      <button type="button" className="pm-more" {...triggerProps} aria-label={label} title="More">
        <MoreIcon size={13} />
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label={label}
        className="pop popover-menu pm-rowmenu"
      >
        {row.isDefault ? null : (
          <button
            type="button"
            {...buildItemProps("make-default")}
            onClick={() => {
              close();
              onMakeDefault();
            }}
          >
            <CheckIcon size={13} />
            {`Make it ${profileName}'s default`}
          </button>
        )}
        <button
          type="button"
          {...takeOutProps}
          className={[takeOutProps.className, "pm-danger"].filter(Boolean).join(" ")}
          onClick={() => {
            close();
            onTakeOut();
          }}
        >
          <CloseIcon size={13} />
          Take out of the menu
        </button>
      </div>
      {row.problem === null ? null : <p className="pm-problem">{row.problem}</p>}
    </li>
  );
}
