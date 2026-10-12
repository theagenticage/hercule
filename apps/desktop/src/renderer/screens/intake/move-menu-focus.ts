/**
 * Moves the focus one item down the menu `menu` for `ArrowDown`, or one item
 * up for `ArrowUp`, and returns the item that now has it. The focus wraps
 * around at either end, and passes over an item marked `aria-disabled`,
 * which cannot be taken. When no item has the focus, `ArrowDown` focuses the
 * first item and `ArrowUp` the last. Returns `undefined` when the menu has no
 * item that can take the focus.
 *
 * Intake's menus, the snooze menu and the pane's menu, call it from their
 * key handlers, so the arrow keys step through both the same way.
 */
export const moveMenuFocus = (
  menu: HTMLElement,
  key: "ArrowDown" | "ArrowUp",
): HTMLElement | undefined => {
  const items = [
    ...menu.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])"),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = key === "ArrowDown" ? 1 : -1;
  const from = at === -1 && step === -1 ? 0 : at;
  const next = items[(from + step + items.length) % items.length];
  next?.focus();
  return next;
};
