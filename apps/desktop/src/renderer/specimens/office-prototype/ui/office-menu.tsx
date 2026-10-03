/**
 * PROTOTYPE - a menu that drops down from a button in the office's top bar:
 * the room directory and the Simulate menu.
 *
 * The menu is the browser's own popover, as the composer's menus are (see
 * screens/thread/composer-menu.tsx), but it opens below its trigger instead
 * of above it. The browser closes it on Esc, on a click outside it, and when
 * another menu opens.
 */
import { useId, useState, type JSX, type ReactNode } from "react";
import "../../../screens/thread/menus.css";

/**
 * Renders a trigger and the menu it opens below itself.
 *
 * - `label` names the menu for assistive technology.
 * - `align` is the edge the menu shares with its trigger: `start` for a menu
 *   that grows to the right, `end` for one that grows to the left.
 * - `children` draws the menu's content. It is called only while the menu
 *   is open, and receives a function that closes the menu.
 */
export function OfficeMenu({
  label,
  align,
  triggerClassName,
  triggerLabel,
  trigger,
  children,
}: {
  readonly label: string;
  readonly align: "start" | "end";
  readonly triggerClassName: string;
  /** Names the trigger for assistive technology when its text is hidden in a narrow office. */
  readonly triggerLabel?: string;
  readonly trigger: ReactNode;
  readonly children: (close: () => void) => ReactNode;
}): JSX.Element {
  const id = useId();
  const [menu, setMenu] = useState<HTMLDivElement | null>(null);
  // Follows the browser's open state, which changes without React: on Esc
  // and on a click outside the menu.
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={triggerClassName}
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
      >
        {trigger}
      </button>
      <div
        ref={setMenu}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        className={`pop office-menu office-menu--${align}`}
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        {open ? children(() => menu?.hidePopover()) : null}
      </div>
    </>
  );
}
