import type { JSX, ReactNode } from "react";
import { usePopoverMenu, type PopoverMenu } from "../use-popover-menu";
import { MenuHeading, MenuPick, ToolMenu } from "./tool-menu";

/** One row of a `ChoiceMenu`: a choice, or a heading above the choices that follow. */
export type ChoiceMenuEntry<Id extends string> =
  | {
      readonly id: Id;
      readonly name: string;
      /** A mark drawn before the name, such as a source's mark. */
      readonly mark?: ReactNode;
    }
  | { readonly heading: string };

/**
 * Renders a "pick one" menu and the button that opens it: one row per choice
 * of `entries`, with the choice `chosenId` on. Picking a row closes the menu
 * and calls `onPick` with the choice's `id`. A page uses it for how a list is
 * grouped or ordered.
 *
 * `renderTrigger` draws the button, which must carry the `triggerProps` it is
 * given. `label` names the menu for assistive technology, and `edge` says
 * which edge of the button the menu lines up with (see `ToolMenu`).
 */
export function ChoiceMenu<Id extends string>({
  label,
  edge,
  entries,
  chosenId,
  onPick,
  renderTrigger,
}: {
  readonly label: string;
  readonly edge: "start" | "end" | "button-end";
  readonly entries: readonly ChoiceMenuEntry<Id>[];
  readonly chosenId: Id | undefined;
  readonly onPick: (id: Id) => void;
  readonly renderTrigger: (triggerProps: PopoverMenu["triggerProps"]) => JSX.Element;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  return (
    <>
      {renderTrigger(triggerProps)}
      <ToolMenu menuProps={menuProps} label={label} edge={edge}>
        {entries.map((entry) => {
          if ("heading" in entry)
            return <MenuHeading key={entry.heading}>{entry.heading}</MenuHeading>;
          const isOn = entry.id === chosenId;
          return (
            <MenuPick
              key={entry.id}
              itemProps={buildItemProps(`choice:${entry.id}`, { checked: isOn })}
              kind="choice"
              name={entry.name}
              isOn={isOn}
              mark={entry.mark}
              onPick={() => {
                close();
                onPick(entry.id);
              }}
            />
          );
        })}
      </ToolMenu>
    </>
  );
}
