import type { ComponentProps, JSX } from "react";
import type { ModelSectionRow } from "@hercule/client-core";
import { CheckIcon } from "../../../icons/check";
import { CloseIcon } from "../../../icons/close";
import { GripIcon } from "../../../icons/grip";
import { MoreIcon } from "../../../icons/more";
import { PlusIcon } from "../../../icons/plus";
import { HarnessLogo } from "../../thread/harness-logo";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import "./models.css";

/**
 * Renders one entry of a profile's section: its model's name, "default" when
 * it is the profile's default entry, "in pi" (the harness's name) when it runs
 * in another harness than its section, and a ⋯ menu. The menu holds:
 *
 * - "Make it <profile>'s default";
 * - "Runs in", one radio per harness in `row.runsIn`, when there are any.
 *   A harness that cannot be picked is faint and shows its reason;
 * - "Also offer in <harness>" for each of `row.alsoOfferIn`;
 * - "Take out of the menu".
 *
 * A problem with the model shows under the row.
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
  onMoveToHarness,
  onAlsoOfferIn,
  onTakeOut,
}: {
  readonly row: ModelSectionRow;
  readonly profileName: string;
  readonly rowProps: ComponentProps<"li">;
  readonly onMakeDefault: () => void;
  /** Called with the `harnessId` of the picked "Runs in" choice, other than the current one. */
  readonly onMoveToHarness: (harnessId: string | null) => void;
  /** Called with the `harnessId` of the "Also offer in" choice. */
  readonly onAlsoOfferIn: (harnessId: string | null) => void;
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
        {row.runsIn.length === 0 ? null : (
          <div role="group" aria-label="Runs in">
            <div className="pm-menu-h" aria-hidden="true">
              Runs in
            </div>
            {row.runsIn.map((choice) => {
              const struck = choice.unavailableReason !== null;
              const itemProps = buildItemProps(`runs-in:${choice.resolvedHarnessId}`, {
                checked: choice.isCurrent,
                disabled: struck,
              });
              return (
                <button
                  key={choice.resolvedHarnessId}
                  type="button"
                  {...itemProps}
                  className={[itemProps.className, "pm-choice"].filter(Boolean).join(" ")}
                  onClick={() => {
                    if (struck) return;
                    close();
                    if (!choice.isCurrent) onMoveToHarness(choice.harnessId);
                  }}
                >
                  <span
                    className={choice.isCurrent ? "pm-radio is-on" : "pm-radio"}
                    aria-hidden="true"
                  />
                  <span className="pm-choice-text">
                    <span>
                      {choice.name}
                      {choice.harnessId === null ? (
                        <small className="pm-choice-note"> like the account</small>
                      ) : null}
                    </span>
                    {choice.unavailableReason === null ? null : (
                      <small className="pm-choice-why">{choice.unavailableReason}</small>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {row.alsoOfferIn.map((choice) => (
          <button
            key={choice.resolvedHarnessId}
            type="button"
            {...buildItemProps(`also-offer:${choice.resolvedHarnessId}`)}
            onClick={() => {
              close();
              onAlsoOfferIn(choice.harnessId);
            }}
          >
            <PlusIcon size={13} />
            {`Also offer in ${choice.name}`}
          </button>
        ))}
        <div className="pm-menu-sep" role="separator" />
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
