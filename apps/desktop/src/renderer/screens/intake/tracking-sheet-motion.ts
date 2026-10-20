/**
 * The motion of opening and closing Tracking (spec 17 §Tracking, Motion).
 *
 * - Opening: the sheet rises from where folded Tracking stood, over 240ms
 *   with a slight spring. Its head, section headings and rows cascade in on
 *   top of the rise, each over `--dur-2`, 16ms apart from 60ms.
 * - Closing: a copy of the sheet drops back to where folded Tracking stands,
 *   over 180ms, easing in. The sheet itself is gone at once, so the keys and
 *   the folded rows work from the first frame.
 *
 * Everything is `transform` and `opacity`, plays once, and plays only for
 * parts on screen. With Reduce motion, or while the window is hidden, the
 * sheet and the fold swap with no motion.
 */
import { useCallback, useLayoutEffect, useRef } from "react";
import type { HandoffFlights } from "./handoff-flight";
import { readMotionDuration, readMotionEasing } from "./motion-tokens";
import { copyElementWithoutIds, isMotionShown, isOnScreen, type RowPlace } from "./motion-helpers";

/** How long the sheet takes to rise, in milliseconds. */
const RISE_DURATION = 240;

/**
 * A spring that overshoots a little and settles. The design language's
 * `--ease-spring` overshoots too far for a sheet as tall as the window.
 */
const RISE_EASING = "cubic-bezier(0.3, 1.2, 0.5, 1)";

/** How long the sheet takes to drop back, in milliseconds. */
const DROP_DURATION = 180;

/** The easing of the drop: it starts slowly, as something let go of. */
const DROP_EASING = "cubic-bezier(0.5, 0, 0.75, 0)";

/** The parts of the sheet that cascade in: its head, its section headings and its rows. */
const CASCADE_PARTS = ".tr-head, .tr-sec, .tr-run-item";

/** How many parts cascade at most. The rest rise with the sheet. */
const MAX_CASCADED_PARTS = 13;

/** When the first part starts, in milliseconds after the rise starts. */
const CASCADE_START = 60;

/** How long each part starts after the one before it, in milliseconds. */
const CASCADE_STEP = 16;

/** The time by which the whole cascade is done, in milliseconds. */
const CASCADE_END = 450;

/** How far below its place a part starts, in pixels. */
const CASCADE_DROP = 12;

/** One part of the sheet that cascades in: which part, and when it starts. */
export interface CascadedPart {
  /** The part's position among all the sheet's parts, in document order. */
  readonly index: number;
  /** Milliseconds from the start of the rise to the part's start. */
  readonly delay: number;
}

/**
 * Plans the cascade of `count` parts, which stand one under the other in
 * document order. `readPlace` returns where a part stands, `viewport` is the
 * part of the sheet that shows, and `duration` is how long one part takes.
 *
 * Only the first `MAX_CASCADED_PARTS` parts on screen cascade, each starting
 * `CASCADE_STEP` after the one before it from `CASCADE_START`. A part never
 * starts so late that it would end after `CASCADE_END`: the last parts of a
 * full cascade start together. The planning reads the place of a part only
 * while it can still be one of them: it stops at the last part that
 * cascades, or at the first part that starts below the viewport.
 */
export const planCascade = (
  count: number,
  readPlace: (index: number) => RowPlace,
  viewport: RowPlace,
  duration: number,
): ReadonlyArray<CascadedPart> => {
  const parts: CascadedPart[] = [];
  for (let index = 0; index < count && parts.length < MAX_CASCADED_PARTS; index++) {
    const place = readPlace(index);
    if (place.top >= viewport.bottom) break;
    if (!isOnScreen(place, viewport)) continue;
    parts.push({
      index,
      delay: Math.min(CASCADE_START + parts.length * CASCADE_STEP, CASCADE_END - duration),
    });
  }
  return parts;
};

/**
 * Plays the rise of `sheet`, which has just been drawn in its place over the
 * column, from where folded Tracking stood: `foldedHeight` tall, at the foot
 * of the column. Every place is read before any animation starts, so the page
 * lays out once and the parts are measured where they stand, not where the
 * rise starts them. Only the parts that cascade are measured.
 */
const riseSheet = (sheet: HTMLElement, foldedHeight: number): void => {
  const sheetPlace = sheet.getBoundingClientRect();
  const scrollPlace = sheet.querySelector<HTMLElement>(".tr-scroll")!.getBoundingClientRect();
  const parts = [...sheet.querySelectorAll<HTMLElement>(CASCADE_PARTS)];
  const duration = readMotionDuration("--dur-2");
  const cascade = planCascade(
    parts.length,
    (index) => parts[index]!.getBoundingClientRect(),
    { top: sheetPlace.top, bottom: scrollPlace.bottom },
    duration,
  );

  sheet.animate(
    { transform: [`translateY(${String(sheetPlace.height - foldedHeight)}px)`, "none"] },
    { duration: RISE_DURATION, easing: RISE_EASING },
  );
  const easing = readMotionEasing();
  for (const { index, delay } of cascade) {
    parts[index]!.animate(
      {
        opacity: [0, 1],
        transform: [`translateY(${String(CASCADE_DROP)}px)`, "none"],
      },
      { duration, delay, easing, fill: "backwards" },
    );
  }
};

/**
 * Plays the drop of `sheet`, the sheet that has just left: a copy of it
 * drops in `layer`, over the column, until its head stands at the top of
 * `fold`, folded Tracking. Returns the drop, so a new opening can end it.
 */
const dropSheet = (sheet: HTMLElement, layer: HTMLElement, fold: HTMLElement): Animation => {
  const copy = copyElementWithoutIds(sheet);
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  layer.append(copy);
  const distance = copy.getBoundingClientRect().height - fold.getBoundingClientRect().height;
  const drop = copy.animate(
    { transform: ["none", `translateY(${String(distance)}px)`] },
    { duration: DROP_DURATION, easing: DROP_EASING, fill: "forwards" },
  );
  const removeCopy = (): void => {
    copy.remove();
  };
  drop.finished.then(removeCopy, removeCopy);
  return drop;
};

/** The refs that hand Tracking's elements to the motion. */
export interface TrackingSheetMotion {
  /**
   * A ref for folded Tracking's element. It also tells `flights` where folded
   * Tracking is while it is drawn.
   */
  readonly setFoldElement: (fold: HTMLElement | null) => (() => void) | undefined;
  /** A ref for the sheet's element. */
  readonly setSheetElement: (sheet: HTMLElement | null) => void;
  /** A ref for the layer over the list column, which the drop and the flights move in. */
  readonly setLayerElement: (layer: HTMLElement | null) => void;
}

/**
 * Plays the sheet's rise when `open` turns true and its drop when it turns
 * false, as this module describes. Nothing plays when Tracking is drawn
 * already open, such as on opening the page, or after a view change.
 *
 * The drop plays in `flights`' layer over the list column. The caller puts
 * `setFoldElement` and `setSheetElement` on the two elements.
 *
 * The rise needs the height folded Tracking had, which is gone once the sheet
 * is drawn, so `setFoldElement` records it as the fold is removed. The drop needs
 * the sheet, which React has removed by then, so `setSheetElement` keeps the last
 * one. A removed element still holds its rows, and a copy of it looks the
 * same as the sheet did.
 */
export const useTrackingSheetMotion = (
  open: boolean,
  flights: HandoffFlights,
): TrackingSheetMotion => {
  const foldedHeight = useRef(0);
  const lastSheet = useRef<HTMLElement | null>(null);
  const drop = useRef<Animation | null>(null);
  const wasOpen = useRef(open);

  const setFoldElement = useCallback(
    (fold: HTMLElement | null) => {
      if (fold === null) return undefined;
      flights.setFold(fold);
      return () => {
        // Called as React removes the fold, while the element still has its place.
        foldedHeight.current = fold.offsetHeight;
        flights.setFold(null);
      };
    },
    [flights],
  );
  const setSheetElement = useCallback((sheet: HTMLElement | null) => {
    if (sheet !== null) lastSheet.current = sheet;
  }, []);
  const setLayerElement = flights.setLayer;

  useLayoutEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (!isMotionShown()) return;
    if (open) {
      drop.current?.cancel();
      // Without a folded Tracking just before, the sheet did not come from it.
      if (foldedHeight.current > 0) riseSheet(lastSheet.current!, foldedHeight.current);
      foldedHeight.current = 0;
    } else {
      drop.current = dropSheet(lastSheet.current!, flights.readLayer()!, flights.readFold()!);
    }
  }, [open, flights]);

  return { setFoldElement, setSheetElement, setLayerElement };
};
