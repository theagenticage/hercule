/**
 * The motion of a Tracking row whose state changed (spec 17 §Tracking,
 * Motion): the line under its title fades in anew over `--dur-2`, so the eye
 * sees what changed. The row's place may change too, which `useRowMotion`
 * moves.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";
import type { TrackingState } from "@hercule/client-core";
import { readMotionDuration } from "./motion-tokens";
import { isMotionShown, isOnScreen } from "./motion-helpers";

/** What the fade needs to know of a row of Tracking: which Task it is, and its state. */
interface FadedRow {
  readonly taskId: string;
  readonly state: TrackingState;
}

/** Checks whether `line` shows inside the scrolling part of the list it is in, if it is in one. */
const isLineShown = (line: HTMLElement): boolean => {
  const scroll = line.closest(".tr-scroll");
  if (scroll === null) return true;
  const { top, bottom } = scroll.getBoundingClientRect();
  return isOnScreen(line.getBoundingClientRect(), { top, bottom });
};

/**
 * Fades in the line of each row of `rows` whose state differs from the last
 * time it was drawn, once, over `--dur-2`. A row drawn for the first time
 * does not fade, and a row whose line is out of view changes at once.
 *
 * `rootRef` is the element that holds the rows' elements, each marked with its
 * Task's id in `data-item-key`. A row is found by that mark, not by the
 * element it was drawn in last time, because Tracking's sheet draws each state
 * in a section of its own: a row that changes state is a new element.
 */
export const useLineFade = (
  rows: ReadonlyArray<FadedRow>,
  rootRef: RefObject<HTMLElement | null>,
): void => {
  const states = useRef(new Map<string, TrackingState>());

  useLayoutEffect(() => {
    const before = states.current;
    states.current = new Map(rows.map((row) => [row.taskId, row.state]));
    if (!isMotionShown()) return;
    const changed = rows.filter((row) => {
      const was = before.get(row.taskId);
      return was !== undefined && was !== row.state;
    });
    const duration = readMotionDuration("--dur-2");
    for (const { taskId } of changed) {
      const line = rootRef.current?.querySelector<HTMLElement>(
        `[data-item-key="${CSS.escape(taskId)}"] .tr-run-sub`,
      );
      if (line !== null && line !== undefined && isLineShown(line)) {
        line.animate({ opacity: [0, 1] }, { duration, easing: "linear" });
      }
    }
  }, [rows, rootRef]);
};
