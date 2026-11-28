import type { KeyboardEvent, PointerEvent, RefObject } from "react";

/** How far one arrow key press moves the pane's edge, in pixels, unless the caller says otherwise. */
const DEFAULT_KEYBOARD_STEP = 16;

/** What `useResizablePane` needs to know about the pane it resizes. */
export interface ResizablePaneOptions {
  /** The pane's element. Its box tells where its fixed edge is and how wide it is now. */
  readonly paneRef: RefObject<HTMLElement | null>;
  /**
   * Which side of the separator the pane is on. A pane on the right grows
   * when the separator moves left, and a pane on the left grows when it moves
   * right.
   */
  readonly paneSide: "left" | "right";
  /** The width the user last gave the pane, as the caller draws it. Reported as `aria-valuenow`. */
  readonly width: number;
  /** The width a double click gives the pane. */
  readonly defaultWidth: number;
  /** The narrowest the pane may be. Reported as `aria-valuemin`. */
  readonly min: number;
  /** The widest the pane may be, when it is known while rendering. Reported as `aria-valuemax`. */
  readonly max?: number | undefined;
  /**
   * Measures the widest the pane may be, for a pane whose limit only layout
   * knows. Called once per gesture, never per pointer move. Without it the
   * limit is `max`, or none.
   */
  readonly measureMax?: () => number;
  /** How far one arrow key press moves the edge, in pixels. 16 unless given. */
  readonly step?: number;
  /**
   * Draws the pane at `width` pixels straight in the page, with no React
   * render. Called for every pointer move and key press.
   */
  readonly draw: (width: number) => void;
  /** Stores `width` as the pane's new width. Called once when a gesture ends, never per pointer move. */
  readonly onCommit: (width: number) => void;
}

/** The props to spread on the separator element. The caller adds its own `aria-label` and `className`. */
export interface ResizableSeparatorProps {
  readonly role: "separator";
  readonly "aria-orientation": "vertical";
  readonly "aria-valuenow": number;
  readonly "aria-valuemin": number;
  readonly "aria-valuemax": number | undefined;
  readonly tabIndex: 0;
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
}

/**
 * Returns the props of a vertical separator that resizes a pane, which is the
 * mechanics shared by every resizable pane of the desktop app:
 *
 * - Dragging with the pointer makes the pane follow it one to one. Each move
 *   calls `draw` and the end of the drag calls `onCommit` once, so React
 *   renders once per drag, not once per move.
 * - The arrow keys move the pane's edge by `step`. The arrow that points
 *   away from the pane widens it. Home gives the pane its widest width and
 *   End its narrowest.
 * - A double click gives the pane `defaultWidth`.
 *
 * Every width the hook produces stays within `min` and the pane's widest
 * width. The caller keeps its own limits, storage and breakpoints, and the
 * handled keys do not bubble, so a screen's own keys never see them.
 */
export function useResizablePane(options: ResizablePaneOptions): ResizableSeparatorProps {
  const { paneRef, paneSide, min, max, step = DEFAULT_KEYBOARD_STEP } = options;

  /**
   * Measures the pane once per gesture, because a read after a style write
   * forces a layout. Returns the pane's box and a function that keeps a width
   * within the limits.
   */
  const measure = (): {
    readonly box: DOMRect;
    readonly fit: (width: number) => number;
  } => {
    const widest = options.measureMax?.() ?? max ?? Infinity;
    return {
      box: paneRef.current!.getBoundingClientRect(),
      fit: (width) => Math.max(min, Math.min(Math.round(width), widest)),
    };
  };

  /** Draws and stores a width that was not dragged to, such as a key's or a double click's. */
  const jumpTo = (width: number): void => {
    options.draw(width);
    options.onCommit(width);
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const { box, fit } = measure();
    // The pane's edge on the far side of the separator does not move.
    const fixedEdge = paneSide === "right" ? box.right : box.left;
    let latest: number | undefined;
    const move = (moved: globalThis.PointerEvent): void => {
      latest = fit(paneSide === "right" ? fixedEdge - moved.clientX : moved.clientX - fixedEdge);
      options.draw(latest);
      handle.setAttribute("aria-valuenow", String(latest));
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (latest !== undefined) options.onCommit(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The arrow that points away from the pane widens it.
    const widening = paneSide === "right" ? "ArrowLeft" : "ArrowRight";
    const narrowing = paneSide === "right" ? "ArrowRight" : "ArrowLeft";
    const { box, fit } = measure();
    const width = Math.round(box.width);
    const next =
      event.key === widening
        ? fit(width + step)
        : event.key === narrowing
          ? fit(width - step)
          : event.key === "Home"
            ? fit(Infinity)
            : event.key === "End"
              ? fit(0)
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    jumpTo(next);
  };

  return {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-valuenow": options.width,
    "aria-valuemin": min,
    "aria-valuemax": max,
    tabIndex: 0,
    onPointerDown: startDrag,
    onKeyDown: resizeWithKeys,
    onDoubleClick: () => {
      jumpTo(measure().fit(options.defaultWidth));
    },
  };
}
