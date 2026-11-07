/**
 * The part of the opening sheet that moves it: it reads the places, writes
 * the frame to styles on every tick of the spring, and tells when the sheet
 * has closed. It lives outside the component so that nothing in it is part of
 * a render: it reads and writes elements only.
 */
import {
  animateValue,
  isMotionReduced,
  MOVING_CLASS,
  trackBody,
  type MotionValue,
} from "../../app/motion";
import {
  computeCardWordsOpacity,
  computeFallbackOrigin,
  computeSheetProgress,
  computeSheetWords,
  interpolateSheetFrame,
  type SheetRect,
} from "./opening-sheet-geometry";

/**
 * Where an opening sheet grows from: the rectangle of what stands for the
 * thing it opens, and a copy of that thing's words to ride on the sheet.
 *
 * - `rect` is in window pixels, as `getBoundingClientRect` gives it. It is
 *   `null` when nothing on the page holds the thing, and the sheet then grows
 *   from a smaller sheet inside its destination.
 * - `words` is a detached copy that looks like the thing now, or `null`.
 *   The sheet takes it into its own tree at the width of `rect`, fades it out
 *   as it opens, and fades it back in as it closes.
 */
export interface SheetOrigin {
  readonly rect: SheetRect | null;
  readonly words: HTMLElement | null;
}

/**
 * What the caller knows of the page when the sheet starts to open, close or
 * swap: where the sheet grows from, and where it ends.
 *
 * `destination` is the sheet's open box in window pixels. It is the caller's
 * to choose, so the sheet can end over a page, as the details pane does, or
 * docked beside it.
 */
export interface SheetPlaces {
  readonly origin: SheetOrigin;
  readonly destination: SheetRect;
}

/** The elements the controller moves. */
export interface SheetParts {
  /** The layer that covers the sheet's positioned parent. */
  readonly layer: HTMLElement;
  readonly sheet: HTMLElement;
  /** Holds the copy of the card's words. */
  readonly ghost: HTMLElement;
  /** The sheet's words, laid out at the destination's size. */
  readonly words: HTMLElement;
  /** Inside `words`: what swaps when the sheet shows another thing. */
  readonly content: HTMLElement;
}

/** What the controller asks of its caller. */
export interface SheetHost {
  /** Reads the page for the places, now. */
  readonly readPlaces: () => SheetPlaces;
  /** Tells that the sheet has closed all the way. */
  readonly onClosed: () => void;
}

/** What the controller does for the component. */
export interface SheetController {
  /** Reads the places again and paints the sheet as it is now. For a resize. */
  readonly remeasure: () => void;
  /** Reads the places and sends the sheet toward open, from where it is. */
  readonly open: () => void;
  /** Reads the places and sends the sheet toward closed, from where it is. */
  readonly close: () => void;
  /** Reads the places again for another thing in the open sheet, and swaps the words in a short fade. The sheet stays. */
  readonly swap: () => void;
  /** Stops everything and gives the elements back to their stylesheets. */
  readonly dispose: () => void;
}

/** How far the sheet's words rise while they swap for another thing's, in pixels. */
const SWAP_RISE = 6;

/** The page's default ease out (`--m-ease`), which a Web Animation cannot read from the stylesheet. */
const SWAP_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Makes the controller of one sheet, which starts closed. */
export const createSheetController = (parts: SheetParts, host: SheetHost): SheetController => {
  const { layer, sheet, ghost, words, content } = parts;
  let frame: { from: SheetRect; open: SheetRect } | null = null;
  const value: MotionValue = animateValue(0, (p) => {
    paint(p);
  });

  /** Writes the sheet's look at `p`. It touches styles only. */
  function paint(p: number): void {
    if (frame === null) return;
    const { rect, corner } = interpolateSheetFrame(frame.from, frame.open, p);
    sheet.style.left = `${rect.left.toFixed(2)}px`;
    sheet.style.top = `${rect.top.toFixed(2)}px`;
    sheet.style.width = `${rect.width.toFixed(2)}px`;
    sheet.style.height = `${rect.height.toFixed(2)}px`;
    sheet.style.setProperty("--sheet-corner", `${corner.toFixed(2)}px`);
    const shown = computeSheetWords(p);
    words.style.opacity = shown.opacity.toFixed(3);
    words.style.transform = `translateY(${shown.rise.toFixed(2)}px)`;
    ghost.style.opacity = computeCardWordsOpacity(p).toFixed(3);
    layer.style.setProperty("--sheet-progress", computeSheetProgress(p).toFixed(3));
  }

  /** Reads the places, takes the copy of the card's words into the sheet, and paints the sheet as it is now. */
  const takePlaces = (): void => {
    const bounds = layer.getBoundingClientRect();
    const { origin, destination } = host.readPlaces();
    const open: SheetRect = {
      left: destination.left - bounds.left,
      top: destination.top - bounds.top,
      width: destination.width,
      height: destination.height,
    };
    const from: SheetRect =
      origin.rect === null
        ? computeFallbackOrigin(open)
        : {
            left: origin.rect.left - bounds.left,
            top: origin.rect.top - bounds.top,
            width: origin.rect.width,
            height: origin.rect.height,
          };
    frame = { from, open };
    layer.style.setProperty("--sheet-w", `${open.width}px`);
    layer.style.setProperty("--sheet-h", `${open.height}px`);
    ghost.replaceChildren(...(origin.words === null ? [] : [origin.words]));
    if (origin.words !== null) origin.words.style.width = `${from.width}px`;
    paint(value.current);
  };

  /** Moves the sheet toward open (1) or closed (0), from where it is. */
  const travel = (goal: 0 | 1): void => {
    const arrive = (): void => {
      layer.classList.remove(MOVING_CLASS);
      if (goal === 0) host.onClosed();
    };
    if (!isMotionReduced()) {
      layer.classList.add(MOVING_CLASS);
      value.to(goal, "travel", arrive);
      return;
    }
    // The sheet stands at its destination, and the sheet with what is behind it fades.
    const fade = trackBody(layer);
    const wasClosed = value.current === 0;
    value.set(1);
    if (goal === 1) {
      // A sheet reopened while it fades out turns round from where it is.
      if (wasClosed) fade.set({ o: 0 });
      fade.to({ o: 1 }, "travel", { done: arrive });
    } else {
      fade.to({ o: 0 }, "travel", {
        done: () => {
          value.set(0);
          fade.clear();
          arrive();
        },
      });
    }
  };

  return {
    remeasure: takePlaces,
    open: () => {
      takePlaces();
      travel(1);
    },
    close: () => {
      takePlaces();
      travel(0);
    },
    swap: () => {
      takePlaces();
      // The words fade in from 6px below over 200ms, on the page's ease. Under
      // Reduce motion they only fade, in 120ms. A page with no Web Animations
      // (a test) swaps with no motion.
      if (typeof content.animate === "function") {
        const reduced = isMotionReduced();
        content.animate(
          reduced
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: `translateY(${String(SWAP_RISE)}px)` },
                { opacity: 1, transform: "none" },
              ],
          { duration: reduced ? 120 : 200, easing: SWAP_EASE },
        );
      }
      // The focus must not be left on words that are gone.
      if (sheet.contains(document.activeElement)) {
        sheet.querySelector<HTMLElement>("[data-sheet-focus]")?.focus({ preventScroll: true });
      }
    },
    dispose: () => {
      value.set(value.current);
      trackBody(layer).clear();
      for (const animation of content.getAnimations?.() ?? []) animation.cancel();
    },
  };
};
