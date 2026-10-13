import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  decideSidebarDragEnd,
  DEFAULT_SIDEBAR_WIDTH,
  fitSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  type SidebarLayout,
} from "@hercule/client-core";
import { storeSidebarLayout, toggleSidebar } from "./use-sidebar-layout";

/** How far one arrow key press moves the sidebar's edge, in pixels. */
const KEYBOARD_STEP = 16;

/**
 * Draws the sidebar at `width` pixels, straight in the page: sets
 * `--sidebar-w` on the sidebar's box and on the handle inside `shell`, the
 * two elements whose style reads it. The shell's CSS keeps the width drawn
 * within the sidebar's limits for the window.
 */
export function drawSidebarWidth(shell: HTMLElement, width: number): void {
  for (const element of shell.querySelectorAll<HTMLElement>(".side-slot, .side-handle")) {
    element.style.setProperty("--sidebar-w", `${String(width)}px`);
  }
}

/**
 * Renders the handle on the sidebar's right edge, by which the user resizes
 * the sidebar. `shellRef` is the shell's element, and `width` is the stored
 * width.
 *
 * - Dragging the handle resizes the sidebar. Letting go of it below the
 *   collapse width hides the sidebar.
 * - Double-clicking it gives the sidebar its default width.
 * - With the focus on it, the arrow keys move the edge 16px, Home and End
 *   give the sidebar its narrowest and widest width, and Enter hides it.
 *
 * While the user drags, the handle writes the width straight into the page,
 * at most once a frame, and React draws nothing. Only the end of the drag
 * stores the layout, which draws the shell once.
 */
export function SidebarHandle({
  shellRef,
  width,
}: {
  readonly shellRef: RefObject<HTMLDivElement | null>;
  readonly width: number;
}): JSX.Element {
  /**
   * Gives the sidebar `layout.width` at once, with no transition, then
   * stores the layout. Showing and hiding the sidebar slide; resizing it
   * does not. The new width is laid out before the transition is allowed
   * again, so the change never starts one.
   */
  const resize = (layout: SidebarLayout): void => {
    const shell = shellRef.current!;
    shell.dataset.resizing = "";
    drawSidebarWidth(shell, layout.width);
    void shell.offsetWidth;
    delete shell.dataset.resizing;
    storeSidebarLayout(layout);
  };

  // Stops the drag in progress, if one is, without storing anything. The
  // handle unmounts when the sidebar hides, by ⌘B or the menu, in the middle
  // of a drag; the drag's listeners, its pending frame and the shell's
  // `data-resizing` must not outlive it.
  const stopDragRef = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(
    () => () => {
      stopDragRef.current?.();
    },
    [],
  );

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // Keeps the drag from selecting text. The handle holds the pointer, so
    // the pointer shows the handle's resize cursor wherever it goes.
    event.preventDefault();
    const shell = shellRef.current!;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const widthBefore = fitSidebarWidth(width, innerWidth);
    // The distance from the pointer to the sidebar's edge, kept for the whole
    // drag, so the edge does not jump to the pointer when the drag starts.
    const offset = widthBefore - event.clientX;
    // `undefined` until the pointer moves: a click, or each click of a
    // double-click, changes nothing and stores nothing.
    let dragged: number | undefined;
    let frame: number | undefined;
    shell.dataset.resizing = "";

    const draw = (): void => {
      frame = undefined;
      const fitted = fitSidebarWidth(dragged!, innerWidth);
      drawSidebarWidth(shell, fitted);
      handle.setAttribute("aria-valuenow", String(fitted));
    };
    const move = (moved: globalThis.PointerEvent): void => {
      dragged = moved.clientX + offset;
      frame ??= requestAnimationFrame(draw);
    };
    const stop = (): void => {
      stopDragRef.current = undefined;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", cancel);
      handle.removeEventListener("lostpointercapture", cancel);
      if (frame !== undefined) cancelAnimationFrame(frame);
      delete shell.dataset.resizing;
    };
    // The system took the pointer away before it was let go, so the drag
    // changes nothing: the sidebar goes back to the width it had.
    const cancel = (): void => {
      stop();
      drawSidebarWidth(shell, widthBefore);
      handle.setAttribute("aria-valuenow", String(widthBefore));
    };
    const end = (): void => {
      stop();
      if (dragged === undefined) return;
      const layout = decideSidebarDragEnd(dragged, widthBefore, innerWidth);
      if (layout.collapsed) {
        // The sidebar slides shut from the width it shows now. The stored
        // width is the one from before the drag, which it opens at again.
        storeSidebarLayout(layout);
        return;
      }
      resize(layout);
    };
    stopDragRef.current = stop;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", cancel);
    // A pointer let go fires `pointerup` first, which ends the drag and
    // removes this listener, so only a capture lost some other way cancels.
    handle.addEventListener("lostpointercapture", cancel);
  };

  // The widths the handle reports depend on the window's width, so they are
  // updated when the window is resized. They are set on the element, as a
  // drag sets them, so a resize of the window draws nothing in React.
  const handleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const report = (): void => {
      const handle = handleRef.current!;
      handle.setAttribute("aria-valuenow", String(fitSidebarWidth(width, innerWidth)));
      handle.setAttribute("aria-valuemax", String(fitSidebarWidth(MAX_SIDEBAR_WIDTH, innerWidth)));
    };
    addEventListener("resize", report);
    return () => {
      removeEventListener("resize", report);
    };
  }, [width]);

  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const shown = fitSidebarWidth(width, innerWidth);
    const widths: Partial<Record<string, number>> = {
      ArrowLeft: shown - KEYBOARD_STEP,
      ArrowRight: shown + KEYBOARD_STEP,
      Home: MIN_SIDEBAR_WIDTH,
      End: MAX_SIDEBAR_WIDTH,
    };
    const next = widths[event.key];
    if (event.key === "Enter") {
      event.preventDefault();
      toggleSidebar();
    } else if (next !== undefined) {
      event.preventDefault();
      resize({ width: fitSidebarWidth(next, innerWidth), collapsed: false });
    }
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={fitSidebarWidth(width, innerWidth)}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={fitSidebarWidth(MAX_SIDEBAR_WIDTH, innerWidth)}
      tabIndex={0}
      className="side-handle"
      onPointerDown={startDrag}
      onKeyDown={resizeWithKeys}
      onDoubleClick={() => {
        resize({ width: DEFAULT_SIDEBAR_WIDTH, collapsed: false });
      }}
    />
  );
}
