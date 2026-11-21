import { useId, useState, type JSX, type ReactNode } from "react";
import "./menus.css";

/**
 * Renders a trigger in the composer and the menu it opens above itself.
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
 * - `width` sizes the menu, as spec 14 sizes each one: `narrow` is 320px,
 *   `wide` 360px for the model menu, and `widest` 420px for the workspace
 *   and machine menus, whose rows carry a second line. `bare` draws no
 *   panel of its own: the content brings its own glass panels, as the `+`
 *   menu's two panels side by side.
 * - `disabled` leaves the trigger drawn but unable to open the menu.
 * - `triggerLabel`, when given, is the trigger's accessible name, for a
 *   trigger that is an icon.
 * - `onOpen`, when given, is called each time the menu opens.
 * - `onClosed`, when given, is called each time the menu closes, however it
 *   closes.
 * - `children` draws the menu's content. It is called only while the menu
 *   is open, so a closed menu costs nothing, and anything the content holds,
 *   such as a filter's text, starts afresh each time the menu opens. It
 *   receives a function that closes the menu.
 */
export function ComposerMenu({
  label,
  align,
  width = "narrow",
  disabled,
  triggerClassName,
  trigger,
  triggerLabel,
  children,
  onOpen,
  onClosed,
}: {
  readonly label: string;
  readonly align: "start" | "end";
  readonly width?: "narrow" | "wide" | "widest" | "bare";
  readonly disabled: boolean;
  readonly triggerClassName: string;
  readonly trigger: ReactNode;
  readonly triggerLabel?: string | undefined;
  readonly children: (close: () => void) => ReactNode;
  readonly onOpen?: (() => void) | undefined;
  readonly onClosed?: (() => void) | undefined;
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
        aria-label={triggerLabel}
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
        className={`pop menu menu--${align} menu--${width}`}
        onToggle={(event) => {
          setOpen(event.newState === "open");
          if (event.newState === "open") onOpen?.();
          else onClosed?.();
        }}
      >
        {open ? children(close) : null}
      </div>
    </>
  );
}
