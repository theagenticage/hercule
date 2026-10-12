import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  type ToggleEvent,
} from "react";
import { moveMenuFocus } from "./move-menu-focus";

/** What `usePopoverMenu` returns: the props of the trigger, the menu and each item. */
export interface PopoverMenu {
  /** Spread on the button that opens the menu. */
  readonly triggerProps: {
    readonly popoverTarget: string;
    readonly "aria-haspopup": "menu";
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
   * `data-item`, and the class that draws it active. A `disabled` item is
   * marked `aria-disabled`, and the pointer and the arrow keys pass over it.
   */
  readonly buildItemProps: (
    item: string,
    disabled?: boolean,
  ) => {
    readonly role: "menuitem";
    readonly className: string | undefined;
    readonly "data-item": string;
    readonly "aria-disabled"?: true;
    readonly onFocus: () => void;
    readonly onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
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
 * - the item with the focus is drawn active, whether Tab, the arrow keys or
 *   the pointer moved it there, and a disabled item is never drawn active.
 *   The pointer moves the focus to the item it enters, so Enter always takes
 *   the item drawn active, and two items are never highlighted at once.
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
    // The focus above makes the first item active. A menu opened by the
    // pointer starts with no item active, so this replaces that state.
    setActiveItem(openedByKey.current && first !== null ? (first.dataset.item ?? null) : null);
  };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveMenuFocus(event.currentTarget, event.key);
  };

  return {
    triggerProps: {
      popoverTarget: menuId,
      "aria-haspopup": "menu",
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
      onFocus: () => {
        setActiveItem(disabled ? null : item);
      },
      onPointerEnter: (event) => {
        event.currentTarget.focus({ preventScroll: true });
      },
    }),
    close: () => {
      menuRef.current?.hidePopover();
    },
  };
}
