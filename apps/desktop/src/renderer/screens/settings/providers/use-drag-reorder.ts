import { useRef, useState, type DragEvent, type PointerEvent } from "react";

/** Where a dragged item will land relative to the item under the pointer. */
type DropSide = "before" | "after";

/** The elements inside a draggable item that take the pointer for themselves. */
const CONTROL_SELECTOR = 'button, input, [role="menu"], [popover]';

/**
 * Makes the items `keys` drag-reorderable, with the browser's own drag and
 * drop. Nothing is sent while the pointer moves: `onDrop` is called once,
 * when the item is dropped, with the item's key and the position it lands on
 * (0 is the top) in the list as it is without the dragged item moved.
 *
 * Returns:
 *
 * - `draggingKey`, the key being dragged, or `null`;
 * - `dropMark`, the item under the pointer and which side of it the dragged
 *   item will land on, or `null`;
 * - `getSourceProps(key)`, the props of the element the user grabs to drag
 *   the item `key`. A press on a button, an input or a menu inside that
 *   element does not start a drag, so the user can press and slightly move
 *   the pointer there without carrying the item along;
 * - `getTargetProps(key)`, the props of the element a dragged item can be
 *   dropped on to land beside the item `key`.
 *
 * Two lists with their own instance of this hook do not take each other's
 * items: a drag from one list is ignored by the other's targets, which is how
 * a model row and an account's section can both be dragged on one page.
 */
export function useDragReorder(
  keys: readonly string[],
  onDrop: (key: string, toIndex: number) => void,
) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{
    readonly key: string;
    readonly side: DropSide;
  } | null>(null);

  // Whether the last press landed on a button, an input or a menu inside the
  // draggable element. The browser fires `dragstart` at the draggable element
  // itself, never at the child under the pointer, so only the press can tell.
  const pressedOnControl = useRef(false);

  const readSide = (event: DragEvent<HTMLElement>): DropSide => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? "before" : "after";
  };
  const finish = (): void => {
    setDraggingKey(null);
    setDropMark(null);
  };

  return {
    draggingKey,
    dropMark,
    getSourceProps: (key: string) => ({
      draggable: true as const,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        const control =
          event.target instanceof Element ? event.target.closest(CONTROL_SELECTOR) : null;
        pressedOnControl.current =
          control !== null &&
          control !== event.currentTarget &&
          event.currentTarget.contains(control);
      },
      onDragStart: (event: DragEvent<HTMLElement>) => {
        if (pressedOnControl.current) {
          event.preventDefault();
          return;
        }
        // Firefox starts no drag without data; Chromium does not need it.
        event.dataTransfer.setData("text/plain", key);
        event.dataTransfer.effectAllowed = "move";
        setDraggingKey(key);
      },
      onDragEnd: finish,
    }),
    getTargetProps: (key: string) => ({
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (draggingKey === null || draggingKey === key) return;
        event.preventDefault();
        const side = readSide(event);
        if (dropMark?.key !== key || dropMark.side !== side) setDropMark({ key, side });
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropMark((mark) => (mark?.key === key ? null : mark));
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (draggingKey === null || draggingKey === key) return;
        event.preventDefault();
        const from = keys.indexOf(draggingKey);
        const over = keys.indexOf(key);
        finish();
        if (from === -1 || over === -1) return;
        const toIndex = over + (readSide(event) === "after" ? 1 : 0) - (from < over ? 1 : 0);
        if (toIndex !== from) onDrop(draggingKey, toIndex);
      },
    }),
  };
}
