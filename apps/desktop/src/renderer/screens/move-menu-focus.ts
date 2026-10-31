/**
 * The CSS selector of a menu's items that can take the focus: the items with
 * the role `menuitem` or `menuitemradio` that are not marked `aria-disabled`.
 */
export const FOCUSABLE_MENU_ITEM_SELECTOR =
  ":is([role='menuitem'], [role='menuitemradio']):not([aria-disabled='true'])";

/**
 * Moves the focus one item down the menu `menu` for `ArrowDown`, or one item
 * up for `ArrowUp`, and returns the item that now has it. The focus wraps
 * around at either end, and passes over an item marked `aria-disabled`,
 * which cannot be taken. When no item has the focus, `ArrowDown` focuses the
 * first item and `ArrowUp` the last. Returns `undefined` when the menu has no
 * item that can take the focus.
 *
 * The snooze menu and every menu built with `usePopoverMenu` call it from
 * their key handlers, so the arrow keys step through each menu the same way.
 */
export const moveMenuFocus = (
  menu: HTMLElement,
  key: "ArrowDown" | "ArrowUp",
): HTMLElement | undefined => {
  const items = [...menu.querySelectorAll<HTMLElement>(FOCUSABLE_MENU_ITEM_SELECTOR)];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = key === "ArrowDown" ? 1 : -1;
  const from = at === -1 && step === -1 ? 0 : at;
  const next = items[(from + step + items.length) % items.length];
  next?.focus();
  return next;
};
