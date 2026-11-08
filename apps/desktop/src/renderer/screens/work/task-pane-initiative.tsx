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
 * "New initiative…".
 *
 * - `current` is the open Initiative the Task is on. A Task on a closed
 *   Initiative has none to show, as the board draws it.
 * - `pendingInitiative` is set while a change is on its way. The row then
 *   shows the Initiative the Task is being put on, quiet, and is
 *   `aria-disabled` and opens no menu, so the next pick starts from the
 *   answer and not from a guess.
 * - `onPick` is called with the id of the row the user chose: an Initiative's
 *   id, `NO_INITIATIVE_CHOICE_ID` or `NEW_INITIATIVE_CHOICE_ID`.
 *
 * Esc inside the open menu closes the menu only. The pane's own Esc, which
 * closes the pane, never sees it.
 */
export function InitiativeSection({
  current,
  initiatives,
  pendingInitiative,
  isDisabled,
  onPick,
}: {
  readonly current: WorkInitiative | undefined;
  readonly initiatives: readonly WorkInitiative[];
  /**
   * The Initiative the Task is being put on (`null` for none) while a pick or
   * its Undo has not finished, else `undefined`.
   */
  readonly pendingInitiative: { readonly initiativeId: string | null } | undefined;
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
    { id: NEW_INITIATIVE_CHOICE_ID, name: "New initiative…", mark: <PlusIcon size={14} /> },
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
  const isPending = pendingInitiative !== undefined;
  const shown = isPending
    ? initiatives.find((each) => each.id === pendingInitiative.initiativeId)
    : current;
  return (
    <section className="task-pane-sec task-pane-initiative" aria-label="Initiative">
      <h3>Initiative</h3>
      {/* The menu is a popover inside this wrapper, so a key pressed in it reaches this handler. */}
      <div onKeyDown={keepEscapeInMenu}>
        <ChoiceMenu
          label="Initiative"
          edge="button-end"
          entries={entries}
          chosenId={shown?.id ?? NO_INITIATIVE_CHOICE_ID}
          onPick={onPick}
          renderTrigger={(triggerProps) => (
            <button
              {...triggerProps}
              type="button"
              className={`task-pane-row task-pane-initiative-row${isPending ? " is-pending" : ""}`}
              disabled={isDisabled}
              aria-disabled={isPending ? true : undefined}
              aria-label={`Initiative: ${shown?.name ?? "none"}`}
              onClick={(event) => {
                // The button stays focusable while pending, so it only refuses to open the menu.
                if (isPending) event.preventDefault();
                else triggerProps.onClick(event);
              }}
            >
              <span className="task-pane-initiative-mark">
                {shown === undefined ? (
                  <FlagIcon size={13} />
                ) : (
                  <HueFlag hue={shown.hue} size={13} />
                )}
              </span>
              <span className="task-pane-row-text">{shown?.name ?? "No initiative"}</span>
              <ChevronDownIcon size={12} />
            </button>
          )}
        />
      </div>
    </section>
  );
}
