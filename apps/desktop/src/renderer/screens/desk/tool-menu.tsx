import type { JSX, ReactNode } from "react";
import { CheckIcon } from "../../icons/check";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { ChevronRightIcon } from "../../icons/chevron-right";
import type { PopoverMenu } from "../use-popover-menu";
import { ViewSwitch, type ViewChoice } from "../workflows/view-switch";
import "../thread/menus.css";
import "./toolbar.css";

/** The props `usePopoverMenu` returns for one item: spread on the item's button. */
export type MenuItemProps = ReturnType<PopoverMenu["buildItemProps"]>;

/**
 * Renders the menu of a toolbar control as a popover, 8px under the button
 * that opens it (`usePopoverMenu`'s `triggerProps` go on that button, and its
 * `menuProps` here). Fill it with `MenuPick`, `MenuBack`, `MenuHeading` and
 * `MenuLine`. `label` names the menu for assistive technology.
 */
export function ToolMenu({
  menuProps,
  label,
  children,
}: {
  readonly menuProps: PopoverMenu["menuProps"];
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      {...menuProps}
      popover="auto"
      role="menu"
      aria-label={label}
      className="pop popover-menu menu--tool"
    >
      {children}
    </div>
  );
}

/** Joins the classes an item is drawn with, leaving out those it does not have. */
const joinClasses = (...classes: ReadonlyArray<string | false | undefined>): string =>
  classes.filter((each) => each !== undefined && each !== false).join(" ");

/**
 * What a `MenuPick` does when pressed:
 *
 * - `choice` is one of a group, and the chosen one shows a check at its end;
 * - `toggle` is a box that is on or off, with the number of Tasks it would
 *   leave beside it, when `count` is given;
 * - `opens` opens a submenu, with the number of values on in it, when given.
 */
export type MenuPickKind = "choice" | "toggle" | "opens";

/**
 * Renders one row of a tool menu: a `mark` such as a folder or a source's
 * mark, then `name`, then what the row's kind adds (see `MenuPickKind`).
 *
 * `itemProps` is what `buildItemProps` of the menu returns for this row. A
 * `toggle` row is a checkbox, so it takes the role `menuitemcheckbox` in place
 * of the `menuitemradio` that `buildItemProps` gives a row with `checked`.
 */
export function MenuPick({
  itemProps,
  kind,
  name,
  isOn,
  mark,
  count,
  onPick,
}: {
  readonly itemProps: MenuItemProps;
  readonly kind: MenuPickKind;
  readonly name: string;
  readonly isOn: boolean;
  readonly mark?: ReactNode;
  readonly count?: number;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <button
      {...itemProps}
      type="button"
      role={kind === "toggle" ? "menuitemcheckbox" : itemProps.role}
      className={joinClasses("menu-pick", isOn && "is-on", itemProps.className)}
      onClick={onPick}
    >
      {kind === "toggle" && <i className="menu-box">{isOn && <CheckIcon size={11} />}</i>}
      <span className="menu-mark">{mark}</span>
      <span>{name}</span>
      {kind === "toggle" && count !== undefined && <small>{count}</small>}
      {kind === "opens" && count !== undefined && count > 0 && <small>{count}</small>}
      {kind === "choice" && isOn && <CheckIcon size={14} />}
      {kind === "opens" && <ChevronRightIcon size={12} />}
    </button>
  );
}

/** Renders the row that leaves a submenu, named for the submenu, and calls `onBack`. */
export function MenuBack({
  itemProps,
  name,
  onBack,
}: {
  readonly itemProps: MenuItemProps;
  readonly name: string;
  readonly onBack: () => void;
}): JSX.Element {
  return (
    <button
      {...itemProps}
      type="button"
      className={joinClasses("menu-back", itemProps.className)}
      onClick={onBack}
    >
      <ChevronLeftIcon size={12} />
      <b>{name}</b>
    </button>
  );
}

/** Renders a quiet heading over a group of rows, such as "From your sources". */
export function MenuHeading({ children }: { readonly children: ReactNode }): JSX.Element {
  return <p className="menu-h">{children}</p>;
}

/** Renders a hairline between two groups of rows. */
export function MenuLine(): JSX.Element {
  return <i className="menu-line" />;
}

/**
 * Renders a row of a tool menu that acts when pressed, such as "Fold
 * everything", with its key at the end.
 */
export function MenuAction({
  itemProps,
  name,
  shortcut,
  onPick,
}: {
  readonly itemProps: MenuItemProps;
  readonly name: string;
  readonly shortcut: string;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <button
      {...itemProps}
      type="button"
      className={joinClasses("menu-action", itemProps.className)}
      onClick={onPick}
    >
      {name}
      <kbd>{shortcut}</kbd>
    </button>
  );
}

/**
 * Renders a setting of a tool menu that is on or off: its `name`, a line of
 * `description` under it, and a switch. Pressing the row calls `onToggle`.
 * Like a `toggle` row of `MenuPick`, it is a `menuitemcheckbox` that the
 * arrow keys step to.
 */
export function MenuSwitch({
  itemProps,
  name,
  description,
  isOn,
  onToggle,
}: {
  readonly itemProps: MenuItemProps;
  readonly name: string;
  readonly description: string;
  readonly isOn: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <button
      {...itemProps}
      type="button"
      role="menuitemcheckbox"
      className={joinClasses("menu-switch", isOn && "is-on", itemProps.className)}
      onClick={onToggle}
    >
      <span className="menu-switch-words">
        <b>{name}</b>
        <small>{description}</small>
      </span>
      <i className="menu-switch-track" />
    </button>
  );
}

/**
 * Renders a setting of a tool menu with a few words to choose from, such as
 * "Side labels" or "Bands": its `name` and a segmented control. Pressing a
 * word calls `onPick`, and the left and right arrows pick the word beside
 * the one picked. The words are not menu items, so Tab reaches them and the
 * up and down arrows pass over them.
 */
export function MenuSegment<Choice extends string>({
  name,
  choices,
  choice,
  onPick,
}: {
  readonly name: string;
  readonly choices: ReadonlyArray<ViewChoice<Choice>>;
  readonly choice: Choice;
  readonly onPick: (choice: Choice) => void;
}): JSX.Element {
  return (
    <div className="menu-segment">
      <b>{name}</b>
      <ViewSwitch label={name} choices={choices} view={choice} onPick={onPick} />
    </div>
  );
}
