import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  type ToggleEvent,
} from "react";
import { moveMenuFocus } from "./intake/move-menu-focus";

/** What `usePopoverMenu` returns: the props of the trigger, the menu and each item. */
export interface PopoverMenu {
  /** Spread on the button that opens the menu. */
  readonly triggerProps: {
    readonly popoverTarget: string;
    readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  };
  /** Spread on the menu's element, together with `popover="auto"` and `role="menu"`. */
  readonly menuProps: {
    readonly ref: RefObject<HTMLDivElement | null>;
    readonly id: string;
    readonly onToggle: (event: ToggleEvent<HTMLDivElement>) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  };
  /**
   * Returns the props of the item named `item`: its role, its name in
   * `data-item`, and the class that draws it active under the pointer. A
   * `disabled` item is marked `aria-disabled`, and the pointer and the arrow
   * keys pass over it.
   */
  readonly buildItemProps: (
    item: string,
    disabled?: boolean,
  ) => {
    readonly role: "menuitem";
    readonly className: string | undefined;
    readonly "data-item": string;
    readonly "aria-disabled"?: true;
    readonly onPointerEnter: () => void;
    readonly onPointerLeave: () => void;
  };
  /** Closes the menu. An item calls it before it acts. */
  readonly close: () => void;
}

/**
 * Returns the props that make a button and an element a popover menu, as
 * Intake's pane menu and the Connections menus draw it.
 *
 * The menu is the browser's own popover (`popover="auto"`): the browser
 * closes it on Esc and on a click outside it, and CSS places it beside its
 * button by anchor positioning. The items are always rendered, open or not,
 * so a closed menu holds no state of its own. Its items are stepped through
 * as the snooze menu's are:
 *
 * - the first item that can be taken gets the focus when the menu opens, so
 *   the arrow keys work at once, and it is drawn active when the menu was
 *   opened by a key;
 * - the arrow keys move the focus, wrapping around at either end;
 * - the item under the pointer, or the one the keys moved to, is drawn
 *   active, so two items are never highlighted at once.
 */
export function usePopoverMenu(): PopoverMenu {
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const openedByKey = useRef(false);
  const [activeItem, setActiveItem] = useState<string | null>(null);

  const handleToggle = (event: ToggleEvent<HTMLDivElement>): void => {
    if (event.newState !== "open") {
      setActiveItem(null);
      return;
    }
    const first = event.currentTarget.querySelector<HTMLElement>(
      "[role='menuitem']:not([aria-disabled='true'])",
    );
    first?.focus({ preventScroll: true });
    setActiveItem(openedByKey.current && first !== null ? (first.dataset.item ?? null) : null);
  };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = moveMenuFocus(event.currentTarget, event.key);
    setActiveItem(next?.dataset.item ?? null);
  };

  return {
    triggerProps: {
      popoverTarget: menuId,
      onClick: (event) => {
        // A click from the keyboard, Enter or Space, has no pointer press.
        openedByKey.current = event.detail === 0;
      },
    },
    menuProps: { ref: menuRef, id: menuId, onToggle: handleToggle, onKeyDown: handleKeys },
    buildItemProps: (item, disabled = false) => ({
      role: "menuitem",
      className: item === activeItem ? "is-active" : undefined,
      "data-item": item,
      ...(disabled ? { "aria-disabled": true } : {}),
      onPointerEnter: () => {
        setActiveItem(disabled ? null : item);
      },
      onPointerLeave: () => {
        setActiveItem(null);
      },
    }),
    close: () => {
      menuRef.current?.hidePopover();
    },
  };
}
