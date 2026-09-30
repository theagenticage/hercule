import { useId, useState, type JSX, type ReactNode } from "react";
import "./menus.css";

/**
 * Renders a trigger in the composer's row and the menu it opens above
 * itself.
 *
 * The menu is the browser's own popover (`popover="auto"`), opened by the
 * trigger's `popovertarget`. The browser closes it on Esc, on a click
 * outside it, and when another menu opens, so one menu is open at a time,
 * and the text in the message field is never touched. The menu is placed
 * with CSS anchor positioning: the trigger is its anchor, because it opens
 * the menu.
 *
 * - `label` names the menu for assistive technology.
 * - `align` is the edge the menu shares with its trigger: `start` for a menu
 *   that grows to the right, `end` for one that grows to the left.
 * - `wide` makes the menu 360px wide instead of 320px, as spec 14 sizes the
 *   model menu.
 * - `disabled` leaves the trigger drawn but unable to open the menu.
 * - `children` draws the menu's content. It is called only while the menu
 *   is open, so a closed menu costs nothing, and anything the content holds,
 *   such as a filter's text, starts afresh each time the menu opens. It
 *   receives a function that closes the menu.
 */
export function ComposerMenu({
  label,
  align,
  wide = false,
  disabled,
  triggerClassName,
  trigger,
  children,
}: {
  readonly label: string;
  readonly align: "start" | "end";
  readonly wide?: boolean;
  readonly disabled: boolean;
  readonly triggerClassName: string;
  readonly trigger: ReactNode;
  readonly children: (close: () => void) => ReactNode;
}): JSX.Element {
  const id = useId();
  const [menu, setMenu] = useState<HTMLDivElement | null>(null);
  // Follows the browser's open state, which changes without React: on Esc
  // and on a click outside the menu.
  const [open, setOpen] = useState(false);
  const close = (): void => {
    menu?.hidePopover();
  };

  return (
    <>
      <button
        type="button"
        className={triggerClassName}
        popoverTarget={disabled ? undefined : id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
      >
        {trigger}
      </button>
      <div
        ref={setMenu}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        className={`menu menu--${align}${wide ? " menu--wide" : ""}`}
        onToggle={(event) => {
          setOpen(event.newState === "open");
        }}
      >
        {open ? children(close) : null}
      </div>
    </>
  );
}
