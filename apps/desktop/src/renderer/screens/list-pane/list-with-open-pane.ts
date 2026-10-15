/**
 * The behaviour shared by the screens that show a list beside an open item:
 * Workflows, Discussions and Wiki. The list is one list at three widths:
 *
 * - the table, while nothing is open;
 * - a column beside the open item;
 * - hidden, while the open item fills the pane (`full`).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { isTextField } from "../../app/text-field";

/** The three widths of a list beside an open item. */
export type ListPaneWidth = "table" | "column" | "full";

/**
 * Returns the width the list is drawn at: the table while no item is open
 * (`open` is `undefined`), the column while one is open, and `full` while the
 * open item's `full` search param is true, which hides the list.
 */
export const computeListPaneWidth = (
  open: { readonly search: { readonly full?: true | undefined } } | undefined,
): ListPaneWidth => {
  if (open === undefined) return "table";
  return open.search.full === true ? "full" : "column";
};

/**
 * Returns the `full` search param of an open item from the URL's search. A
 * value other than `true` is dropped, so the item shows its default.
 *
 * A dropped param is returned as `undefined` rather than left out, because
 * the router lays the validated params over the URL's: a param left out would
 * keep the URL's value.
 */
export const readFullSearch = (search: Record<string, unknown>): true | undefined =>
  search.full === true ? true : undefined;

/**
 * Returns a function that hides the list while it is a column beside the open
 * item `open`, and shows it again while the item fills the pane. It navigates
 * to the same item with `full` set or removed, and keeps the other search
 * params, such as a wiki page's `revision`. Hiding the list pushes a history
 * entry, so Back shows it again. The function does nothing while no item is
 * open.
 */
export const useToggleListPane = (
  open: { readonly pathname: string } | undefined,
  width: ListPaneWidth,
): (() => void) => {
  const navigate = useNavigate();
  return () => {
    if (open === undefined) return;
    void navigate({
      to: open.pathname,
      search: (previous: Record<string, unknown>) => {
        const kept = { ...previous };
        delete kept.full;
        return width === "column" ? { ...kept, full: true } : kept;
      },
    });
  };
};

/**
 * Calls `close` when the user presses Esc while `isOpen`, unless something
 * else takes Esc first:
 *
 * - anything that handles Esc and calls `preventDefault()`, such as a
 *   workflow step's card;
 * - an open dialog, or an open popover the browser closes on Esc (one with
 *   `popover="auto"`), which the browser closes without calling
 *   `preventDefault()`. A manual popover, such as the sidebar's hover card
 *   of a thread, does not close on Esc, so it does not take it;
 * - a focused text field, where Esc belongs to the field.
 */
export const useCloseOnEscape = (isOpen: boolean, close: () => void): void => {
  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTextField(event.target)) return;
      if (document.querySelector('dialog[open], [popover="auto"]:popover-open') !== null) return;
      close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, close]);
};

/**
 * Returns the id of the item the list is scrolled to and focused on when it is
 * drawn at a new width: the open item's id, or while nothing is open, the id
 * of the item open last. Returns `undefined` until an item has been open.
 */
export const useLastOpenItemId = (openId: string | undefined): string | undefined => {
  const [lastOpenId, setLastOpenId] = useState(openId);
  if (openId !== undefined && openId !== lastOpenId) setLastOpenId(openId);
  return openId ?? lastOpenId;
};

/**
 * Moves focus to the row of the item `itemId` after the list is drawn at a new
 * `width`. Opening an item or closing it draws the list again at its new
 * width, which drops the keyboard's focus when it was in the list or the open
 * item. `itemId` is what `useLastOpenItemId` returns.
 *
 * The list must scroll itself to `itemId` as it draws (`isInitialItem` of
 * `VirtualList`), so that the row is mounted. Focus then keeps the row in
 * view.
 *
 * `findRow` returns the item's row among the rows of `list`, the element
 * with the class `workflow-list` that every such screen's list carries, or
 * `null` when the row is not drawn. It must keep its identity across
 * renders, such as a function at the top of a module.
 *
 * Focus that the new width did not drop stays where it is, and a list
 * hidden behind a full open item has no row to focus.
 */
export const useRestoreRowFocus = (
  width: ListPaneWidth,
  itemId: string | undefined,
  findRow: (list: Element, id: string) => HTMLElement | null,
): void => {
  // The width the list was drawn at, so that the row takes focus only after
  // the list is drawn at a new width.
  const lastWidth = useRef(width);
  useEffect(() => {
    const isNewWidth = width !== lastWidth.current;
    lastWidth.current = width;
    if (!isNewWidth || width === "full" || itemId === undefined) return;
    if (document.activeElement !== document.body) return;
    const list = document.querySelector(".workflow-list");
    if (list === null) return;
    // Returns false while the list has drawn no row yet. A list at a new width
    // draws its rows only after it has measured itself, a render after this
    // effect runs, so the row is looked for again as the list changes. When
    // rows are drawn but not the item's, such as when its page is not read
    // yet, the focus stays where it is.
    const focusRow = (): boolean => {
      if (list.querySelector("[data-key]") === null) return false;
      if (document.activeElement === document.body) findRow(list, itemId)?.focus();
      return true;
    };
    if (focusRow()) return;
    const observer = new MutationObserver(() => {
      if (focusRow()) observer.disconnect();
    });
    observer.observe(list, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [width, itemId, findRow]);
};
