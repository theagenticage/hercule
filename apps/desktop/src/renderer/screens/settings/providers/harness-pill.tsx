import { Fragment, type DragEvent, type JSX } from "react";
import type { HarnessOption, SectionHarness } from "@hercule/client-core";
import { ChevronRightIcon } from "../../../icons/chevron-right";
import { HarnessLogo } from "../../thread/harness-logo";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import "./models.css";

/** Returns the small line under an option: what it is, why it is struck through, or a note. */
const readOptionLine = (option: HarnessOption): string | null => {
  if (option.unavailableReason !== null) return option.unavailableReason;
  if (option.harnessId === null) return "The account's default harness.";
  return option.note;
};

/**
 * Renders the pill in the head of an account's section, which says where the
 * account's models run in the profile, and the popover it opens.
 *
 * The pill reads `harness.label` and wears the harness's logo. It is raised
 * when the profile names a harness (`!followsAccount`), and quiet, without its
 * chevron, when fewer than two harnesses can be picked (`isFixed`). It is a
 * button either way: a fixed pill still opens the popover, which says why
 * nothing else can be picked.
 *
 * The popover has one radio for each of `harness.options`. A struck option
 * shows its reason and cannot be picked. Picking another option than the
 * current one closes the popover and calls `onPick` with the option's
 * `harnessId` (`null` is "Same as the account"); picking the current one only
 * closes it. "Change it", under the first option, closes the popover and
 * calls `onChangeAccountHarness`, which opens the account.
 *
 * The head the pill sits in is a drag handle. A drag that starts on the pill
 * or in its popover is cancelled, so it never moves the section.
 */
export function HarnessPill({
  harness,
  accountName,
  profileName,
  onPick,
  onChangeAccountHarness,
}: {
  readonly harness: SectionHarness;
  readonly accountName: string;
  readonly profileName: string;
  readonly onPick: (harnessId: string | null) => void;
  readonly onChangeAccountHarness: () => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const heading = `${accountName}'s models in ${profileName} run in`;
  const changeProps = buildItemProps("change-account-harness");
  const className = [
    "pm-hpill",
    harness.isFixed ? "is-fixed" : "",
    harness.followsAccount ? "" : "is-set",
  ]
    .filter((name) => name !== "")
    .join(" ");

  return (
    <span
      className="pm-hwrap"
      onDragStart={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        className={className}
        {...triggerProps}
        title={`Where ${accountName}'s models run in ${profileName}`}
      >
        <HarnessLogo harnessId={harness.resolvedHarnessId} size={11} />
        {harness.label}
        {harness.isFixed ? null : <ChevronRightIcon size={10} />}
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label={heading}
        className="pop popover-menu pm-hpop"
      >
        <div className="pm-menu-h" aria-hidden="true">
          {heading}
        </div>
        {harness.options.map((option) => {
          const item = buildItemProps(option.harnessId ?? "same-as-account", {
            checked: option.isCurrent,
            disabled: option.unavailableReason !== null,
          });
          const line = readOptionLine(option);
          return (
            <Fragment key={option.harnessId ?? "same-as-account"}>
              <button
                type="button"
                {...item}
                className={[
                  item.className,
                  "pm-hrow",
                  option.unavailableReason === null ? "" : "is-off",
                ]
                  .filter((name) => name !== undefined && name !== "")
                  .join(" ")}
                onClick={() => {
                  if (option.unavailableReason !== null) return;
                  close();
                  if (!option.isCurrent) onPick(option.harnessId);
                }}
              >
                <span className={option.isCurrent ? "pm-radio is-on" : "pm-radio"} aria-hidden />
                <span className="pm-htext">
                  <span className="pm-hname">
                    {option.harnessId === null || option.unavailableReason !== null ? null : (
                      <HarnessLogo harnessId={option.resolvedHarnessId} size={11} />
                    )}
                    {option.name}
                  </span>
                  {line === null ? null : <small>{line}</small>}
                </span>
              </button>
              {option.harnessId === null ? (
                <button
                  type="button"
                  {...changeProps}
                  className={[changeProps.className, "pm-hchange"]
                    .filter((name) => name !== undefined)
                    .join(" ")}
                  onClick={() => {
                    close();
                    onChangeAccountHarness();
                  }}
                >
                  Change it
                </button>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </span>
  );
}
