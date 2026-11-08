import type { JSX, KeyboardEvent } from "react";
import {
  NEW_INITIATIVE_CHOICE_ID,
  NO_INITIATIVE_CHOICE_ID,
  type WorkInitiative,
} from "@hercule/client-core/work";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { FlagIcon } from "../../icons/flag";
import { PlusIcon } from "../../icons/plus";
import { ChoiceMenu, HueFlag, type ChoiceMenuEntry } from "../desk";

/**
 * Renders the Initiative the Task is on as a quiet row with a menu: the
 * Initiative's flag and name, or "No initiative", and a chevron. The menu
 * lists the open Initiatives with their flags, "No initiative", and last
 * "New initiative…" when `canCreate` is true.
 *
 * - `current` is the open Initiative the Task is on. A Task on a closed
 *   Initiative has none to show, as the board draws it.
 * - `onPick` is called with the id of the row the user chose: an Initiative's
 *   id, `NO_INITIATIVE_CHOICE_ID` or `NEW_INITIATIVE_CHOICE_ID`.
 *
 * Esc inside the open menu closes the menu only. The pane's own Esc, which
 * closes the pane, never sees it.
 */
export function InitiativeSection({
  current,
  initiatives,
  canCreate,
  isDisabled,
  onPick,
}: {
  readonly current: WorkInitiative | undefined;
  readonly initiatives: readonly WorkInitiative[];
  readonly canCreate: boolean;
  /** True for a Task that no longer exists, which cannot be changed. */
  readonly isDisabled: boolean;
  readonly onPick: (choiceId: string) => void;
}): JSX.Element {
  const entries: readonly ChoiceMenuEntry<string>[] = [
    ...initiatives.map((initiative) => ({
      id: initiative.id,
      name: initiative.name,
      mark: <HueFlag hue={initiative.hue} />,
    })),
    { id: NO_INITIATIVE_CHOICE_ID, name: "No initiative" },
    ...(canCreate
      ? [{ id: NEW_INITIATIVE_CHOICE_ID, name: "New initiative…", mark: <PlusIcon size={14} /> }]
      : []),
  ];
  const keepEscapeInMenu = (event: KeyboardEvent<HTMLElement>): void => {
    if (
      event.key === "Escape" &&
      event.target instanceof Element &&
      event.target.closest("[role=menu]")
    ) {
      event.stopPropagation();
    }
  };
  return (
    <section className="task-pane-sec task-pane-initiative" aria-label="Initiative">
      <h3>Initiative</h3>
      {/* The menu is a popover inside this wrapper, so a key pressed in it reaches this handler. */}
      <div onKeyDown={keepEscapeInMenu}>
        <ChoiceMenu
          label="Initiative"
          edge="button-end"
          entries={entries}
          chosenId={current?.id ?? NO_INITIATIVE_CHOICE_ID}
          onPick={onPick}
          renderTrigger={(triggerProps) => (
            <button
              {...triggerProps}
              type="button"
              className="task-pane-row task-pane-initiative-row"
              disabled={isDisabled}
              aria-label={`Initiative: ${current?.name ?? "none"}`}
            >
              <span className="task-pane-initiative-mark">
                {current === undefined ? <FlagIcon size={14} /> : <HueFlag hue={current.hue} />}
              </span>
              <span className="task-pane-row-text">{current?.name ?? "No initiative"}</span>
              <ChevronDownIcon size={12} />
            </button>
          )}
        />
      </div>
    </section>
  );
}
