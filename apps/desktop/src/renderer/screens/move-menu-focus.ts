/**
 * The CSS selector of a menu's items that can take the focus: the items with
 * the role `menuitem` or `menuitemradio` that are not marked `aria-disabled`.
 */
export const FOCUSABLE_MENU_ITEM_SELECTOR =
  ":is([role='menuitem'], [role='menuitemradio']):not([aria-disabled='true'])";

/** The keys `moveMenuFocus` handles. */
export type MenuFocusKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** Returns whether `key` is one of the keys `moveMenuFocus` handles. */
export const isMenuFocusKey = (key: string): key is MenuFocusKey =>
  key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";

/**
 * Moves the focus in the menu `menu` as `key` asks, and returns the item that
 * now has it:
 *
 * - `ArrowDown` moves one item down and `ArrowUp` one item up. The focus wraps
 *   around at either end. When no item has the focus, `ArrowDown` focuses the
 *   first item and `ArrowUp` the last.
 * - `Home` focuses the first item and `End` the last.
 *
 * All four keys pass over an item marked `aria-disabled`, which cannot be
 * taken. Returns `undefined` when the menu has no item that can take the focus.
 *
 * The snooze menu and every menu built with `usePopoverMenu` call it from
 * their key handlers, so the keys step through each menu the same way.
 */
export const moveMenuFocus = (menu: HTMLElement, key: MenuFocusKey): HTMLElement | undefined => {
  const items = [...menu.querySelectorAll<HTMLElement>(FOCUSABLE_MENU_ITEM_SELECTOR)];
  if (key === "Home" || key === "End") {
    const edge = key === "Home" ? items[0] : items.at(-1);
    edge?.focus();
    return edge;
  }
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = key === "ArrowDown" ? 1 : -1;
  const from = at === -1 && step === -1 ? 0 : at;
  const next = items[(from + step + items.length) % items.length];
  next?.focus();
  return next;
};
