/**
 * The state of Intake's split of a list and a pane: its measured width,
 * whether the pane shows, the list's width while it opens and closes, and the
 * handle that resizes the list. Every Intake view shares it.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { fitIntakeListWidth, fitsIntakePane } from "@hercule/client-core";
import { useIntakeListWidth } from "./use-intake-list-width";

/** How far one arrow key press moves the split's handle, in pixels. */
const KEYBOARD_STEP = 16;

/** What `useIntakeSplit` returns, for the screen's own keys and for `IntakeSplit`. */
export interface IntakeSplitState {
  readonly splitRef: RefObject<HTMLDivElement | null>;
  readonly listRef: RefObject<HTMLElement | null>;
  /** The width the user last gave the list, before it is fitted to the split. */
  readonly width: number;
  /** The split's measured width, or `null` until it is measured. */
  readonly available: number | null;
  /** Whether the split is wide enough for the pane. It counts as wide until the split is measured. */
  readonly fits: boolean;
  /** Whether the pane shows: a row is selected, the user did not close it, and the split is wide enough. */
  readonly paneShown: boolean;
  /** Whether the pane is drawn: it shows, or it is sliding out. */
  readonly paneDrawn: boolean;
  /** Whether the list is narrowed for the pane. It follows `paneShown` one frame late. */
  readonly listNarrowed: boolean;
  /** Closes the pane and keeps the row selected, or opens it again with `false`. */
  readonly setDismissed: (dismissed: boolean) => void;
  /** Called when the list's width transition ends, which is when a closing pane is no longer drawn. */
  readonly endClosing: () => void;
  readonly startDrag: (event: PointerEvent<HTMLDivElement>) => void;
  readonly resizeWithKeys: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Returns the split's state for a view whose selected row is `selectedId`, or
 * `null` when none is. `rowAttribute` is the data attribute that marks each
 * row of the list with its id, such as `data-signal-id`: when the pane
 * closes, the focus goes to the selected row.
 */
export function useIntakeSplit(selectedId: string | null, rowAttribute: string): IntakeSplitState {
  const [width, storeWidth] = useIntakeListWidth();
  const [dismissed, setDismissed] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  // `null` until the split is measured, which counts as fitting, so the pane
  // never flashes closed on the first frame.
  const [available, setAvailable] = useState<number | null>(null);

  useLayoutEffect(() => {
    const split = splitRef.current!;
    const measure = (): void => {
      setAvailable(split.offsetWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    return () => {
      observer.disconnect();
    };
  }, []);

  const fits = available === null || fitsIntakePane(available);
  const paneShown = selectedId !== null && !dismissed && fits;

  // The row whose pane is sliding out: the pane stays drawn until the
  // list has widened over it. Only that row is drawn while the pane is
  // closed, so moving the selection with the pane closed reads nothing and
  // loads no image. Under Reduce motion no transition ends, so the id stays
  // until the selection moves, which draws that same row and nothing new.
  const [closingId, setClosingId] = useState<string | null>(null);
  const [paneShownBefore, setPaneShownBefore] = useState(paneShown);
  if (paneShown !== paneShownBefore) {
    setPaneShownBefore(paneShown);
    setClosingId(paneShown ? null : selectedId);
  }
  const paneDrawn = selectedId !== null && (paneShown || closingId === selectedId);

  // Whether the list is narrowed for the pane. Changing it starts the
  // split's transition, and it follows `paneShown` one frame late: the click
  // or key is drawn in one frame, and the list starts to move in the next.
  // The click's work then never shares a frame with the motion's start:
  // - Opening renders the pane, which takes up to 12 ms.
  // - After the screen has been still, the frame that draws a click starts
  //   4 to 5 ms late, so even a small render can miss that frame's deadline
  //   and delay the transition's first frame by a whole frame.
  const [listNarrowed, setListNarrowed] = useState(paneShown);
  // Under Reduce motion nothing moves, so the split changes in this frame.
  if (listNarrowed !== paneShown && matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setListNarrowed(paneShown);
  }
  useLayoutEffect(() => {
    if (listNarrowed === paneShown) return;
    // The first callback runs before the frame that draws the click, the
    // second one in the frame after it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setListNarrowed(paneShown);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [paneShown, listNarrowed]);

  /**
   * Puts the focus on the selected row. When the list does not draw it,
   * because the row left the view, the focus goes to the list itself, so the
   * screen's keys keep working.
   */
  const focusSelected = (): void => {
    if (selectedId === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[${rowAttribute}="${CSS.escape(selectedId)}"]`,
    );
    (row ?? listRef.current)?.focus();
  };

  // When the pane closes, by Esc, by the toggle or because the window grew
  // too narrow for it, the closing pane turns inert, and the focus inside it
  // would fall to the page's body, outside the screen's keys. The focus goes
  // to the list instead. Focus outside the split, such as on the toggle that
  // closed the pane, stays where it is.
  useLayoutEffect(() => {
    if (paneShown) return;
    const focused = document.activeElement;
    const inPane =
      (splitRef.current?.contains(focused) ?? false) &&
      !(listRef.current?.contains(focused) ?? false);
    if (inPane || focused === null || focused === document.body) focusSelected();
    // Runs only when the pane closes; `focusSelected` is a new function on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneShown]);

  /** Measures the list's left edge and the split's width, once per drag or key press. */
  const measureSplit = (): {
    readonly left: number;
    readonly listWidth: number;
    readonly available: number;
  } => {
    const list = listRef.current!.getBoundingClientRect();
    return { left: list.left, listWidth: list.width, available: splitRef.current!.offsetWidth };
  };

  /**
   * Gives the list `listWidth` at once, with no React render and no
   * transition: only opening and closing the pane animate the list's width.
   * The new width is laid out before the transition is allowed again, so the
   * change never starts one.
   */
  const resizeList = (listWidth: number): void => {
    const split = splitRef.current!;
    split.dataset.resizing = "";
    split.style.setProperty("--intake-list-width", `${String(listWidth)}px`);
    void listRef.current!.offsetWidth;
    delete split.dataset.resizing;
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const split = measureSplit();
    let latest: number | undefined;
    // Each move resizes the list straight in the page; only the end of the
    // drag stores the width, which renders once.
    const move = (moved: globalThis.PointerEvent): void => {
      latest = fitIntakeListWidth(Math.round(moved.clientX - split.left), split.available);
      resizeList(latest);
      handle.setAttribute("aria-valuenow", String(latest));
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (latest !== undefined) storeWidth(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The handle is the list's right edge, so the right arrow widens the list.
    const step =
      event.key === "ArrowRight" ? KEYBOARD_STEP : event.key === "ArrowLeft" ? -KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    // The split's key handler must not also move the selection.
    event.stopPropagation();
    const split = measureSplit();
    const next = fitIntakeListWidth(Math.round(split.listWidth) + step, split.available);
    resizeList(next);
    storeWidth(next);
  };

  return {
    splitRef,
    listRef,
    width,
    available,
    fits,
    paneShown,
    paneDrawn,
    listNarrowed,
    setDismissed,
    endClosing: () => {
      setClosingId(null);
    },
    startDrag,
    resizeWithKeys,
  };
}
