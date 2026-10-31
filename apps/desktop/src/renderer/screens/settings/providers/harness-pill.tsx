import { Fragment, type JSX } from "react";
import type { ModelProfileHarnessChoice, SectionHarness } from "@hercule/client-core";
import { ChevronRightIcon } from "../../../icons/chevron-right";
import { HarnessLogo } from "../../thread/harness-logo";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import "./models.css";

/**
 * Returns the small lines under a choice: why it is struck through, else what
 * it is ("Same as the account" is the account's default harness) and its note.
 */
const readChoiceLines = (choice: ModelProfileHarnessChoice): string[] => {
  if (choice.unavailableReason !== null) return [choice.unavailableReason];
  const lines = choice.harnessId === null ? ["The account's default harness."] : [];
  if (choice.note !== null) lines.push(choice.note);
  return lines;
};

/**
 * Renders the pill in the head of an account's section, which says where the
 * account's models run in the profile, and the popover it opens.
 *
 * The pill reads the name of the current choice and wears its harness's logo.
 * It is raised when the profile names a harness (the current choice's
 * `harnessId` is not `null`), and quiet, without its chevron, when no other
 * harness can be picked (`isFixed`). It is a button either way: a fixed pill
 * still opens the popover, which says why nothing else can be picked.
 *
 * The popover has one radio for each of `harness.choices`. A struck choice
 * shows its reason and cannot be picked. Picking another choice than the
 * current one closes the popover and calls `onPick` with the choice's
 * `harnessId` (`null` is "Same as the account"); picking the current one only
 * closes it. "Change it", under the first choice, closes the popover and
 * calls `onChangeAccountHarness`, which opens the account.
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
  // Exactly one choice is current, so the pill always has one to read.
  const current = harness.choices.find((choice) => choice.isCurrent)!;
  const className = [
    "pm-hpill",
    harness.isFixed ? "is-fixed" : "",
    current.harnessId === null ? "" : "is-set",
  ]
    .filter((name) => name !== "")
    .join(" ");

  return (
    <span className="pm-hwrap">
      <button
        type="button"
        className={className}
        {...triggerProps}
        title={`Where ${accountName}'s models run in ${profileName}`}
      >
        <HarnessLogo harnessId={current.resolvedHarnessId} size={11} />
        {current.name}
        {harness.isFixed ? null : <ChevronRightIcon size={10} />}
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        // The head the pill sits in has a tooltip; an empty title stops it showing here.
        title=""
        aria-label={heading}
        className="pop popover-menu pm-hpop"
      >
        <div className="pm-menu-h" aria-hidden="true">
          {heading}
        </div>
        {harness.choices.map((choice) => {
          const item = buildItemProps(choice.harnessId ?? "same-as-account", {
            checked: choice.isCurrent,
            disabled: choice.unavailableReason !== null,
          });
          const lines = readChoiceLines(choice);
          return (
            <Fragment key={choice.harnessId ?? "same-as-account"}>
              <button
                type="button"
                {...item}
                className={[
                  item.className,
                  "pm-hrow",
                  choice.unavailableReason === null ? "" : "is-off",
                ]
                  .filter((name) => name !== undefined && name !== "")
                  .join(" ")}
                onClick={() => {
                  if (choice.unavailableReason !== null) return;
                  close();
                  if (!choice.isCurrent) onPick(choice.harnessId);
                }}
              >
                <span
                  className={choice.isCurrent ? "pm-radio is-on" : "pm-radio"}
                  aria-hidden="true"
                />
                <span className="pm-htext">
                  <span className="pm-hname">
                    {choice.harnessId === null || choice.unavailableReason !== null ? null : (
                      <HarnessLogo harnessId={choice.resolvedHarnessId} size={11} />
                    )}
                    {choice.name}
                  </span>
                  {lines.map((line) => (
                    <small key={line}>{line}</small>
                  ))}
                </span>
              </button>
              {choice.harnessId === null ? (
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
